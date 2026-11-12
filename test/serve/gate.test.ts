import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { TMember } from '../../src/trello/api.ts';
import { ACTION_MAX_AGE_MS, createRecentIds, gate, mentions, parseWebhook } from '../../src/serve/gate.ts';
import type { CommentAction, DropReason, GateDeps } from '../../src/serve/gate.ts';
import { formatMarker } from '../../src/bot/marker.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { commentWebhook } from '../support/webhook.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const JOB_CARD = 'fa4e00000000000000000012';
const ORIGINALS_CARD = 'fa4e00000000000000000443';
const SETTINGS_CARD = (load('system').find((c) => c.path.endsWith('/cards/open'))!.body as { id: string; name: string }[])
  .find((c) => c.name === 'Settings')!.id;
const BOT: TMember = { id: 'fa4e00000000000000000002', username: 'samplebot' };
const USER_A: TMember = { id: 'fa4e0000000000000000a001', username: 'usera' };
const STRANGER: TMember = { id: 'fa4e0000000000000000a002', username: 'stranger' };
const NOW = new Date('2026-11-12T12:00:00.000Z');
const ACTION_ID = 'fa4e0000000000000000b001';

const settingsDesc = (allowed: string[]) =>
  `\`\`\`yaml\nproviders: [claude]\nlocations: [berlin]\nallowed_members: [${allowed.join(', ')}]\n\`\`\``;

function setup(allowed: string[] = ['usera']) {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  fake.setCardDesc(SETTINGS_CARD, settingsDesc(allowed));
  const api = scopeUserBoards(createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} }), BOARDS);
  const logs: string[] = [];
  const deps: GateDeps = { api, boards: BOARDS, me: BOT, seen: createRecentIds(), now: () => NOW, log: (s) => logs.push(s) };
  return { fake, deps, logs };
}

function action(o: Partial<{ cardId: string; boardId: string; listName: string; author: TMember; text: string; date: Date; id: string }> = {}): CommentAction {
  const a = parseWebhook(commentWebhook({
    cardId: o.cardId ?? JOB_CARD,
    boardId: o.boardId ?? BOARDS.jobs,
    listName: o.listName ?? 'Nov 9 · 01:00',
    author: o.author ?? USER_A,
    text: o.text ?? '@samplebot open',
    date: (o.date ?? new Date(NOW.getTime() - 5 * 60_000)).toISOString(),
    id: o.id ?? ACTION_ID,
  }));
  assert.ok(a);
  return a;
}

async function assertDrop(s: ReturnType<typeof setup>, a: CommentAction, reason: DropReason) {
  assert.deepEqual(await gate(s.deps, a), { ok: false, reason });
  assert.deepEqual(s.fake.requests.filter((r) => r.method !== 'GET'), [], 'no write request');
  assert.equal(s.logs.at(-1), `drop ${a.id}: ${reason}`);
}

// ── parseWebhook ─────────────────────────────────────────────────────────────

function capturedAction(): Record<string, unknown> {
  const call = load('comments').find((c) => c.path.startsWith('/cards/'))!;
  return structuredClone((call.body as Record<string, unknown>[])[0]!);
}

test('parseWebhook reads the captured comment shape', () => {
  const a = { ...capturedAction(), memberCreator: { id: USER_A.id, username: USER_A.username } };
  assert.deepEqual(parseWebhook({ action: a, model: { id: BOARDS.jobs } }), {
    id: 'fa4e00000000000000000013',
    date: new Date('2026-11-10T22:09:07.518Z'),
    authorId: 'fa4e00000000000000000002',
    author: 'usera',
    text: 'Sample comment: looks like a good fit.',
    cardId: JOB_CARD,
    boardId: BOARDS.jobs,
    listName: 'Nov 9 · 01:00',
  });
});

test('parseWebhook returns null for updateCard and for a body without memberCreator', () => {
  const a: Record<string, unknown> = { ...capturedAction(), memberCreator: { id: USER_A.id, username: USER_A.username } };
  assert.equal(parseWebhook({ action: { ...a, type: 'updateCard' } }), null);
  assert.equal(parseWebhook({ action: capturedAction() }), null);
  const data = a['data'] as Record<string, unknown>;
  for (const key of ['text', 'card', 'board']) {
    const { [key]: _, ...rest } = data;
    assert.equal(parseWebhook({ action: { ...a, data: rest } }), null, `without ${key}`);
  }
  assert.equal(parseWebhook({ action: { ...a, id: 'not-a-trello-id' } }), null);
  assert.equal(parseWebhook({ action: { ...a, date: 'yesterday' } }), null);
  assert.equal(parseWebhook(null), null);
  assert.equal(parseWebhook('{}'), null);
});

