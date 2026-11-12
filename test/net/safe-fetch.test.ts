import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BlockedUrlError,
  assertPublicUrl,
  isPublicAddress,
  safeFetch,
  safeFetchLike,
} from '../../src/net/safe-fetch.ts';
import type { LookupAll } from '../../src/net/safe-fetch.ts';

const seen: string[] = [];
let lastHeaders: Record<string, string | string[] | undefined> = {};
const server = createServer((req, res) => {
  const path = req.url ?? '';
  seen.push(path);
  lastHeaders = req.headers;
  const n = /^\/redirect-(\d+)$/.exec(path);
  if (n) {
    const left = Number(n[1]);
    res.writeHead(302, { location: left > 1 ? `/redirect-${left - 1}` : '/ok' }).end();
  } else if (path === '/ok') {
    res.end('hello');
  } else if (path === '/to-loopback') {
    onToLoopback();
    res.writeHead(301, { location: `http://inner.test:${port}/ok` }).end();
  } else if (path === '/big') {
    res.end('x'.repeat(100_000));
  } else if (path === '/slow') {
    // never answers
  } else {
    res.writeHead(404).end('no');
  }
});
let port = 0;
let onToLoopback = (): void => {};

test.before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.after(() => { server.closeAllConnections(); server.close(); });
test.beforeEach(() => { seen.length = 0; });

const toLoopback: LookupAll = async () => [{ address: '127.0.0.1', family: 4 }];
const onlyLoopback = (ip: string): boolean => ip === '127.0.0.1';
const noDns: LookupAll = async (host) => { throw new Error(`unexpected lookup of ${host}`); };
const tableOf = (m: Record<string, string>): LookupAll => async (host) => {
  const a = m[host];
  if (!a) throw new Error(`ENOTFOUND ${host}`);
  return [{ address: a, family: a.includes(':') ? 6 : 4 }];
};

test('isPublicAddress blocks every listed range and passes public addresses', () => {
  const blocked = [
    '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.0.0.8', '192.168.1.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1',
    '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1',
    '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1',
    'fe80::1%eth0', '::127.0.0.1', '2002:7f00:1::1', '64:ff9b:1::8.8.8.8',
    'not-an-ip', '', '0177.0.0.1', '0x7f.0.0.1', '127.1', '2130706433',
  ];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip);
  const allowed = ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
    '198.17.255.255', '198.20.0.0', '223.255.255.255', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'];
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, ip);
});

test('blocks http://169.254.169.254/latest/meta-data without a request', async () => {
  await assert.rejects(safeFetch('http://169.254.169.254/latest/meta-data', { lookup: noDns }), BlockedUrlError);
  assert.deepEqual(seen, []);
});

test('blocks localhost and a name resolving to 10.0.0.5', async () => {
  await assert.rejects(assertPublicUrl('http://localhost/', { lookup: noDns }), BlockedUrlError);
  await assert.rejects(assertPublicUrl('http://LOCALHOST./', { lookup: noDns }), BlockedUrlError);
  await assert.rejects(assertPublicUrl('http://a.localhost/', { lookup: noDns }), BlockedUrlError);
  const lookup = tableOf({ 'intranet.test': '10.0.0.5' });
  await assert.rejects(assertPublicUrl('http://intranet.test/', { lookup }), BlockedUrlError);
  const mixed: LookupAll = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(assertPublicUrl('http://mixed.test/', { lookup: mixed }), BlockedUrlError);
  const none: LookupAll = async () => [];
  await assert.rejects(assertPublicUrl('http://empty.test/', { lookup: none }), BlockedUrlError);
  const ok = await assertPublicUrl('https://jobs.test/x', { lookup: tableOf({ 'jobs.test': '8.8.8.8' }) });
  assert.equal(ok.href, 'https://jobs.test/x');
});

test('blocks loopback written in short, octal, hex, decimal and IPv6 forms', async () => {
  for (const u of [
    'http://127.1/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://2130706433/', 'http://0/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::7f00:1]/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'http://[fe80::1]/',
  ]) {
    await assert.rejects(assertPublicUrl(u, { lookup: noDns }), BlockedUrlError, u);
  }
  await assert.rejects(assertPublicUrl('http://[fe80::1%25eth0]/', { lookup: noDns }));
});

