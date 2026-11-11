import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnce } from '../../src/run/run-once.ts';
import type { RunDeps, RunOpts } from '../../src/run/run-once.ts';
import { parseStatusCard } from '../../src/run/status.ts';
import type { ScanOutput } from '../../src/run/scan.ts';
import type { Defaults } from '../../src/run/sources-plan.ts';
import type { ParsedFacts } from '../../src/pipeline/facts.ts';
import type { Job } from '../../src/pipeline/keys.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { isRunSummaryTitle, parseJobKey, parseTitleScore } from '../../src/trello/cards.ts';
import type { TCard, TrelloApi } from '../../src/trello/api.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { fakeLlm, fakeLlmEnv } from '../support/fake-llm.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const boardId = (rec: Recording): string => rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path.split('/')[2]!;
const body = <T>(rec: Recording, suffix: string): T => rec.find((c) => c.method === 'GET' && c.path.endsWith(suffix))!.body as T;

const NOW = new Date('2026-11-10T00:00:00Z');
const COLUMN = 'Nov 10 · 01:00';
const OLD_COLUMN = 'Oct 1 · 01:00';
// The sample Sources card drops "Old Example AG"; with it in the defaults the drop is not a typo.
const DEFAULTS: Defaults = { portals: { tracked_companies: [{ name: 'Old Example AG', careers_url: 'https://jobs.example.com/old' }] }, extra: {} };
const JD = 'Plan, write and edit articles for an online magazine in a small team. '.repeat(20).slice(0, 1000);

/** Rows that pass the sample "Content editor" filters (an editor title, Berlin). */
const row = (n: number, o: Partial<Job> = {}): Job => ({
  key: `test:row-${n}`, url: `https://jobs.example.com/row-${n}`, company: `Row Company ${n}`,
  title: `Content Editor ${n}`, location: 'Berlin', source: 'test', ...o,
});
const SCORES: Record<string, number> = { 'test:row-1': 2, 'test:row-2': 9, 'test:row-3': 7 };

type Setup = {
  rows?: Job[];
  score?: (key: string) => number | 'quota' | 'bad';
  facts?: (key: string) => Partial<ParsedFacts> | 'quota';
  scan?: () => Promise<ScanOutput>;
  defaults?: Defaults;
  /** Called before every request reaches the fake; `init.body` is the JSON the client sent. */
  onRequest?: (method: string, path: string, init: RequestInit | undefined) => void;
};

function setup(s: Setup = {}) {
  const recs = { jobs: load('jobs'), profiles: load('profiles'), system: load('system') };
  const fake = FakeTrello.fromRecordings(recs.jobs, recs.profiles, recs.system, load('lookups'));
  const boards = { jobs: boardId(recs.jobs), profiles: boardId(recs.profiles), system: boardId(recs.system) };
  const fetchImpl: typeof fetch = (input, init) => {
    const u = new URL(String(input));
    s.onRequest?.((init?.method ?? 'GET').toUpperCase(), u.pathname.replace(/^\/1(?=\/)/, ''), init);
    return fake.fetch(input, init);
  };
  const client = (f: typeof fetch): TrelloApi =>
    createTrelloClient({ key: 'trello-key-0000', token: 'trello-token-0000', fetchImpl: f, sleep: async () => {}, maxPer10s: 1e9 });
  const llm = fakeLlm({ score: s.score ?? ((k) => SCORES[k] ?? 5), ...(s.facts ? { facts: s.facts } : {}) });
  const rows = s.rows ?? [row(1), row(2), row(3)];
  const scans: unknown[] = [];
  const fetched: string[] = [];
  const sink: string[] = [];
  const deps: RunDeps = {
    trello: client(fetchImpl),
    boards,
    scan: async (plan) => {
      scans.push(plan);
      return s.scan ? s.scan() : { jobs: rows, bySource: { test: rows.length }, errors: [] };
    },
    fetchJd: async (j) => { fetched.push(j.key); return { jd: JD, meta: {} }; },
    env: { ...fakeLlmEnv, TRELLO_TOKEN: 'trello-token-0000' },
    call: { fetchImpl: llm.fetchImpl, retries: 0 },
    defaults: s.defaults ?? DEFAULTS,
    extractor: 'Extract facts as JSON.',
    now: () => NOW,
    sink: (l) => sink.push(l),
  };
  const lists = (rec: Recording) => body<{ id: string; name: string }[]>(rec, '/lists');
  const cards = (rec: Recording) => body<{ id: string; name: string; checklists?: { id: string }[] }[]>(rec, '/cards/open');
  return {
    fake, deps, llm, scans, fetched, sink, boards,
    // A second client for the test's own reads and the user's edits; it is not the run's client.
    user: client(fake.fetch),
    runsList: lists(recs.system).find((l) => l.name === 'Runs')!.id,
    settingsCard: cards(recs.system).find((c) => c.name === 'Settings')!.id,
    detailsChecklist: cards(recs.profiles).find((c) => c.name === 'Personal details')!.checklists![0]!.id,
    listId: (name: string) => lists(recs.jobs).find((l) => l.name === name)!.id,
  };
}

