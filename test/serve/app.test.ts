import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BODY_MAX, createApp } from '../../src/serve/app.ts';
import { trelloSignature } from '../../src/serve/auth.ts';
import type { AppDeps } from '../../src/serve/app.ts';
import type { CommentAction } from '../../src/serve/gate.ts';
import type { RunTrigger } from '../../src/run/stats.ts';
import { commentWebhook, signedRequest } from '../support/webhook.ts';

const APP_SECRET = 'app-secret-sample-0123456789';
const TRIGGER_SECRET = 'trigger-secret-sample-0123456789abcdef';
const CALLBACK = 'https://bot.example/trello';
const BOARD = 'fa4e00000000000000000005';
const CARD = 'fa4e00000000000000000012';
const USER_A = { id: 'fa4e0000000000000000a001', username: 'usera' };

type Starter = { running?: boolean; isRunningThrows?: boolean; startThrows?: boolean };

const servers: ReturnType<typeof createServer>[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function serve(o: { starter?: Starter; queueFull?: boolean } = {}) {
  const comments: CommentAction[] = [];
  const logs: string[] = [];
  const calls = { isRunning: 0, starts: [] as RunTrigger[] };
  const deps: AppDeps = {
    appSecret: APP_SECRET,
    callbackUrl: CALLBACK,
    triggerSecret: TRIGGER_SECRET,
    onComment: (a) => { comments.push(a); return !o.queueFull; },
    starter: {
      async isRunning() {
        calls.isRunning++;
        if (o.starter?.isRunningThrows) throw new Error('platform down');
        return o.starter?.running ?? false;
      },
      async start(t) {
        calls.starts.push(t);
        if (o.starter?.startThrows) throw new Error('quota');
      },
    },
    log: (s) => logs.push(s),
  };
  const server = createServer(createApp(deps));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, comments, logs, calls };
}

const comment = (text = '@samplebot help') =>
  commentWebhook({ cardId: CARD, boardId: BOARD, author: USER_A, text, listName: 'Nov 9 · 01:00' });

function post(base: string, raw: Buffer, signature?: string) {
  return fetch(`${base}/trello`, {
    method: 'POST',
    body: new Uint8Array(raw),
    headers: signature === undefined ? {} : { 'x-trello-webhook': signature },
  });
}

test('HEAD /trello → 200; GET /trello → 405; GET /nope → 404; GET /healthz → 200 ok', async () => {
  const { base } = await serve();
  assert.equal((await fetch(`${base}/trello`, { method: 'HEAD' })).status, 200);
  const wrong = await fetch(`${base}/trello`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'HEAD, POST');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/trigger/run`)).status, 405);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
});

test('POST /trello with a valid signature → 200 and onComment called once with the parsed action', async () => {
  const s = await serve();
  const body = comment() as { action: { id: string } };
  const { raw, signature } = signedRequest(body, { callbackUrl: CALLBACK, appSecret: APP_SECRET });
  const res = await post(s.base, raw, signature);
  assert.equal(res.status, 200);
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0]!.id, body.action.id);
  assert.equal(s.comments[0]!.text, '@samplebot help');
  assert.equal(s.comments[0]!.cardId, CARD);
});

test('bad signature → 401, onComment not called; missing header → 401', async () => {
  const s = await serve();
  const { raw, signature } = signedRequest(comment(), { callbackUrl: CALLBACK, appSecret: APP_SECRET });
  const other = signedRequest(comment(), { callbackUrl: CALLBACK, appSecret: 'another-secret-0123456789' });
  assert.equal((await post(s.base, raw, other.signature)).status, 401);
  // Signed for another callback URL: a request's own Host header must not change what is verified.
  const elsewhere = signedRequest(comment(), { callbackUrl: `${s.base}/trello`, appSecret: APP_SECRET });
  assert.equal((await post(s.base, elsewhere.raw, elsewhere.signature)).status, 401);
  assert.equal((await post(s.base, Buffer.concat([raw, Buffer.from(' ')]), signature)).status, 401);
  assert.equal((await post(s.base, raw)).status, 401);
  assert.equal((await post(s.base, raw, '')).status, 401);
  assert.deepEqual(s.comments, []);
});

test('a valid signature over non-JSON → 400; a bad one → 401, before any parse', async () => {
  const s = await serve();
  const broken = Buffer.from('{"action":', 'utf8');
  assert.equal((await post(s.base, broken, trelloSignature(broken, CALLBACK, APP_SECRET))).status, 400);
  assert.equal((await post(s.base, broken, trelloSignature(broken, CALLBACK, 'another-secret-0123456789'))).status, 401);
  assert.deepEqual(s.comments, []);
});

test('1,000,001 bytes → 413, onComment not called, whether announced or streamed', async () => {
  const s = await serve();
  const big = Buffer.alloc(BODY_MAX + 1, 0x20);
  const sig = trelloSignature(big, CALLBACK, APP_SECRET);
  assert.equal((await post(s.base, big, sig)).status, 413);

  // No content-length: the cap applies while reading.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${s.base}/trello`, { method: 'POST', headers: { 'x-trello-webhook': sig } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    for (let i = 0; i < 11; i++) req.write(Buffer.alloc(100_000, 0x20));
    req.end();
  });
  assert.equal(status, 413);
  assert.deepEqual(s.comments, []);
});

