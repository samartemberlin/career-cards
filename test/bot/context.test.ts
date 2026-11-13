import test from 'node:test';
import assert from 'node:assert/strict';
import type { TCardWithList, TComment } from '../../src/trello/api.ts';
import type { BotApi } from '../../src/trello/api.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { CommentAction } from '../../src/serve/gate.ts';
import { jobCardDesc } from '../../src/trello/cards.ts';
import { parseJobCard, loadCardContext } from '../../src/bot/context.ts';

const BOARDS: UserBoards = {
  jobs: 'fa4e00000000000000000005',
  profiles: 'fa4e0000000000000000000c',
  system: 'fa4e0000000000000000000d',
};

const BOT_ID = 'fa4e000000000000000000ff';

// --- parseJobCard tests --------------------------------------------------

test('parseJobCard reads back what jobCardDesc wrote', () => {
  const name = '7 · Acme Corp — Marketing Manager';
  const { desc } = jobCardDesc({
    key: 'acme-mm-001',
    company: 'Acme Corp',
    title: 'Marketing Manager',
    url: 'https://jobs.acme.example/apply',
    location: 'Berlin',
    posted: '2026-11-01',
    deadline: '2026-11-30',
    jd: 'Join our fast-growing team. Apply today.',
    reason: 'Strong fit for marketing role.',
  });
  const f = parseJobCard(name, desc);
  assert.ok(f);
  assert.equal(f.key, 'acme-mm-001');
  assert.equal(f.company, 'Acme Corp');
  assert.equal(f.title, 'Marketing Manager');
  assert.equal(f.url, 'https://jobs.acme.example/apply');
  assert.equal(f.location, 'Berlin');
  assert.equal(f.posted, '2026-11-01');
  assert.equal(f.deadline, '2026-11-30');
  assert.equal(f.why, 'Strong fit for marketing role.');
  assert.equal(f.jd, 'Join our fast-growing team. Apply today.');
  assert.equal(f.score, 7);
});

test('parseJobCard reads a samjobs-format card', () => {
  const name = '6 · Beta GmbH — Data Analyst';
  const desc = [
    '**Beta GmbH — Data Analyst**',
    '',
    '**Link:** https://beta.example/jobs/42',
    '**Location:** Hamburg  ·  **Posted:** 2026-10-15  ·  **Deadline:** —',
    '',
    '---',
    '',
    'We are looking for a skilled data analyst.',
    '',
    '---',
    'samjobs-key: beta-da-042',
  ].join('\n');
  const f = parseJobCard(name, desc);
  assert.ok(f);
  assert.equal(f.key, 'beta-da-042');
  assert.equal(f.company, 'Beta GmbH');
  assert.equal(f.title, 'Data Analyst');
  assert.equal(f.url, 'https://beta.example/jobs/42');
  assert.equal(f.location, 'Hamburg');
  assert.equal(f.posted, '2026-10-15');
  assert.equal(f.score, 6);
});

test('parseJobCard ignores a **Link:** line inside the job text', () => {
  const name = '5 · Gamma Ltd — Backend Engineer';
  const { desc } = jobCardDesc({
    key: 'gamma-be-007',
    company: 'Gamma Ltd',
    title: 'Backend Engineer',
    url: 'https://gamma.example/careers/7',
    location: 'Remote',
    posted: '2026-10-20',
    deadline: '',
    jd: 'Build scalable services.\n\n**Link:** https://evil.example/phish\n\nSee our website.',
  });
  const f = parseJobCard(name, desc);
  assert.ok(f);
  assert.equal(f.url, 'https://gamma.example/careers/7');
  assert.ok(f.jd.includes('**Link:** https://evil.example/phish'), 'JD link should be preserved in jd field');
});

test('parseJobCard falls back to the title when the head is missing', () => {
  const name = '4 · Delta Inc — Product Manager';
  const desc = 'Some job description text without a link or head structure.\n\ncareer-cards-key: delta-pm-003';
  const f = parseJobCard(name, desc);
  assert.ok(f);
  assert.equal(f.key, 'delta-pm-003');
  assert.equal(f.company, 'Delta Inc');
  assert.equal(f.title, 'Product Manager');
  assert.equal(f.url, '');
  assert.equal(f.score, 4);
  assert.ok(f.jd.includes('Some job description text'));
});

test('parseJobCard is null for a summary card, a config card and a card without a key', () => {
  // Summary card
  assert.equal(parseJobCard('ℹ️ Run 2026-11-12 ok', 'career-cards-key: run-001'), null);

  // Config card (no key)
  assert.equal(parseJobCard('Settings', '```yaml\nlocations: [berlin]\n```'), null);

  // Card without a key
  assert.equal(parseJobCard('8 · Epsilon Co — Designer', 'Some description without a key line.'), null);
});

test('parseJobCard reads deadline and why from the head', () => {
  const name = '9 · Zeta AG — DevOps Engineer';
  const { desc } = jobCardDesc({
    key: 'zeta-do-099',
    company: 'Zeta AG',
    title: 'DevOps Engineer',
    url: 'https://zeta.example/jobs/99',
    location: 'Munich',
    posted: '2026-11-05',
    deadline: '2026-12-01',
    jd: 'Manage cloud infrastructure.',
    reason: 'Perfect match: cloud and automation skills.',
  });
  const f = parseJobCard(name, desc);
  assert.ok(f);
  assert.equal(f.deadline, '2026-12-01');
  assert.equal(f.why, 'Perfect match: cloud and automation skills.');
});

