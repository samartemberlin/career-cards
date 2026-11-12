import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { replayFetch } from '../support/replay.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const load = (name: string): Recording => JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;
const client = (rec: Recording) => createTrelloClient({ key: 'k', token: 't', fetchImpl: replayFetch(rec), sleep: async () => {} });

test('all six recordings are present', () => {
  assert.deepEqual(files.sort(), ['comments', 'jobs', 'lookups', 'profiles', 'system', 'writes'].map((n) => `${n}.recording.json`));
});

test('fixtures hold no real ids', () => {
  for (const f of files) {
    const ids = readFileSync(join(DIR, f), 'utf8').match(/\b[0-9a-f]{24}\b/g) ?? [];
    for (const id of ids) assert.ok(id.startsWith('fa4e'), `${f}: ${id}`);
  }
});

test('fixtures hold no credentials or links to real boards', () => {
  for (const f of files) {
    const text = readFileSync(join(DIR, f), 'utf8');
    const rec = JSON.parse(text) as Recording;
    for (const c of rec) {
      assert.ok(!('key' in c.query) && !('token' in c.query), `${f}: ${c.method} ${c.path}`);
    }
    assert.doesNotMatch(text, /oauth/i, f);
    for (const url of text.match(/trello\.com\/[^"\s)]*/g) ?? []) {
      assert.match(url, /^trello\.com\/c\/sample\d+$/, `${f}: ${url}`);
    }
    assert.doesNotMatch(text, /https?:\/\/(?!trello\.com\/c\/sample|(?:jobs\.)?example\.com)/, f);
    // The only addresses are the made-up person's, on the Personal details checklist.
    for (const m of text.matchAll(/[^\s"]*@[^\s"]*/g)) assert.equal(m[0], 'alex.example@example.com', `${f}: ${m[0]}`);
  }
});

test('client replays the Jobs board', async () => {
  const rec = load('jobs');
  const boardId = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path)![1]!;
  const api = client(rec);
  const cards = await api.allCards(boardId);
  assert.equal(cards.length, 1062);
  assert.equal(rec.filter((c) => c.path.endsWith('/cards/all')).length, 2);
  const lists = await api.lists(boardId, 'all');
  const closedLists = new Set(lists.filter((l) => l.closed).map((l) => l.id));
  assert.equal(cards.filter((c) => closedLists.has(c.idList)).length, 1050);
  assert.equal(cards.filter((c) => c.closed).length, 5);
  assert.equal((await api.board(boardId)).prefs.permissionLevel, 'private');
  assert.deepEqual((await api.boardMembers(boardId)).map((m) => m.username), ['samplebot']);
});

test('client reads the archived-list lookup', async () => {
  const jobs = load('jobs');
  const boardId = /^\/boards\/([^/]+)$/.exec(jobs.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path)![1]!;
  const jobsApi = client(jobs);
  const oldRun = (await jobsApi.lists(boardId, 'all')).find((l) => l.name === 'Oct 1 · 01:00')!;
  const lookups = client(load('lookups'));
  const archivedCard = load('lookups').find((c) => (c.body as { idList?: string } | null)?.idList === oldRun.id)!;
  const card = await lookups.card(archivedCard.path.split('/').pop()!);
  assert.equal(card.list.name, 'Oct 1 · 01:00');
});

test('lookups hold one 404 for a card that does not exist', async () => {
  const rec = load('lookups');
  const missing = rec.filter((c) => c.status === 404);
  assert.equal(missing.length, 1);
  await assert.rejects(client(rec).card(missing[0]!.path.split('/').pop()!), (e: { status?: number }) => e.status === 404);
});

test('the Profiles and System boards replay with their checklists', async () => {
  for (const [name, checklist] of [['profiles', 'Personal details'], ['system', 'Add']] as const) {
    const rec = load(name);
    const boardId = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path)![1]!;
    const cards = await client(rec).cards(boardId, { filter: 'open', checklists: true });
    assert.ok(cards.some((c) => c.checklists?.some((cl) => cl.name === checklist)), name);
  }
});

test('writes hold one response of each kind', () => {
  const rec = load('writes');
  assert.equal(rec.length, 9);
  assert.ok(rec.every((c) => c.status === 200 && c.method !== 'GET'));
});
