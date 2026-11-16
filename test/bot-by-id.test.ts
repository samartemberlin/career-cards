import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient, TrelloError } from '../src/trello/client.ts';
import { scopeUserBoards } from '../src/trello/scoped.ts';
import type { UserBoards } from '../src/trello/scoped.ts';
import type { BotApi, TMember } from '../src/trello/api.ts';
import { createRecentIds } from '../src/serve/gate.ts';
import { byId, BOT_ACTION_MAX_AGE_MS } from '../src/bot/by-id.ts';
import type { ByIdDeps } from '../src/bot/by-id.ts';
import { formatMarker } from '../src/bot/marker.ts';
import { FakeTrello } from './support/fake-trello.ts';
import { commentWebhook } from './support/webhook.ts';
import type { Recording } from '../tools/sample/scrub.ts';
import type { RunTrigger } from '../src/run/stats.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const FOREIGN_BOARD = 'aaaa000000000000000000ff';
const JOB_CARD = 'fa4e00000000000000000012';
const SETTINGS_CARD = 'fa4e00000000000000000476';
const BOT: TMember = { id: 'fa4e000000000000000000ff', username: 'samplebot' };
const USER_A: TMember = { id: 'fa4e0000000000000000a001', username: 'usera' };
const NOW = new Date('2026-11-16T12:00:00.000Z');

let nextId = 0xb100;
const newId = () => `fa4e${(nextId++).toString(16).padStart(20, '0')}`;

const settingsDesc = (allowed: string[]) =>
  `\`\`\`yaml\nproviders: [claude]\nlocations: [berlin]\nallowed_members: [${allowed.join(', ')}]\n\`\`\``;

/** Full setup using recorded fixture data. */
function fullSetup() {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  fake.setNow(NOW);
  fake.setCardDesc(SETTINGS_CARD, settingsDesc(['usera']));
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeUserBoards(raw, BOARDS);
  const logs: string[] = [];
  const starts: RunTrigger[] = [];
  const starter = { isRunning: async () => false, start: async (t: RunTrigger) => { starts.push(t); } };
  const deps: ByIdDeps = {
    api,
    boards: BOARDS,
    me: BOT,
    seen: createRecentIds(),
    now: () => NOW,
    log: (s) => logs.push(s),
    starter,
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'unknown' as const, reason: 'test' }) },
    env: {},
  };
  return { fake, deps, logs, starts };
}

/** Minimal api stub for tests that only need api.action to return a specific value. */
function makeApi(actionFn: (id: string) => Promise<unknown>): BotApi {
  const noop = async (): Promise<never> => { throw new Error('unexpected call'); };
  return {
    action: actionFn,
    me: async () => BOT,
    board: noop, boardMembers: noop, lists: noop, list: noop,
    cards: noop, allCards: noop, card: noop, checklist: noop, labels: noop,
    createLabel: noop, createList: noop,
    comment: noop, createCard: noop, archiveCard: noop, attachText: noop,
    cardComments: noop, boardComments: noop,
  } as BotApi;
}

/** Minimal deps for early-drop tests (not found, not a comment, foreign board, stale). */
function minimalDeps(actionFn: (id: string) => Promise<unknown>): { deps: ByIdDeps; logs: string[] } {
  const logs: string[] = [];
  const deps: ByIdDeps = {
    api: makeApi(actionFn),
    boards: BOARDS,
    me: BOT,
    seen: createRecentIds(),
    now: () => NOW,
    log: (s) => logs.push(s),
    starter: { isRunning: async () => false, start: async () => {} },
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'unknown' as const, reason: 'test' }) },
    env: {},
  };
  return { deps, logs };
}

/** Build the raw action body for a commentCard, as Trello returns from GET /actions/{id}. */
function rawAction(o: {
  id: string; text: string; author: TMember; cardId: string; boardId: string; date: Date;
}): unknown {
  const webhook = commentWebhook({ cardId: o.cardId, boardId: o.boardId, author: o.author, text: o.text, date: o.date.toISOString(), id: o.id }) as Record<string, unknown>;
  return (webhook as { action: unknown }).action;
}

// ── success path ──────────────────────────────────────────────────────────

test('byId: commentCard on a user board → gate passes, handler runs, logs bot: action <id> handled', async () => {
  const { fake, deps, logs } = fullSetup();
  const id = newId();
  fake.seedAction(BOARDS.jobs, JOB_CARD, {
    id,
    idMemberCreator: USER_A.id,
    username: USER_A.username,
    date: new Date(NOW.getTime() - 60_000).toISOString(), // 1 min ago
    text: '@samplebot help',
  });

  const code = await byId(id, deps);

  assert.equal(code, 0);
  assert.ok(logs.some((l) => l === `bot: action ${id} handled`), `expected handled log; got: ${logs.join(' | ')}`);
  // Handler replied once
  assert.equal(fake.commentsOn(JOB_CARD).filter((c) => c.includes('career-cards-reply:')).length, 1);
});

