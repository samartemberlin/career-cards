import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRelay } from '../relay/src/index.ts';
import { serve } from '../relay/src/node.ts';

test('node adapter: HEAD, 404, and a POST body reach the core; Northflank header is honoured', async () => {
  const logs: string[] = [];
  const relay = createRelay({
    fetch: async () => {
      throw new Error('no network in tests');
    },
    now: Date.now,
    log: (s) => logs.push(s),
  });
  const server = serve(relay, { RELAY_IP_HEADER: 'x-envoy-external-address' }, 0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/hook/user-a/repo`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const post = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/hook/user-a/repo`, { method: 'POST', headers, body });
    const spoof = await post({ 'cf-connecting-ip': '104.192.142.241' }, 'x');
    assert.equal(spoof.status, 200);
    assert.equal(await spoof.text(), 'ok');
    const res = await post({ 'x-envoy-external-address': '104.192.142.241' }, 'not json');
    assert.equal(res.status, 200);
    const big = await post({ 'x-envoy-external-address': '104.192.142.241' }, 'x'.repeat(300 * 1024));
    assert.equal(big.status, 200);
    assert.deepEqual(logs, ['head', 'notfound', 'drop ip', 'drop json', 'drop size']);
  } finally {
    server.close();
  }
});

test('node entry refuses to start without RELAY_IP_HEADER', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
  delete env.RELAY_IP_HEADER;
  const r = spawnSync(process.execPath, [new URL('../relay/src/node.ts', import.meta.url).pathname], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RELAY_IP_HEADER/);
});
