import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import { HANDLERS, helpText } from '../../src/bot/handlers.ts';
import type { CommandCtx } from '../../src/bot/handlers.ts';
import { CATALOGUE } from '../../src/bot/catalogue.ts';
import type { RunStarter } from '../../src/serve/runs.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const RUNS_LIST = 'fa4e0000000000000000047f';

function setup(starter: RunStarter = { isRunning: async () => false, start: async () => {} }) {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const logs: string[] = [];
  const ctx = {
    api: scopeUserBoards(raw, BOARDS), boards: BOARDS, starter, log: (s: string) => logs.push(s),
  } as unknown as CommandCtx;
  return { fake, raw, ctx, logs };
}

const statusDesc = (iso: string) => `Scanned 9\n\ncareer-cards-run: ${iso} ok`;

test('show_last_run: the top status card in Runs, skipping cards without the contract line', async () => {
  const s = setup();
  await s.raw.createCard({ idList: RUNS_LIST, name: 'older', desc: statusDesc('2026-11-10T00:00:00.000Z'), pos: 'top' });
  const newest = await s.raw.createCard({ idList: RUNS_LIST, name: 'newer', desc: statusDesc('2026-11-11T00:00:00.000Z'), pos: 'top' });
  await s.raw.createCard({ idList: RUNS_LIST, name: 'a note', desc: 'no contract line', pos: 'top' });
  assert.deepEqual(await HANDLERS['show_last_run']!(s.ctx, {}), {
    text: `Last run: newer\n${newest.shortUrl}`,
    links: [newest.shortUrl],
  });
});

test('show_last_run: a Runs list without status cards, or no Runs list → No runs yet.', async () => {
  const s = setup();
  assert.deepEqual(await HANDLERS['show_last_run']!(s.ctx, {}), { text: 'No runs yet.' });
  s.fake.renameList(RUNS_LIST, 'Archive');
  assert.deepEqual(await HANDLERS['show_last_run']!(s.ctx, {}), { text: 'No runs yet.' });
});

test('start_run: the copy for each start result', async () => {
  const cases: [RunStarter, string, number][] = [
    [{ isRunning: async () => false, start: async () => {} }, 'Run started. Its status card will appear on top of System › Runs.', 1],
    [{ isRunning: async () => true, start: async () => {} }, 'A run is already in progress. Its status card will appear when it ends.', 0],
    [{ isRunning: async () => { throw new Error('platform down'); }, start: async () => {} },
      "I couldn't check whether a run is in progress, so I didn't start one. Try again in a few minutes.", 0],
    [{ isRunning: async () => false, start: async () => { throw new Error('no capacity'); } }, "The run couldn't be started. The service log has details.", 1],
  ];
  for (const [inner, text, startCalls] of cases) {
    const calls: string[] = [];
    const starter: RunStarter = { isRunning: () => inner.isRunning(), start: (t) => { calls.push(t); return inner.start(t); } };
    const s = setup(starter);
    assert.deepEqual(await HANDLERS['start_run']!(s.ctx, {}), { text });
    assert.deepEqual(calls, startCalls ? ['manual'] : []);
  }
});

test('helpText: one line per registered action in catalogue order, then yes/no', () => {
  const registered = CATALOGUE.filter((c) => HANDLERS[c.id]);
  const lines = helpText('samplebot').split('\n');
  assert.equal(lines.length, registered.length + 1);
  registered.forEach((c, i) => assert.equal(lines[i], `@samplebot ${c.usage} — ${c.about}`));
  assert.match(lines.at(-1)!, /^@samplebot yes \/ @samplebot no — /);
});
