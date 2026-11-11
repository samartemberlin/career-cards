import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  summaryTitle, summaryDesc, runColumnPos, writeRunColumn, archiveRunCards,
} from '../../src/run/column.ts';
import { emptyStats } from '../../src/run/stats.ts';
import type { RunStats } from '../../src/run/stats.ts';
import { parseJobKey, parseTitleScore, isRunSummaryTitle } from '../../src/trello/cards.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards, ScopeError } from '../../src/trello/scoped.ts';
import type { ScoredJob } from '../../src/trello/writer.ts';
import type { TList } from '../../src/trello/api.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const SAMPLE_RUN_COLUMN = 'Nov 9 · 01:00';
const ARCHIVED_RUN_COLUMN = 'Oct 1 · 01:00';

function setup(o: { failCardNo?: number } = {}) {
  const rec = load('jobs');
  const bid = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path)![1]!;
  const fake = FakeTrello.fromRecordings(rec);
  let cardPosts = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    if (init?.method === 'POST' && /\/cards(\?|$)/.test(new URL(String(input)).pathname)) {
      cardPosts++;
      if (cardPosts === o.failCardNo) fake.failNext('POST', /\/cards$/, 400);
    }
    return fake.fetch(input, init);
  };
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl, sleep: async () => {} });
  const api = scopeUserBoards(inner, { jobs: bid, profiles: 'fa4e0000000000000000ff01', system: 'fa4e0000000000000000ff02' });
  return { bid, fake, api };
}

function makeJob(score: number, overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    key: `greenhouse:acme:${score}00`,
    url: `https://jobs.example.com/${score}00`,
    company: 'Acme Corp',
    title: `Engineer ${score}`,
    location: 'Berlin',
    jd: 'A job at Acme Corp.',
    score,
    reason: 'Fits.',
    flags: [],
    ...overrides,
  };
}

function stats(o: Partial<RunStats> = {}): RunStats {
  return { ...emptyStats(), scanned: 900, scored: 23, rejectedPre: 400, rejectedPost: 12, deferred: 1, left: 1,
    jd: { fetched: 30, missing: 0, deferred: 1 }, rules: { EXCLUDE_TITLE: 300, LOCATION: 100, STALE: 12 }, ...o };
}

const noLog = () => {};

// ── summary card ──────────────────────────────────────────────────────────

test('summaryTitle counts new, filtered and deferred', () => {
  assert.equal(summaryTitle(stats()), 'ℹ️ Run · 23 new · 412 filtered · 3 deferred');
});

test('summaryDesc has no key line and points to System › Runs', () => {
  const desc = summaryDesc(stats());
  assert.equal(parseJobKey(desc), null);
  assert.ok(desc.includes('Full status: this run\'s card in System › Runs'));
  assert.ok(desc.includes('EXCLUDE_TITLE: 300'));
  assert.ok(desc.includes('**Scanned:** 900'));
});

test('summaryDesc lists at most 5 rules, most frequent first', () => {
  const rules = { A: 1, B: 7, C: 3, D: 9, E: 2, F: 5 };
  const desc = summaryDesc(stats({ rules }));
  const listed = [...desc.matchAll(/^- (\w+): \d+$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['D', 'B', 'F', 'C', 'E']);
});

// ── column position ───────────────────────────────────────────────────────

const list = (name: string, pos: number, closed = false): TList => ({ id: name, name, pos, closed, idBoard: 'b' });

test('runColumnPos: midpoint with the open list before the leftmost run column', () => {
  const lists = [list('Nov 9 · 01:00', 300), list('To apply', 100), list('Nov 8 · 01:00', 400), list('Old', 200, true)];
  assert.equal(runColumnPos(lists), 200);
});

test('runColumnPos: half the pos when the run column is first; bottom with none', () => {
  assert.equal(runColumnPos([list('Nov 9 · 01:00', 100), list('To apply', 200)]), 50);
  assert.equal(runColumnPos([list('To apply', 100), list('Oct 1 · 01:00', 50, true)]), 'bottom');
});

test('column goes left of the newest open run column', async () => {
  const { bid, api } = setup();
  const before = await api.lists(bid, 'open');
  const sample = before.find((l) => l.name === SAMPLE_RUN_COLUMN)!;
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs: [makeJob(8)], stats: stats(), log: noLog });
  const lists = (await api.lists(bid, 'open')).sort((a, b) => a.pos - b.pos);
  const created = lists.find((l) => l.id === r.listId)!;
  assert.ok(created.pos > 0 && created.pos < sample.pos, `pos ${created.pos} is left of ${sample.pos}`);
  assert.deepEqual(lists.slice(0, 2).map((l) => l.name), ['Nov 10 · 01:00', SAMPLE_RUN_COLUMN]);
});

