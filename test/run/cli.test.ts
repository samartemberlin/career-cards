import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunArgs, resolveBoards, main, UsageError } from '../../src/run.ts';
import type { TrelloApi } from '../../src/trello/api.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scanAll, ScanFailed } from '../../src/run/scan.ts';
import type { Recording } from '../../tools/sample/scrub.ts';
import type { ScanOutput } from '../../src/run/scan.ts';
import type { ScanPlan } from '../../src/run/sources-plan.ts';
import type { SourceResult } from '../../src/pipeline/sources/types.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;
const boardId = (rec: Recording): string => rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path.split('/')[2]!;

const emptyResult = (): SourceResult => Object.assign([], { errors: [] });

function makeClient(fake: FakeTrello): TrelloApi {
  return createTrelloClient({
    key: 'trello-key-0000',
    token: 'trello-token-0000',
    fetchImpl: fake.fetch,
    sleep: async () => {},
    maxPer10s: 1e9,
  });
}

function setupBoards(): { fake: FakeTrello; trello: TrelloApi; boards: { jobs: string; profiles: string; system: string } } {
  const recs = { jobs: load('jobs'), profiles: load('profiles'), system: load('system') };
  const fake = FakeTrello.fromRecordings(recs.jobs, recs.profiles, recs.system, load('lookups'));
  const boards = { jobs: boardId(recs.jobs), profiles: boardId(recs.profiles), system: boardId(recs.system) };
  const trello = makeClient(fake);
  return { fake, trello, boards };
}

// ── parseRunArgs ──────────────────────────────────────────────────────────────

test('parseRunArgs: defaults', () => {
  const r = parseRunArgs([]);
  assert.equal(r.dryRun, false);
  assert.equal(r.trigger, 'manual');
  assert.equal(r.boardsFile, undefined);
  assert.equal(r.cap, undefined);
});

test('parseRunArgs: --dry-run sets dryRun', () => {
  const r = parseRunArgs(['--dry-run']);
  assert.equal(r.dryRun, true);
});

test('parseRunArgs: --trigger scheduled', () => {
  const r = parseRunArgs(['--trigger', 'scheduled']);
  assert.equal(r.trigger, 'scheduled');
});

test('parseRunArgs: --trigger manual', () => {
  const r = parseRunArgs(['--trigger', 'manual']);
  assert.equal(r.trigger, 'manual');
});

test('parseRunArgs: --trigger nightly throws UsageError', () => {
  assert.throws(() => parseRunArgs(['--trigger', 'nightly']), UsageError);
});

test('parseRunArgs: --cap 0 is allowed', () => {
  const r = parseRunArgs(['--cap', '0']);
  assert.equal(r.cap, 0);
});

test('parseRunArgs: --cap -1 throws UsageError', () => {
  assert.throws(() => parseRunArgs(['--cap', '-1']), UsageError);
});

test('parseRunArgs: --cap NaN throws UsageError', () => {
  assert.throws(() => parseRunArgs(['--cap', 'abc']), UsageError);
});

test('parseRunArgs: --boards sets boardsFile', () => {
  const r = parseRunArgs(['--boards', 'tools/.sample-boards.json']);
  assert.equal(r.boardsFile, 'tools/.sample-boards.json');
});

test('parseRunArgs: --boards --dry-run is a UsageError, not a file read', () => {
  assert.throws(() => parseRunArgs(['--boards', '--dry-run']), UsageError);
});

test('parseRunArgs: unknown flag throws UsageError', () => {
  assert.throws(() => parseRunArgs(['--unknown']), UsageError);
});

// ── resolveBoards ─────────────────────────────────────────────────────────────

test('resolveBoards: reads the sample state shape from file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-test-'));
  try {
    const file = join(tmp, 'state.json');
    writeFileSync(file, JSON.stringify({ workspace: 'ws1', jobs: 'board-jobs', profiles: 'board-profiles', system: 'board-system' }));
    const boards = resolveBoards({}, file);
    assert.deepEqual(boards, { jobs: 'board-jobs', profiles: 'board-profiles', system: 'board-system' });
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test('resolveBoards: file parse error names the file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-test-'));
  try {
    const file = join(tmp, 'bad.json');
    writeFileSync(file, 'not json');
    assert.throws(
      () => resolveBoards({}, file),
      (e: unknown) => e instanceof Error && e.message.includes(file),
    );
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test('resolveBoards: null JSON is rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-test-'));
  try {
    const file = join(tmp, 'null.json');
    writeFileSync(file, 'null');
    assert.throws(() => resolveBoards({}, file));
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test('resolveBoards: non-string ids are rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cli-test-'));
  try {
    const file = join(tmp, 'bad-ids.json');
    writeFileSync(file, JSON.stringify({ jobs: 123, profiles: 'p', system: 's' }));
    assert.throws(() => resolveBoards({}, file));
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

test('resolveBoards: names the missing env variables', () => {
  assert.throws(
    () => resolveBoards({}),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes('JOBS_BOARD_ID'), 'should mention JOBS_BOARD_ID');
      assert.ok(e.message.includes('PROFILES_BOARD_ID'), 'should mention PROFILES_BOARD_ID');
      assert.ok(e.message.includes('SYSTEM_BOARD_ID'), 'should mention SYSTEM_BOARD_ID');
      return true;
    },
  );
});

test('resolveBoards: names only the missing variables when some are set', () => {
  assert.throws(
    () => resolveBoards({ JOBS_BOARD_ID: 'board-jobs' }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes('JOBS_BOARD_ID'), 'should not mention present JOBS_BOARD_ID');
      assert.ok(e.message.includes('PROFILES_BOARD_ID'), 'should mention missing PROFILES_BOARD_ID');
      assert.ok(e.message.includes('SYSTEM_BOARD_ID'), 'should mention missing SYSTEM_BOARD_ID');
      return true;
    },
  );
});

