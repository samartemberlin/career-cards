// GitHub App auth with WebCrypto only. Everything is cached per isolate (Workers Free allows 10 ms CPU per request),
// and nothing is persisted.

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

/** A failure at one stage, logged as `fail <stage> <code>`. */
export class Fail extends Error {
  readonly stage: string;
  readonly code: string | number;
  constructor(stage: string, code: string | number) {
    super(`${stage} ${code}`);
    this.stage = stage;
    this.code = code;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function importKey(pem: string): Promise<CryptoKey> {
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!m) throw new Fail('key', 'format');
  const der = Uint8Array.from(atob(m[1]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

type Repo = { token: string; refreshAt: number; branch?: string };

export function githubApp(deps: { fetch: Fetch; now: () => number }) {
  let key: { pem: string; key: Promise<CryptoKey> } | undefined;
  let jwt: { appId: string; value: string; refreshAt: number } | undefined;
  const repos = new Map<string, Repo>();
  // Anyone can point a Trello webhook at any path, so remember repos without the App for a while (bounded).
  const notInstalled = new Map<string, number>();

  async function call(stage: string, path: string, auth: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await deps.fetch(`${API}${path}`, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${auth}`,
          'user-agent': 'career-cards-relay',
          'x-github-api-version': '2022-11-28',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Fail(stage, 'net');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Fail(stage, res.status);
    }
    return res;
  }

  async function appJwt(appId: string, pem: string): Promise<string> {
    const nowS = Math.floor(deps.now() / 1000);
    if (jwt && jwt.appId === appId && key?.pem === pem && nowS < jwt.refreshAt) return jwt.value;
    if (!key || key.pem !== pem) {
      key = { pem, key: importKey(pem) };
      jwt = undefined;
    }
    let k: CryptoKey;
    try {
      k = await key.key;
    } catch {
      key = undefined;
      throw new Fail('key', 'import');
    }
    const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iat: nowS - 60, exp: nowS + 540, iss: appId })}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(unsigned)));
    jwt = { appId, value: `${unsigned}.${b64url(sig)}`, refreshAt: nowS + 540 - 60 };
    return jwt.value;
  }

  const inflight = new Map<string, Promise<Repo>>();

  function repoToken(appId: string, pem: string, owner: string, repo: string): Promise<Repo> {
    const id = `${owner}/${repo}`.toLowerCase();
    const hit = repos.get(id);
    if (hit && deps.now() < hit.refreshAt) return Promise.resolve(hit);
    let p = inflight.get(id);
    if (!p) {
      p = freshToken(appId, pem, owner, repo, id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    return p;
  }

  async function freshToken(appId: string, pem: string, owner: string, repo: string, id: string): Promise<Repo> {
    repos.delete(id);
    if ((notInstalled.get(id) ?? 0) > deps.now()) throw new Fail('install', '404-cached');
    const j = await appJwt(appId, pem);
    let instRes: Response;
    try {
      instRes = await call('install', `/repos/${owner}/${repo}/installation`, j);
    } catch (e) {
      if (e instanceof Fail && e.code === 404) {
        if (notInstalled.size >= 1000) notInstalled.clear();
        notInstalled.set(id, deps.now() + 10 * 60_000);
      }
      throw e;
    }
    const inst = (await instRes.json().catch(() => ({}))) as { id?: unknown };
    if (typeof inst.id !== 'number') throw new Fail('install', 'bad');
    const t = (await (
      await call('token', `/app/installations/${inst.id}/access_tokens`, j, {
        method: 'POST',
        body: JSON.stringify({ repositories: [repo], permissions: { actions: 'write', metadata: 'read' } }),
      })
    )
      .json()
      .catch(() => ({}))) as { token?: unknown; expires_at?: unknown };
    const exp = typeof t.expires_at === 'string' ? Date.parse(t.expires_at) : NaN;
    if (typeof t.token !== 'string' || !Number.isFinite(exp)) throw new Fail('token', 'bad');
    const entry = { token: t.token, refreshAt: exp - 5 * 60_000 };
    if (repos.size >= 1000) repos.clear();
    repos.set(id, entry);
    return entry;
  }

  /** Dispatches `bot.yml` on the repo's default branch; returns the HTTP status. */
  async function dispatch(
    env: { appId: string; pem: string },
    owner: string,
    repo: string,
    inputs: Record<string, string>,
  ): Promise<number> {
    const entry = await repoToken(env.appId, env.pem, owner, repo);
    const id = `${owner}/${repo}`.toLowerCase();
    try {
      if (!entry.branch) {
        const r = (await (await call('repo', `/repos/${owner}/${repo}`, entry.token)).json().catch(() => ({}))) as {
          default_branch?: unknown;
        };
        if (typeof r.default_branch !== 'string' || !r.default_branch) throw new Fail('repo', 'bad');
        entry.branch = r.default_branch;
      }
      const res = await call('dispatch', `/repos/${owner}/${repo}/actions/workflows/bot.yml/dispatches`, entry.token, {
        method: 'POST',
        body: JSON.stringify({ ref: entry.branch, inputs }),
      });
      await res.body?.cancel().catch(() => {});
      return res.status;
    } catch (e) {
      repos.delete(id); // a revoked install, a renamed branch: start fresh next time
      throw e;
    }
  }

  return { dispatch };
}