const run = (deps: RunDeps, o: Partial<RunOpts> = {}) => runOnce(deps, { trigger: 'scheduled', dryRun: false, ...o });

async function runCards(t: ReturnType<typeof setup>): Promise<TCard[]> {
  return (await t.user.cards(t.boards.system, { filter: 'open' })).filter((c) => c.idList === t.runsList).sort((a, b) => a.pos - b.pos);
}

async function columnCards(t: ReturnType<typeof setup>, name: string): Promise<TCard[]> {
  const list = (await t.user.lists(t.boards.jobs, 'open')).filter((l) => l.name === name);
  assert.equal(list.length, 1, `one open list named ${name}`);
  return (await t.user.cards(t.boards.jobs, { filter: 'open' })).filter((c) => c.idList === list[0]!.id).sort((a, b) => a.pos - b.pos);
}

const cardWrites = (t: ReturnType<typeof setup>) => t.fake.requests.filter((r) => r.method !== 'GET');

test('one run: a column named Nov 10 · 01:00, summary first, cards best first', async () => {
  const t = setup();
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  assert.equal(out.exitCode, 0);
  assert.equal(out.column, COLUMN);
  const cards = await columnCards(t, COLUMN);
  assert.ok(isRunSummaryTitle(cards[0]!.name));
  assert.match(cards[0]!.name, /· 3 new ·/);
  assert.deepEqual(cards.slice(1).map((c) => parseTitleScore(c.name)), [9, 7, 2]);
  assert.deepEqual(cards.slice(1).map((c) => parseJobKey(c.desc)), ['test:row-2', 'test:row-3', 'test:row-1']);
  assert.deepEqual(out.stats.cards, { created: 3, failed: 0 });
});

test('status card: ⏳ written first, then ✅ … · scheduled · +3 cards, on top of Runs', async () => {
  const posted: string[] = [];
  const t = setup({
    onRequest: (method, path, init) => {
      if (method === 'POST' && path === '/cards') posted.push((JSON.parse(String(init!.body)) as { name: string }).name);
    },
  });
  const out = await run(t.deps);
  assert.equal(posted[0], `⏳ ${COLUMN} · scheduled · running`);
  const top = (await runCards(t))[0]!;
  assert.equal(top.name, `✅ ${COLUMN} · scheduled · +3 cards`);
  assert.equal(parseStatusCard(top)?.state, 'ok');
  assert.equal(parseStatusCard(top)?.start.toISOString(), NOW.toISOString());
  assert.equal(out.statusUrl, top.shortUrl);
  assert.equal(out.report, top.desc);
  assert.match(top.desc, /Cards: 3 created · 0 failed/);
});

test('known keys get no card, from both key-line formats', async () => {
  // The sample's Applied list holds a migrated card with a `samjobs-key: sample:old-1` line.
  const t = setup({ rows: [row(1), row(2), row(3), row(4, { key: 'sample:old-1' })] });
  t.fake.addCards(t.listId('To apply'), 1, () => ({ name: '9 · Row Company 2 — Content Editor 2', desc: 'Moved.\n\n---\ncareer-cards-key: test:row-2' }));
  const out = await run(t.deps);
  assert.equal(out.stats.known, 2);
  const cards = await columnCards(t, COLUMN);
  assert.deepEqual(cards.slice(1).map((c) => parseJobKey(c.desc)), ['test:row-3', 'test:row-1']);
  assert.deepEqual(t.fetched.sort(), ['test:row-1', 'test:row-3']);
});

