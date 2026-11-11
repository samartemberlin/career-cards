import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scopeClient, scopeUserBoards, ScopeError, OriginalsWriteError, isOriginalsName } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { TrelloApi, TCard, TCardWithList, TList, TChecklist, TCheckItem, TBoard, TMember, TLabel } from '../../src/trello/api.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

// --- stub builder --------------------------------------------------------

type CallLog = { method: string; args: unknown[] }[];

function makeCard(overrides: Partial<TCard & { idBoard: string; list?: { id: string; name: string } }> = {}): TCardWithList {
  return {
    id: overrides.id ?? 'card1',
    name: overrides.name ?? 'Test Card',
    desc: '',
    idList: overrides.idList ?? 'list1',
    idBoard: overrides.idBoard ?? 'board1',
    closed: false,
    pos: 0,
    shortUrl: 'https://trello.com/c/sample001',
    list: overrides.list ?? { id: overrides.idList ?? 'list1', name: 'Open' },
  };
}

function makeList(overrides: Partial<TList> = {}): TList {
  return {
    id: overrides.id ?? 'list1',
    name: overrides.name ?? 'Open',
    closed: false,
    pos: 0,
    idBoard: overrides.idBoard ?? 'board1',
  };
}

function makeChecklist(overrides: Partial<TChecklist> = {}): TChecklist {
  return {
    id: overrides.id ?? 'check1',
    name: overrides.name ?? 'Checklist',
    idCard: overrides.idCard ?? 'card1',
    checkItems: [],
  };
}

type StubOpts = {
  cardResult?: () => TCardWithList;
  listResult?: () => TList;
  checklistResult?: () => TChecklist;
};

function makeStub(opts: StubOpts = {}): { api: TrelloApi; log: CallLog } {
  const log: CallLog = [];

  const api: TrelloApi = {
    me: async () => { log.push({ method: 'me', args: [] }); return { id: 'u1', username: 'bot' }; },
    board: async (id) => { log.push({ method: 'board', args: [id] }); return { id, name: 'B', closed: false, idOrganization: null, prefs: { permissionLevel: 'private' } }; },
    boardMembers: async (id) => { log.push({ method: 'boardMembers', args: [id] }); return []; },
    organizationMembers: async (orgId) => { log.push({ method: 'organizationMembers', args: [orgId] }); return []; },
    myOrganizations: async () => { log.push({ method: 'myOrganizations', args: [] }); return []; },
    lists: async (boardId, filter) => { log.push({ method: 'lists', args: [boardId, filter] }); return []; },
    list: async (id) => { log.push({ method: 'list', args: [id] }); return (opts.listResult ?? (() => makeList({ id })))(); },
    cards: async (boardId, o) => { log.push({ method: 'cards', args: [boardId, o] }); return []; },
    allCards: async (boardId) => { log.push({ method: 'allCards', args: [boardId] }); return []; },
    card: async (id) => { log.push({ method: 'card', args: [id] }); return (opts.cardResult ?? (() => makeCard({ id })))(); },
    checklist: async (id) => { log.push({ method: 'checklist', args: [id] }); return (opts.checklistResult ?? (() => makeChecklist({ id })))(); },
    labels: async (boardId) => { log.push({ method: 'labels', args: [boardId] }); return []; },
    createLabel: async (boardId, name, color) => { log.push({ method: 'createLabel', args: [boardId, name, color] }); return { id: 'lbl1', name, color }; },
    createBoard: async (name, idOrg) => { log.push({ method: 'createBoard', args: [name, idOrg] }); return { id: 'brd1', name, closed: false, idOrganization: idOrg, prefs: { permissionLevel: 'private' } }; },
    createList: async (boardId, name, pos) => { log.push({ method: 'createList', args: [boardId, name, pos] }); return makeList({ id: 'lst-new', name, idBoard: boardId }); },
    setListClosed: async (listId, closed) => { log.push({ method: 'setListClosed', args: [listId, closed] }); return makeList({ id: listId }); },
    createCard: async (c) => { log.push({ method: 'createCard', args: [c] }); return { id: 'card-new', name: c.name, desc: c.desc, idList: c.idList, idBoard: 'board1', closed: false, pos: typeof c.pos === 'number' ? c.pos : 0, shortUrl: 'https://trello.com/c/sample001' }; },
    updateCard: async (cardId, update) => { log.push({ method: 'updateCard', args: [cardId, update] }); return { id: cardId, name: update.name ?? '', desc: update.desc ?? '', idList: 'list1', idBoard: 'board1', closed: false, pos: 0, shortUrl: 'https://trello.com/c/sample001' }; },
    setCardClosed: async (cardId, closed) => { log.push({ method: 'setCardClosed', args: [cardId, closed] }); return { id: cardId, name: '', desc: '', idList: 'list1', idBoard: 'board1', closed, pos: 0, shortUrl: 'https://trello.com/c/sample001' }; },
    comment: async (cardId, text) => { log.push({ method: 'comment', args: [cardId, text] }); return { id: 'act1' }; },
    attachText: async (cardId, name, text) => { log.push({ method: 'attachText', args: [cardId, name, text] }); return { id: 'att1' }; },
    createChecklist: async (cardId, name) => { log.push({ method: 'createChecklist', args: [cardId, name] }); return makeChecklist({ idCard: cardId, name }); },
    addCheckItem: async (checklistId, name, checked) => { log.push({ method: 'addCheckItem', args: [checklistId, name, checked] }); return { id: 'ci1', name, state: 'incomplete', pos: 0 }; },
  };

  return { api, log };
}

