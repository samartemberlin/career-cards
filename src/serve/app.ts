// The public surface. Nothing from a request reaches a log line but ids, outcomes and status codes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { secretMatches, verifyTrelloSignature } from './auth.ts';
import { parseWebhook } from './gate.ts';
import type { CommentAction } from './gate.ts';
import { startRun } from './runs.ts';
import type { RunStarter, StartResult } from './runs.ts';

export const BODY_MAX = 1_000_000;

export type AppDeps = {
  appSecret: string;
  callbackUrl: string;
  triggerSecret: string;
  onComment: (a: CommentAction) => boolean;
  starter: RunStarter;
  log: (s: string) => void;
};

const ALLOWED: Record<string, string[]> = {
  '/trello': ['HEAD', 'POST'],
  '/trigger/run': ['POST'],
  '/healthz': ['GET'],
};

const START_STATUS: Record<StartResult, number> = { started: 202, busy: 409, unknown: 503, failed: 500 };

class TooLarge extends Error {}

/** Reads the raw bytes, refusing more than BODY_MAX before buffering them. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
      reject(new TooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > BODY_MAX) {
        req.off('data', onData);
        chunks.length = 0;
        // Drop the bytes; the 413 goes out with `connection: close`, which ends the socket.
        req.resume();
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => reject(new Error('request closed')));
  });
}

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function createApp(d: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  let starting = false;

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      d.log('webhook: body too large');
      send(res, 413, 'too large', { connection: 'close' });
      return;
    }
    const sig = req.headers['x-trello-webhook'];
    if (!verifyTrelloSignature(raw, typeof sig === 'string' ? sig : undefined, d.callbackUrl, d.appSecret)) {
      d.log('webhook: bad signature');
      send(res, 401, 'unauthorized');
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      d.log('webhook: bad json');
      send(res, 400, 'bad request');
      return;
    }
    const a = parseWebhook(body);
    if (a && !d.onComment(a)) d.log(`webhook: queue full, dropped ${a.id}`);
    send(res, 200, 'ok');
  }

  async function trigger(url: URL, res: ServerResponse): Promise<void> {
    if (!secretMatches(url.searchParams.get('key'), d.triggerSecret)) {
      d.log('trigger: bad key');
      send(res, 401, 'unauthorized');
      return;
    }
    // Two triggers at once would both see no run in progress.
    if (starting) {
      send(res, 409, 'busy');
      return;
    }
    starting = true;
    let result: StartResult;
    try {
      result = await startRun(d.starter, 'scheduled', d.log);
    } finally {
      starting = false;
    }
    d.log(`trigger: ${result}`);
    send(res, START_STATUS[result], result);
  }

  return (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://service.invalid');
    } catch {
      send(res, 400, 'bad request');
      return;
    }
    const methods = ALLOWED[url.pathname];
    const method = req.method ?? '';
    if (!methods) return send(res, 404, 'not found');
    if (!methods.includes(method)) return send(res, 405, 'method not allowed', { allow: methods.join(', ') });
    if (method !== 'POST') return send(res, 200, method === 'HEAD' ? '' : 'ok');

    (url.pathname === '/trello' ? webhook(req, res) : trigger(url, res)).catch((e: unknown) => {
      // The pathname only: the trigger's query holds its secret.
      d.log(`${url.pathname}: failed with ${e instanceof Error ? e.name : 'a non-error'}`);
      send(res, 500, 'error');
    });
  };
}
