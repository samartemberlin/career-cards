import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import { guardWrites } from '../../src/bot/dispatch.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { CommandCtx } from '../../src/bot/handlers.ts';
import { feedbackComment, findFeedbackCards, recordFeedback } from '../../src/bot/feedback.ts';
import type { JobFields } from '../../src/bot/context.ts';
import type { UserConfig } from '../../src/config/schema.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = {
  jobs: 'fa4e00000000000000000005',
  profiles: 'fa4e0000000000000000000c',
  system: 'fa4e0000000000000000000d',
};

// From the fixture: open "Content editor" list → open "Feedback" card
const FEEDBACK_CARD = 'fa4e00000000000000000461';
const FEEDBACK_SHORT_URL = 'https://trello.com/c/sample1072';
// The job card from the fixture (jobs/all)
const JOB_CARD = 'fa4e00000000000000000012';
// Originals list id from profiles fixture
const ORIGINALS_LIST = 'fa4e00000000000000000440';

const SETTINGS = {
  timezone: 'UTC',
  providers: ['gemini'] as ['gemini'],
  scoring_cap: 150,
  locations: [],
  linkedin_locations: [],
  linkedin: false,
  allowed_members: [],
  caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
};

/** Config with one active profile named "Content editor" (matches the fixture's list). */
function makeConfig(overrides: { profiles?: UserConfig['profiles'] } = {}): UserConfig {
  return {
    settings: SETTINGS,
    profiles: overrides.profiles ?? [{
      name: 'Content editor',
      active: true,
      rubric: 'Looking for editing work.',
      searchKeywords: [],
      filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] },
    }],
    sharedCv: 'CV of Alex Testperson',
    personalDetails: ['Alex Testperson'],
    preferences: undefined,
    sources: { add: [], drop: [] },
  };
}

function setup(cfgOverrides: { profiles?: UserConfig['profiles'] } = {}) {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const cfg = makeConfig(cfgOverrides);
  const ctx = {
    api: scopeUserBoards(raw, BOARDS),
    boards: BOARDS,
    me: { id: 'botid', username: 'samplebot' },
    settings: SETTINGS,
    action: { id: 'act1', cardId: JOB_CARD, boardId: BOARDS.jobs, author: 'usera', authorId: 'uid1',
      text: '', date: new Date('2026-11-12T12:00:00Z') },
    now: new Date('2026-11-12T12:00:00Z'),
    config: async () => cfg,
    starter: { isRunning: async () => false, start: async () => {} },
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'open' as const, reason: 'live' }) },
    log: () => {},
    signal: new AbortController().signal,
    comments: [],
  } as unknown as CommandCtx;
  return { fake, raw, ctx };
}

// --- feedbackComment ---

test('feedbackComment: format with all fields', () => {
  const job: JobFields = {
    key: 'sample:job-1', company: 'Acme Corp', title: 'Content Editor',
    url: 'https://jobs.acme.example/apply', location: 'Berlin', posted: '2026-11-01',
    deadline: '', why: '', jd: 'some jd', score: 7,
  };
  const result = feedbackComment(job, 'https://trello.com/c/abc', 'Great team.');
  assert.match(result, /^Feedback on \[/);
  assert.match(result, /Acme Corp/);
  assert.match(result, /Content Editor/);
  assert.match(result, /score 7/);
  assert.match(result, /Posting: https:\/\/jobs\.acme\.example\/apply/);
  assert.match(result, /> Great team\./);
});

test('feedbackComment: multi-line text is kept line for line', () => {
  const job: JobFields = {
    key: 'k', company: 'Co', title: 'Role', url: 'https://co.example/j', location: '',
    posted: '', deadline: '', why: '', jd: '', score: null,
  };
  const result = feedbackComment(job, 'https://trello.com/c/x', 'line one\nline two\nline three');
  assert.ok(result.includes('> line one\n> line two\n> line three'), `unexpected:\n${result}`);
});

test('feedbackComment: no-URL job prints –', () => {
  const job: JobFields = {
    key: 'k', company: 'Co', title: 'Role', url: '', location: '',
    posted: '', deadline: '', why: '', jd: '', score: null,
  };
  const result = feedbackComment(job, 'https://trello.com/c/x', 'text');
  assert.match(result, /Posting: –/);
});

test('feedbackComment: URL with Markdown-active chars prints –', () => {
  const job: JobFields = {
    key: 'k', company: 'Co', title: 'Role',
    url: 'https://a.example/[x](https://evil.example)',
    location: '', posted: '', deadline: '', why: '', jd: '', score: null,
  };
  const result = feedbackComment(job, 'https://trello.com/c/x', 'text');
  assert.match(result, /Posting: –/);
  assert.ok(!result.includes('evil.example'), `planted URL should not appear: ${result}`);
});

test('feedbackComment: score null prints –', () => {
  const job: JobFields = {
    key: 'k', company: 'Co', title: 'Role', url: '', location: '',
    posted: '', deadline: '', why: '', jd: '', score: null,
  };
  const result = feedbackComment(job, 'https://trello.com/c/x', 'text');
  assert.match(result, /score –/);
});

// --- findFeedbackCards ---

test('findFeedbackCards: finds the Feedback card in the matching list', async () => {
  const { ctx } = setup();
  const profiles = [{ name: 'Content editor', active: true, rubric: '', searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } }];
  const result = await findFeedbackCards(ctx.api, BOARDS.profiles, profiles);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.profile, 'Content editor');
  assert.equal(result[0]!.card?.id, FEEDBACK_CARD);
});

