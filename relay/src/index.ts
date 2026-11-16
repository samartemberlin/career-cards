// Trello webhook → workflow_dispatch relay. Web-standard core shared by the Cloudflare entry (this default export)
// and the node:http adapter (node.ts). Always answers Trello 200 on a hook POST: retries would only duplicate work.
// Logs exactly one status line per request, never bodies, ids, comment text or tokens.
import { decide, inSubnet, MAX_BODY } from './gate.ts';
import { Fail, githubApp, type Fetch } from './github-app.ts';
import { hookSig, MIN_SECRET, sameSig, validRepo } from './sig.ts';

export type Env = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY_PKCS8?: string;
  ALLOWED_OWNERS?: string;
  RELAY_IP_HEADER?: string;
  RELAY_SKIP_IP_CHECK?: string;
  RELAY_PATH_SECRET?: string;
};
export type Ctx = { waitUntil(p: Promise<unknown>): void };
export type Deps = { fetch: Fetch; now: () => number; log: (line: string) => void };

const PATH = /^\/hook\/([^/]+)\/([^/]+)(?:\/([^/]*))?$/;
// Per owner/repo, a second line of defence behind the path signature.
export const RATE = { burst: 20, windowMs: 10 * 60_000 };

class TooBig extends Error {}

async function readCapped(req: Request): Promise<string> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new TooBig();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new TooBig();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c, (at += c.byteLength) - c.byteLength);
  return new TextDecoder().decode(all);
}

export function createRelay(deps: Deps) {
  const gh = githubApp(deps);
  const buckets = new Map<string, { tokens: number; at: number }>();

  function take(id: string): boolean {
    const now = deps.now();
    const b = buckets.get(id) ?? { tokens: RATE.burst, at: now };
    b.tokens = Math.min(RATE.burst, b.tokens + ((now - b.at) * RATE.burst) / RATE.windowMs);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (!buckets.has(id) && buckets.size >= 1000) buckets.clear();
    buckets.set(id, b);
    return true;
  }
  const ok = () => new Response('ok', { status: 200 });

  async function post(req: Request, env: Env, ctx: Ctx, owner: string, repo: string): Promise<string | null> {
    if (env.RELAY_SKIP_IP_CHECK !== '1') {
      const ip = req.headers.get(env.RELAY_IP_HEADER || 'cf-connecting-ip') ?? '';
      if (!inSubnet(ip)) return 'drop ip';
    }
    let raw: string;
    try {
      raw = await readCapped(req);
    } catch (e) {
      if (e instanceof TooBig) return 'drop size';
      throw e;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return 'drop json';
    }
    const d = decide(body, new Date(deps.now()));
    if ('drop' in d) return `drop ${d.drop}`;
    const allowed = (env.ALLOWED_OWNERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(owner.toLowerCase())) return 'drop owner';
    if (!take(`${owner}/${repo}`.toLowerCase())) return 'drop rate';
    const appId = env.GITHUB_APP_ID ?? '';
    const pem = env.GITHUB_APP_PRIVATE_KEY_PKCS8 ?? '';
    ctx.waitUntil(
      (async () => {
        try {
          if (!/^\d+$/.test(appId) || !pem) throw new Fail('key', '');
          deps.log(`dispatch ${await gh.dispatch({ appId, pem }, owner, repo, d.forward)}`);
        } catch (e) {
          deps.log(e instanceof Fail ? (e.stage === 'key' ? 'fail key' : `fail ${e.stage} ${e.code}`) : 'fail internal');
        }
      })(),
    );
    return null;
  }

  return {
    async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
      const notFound = (line: string) => {
        deps.log(line);
        return new Response('not found', { status: 404 });
      };
      const m = PATH.exec(new URL(req.url).pathname);
      if (!m || !validRepo(m[1]!, m[2]!) || (req.method !== 'HEAD' && req.method !== 'POST')) return notFound('notfound');
      const secret = env.RELAY_PATH_SECRET ?? '';
      if (secret.length < MIN_SECRET) return notFound('fail secret');
      try {
        if (!sameSig(m[3] ?? '', await hookSig(secret, m[1]!, m[2]!))) return notFound('drop sig');
      } catch {
        return notFound('fail secret');
      }
      if (req.method === 'HEAD') {
        deps.log('head');
        return new Response(null, { status: 200 });
      }
      try {
        const line = await post(req, env, ctx, m[1]!, m[2]!);
        if (line) deps.log(line);
      } catch {
        deps.log('fail internal');
      }
      return ok();
    },
  };
}

export default createRelay({ fetch: (i, init) => fetch(i, init), now: Date.now, log: (s) => console.log(s) });