test('resolveBoards: reads all three from env when no file given', () => {
  const boards = resolveBoards({ JOBS_BOARD_ID: 'j', PROFILES_BOARD_ID: 'p', SYSTEM_BOARD_ID: 's' });
  assert.deepEqual(boards, { jobs: 'j', profiles: 'p', system: 's' });
});

// ── main ──────────────────────────────────────────────────────────────────────

test('main: missing credentials are reported by name, not value', async () => {
  const lines: string[] = [];
  // TRELLO_KEY is set to a known secret value; it must never appear in output
  const code = await main([], { TRELLO_KEY: 'secret-key-xyzzy' }, { out: (s) => lines.push(s) });
  assert.equal(code, 1);
  const output = lines.join('\n');
  assert.ok(output.includes('TRELLO_TOKEN'), 'should mention TRELLO_TOKEN');
  assert.ok(!output.includes('secret-key-xyzzy'), 'must not print the key value');
});

test('main: without TRELLO_KEY only returns 1 and names TRELLO_KEY', async () => {
  const lines: string[] = [];
  const code = await main([], { TRELLO_TOKEN: 'some-token' }, { out: (s) => lines.push(s) });
  assert.equal(code, 1);
  const output = lines.join('\n');
  assert.ok(output.includes('TRELLO_KEY'), 'should mention TRELLO_KEY');
  assert.ok(!output.includes('some-token'), 'must not print the token value');
});

test('main: bad RUN_BUDGET_MIN returns 1 and names the variable', async () => {
  const lines: string[] = [];
  const { trello, boards } = setupBoards();
  const code = await main(
    ['--dry-run'],
    { JOBS_BOARD_ID: boards.jobs, PROFILES_BOARD_ID: boards.profiles, SYSTEM_BOARD_ID: boards.system, RUN_BUDGET_MIN: 'not-a-number' },
    { trello, scan: async () => ({ jobs: [], bySource: {}, errors: [] }), out: (s) => lines.push(s) },
  );
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('RUN_BUDGET_MIN')), 'must name the variable');
});

test('main: RUN_BUDGET_MIN=0 is rejected', async () => {
  const lines: string[] = [];
  const { trello, boards } = setupBoards();
  const code = await main(
    ['--dry-run'],
    { JOBS_BOARD_ID: boards.jobs, PROFILES_BOARD_ID: boards.profiles, SYSTEM_BOARD_ID: boards.system, RUN_BUDGET_MIN: '0' },
    { trello, scan: async () => ({ jobs: [], bySource: {}, errors: [] }), out: (s) => lines.push(s) },
  );
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('RUN_BUDGET_MIN')));
});

test('main: --dry-run over FakeTrello returns 0 and makes no write request', async () => {
  const { fake, trello, boards } = setupBoards();
  const emptyScan: ScanOutput = { jobs: [], bySource: {}, errors: [] };
  const lines: string[] = [];
  const code = await main(
    ['--dry-run'],
    { JOBS_BOARD_ID: boards.jobs, PROFILES_BOARD_ID: boards.profiles, SYSTEM_BOARD_ID: boards.system },
    {
      trello,
      scan: async () => emptyScan,
      out: (s) => lines.push(s),
    },
  );
  assert.equal(code, 0);
  const writes = fake.requests.filter((r) => r.method !== 'GET');
  assert.equal(writes.length, 0, 'no writes in a dry run');
});

test('main: career-ops ScanFailed becomes a source error (⚠️), run still exits 0', async () => {
  const { trello, boards } = setupBoards();
  const lines: string[] = [];
  // The scan passes through scanAll with a careerOps dep that throws ScanFailed;
  // scanAll turns it into a source error via Promise.allSettled.
  const scan = (plan: ScanPlan) => scanAll(plan, {
    careerOps: async (): Promise<SourceResult> => { throw new ScanFailed('scan failed (exit 1)\nboom'); },
    rss: async () => emptyResult(),
    pages: async () => emptyResult(),
    log: () => {},
  });
  const code = await main(
    ['--dry-run'],
    { JOBS_BOARD_ID: boards.jobs, PROFILES_BOARD_ID: boards.profiles, SYSTEM_BOARD_ID: boards.system },
    { trello, scan, out: (s) => lines.push(s) },
  );
  assert.equal(code, 0, 'ScanFailed must not fail the run');
  assert.ok(lines.some((l) => l.includes('career-ops')), 'career-ops error should appear in output');
});

test('main: scan log lines go through the redacting run log', async () => {
  const { trello, boards } = setupBoards();
  const lines: string[] = [];
  const code = await main(
    ['--dry-run'],
    { JOBS_BOARD_ID: boards.jobs, PROFILES_BOARD_ID: boards.profiles, SYSTEM_BOARD_ID: boards.system, TRELLO_TOKEN: 'trello-token-0000' },
    {
      trello,
      sources: {
        careerOps: async (): Promise<SourceResult> => { throw new ScanFailed('scan failed: token trello-token-0000 refused'); },
        rss: async () => emptyResult(),
        pages: async () => emptyResult(),
        linkedin: async () => emptyResult(),
      },
      out: (s) => lines.push(s),
    },
  );
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('career-ops: failed: scan failed: token *** refused')), 'the scan log line is missing');
  for (const l of lines) assert.ok(!l.includes('trello-token-0000'), l);
});

test('main: bad --trigger returns 1', async () => {
  const lines: string[] = [];
  const code = await main(['--trigger', 'invalid'], {}, { out: (s) => lines.push(s) });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('--trigger')));
});