// --- isOriginalsName tests -----------------------------------------------

test('isOriginalsName: exact match', () => {
  assert.ok(isOriginalsName('Originals'));
});

test('isOriginalsName: case-insensitive', () => {
  assert.ok(isOriginalsName('originals'));
  assert.ok(isOriginalsName('ORIGINALS'));
  assert.ok(isOriginalsName('OrIgInAlS'));
});

test('isOriginalsName: trims whitespace', () => {
  assert.ok(isOriginalsName('  Originals  '));
  assert.ok(isOriginalsName(' ORIGINALS '));
});

test('isOriginalsName: list named " ORIGINALS " counts', () => {
  assert.ok(isOriginalsName(' ORIGINALS '));
});

test('isOriginalsName: other names do not match', () => {
  assert.ok(!isOriginalsName('Open'));
  assert.ok(!isOriginalsName('Jobs'));
  assert.ok(!isOriginalsName('original'));
  assert.ok(!isOriginalsName('Originals2'));
});

// --- scope guard: board calls --------------------------------------------

test('board call outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.board('board-other'), ScopeError);
  assert.equal(log.length, 0, 'no requests should be made before scope check');
});

test('board call inside scope passes through', async () => {
  const { api } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  const result = await scoped.board('board1');
  assert.equal(result.id, 'board1');
});

test('lists outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.lists('board-other', 'open'), ScopeError);
  assert.equal(log.length, 0);
});

test('cards outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.cards('board-other', { filter: 'open' }), ScopeError);
  assert.equal(log.length, 0);
});

test('allCards outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.allCards('board-other'), ScopeError);
  assert.equal(log.length, 0);
});

test('labels outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.labels('board-other'), ScopeError);
  assert.equal(log.length, 0);
});

test('createLabel outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.createLabel('board-other', 'Tag', 'blue'), ScopeError);
  assert.equal(log.length, 0);
});

test('createList outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.createList('board-other', 'New', 'top'), ScopeError);
  assert.equal(log.length, 0);
});

test('boardMembers outside scope throws before any request', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.boardMembers('board-other'), ScopeError);
  assert.equal(log.length, 0);
});

test('createBoard always throws ScopeError', async () => {
  const { api, log } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1', 'board2', 'board3'] });
  await assert.rejects(() => scoped.createBoard('New Board', 'org1'), ScopeError);
  assert.equal(log.length, 0, 'no requests should be made');
});

// --- scope guard: passthrough calls --------------------------------------

test('me passes through', async () => {
  const { api } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  const result = await scoped.me();
  assert.equal(result.username, 'bot');
});