test('running twice creates nothing twice', async () => {
  const t = setup();
  await run(t.deps);
  const second = await run(t.deps);
  assert.equal(second.state, 'ok');
  assert.equal((await t.user.lists(t.boards.jobs, 'all')).filter((l) => l.name === COLUMN).length, 1);
  assert.equal((await runCards(t))[0]!.name, `✅ ${COLUMN} · scheduled · +0 cards`);
  const keys = (await t.user.allCards(t.boards.jobs)).map((c) => parseJobKey(c.desc)).filter((k) => k !== null);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(second.stats.known, 3);
});

test('no scored jobs → no column', async () => {
  const t = setup({ score: () => 'bad' });
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  assert.equal(out.stats.scoreErrors, 3);
  assert.ok(!(await t.user.lists(t.boards.jobs, 'all')).some((l) => l.name === COLUMN));
  assert.ok(!t.fake.requests.some((r) => r.method === 'POST' && r.path === '/lists'));
  assert.equal((await runCards(t))[0]!.name, `✅ ${COLUMN} · scheduled · +0 cards`);
});

test("the archived run column's cards are archived; its summary card is not", async () => {
  const t = setup();
  const old = t.listId(OLD_COLUMN);
  t.fake.addCards(old, 1, () => ({ name: 'ℹ️ Run · 5 new · 0 filtered · 0 deferred', desc: 'Summary.' }));
  const out = await run(t.deps);
  assert.deepEqual(out.stats.archived, { archived: 1050, failed: 0, left: 0 });
  const inOld = (await t.user.allCards(t.boards.jobs)).filter((c) => c.idList === old);
  assert.equal(inOld.filter((c) => !c.closed).length, 1);
  assert.ok(isRunSummaryTitle(inOld.find((c) => !c.closed)!.name));
});

test('config error: ❌ with one comment on the bad card, nothing scanned or written to Jobs', async () => {
  const t = setup();
  t.fake.setCardDesc(t.settingsCard, 'no yaml');
  const out = await run(t.deps);
  assert.equal(out.state, 'failed');
  assert.equal(out.exitCode, 1);
  assert.equal((await runCards(t))[0]!.name, `❌ ${COLUMN} · scheduled · config error`);
  const comments = t.fake.commentsOn(t.settingsCard);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!, new RegExp(`^career-cards: this card stopped the run of ${COLUMN}:\\n- no \`\`\`yaml block`));
  assert.equal(t.scans.length, 0);
  assert.ok(out.problems.some((p) => p.startsWith('System › Settings:')));
  const jobsLists = new Set((await t.user.lists(t.boards.jobs, 'all')).map((l) => l.id));
  const jobsCards = new Set((await t.user.allCards(t.boards.jobs)).map((c) => c.id));
  for (const w of cardWrites(t)) {
    const id = /^\/(?:cards|lists)\/([^/]+)/.exec(w.path)?.[1];
    assert.ok(!id || (!jobsLists.has(id) && !jobsCards.has(id)), `${w.method} ${w.path}`);
  }
  assert.ok(!t.fake.requests.some((r) => r.method === 'POST' && r.path === '/lists'));
});

test('board not private: ❌, nothing scanned', async () => {
  const t = setup();
  t.fake.setBoardPermissionLevel(t.boards.jobs, 'org');
  const out = await run(t.deps);
  assert.equal(out.exitCode, 1);
  const top = (await runCards(t))[0]!;
  assert.equal(top.name, `❌ ${COLUMN} · scheduled · boards not private`);
  assert.match(top.desc, /Problems:\n- career-cards sample · Jobs: not private \(org\)/);
  assert.equal(t.scans.length, 0);
});

test('masking fails closed: no model call', async () => {
  const t = setup();
  // "USER" is still in the masked text, inside the "[USER]" placeholder.
  await t.user.addCheckItem(t.detailsChecklist, 'USER');
  const out = await run(t.deps);
  assert.equal(out.exitCode, 1);
  assert.equal((await runCards(t))[0]!.name, `❌ ${COLUMN} · scheduled · masking failed`);
  assert.equal(t.llm.requests.length, 0);
  assert.equal(t.scans.length, 0);
  assert.equal(t.fetched.length, 0);
});

