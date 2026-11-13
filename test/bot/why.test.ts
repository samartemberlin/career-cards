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

const JOBS_BOARD = 'fa4e00000000000000000005';
const BOARDS: UserBoards = { jobs: JOBS_BOARD, profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };

// config with one active profile that excludes "senior" in titles
const cfg: UserConfig = {
  settings: {
    timezone: 'UTC', providers: ['gemini'], scoring_cap: 150, locations: ['berlin'],
    linkedin_locations: [], linkedin: false, allowed_members: [], bot_keyword: '/bot',
    caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
  },
  profiles: [{
    name: 'Default', active: true, rubric: 'Looking for event work.',
    searchKeywords: [],
    filters: {
      includeTitles: [],
      excludeTitles: [{ pattern: 'senior' }],
      excludeCompanies: [],
      excludeText: [],
      excludeLocations: [],
    },
  }],
  sharedCv: 'CV of Alex Testperson', personalDetails: ['Alex Testperson'],
  preferences: undefined,
  sources: { add: [], drop: [] },
};

type FetchJdFn = NetDeps['fetchJd'];

function setup(jdFn: FetchJdFn = async () => null) {
  const fake = new FakeTrello();
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
  } as unknown as CommandCtx;
  return { fake, raw, ctx, fetchJdCalls };
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

test('why: rejected by an Exclude titles item → the rule id', async () => {
  // 8.8.8.8 is a public IP so assertPublicUrl passes without DNS lookup
  const url = 'https://8.8.8.8/senior-engineer/42';
  const jd: FetchJdResult = { jd: 'Join our team.', meta: { title: 'Senior Software Engineer', company: 'Acme' } };
  const { ctx } = setup(async () => jd);
  const result = await explainFilter(ctx, { link: url });
  assert.ok(result.text.startsWith('Rejected by rule `EXCLUDE_TITLE`'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes('EXCLUDE_TITLE'), 'rule id in body');
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
  assert.ok(result.text.startsWith('Rejected by rule `EXPIRED`'), `unexpected text: ${result.text}`);
  assert.ok(result.text.includes('deadline 2026-11-01'), `expected deadline in text: ${result.text}`);
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
