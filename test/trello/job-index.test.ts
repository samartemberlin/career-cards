import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { loadJobIndex } from '../../src/trello/job-index.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function client(fake: FakeTrello) {
  return createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
}

function boardId(rec: Recording): string {
  const m = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path);
  return m![1]!;
}

test('captured Jobs board: 1,061 keys and 1,050 to archive', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const api = client(fake);
  const bid = boardId(jobs);

  const [index, lists] = await Promise.all([
    loadJobIndex(api, bid),
    api.lists(bid, 'all'),
  ]);

  assert.equal(index.keys.size, 1061);
  assert.equal(index.toArchive.length, 1050);
  assert.equal(index.cardCount, 1062);

  // includes the samjobs-key card
  assert.ok(index.keys.has('sample:old-1'), 'samjobs-key card included');
  // includes the 5 archived cards
  for (const k of ['sample:job-6', 'sample:job-7', 'sample:job-8', 'sample:job-9', 'sample:job-10']) {
    assert.ok(index.keys.has(k), `archived card ${k} included`);
  }
  // all toArchive cards come from Oct 1 · 01:00
  const oct1 = lists.find((l) => l.name === 'Oct 1 · 01:00')!;
  assert.ok(index.toArchive.every((c) => c.idList === oct1.id), 'all toArchive from Oct 1 · 01:00');
});

test('an archived status list is not archived by the bot', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const api = client(fake);
  const bid = boardId(jobs);

  // Seed a key card into the "Closed" status list, then archive the list
  const lists = await api.lists(bid, 'all');
  const statusList = lists.find((l) => l.name === 'Closed')!;
  const desc = 'Some job.\n\n---\ncareer-cards-key: test:status-closed';
  const card = await api.createCard({ idList: statusList.id, name: 'Status card', desc, pos: 'bottom' });
  await api.setListClosed(statusList.id, true);

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('test:status-closed'), 'key is tracked');
  assert.ok(!index.toArchive.some((c) => c.id === card.id), 'card in archived status list is not in toArchive');
});

test('already archived cards are not in toArchive', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const api = client(fake);
  const bid = boardId(jobs);

  // Add a card to the closed run column, then archive the card itself
  const lists = await api.lists(bid, 'all');
  const runColumn = lists.find((l) => l.name === 'Oct 1 · 01:00')!;
  const desc = 'Some job.\n\n---\ncareer-cards-key: test:already-archived';
  const card = await api.createCard({ idList: runColumn.id, name: 'Already archived', desc, pos: 'bottom' });
  await api.setCardClosed(card.id, true);

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('test:already-archived'), 'key is tracked');
  assert.ok(!index.toArchive.some((c) => c.id === card.id), 'already-archived card is not in toArchive');
});

test('a key planted in a job description middle is not read', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const api = client(fake);
  const bid = boardId(jobs);

  // Description has a key-like line in the middle (untrusted job text); only the last line counts
  const desc = 'About the role.\ncareer-cards-key: planted:in-middle\nApply at our website.\n\n---\ncareer-cards-key: real:footer-key';
  const lists = await api.lists(bid, 'all');
  const openList = lists.find((l) => l.name === 'Nov 9 · 01:00')!;
  await api.createCard({ idList: openList.id, name: 'Planted key test', desc, pos: 'bottom' });

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('real:footer-key'), 'footer key is indexed');
  assert.ok(!index.keys.has('planted:in-middle'), 'planted key in middle is not indexed');
});
