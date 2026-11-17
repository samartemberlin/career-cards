import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { CommandCtx, NetDeps } from '../../src/bot/handlers.ts';
import { explainFilter } from '../../src/bot/why.ts';
import type { FetchJdResult } from '../../src/pipeline/jd.ts';
import type { UserConfig } from '../../src/config/schema.ts';
import type { Compiled } from '../../src/compile/schema.ts';
import { capClassOf } from '../../src/bot/caps.ts';
import { CATALOGUE } from '../../src/bot/catalogue.ts';
import { fakeLlm, fakeLlmEnv } from '../support/fake-llm.ts';
import type { CompileReply } from '../support/fake-llm.ts';
import { testConfig } from '../support/user-config.ts';

const JOBS_BOARD = 'fa4e00000000000000000005';
const BOARDS: UserBoards = { jobs: JOBS_BOARD, profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };

const cfg: UserConfig = testConfig({
  settings: {
    timezone: 'UTC', providers: ['gemini'], scoring_cap: 150,
    linkedin: false, allowed_members: [], bot_keyword: '/bot',
    caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
  },
  dream: 'Looking for event work.', cv: 'CV of Alex Testperson', personalDetails: ['Alex Testperson'],
});

// What the model reads from the cards: one active profile that drops "senior" in titles.
const COMPILED: Compiled = {
  places: { anywhere: false, keep: ['Berlin', 'Germany'], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [], text_exclude: [], languages: {}, years_experience: null,
  profiles: [{
    name: 'Default', search_terms: ['event manager'], title_include: ['manager', 'engineer'], title_exclude: ['senior'],
    examples: [{ role: 'Event manager', score: 8 }, { role: 'Venue engineer', score: 6 }, { role: 'Sales clerk', score: 1 }],
  }],
  unused: [], problems: [],
};

type FetchJdFn = NetDeps['fetchJd'];

function setup(jdFn: FetchJdFn = async () => null, compile: () => CompileReply = () => COMPILED) {
  const fake = new FakeTrello();
  const llm = fakeLlm({ score: () => 5, compile });
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const fetchJdCalls: { key: string; url: string }[] = [];
  const ctx = {
    api: scopeUserBoards(raw, BOARDS),
    boards: BOARDS,
    me: { id: 'bot1', username: 'samplebot' },
    settings: cfg.settings,
    action: { id: 'act1', idMemberCreator: 'u1', text: '', cardId: 'c1', boardId: JOBS_BOARD, date: new Date().toISOString() },
    now: new Date('2026-11-12T12:00:00Z'),
    config: async () => cfg,
    starter: { isRunning: async () => false, start: async () => {} },
    net: {
      fetchJd: async (job: { key: string; url: string }, opts?: { deadline?: number }) => {
        fetchJdCalls.push({ key: job.key, url: job.url });
        return jdFn(job, opts);
      },
      checkOpen: async () => ({ verdict: 'open' as const, reason: 'live' }),
    },
    log: () => {},
    env: fakeLlmEnv,
    call: { fetchImpl: llm.fetchImpl, retries: 0 },
    signal: new AbortController().signal,
  } as unknown as CommandCtx;
  return { fake, raw, ctx, fetchJdCalls, llm };
}

test('why: a job with a card → its link', async () => {
  const { ctx, raw } = setup();
  const list = await raw.createList(JOBS_BOARD, 'Nov 12 · 01:00', 'bottom');
  // A greenhouse URL whose key matches the card we seed
  const url = 'https://boards.greenhouse.io/acme/jobs/9001';
  const card = await raw.createCard({
    idList: list.id,
    name: '7 · Acme — Software Engineer',
    desc: 'Some text.\n\n---\ncareer-cards-key: greenhouse:acme:9001',
    pos: 'bottom',
  });
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.startsWith('This job already has a card:'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes(card.shortUrl), `expected shortUrl in text`);
  assert.deepEqual(result.links, [card.shortUrl]);
  assert.ok(!result.text.includes('(archived)'), 'open card should not say archived');
});

test('why: a job with an archived card → its link plus (archived)', async () => {
  const { ctx, raw } = setup();
  const list = await raw.createList(JOBS_BOARD, 'Nov 12 · 01:00', 'bottom');
  const url = 'https://boards.greenhouse.io/acme/jobs/9002';
  const card = await raw.createCard({
    idList: list.id,
    name: '5 · Acme — Old Role',
    desc: 'Old.\n\n---\ncareer-cards-key: greenhouse:acme:9002',
    pos: 'bottom',
  });
  await raw.setCardClosed(card.id, true);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.includes('(archived)'), `expected (archived) in text: ${result.text}`);
  assert.deepEqual(result.links, [card.shortUrl]);
});

