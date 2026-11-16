import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, type Env } from '../relay/src/index.ts';
import { buildLabel, inSubnet } from '../relay/src/gate.ts';
import { commentWebhook } from './support/webhook.ts';

const SENTINEL = 'zq-sentinel-7781';
const NOW = Date.UTC(2026, 10, 16, 21, 3, 30);
const IDS = { card: 'fa4e00000000000000000012', board: 'fa4e00000000000000000005', action: 'fa4e00000000000000000013' };
const author = { id: 'fa4e00000000000000000002', username: 'usera', fullName: 'User A' } as never;

const keys = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;

type Call = { method: string; url: string; headers: Headers; body: string };

function harness(o: { routes?: Record<string, () => Response>; env?: Env; now?: () => number } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const routes: Record<string, () => Response> = {
    'GET /repos/user-a/career-cards-a/installation': () => Response.json({ id: 777 }),
    'POST /app/installations/777/access_tokens': () =>
      Response.json({ token: 'ghs_test', expires_at: new Date(NOW + 3600_000).toISOString() }, { status: 201 }),
    'GET /repos/user-a/career-cards-a': () => Response.json({ default_branch: 'trunk' }),
    'POST /repos/user-a/career-cards-a/actions/workflows/bot.yml/dispatches': () => new Response(null, { status: 204 }),
    ...o.routes,
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, 'https://api.github.com');
    calls.push({ method: req.method, url: url.pathname, headers: req.headers, body: await req.text() });
    const route = routes[`${req.method} ${url.pathname}`];
    return route ? route() : new Response('nope', { status: 599 });
  };
  const relay = createRelay({ fetch, now: o.now ?? (() => NOW), log: (s) => logs.push(s) });
  const env: Env = { GITHUB_APP_ID: '12345', GITHUB_APP_PRIVATE_KEY_PKCS8: PEM, ...o.env };
  const send = async (req: Request) => {
    const pending: Promise<unknown>[] = [];
    const res = await relay.fetch(req, env, { waitUntil: (p) => void pending.push(p) });
    await Promise.all(pending);
    return res;
  };
  return { calls, logs, send };
}

const hook = (body: BodyInit | null, o: { ip?: string; path?: string; method?: string } = {}) =>
  new Request(`https://relay.example${o.path ?? '/hook/user-a/career-cards-a'}`, {
    method: o.method ?? 'POST',
    headers: { 'cf-connecting-ip': o.ip ?? '104.192.142.245', 'content-type': 'application/json' },
    body,
  });

const comment = (text: string, shortLink = '4EyYg0x3') => {
  const b = commentWebhook({ cardId: IDS.card, boardId: IDS.board, author, text, id: IDS.action }) as any;
  b.action.data.card.shortLink = shortLink;
  return JSON.stringify(b);
};

test('HEAD on a hook path answers 200', async () => {
  const h = harness();
  const res = await h.send(hook(null, { method: 'HEAD' }));
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, 0);
});

test('bad paths answer 404', async () => {
  const h = harness();
  for (const path of ['/', '/hook/user-a', '/hook/user_a/repo', '/hook/user-a/re%2Fpo', '/hook/user-a/repo/x', `/hook/${'a'.repeat(40)}/r`]) {
    assert.equal((await h.send(hook(comment('/bot run'), { path }))).status, 404, path);
  }
  assert.equal((await h.send(hook(null, { method: 'GET' }))).status, 404);
  assert.equal(h.calls.length, 0);
});

test('a POST from outside the Trello subnet is dropped without any fetch', async () => {
  for (const ip of ['1.2.3.4', '104.192.142.239', '104.192.142.256', '', '104.192.142.245, 1.2.3.4']) {
    const h = harness();
    const res = await h.send(hook(comment('/bot run'), { ip }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(h.logs, ['drop ip'], ip);
    assert.equal(h.calls.length, 0);
  }
});

test('the IP header is configurable', async () => {
  const h = harness({ env: { RELAY_IP_HEADER: 'x-envoy-external-address' } });
  await h.send(hook(comment('/bot run')));
  assert.deepEqual(h.logs, ['drop ip']);
  const req = hook(comment('/bot run'), { ip: '1.2.3.4' });
  req.headers.set('x-envoy-external-address', '104.192.142.240');
  await h.send(req);
  assert.equal(h.logs[1], 'dispatch 204');
});

test('subnet check', () => {
  assert.ok(inSubnet('104.192.142.240'));
  assert.ok(inSubnet('104.192.142.255'));
  assert.ok(!inSubnet('104.192.143.0'));
  assert.ok(!inSubnet('::ffff:104.192.142.240x'));
  assert.ok(inSubnet('::ffff:104.192.142.241'));
  assert.ok(!inSubnet('104.192.142.0241'));
});

test('junk bodies answer 200 and are dropped with one status word', async () => {
  const cases: [BodyInit | null, string][] = [
    ['not json', 'drop json'],
    ['null', 'drop not-comment'],
    ['"x"', 'drop not-comment'],
    [JSON.stringify({ action: { type: 'updateCard', data: { text: '/bot run' } } }), 'drop not-comment'],
    [comment('just a note'), 'drop no-keyword'],
    [comment('   '), 'drop no-keyword'],
    [JSON.stringify({ action: { type: 'commentCard', data: { text: 5 } } }), 'drop no-keyword'],
    [JSON.stringify({ action: { type: 'commentCard', data: { text: '/bot run' } } }), 'drop bad-ids'],
    ['x'.repeat(256 * 1024 + 1), 'drop size'],
  ];
  for (const [body, word] of cases) {
    const h = harness();
    const res = await h.send(hook(body));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(h.logs, [word]);
    assert.equal(h.calls.length, 0);
  }
});

test('a streamed oversized body is dropped', async () => {
  const h = harness();
  const chunk = new Uint8Array(64 * 1024);
  let n = 0;
  const body = new ReadableStream({
    pull(c) {
      if (n++ < 10) c.enqueue(chunk);
      else c.close();
    },
  });
  const req = new Request('https://relay.example/hook/user-a/career-cards-a', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '104.192.142.245' },
    body,
    duplex: 'half',
  } as RequestInit);
  assert.equal((await h.send(req)).status, 200);
  assert.deepEqual(h.logs, ['drop size']);
});

