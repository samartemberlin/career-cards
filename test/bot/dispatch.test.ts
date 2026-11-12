import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { TMember } from '../../src/trello/api.ts';
import { createRecentIds, parseWebhook } from '../../src/serve/gate.ts';
import type { CommentAction } from '../../src/serve/gate.ts';
import { handleComment } from '../../src/bot/dispatch.ts';
import type { DispatchDeps } from '../../src/bot/dispatch.ts';
import { HANDLERS } from '../../src/bot/handlers.ts';
import type { Handler } from '../../src/bot/handlers.ts';
import { formatMarker, parseMarker } from '../../src/bot/marker.ts';
import type { ReplyMarker } from '../../src/bot/marker.ts';
import { proposal } from '../../src/bot/confirm.ts';
import { loadUsage } from '../../src/bot/caps.ts';
import type { RunTrigger } from '../../src/run/stats.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { commentWebhook } from '../support/webhook.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const JOB_CARD = 'fa4e00000000000000000012';
const SETTINGS_CARD = 'fa4e00000000000000000476';
const PERSONAL_DETAILS_CARD = 'fa4e00000000000000000444';
const RUNS_LIST = 'fa4e0000000000000000047f';
const USER_A: TMember = { id: 'fa4e0000000000000000a001', username: 'usera' };
const NOW = new Date('2026-11-12T12:00:00.000Z');
const SECRET = 'tok-sample-secret-0123456789';

let nextId = 0xb000;
const newId = () => `fa4e${(nextId++).toString(16).padStart(20, '0')}`;

function setup() {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  fake.setNow(NOW);
  fake.setCardDesc(SETTINGS_CARD, '```yaml\nproviders: [claude]\nlocations: [berlin]\nallowed_members: [usera]\n```');
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeUserBoards(raw, BOARDS);
  const logs: string[] = [];
  const starts: RunTrigger[] = [];
  const starter = { running: false, isRunning: async () => starter.running, start: async (t: RunTrigger) => { starts.push(t); } };
  const deps: DispatchDeps = {
    api, boards: BOARDS, me: { id: '', username: '' }, seen: createRecentIds(), now: () => NOW, log: (s) => logs.push(s),
    starter,
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'unknown', reason: 'test' }) },
    env: { TRELLO_TOKEN: SECRET },
  };
  return { fake, raw, api, deps, logs, starts, starter };
}

type S = ReturnType<typeof setup>;

async function ready(s: S): Promise<S> {
  s.deps.me = await s.api.me();
  return s;
}