test('no prompt carries a personal detail', async () => {
  const t = setup();
  await run(t.deps);
  assert.ok(t.llm.requests.length >= 6, 'scoring and facts calls were made');
  const details = (await t.user.checklist(t.detailsChecklist)).checkItems
    .map((i) => i.name.replace(/^(?:address|link|email|phone):\s*/i, '').toLowerCase());
  assert.ok(details.length >= 5);
  for (const r of t.llm.requests) {
    const text = `${r.system}\n${r.user}`.toLowerCase();
    for (const d of details) assert.ok(!text.includes(d), `a prompt contains a personal detail (${details.indexOf(d)})`);
  }
  assert.ok(t.llm.requests.some((r) => r.user.includes('[USER]') || r.system.includes('[USER]')));
});

test('a crash after ⏳ marks ❌ and exits 1', async () => {
  const t = setup({ scan: async () => { throw new Error('scanner exploded\nsecond line'); } });
  const out = await run(t.deps);
  assert.equal(out.state, 'failed');
  assert.equal(out.exitCode, 1);
  const top = (await runCards(t))[0]!;
  assert.equal(top.name, `❌ ${COLUMN} · scheduled · scanner exploded`);
  assert.match(top.desc, /Error: scanner exploded\n/);
  assert.equal(parseStatusCard(top)?.state, 'failed');
});

test('quota stops scoring: scored jobs are carded, the rest left', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
  const t = setup({ rows, score: (k) => (k === 'test:row-1' || k === 'test:row-2' ? 8 : 'quota') });
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  const s = out.stats;
  assert.ok(s.left > 0);
  assert.equal(s.scored, 2);
  assert.equal(s.scored + s.scoreErrors + s.left, 6);
  assert.deepEqual(s.cards, { created: 2, failed: 0 });
  assert.match((await runCards(t))[0]!.desc, new RegExp(`left: ${s.left}`));
});

test('cap lowers scoring_cap', async () => {
  const t = setup();
  const out = await run(t.deps, { cap: 1 });
  assert.equal(out.stats.cards.created, 1);
  assert.equal(out.stats.scored, 1);
  // At cap 1, descriptions are fetched for 2 (twice the cap): one waits for the cap, one for its description.
  assert.equal(out.stats.deferred + out.stats.jd.deferred, 2);
  assert.equal((await columnCards(t, COLUMN)).length, 2);
});

test('a ⏳ card under 2 h blocks the run', async () => {
  const t = setup();
  t.fake.addCards(t.runsList, 1, () => ({ name: '⏳ Nov 10 · 00:30 · manual · running', desc: 'career-cards-run: 2026-11-09T23:30:00.000Z running' }));
  const out = await run(t.deps);
  assert.equal(out.state, 'skipped');
  assert.equal(out.exitCode, 3);
  assert.equal(t.scans.length, 0);
  const cards = await runCards(t);
  assert.equal(cards[0]!.name, `⏭️ ${COLUMN} · scheduled · another run in progress`);
  assert.ok(cards.some((c) => c.name === '⏳ Nov 10 · 00:30 · manual · running'));
});

test('a ⏳ card over 2 h old is abandoned', async () => {
  const t = setup();
  t.fake.addCards(t.runsList, 1, () => ({ name: '⏳ Nov 9 · 22:00 · manual · running', desc: 'career-cards-run: 2026-11-09T21:00:00.000Z running' }));
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  const cards = await runCards(t);
  const old = cards.find((c) => c.name.includes('Nov 9 · 22:00'))!;
  assert.equal(old.name, '❌ Nov 9 · 22:00 · manual · abandoned');
  assert.equal(parseStatusCard(old)?.state, 'failed');
  assert.equal(cards[0]!.name, `✅ ${COLUMN} · scheduled · +3 cards`);
});