test('why: rejected by a compiled title rule → the rule in plain words, its id and the evidence', async () => {
  // 8.8.8.8 is a public IP so assertPublicUrl passes without DNS lookup
  const url = 'https://8.8.8.8/senior-engineer/42';
  const jd: FetchJdResult = { jd: 'Join our team.', meta: { title: 'Senior Software Engineer', company: 'Acme' } };
  const { ctx, llm } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.equal(result.text, 'Rejected: title contains excluded word (`TITLE_EXCLUDED`): "Senior"');
  assert.equal(result.uncounted, undefined, 'the compile call counts');
  assert.equal(llm.requests.length, 1);
});

test('why: a place the cards do not keep → PLACE_NOT_KEPT with the location', async () => {
  const jd: FetchJdResult = { jd: 'Run events.', meta: { title: 'Event Manager', location: 'Zürich, Switzerland' } };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: 'https://8.8.8.8/event-manager/9' });
  assert.equal(result.text, 'Rejected: location not in your places (`PLACE_NOT_KEPT`): "Zürich, Switzerland"');
});

test('why: cards the model cannot use → the first reason', async () => {
  const jd: FetchJdResult = { jd: 'Run events.', meta: { title: 'Event Manager' } };
  const { ctx } = setup(async () => jd, () => ({ ...COMPILED, problems: [{ card: 'Default › My dream job', reason: 'says nothing usable' }] }));
  const result = await explainFilter(ctx, { link: 'https://8.8.8.8/event-manager/10' });
  assert.equal(result.text, "I couldn't read your Profiles cards just now: Default › My dream job: says nothing usable");
});

test('why: counted in the model cap class; a reply before the compile is uncounted', async () => {
  assert.equal(capClassOf(CATALOGUE.find((s) => s.id === 'explain_filter')!), 'model');
  const { ctx, llm } = setup(async () => null);
  const result = await explainFilter(ctx, { link: 'https://8.8.8.8/event-manager/11' });
  assert.equal(result.uncounted, true);
  assert.equal(llm.requests.length, 0);
});

test('why: passes → would be scored', async () => {
  const url = 'https://8.8.8.8/event-manager/1';
  const jd: FetchJdResult = { jd: 'Plan events across Europe.', meta: { title: 'Event Manager', company: 'EventCo', location: 'Berlin, Germany' } };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.startsWith('No filter rejects it'), `unexpected text: ${result.text}`);
});

test('why: expired → EXPIRED', async () => {
  const url = 'https://8.8.8.8/event-manager/2';
  const jd: FetchJdResult = { jd: 'Plan events.', meta: { title: 'Event Manager', deadline: '2026-11-01' } };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.equal(result.text, 'Rejected: the application deadline has passed (`EXPIRED`): "deadline 2026-11-01"');
});

test('why with an internal link fetches nothing (private IPv4)', async () => {
  const url = 'http://10.0.0.5/jobs/1';
  const { ctx, fetchJdCalls } = setup();
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.includes("I can't check that link"), `unexpected text: ${result.text}`);
  assert.deepEqual(fetchJdCalls, [], 'fetchJd must not be called');
});

test('why with an internal link fetches nothing (loopback with greenhouse path)', async () => {
  const url = 'http://127.0.0.1/greenhouse.io/x/jobs/1';
  const { ctx, fetchJdCalls } = setup();
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.includes("I can't check that link"), `unexpected text: ${result.text}`);
  assert.deepEqual(fetchJdCalls, [], 'fetchJd must not be called');
});

test('why: no description → the can\'t-tell reply', async () => {
  const url = 'https://8.8.8.8/event-manager/3';
  const { ctx } = setup(async () => null);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.includes("I couldn't read the posting"), `unexpected text: ${result.text}`);
});

test('why: no title in description → the can\'t-tell reply', async () => {
  const url = 'https://8.8.8.8/event-manager/4';
  const jd: FetchJdResult = { jd: 'Some page content.', meta: {} };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.includes("I couldn't find the job title"), `unexpected text: ${result.text}`);
});

// When the real bot fetchJd (Task 13) provides a title for an ATS key, why reaches the filter.
// The host 8.8.8.8 is a public IP so assertPublicUrl passes without DNS. The path matches
// the greenhouse key pattern, so jobKey returns greenhouse:acme:9999 (an ATS key).
test('why: ATS-key URL whose fetchJd returns a title → passes the filter', async () => {
  const url = 'https://8.8.8.8/greenhouse.io/acme/jobs/9999';
  const jd: FetchJdResult = { jd: 'Join our event team.', meta: { title: 'Event Manager', company: 'Acme Events', location: 'Berlin, Germany' } };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.startsWith('No filter rejects it'), `unexpected text: ${result.text}`);
});
