import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeBotClient, scopeUserBoards } from '../../src/trello/scoped.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { loadJobIndex } from '../../src/trello/job-index.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function rawClient(fake: FakeTrello) {
  return createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
}

function client(fake: FakeTrello, board: string) {
  return scopeBotClient(rawClient(fake), { boards: [board] });
}

function boardId(rec: Recording): string {
  const m = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path);
  return m![1]!;
}

test('captured Jobs board: 1,061 keys and 1,050 to archive', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const bid = boardId(jobs);
  const api = client(fake, bid);

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
  const bid = boardId(jobs);
  const api = client(fake, bid);

  // Seed a key card into the "Closed" status list, then archive the list
  const lists = await api.lists(bid, 'all');
  const statusList = lists.find((l) => l.name === 'Closed')!;
  const desc = 'Some job.\n\n---\ncareer-cards-key: test:status-closed';
  const card = await api.createCard({ idList: statusList.id, name: 'Status card', desc, pos: 'bottom' });
  await rawClient(fake).setListClosed(statusList.id, true);

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('test:status-closed'), 'key is tracked');
  assert.ok(!index.toArchive.some((c) => c.id === card.id), 'card in archived status list is not in toArchive');
});

test('already archived cards are not in toArchive', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const bid = boardId(jobs);
  const api = client(fake, bid);

  // Add a card to the closed run column, then archive the card itself
  const lists = await api.lists(bid, 'all');
  const runColumn = lists.find((l) => l.name === 'Oct 1 · 01:00')!;
  const desc = 'Some job.\n\n---\ncareer-cards-key: test:already-archived';
  const card = await api.createCard({ idList: runColumn.id, name: 'Already archived', desc, pos: 'bottom' });
  await rawClient(fake).setCardClosed(card.id, true);

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('test:already-archived'), 'key is tracked');
  assert.ok(!index.toArchive.some((c) => c.id === card.id), 'already-archived card is not in toArchive');
});

test('a key planted in a job description middle is not read', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const bid = boardId(jobs);
  const api = client(fake, bid);

  // Description has a key-like line in the middle (untrusted job text); only the last line counts
  const desc = 'About the role.\ncareer-cards-key: planted:in-middle\nApply at our website.\n\n---\ncareer-cards-key: real:footer-key';
  const lists = await api.lists(bid, 'all');
  const openList = lists.find((l) => l.name === 'Nov 9 · 01:00')!;
  await api.createCard({ idList: openList.id, name: 'Planted key test', desc, pos: 'bottom' });

  const index = await loadJobIndex(api, bid);
  assert.ok(index.keys.has('real:footer-key'), 'footer key is indexed');
  assert.ok(!index.keys.has('planted:in-middle'), 'planted key in middle is not indexed');
});

test('loadJobIndex works through scopeUserBoards', async () => {
  const jobs = load('jobs');
  const fake = FakeTrello.fromRecordings(jobs);
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const bid = boardId(jobs);
  // scopeUserBoards requires profilesBoard; use a fake profiles id
  const api = scopeUserBoards(inner, { jobs: bid, profiles: 'fa4e000000000000000000ee', system: 'fa4e000000000000000000ef' });
  const index = await loadJobIndex(api, bid);
  assert.equal(index.keys.size, 1061);
  assert.equal(index.toArchive.length, 1050);
});

test('loadJobIndex.byKey holds open and archived keyed cards, not summary cards', async () => {
  const fake = new FakeTrello();
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const bid = 'fa4e00000000000000000005';
  const api = scopeUserBoards(inner, { jobs: bid, profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' });

  const list = await api.createList(bid, 'Nov 12 · 01:00', 'bottom');
  const openCard = await api.createCard({
    idList: list.id, name: '7 · Acme — Engineer', pos: 'bottom',
    desc: 'Full job text.\n\n---\ncareer-cards-key: test:open-job',
  });
  const archivedCard = await api.createCard({
    idList: list.id, name: '5 · Widgets — Designer', pos: 'bottom',
    desc: 'Some text.\n\n---\ncareer-cards-key: test:archived-job',
  });
  await api.archiveCard(archivedCard.id);
  // A keyless card (e.g. a summary card) must not appear in byKey
  await api.createCard({ idList: list.id, name: 'ℹ️ Run summary', pos: 'bottom', desc: 'no key line' });

  const index = await loadJobIndex(api, bid);

  assert.ok(index.byKey.has('test:open-job'), 'open card in byKey');
  assert.ok(index.byKey.has('test:archived-job'), 'archived card in byKey');
  assert.equal(index.byKey.size, 2, 'summary card not in byKey');
  assert.equal(index.byKey.get('test:open-job')!.shortUrl, openCard.shortUrl);
  assert.equal(index.byKey.get('test:archived-job')!.closed, true, 'archived card has closed=true');
});