test('myOrganizations passes through', async () => {
  const { api } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  const result = await scoped.myOrganizations();
  assert.deepEqual(result, []);
});

test('organizationMembers passes through', async () => {
  const { api } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  const result = await scoped.organizationMembers('org1');
  assert.deepEqual(result, []);
});

// --- id-addressed reads: card --------------------------------------------

test('reading a card on another board throws ScopeError and returns nothing', async () => {
  const { api, log } = makeStub({
    cardResult: () => makeCard({ id: 'card-other', idBoard: 'board-other' }),
  });
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.card('card-other'), ScopeError);
  // The lookup was made (one call to verify board), but nothing was returned
  assert.equal(log.filter(c => c.method === 'card').length, 1, 'one lookup to check the board');
});

test('reading a card on an in-scope board passes through', async () => {
  const { api } = makeStub({
    cardResult: () => makeCard({ id: 'card1', idBoard: 'board1' }),
  });
  const scoped = scopeClient(api, { boards: ['board1'] });
  const result = await scoped.card('card1');
  assert.equal(result.id, 'card1');
});

test('list outside scope throws ScopeError after lookup', async () => {
  const { api, log } = makeStub({
    listResult: () => makeList({ id: 'list-other', idBoard: 'board-other' }),
  });
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.list('list-other'), ScopeError);
  assert.equal(log.filter(c => c.method === 'list').length, 1);
});

test('checklist outside scope throws ScopeError after lookup of checklist then card', async () => {
  const { api, log } = makeStub({
    checklistResult: () => makeChecklist({ id: 'check-other', idCard: 'card-other' }),
    cardResult: () => makeCard({ id: 'card-other', idBoard: 'board-other' }),
  });
  const scoped = scopeClient(api, { boards: ['board1'] });
  await assert.rejects(() => scoped.checklist('check-other'), ScopeError);
  assert.equal(log.filter(c => c.method === 'checklist').length, 1);
});

// --- write guard: exact one lookup then write ----------------------------

test('write to a Jobs-board card makes exactly one lookup then the write', async () => {
  const { api, log } = makeStub({
    cardResult: () => makeCard({ id: 'card1', idBoard: 'board1', idList: 'list1', list: { id: 'list1', name: 'Open' } }),
  });
  const scoped = scopeClient(api, { boards: ['board1'] });
  await scoped.comment('card1', 'hello');
  const cardLookups = log.filter(c => c.method === 'card');
  const commentCalls = log.filter(c => c.method === 'comment');
  assert.equal(cardLookups.length, 1, 'exactly one fresh lookup');
  assert.equal(commentCalls.length, 1, 'exactly one write');
  assert.ok(log.indexOf(cardLookups[0]!) < log.indexOf(commentCalls[0]!), 'lookup before write');
});

// --- Originals write guard -----------------------------------------------

const PROFILES_BOARD = 'profiles-board';
const JOBS_BOARD = 'board1';

function makeOriginalsCard(): TCardWithList {
  return makeCard({ idBoard: PROFILES_BOARD, idList: 'orig-list', list: { id: 'orig-list', name: 'Originals' } });
}

function makeOriginalsScope(): ReturnType<typeof scopeClient> {
  return scopeClient(
    makeStub({ cardResult: makeOriginalsCard }).api,
    { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD },
  );
}

test('comment on a card in Originals list throws OriginalsWriteError', async () => {
  const scoped = makeOriginalsScope();
  await assert.rejects(() => scoped.comment('card1', 'hello'), OriginalsWriteError);
});

test('setCardClosed on a card in Originals list throws OriginalsWriteError', async () => {
  const scoped = makeOriginalsScope();
  await assert.rejects(() => scoped.setCardClosed('card1', true), OriginalsWriteError);
});

test('attachText on a card in Originals list throws OriginalsWriteError', async () => {
  const scoped = makeOriginalsScope();
  await assert.rejects(() => scoped.attachText('card1', 'notes.md', 'content'), OriginalsWriteError);
});