// ── drop: not found ───────────────────────────────────────────────────────

test('byId: Trello 404 on the action → drop <id>: not found, exit 0, no Trello write', async () => {
  const id = newId();
  const { deps, logs } = minimalDeps(async (aid) => { throw new TrelloError(404, 'GET', `/actions/${aid}`, 'not found'); });
  const code = await byId(id, deps);
  assert.equal(code, 0);
  assert.ok(logs.includes(`drop ${id}: not found`), `logs: ${logs.join(' | ')}`);
});

// ── drop: not a comment ───────────────────────────────────────────────────

test('byId: non-commentCard action → drop <id>: not a comment, exit 0', async () => {
  const id = newId();
  const { deps, logs } = minimalDeps(async () => ({
    id, type: 'updateCard', date: NOW.toISOString(),
    idMemberCreator: USER_A.id,
    memberCreator: { username: USER_A.username },
    data: { card: { id: JOB_CARD }, board: { id: BOARDS.jobs } },
  }));
  const code = await byId(id, deps);
  assert.equal(code, 0);
  assert.ok(logs.includes(`drop ${id}: not a comment`), `logs: ${logs.join(' | ')}`);
});

// ── drop: foreign board ───────────────────────────────────────────────────

test('byId: foreign board → drop <id>: foreign board, exit 0', async () => {
  const id = newId();
  const date = new Date(NOW.getTime() - 60_000);
  const { deps, logs } = minimalDeps(async () => rawAction({ id, text: '@samplebot help', author: USER_A, cardId: JOB_CARD, boardId: FOREIGN_BOARD, date }));
  const code = await byId(id, deps);
  assert.equal(code, 0);
  assert.ok(logs.includes(`drop ${id}: foreign board`), `logs: ${logs.join(' | ')}`);
});

// ── drop: stale ───────────────────────────────────────────────────────────

test('byId: age 16 min with BOT_ACTION_MAX_AGE_MS 900_000 → drop <id>: stale, exit 0', async () => {
  assert.equal(BOT_ACTION_MAX_AGE_MS, 900_000);
  const id = newId();
  const date = new Date(NOW.getTime() - 16 * 60_000); // 16 min ago
  const { deps, logs } = minimalDeps(async () => rawAction({ id, text: '@samplebot help', author: USER_A, cardId: JOB_CARD, boardId: BOARDS.jobs, date }));
  const code = await byId(id, deps);
  assert.equal(code, 0);
  assert.ok(logs.includes(`drop ${id}: stale`), `logs: ${logs.join(' | ')}`);
});

// ── drop: already answered ────────────────────────────────────────────────

test('byId: already answered → drop <id>: answered, exit 0, no additional Trello write', async () => {
  const { fake, deps, logs } = fullSetup();
  const id = newId();
  // Add a bot reply that marks this action id as answered
  fake.addComment(JOB_CARD, BOT, `Here is help.\n\n${formatMarker({ actionId: id, cls: 'static' })}`);
  fake.seedAction(BOARDS.jobs, JOB_CARD, {
    id,
    idMemberCreator: USER_A.id,
    username: USER_A.username,
    date: new Date(NOW.getTime() - 60_000).toISOString(),
    text: '@samplebot help',
  });

  const writesBefore = fake.requests.filter((r) => r.method !== 'GET').length;
  const code = await byId(id, deps);
  assert.equal(code, 0);
  assert.ok(logs.includes(`drop ${id}: answered`), `logs: ${logs.join(' | ')}`);
  assert.equal(fake.requests.filter((r) => r.method !== 'GET').length, writesBefore, 'no writes');
});

// ── two sequential calls → one reply ─────────────────────────────────────

test('two sequential byId calls for the same action → one reply, second drops answered', async () => {
  const { fake, deps } = fullSetup();
  const id = newId();
  fake.seedAction(BOARDS.jobs, JOB_CARD, {
    id,
    idMemberCreator: USER_A.id,
    username: USER_A.username,
    date: new Date(NOW.getTime() - 60_000).toISOString(),
    text: '@samplebot help',
  });

  // First call: succeeds and posts a reply with the action marker
  await byId(id, deps);

  // Second call: same fake (now has the reply) but fresh seen; gate finds the marker → answered
  const logs2: string[] = [];
  const deps2: ByIdDeps = { ...deps, seen: createRecentIds(), log: (s) => logs2.push(s) };
  const code2 = await byId(id, deps2);

  assert.equal(code2, 0);
  assert.ok(logs2.includes(`drop ${id}: answered`), `second call logs: ${logs2.join(' | ')}`);
  // Exactly one reply posted (from the first call only)
  const replies = fake.commentsOn(JOB_CARD).filter((c) => c.includes('career-cards-reply:'));
  assert.equal(replies.length, 1, `expected one reply, got ${replies.length}`);
});