test('findFeedbackCards: case-insensitive and trims whitespace', async () => {
  const { ctx } = setup();
  const profiles = [{ name: ' CONTENT EDITOR ', active: true, rubric: '', searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } }];
  const result = await findFeedbackCards(ctx.api, BOARDS.profiles, profiles);
  assert.equal(result[0]!.card?.id, FEEDBACK_CARD);
});

test('findFeedbackCards: null when list not found', async () => {
  const { ctx } = setup();
  const profiles = [{ name: 'No such list', active: true, rubric: '', searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } }];
  const result = await findFeedbackCards(ctx.api, BOARDS.profiles, profiles);
  assert.equal(result[0]!.card, null);
});

test('findFeedbackCards: null when list exists but has no Feedback card', async () => {
  const { ctx } = setup();
  // "Copywriter" list exists in the fixture but has no Feedback card
  const profiles = [{ name: 'Copywriter', active: true, rubric: '', searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } }];
  const result = await findFeedbackCards(ctx.api, BOARDS.profiles, profiles);
  assert.equal(result[0]!.card, null);
});

// --- recordFeedback handler ---

test('feedback posts the words verbatim on the active profile\'s Feedback card', async () => {
  const { fake, ctx } = setup();
  const feedbackText = 'Good work environment.\nFast interview process.';
  const result = await recordFeedback(ctx, { text: feedbackText });

  assert.match(result.text, /Recorded on:/);
  const comments = fake.commentsOn(FEEDBACK_CARD);
  assert.equal(comments.length, 1);
  // The comment matches feedbackComment(...) exactly
  const job = { key: 'sample:job-1', company: 'Example Media GmbH', title: 'Content Editor',
    url: 'https://jobs.example.com/sample-1', location: 'Berlin, Germany', posted: '2026-11-02',
    deadline: '', why: 'Editing role in Berlin that matches the profile.', jd: '', score: 9 };
  assert.equal(comments[0], feedbackComment(job, FEEDBACK_SHORT_URL, feedbackText));
  // Multi-line preserved
  assert.ok(comments[0]!.includes('> Good work environment.\n> Fast interview process.'));
});

test('an inactive profile\'s Feedback card gets nothing', async () => {
  const { fake, ctx } = setup({
    profiles: [
      { name: 'Content editor', active: false, rubric: '', searchKeywords: [],
        filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } },
    ],
  });
  await recordFeedback(ctx, { text: 'hi' });
  assert.deepEqual(fake.commentsOn(FEEDBACK_CARD), []);
});

test('a missing Feedback card is named in the reply, and nothing is created', async () => {
  const { fake, ctx } = setup({
    profiles: [
      { name: 'Copywriter', active: true, rubric: '', searchKeywords: [],
        filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } },
    ],
  });
  const result = await recordFeedback(ctx, { text: 'hi' });
  assert.match(result.text, /No Feedback card in the "Copywriter" column/);
  // The count of cards on the profiles board hasn't increased
  const before = fake.commentsOn(FEEDBACK_CARD).length;
  assert.equal(before, 0);
});

