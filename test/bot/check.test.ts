import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { CommandCtx } from '../../src/bot/handlers.ts';
import { checkCard } from '../../src/bot/check.ts';
import { CATALOGUE, matchStatic } from '../../src/bot/catalogue.ts';
import { helpText } from '../../src/bot/handlers.ts';
import { capClassOf } from '../../src/bot/caps.ts';
import { LISTS, specOf } from '../../src/config/cards.ts';
import type { UserConfig } from '../../src/config/schema.ts';
import type { Compiled } from '../../src/compile/schema.ts';
import { fakeLlm, fakeLlmEnv } from '../support/fake-llm.ts';
import type { CompileReply } from '../support/fake-llm.ts';
import { testConfig } from '../support/user-config.ts';
import { MASKING_REPLY, QUOTA_REPLY } from '../../src/bot/stages/call.ts';
import { readingOf, readingText } from '../../src/compile/reading.ts';
import { compileInputOf, scoringTextOf } from '../../src/run/profiles.ts';
import { ConfigInvalid } from '../../src/trello/config.ts';

const JOBS_BOARD = 'fa4e00000000000000000005';
const PROFILES_BOARD = 'fa4e0000000000000000000c';
const BOARDS: UserBoards = { jobs: JOBS_BOARD, profiles: PROFILES_BOARD, system: 'fa4e0000000000000000000d' };

const cfg: UserConfig = testConfig({
  settings: {
    timezone: 'UTC', providers: ['gemini'], scoring_cap: 150,
    linkedin: false, allowed_members: [], bot_keyword: '/bot',
    caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
  },
  dream: 'Looking for editor work.', cv: 'CV of Test Person', personalDetails: ['Test Person'],
});

// A compile result that matches the testConfig 'Default' profile.
const COMPILED: Compiled = {
  places: { anywhere: false, keep: ['Berlin', 'Germany'], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [], text_exclude: [], languages: {}, years_experience: null,
  profiles: [{
    name: 'Default', search_terms: ['editor'], title_include: ['editor', 'manager'], title_exclude: [],
    examples: [
      { role: 'Content editor at a media company', score: 8 },
      { role: 'Marketing manager at an agency', score: 5 },
      { role: 'Sales clerk', score: 1 },
    ],
  }],
  unused: [], problems: [],
};

function setup(compile: () => CompileReply = () => COMPILED) {
  const fake = new FakeTrello();
  const llm = fakeLlm({ score: () => 5, compile });
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });

  const makeCtx = (cardId: string, configFn?: () => Promise<UserConfig>): CommandCtx => ({
    api: scopeUserBoards(raw, BOARDS),
    boards: BOARDS,
    me: { id: 'bot1', username: 'samplebot' },
    settings: cfg.settings,
    action: { id: 'act1', authorId: 'u1', text: '', cardId, boardId: PROFILES_BOARD, date: new Date(), author: 'user1' },
    now: new Date('2026-11-17T12:00:00Z'),
    config: configFn ?? (async () => cfg),
    starter: { isRunning: async () => false, start: async () => {} },
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'open' as const, reason: 'live' }) },
    log: () => {},
    env: fakeLlmEnv,
    call: { fetchImpl: llm.fetchImpl, retries: 0 },
    signal: new AbortController().signal,
    comments: [],
    researchCap: async () => null,
  }) as unknown as CommandCtx;

  return { fake, raw, llm, makeCtx };
}

test('check: profiles Deal-breakers card → exact block from compile', async () => {
  const { raw, makeCtx } = setup();
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);

  const input = compileInputOf(cfg);
  const niceToHave = scoringTextOf(cfg).niceToHave;
  const reading = readingOf(COMPILED, input, niceToHave);
  const entry = reading.find((r) => r.card.toLowerCase() === 'where & how i work');
  assert.ok(entry, 'expected reading entry for the card');
  const expected = `How a run would read this card:\n${readingText([entry])}`;

  assert.equal(result.text, expected);
  assert.equal(result.uncounted, undefined, 'compile counts');
});

