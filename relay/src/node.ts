// node:http adapter for hosts that run a process (Northflank, Render): `node relay/src/node.ts`, listens on $PORT.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import relay, { type Env } from './index.ts';
import { MIN_SECRET } from './sig.ts';

type Handler = { fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> };

const pending = new Set<Promise<unknown>>();

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', 'http://relay.local'), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
    duplex: 'half',
  } as RequestInit);
}

/** Throws on an env that would run the relay unsafely. */
export function checkEnv(env: Env, nodeEnv = process.env.NODE_ENV): void {
  // Off Cloudflare a client can send its own cf-connecting-ip, so the host's own header must be named.
  if (!env.RELAY_IP_HEADER) throw new Error('set RELAY_IP_HEADER to the header your host overwrites with the client IP');
  if ((env.RELAY_PATH_SECRET ?? '').length < MIN_SECRET) throw new Error(`set RELAY_PATH_SECRET (at least ${MIN_SECRET} characters)`);
  if (env.RELAY_SKIP_IP_CHECK && nodeEnv !== 'test') throw new Error('RELAY_SKIP_IP_CHECK is for tests only (NODE_ENV=test)');
}

export function serve(handler: Handler, env: Env, port: number): Server {
  checkEnv(env);
  return createServer(async (req, res) => {
    let out: Response;
    try {
      out = await handler.fetch(toRequest(req), env, {
        waitUntil: (p) => {
          const q = p.catch(() => {}).finally(() => pending.delete(q));
          pending.add(q);
        },
      });
    } catch {
      out = new Response('error', { status: 500 });
    }
    const headers = Object.fromEntries(out.headers);
    // The core stops reading an oversized body; that socket can't be reused.
    if (!req.complete) headers.connection = 'close';
    res.writeHead(out.status, headers);
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await out.arrayBuffer()));
    if (req.complete) req.resume();
  }).listen(port);
}

/** Stops accepting, then waits up to `graceMs` for dispatches still running. */
export async function shutdown(server: Server, graceMs = 10_000): Promise<void> {
  server.close();
  server.closeIdleConnections();
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, graceMs).unref())]);
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const env = process.env as Env;
  let server: Server;
  try {
    server = serve(relay, env, port);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const owners = (env.ALLOWED_OWNERS ?? '').split(',').filter((s) => s.trim()).length;
  server.on('listening', () => console.log(`listening ${port}, allowed owners: ${owners || 'any'}`));
  // As PID 1 in a container Node gets no default SIGTERM handler.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void shutdown(server).then(() => process.exit(0)));
}