// ── mentions / createRecentIds ───────────────────────────────────────────────

test('mentions', () => {
  assert.equal(mentions('@samplebot open', 'samplebot'), true);
  assert.equal(mentions('hi @SampleBot, open?', 'samplebot'), true);
  assert.equal(mentions('please @samplebot', 'samplebot'), true);
  assert.equal(mentions('@samplebot2 open', 'samplebot'), false);
  assert.equal(mentions('email@samplebot.de', 'samplebot'), false);
  assert.equal(mentions('samplebot open', 'samplebot'), false);
});

test('createRecentIds evicts the oldest id', () => {
  const r = createRecentIds(2);
  r.add('a');
  r.add('b');
  r.add('a');
  r.add('c');
  assert.deepEqual(['a', 'b', 'c'].map((x) => r.has(x)), [false, true, true]);
});

// ── gate: one test per drop reason ───────────────────────────────────────────

test('passes a fresh mention from an allowed member and returns Settings and the card comments', async () => {
  const s = setup();
  s.fake.addComment(JOB_CARD, USER_A, 'earlier note', new Date(NOW.getTime() - 60_000));
  const r = await gate(s.deps, action());
  assert.ok(r.ok);
  assert.deepEqual(r.settings.allowed_members, ['usera']);
  assert.deepEqual(r.comments.map((c) => c.text), ['earlier note']);
  assert.deepEqual(s.fake.requests.filter((x) => x.method !== 'GET'), []);
  assert.deepEqual(s.logs, []);
});

test('drops a comment without a mention', async () => {
  const s = setup();
  await assertDrop(s, action({ text: 'open' }), 'no mention');
});

test('drops a comment on a foreign board', async () => {
  const s = setup();
  await assertDrop(s, action({ boardId: 'fa4e0000000000000000c001' }), 'foreign board');
  assert.deepEqual(s.fake.requests, []);
});

test("drops the bot's own comment", async () => {
  const s = setup(['usera', 'samplebot']);
  await assertDrop(s, action({ author: BOT }), 'own comment');
});

test('drops a comment on an Originals card', async () => {
  const s = setup();
  await assertDrop(s, action({ boardId: BOARDS.profiles, cardId: ORIGINALS_CARD, listName: ' originals ' }), 'originals');
});

test('drops an action dated 2 h ago', async () => {
  const s = setup();
  await assertDrop(s, action({ date: new Date(NOW.getTime() - 2 * 3_600_000) }), 'stale');
  assert.equal(ACTION_MAX_AGE_MS, 3_600_000);
});

test('drops the same id the second time, also while the first is still running', async () => {
  const s = setup();
  const first = gate(s.deps, action());
  await assertDrop(s, action(), 'seen');
  assert.ok((await first).ok);
  await assertDrop(s, action(), 'seen');
});

test('drops when the Settings card has broken YAML', async () => {
  const s = setup();
  s.fake.setCardDesc(SETTINGS_CARD, '```yaml\nallowed_members: [usera\n```');
  await assertDrop(s, action(), 'settings unreadable');
});

test('drops an author not in allowed_members', async () => {
  const s = setup();
  await assertDrop(s, action({ author: STRANGER }), 'not allowed');
});

test('an author in allowed_members with other case passes', async () => {
  const s = setup(['UserA']);
  assert.ok((await gate(s.deps, action())).ok);
});

test('drops an action a bot marker on the card already answers (memory empty)', async () => {
  const s = setup();
  s.fake.addComment(JOB_CARD, BOT, `Opened.\n\n${formatMarker({ actionId: ACTION_ID, cls: 'static' })}`);
  await assertDrop(s, action(), 'answered');
});

test('a user comment carrying the marker does not count as answered', async () => {
  const s = setup();
  s.fake.addComment(JOB_CARD, USER_A, `fake\n${formatMarker({ actionId: ACTION_ID, cls: 'static' })}`);
  assert.ok((await gate(s.deps, action())).ok);
});

test('the order holds: a stale action from a stranger on a foreign board is a foreign board', async () => {
  const s = setup();
  const a = action({ boardId: 'fa4e0000000000000000c001', author: STRANGER, date: new Date(NOW.getTime() - 2 * 3_600_000) });
  await assertDrop(s, a, 'foreign board');
});
