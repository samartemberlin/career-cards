import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  statusTitle, statusDesc, parseStatusCard,
  findRunsList, activeRun, staleRuns,
  RUNS_LIST, STALE_MS,
} from '../../src/run/status.ts';
import type { StatusView } from '../../src/run/status.ts';
import { DESC_LIMIT } from '../../src/trello/cards.ts';
import { emptyStats } from '../../src/run/stats.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeClient } from '../../src/trello/scoped.ts';
import type { Recording } from '../../tools/sample/scrub.ts';
import type { TCard } from '../../src/trello/api.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function getBoardId(rec: Recording): string {
  const m = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path);
  return m![1]!;
}

const START = new Date('2024-11-10T01:00:00.000Z');
const COLUMN = 'Nov 10 · 01:00';

function makeView(overrides: Partial<StatusView> = {}): StatusView {
  return {
    state: 'running',
    column: COLUMN,
    trigger: 'scheduled',
    start: START,
    ...overrides,
  };
}

// ── statusTitle ───────────────────────────────────────────────────────────

test('statusTitle: running', () => {
  assert.equal(statusTitle(makeView({ state: 'running' })), '⏳ Nov 10 · 01:00 · scheduled · running');
});

test('statusTitle: ok with 23 cards', () => {
  const stats = emptyStats();
  stats.cards.created = 23;
  assert.equal(statusTitle(makeView({ state: 'ok', stats })), '✅ Nov 10 · 01:00 · scheduled · +23 cards');
});

test('statusTitle: ok with 2 warnings', () => {
  const stats = emptyStats();
  stats.cards.created = 23;
  stats.warnings = ['w1', 'w2'];
  assert.equal(
    statusTitle(makeView({ state: 'ok', stats })),
    '✅ Nov 10 · 01:00 · scheduled · +23 cards · ⚠️ 2 warnings',
  );
});

test('statusTitle: failed with reason', () => {
  assert.equal(
    statusTitle(makeView({ state: 'failed', trigger: 'manual', reason: 'config error' })),
    '❌ Nov 10 · 01:00 · manual · config error',
  );
});

test('statusTitle: failed with reason longer than 40 chars is clipped', () => {
  const reason = 'a very long reason string that is well over forty characters long';
  const title = statusTitle(makeView({ state: 'failed', reason }));
  // outcome = reason.slice(0,39) + '…'
  assert.ok(title.includes('…'), 'long reason should be clipped with …');
  const outcome = title.split(' · ').at(-1)!;
  assert.ok(outcome.length <= 41, `outcome length ${outcome.length} should be ≤41 (40 chars + ellipsis)`);
});

test('statusTitle: skipped starts with ⏭️', () => {
  assert.ok(statusTitle(makeView({ state: 'skipped', reason: 'run already active' })).startsWith('⏭️'));
});

// ── statusDesc round-trips ────────────────────────────────────────────────

for (const state of ['running', 'ok', 'failed', 'skipped'] as const) {
  test(`statusDesc round-trips through parseStatusCard: ${state}`, () => {
    const start = new Date('2024-11-10T01:00:00.123Z');
    const v = makeView({ state, start });
    const desc = statusDesc(v);
    const result = parseStatusCard({ name: statusTitle(v), desc });
    assert.ok(result !== null, 'parseStatusCard should not return null');
    assert.equal(result.state, state);
    assert.equal(result.start.getTime(), start.getTime(), 'start time round-trips to the millisecond');
  });
}

test('statusDesc shows facts tokens, unmasked jobs and shadow penalties only when present', () => {
  const plain = statusDesc(makeView({ state: 'ok', stats: emptyStats() }));
  assert.doesNotMatch(plain, /not masked|Shadow|Facts:.*tokens/);
  const stats = emptyStats();
  stats.facts.tokens = 40; stats.leftUnmasked = 3; stats.shadow = { jobs: 2, points: 5 };
  const desc = statusDesc(makeView({ state: 'ok', stats }));
  assert.match(desc, /Facts: 0 done · 0 errors · tokens: 40/);
  assert.match(desc, /left: 0 · not masked: 3/);
  assert.match(desc, /Shadow penalties \(not applied\): 2 jobs · 5 points/);
});

