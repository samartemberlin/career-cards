import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  statusTitle, statusDesc, parseStatusCard,
  findRunsList,
  RUNS_LIST,
  dropLines,
} from '../../src/run/status.ts';
import type { StatusView } from '../../src/run/status.ts';
import type { CardReading } from '../../src/compile/reading.ts';
import { DESC_LIMIT } from '../../src/trello/cards.ts';
import { emptyStats } from '../../src/run/stats.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeBotClient } from '../../src/trello/scoped.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

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
    state: 'ok',
    column: COLUMN,
    trigger: 'scheduled',
    start: START,
    ...overrides,
  };
}

// ── statusTitle ───────────────────────────────────────────────────────────

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

for (const state of ['ok', 'failed', 'skipped'] as const) {
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

  // Count lines still show a compact "Top rules:" summary (top 5).
  assert.ok(desc.includes('EXCLUDE_TITLE: 10'), 'top rule 1 with count in Top rules line');
  assert.ok(desc.includes('NO_GERMAN: 7'), 'top rule 2 with count');
  assert.ok(desc.includes('TOO_JUNIOR: 5'), 'top rule 3 with count');
  assert.ok(desc.includes('LOCATION: 3'), 'top rule 4 with count');
  assert.ok(desc.includes('COMPANY_SKIP: 2'), 'top rule 5 with count');
  // 6th rule appears in Dropped jobs (drop lines default to 6) but not in the Top rules line.
  assert.ok(!desc.match(/^Top rules:.*EXTRA_RULE/m), '6th rule must not appear in Top rules line');
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

test('statusDesc redacts and clips the scoring and facts abort reasons', () => {
  const secret = 'provider-key-31337';
  const redact = (s: string): string => s.split(secret).join('***');
  const stats = emptyStats();
  stats.aborted = `all providers failed: HTTP 401 {"error":"bad key ${secret}"} ${'x'.repeat(5000)}`;
  stats.facts.aborted = `all providers failed: stderr says ${secret}`;
  const desc = statusDesc(makeView({ state: 'ok', stats, redact }));
  assert.ok(!desc.includes(secret), 'an abort reason exposes the secret');
  assert.match(desc, /aborted: all providers failed: HTTP 401 \{"error":"bad key \*\*\*"\}/);
  assert.match(desc, /aborted: all providers failed: stderr says \*\*\*/);
  assert.ok(!desc.includes('x'.repeat(1000)), 'the abort reason is clipped');
});

test('statusDesc redacts a secret split across a clipped field', () => {
  const secret = 'abcdefgh-secret-0000';
  const redact = (s: string): string => s.split(secret).join('***');
  const stats = emptyStats();
  stats.aborted = `${'y'.repeat(290)} ${secret}`;
  const desc = statusDesc(makeView({ state: 'ok', stats, redact }));
  assert.ok(!desc.includes(secret.slice(0, 8)), 'a clipped prefix of the secret remains');
});

// ── findRunsList ──────────────────────────────────────────────────────────

test('findRunsList creates Runs only when asked (FakeTrello from System recording with Runs renamed away)', async () => {
  const rec = load('system');
  const bid = getBoardId(rec);
  const fake = FakeTrello.fromRecordings(rec);
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeBotClient(inner, { boards: [bid] });

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

test('parseStatusCard: a ⏳ running card from before the bot stopped editing cards is not a status', () => {
  assert.equal(parseStatusCard({ name: '⏳ x', desc: 'career-cards-run: 2024-11-10T01:00:00.000Z running' }), null);
});

test('statusDesc shortens long Problems and Warnings with a "… and N more" line to stay under DESC_LIMIT', () => {
  const stats = emptyStats();
  stats.warnings = Array.from({ length: 400 }, (_, i) => `warning ${i}: ${'w'.repeat(80)}`);
  stats.sourceErrors = Array.from({ length: 50 }, (_, i) => ({ company: `Company${i}`, error: 'HTTP 500' }));
  const problems = Array.from({ length: 300 }, (_, i) => `Filters card: pattern ${i} is not a valid regex ${'p'.repeat(60)}`);
  const log = Array.from({ length: 40 }, (_, i) => `log line ${i}`);
  const start = new Date('2024-11-10T01:00:00.000Z');
  const desc = statusDesc(makeView({ state: 'failed', reason: 'config error', stats, problems, log, start }));
  assert.ok(desc.length <= DESC_LIMIT, `desc length ${desc.length} exceeds DESC_LIMIT ${DESC_LIMIT}`);
  assert.equal(desc.trimEnd().split('\n').at(-1), `career-cards-run: ${start.toISOString()} failed`);
  assert.match(desc, /\nProblems:\n- Filters card: pattern 0 /);
  assert.match(desc, /\n- … and \d+ more\n/);
});

test('statusDesc: problems are kept before warnings', () => {
  const stats = emptyStats();
  stats.warnings = Array.from({ length: 400 }, (_, i) => `warning ${i}: ${'w'.repeat(80)}`);
  const problems = Array.from({ length: 50 }, (_, i) => `problem ${i}`);
  const desc = statusDesc(makeView({ state: 'failed', stats, problems }));
  assert.ok(desc.length <= DESC_LIMIT);
  assert.match(desc, /- problem 49\n/);
  assert.match(desc, /\nWarnings:\n- warning 0: [\s\S]*- … and \d+ more\n/);
});

// ── dropLines ─────────────────────────────────────────────────────────────

function sampleReading(): CardReading[] {
  return [{
    card: 'Where & how I work',
    hardRules: ['Keep jobs located in: Berlin'],
    scoring: [],
    unused: [{ text: 'Prefer small companies', reason: 'not a filter' }],
  }];
}

test('dropLines: exact output for three rules, in count order, with examples', () => {
  const s = emptyStats();
  s.rules = { PLACE_NOT_KEPT: 20, TITLE_EXCLUDED: 10, EXPIRED: 5 };
  s.ruleExamples = {
    PLACE_NOT_KEPT: Object.assign(Object.create(null) as Record<string, number>, { 'Zürich, Switzerland': 12, 'Remote (EMEA)': 8 }),
    TITLE_EXCLUDED: Object.assign(Object.create(null) as Record<string, number>, { senior: 7, lead: 3 }),
    EXPIRED: Object.assign(Object.create(null) as Record<string, number>, {}),
  };
  const lines = dropLines(s);
  assert.deepEqual(lines, [
    'Dropped 20: location not in your places — Zürich, Switzerland 12, Remote (EMEA) 8',
    'Dropped 10: title contains excluded word — senior 7, lead 3',
    'Dropped 5: EXPIRED',
  ]);
});

test('dropLines: example order is by count desc, ties keep insertion order', () => {
  const s = emptyStats();
  s.rules = { PLACE_NOT_KEPT: 10 };
  s.ruleExamples = {
    PLACE_NOT_KEPT: Object.assign(Object.create(null) as Record<string, number>, {
      'Berlin': 5, 'London': 5, 'Paris': 3,
    }),
  };
  const lines = dropLines(s);
  assert.equal(lines[0], 'Dropped 10: location not in your places — Berlin 5, London 5, Paris 3');
});

test('dropLines: defaults to 6 rules and 4 examples; respects options', () => {
  const s = emptyStats();
  s.rules = { A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1 };
  s.ruleExamples = {
    A: Object.assign(Object.create(null) as Record<string, number>, { a: 1, b: 2, c: 3, d: 4, e: 5 }),
  };
  const all = dropLines(s);
  assert.equal(all.length, 6, 'default 6 rules');
  assert.equal(all[0], 'Dropped 7: A — e 5, d 4, c 3, b 2', 'default 4 examples');
  const fewer = dropLines(s, { rules: 2, examples: 2 });
  assert.equal(fewer.length, 2);
  assert.equal(fewer[0], 'Dropped 7: A — e 5, d 4');
});

// ── statusDesc with reading ───────────────────────────────────────────────

test('statusDesc shows the reading and drop sections after count lines', () => {
  const stats = emptyStats();
  stats.reading = sampleReading();
  stats.rules = { PLACE_NOT_KEPT: 20 };
  stats.ruleExamples = {
    PLACE_NOT_KEPT: Object.assign(Object.create(null) as Record<string, number>, { 'Zürich, Switzerland': 12, 'Remote (EMEA)': 8 }),
  };
  const desc = statusDesc(makeView({ state: 'ok', stats }));
  assert.ok(desc.includes('**How this run read your search**'), 'reading heading present');
  assert.ok(desc.includes('**Dropped jobs**'), 'dropped heading present');
  assert.ok(desc.includes('Dropped 20: location not in your places — Zürich, Switzerland 12, Remote (EMEA) 8'));
  assert.ok(desc.includes('Not used:'), 'unused entry from reading appears');
});

test('statusDesc with a 30,000-char log still keeps the reading heading and stays ≤ DESC_LIMIT', () => {
  const stats = emptyStats();
  stats.reading = sampleReading();
  const log = Array.from({ length: 1000 }, (_, i) => `${'x'.repeat(27)} line ${i}`);
  const start = new Date('2024-11-10T01:00:00.000Z');
  const desc = statusDesc(makeView({ state: 'ok', stats, log, start }));
  assert.ok(desc.length <= DESC_LIMIT, `desc length ${desc.length} > DESC_LIMIT`);
  assert.ok(desc.includes('**How this run read your search**'), 'reading heading kept after log cut');
  assert.equal(desc.trimEnd().split('\n').at(-1)!.trim(), `career-cards-run: ${start.toISOString()} ok`);
});

test('statusDesc: a failed view with null reading shows no reading or drop heading', () => {
  const stats = emptyStats();
  // stats.reading is null by default
  const desc = statusDesc(makeView({ state: 'failed', stats, reason: 'compile failed' }));
  assert.ok(!desc.includes('**How this run read your search**'), 'no reading heading on failed with null reading');
  assert.ok(!desc.includes('**Dropped jobs**'), 'no drop heading on failed with null reading');
});

test('statusDesc: a secret inside unused reading text is redacted', () => {
  const secret = 'unused-secret-9999';
  const redact = (s: string): string => s.split(secret).join('***');
  const stats = emptyStats();
  stats.reading = [{
    card: 'Test card',
    hardRules: [],
    scoring: [],
    unused: [{ text: `ignore this ${secret} value`, reason: 'not applicable' }],
  }];
  const desc = statusDesc(makeView({ state: 'ok', stats, redact }));
  assert.ok(!desc.includes(secret), 'secret not exposed in desc');
  assert.ok(desc.includes('***'), 'redacted placeholder present');
});