test('/bot run dispatches bot.yml with the ids and a slug label', async () => {
  const h = harness();
  const res = await h.send(hook(comment(`/bot run ${SENTINEL}`)));
  assert.equal(res.status, 200);
  assert.deepEqual(h.logs, ['dispatch 204']);
  assert.deepEqual(
    h.calls.map((c) => `${c.method} ${c.url}`),
    [
      'GET /repos/user-a/career-cards-a/installation',
      'POST /app/installations/777/access_tokens',
      'GET /repos/user-a/career-cards-a',
      'POST /repos/user-a/career-cards-a/actions/workflows/bot.yml/dispatches',
    ],
  );
  const d = h.calls[3]!;
  assert.equal(d.headers.get('authorization'), 'Bearer ghs_test');
  assert.deepEqual(JSON.parse(d.body), {
    ref: 'trunk',
    inputs: { action_id: IDS.action, card_id: IDS.card, board_id: IDS.board, label: 'run-4EyYg0x3-1116-2103z' },
  });
  const tok = JSON.parse(h.calls[1]!.body);
  assert.deepEqual(tok.repositories, ['career-cards-a']);
  assert.equal(tok.permissions.actions, 'write');
});

test('labels: verb after the keyword or ask; shortLink or the card id', () => {
  const at = new Date(Date.UTC(2026, 0, 2, 3, 4));
  const L = (text: string, shortLink?: unknown, id = IDS.card) => buildLabel(text, { shortLink, id }, at);
  assert.equal(L('/bot why', 'abcdEFGH'), 'why-abcdEFGH-0102-0304z');
  assert.equal(L('@carbot  re-score now', 'abcdEFGH'), 're-score-abcdEFGH-0102-0304z');
  assert.equal(L('/bot', 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L('/bot What is this', 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L(`/bot ${SENTINEL}`, 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L('/bot ab_cd', 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L(`/bot ${'a'.repeat(21)}`, 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L('hello @carbot run', 'abcdEFGH'), 'ask-abcdEFGH-0102-0304z');
  assert.equal(L('/bot run', 'bad/link'), 'run-fa4e0000-0102-0304z');
  assert.equal(L('/bot run', ''), 'run-fa4e0000-0102-0304z');
  assert.equal(L('/bot run', undefined, 'zz'), 'run-00000000-0102-0304z');
});

test('ALLOWED_OWNERS limits whose repos get a dispatch', async () => {
  const off = harness({ env: { ALLOWED_OWNERS: 'user-b, other' } });
  await off.send(hook(comment('/bot run')));
  assert.deepEqual(off.logs, ['drop owner']);
  assert.equal(off.calls.length, 0);
  const on = harness({ env: { ALLOWED_OWNERS: 'user-b,User-A' } });
  await on.send(hook(comment('/bot run')));
  assert.deepEqual(on.logs, ['dispatch 204']);
});

test('GitHub failures still answer 200 and log the stage and status', async () => {
  const cases: [Record<string, () => Response>, string][] = [
    [{ 'GET /repos/user-a/career-cards-a/installation': () => new Response('{}', { status: 404 }) }, 'fail install 404'],
    [{ 'POST /app/installations/777/access_tokens': () => new Response('{}', { status: 401 }) }, 'fail token 401'],
    [{ 'POST /app/installations/777/access_tokens': () => Response.json({ token: 1 }, { status: 201 }) }, 'fail token bad'],
    [{ 'GET /repos/user-a/career-cards-a': () => new Response('{}', { status: 500 }) }, 'fail repo 500'],
    [{ 'POST /repos/user-a/career-cards-a/actions/workflows/bot.yml/dispatches': () => new Response('', { status: 422 }) }, 'fail dispatch 422'],
    [{ 'GET /repos/user-a/career-cards-a/installation': () => { throw new TypeError('network down'); } }, 'fail install net'],
  ];
  for (const [routes, word] of cases) {
    const h = harness({ routes });
    const res = await h.send(hook(comment('/bot run')));
    assert.equal(res.status, 200);
    assert.deepEqual(h.logs, [word]);
  }
});

test('missing or PKCS#1 key logs fail key, never throws', async () => {
  for (const env of [
    { GITHUB_APP_PRIVATE_KEY_PKCS8: '' },
    { GITHUB_APP_ID: '' },
    { GITHUB_APP_PRIVATE_KEY_PKCS8: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' },
    { GITHUB_APP_PRIVATE_KEY_PKCS8: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' },
  ]) {
    const h = harness({ env });
    const res = await h.send(hook(comment('/bot run')));
    assert.equal(res.status, 200);
    assert.deepEqual(h.logs, ['fail key']);
    assert.equal(h.calls.length, 0);
  }
});

test('the installation token, JWT and default branch are cached per isolate', async () => {
  let now = NOW;
  const h = harness({ now: () => now });
  await h.send(hook(comment('/bot run')));
  now += 30 * 60_000;
  await h.send(hook(comment('/bot why')));
  const count = (p: string) => h.calls.filter((c) => `${c.method} ${c.url}` === p).length;
  assert.equal(count('POST /app/installations/777/access_tokens'), 1);
  assert.equal(count('GET /repos/user-a/career-cards-a'), 1);
  assert.equal(count('POST /repos/user-a/career-cards-a/actions/workflows/bot.yml/dispatches'), 2);
  now += 26 * 60_000; // within 5 min of expires_at: refresh
  await h.send(hook(comment('/bot why')));
  assert.equal(count('POST /app/installations/777/access_tokens'), 2);
  const jwts = h.calls.filter((c) => c.url.startsWith('/app/') || c.url.endsWith('/installation'));
  // JWT lives 10 min: the first and the refreshed calls are > 56 min apart, so two distinct JWTs.
  assert.notEqual(jwts[0]!.headers.get('authorization'), jwts[2]!.headers.get('authorization'));
  assert.equal(jwts[0]!.headers.get('authorization'), jwts[1]!.headers.get('authorization'));
});

test('a 401 on dispatch drops the cached token', async () => {
  let status = 401;
  const h = harness({
    routes: { 'POST /repos/user-a/career-cards-a/actions/workflows/bot.yml/dispatches': () => new Response(null, { status }) },
  });
  await h.send(hook(comment('/bot run')));
  status = 204;
  await h.send(hook(comment('/bot run')));
  assert.deepEqual(h.logs, ['fail dispatch 401', 'dispatch 204']);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 2);
});

test('the JWT is RS256, verifies with the public key, and has the right claims', async () => {
  const h = harness();
  await h.send(hook(comment('/bot run')));
  const auth = h.calls[0]!.headers.get('authorization')!;
  assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const [head, body, sig] = auth.slice(7).split('.') as [string, string, string];
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    keys.publicKey,
    Buffer.from(sig, 'base64url'),
    new TextEncoder().encode(`${head}.${body}`),
  );
  assert.ok(ok);
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const s = Math.floor(NOW / 1000);
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString()), { iat: s - 60, exp: s + 540, iss: '12345' });
});

test('logs never contain comment text, ids or tokens', async () => {
  const h = harness();
  await h.send(hook(comment(`/bot run ${SENTINEL}`)));
  await h.send(hook(comment(`${SENTINEL} @bot`).replace('commentCard', 'updateCard')));
  await h.send(hook(comment(`plain ${SENTINEL}`)));
  await h.send(hook(`{"broken": "${SENTINEL}`));
  const all = h.logs.join('\n');
  assert.equal(h.logs.length, 4);
  for (const secret of [SENTINEL, IDS.card, IDS.action, IDS.board, 'ghs_test', 'user-a']) assert.ok(!all.includes(secret), secret);
});

test('an unexpected error inside the handler still answers 200', async () => {
  const h = harness();
  const req = hook(comment('/bot run'));
  Object.defineProperty(req, 'body', { get: () => { throw new Error('boom'); } });
  const res = await h.send(req);
  assert.equal(res.status, 200);
  assert.deepEqual(h.logs, ['fail internal']);
});

test('a repo without the App is not looked up again for 10 minutes', async () => {
  let now = NOW;
  const h = harness({
    now: () => now,
    routes: { 'GET /repos/user-a/career-cards-a/installation': () => new Response('{}', { status: 404 }) },
  });
  await h.send(hook(comment('/bot run')));
  now += 9 * 60_000;
  await h.send(hook(comment('/bot run')));
  now += 2 * 60_000;
  await h.send(hook(comment('/bot run')));
  assert.deepEqual(h.logs, ['fail install 404', 'fail install 404-cached', 'fail install 404']);
  assert.equal(h.calls.length, 2);
});

test('concurrent requests for one repo share one token request', async () => {
  const h = harness();
  await Promise.all([h.send(hook(comment('/bot run'))), h.send(hook(comment('/bot why')))]);
  assert.deepEqual(h.logs, ['dispatch 204', 'dispatch 204']);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 1);
});