// ── statusDesc truncation ─────────────────────────────────────────────────

test('statusDesc stays under DESC_LIMIT with a 50,000-char log and 500 source errors, keeping the contract line', () => {
  const stats = emptyStats();
  stats.sourceErrors = Array.from({ length: 500 }, (_, i) => ({
    company: `Company${i}`,
    error: 'Network error: connection refused after retry',
  }));
  // 1,000 log lines each ~60 chars = ~60,000 chars total; slice(-40) → 40 lines
  const log = Array.from({ length: 1000 }, (_, i) => `${'x'.repeat(50)} line ${i}`);
  const start = new Date('2024-11-10T01:00:00.000Z');
  const v = makeView({ state: 'ok', stats, log, start });
  const desc = statusDesc(v);

  assert.ok(desc.length <= DESC_LIMIT, `desc length ${desc.length} exceeds DESC_LIMIT ${DESC_LIMIT}`);

  const lastLine = desc.trimEnd().split('\n').at(-1)!.trim();
  assert.equal(lastLine, `career-cards-run: ${start.toISOString()} ok`);
});

// ── top 5 rules ───────────────────────────────────────────────────────────

test('top rules are the 5 most frequent, with counts', () => {
  const stats = emptyStats();
  stats.rules = {
    EXCLUDE_TITLE: 10,
    NO_GERMAN: 7,
    TOO_JUNIOR: 5,
    LOCATION: 3,
    COMPANY_SKIP: 2,
    EXTRA_RULE: 1,
  };
  const v = makeView({ state: 'ok', stats });
  const desc = statusDesc(v);

  assert.ok(desc.includes('EXCLUDE_TITLE: 10'), 'top rule 1 with count');
  assert.ok(desc.includes('NO_GERMAN: 7'), 'top rule 2 with count');
  assert.ok(desc.includes('TOO_JUNIOR: 5'), 'top rule 3 with count');
  assert.ok(desc.includes('LOCATION: 3'), 'top rule 4 with count');
  assert.ok(desc.includes('COMPANY_SKIP: 2'), 'top rule 5 with count');
  assert.ok(!desc.includes('EXTRA_RULE'), '6th rule must not appear in the description');
});

// ── parseStatusCard ───────────────────────────────────────────────────────

test('parseStatusCard ignores a contract line that is not last', () => {
  const desc = 'career-cards-run: 2024-11-10T01:00:00.000Z running\nsome more text that follows';
  assert.equal(parseStatusCard({ name: 'any', desc }), null);
});

test('parseStatusCard returns null for card without contract line', () => {
  const desc = '✅ Nov 9 · 01:00 · scheduled · +3 cards\nSome description without contract.';
  assert.equal(parseStatusCard({ name: '✅ Nov 9 · 01:00 · scheduled · +3 cards', desc }), null);
});

test('parseStatusCard handles trailing whitespace in desc', () => {
  const start = new Date('2024-11-10T01:00:00.000Z');
  const desc = `some content\n\ncareer-cards-run: ${start.toISOString()} ok\n\n`;
  const result = parseStatusCard({ name: 'any', desc });
  assert.ok(result !== null);
  assert.equal(result.state, 'ok');
  assert.equal(result.start.getTime(), start.getTime());
});

// ── activeRun and staleRuns ───────────────────────────────────────────────

function makeRunningCard(id: string, start: Date): TCard {
  const contract = `career-cards-run: ${start.toISOString()} running`;
  return {
    id,
    name: '⏳ Nov 10 · 01:00 · scheduled · running',
    desc: `\n\n${contract}`,
    idList: 'list1',
    idBoard: 'board1',
    closed: false,
    pos: 0,
    shortUrl: `https://trello.com/c/${id}`,
  };
}

test('activeRun: a running card 1 h 59 min old is active', () => {
  const start = new Date('2024-11-10T01:00:00.000Z');
  const now = new Date(start.getTime() + (2 * 60 - 1) * 60_000);
  const result = activeRun([makeRunningCard('c1', start)], now);
  assert.ok(result !== null, 'should be active');
  assert.equal(result.card.id, 'c1');
});