test('the later of two simultaneous runs skips itself', async () => {
  let inserted = false;
  const t: ReturnType<typeof setup> = setup({
    onRequest: (method, path, init) => {
      if (inserted || method !== 'POST' || path !== '/cards') return;
      if (!(JSON.parse(String(init!.body)) as { name: string }).name.startsWith('⏳')) return;
      inserted = true;
      t.fake.addCards(t.runsList, 1, () => ({ name: '⏳ Nov 10 · 00:59 · manual · running', desc: 'career-cards-run: 2026-11-09T23:59:00.000Z running' }));
    },
  });
  const out = await run(t.deps);
  assert.ok(inserted);
  assert.equal(out.state, 'skipped');
  assert.equal(out.exitCode, 3);
  assert.equal(t.scans.length, 0);
  assert.equal((await runCards(t))[0]!.name, `⏭️ ${COLUMN} · scheduled · another run in progress`);
});

test('a secret in an error never reaches the status card or the log', async () => {
  const t = setup({ scan: async () => { throw new Error('boom test-key-0000 trello-token-0000'); } });
  const out = await run(t.deps);
  const top = (await runCards(t))[0]!;
  for (const text of [top.name, top.desc, out.report, ...t.sink]) {
    assert.ok(!text.includes('test-key-0000') && !text.includes('trello-token-0000'), text);
  }
  assert.equal(top.name, `❌ ${COLUMN} · scheduled · boom *** ***`);
});

test('a Sources Drop typo is a warning on a ✅ card', async () => {
  const t = setup({ defaults: { portals: {}, extra: {} } });
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  const top = (await runCards(t))[0]!;
  assert.equal(top.name, `✅ ${COLUMN} · scheduled · +3 cards · ⚠️ 1 warnings`);
  assert.match(top.desc, /Warnings:\n- Sources › Drop: "Old Example AG" matches no default source/);
});

test('a failed career-ops scan is a short warning on a ✅ card', async () => {
  const tail = 'x'.repeat(1990);
  const t = setup({
    scan: async () => ({ jobs: [row(1)], bySource: { test: 1 }, errors: [{ company: 'career-ops', error: `scan failed (exit 1)\n${tail}` }] }),
  });
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  const top = (await runCards(t))[0]!;
  assert.equal(top.name, `✅ ${COLUMN} · scheduled · +1 cards · ⚠️ 1 warnings`);
  assert.match(top.desc, /career-ops: scan failed \(exit 1\)\n/);
  assert.ok(!top.desc.includes('x'.repeat(300)));
});

test('preferences feed shadow penalties, never the score', async () => {
  const t = setup({ facts: (k) => (k === 'test:row-2' ? { german: { level: 'c1', spoken_heavy: null, evidence: 'C1' } } : {}) });
  const out = await run(t.deps);
  assert.equal(out.stats.shadow.jobs, 1);
  assert.equal(out.stats.shadow.points, 3);
  assert.equal(parseTitleScore((await columnCards(t, COLUMN))[1]!.name), 9);
});

test('a run column that cannot be created is a warning; the run still archives', async () => {
  const t = setup();
  t.fake.failNext('POST', /^\/lists$/, 400);
  const out = await run(t.deps);
  assert.equal(out.state, 'ok');
  assert.deepEqual(out.stats.cards, { created: 0, failed: 3 });
  assert.equal(out.stats.archived.archived, 1050);
  assert.equal((await runCards(t))[0]!.name, `✅ ${COLUMN} · scheduled · +0 cards · ⚠️ 1 warnings`);
});

test('dry run: no write request at all', async () => {
  const t = setup({ rows: [row(1), row(2), row(3), row(4, { title: 'Senior Editor' })] });
  const before = t.fake.requests.length;
  const out = await runOnce(t.deps, { trigger: 'manual', dryRun: true });
  assert.equal(out.state, 'ok');
  assert.equal(out.exitCode, 0);
  assert.equal(out.statusUrl, null);
  assert.deepEqual(t.fake.requests.slice(before).filter((r) => r.method !== 'GET'), []);
  assert.equal(t.fetched.length, 0);
  assert.equal(t.llm.requests.length, 0);
  assert.match(out.report, /Scanned: 4 · Known: 0 · Fresh: 4 · Rejected pre: 1/);
  assert.match(out.report, /Would describe and score: up to 3 of the 3 jobs/);
  assert.match(out.report, /Would archive: 1050 cards/);
});
