import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { replayFetch } from './replay.ts';
import { FakeTrello } from './fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function client(fetchImpl: typeof fetch) {
  return createTrelloClient({ key: 'k', token: 't', fetchImpl, sleep: async () => {} });
}

function sortById<T extends { id: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function boardId(rec: Recording): string {
  const m = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path);
  return m![1]!;
}

// ── mirrors every captured GET ──────────────────────────────────────────────

test('mirrors every captured GET', async () => {
  const recs = {
    jobs: load('jobs'),
    profiles: load('profiles'),
    system: load('system'),
    lookups: load('lookups'),
  };
  const fake = FakeTrello.fromRecordings(...Object.values(recs));
  const fakeApi = client(fake.fetch);

  // jobs board: board, boardMembers, lists, labels, allCards
  {
    const rec = recs.jobs;
    const replay = client(replayFetch(rec));
    const bid = boardId(rec);
    assert.deepEqual(await fakeApi.board(bid), await replay.board(bid), 'jobs board');
    assert.deepEqual(sortById(await fakeApi.boardMembers(bid)), sortById(await replay.boardMembers(bid)), 'jobs boardMembers');
    assert.deepEqual(sortById(await fakeApi.lists(bid, 'all')), sortById(await replay.lists(bid, 'all')), 'jobs lists');
    assert.deepEqual(sortById(await fakeApi.labels(bid)), sortById(await replay.labels(bid)), 'jobs labels');
    assert.deepEqual(sortById(await fakeApi.allCards(bid)), sortById(await replay.allCards(bid)), 'jobs allCards');
  }

  // profiles board: board, boardMembers, lists, cards (with checklists)
  {
    const rec = recs.profiles;
    const replay = client(replayFetch(rec));
    const bid = boardId(rec);
    assert.deepEqual(await fakeApi.board(bid), await replay.board(bid), 'profiles board');
    assert.deepEqual(sortById(await fakeApi.boardMembers(bid)), sortById(await replay.boardMembers(bid)), 'profiles boardMembers');
    assert.deepEqual(sortById(await fakeApi.lists(bid, 'all')), sortById(await replay.lists(bid, 'all')), 'profiles lists');
    // profiles uses cards/open with checklists=all
    const fakeCards = sortById(await fakeApi.cards(bid, { filter: 'open', checklists: true }));
    const replayCards = sortById(await replay.cards(bid, { filter: 'open', checklists: true }));
    assert.deepEqual(fakeCards, replayCards, 'profiles cards/open with checklists');
  }

  // system board: board, boardMembers, lists, cards (with checklists)
  {
    const rec = recs.system;
    const replay = client(replayFetch(rec));
    const bid = boardId(rec);
    assert.deepEqual(await fakeApi.board(bid), await replay.board(bid), 'system board');
    assert.deepEqual(sortById(await fakeApi.boardMembers(bid)), sortById(await replay.boardMembers(bid)), 'system boardMembers');
    assert.deepEqual(sortById(await fakeApi.lists(bid, 'all')), sortById(await replay.lists(bid, 'all')), 'system lists');
    const fakeCards = sortById(await fakeApi.cards(bid, { filter: 'open', checklists: true }));
    const replayCards = sortById(await replay.cards(bid, { filter: 'open', checklists: true }));
    assert.deepEqual(fakeCards, replayCards, 'system cards/open with checklists');
  }

  // lookups: individual card, list, checklist lookups
  {
    const rec = recs.lookups;
    const replay = client(replayFetch(rec));

    for (const c of rec.filter((x) => x.method === 'GET' && x.status === 200 && /^\/cards\//.test(x.path))) {
      const id = c.path.split('/').pop()!;
      assert.deepEqual(await fakeApi.card(id), await replay.card(id), `card ${id}`);
    }
    for (const c of rec.filter((x) => x.method === 'GET' && x.status === 200 && /^\/lists\//.test(x.path))) {
      const id = c.path.split('/').pop()!;
      assert.deepEqual(await fakeApi.list(id), await replay.list(id), `list ${id}`);
    }
    for (const c of rec.filter((x) => x.method === 'GET' && x.status === 200 && /^\/checklists\//.test(x.path))) {
      const id = c.path.split('/').pop()!;
      assert.deepEqual(await fakeApi.checklist(id), await replay.checklist(id), `checklist ${id}`);
    }
  }

  // 404 for unknown card
  {
    const rec = recs.lookups;
    const replay = client(replayFetch(rec));
    const missing = rec.find((c) => c.status === 404)!;
    const id = missing.path.split('/').pop()!;
    await assert.rejects(fakeApi.card(id), (e: { status?: number }) => e.status === 404);
    await assert.rejects(replay.card(id), (e: { status?: number }) => e.status === 404);
  }
});

// ── write responses have the captured shape ──────────────────────────────────

test('write responses have the captured shape', async () => {
  // Seed with enough state so every write can succeed.
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'), load('lookups'));
  const writes = load('writes');

  for (const w of writes) {
    const url = new URL(`https://api.trello.com/1${w.path}`);
    const init: RequestInit = {
      method: w.method,
      headers: { authorization: 'OAuth oauth_consumer_key="k", oauth_token="t"', accept: 'application/json' },
    };

    // For POST to /cards and /lists and /labels and /checklists, build a minimal body.
    // We test the shape (key set), not the values.
    if (w.path === '/cards') {
      // Pick an existing list from the jobs board.
      const jobsRec = load('jobs');
      const bid = boardId(jobsRec);
      const lists = JSON.parse(readFileSync(join(DIR, 'jobs.recording.json'), 'utf8')) as Recording;
      const listsEntry = lists.find((c) => c.path === `/boards/${bid}/lists`);
      const listId = (listsEntry!.body as { id: string }[])[0]!.id;
      url.pathname = '/1/cards';
      init.body = JSON.stringify({ idList: listId, name: 'Test', desc: '', pos: 'bottom' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
    } else if (/^\/cards\/[^/]+\/actions\/comments$/.test(w.path)) {
      init.body = JSON.stringify({ text: 'test comment' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = `/1${w.path}`;
    } else if (/^\/cards\/[^/]+\/attachments$/.test(w.path)) {
      const form = new FormData();
      form.set('name', 'test.md');
      form.set('mimeType', 'text/markdown');
      form.set('file', new Blob(['content'], { type: 'text/markdown' }), 'test.md');
      init.body = form;
      url.pathname = `/1${w.path}`;
    } else if (/^\/cards\/[^/]+$/.test(w.path) && w.method === 'PUT') {
      init.body = JSON.stringify({ closed: true });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = `/1${w.path}`;
    } else if (w.path === '/lists') {
      const jobsRec = load('jobs');
      const bid = boardId(jobsRec);
      init.body = JSON.stringify({ idBoard: bid, name: 'New list', pos: 'bottom' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = '/1/lists';
    } else if (/^\/lists\/[^/]+\/closed$/.test(w.path)) {
      const listId = w.path.split('/')[2]!;
      init.body = JSON.stringify({ value: true });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = `/1${w.path}`;
    } else if (w.path === '/labels') {
      const jobsRec = load('jobs');
      const bid = boardId(jobsRec);
      init.body = JSON.stringify({ idBoard: bid, name: 'Test label', color: 'blue' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = '/1/labels';
    } else if (w.path === '/checklists') {
      const lookups = load('lookups');
      const cardId = lookups.find((c) => c.method === 'GET' && /^\/cards\//.test(c.path) && c.status === 200)!.path.split('/').pop()!;
      init.body = JSON.stringify({ idCard: cardId, name: 'Test checklist' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = '/1/checklists';
    } else if (/^\/checklists\/[^/]+\/checkItems$/.test(w.path)) {
      init.body = JSON.stringify({ name: 'Test item' });
      init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' };
      url.pathname = `/1${w.path}`;
    } else {
      continue;
    }

    const res = await fake.fetch(url, init);
    assert.equal(res.status, 200, `${w.method} ${w.path} should succeed`);
    const fakeBody = await res.json() as Record<string, unknown>;
    const capturedBody = w.body as Record<string, unknown>;
    const fakeKeys = new Set(Object.keys(fakeBody));
    const capturedKeys = new Set(Object.keys(capturedBody));
    assert.deepEqual(
      [...fakeKeys].sort(),
      [...capturedKeys].sort(),
      `${w.method} ${w.path}: key sets differ`,
    );
  }
});

// ── pages 2,500 added cards like Trello ─────────────────────────────────────

test('pages 2,500 added cards like Trello', async () => {
  const jobsRec = load('jobs');
  const fake = FakeTrello.fromRecordings(jobsRec);

  const bid = boardId(jobsRec);
  // jobsRec has 1062 cards; add 2500 more → 3562 total
  const listId = (jobsRec.find((c) => /^\/boards\/[^/]+\/lists$/.test(c.path))!.body as { id: string }[])[0]!.id;
  fake.addCards(listId, 2500, (i) => ({ name: `Added card ${i}`, desc: `desc ${i}` }));

  let reqCount = 0;
  const counting: typeof fetch = async (url, init) => {
    if (new URL(url as URL | string).pathname.endsWith('/cards/all')) reqCount++;
    return fake.fetch(url, init);
  };
  const api = client(counting);
  const cards = await api.allCards(bid);

  assert.equal(cards.length, 3562, 'total card count after adding 2500');
  assert.equal(reqCount, 4, 'exactly 4 paging requests');
});

// ── a card in an archived list comes back from cards/open ───────────────────

test('a card in an archived list comes back from cards/open', async () => {
  const jobsRec = load('jobs');
  const fake = FakeTrello.fromRecordings(jobsRec);
  const api = client(fake.fetch);

  const bid = boardId(jobsRec);
  const lists = await api.lists(bid, 'all');
  const closedList = lists.find((l) => l.closed)!;
  assert.ok(closedList, 'jobs board has a closed list');

  // cards/open should include open cards even when their list is archived
  const openCards = await api.cards(bid, { filter: 'open' });
  const inClosedList = openCards.filter((c) => c.idList === closedList.id);
  assert.ok(inClosedList.length > 0, 'open cards in a closed list must appear in cards/open');
});

// ── failNext retries correctly through the real client ──────────────────────

test('failNext(…, 429, 2) then success', async () => {
  const jobsRec = load('jobs');
  const fake = FakeTrello.fromRecordings(jobsRec, load('lookups'));

  // Pick a card id that exists in the lookups recording (cards endpoint)
  const lookups = load('lookups');
  const cardId = lookups.find(
    (c) => c.method === 'GET' && /^\/cards\//.test(c.path) && c.status === 200,
  )!.path.split('/').pop()!;

  // The first 2 POSTs to .../actions/comments will return 429
  fake.failNext('POST', /\/actions\/comments$/, 429, 2);

  const sleeps: number[] = [];
  const api = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl: fake.fetch,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
  });

  const result = await api.comment(cardId, 'hello');
  assert.ok(typeof result.id === 'string', 'comment returns an id');
  assert.equal(sleeps.length, 2, 'two backoff sleeps for the two 429s');
  assert.deepEqual(sleeps, [2000, 4000]);

  // Three POST requests in total (2 failed + 1 succeeded)
  const commentRequests = fake.requests.filter(
    (r) => r.method === 'POST' && r.path.endsWith('/actions/comments'),
  );
  assert.equal(commentRequests.length, 3);
});