test('activeRun: a running card 2 h 0 min old is stale (not active)', () => {
  const start = new Date('2024-11-10T01:00:00.000Z');
  const now = new Date(start.getTime() + STALE_MS);
  const card = makeRunningCard('c1', start);

  assert.equal(activeRun([card], now), null, 'should not be active at STALE_MS');

  const stale = staleRuns([card], now);
  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.card.id, 'c1');
});

test('activeRun: an ok card is neither active nor stale', () => {
  const start = new Date('2024-11-10T01:00:00.000Z');
  const now = new Date(start.getTime() + 60_000);
  const contract = `career-cards-run: ${start.toISOString()} ok`;
  const card: TCard = {
    id: 'ok1',
    name: '✅ Nov 10 · 01:00 · scheduled · +3 cards',
    desc: `Run complete\n\n${contract}`,
    idList: 'list1',
    idBoard: 'board1',
    closed: false,
    pos: 0,
    shortUrl: 'https://trello.com/c/ok1',
  };
  assert.equal(activeRun([card], now), null);
  assert.equal(staleRuns([card], now).length, 0);
});

test('statusDesc lists the warnings, redacted', () => {
  const stats = emptyStats();
  stats.warnings = ['Sources › Drop: "Typo AG" matches no default source', 'key sk-secret-1234 rejected'];
  const desc = statusDesc(makeView({ state: 'ok', stats, redact: (s) => s.split('sk-secret-1234').join('***') }));
  assert.match(desc, /\nWarnings:\n- Sources › Drop: "Typo AG" matches no default source\n- key \*\*\* rejected/);
});

// ── findRunsList ──────────────────────────────────────────────────────────

// ── redact field on StatusView ────────────────────────────────────────────

test('statusDesc redacts source errors containing a secret via v.redact', () => {
  const secret = 'apikey99secret88';
  const redact = (s: string): string => s.split(secret).join('***');
  const stats = emptyStats();
  stats.sourceErrors = [
    { company: 'Acme', error: `fetch failed: https://api.example.com/jobs?key=${secret}&q=eng` },
  ];
  const v = makeView({ state: 'failed', stats, redact });
  const desc = statusDesc(v);
  assert.ok(!desc.includes(secret), 'source error must not expose the secret in the card desc');
  assert.ok(desc.includes('***'), 'redacted placeholder must appear');
});

test('statusTitle and statusDesc apply v.redact to free-text fields (reason, error, problems)', () => {
  const secret = 'topsecrettoken99';
  const redact = (s: string): string => s.split(secret).join('***');

  const v = makeView({
    state: 'failed',
    trigger: 'manual',
    reason: `connection failed: token=${secret}`,
    error: `API rejected key ${secret}`,
    problems: [`webhook bearer ${secret} bounced`],
    redact,
  });

  const title = statusTitle(v);
  const desc = statusDesc(v);

  assert.ok(!title.includes(secret), 'title must not contain the secret');
  assert.ok(!desc.includes(secret), 'desc must not contain the secret');
  assert.ok(title.includes('***'), 'title should contain *** placeholder');
  assert.ok(desc.includes('***'), 'desc should contain *** placeholder');
});

// ── findRunsList ──────────────────────────────────────────────────────────

test('findRunsList creates Runs only when asked (FakeTrello from System recording with Runs renamed away)', async () => {
  const rec = load('system');
  const bid = getBoardId(rec);
  const fake = FakeTrello.fromRecordings(rec);
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeClient(inner, { boards: [bid] });

  // Confirm the fixture has a Runs list, then rename it away
  const listsBefore = await api.lists(bid, 'open');
  const existing = listsBefore.find((l) => l.name === RUNS_LIST);
  assert.ok(existing, 'system recording should have a Runs list');
  fake.renameList(existing.id, 'Runs_old');

  // create: false → null
  assert.equal(await findRunsList(api, bid, { create: false }), null);

  // create: true → creates it
  const created = await findRunsList(api, bid, { create: true });
  assert.ok(created !== null, 'should create a Runs list');
  assert.equal(created.name, RUNS_LIST);

  // now it exists, create: false → returns existing
  const found = await findRunsList(api, bid, { create: false });
  assert.ok(found !== null, 'should find the newly created Runs list');
  assert.equal(found.name, RUNS_LIST);
});