test('createChecklist on a card in Originals list throws OriginalsWriteError', async () => {
  const scoped = makeOriginalsScope();
  await assert.rejects(() => scoped.createChecklist('card1', 'Tasks'), OriginalsWriteError);
});

test('addCheckItem via checklist in Originals card throws OriginalsWriteError', async () => {
  // The checklist points to a card in Originals
  const { api } = makeStub({
    checklistResult: () => makeChecklist({ id: 'check1', idCard: 'card1' }),
    cardResult: makeOriginalsCard,
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });
  await assert.rejects(() => scoped.addCheckItem('check1', 'Item'), OriginalsWriteError);
});

test('createCard into the Originals list throws OriginalsWriteError', async () => {
  // createCard checks the list it targets
  const { api } = makeStub({
    listResult: () => makeList({ id: 'orig-list', name: 'Originals', idBoard: PROFILES_BOARD }),
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });
  await assert.rejects(
    () => scoped.createCard({ idList: 'orig-list', name: 'New', desc: '', pos: 'bottom' }),
    OriginalsWriteError,
  );
});

test('setListClosed on Originals throws OriginalsWriteError', async () => {
  const { api } = makeStub({
    listResult: () => makeList({ id: 'orig-list', name: 'Originals', idBoard: PROFILES_BOARD }),
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });
  await assert.rejects(() => scoped.setListClosed('orig-list', true), OriginalsWriteError);
});

// --- Originals on Jobs board (not Profiles board) -------------------------

test('a list named Originals on the Jobs board does not trigger OriginalsWriteError', async () => {
  // Originals guard only applies to the Profiles board
  const { api } = makeStub({
    cardResult: () => makeCard({
      id: 'card1',
      idBoard: JOBS_BOARD,
      idList: 'orig-list-jobs',
      list: { id: 'orig-list-jobs', name: 'Originals' },
    }),
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });
  // Should NOT throw OriginalsWriteError — only Profiles board is guarded
  const result = await scoped.comment('card1', 'hello');
  assert.equal(result.id, 'act1');
});

// --- card moved into Originals after being read --------------------------

test('card moved into Originals after it was read: comment throws OriginalsWriteError', async () => {
  // First card() call returns the card in a normal list;
  // second (fresh lookup for comment) returns it in Originals.
  let callCount = 0;
  const { api } = makeStub({
    cardResult: () => {
      callCount++;
      if (callCount === 1) {
        // First read: card is in a normal list
        return makeCard({ id: 'card1', idBoard: PROFILES_BOARD, idList: 'list-normal', list: { id: 'list-normal', name: 'Open' } });
      }
      // Second read (fresh lookup for the write): card moved to Originals
      return makeCard({ id: 'card1', idBoard: PROFILES_BOARD, idList: 'orig-list', list: { id: 'orig-list', name: 'Originals' } });
    },
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });

  // First read: should succeed
  const card = await scoped.card('card1');
  assert.equal(card.list.name, 'Open');

  // Now try to comment: the write guard does a fresh lookup and finds it in Originals
  await assert.rejects(() => scoped.comment('card1', 'hello'), OriginalsWriteError);
});

// --- ScopeError and OriginalsWriteError have expected properties ----------

test('ScopeError has target property', async () => {
  const { api } = makeStub();
  const scoped = scopeClient(api, { boards: ['board1'] });
  try {
    await scoped.board('board-other');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ScopeError);
    assert.equal(err.target, 'board-other');
  }
});

test('OriginalsWriteError has cardId when thrown for a card write', async () => {
  const scoped = makeOriginalsScope();
  try {
    await scoped.comment('card1', 'hello');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof OriginalsWriteError);
    assert.equal(err.cardId, 'card1');
  }
});

test('OriginalsWriteError has listId when thrown for setListClosed', async () => {
  const { api } = makeStub({
    listResult: () => makeList({ id: 'orig-list', name: 'Originals', idBoard: PROFILES_BOARD }),
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, PROFILES_BOARD], profilesBoard: PROFILES_BOARD });
  try {
    await scoped.setListClosed('orig-list', true);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof OriginalsWriteError);
    assert.equal(err.listId, 'orig-list');
  }
});

