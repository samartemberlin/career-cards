import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOnlyClient, DryRunWriteError } from '../../src/trello/read-only.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const REC_DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const loadRec = (name: string): Recording =>
  JSON.parse(readFileSync(join(REC_DIR, `${name}.recording.json`), 'utf8')) as Recording;

function firstBoardId(rec: Recording): string {
  return (rec.find((e) => /^\/boards\/[^/]+$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string }).id;
}

// All write method names from TrelloApi (these must each throw DryRunWriteError)
const WRITE_METHODS = [
  'createBoard',
  'createLabel',
  'createList',
  'setListClosed',
  'createCard',
  'setCardClosed',
  'updateCard',
  'comment',
  'attachText',
  'createChecklist',
  'addCheckItem',
] as const;

test('readOnlyClient: every write method throws DryRunWriteError and FakeTrello sees no request', async () => {
  const fake = FakeTrello.fromRecordings(
    loadRec('jobs'), loadRec('profiles'), loadRec('system'), loadRec('lookups'),
  );
  const rawApi = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const roApi = readOnlyClient(rawApi);

  const jobsBid = firstBoardId(loadRec('jobs'));
  const jobsListId = (() => {
    const rec = loadRec('jobs');
    return (rec.find((e) => /\/lists$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string }[])[0]!.id;
  })();
  const lookupsRec = loadRec('lookups');
  const existingCardId = lookupsRec.find((e) => /^\/cards\/[^/]+$/.test(e.path) && e.method === 'GET' && e.status === 200)!.path.split('/').pop()!;
  const existingChecklistId = lookupsRec.find((e) => /^\/checklists\/[^/]+$/.test(e.path) && e.method === 'GET' && e.status === 200)!.path.split('/').pop()!;
  const existingListId = lookupsRec.find((e) => /^\/lists\/[^/]+$/.test(e.path) && e.method === 'GET' && e.status === 200)!.path.split('/').pop()!;

  const requestsBefore = fake.requests.length;

  // Verify each write throws DryRunWriteError and names the method
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['createBoard', () => roApi.createBoard('Test Board', 'org1')],
    ['createLabel', () => roApi.createLabel(jobsBid, 'Tag', 'blue')],
    ['createList', () => roApi.createList(jobsBid, 'New list', 'bottom')],
    ['setListClosed', () => roApi.setListClosed(existingListId, true)],
    ['createCard', () => roApi.createCard({ idList: jobsListId, name: 'Job', desc: '', pos: 'bottom' })],
    ['setCardClosed', () => roApi.setCardClosed(existingCardId, true)],
    ['updateCard', () => roApi.updateCard(existingCardId, { name: 'edited' })],
    ['comment', () => roApi.comment(existingCardId, 'hello')],
    ['attachText', () => roApi.attachText(existingCardId, 'cv.md', 'content')],
    ['createChecklist', () => roApi.createChecklist(existingCardId, 'Tasks')],
    ['addCheckItem', () => roApi.addCheckItem(existingChecklistId, 'Item 1')],
  ];

  for (const [method, fn] of calls) {
    await assert.rejects(fn, (err: unknown) => {
      assert.ok(err instanceof DryRunWriteError, `${method}: must throw DryRunWriteError, got ${String(err)}`);
      assert.equal(err.method, method, `${method}: DryRunWriteError.method must equal '${method}'`);
      return true;
    });
  }

  assert.equal(fake.requests.length, requestsBefore, 'FakeTrello must receive no requests from write method calls');

  // Verify WRITE_METHODS list is complete (no method added to TrelloApi without updating this test)
  const writeMethods = new Set(WRITE_METHODS);
  for (const [method] of calls) {
    assert.ok(writeMethods.has(method as typeof WRITE_METHODS[number]), `${method} not in WRITE_METHODS`);
  }
});

test('readOnlyClient: reads pass through to FakeTrello', async () => {
  const fake = FakeTrello.fromRecordings(
    loadRec('jobs'), loadRec('profiles'), loadRec('system'), loadRec('lookups'),
  );
  const rawApi = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const roApi = readOnlyClient(rawApi);

  const jobsRec = loadRec('jobs');
  const jobsBid = firstBoardId(jobsRec);

  // A sample of read methods
  const member = await roApi.me();
  assert.ok(member.id, 'me() passes through');

  const board = await roApi.board(jobsBid);
  assert.equal(board.id, jobsBid, 'board() passes through');

  const lists = await roApi.lists(jobsBid, 'open');
  assert.ok(lists.length > 0, 'lists() passes through');

  const cards = await roApi.cards(jobsBid, { filter: 'open' });
  assert.ok(cards.length > 0, 'cards() passes through');
});