function action(text: string, o: { id?: string; cardId?: string } = {}): CommentAction {
  const a = parseWebhook(commentWebhook({
    cardId: o.cardId ?? JOB_CARD, boardId: BOARDS.jobs, listName: 'Nov 9 · 01:00', author: USER_A, text,
    date: new Date(NOW.getTime() - 60_000).toISOString(), id: o.id ?? newId(),
  }));
  assert.ok(a);
  return a;
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const body = (c: string) => unescape(c.split('\n').filter((l) => !l.startsWith('career-cards-reply:')).join('\n').trim());
const markerOf = (c: string): ReplyMarker => parseMarker(c)!;

async function say(s: S, text: string, o: { id?: string } = {}) {
  const before = s.fake.commentsOn(JOB_CARD).length;
  const a = action(text, o);
  await handleComment(s.deps, a);
  return { a, posted: s.fake.commentsOn(JOB_CARD).slice(before) };
}

function propose(s: S, askId: string) {
  const p = proposal({ id: 'start_run', args: {} }, new Date(NOW.getTime() - 10 * 60_000));
  s.fake.addComment(JOB_CARD, s.deps.me, `Start a run?\n\n${formatMarker({ actionId: askId, cls: 'static', proposal: p })}`,
    new Date(NOW.getTime() - 10 * 60_000));
}

function withHandler(id: string, h: Handler) {
  const old = HANDLERS[id];
  HANDLERS[id] = h;
  return () => { HANDLERS[id] = old; };
}

test('@samplebot help → one comment mentioning @usera, listing last and run, marker class static', async () => {
  const s = await ready(setup());
  const { a, posted } = await say(s, '@samplebot help');
  assert.equal(posted.length, 1);
  const text = body(posted[0]!);
  assert.match(text, /^@usera /);
  assert.match(text, /@samplebot last — /);
  assert.match(text, /@samplebot run — /);
  assert.match(text, /@samplebot yes \/ @samplebot no — /);
  assert.deepEqual(markerOf(posted[0]!), { actionId: a.id, cls: 'static' });
});

test('@samplebot last → the newest status card\'s title and link', async () => {
  const s = await ready(setup());
  for (const [name, iso] of [['✅ Nov 10 · 01:00 · scheduled · +3 cards', '2026-11-10T00:00:00.000Z'], ['✅ Nov 11 · 01:00 · scheduled · +4 cards', '2026-11-11T00:00:00.000Z']]) {
    await s.raw.createCard({ idList: RUNS_LIST, name: name!, desc: `Scanned 9\n\ncareer-cards-run: ${iso} ok`, pos: 'top' });
  }
  const top = await s.raw.createCard({ idList: RUNS_LIST, name: 'not a status card', desc: 'notes', pos: 'top' });
  assert.ok(top);
  const { posted } = await say(s, '@samplebot last');
  assert.equal(posted.length, 1);
  const text = body(posted[0]!);
  assert.match(text, /Last run: ✅ Nov 11 · 01:00 · scheduled · \+4 cards/);
  assert.match(text, /link 1: <https:\/\/trello\.com\/c\//);
  assert.doesNotMatch(text, /link removed/);
});

test('@samplebot last with no Runs list → No runs yet.', async () => {
  const s = await ready(setup());
  s.fake.renameList(RUNS_LIST, 'Old runs');
  const { posted } = await say(s, '@samplebot last');
  assert.equal(body(posted[0]!), '@usera No runs yet.');
});

test('@samplebot run → started, starter.start(manual) called once', async () => {
  const s = await ready(setup());
  const { posted } = await say(s, '@samplebot run');
  assert.deepEqual(s.starts, ['manual']);
  assert.equal(body(posted[0]!), '@usera Run started. Its status card will appear on top of System › Runs.');
});

test('@samplebot run while a run is in progress → busy, no start', async () => {
  const s = await ready(setup());
  s.starter.running = true;
  const { posted } = await say(s, '@samplebot run');
  assert.deepEqual(s.starts, []);
  assert.equal(body(posted[0]!), '@usera A run is already in progress. Its status card will appear when it ends.');
});

test('@samplebot fit → `fit` isn\'t available yet.', async () => {
  const s = await ready(setup());
  const { posted } = await say(s, '@samplebot fit');
  assert.equal(body(posted[0]!), "@usera `fit` isn't available yet.");
  assert.equal(markerOf(posted[0]!).cls, 'model');
});

test('@samplebot what about this? → the help pointer, no handler called', async () => {
  const s = await ready(setup());
  let called = 0;
  const restore = withHandler('show_last_run', async () => { called++; return { text: 'x' }; });
  try {
    const { posted } = await say(s, '@samplebot what about this?');
    assert.match(body(posted[0]!), /^@usera I only know these commands for now:\n@samplebot open /);
  } finally {
    restore();
  }
  assert.equal(called, 0);
});

const NOT_PRIVATE = "@usera I can't work while the boards aren't private. The next run's status card names the problem.";

test('a public board → privacy refusal naming no board, no handler called', async () => {
  const s = await ready(setup());
  s.fake.setBoardPermissionLevel(BOARDS.jobs, 'public');
  const { posted } = await say(s, '@samplebot run');
  assert.deepEqual(s.starts, []);
  assert.equal(posted.length, 1);
  assert.equal(body(posted[0]!), NOT_PRIVATE);
  assert.equal(markerOf(posted[0]!).cls, 'refusal');
});

test('a public board and a broken config → the privacy refusal, not the config one', async () => {
  const s = await ready(setup());
  s.fake.setBoardPermissionLevel(BOARDS.jobs, 'public');
  await s.raw.setCardClosed(PERSONAL_DETAILS_CARD, true);
  const { posted } = await say(s, '@samplebot run');
  assert.equal(posted.length, 1);
  assert.equal(body(posted[0]!), NOT_PRIVATE);
});

test('2,001 characters → length refusal', async () => {
  const s = await ready(setup());
  const text = `@samplebot run ${'x'.repeat(2001 - '@samplebot run '.length)}`;
  assert.equal(text.length, 2001);
  const { posted } = await say(s, text);
  assert.equal(body(posted[0]!), '@usera That comment is over 2,000 characters. Please shorten it.');
  assert.equal(markerOf(posted[0]!).cls, 'refusal');
});

test('101st static command in 24 h → cap refusal; the refusal does not count', async () => {
  const s = await ready(setup());
  for (let i = 0; i < 100; i++) {
    s.fake.addComment(JOB_CARD, s.deps.me, `ok\n\n${formatMarker({ actionId: newId(), cls: 'static' })}`, new Date(NOW.getTime() - 3_600_000));
  }
  for (const n of [101, 102]) {
    const { posted } = await say(s, '@samplebot help');
    assert.equal(posted.length, 1, `command ${n}`);
    assert.match(body(posted[0]!), /^@usera Daily limit reached: 100 commands a day/);
    assert.equal(markerOf(posted[0]!).cls, 'refusal');
  }
  assert.equal((await loadUsage(s.api, BOARDS, { botId: s.deps.me.id, now: NOW })).static, 100);
});

test('a Personal details card missing → the constant config reply, nothing else', async () => {
  const s = await ready(setup());
  await s.raw.setCardClosed(PERSONAL_DETAILS_CARD, true);
  const { posted } = await say(s, '@samplebot run');
  assert.deepEqual(s.starts, []);
  assert.equal(posted.length, 1);
  assert.equal(body(posted[0]!), "@usera I can't answer until the config cards are fixed. The next run's status card names the problem.");
  assert.equal(markerOf(posted[0]!).cls, 'refusal');
});

test('yes with a pending start_run proposal starts one run and marks it resolved', async () => {
  const s = await ready(setup());
  const ask = newId();
  propose(s, ask);
  const { a, posted } = await say(s, '@samplebot yes');
  assert.deepEqual(s.starts, ['manual']);
  assert.equal(posted.length, 2);
  assert.deepEqual(markerOf(posted[0]!), { actionId: a.id, cls: 'static', resolves: ask });
  assert.equal(body(posted[0]!), '@usera Confirmed: run.');
  assert.deepEqual(markerOf(posted[1]!), { actionId: a.id, cls: 'refusal' });
  assert.equal(body(posted[1]!), '@usera Run started. Its status card will appear on top of System › Runs.');
});

test('two yes comments queued back to back start one run', async () => {
  const s = await ready(setup());
  propose(s, newId());
  await say(s, '@samplebot yes');
  const { posted } = await say(s, '@samplebot yes');
  assert.deepEqual(s.starts, ['manual']);
  assert.equal(body(posted[0]!), '@usera Nothing to confirm on this card.');
});

test('two concurrent yes comments start one run', async () => {
  const s = await ready(setup());
  propose(s, newId());
  await Promise.all([handleComment(s.deps, action('@samplebot yes')), handleComment(s.deps, action('@samplebot yes'))]);
  assert.deepEqual(s.starts, ['manual']);
  assert.equal(s.fake.commentsOn(JOB_CARD).filter((c) => body(c) === '@usera Nothing to confirm on this card.').length, 1);
});

test('when the resolution reply cannot be posted, the run does not start', async () => {
  const s = await ready(setup());
  propose(s, newId());
  s.fake.failNext('POST', /\/actions\/comments$/, 400);
  await say(s, '@samplebot yes');
  assert.deepEqual(s.starts, []);
  assert.match(s.logs.at(-1)!, /^comment fa4e[0-9a-f]{20} failed: /);
});

test('no → Cancelled., then yes → nothing to confirm', async () => {
  const s = await ready(setup());
  const ask = newId();
  propose(s, ask);
  const no = await say(s, '@samplebot no');
  assert.equal(body(no.posted[0]!), '@usera Cancelled.');
  assert.equal(markerOf(no.posted[0]!).resolves, ask);
  const yes = await say(s, '@samplebot yes');
  assert.equal(body(yes.posted[0]!), '@usera Nothing to confirm on this card.');
  assert.deepEqual(s.starts, []);
});

test('an expired proposal → asks again', async () => {
  const s = await ready(setup());
  const p = proposal({ id: 'start_run', args: {} }, new Date(NOW.getTime() - 25 * 3_600_000));
  s.fake.addComment(JOB_CARD, s.deps.me, `Start?\n\n${formatMarker({ actionId: newId(), cls: 'static', proposal: p })}`,
    new Date(NOW.getTime() - 25 * 3_600_000));
  const { posted } = await say(s, '@samplebot yes');
  assert.equal(body(posted[0]!), '@usera That proposal expired (24 h). Ask again.');
});

test('a handler that throws with a secret in its message → the constant failure reply; the log has *** not the secret', async () => {
  const s = await ready(setup());
  const restore = withHandler('show_last_run', async () => { throw new Error(`token ${SECRET} rejected`); });
  try {
    const { posted } = await say(s, '@samplebot last');
    assert.equal(body(posted[0]!), '@usera Sorry, last failed. The service log has details.');
  } finally {
    restore();
  }
  assert.ok(s.logs.some((l) => l.includes('handler show_last_run failed') && l.includes('***')));
  assert.ok(!s.logs.some((l) => l.includes(SECRET)));
});

test('a reply that echoes a link not on the card has it removed', async () => {
  const s = await ready(setup());
  const restore = withHandler('show_last_run', async () =>
    ({ text: 'See https://evil.example/steal and https://trello.com/c/sampleok', links: ['https://trello.com/c/sampleok'] }));
  try {
    const { posted } = await say(s, '@samplebot last');
    const text = body(posted[0]!);
    assert.doesNotMatch(text, /evil\.example/);
    assert.match(text, /link removed/);
    assert.match(text, /<https:\/\/trello\.com\/c\/sampleok>/);
  } finally {
    restore();
  }
});

test('a Trello failure inside the gate is logged, not thrown', async () => {
  const s = await ready(setup());
  s.fake.failNext('GET', /\/cards\/[^/]+\/actions$/, 500, 10);
  await assert.doesNotReject(handleComment(s.deps, action('@samplebot help')));
  assert.match(s.logs.at(-1)!, /^comment fa4e[0-9a-f]{20} failed: /);
  assert.deepEqual(s.fake.commentsOn(JOB_CARD), []);
});

test('the gate drops silently: a comment without a mention gets no reply', async () => {
  const s = await ready(setup());
  const { posted } = await say(s, 'just a note');
  assert.deepEqual(posted, []);
});

test('a hung handler times out, is logged, and the next comment on the card runs', async () => {
  const s = await ready(setup());
  s.deps.commentTimeoutMs = 50;
  const restore = withHandler('show_last_run', () => new Promise(() => {}));
  try {
    const hung = action('@samplebot last');
    const next = action('@samplebot help');
    const first = handleComment(s.deps, hung);
    await handleComment(s.deps, next);
    await first;
    assert.ok(s.logs.includes(`comment ${hung.id} timed out`));
    const posted = s.fake.commentsOn(JOB_CARD);
    assert.equal(posted.length, 1);
    assert.equal(markerOf(posted[0]!).actionId, next.id);
  } finally {
    restore();
  }
});