test('blocks ftp:, file:, javascript: and user:pass@ URLs', async () => {
  const lookup = tableOf({ 'jobs.test': '8.8.8.8' });
  for (const u of ['ftp://jobs.test/x', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@jobs.test/',
    'http://user@jobs.test/', 'not a url']) {
    await assert.rejects(assertPublicUrl(u, { lookup }), BlockedUrlError, u);
  }
  await assert.rejects(assertPublicUrl('http://user:hunter2@jobs.test/', { lookup }), (e: Error) => {
    assert.ok(e instanceof BlockedUrlError);
    assert.ok(!e.url.includes('hunter2') && !e.message.includes('hunter2'));
    return true;
  });
});

test('follows 5 redirects, refuses the 6th', async () => {
  const o = { lookup: toLoopback, allow: onlyLoopback };
  const r = await safeFetch(`http://public.test:${port}/redirect-5`, o);
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello');
  assert.equal(r.url, `http://public.test:${port}/ok`);
  seen.length = 0;
  await assert.rejects(safeFetch(`http://public.test:${port}/redirect-6`, o), BlockedUrlError);
  assert.ok(!seen.includes('/ok'));
  await assert.rejects(safeFetch(`http://public.test:${port}/redirect-1`, { ...o, maxRedirects: 0 }), BlockedUrlError);
});

test('blocks a redirect to loopback', async () => {
  let firstHop = true;
  onToLoopback = () => { firstHop = false; };
  const allow = (ip: string): boolean => (firstHop ? onlyLoopback(ip) : isPublicAddress(ip));
  try {
    const lookup = tableOf({ 'public.test': '127.0.0.1', 'inner.test': '127.0.0.1' });
    await assert.rejects(safeFetch(`http://public.test:${port}/to-loopback`, { lookup, allow }), BlockedUrlError);
    assert.deepEqual(seen, ['/to-loopback']);
  } finally {
    onToLoopback = () => {};
  }
});

test('blocks at connect time', async () => {
  let calls = 0;
  const rebinding: LookupAll = async () => [{ address: calls++ === 0 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  await assert.rejects(safeFetch(`http://rebind.test:${port}/ok`, { lookup: rebinding }), BlockedUrlError);
  assert.ok(calls >= 2);
  assert.deepEqual(seen, []);
});

test('cuts the body at maxBytes', async () => {
  const r = await safeFetch(`http://public.test:${port}/big`, { lookup: toLoopback, allow: onlyLoopback, maxBytes: 1000 });
  assert.equal(r.text, 'x'.repeat(1000));
});

test('times out', async () => {
  const t0 = Date.now();
  await assert.rejects(safeFetch(`http://public.test:${port}/slow`, { lookup: toLoopback, allow: onlyLoopback, timeoutMs: 100 }));
  assert.ok(Date.now() - t0 < 2000);
});

test('returns non-2xx responses without throwing', async () => {
  const r = await safeFetch(`http://public.test:${port}/missing`, { lookup: toLoopback, allow: onlyLoopback });
  assert.deepEqual([r.ok, r.status, r.text], [false, 404, 'no']);
});

test('safeFetchLike is a FetchLike that sends the caller headers', async () => {
  const f = safeFetchLike({ lookup: toLoopback, allow: onlyLoopback });
  const r = await f(`http://public.test:${port}/ok`, { headers: { 'user-agent': 'probe/1' }, redirect: 'follow' });
  assert.equal(r.ok, true);
  assert.equal(await r.text(), 'hello');
  assert.equal(lastHeaders['user-agent'], 'probe/1');
  await assert.rejects(f('http://10.0.0.1/'), BlockedUrlError);
});

test('safeFetchLike honours the caller abort signal', async () => {
  const f = safeFetchLike({ lookup: toLoopback, allow: onlyLoopback });
  await assert.rejects(f(`http://public.test:${port}/slow`, { signal: AbortSignal.timeout(50) }));
});
