import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeClient, OriginalsWriteError } from '../../src/trello/scoped.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { createLabelResolver, createJobCard, archiveCards } from '../../src/trello/writer.ts';
import type { ScoredJob } from '../../src/trello/writer.ts';
import { parseJobKey, jobCardTitle, parseTitleScore } from '../../src/trello/cards.ts';
import type { TrelloApi, NewCard } from '../../src/trello/api.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function getBoardId(rec: Recording): string {
  const m = /^\/boards\/([^/]+)$/.exec(rec.find((c) => /^\/boards\/[^/]+$/.test(c.path))!.path);
  return m![1]!;
}

/** Fresh FakeTrello + scoped client on the Jobs board. */
function setup() {
  const rec = load('jobs');
  const bid = getBoardId(rec);
  const fake = FakeTrello.fromRecordings(rec);
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeClient(inner, { boards: [bid] });
  return { bid, fake, inner, api };
}

function makeJob(overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    key: 'greenhouse:acme:12345',
    url: 'https://jobs.example.com/12345',
    company: 'Acme Corp',
    title: 'Software Engineer',
    location: 'Berlin',
    jd: 'A great job at Acme Corp.',
    score: 7,
    reason: 'Good match.',
    flags: [],
    ...overrides,
  };
}

const noLog = () => {};

// ── card creation order and key round-trip ────────────────────────────────

test('cards keep creation order', async () => {
  const { bid, api } = setup();
  const list = await api.createList(bid, 'Nov 11 · 01:00', 'top');

  for (const score of [9, 7, 2]) {
    await createJobCard(api, {
      listId: list.id,
      job: makeJob({ key: `test:order-${score}`, score }),
      labelIds: [],
      log: noLog,
    });
  }

  const inList = (await api.cards(bid, { filter: 'open' }))
    .filter((c) => c.idList === list.id)
    .sort((a, b) => a.pos - b.pos);

  assert.deepEqual(inList.map((c) => parseTitleScore(c.name)), [9, 7, 2]);
});

test('created card round-trips its key', async () => {
  const { bid, api } = setup();
  const list = await api.createList(bid, 'Round-Trip Test', 'top');
  const job = makeJob({ key: 'greenhouse:acme:99999', score: 8 });
  const card = await createJobCard(api, { listId: list.id, job, labelIds: [], log: noLog });

  assert.equal(parseJobKey(card.desc), job.key);
  assert.equal(card.name, jobCardTitle(job));
});

// ── label resolver ────────────────────────────────────────────────────────

test('labels are reused, not duplicated', async () => {
  const { bid, api } = setup();
  const resolver = createLabelResolver(api, bid, noLog);
  const labels = [{ name: 'NewCityLabel', color: 'sky' }];

  const ids1 = await resolver(labels);
  const ids2 = await resolver(labels);

  assert.equal(ids1.length, 1);
  assert.deepEqual(ids1, ids2, 'same id returned on second call');

  const boardLabels = await api.labels(bid);
  const matching = boardLabels.filter((l) => l.name === 'NewCityLabel');
  assert.equal(matching.length, 1, 'exactly one label on the board');
});

test('a label failure leaves the card unlabelled, not missing', async () => {
  const { bid, fake, api } = setup();
  const list = await api.createList(bid, 'Label Fail Test', 'top');

  fake.failNext('POST', /\/labels$/, 400);
  const logs: string[] = [];
  const resolver = createLabelResolver(api, bid, (s) => logs.push(s));
  const ids = await resolver([{ name: 'LabelFailTest', color: 'green' }]);

  assert.equal(ids.length, 0, 'no ids on creation failure');
  assert.ok(logs.length > 0, 'failure was logged');

  const card = await createJobCard(api, { listId: list.id, job: makeJob(), labelIds: ids, log: noLog });
  assert.ok(card.id, 'card still created with no labels');
});

// ── date handling ─────────────────────────────────────────────────────────

test('free-text dates are not sent', async () => {
  const { bid, inner, api } = setup();
  const list = await api.createList(bid, 'Date Test', 'top');

  let captured: NewCard | undefined;
  const spy: TrelloApi = { ...inner, createCard: async (c) => { captured = c; return inner.createCard(c); } };
  const spyScoped = scopeClient(spy, { boards: [bid] });

  const job = makeJob({ posted: '2 weeks ago', deadline: 'ASAP' });
  const card = await createJobCard(spyScoped, { listId: list.id, job, labelIds: [], log: noLog });

  assert.ok(card.id, 'card created');
  assert.ok(captured !== undefined, 'createCard was called');
  assert.ok(!('start' in captured!), 'start not sent');
  assert.ok(!('due' in captured!), 'due not sent');
});

// ── JD attachment ─────────────────────────────────────────────────────────

test('long JD is attached; attach failure still returns the card', async () => {
  const { bid, fake, api } = setup();
  const list = await api.createList(bid, 'JD Test', 'top');
  const longJd = 'x'.repeat(20_000);

  // Part 1: long JD is truncated in desc and the full text is attached.
  const job1 = makeJob({ key: 'test:long-jd-1', jd: longJd });
  const card1 = await createJobCard(api, { listId: list.id, job: job1, labelIds: [], log: noLog });
  assert.ok(card1.id, 'card created');
  assert.equal(fake.attachmentsOn(card1.id).length, 1, 'attachment added');

  // Part 2: attach fails — the card is still returned and the failure is logged.
  fake.failNext('POST', /\/attachments$/, 400);
  const logs: string[] = [];
  const job2 = makeJob({ key: 'test:long-jd-2', jd: longJd });
  const card2 = await createJobCard(api, { listId: list.id, job: job2, labelIds: [], log: (s) => logs.push(s) });
  assert.ok(card2.id, 'card returned despite attach failure');
  assert.ok(logs.some((l) => l.includes('attach')), 'attach failure logged');
});

// ── archiving ─────────────────────────────────────────────────────────────

test('archiveCards continues past a failure', async () => {
  const { bid, fake, api } = setup();
  const list = await api.createList(bid, 'Archive Test', 'top');

  const cards = await Promise.all(
    [0, 1, 2].map((i) =>
      createJobCard(api, { listId: list.id, job: makeJob({ key: `test:archive-${i}` }), labelIds: [], log: noLog }),
    ),
  );

  // Fail the first PUT /cards/{id} to simulate a 404 on one card.
  fake.failNext('PUT', /\/cards\//, 404);
  const logs: string[] = [];
  const result = await archiveCards(api, cards, (s) => logs.push(s));

  assert.equal(result.archived, 2);
  assert.equal(result.failed, 1);
  assert.ok(logs.length > 0, 'failure logged');
});

// ── Originals write guard ─────────────────────────────────────────────────

test('writing into Originals throws through the writer', async () => {
  const { bid, inner } = setup();
  // Create a Profiles board with an Originals list using the raw client (scopeClient blocks createBoard).
  const profBoard = await inner.createBoard('Profiles', 'org1');
  const origList = await inner.createList(profBoard.id, 'Originals', 'top');

  const api = scopeClient(inner, { boards: [bid, profBoard.id], profilesBoard: profBoard.id });

  await assert.rejects(
    () => createJobCard(api, { listId: origList.id, job: makeJob(), labelIds: [], log: noLog }),
    OriginalsWriteError,
  );
});