test('with no open run column it goes last', async () => {
  const { bid, fake, api } = setup();
  const sample = (await api.lists(bid, 'open')).find((l) => l.name === SAMPLE_RUN_COLUMN)!;
  fake.renameList(sample.id, 'Someday');
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs: [makeJob(8)], stats: stats(), log: noLog });
  const lists = (await api.lists(bid, 'open')).sort((a, b) => a.pos - b.pos);
  assert.equal(lists.at(-1)!.id, r.listId);
});

// ── cards ─────────────────────────────────────────────────────────────────

test('summary first, then cards best first', async () => {
  const { bid, api } = setup();
  const jobs = [makeJob(9), makeJob(7, { facts: undefined }), makeJob(2)];
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs, stats: stats(), log: noLog });
  assert.deepEqual({ created: r.created, failed: r.failed, summary: r.summary }, { created: 3, failed: 0, summary: true });
  const cards = (await api.cards(bid, { filter: 'open' })).filter((c) => c.idList === r.listId).sort((a, b) => a.pos - b.pos);
  assert.equal(cards.length, 4);
  assert.ok(isRunSummaryTitle(cards[0]!.name));
  assert.equal(parseJobKey(cards[0]!.desc), null);
  assert.deepEqual(cards.slice(1).map((c) => parseTitleScore(c.name)), [9, 7, 2]);
});

test('no jobs → no list created', async () => {
  const { bid, fake, api } = setup();
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs: [], stats: stats(), log: noLog });
  assert.deepEqual(r, { listId: null, created: 0, failed: 0, summary: false });
  assert.ok(!fake.requests.some((q) => q.method === 'POST' && q.path === '/lists'));
});

test('a failed card is counted and the rest are written', async () => {
  // POSTs to /cards: summary, job 1, job 2 (fails), job 3.
  const { bid, api } = setup({ failCardNo: 3 });
  const logs: string[] = [];
  const jobs = [makeJob(9), makeJob(7), makeJob(2)];
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs, stats: stats(), log: (s) => logs.push(s) });
  assert.deepEqual({ created: r.created, failed: r.failed }, { created: 2, failed: 1 });
  const cards = (await api.cards(bid, { filter: 'open' })).filter((c) => c.idList === r.listId).sort((a, b) => a.pos - b.pos);
  assert.deepEqual(cards.slice(1).map((c) => parseTitleScore(c.name)), [9, 2]);
  assert.ok(logs.some((l) => l.includes('greenhouse:acme:700')));
});

test('a failed summary card is reported, the job cards are still written', async () => {
  const { bid, api } = setup({ failCardNo: 1 });
  const r = await writeRunColumn(api, { board: bid, name: 'Nov 10 · 01:00', jobs: [makeJob(9), makeJob(7)], stats: stats(), log: noLog });
  assert.deepEqual({ created: r.created, failed: r.failed, summary: r.summary }, { created: 2, failed: 0, summary: false });
});

test('scope errors are rethrown', async () => {
  const { api } = setup();
  await assert.rejects(
    writeRunColumn(api, { board: 'fa4e0000000000000000ff99', name: 'Nov 10 · 01:00', jobs: [makeJob(8)], stats: stats(), log: noLog }),
    ScopeError,
  );
});

test('Settings label colour wins', async () => {
  // The sample board already has a green Berlin label, so a city without one shows the colour on creation.
  const { bid, api } = setup();
  await writeRunColumn(api, {
    board: bid, name: 'Nov 10 · 01:00', jobs: [makeJob(8, { location: 'Hamburg' })], stats: stats(),
    labels: [{ name: 'Hamburg', color: 'purple' }], log: noLog,
  });
  const label = (await api.labels(bid)).find((l) => l.name === 'Hamburg');
  assert.equal(label?.color, 'purple');
});

// ── archiving ─────────────────────────────────────────────────────────────

async function archivedColumnCards() {
  const s = setup();
  const lists = await s.api.lists(s.bid, 'all');
  const col = lists.find((l) => l.name === ARCHIVED_RUN_COLUMN && l.closed)!;
  const cards = (await s.api.allCards(s.bid)).filter((c) => c.idList === col.id && !c.closed);
  return { ...s, cards };
}

test('archiveRunCards archives the captured archived column', async () => {
  const { api, bid, cards } = await archivedColumnCards();
  assert.equal(cards.length, 1050);
  const r = await archiveRunCards(api, cards, { deadline: Date.now() + 60_000, log: noLog });
  assert.deepEqual(r, { archived: 1050, failed: 0, left: 0 });
  const ids = new Set(cards.map((c) => c.id));
  assert.equal((await api.allCards(bid)).filter((c) => ids.has(c.id) && !c.closed).length, 0);
});

test('archiveRunCards stops at the deadline with left > 0', async () => {
  const { api, fake, cards } = await archivedColumnCards();
  const r = await archiveRunCards(api, cards, { deadline: Date.now() - 1, log: noLog });
  assert.deepEqual(r, { archived: 0, failed: 0, left: 1050 });
  assert.ok(!fake.requests.some((q) => q.method === 'PUT'));
});