// --- scopeUserBoards: required profilesBoard entry point -----------------

const SYSTEM_BOARD = 'system-board';

function makeUserBoards(): UserBoards {
  return { jobs: JOBS_BOARD, profiles: PROFILES_BOARD, system: SYSTEM_BOARD };
}

test('scopeUserBoards restricts to the three boards', async () => {
  const { api } = makeStub();
  const scoped = scopeUserBoards(api, makeUserBoards());
  // In-scope boards pass
  await scoped.board(JOBS_BOARD);
  await scoped.board(PROFILES_BOARD);
  await scoped.board(SYSTEM_BOARD);
  // Out-of-scope throws
  await assert.rejects(() => scoped.board('other-board'), ScopeError);
});

test('scopeUserBoards: Originals guard is always active (profilesBoard is required)', async () => {
  const { api } = makeStub({
    cardResult: makeOriginalsCard,
  });
  const scoped = scopeUserBoards(api, makeUserBoards());
  await assert.rejects(() => scoped.comment('card1', 'hello'), OriginalsWriteError);
});

// --- updateCard: restricted to System board Runs list --------------------

test('updateCard succeeds for a card in the System board Runs list', async () => {
  const { api } = makeStub({
    cardResult: () => makeCard({ id: 'card1', idBoard: SYSTEM_BOARD, idList: 'runs-list', list: { id: 'runs-list', name: 'Runs' } }),
  });
  const scoped = scopeClient(api, { boards: [SYSTEM_BOARD], systemBoard: SYSTEM_BOARD });
  const result = await scoped.updateCard('card1', { name: 'running ✅' });
  assert.ok(result.id, 'updateCard returned a card');
});

test('updateCard on a card not in Runs throws ScopeError', async () => {
  const { api } = makeStub({
    cardResult: () => makeCard({ id: 'card1', idBoard: SYSTEM_BOARD, idList: 'config-list', list: { id: 'config-list', name: 'Config' } }),
  });
  const scoped = scopeClient(api, { boards: [SYSTEM_BOARD], systemBoard: SYSTEM_BOARD });
  await assert.rejects(() => scoped.updateCard('card1', { name: 'x' }), ScopeError);
});

test('updateCard on a card outside the System board throws ScopeError', async () => {
  const { api } = makeStub({
    // Card is in JOBS_BOARD, list named Runs — still must be rejected (wrong board)
    cardResult: () => makeCard({ id: 'card1', idBoard: JOBS_BOARD, idList: 'runs-list', list: { id: 'runs-list', name: 'Runs' } }),
  });
  const scoped = scopeClient(api, { boards: [JOBS_BOARD, SYSTEM_BOARD], systemBoard: SYSTEM_BOARD });
  await assert.rejects(() => scoped.updateCard('card1', { name: 'x' }), ScopeError);
});

test('updateCard without systemBoard set always throws ScopeError', async () => {
  const { api } = makeStub({
    cardResult: () => makeCard({ id: 'card1', idBoard: SYSTEM_BOARD, idList: 'runs-list', list: { id: 'runs-list', name: 'Runs' } }),
  });
  // scopeClient without systemBoard
  const scoped = scopeClient(api, { boards: [SYSTEM_BOARD] });
  await assert.rejects(() => scoped.updateCard('card1', { name: 'x' }), ScopeError);
});

// --- updateCard over FakeTrello (integration) ----------------------------

const REC_DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const loadRec = (name: string): Recording =>
  JSON.parse(readFileSync(join(REC_DIR, `${name}.recording.json`), 'utf8')) as Recording;

function firstBoardId(rec: Recording): string {
  return (rec.find((e) => /^\/boards\/[^/]+$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string }).id;
}

function fakeClient(fake: FakeTrello) {
  return createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
}

