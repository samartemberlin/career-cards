import test from 'node:test';
import assert from 'node:assert/strict';
import { northflankStarter, selectStarter } from '../../src/serve/northflank.ts';
import type { NorthflankOpts } from '../../src/serve/northflank.ts';
import { serialStarter, startRun } from '../../src/serve/runs.ts';
import type { RunStarter } from '../../src/serve/runs.ts';

const TOKEN = 'tok-secret-123';
const BASE = 'https://api.northflank.test';
const RUNS = `${BASE}/v1/projects/proj-a/jobs/job-a/runs`;

type Reply = { status?: number; body?: unknown } | 'hang' | 'hang-ignoring-signal';
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown; redirect?: string };

/** Scripted fetch: `list` and `start` answer every GET and POST; shapes follow Northflank's API docs. */
function fakeApi(o: { list?: Reply; start?: Reply } = {}) {
  const calls: Call[] = [];
  const answer = (r: Reply, signal: AbortSignal | null | undefined): Promise<Response> => {
    if (r === 'hang-ignoring-signal') return new Promise(() => {});
    if (r === 'hang') {
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    }
    const status = r.status ?? 200;
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status }));
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url: String(input),
      method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init?.redirect,
    });
    if (method === 'POST') return answer(o.start ?? { body: { data: { id: 'r1', runName: 'run-1' } } }, init?.signal);
    return answer(o.list ?? { body: { data: { runs: [] } } }, init?.signal);
  }) as typeof fetch;
  return { fetchImpl, calls, posts: () => calls.filter((c) => c.method === 'POST').length };
}

function starter(api: ReturnType<typeof fakeApi>, o: Partial<NorthflankOpts> = {}) {
  return northflankStarter({ token: TOKEN, projectId: 'proj-a', jobId: 'job-a', apiBase: BASE, fetchImpl: api.fetchImpl, ...o });
}

const run = (id: string, concluded: boolean, status: string) => ({ id, runName: `run-${id}`, concluded, status });

test('starts a run when no run is active and passes the trigger', async () => {
  const api = fakeApi({ list: { body: { data: { runs: [run('r0', true, 'SUCCESS')] } } } });
  const s = starter(api);
  assert.equal(await s.isRunning(), false);
  await s.start('scheduled');
  assert.equal(api.calls[0]!.url, `${RUNS}?per_page=20`);
  const post = api.calls[1]!;
  assert.equal(post.url, RUNS);
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { runtimeEnvironment: { RUN_TRIGGER: 'scheduled' } });
  assert.equal(post.headers['content-type'], 'application/json');
});

test('an active run means busy, and nothing is POSTed', async () => {
  const api = fakeApi({ list: { body: { data: { runs: [run('r2', false, 'RUNNING'), run('r1', true, 'SUCCESS')] } } } });
  assert.equal(await startRun(starter(api), 'manual', () => {}), 'busy');
  assert.equal(api.posts(), 0);
});

test('a concluded FAILED run is not busy', async () => {
  const api = fakeApi({ list: { body: { data: { runs: [run('r1', true, 'FAILED')] } } } });
  assert.equal(await startRun(starter(api), 'manual', () => {}), 'started');
  assert.equal(api.posts(), 1);
});

test('concurrent starts through serialStarter start one run', async () => {
  const api = fakeApi();
  const s = serialStarter(starter(api));
  const results = await Promise.all([startRun(s, 'manual', () => {}), startRun(s, 'scheduled', () => {})]);
  assert.equal(api.posts(), 1);
  assert.deepEqual(results.sort(), ['busy', 'started']);
});

test('a run started 60 s ago that the list does not show yet is still busy', async () => {
  let t = 1_000_000;
  const api = fakeApi();
  const s = starter(api, { now: () => t });
  await s.start('manual');
  t += 60_000;
  assert.equal(await s.isRunning(), true);
});

test('after 120 s the in-memory guard lapses and the list decides', async () => {
  let t = 1_000_000;
  const api = fakeApi();
  const s = starter(api, { now: () => t });
  await s.start('manual');
  t += 121_000;
  assert.equal(await s.isRunning(), false);
});

test('a start that timed out still counts as just started (it may have reached Northflank)', async () => {
  let t = 1_000_000;
  const api = fakeApi({ start: 'hang' });
  const s = starter(api, { now: () => t, timeoutMs: 20 });
  await assert.rejects(s.start('manual'), /northflank timeout on start/);
  t += 60_000;
  assert.equal(await s.isRunning(), true);
});

test('a refused start (4xx) does not hold the guard', async () => {
  const api = fakeApi({ start: { status: 403, body: { error: 'nope' } } });
  const s = starter(api);
  await assert.rejects(s.start('manual'), /northflank 403 on start/);
  assert.equal(await s.isRunning(), false);
});

test('401 on list is an error naming the status, not the token or the body', async () => {
  const api = fakeApi({ list: { status: 401, body: { error: `bad token ${TOKEN}` } } });
  const s = starter(api);
  const err = await s.isRunning().then(() => null, (e: unknown) => e as Error);
  assert.ok(err);
  assert.match(err.message, /northflank 401 on list/);
  assert.doesNotMatch(`${err.message} ${String(err.stack)}`, /tok-secret-123|bad token/);
  const logs: string[] = [];
  assert.equal(await startRun(s, 'manual', (l) => logs.push(l)), 'unknown');
  assert.equal(api.posts(), 0);
  assert.doesNotMatch(logs.join('\n'), /tok-secret-123/);
});