// --- loadCardContext tests -----------------------------------------------

function makeComment(n: number, cardId: string, boardId: string, authorId: string, authorName: string): TComment {
  const id = `comment-${String(n).padStart(3, '0')}`;
  const date = new Date(2026, 10, 1, 0, n).toISOString();
  return { id, idMemberCreator: authorId, username: authorName, date, text: `Comment ${n}`, cardId, boardId };
}

function makeApi(card: TCardWithList): BotApi {
  return {
    card: async (id: string) => { assert.equal(id, card.id); return card; },
  } as unknown as BotApi;
}

const USER_ID = 'fa4e0000000000000000a001';
const USER_NAME = 'alice';
const CARD_ID = 'fa4e00000000000000000012';
const LIST_NAME = 'Nov 10 · 01:00';

const BASE_CARD: TCardWithList = {
  id: CARD_ID,
  name: '7 · Acme Corp — Marketing Manager',
  desc: '',
  idList: 'fa4e0000000000000000001a',
  idBoard: BOARDS.jobs,
  closed: false,
  pos: 1,
  shortUrl: 'https://trello.com/c/fakejob1',
  list: { id: 'fa4e0000000000000000001a', name: LIST_NAME },
};

test('loadCardContext keeps the newest 20 comments, oldest first, without the request', async () => {
  // 25 comments newest-first (matching what the gate passes from cardComments).
  // Comment 25 is the newest and is the request action id.
  const REQUEST_ID = 'comment-025';
  const comments: TComment[] = [];
  for (let i = 25; i >= 1; i--) {
    comments.push(makeComment(i, CARD_ID, BOARDS.jobs, USER_ID, USER_NAME));
  }
  // Comment 25 is the request itself (first in the newest-first array)
  assert.equal(comments[0]!.id, REQUEST_ID);

  const { desc } = jobCardDesc({
    key: 'acme-mm-001', company: 'Acme Corp', title: 'Marketing Manager',
    url: 'https://acme.example/apply', location: 'Berlin', posted: '2026-11-01', deadline: '', jd: 'JD text.',
  });
  const card: TCardWithList = { ...BASE_CARD, desc };
  const a: Pick<CommentAction, 'id' | 'cardId'> = { id: REQUEST_ID, cardId: CARD_ID };

  const ctx = await loadCardContext(makeApi(card), BOARDS, a, BOT_ID, comments);

  assert.equal(ctx.conversation.length, 20);
  assert.equal(ctx.conversation[0]!.text, 'Comment 5');
  assert.equal(ctx.conversation[19]!.text, 'Comment 24');
});

test('loadCardContext marks the bot\'s comments byBot (by member id)', async () => {
  // Newest-first: comment 3 is the request (newest), comment 2 is bot, comment 1 is user.
  const REQUEST_ID = 'comment-003';
  const comments: TComment[] = [
    makeComment(3, CARD_ID, BOARDS.jobs, USER_ID, USER_NAME), // request (newest)
    makeComment(2, CARD_ID, BOARDS.jobs, BOT_ID, 'samplebot'),
    makeComment(1, CARD_ID, BOARDS.jobs, USER_ID, USER_NAME),
  ];
  const a: Pick<CommentAction, 'id' | 'cardId'> = { id: REQUEST_ID, cardId: CARD_ID };

  const { desc } = jobCardDesc({
    key: 'bot-test-001', company: 'Test Co', title: 'Engineer',
    url: 'https://test.example/job', location: 'Berlin', posted: '2026-11-01', deadline: '', jd: 'Job text.',
  });
  const card: TCardWithList = { ...BASE_CARD, desc };
  const ctx = await loadCardContext(makeApi(card), BOARDS, a, BOT_ID, comments);

  assert.equal(ctx.conversation.length, 2);
  assert.equal(ctx.conversation[0]!.byBot, false);  // comment 1: user
  assert.equal(ctx.conversation[1]!.byBot, true);   // comment 2: bot
});

test('loadCardContext on a Profiles card has board \'profiles\' and job null', async () => {
  const PROFILE_CARD_ID = 'fa4e00000000000000000099';
  // Newest-first: only one comment and it is the request itself.
  const REQUEST_ID = 'comment-001';
  const comments: TComment[] = [
    makeComment(1, PROFILE_CARD_ID, BOARDS.profiles, USER_ID, USER_NAME), // the request
  ];
  const a: Pick<CommentAction, 'id' | 'cardId'> = { id: REQUEST_ID, cardId: PROFILE_CARD_ID };
  const profileCard: TCardWithList = {
    id: PROFILE_CARD_ID,
    name: 'Jane Roe',
    desc: 'A profile card, no job key.',
    idList: 'fa4e0000000000000000002b',
    idBoard: BOARDS.profiles,
    closed: false,
    pos: 1,
    shortUrl: 'https://trello.com/c/fakeprof',
    list: { id: 'fa4e0000000000000000002b', name: 'Originals' },
  };
  const ctx = await loadCardContext(makeApi(profileCard), BOARDS, a, BOT_ID, comments);

  assert.equal(ctx.board, 'profiles');
  assert.equal(ctx.job, null);
  assert.equal(ctx.card.url, 'https://trello.com/c/fakeprof');
  assert.equal(ctx.conversation.length, 0); // the only comment was the request itself
});
