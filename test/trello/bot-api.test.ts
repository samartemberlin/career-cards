import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import {
  scopeUserBoards, ImmutableCardError, OriginalsWriteError, ScopeError, isGuardError,
} from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { BotApi, TCard, TList } from '../../src/trello/api.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function boardId(rec: Recording): string {
  return /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path)![1]!;
}

function listsOf(rec: Recording): TList[] {
  return rec.find((c) => c.method === 'GET' && /^\/boards\/[^/]+\/lists$/.test(c.path))!.body as TList[];
}

function cardsOf(rec: Recording): TCard[] {
  return rec.find((c) => c.method === 'GET' && /^\/boards\/[^/]+\/cards\/(all|open)$/.test(c.path))!.body as TCard[];
}

function setup() {
  const jobs = load('jobs');
  const profiles = load('profiles');
  const system = load('system');
  const fake = FakeTrello.fromRecordings(jobs, profiles, system);
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const boards: UserBoards = { jobs: boardId(jobs), profiles: boardId(profiles), system: boardId(system) };
  const jobCard = cardsOf(jobs).find((c) => !c.closed)!;
  const originalsList = listsOf(profiles).find((l) => l.name === 'Originals')!;
  const originalsCard = cardsOf(profiles).find((c) => c.idList === originalsList.id)!;
  const runsList = listsOf(system).find((l) => l.name === 'Runs')!;
  return { fake, raw, boards, jobCard, originalsCard, runsList, api: scopeUserBoards(raw, boards) };
}

const writes = (fake: FakeTrello) => fake.requests.filter((r) => r.method !== 'GET');

test('scopeUserBoards exposes no unarchive, checklist or list-close method', () => {
  const { api } = setup();
  for (const m of ['setCardClosed', 'setListClosed', 'createChecklist', 'addCheckItem', 'createBoard']) {
    assert.equal(m in api, false, `${m} must not be on BotApi`);
  }
});

test('archiveCard archives and cannot unarchive', async () => {
  const { api, jobCard } = setup();
  await api.archiveCard(jobCard.id);
  assert.equal((await api.card(jobCard.id)).closed, true);

  // Never called: the type check is the guard.
  function _unarchive(a: BotApi, id: string) {
    // @ts-expect-error BotApi has no setCardClosed
    return a.setCardClosed(id, false);
  }
  void _unarchive;
});

test('attachText on a card this client created passes', async () => {
  const { api, fake, runsList } = setup();
  const card = await api.createCard({ idList: runsList.id, name: 'new', desc: '', pos: 'bottom' });
  await api.attachText(card.id, 'jd.md', 'text');
  assert.deepEqual(fake.attachmentsOn(card.id), ['jd.md']);
});

test('attachText on an existing job card throws ImmutableCardError, and FakeTrello records no POST …/attachments', async () => {
  const { api, fake, jobCard } = setup();
  await assert.rejects(api.attachText(jobCard.id, 'jd.md', 'text'), (e: unknown) => {
    assert.ok(e instanceof ImmutableCardError);
    assert.equal(e.cardId, jobCard.id);
    assert.ok(isGuardError(e));
    return true;
  });
  assert.equal(fake.requests.some((r) => r.method === 'POST' && /\/attachments$/.test(r.path)), false);
  assert.deepEqual(fake.attachmentsOn(jobCard.id), []);
});

test('attachText on a status card created by another client instance throws', async () => {
  const { api, raw, boards, fake, runsList } = setup();
  const status = await api.createCard({ idList: runsList.id, name: 'status', desc: '', pos: 'top' });
  const other = scopeUserBoards(raw, boards);
  await assert.rejects(other.attachText(status.id, 'log.md', 'text'), ImmutableCardError);
  assert.deepEqual(fake.attachmentsOn(status.id), []);
});

test('archiveCard on an Originals card throws OriginalsWriteError', async () => {
  const { api, fake, originalsCard } = setup();
  const before = writes(fake).length;
  await assert.rejects(api.archiveCard(originalsCard.id), OriginalsWriteError);
  assert.equal(writes(fake).length, before);
  assert.equal((await api.card(originalsCard.id)).closed, false);
});

test('archiveCard on a card of another board throws ScopeError before any write', async () => {
  const { api, raw, fake } = setup();
  const foreign = await raw.createBoard('Elsewhere', 'org1');
  const list = await raw.createList(foreign.id, 'L', 'top');
  const card = await raw.createCard({ idList: list.id, name: 'x', desc: '', pos: 'top' });
  const before = writes(fake).length;
  await assert.rejects(api.archiveCard(card.id), ScopeError);
  assert.equal(writes(fake).length, before);
  assert.equal((await raw.card(card.id)).closed, false);
});
