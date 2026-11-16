import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createRelay } from '../relay/src/index.ts';
import { checkEnv, serve, shutdown } from '../relay/src/node.ts';
import { hookSig } from '../relay/src/sig.ts';

const SECRET = 'test-path-secret-0123456789abcdef';
const ENV = { RELAY_IP_HEADER: 'x-envoy-external-address', RELAY_PATH_SECRET: SECRET };
const ENTRY = new URL('../relay/src/node.ts', import.meta.url).pathname;

function start() {
  const logs: string[] = [];
  const relay = createRelay({
    fetch: async () => {
      throw new Error('no network in tests');
    },
    now: Date.now,
    log: (s) => logs.push(s),
  });
  const server = serve(relay, ENV, 0);
  return { logs, server };
}

test('node adapter: HEAD, 404, and a POST body reach the core; Northflank header is honoured', async () => {
  const { logs, server } = start();
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hook = `${base}/hook/user-a/repo/${await hookSig(SECRET, 'user-a', 'repo')}`;
  try {
    assert.equal((await fetch(hook, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/hook/user-a/repo/wrong`, { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const post = (headers: Record<string, string>, body: string) => fetch(hook, { method: 'POST', headers, body });
    const spoof = await post({ 'cf-connecting-ip': '104.192.142.241' }, 'x');
    assert.equal(spoof.status, 200);
    assert.equal(await spoof.text(), 'ok');
    const res = await post({ 'x-envoy-external-address': '104.192.142.241' }, 'not json');
    assert.equal(res.status, 200);
    assert.deepEqual(logs, ['head', 'drop sig', 'notfound', 'drop ip', 'drop json']);
  } finally {
    await shutdown(server, 100);
  }
});

test('node adapter: an oversized body answers 200 with connection: close, and the server keeps serving', async () => {
  const { logs, server } = start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const path = `/hook/user-a/repo/${await hookSig(SECRET, 'user-a', 'repo')}`;
  try {
    // Chunked, no Content-Length: the core stops reading part-way.
    const res = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = request({ port, path, method: 'POST', headers: { 'x-envoy-external-address': '104.192.142.241' } }, (r) => {
        r.resume();
        r.on('end', () => resolve({ status: r.statusCode!, connection: r.headers.connection }));
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let i = 0; i < 5; i++) req.write(chunk);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.equal(res.connection, 'close');
    assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { method: 'HEAD' })).status, 200);
    assert.deepEqual(logs, ['drop size', 'head']);
  } finally {
    await shutdown(server, 100);
  }
});

test('checkEnv refuses unsafe settings', () => {
  assert.doesNotThrow(() => checkEnv(ENV, 'production'));
  assert.throws(() => checkEnv({ ...ENV, RELAY_IP_HEADER: '' }), /RELAY_IP_HEADER/);
  assert.throws(() => checkEnv({ ...ENV, RELAY_PATH_SECRET: 'short' }), /RELAY_PATH_SECRET/);
  assert.throws(() => checkEnv({ ...ENV, RELAY_SKIP_IP_CHECK: '1' }, 'production'), /RELAY_SKIP_IP_CHECK/);
  assert.throws(() => checkEnv({ ...ENV, RELAY_SKIP_IP_CHECK: '1' }, undefined), /RELAY_SKIP_IP_CHECK/);
  assert.doesNotThrow(() => checkEnv({ ...ENV, RELAY_SKIP_IP_CHECK: '1' }, 'test'));
  assert.throws(() => serve(createRelay({ fetch, now: Date.now, log: () => {} }), {}, 0), /RELAY_IP_HEADER/);
});

test('node entry refuses to start on an unsafe env', () => {
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, PORT: '0', ...ENV };
  for (const [drop, extra, re] of [
    ['RELAY_IP_HEADER', {}, /RELAY_IP_HEADER/],
    ['RELAY_PATH_SECRET', {}, /RELAY_PATH_SECRET/],
    ['', { RELAY_SKIP_IP_CHECK: '1' }, /RELAY_SKIP_IP_CHECK/],
  ] as const) {
    const env: NodeJS.ProcessEnv = { ...base, ...extra };
    if (drop) delete env[drop];
    const r = spawnSync(process.execPath, [ENTRY], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, drop || 'skip');
    assert.match(r.stderr, re);
  }
});

test('node entry exits 0 on SIGTERM', async () => {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, PORT: '0', ...ENV } });
  let out = '';
  await new Promise<void>((r) =>
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('listening')) r();
    }),
  );
  assert.match(out, /allowed owners: any/);
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
});

test('hook-url prints the signed callback URL', async () => {
  const cli = new URL('../relay/src/hook-url.ts', import.meta.url).pathname;
  const run = (args: string[], secret = SECRET) =>
    spawnSync(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, RELAY_PATH_SECRET: secret }, encoding: 'utf8' });
  const ok = run(['https://relay.example/', 'user-a/repo']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), `https://relay.example/hook/user-a/repo/${await hookSig(SECRET, 'user-a', 'repo')}`);
  assert.equal(run(['https://relay.example', 'user-a/..']).status, 2);
  assert.equal(run(['https://relay.example', 'user-a']).status, 2);
  assert.equal(run(['https://relay.example', 'user-a/repo'], 'short').status, 2);
});
