// node:http adapter for hosts that run a process (Northflank, Render): `node relay/src/node.ts`, listens on $PORT.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import relay, { type Env } from './index.ts';

type Handler = { fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> };

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

export function serve(handler: Handler, env: Env, port: number): Server {
  return createServer(async (req, res) => {
    let out: Response;
    try {
      // waitUntil: the process stays up, so the promise just runs; it logs its own outcome and never rejects.
      out = await handler.fetch(toRequest(req), env, { waitUntil: (p) => void p.catch(() => {}) });
    } catch {
      out = new Response('error', { status: 500 });
    }
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await out.arrayBuffer()));
    req.resume();
  }).listen(port);
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  // Off Cloudflare a client can send its own cf-connecting-ip, so the host's own header must be named.
  if (!process.env.RELAY_IP_HEADER) {
    console.error('set RELAY_IP_HEADER to the header your host overwrites with the client IP');
    process.exit(1);
  }
  serve(relay, process.env as Env, port).on('listening', () => console.log(`listening ${port}`));
}