test('a non-2xx on start throws naming the status, never the body', async () => {
  const api = fakeApi({ start: { status: 500, body: { error: TOKEN } } });
  const err = await starter(api).start('manual').then(() => null, (e: unknown) => e as Error);
  assert.ok(err);
  assert.equal(err.message, 'northflank 500 on start');
});

test('a hanging list gives an error after timeoutMs', async () => {
  const api = fakeApi({ list: 'hang' });
  await assert.rejects(starter(api, { timeoutMs: 50 }).isRunning(), /northflank timeout on list/);
});

test('a fetch that never answers and ignores the signal still settles, so serialStarter releases its claim', async () => {
  const api = fakeApi({ start: 'hang-ignoring-signal' });
  let t = 1_000_000;
  const s = serialStarter(starter(api, { timeoutMs: 30, now: () => t }));
  assert.equal(await startRun(s, 'manual', () => {}), 'failed');
  t += 121_000;
  // The claim is released: the next check reaches Northflank's list again instead of answering busy.
  const before = api.calls.length;
  assert.equal(await s.isRunning(), false);
  assert.equal(api.calls.length, before + 1);
});

test('a list that never answers and ignores the signal settles too', async () => {
  const api = fakeApi({ list: 'hang-ignoring-signal' });
  await assert.rejects(starter(api, { timeoutMs: 30 }).isRunning(), /northflank timeout on list/);
});

test('a malformed reply is an error, not a start', async () => {
  const api = fakeApi({ list: { body: { data: { runs: 'x' } } } });
  assert.equal(await startRun(starter(api), 'manual', () => {}), 'unknown');
  assert.equal(api.posts(), 0);
});

test('a non-JSON reply is a bad reply', async () => {
  const fetchImpl = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
  await assert.rejects(starter(fakeApi(), { fetchImpl }).isRunning(), /northflank bad reply on list/);
});

test('a malformed start reply throws a bad reply', async () => {
  const api = fakeApi({ start: { body: { data: {} } } });
  await assert.rejects(starter(api).start('manual'), /northflank bad reply on start/);
});

test('a network failure names neither the URL nor the cause', async () => {
  const fetchImpl = (async () => { throw new TypeError(`fetch failed ${TOKEN}`); }) as typeof fetch;
  const err = await starter(fakeApi(), { fetchImpl }).isRunning().then(() => null, (e: unknown) => e as Error);
  assert.equal(err?.message, 'northflank unreachable on list');
});

test('the bearer token is sent to apiBase only, without following redirects', async () => {
  const api = fakeApi();
  const s = starter(api);
  await s.isRunning();
  await s.start('manual');
  assert.equal(api.calls.length, 2);
  for (const c of api.calls) {
    assert.ok(c.url.startsWith(`${BASE}/`));
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.redirect, 'error');
    assert.doesNotMatch(c.url, /tok-secret/);
  }
});

test('ids are path-encoded', async () => {
  const api = fakeApi();
  await northflankStarter({ token: TOKEN, projectId: 'a/b', jobId: 'c?d', apiBase: BASE, fetchImpl: api.fetchImpl }).isRunning();
  assert.equal(api.calls[0]!.url, `${BASE}/v1/projects/a%2Fb/jobs/c%3Fd/runs?per_page=20`);
});

test('the default apiBase is api.northflank.com', async () => {
  const api = fakeApi();
  await northflankStarter({ token: TOKEN, projectId: 'p', jobId: 'j', fetchImpl: api.fetchImpl }).isRunning();
  assert.ok(api.calls[0]!.url.startsWith('https://api.northflank.com/v1/projects/p/jobs/j/runs'));
});

test('selectStarter: all three set → northflank; none → local; some → throws naming the missing ones', async () => {
  const local: RunStarter = { isRunning: async () => false, start: async () => {} };
  let made = 0;
  const mk = () => { made++; return local; };

  assert.equal(selectStarter({}, mk), local);
  assert.equal(made, 1);

  const api = fakeApi();
  const nf = selectStarter(
    { NORTHFLANK_API_TOKEN: TOKEN, NORTHFLANK_PROJECT_ID: 'proj-a', NORTHFLANK_JOB_ID: 'job-a' },
    mk,
    { fetchImpl: api.fetchImpl },
  );
  assert.notEqual(nf, local);
  assert.equal(made, 1);
  await nf.isRunning();
  assert.equal(api.calls[0]!.url, 'https://api.northflank.com/v1/projects/proj-a/jobs/job-a/runs?per_page=20');

  assert.throws(
    () => selectStarter({ NORTHFLANK_API_TOKEN: TOKEN, NORTHFLANK_JOB_ID: '' }, mk),
    (e: Error) => {
      assert.equal(e.message, 'NORTHFLANK_* variables are incomplete: missing NORTHFLANK_PROJECT_ID, NORTHFLANK_JOB_ID');
      return true;
    },
  );
  assert.throws(() => selectStarter({ NORTHFLANK_JOB_ID: 'job-a' }, mk), /missing NORTHFLANK_API_TOKEN, NORTHFLANK_PROJECT_ID/);
  assert.equal(made, 1);
});