test('check: job card → works-on line, uncounted, no model call', async () => {
  const { raw, llm, makeCtx } = setup();
  const list = await raw.createList(JOBS_BOARD, 'Nov 17 · Jobs', 'bottom');
  const card = await raw.createCard({ idList: list.id, name: '7 · Acme — Editor', desc: 'career-cards-key: greenhouse:acme:1', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.includes('Profiles board'), `unexpected text: ${result.text}`);
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

test('check: model problem in reply → reading shows "Check this card: …", no fix list', async () => {
  const { raw, makeCtx } = setup(() => ({
    ...COMPILED,
    problems: [{ card: 'Default › My dream job', reason: 'says nothing usable' }],
  }));
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith('How a run would read this card:'), `expected reading block, got: ${result.text}`);
  assert.ok(!result.text.includes('These cards need a fix'), `should not show fix list: ${result.text}`);
});

test('check: code-detected unusable (empty search_terms on the one attempt) → "These cards need a fix" naming the card', async () => {
  // With attempts:1 in check.ts, one unusable attempt → CompileFailed thrown by compileCards.
  const thinCompiled = { ...COMPILED, profiles: [{ ...COMPILED.profiles[0]!, search_terms: [] }] };
  const { raw, makeCtx } = setup(() => thinCompiled);
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith('These cards need a fix before a run can start:'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes('Default'), `expected card name in text: ${result.text}`);
});

test('check: checking the very card that carries a model problem → "Check this card: <reason>" in the reading', async () => {
  const { raw, makeCtx } = setup(() => ({
    ...COMPILED,
    problems: [{ card: 'Default › My dream job', reason: 'too generic to score' }],
  }));
  const list = await raw.createList(PROFILES_BOARD, 'Default', 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'My dream job', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith('How a run would read this card:'), `expected reading block: ${result.text}`);
  assert.ok(result.text.includes('Check this card: too generic to score'), `expected Check this card in: ${result.text}`);
});

test('check: compile unavailable (quota) → QUOTA_REPLY', async () => {
  const { raw, makeCtx } = setup(() => 'quota');
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.equal(result.text, QUOTA_REPLY);
});

test('check: compile unavailable (invalid model answer) → invalid reply, counted', async () => {
  const { raw, makeCtx } = setup(() => 'bad');
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith("The model's reading of your cards didn't check out"), `unexpected text: ${result.text}`);
  assert.equal(result.uncounted, undefined, 'compile counts');
});

test('check: About me card → works-on line, uncounted', async () => {
  const { raw, llm, makeCtx } = setup();
  const list = await raw.createList(PROFILES_BOARD, LISTS.aboutMe, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Personal details', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.includes('Profiles board'), `unexpected text: ${result.text}`);
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

test('check: profile list card → shows block for that profile card', async () => {
  const { raw, makeCtx } = setup();
  const list = await raw.createList(PROFILES_BOARD, 'Default', 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'My dream job', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id);
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith('How a run would read this card:'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes('Default › My dream job'), `expected display name in text: ${result.text}`);
});

const NOT_ONE = 'This card is not one the run reads.';

async function cardIn(raw: ReturnType<typeof setup>['raw'], list: string, name: string): Promise<string> {
  const l = await raw.createList(PROFILES_BOARD, list, 'bottom');
  return (await raw.createCard({ idList: l.id, name, desc: '', pos: 'bottom' })).id;
}

test('check: card in an inactive profile → not active, uncounted, no model call', async () => {
  const { raw, llm, makeCtx } = setup();
  const two = testConfig({ settings: cfg.settings, cv: cfg.board.cv, personalDetails: cfg.personalDetails, dream: 'Looking for editor work.', profiles: [{ name: 'Default', active: true }, { name: 'Spare', active: false }] });
  const id = await cardIn(raw, 'Spare', 'My dream job');
  const result = await checkCard(makeCtx(id, async () => two));
  assert.equal(result.text, "This card is not read by tonight's run (its profile is not active).");
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

test('check: an empty optional card → skipped, uncounted, no model call', async () => {
  const { raw, llm, makeCtx } = setup();
  const withEmpty: UserConfig = structuredClone(cfg);
  const spec = specOf('examples');
  withEmpty.board.profiles[0]!.cards.push({ key: 'examples', name: spec.name, text: '', ref: { id: 'x', name: spec.name, url: 'https://trello.com/c/x', board: 'profiles' } });
  const id = await cardIn(raw, 'Default', spec.name);
  const result = await checkCard(makeCtx(id, async () => withEmpty));
  assert.equal(result.text, 'This card is empty, so tonight\'s run skips it.');
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

for (const [list, name] of [['Feedback', 'Too senior'], ['Originals', 'My dream job'], ['Ideas', 'My notes'], [LISTS.dealBreakers, 'My notes'], [LISTS.niceToHave, 'Salary'], ['Default', 'Active']]) {
  test(`check: ${list} › ${name} → not one the run reads, uncounted, no model call`, async () => {
    const { raw, llm, makeCtx } = setup();
    const result = await checkCard(makeCtx(await cardIn(raw, list!, name!)));
    assert.equal(result.text, NOT_ONE);
    assert.equal(result.uncounted, true);
    assert.equal(llm.requests.length, 0);
  });
}

test('check: list and card names match trimmed, in any case', async () => {
  const { raw, llm, makeCtx } = setup();
  const result = await checkCard(makeCtx(await cardIn(raw, ' default ', ' MY DREAM JOB ')));
  assert.ok(result.text.startsWith('How a run would read this card:'), result.text);
  assert.ok(result.text.includes('Default › My dream job'), result.text);
  assert.equal(llm.requests.length, 1);
});

test('check: a masking failure → masking reply, uncounted', async () => {
  const { raw, llm, makeCtx } = setup();
  const leaky = testConfig({ settings: cfg.settings, cv: cfg.board.cv, dream: 'Looking for editor work.', personalDetails: ['Default'] });
  const id = await cardIn(raw, 'Default', 'My dream job');
  const result = await checkCard(makeCtx(id, async () => leaky));
  assert.equal(result.text, MASKING_REPLY('a profile name contains a personal detail'));
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

test('check: config error → fix list, uncounted, no model call', async () => {
  const { raw, llm, makeCtx } = setup();
  const list = await raw.createList(PROFILES_BOARD, LISTS.dealBreakers, 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Where & how I work', desc: '', pos: 'bottom' });
  const ctx = makeCtx(card.id, async () => {
    throw new ConfigInvalid([{ where: 'profiles › Deal-breakers › Contract & visa', message: 'missing card' }]);
  });
  const result = await checkCard(ctx);
  assert.ok(result.text.startsWith('These cards need a fix before a run can start:'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes('profiles › Deal-breakers › Contract & visa'), `expected where in text: ${result.text}`);
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

const T = { botUsername: 'bot', keyword: '/bot' };

test('matchStatic: "/bot check" → check_card action', () => {
  const m = matchStatic('/bot check', T);
  assert.equal(m.kind, 'action', JSON.stringify(m));
  if (m.kind !== 'action') return;
  assert.equal(m.spec.id, 'check_card');
  assert.deepEqual(m.args, {});
});

test('matchStatic: "/bot prüfen" → check_card action', () => {
  const m = matchStatic('/bot prüfen', T);
  assert.equal(m.kind, 'action', JSON.stringify(m));
  if (m.kind !== 'action') return;
  assert.equal(m.spec.id, 'check_card');
});

test('helpText has a check line', () => {
  const text = helpText('/bot');
  assert.ok(text.includes('check'), `helpText missing 'check': ${text}`);
});

test('check_card is stage reader (counted as model cap)', () => {
  const spec = CATALOGUE.find((s) => s.id === 'check_card');
  assert.ok(spec, 'check_card not in CATALOGUE');
  assert.equal(capClassOf(spec), 'model');
});