test('updateCard (scopeUserBoards): passes on a Runs card; throws on a Jobs card; Jobs card unchanged', async () => {
  const sysRec = loadRec('system');
  const jobsRec = loadRec('jobs');
  const profilesRec = loadRec('profiles');
  const fake = FakeTrello.fromRecordings(sysRec, jobsRec, profilesRec);
  const rawApi = fakeClient(fake);

  const boards: UserBoards = {
    system: firstBoardId(sysRec),
    jobs: firstBoardId(jobsRec),
    profiles: firstBoardId(profilesRec),
  };

  // Find a card in the Runs list from the system recording
  const sysLists = (sysRec.find((e) => /\/lists$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; name: string }[]);
  const runsListId = sysLists.find((l) => l.name === 'Runs')!.id;
  const sysCards = (sysRec.find((e) => /\/cards\//.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; idList: string; name: string }[]);
  const runsCard = sysCards.find((c) => c.idList === runsListId)!;

  // Find a Jobs board card
  const jobsCards = (jobsRec.find((e) => /\/cards\//.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; name: string }[]);
  const jobCard = jobsCards[0]!;

  const scoped = scopeUserBoards(rawApi, boards);

  // updateCard on the Runs card succeeds
  const updated = await scoped.updateCard(runsCard.id, { name: '✅ done', desc: 'career-cards-run: done' });
  assert.equal(updated.id, runsCard.id, 'updateCard returned the updated card');

  // updateCard on a Jobs card throws ScopeError; card is unchanged
  await assert.rejects(() => scoped.updateCard(jobCard.id, { name: 'edited' }), ScopeError);
  const jobsAfter = await rawApi.cards(boards.jobs, { filter: 'open' });
  const stillJob = jobsAfter.find((c) => c.id === jobCard.id)!;
  assert.equal(stillJob.name, jobCard.name, 'Jobs card must be unchanged after failed updateCard');
});

test('updateCard: card moved out of Runs between lookup and update throws ScopeError', async () => {
  const sysRec = loadRec('system');
  const jobsRec = loadRec('jobs');
  const profilesRec = loadRec('profiles');
  const fake = FakeTrello.fromRecordings(sysRec, jobsRec, profilesRec);
  const rawApi = fakeClient(fake);

  const boards: UserBoards = {
    system: firstBoardId(sysRec),
    jobs: firstBoardId(jobsRec),
    profiles: firstBoardId(profilesRec),
  };

  const sysLists = (sysRec.find((e) => /\/lists$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; name: string }[]);
  const runsListId = sysLists.find((l) => l.name === 'Runs')!.id;
  const configListId = sysLists.find((l) => l.name !== 'Runs')!.id;

  // Create a new status card in Runs
  const card = await rawApi.createCard({ idList: runsListId, name: '⏳ Nov 11', desc: '', pos: 'top' });

  // Move it out of Runs before the updateCard call
  fake.moveCard(card.id, configListId);

  const scoped = scopeUserBoards(rawApi, boards);
  await assert.rejects(() => scoped.updateCard(card.id, { name: '✅ Nov 11' }), ScopeError);
});

test('updateCard: System board card outside Runs (Settings list) throws ScopeError', async () => {
  const sysRec = loadRec('system');
  const jobsRec = loadRec('jobs');
  const profilesRec = loadRec('profiles');
  const fake = FakeTrello.fromRecordings(sysRec, jobsRec, profilesRec);
  const rawApi = fakeClient(fake);

  const boards: UserBoards = {
    system: firstBoardId(sysRec),
    jobs: firstBoardId(jobsRec),
    profiles: firstBoardId(profilesRec),
  };

  // Find a card in the non-Runs list (Config) on the System board
  const sysLists = (sysRec.find((e) => /\/lists$/.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; name: string }[]);
  const configListId = sysLists.find((l) => l.name !== 'Runs')!.id;
  const sysCards = (sysRec.find((e) => /\/cards\//.test(e.path) && e.method === 'GET' && e.status === 200)!.body as { id: string; idList: string; name: string }[]);
  const configCard = sysCards.find((c) => c.idList === configListId)!;

  const scoped = scopeUserBoards(rawApi, boards);
  await assert.rejects(() => scoped.updateCard(configCard.id, { name: 'edited' }), ScopeError);
});