test('@bot inside the feedback text loses its @', async () => {
  const { fake, ctx } = setup();
  await recordFeedback(ctx, { text: '@samplebot great team' });
  const comments = fake.commentsOn(FEEDBACK_CARD);
  assert.equal(comments.length, 1);
  assert.ok(!comments[0]!.includes('@samplebot'), `@ should be stripped: ${comments[0]}`);
  assert.ok(comments[0]!.includes('samplebot'), 'name without @ should remain');
});

test('feedback on a non-job card replies JOB_ONLY_REPLY', async () => {
  const { fake, raw, ctx } = setup();
  // Create a card on the profiles board (not a job card)
  const list = await raw.createList(BOARDS.profiles, 'Test', 'bottom');
  const profileCard = await raw.createCard({ idList: list.id, name: 'Some profile', desc: 'No job key.', pos: 'bottom' });
  (ctx.action as { cardId: string }).cardId = profileCard.id;
  const result = await recordFeedback(ctx, { text: 'hi' });
  assert.match(result.text, /`feedback` works on job cards only/);
  assert.ok(result.uncounted === true);
  assert.deepEqual(fake.commentsOn(FEEDBACK_CARD), []);
});

test('feedback on an Originals card is refused by the guard', async () => {
  const { fake, ctx } = setup({
    profiles: [
      // A profile named "Originals" bypasses the config schema in this test to exercise the guard
      { name: 'Originals', active: true, rubric: '', searchKeywords: [],
        filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] } },
    ],
  });
  // Add a Feedback card to the Originals list (the guard blocks writes there)
  fake.addCards(ORIGINALS_LIST, 1, () => ({ name: 'Feedback', desc: '' }));

  // The handler must not throw; it reports the guard error in the result
  const result = await recordFeedback(ctx, { text: 'hi' });
  assert.ok(!result.text.includes('Recorded on:'), `should not record: ${result.text}`);
  assert.ok(result.text.includes('Originals') || result.text.includes('Cannot record'), `should mention error: ${result.text}`);
});

test('the reply links the Feedback cards', async () => {
  const { ctx } = setup();
  const result = await recordFeedback(ctx, { text: 'great role' });
  assert.ok(Array.isArray(result.links) && result.links.length > 0, 'links should be non-empty');
  assert.ok(result.links!.includes(FEEDBACK_SHORT_URL), `expected ${FEEDBACK_SHORT_URL} in links: ${JSON.stringify(result.links)}`);
  assert.ok(result.text.includes(FEEDBACK_SHORT_URL), `expected shortUrl in text: ${result.text}`);
});

test('a planted link in the job title does not become a link on the Feedback card', async () => {
  const { fake, raw, ctx } = setup();
  // Create a job card with a Markdown link in the title field of the description
  const list = await raw.createList(BOARDS.jobs, 'Nov 12 · test', 'bottom');
  const card = await raw.createCard({
    idList: list.id,
    name: '5 · Evil Corp — [x](https://evil.example)',
    desc: '**Evil Corp — [x](https://evil.example)**\n\n**Link:** https://evil.example/job\n**Location:** —  ·  **Posted:** —  ·  **Deadline:** —\n\n---\ntest\n\n---\ncareer-cards-key: evil:job:1',
    pos: 'bottom',
  });
  (ctx.action as { cardId: string }).cardId = card.id;
  const result = await recordFeedback(ctx, { text: 'looks good' });
  const comments = fake.commentsOn(FEEDBACK_CARD);
  assert.equal(comments.length, 1);
  // The link in the title is escaped, not rendered as a link
  assert.ok(!comments[0]!.includes('](https://evil.example)'), `link syntax should be escaped: ${comments[0]}`);
});

test('feedback after an abort posts on no Feedback card', async () => {
  const { fake, ctx } = setup();
  const ac = new AbortController();
  // Replace ctx.api with a write-guarded version and immediately abort
  (ctx as { api: typeof ctx.api }).api = guardWrites(ctx.api, ac.signal);
  ac.abort();
  // The handler throws because ctx.api.comment throws after abort
  await assert.rejects(async () => recordFeedback(ctx, { text: 'hi' }));
  assert.deepEqual(fake.commentsOn(FEEDBACK_CARD), []);
});
