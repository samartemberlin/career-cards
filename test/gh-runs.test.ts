import test from 'node:test';
import assert from 'node:assert/strict';
import { ghRunStarter } from '../src/gh/runs.ts';
import type { FetchLike } from '../src/gh/runs.ts';

const ENV = {
  GITHUB_TOKEN: 'tok-secret-ghtest',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_API_URL: 'https://api.example.com',
  RUN_WORKFLOW: 'run.yml',
  RUN_REF: 'main',
};

type Call = { url: string; init?: RequestInit };

function makeFetch(responses: { status: number; body?: unknown }[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[i++] ?? { status: 200, body: { total_count: 0, workflow_runs: [] } };
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.body ?? ''), { status: r.status });
  };
  return { fetchImpl, calls };
}

test('ghRunStarter.isRunning is false when both queued and in_progress lists are empty', async () => {
  const { fetchImpl, calls } = makeFetch([
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
  ]);
  const starter = ghRunStarter(ENV, { fetchImpl });
  assert.equal(await starter.isRunning(), false);
  assert.equal(calls.length, 2);
});

test('ghRunStarter.isRunning is true when the API lists one in_progress run', async () => {
  const { fetchImpl } = makeFetch([
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
    { status: 200, body: { total_count: 1, workflow_runs: [{ id: 1 }] } },
  ]);
  const starter = ghRunStarter(ENV, { fetchImpl });
  assert.equal(await starter.isRunning(), true);
});

test('ghRunStarter.isRunning is true when queued run exists (stops early)', async () => {
  const { fetchImpl, calls } = makeFetch([
    { status: 200, body: { total_count: 1, workflow_runs: [{ id: 2 }] } },
  ]);
  const starter = ghRunStarter(ENV, { fetchImpl });
  assert.equal(await starter.isRunning(), true);
  // Short-circuits on queued; does not call in_progress
  assert.equal(calls.length, 1);
});

test('ghRunStarter.start POSTs workflow_dispatch with ref, trigger and label', async () => {
  const fixedNow = new Date('2026-11-16T21:05:30.000Z');
  const { fetchImpl, calls } = makeFetch([{ status: 204 }]);
  const starter = ghRunStarter(ENV, { fetchImpl, now: () => fixedNow });
  await starter.start('manual');

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://api.example.com/repos/o/r/actions/workflows/run.yml/dispatches');
  assert.equal(call.init?.method, 'POST');
  const body = JSON.parse(call.init?.body as string) as unknown;
  assert.deepEqual(body, { ref: 'main', inputs: { trigger: 'manual', label: '1116-2105z' } });

  const auth = (call.init?.headers as Record<string, string>)?.Authorization;
  assert.equal(auth, `Bearer ${ENV.GITHUB_TOKEN}`);
});

test('ghRunStarter.start: non-2xx throws an error naming the status and never the token', async () => {
  const { fetchImpl } = makeFetch([{ status: 422, body: 'validation error' }]);
  const starter = ghRunStarter(ENV, { fetchImpl });
  await assert.rejects(
    () => starter.start('manual'),
    (e: Error) => {
      assert.ok(e.message.includes('422'), `expected 422 in: ${e.message}`);
      assert.ok(!e.message.includes(ENV.GITHUB_TOKEN), `token must not appear in: ${e.message}`);
      return true;
    },
  );
});

test('ghRunStarter.isRunning throws when API is non-2xx', async () => {
  const { fetchImpl } = makeFetch([{ status: 401 }]);
  const starter = ghRunStarter(ENV, { fetchImpl });
  await assert.rejects(() => starter.isRunning(), /GitHub API 401/);
});