test('exactly 1,000,000 bytes is read and checked', async () => {
  const s = await serve();
  const body = Buffer.alloc(BODY_MAX, 0x20);
  assert.equal((await post(s.base, body, 'AAAA')).status, 401);
});

test('an updateCard action with a valid signature → 200, onComment not called', async () => {
  const s = await serve();
  const body = comment() as { action: Record<string, unknown> };
  body.action.type = 'updateCard';
  const { raw, signature } = signedRequest(body, { callbackUrl: CALLBACK, appSecret: APP_SECRET });
  assert.equal((await post(s.base, raw, signature)).status, 200);
  assert.deepEqual(s.comments, []);
});

test('a full queue is logged by action id and still answered 200', async () => {
  const s = await serve({ queueFull: true });
  const body = comment('@samplebot help, my secret text') as { action: { id: string } };
  const { raw, signature } = signedRequest(body, { callbackUrl: CALLBACK, appSecret: APP_SECRET });
  assert.equal((await post(s.base, raw, signature)).status, 200);
  assert.deepEqual(s.logs, [`webhook: queue full, dropped ${body.action.id}`]);
});

const trigger = (base: string, key?: string) =>
  fetch(`${base}/trigger/run${key === undefined ? '' : `?key=${encodeURIComponent(key)}`}`, { method: 'POST' });

test('POST /trigger/run?key=<right> → 202 and start(scheduled)', async () => {
  const s = await serve();
  assert.equal((await trigger(s.base, TRIGGER_SECRET)).status, 202);
  assert.deepEqual(s.calls.starts, ['scheduled']);
});

test('trigger: busy → 409; isRunning throws → 503; start throws → 500', async () => {
  assert.equal((await trigger((await serve({ starter: { running: true } })).base, TRIGGER_SECRET)).status, 409);
  assert.equal((await trigger((await serve({ starter: { isRunningThrows: true } })).base, TRIGGER_SECRET)).status, 503);
  assert.equal((await trigger((await serve({ starter: { startThrows: true } })).base, TRIGGER_SECRET)).status, 500);
});

test('trigger: wrong key → 401, isRunning not called; no key → 401; nothing logs the key', async () => {
  const s = await serve();
  assert.equal((await trigger(s.base, `${TRIGGER_SECRET}x`)).status, 401);
  assert.equal((await trigger(s.base, TRIGGER_SECRET.slice(0, -1))).status, 401);
  assert.equal((await trigger(s.base)).status, 401);
  assert.equal((await trigger(s.base, '')).status, 401);
  assert.equal(s.calls.isRunning, 0);
  await trigger(s.base, TRIGGER_SECRET);
  assert.ok(s.logs.every((l) => !l.includes(TRIGGER_SECRET.slice(0, 12))), s.logs.join('\n'));
});

test('trigger: a second trigger while the first is starting → 409, start runs once', async () => {
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => { release = r; });
  const starts: RunTrigger[] = [];
  const app = createApp({
    appSecret: APP_SECRET, callbackUrl: CALLBACK, triggerSecret: TRIGGER_SECRET, onComment: () => true, log: () => {},
    starter: { isRunning: async () => { await gateOpen; return false; }, start: async (t) => { starts.push(t); } },
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const first = trigger(base, TRIGGER_SECRET);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await trigger(base, TRIGGER_SECRET)).status, 409);
  release();
  assert.equal((await first).status, 202);
  assert.deepEqual(starts, ['scheduled']);
});
