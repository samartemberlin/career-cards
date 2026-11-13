import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import type { TMember } from '../../src/trello/api.ts';
import { CATALOGUE } from '../../src/bot/catalogue.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { loadUsage, capClassOf, overCap } from '../../src/bot/caps.ts';
import type { Usage } from '../../src/bot/caps.ts';
import type { Settings } from '../../src/config/schema.ts';
import { finishReply } from '../../src/bot/reply.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

function rawClient(fake: FakeTrello) {
  return createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
}

/** Create three boards plus one list in each board; return the board IDs. */
async function setupBoards(fake: FakeTrello): Promise<UserBoards & { listIds: [string, string, string] }> {
  const api = rawClient(fake);
  const orgId = 'fa4eorgorgorgorgorgorgorg';
  const jobs = await api.createBoard('Jobs', orgId);
  const profiles = await api.createBoard('Profiles', orgId);
  const system = await api.createBoard('System', orgId);
  const [l0, l1, l2] = await Promise.all([
    api.createList(jobs.id, 'Open', 'bottom'),
    api.createList(profiles.id, 'Profiles', 'bottom'),
    api.createList(system.id, 'Runs', 'bottom'),
  ]);
  return {
    jobs: jobs.id,
    profiles: profiles.id,
    system: system.id,
    listIds: [l0.id, l1.id, l2.id],
  };
}

function botApi(fake: FakeTrello, boards: UserBoards) {
  return scopeUserBoards(rawClient(fake), boards);
}

/** Marker comment text: a reply marker line as the last line. */
function markerText(actionId: string, cls: 'static' | 'model' | 'research' | 'refusal'): string {
  return `Some reply text.\ncareer-cards-reply: ${actionId} ${cls}`;
}

const DEFAULT_CAPS: Settings['caps'] = {
  model_per_day: 30,
  model_per_card_per_day: 8,
  research_per_day: 10,
  static_per_day: 100,
};

// ── loadUsage ─────────────────────────────────────────────────────────────────

test('loadUsage counts by class, skips refusals, user comments and comments older than 24 h', async () => {
  const fake = new FakeTrello();
  const { listIds, ...boards } = await setupBoards(fake);
  const api = rawClient(fake);

  const card = await api.createCard({ idList: listIds[0], name: 'Job A', desc: '', pos: 'bottom' });

  const bot: TMember = fake['_me'] as TMember;
  const user: TMember = { id: 'fa4eaaaaaaaaaaaaaaaaaa01', username: 'userA' };
  const now = new Date('2026-11-12T12:00:00.000Z');
  const recent = new Date('2026-11-12T06:00:00.000Z');   // 6 h ago — in window
  const old    = new Date('2026-11-11T11:00:00.000Z');   // 25 h ago — outside window

  fake.addComment(card.id, bot,  markerText('000000000000000000000001', 'static'),   recent);
  fake.addComment(card.id, bot,  markerText('000000000000000000000002', 'model'),    recent);
  fake.addComment(card.id, bot,  markerText('000000000000000000000003', 'research'), recent);
  fake.addComment(card.id, bot,  markerText('000000000000000000000004', 'refusal'),  recent);  // skip
  fake.addComment(card.id, user, markerText('000000000000000000000005', 'static'),   recent);  // skip — user
  fake.addComment(card.id, bot,  markerText('000000000000000000000006', 'static'),   old);     // skip — old

  const u = await loadUsage(botApi(fake, boards), boards, { botId: bot.id, now });

  assert.equal(u.static, 1, 'one static');
  assert.equal(u.model,  1, 'one model');
  assert.equal(u.research, 1, 'one research');
  assert.equal(u.modelByCard.get(card.id), 2, 'model + research count toward modelByCard');
});

test('loadUsage reads all three boards', async () => {
  const fake = new FakeTrello();
  const { listIds, ...boards } = await setupBoards(fake);
  const api = rawClient(fake);

  const [cJobs, cProfiles, cSystem] = await Promise.all([
    api.createCard({ idList: listIds[0], name: 'J', desc: '', pos: 'bottom' }),
    api.createCard({ idList: listIds[1], name: 'P', desc: '', pos: 'bottom' }),
    api.createCard({ idList: listIds[2], name: 'S', desc: '', pos: 'bottom' }),
  ]);

  const bot: TMember = fake['_me'] as TMember;
  const now = new Date('2026-11-12T12:00:00.000Z');
  const t   = new Date('2026-11-12T06:00:00.000Z');

  fake.addComment(cJobs.id,     bot, markerText('000000000000000000000011', 'static'), t);
  fake.addComment(cProfiles.id, bot, markerText('000000000000000000000012', 'model'),  t);
  fake.addComment(cSystem.id,   bot, markerText('000000000000000000000013', 'research'), t);

  const u = await loadUsage(botApi(fake, boards), boards, { botId: bot.id, now });

  assert.equal(u.static + u.model + u.research, 3, 'one comment from each board');
  assert.equal(u.static,   1);
  assert.equal(u.model,    1);
  assert.equal(u.research, 1);
});

// ── capClassOf ────────────────────────────────────────────────────────────────

test('capClassOf maps every catalogue row', () => {
  const byStage: Record<string, string> = {};
  for (const spec of CATALOGUE) byStage[spec.id] = capClassOf(spec);

  assert.deepEqual(byStage, {
    check_open:       'static',
    check_legit:      'model',
    apply_needs:      'model',
    explain_fit:      'model',
    cv_tips:          'model',
    job_deep_dive:    'research',
    company_research: 'research',
    explain_filter:   'static',
    record_feedback:  'static',
    show_last_run:    'static',
    start_run:        'static',
  });
});

test('capClassOf(null) returns static', () => {
  assert.equal(capClassOf(null), 'static');
});

// ── overCap ───────────────────────────────────────────────────────────────────

function usage(overrides: Partial<Omit<Usage, 'modelByCard'>> & { modelByCard?: [string, number][] } = {}): Usage {
  return {
    static: overrides.static ?? 0,
    model:  overrides.model  ?? 0,
    research: overrides.research ?? 0,
    modelByCard: new Map(overrides.modelByCard ?? []),
  };
}

test('overCap static at 100 refuses, at 99 passes', () => {
  const caps = { ...DEFAULT_CAPS, static_per_day: 100 };
  assert.match(overCap('static', 'c1', usage({ static: 100 }), caps)!, /100 commands a day/);
  assert.equal(overCap('static', 'c1', usage({ static: 99 }), caps), null);
});

test('overCap model per day: 20 model + 10 research refuses', () => {
  const caps = { ...DEFAULT_CAPS, model_per_day: 30 };
  const u = usage({ model: 20, research: 10 });
  assert.match(overCap('model', 'c1', u, caps)!, /30 model requests a day/);
});

test('overCap model per card: 8 on card A refuses A, passes B', () => {
  const caps = { ...DEFAULT_CAPS, model_per_card_per_day: 8 };
  // model+research well under the daily cap so only the per-card cap fires.
  const u = usage({ model: 8, modelByCard: [['cardA', 8]] });
  assert.match(overCap('model', 'cardA', u, caps)!, /8 model requests on this card a day/);
  assert.equal(overCap('model', 'cardB', u, caps), null);
});

test('overCap research: 10 research refuses even with model headroom', () => {
  // model+research = 10 is well under model_per_day=30; per-card count under model_per_card_per_day=8.
  // Only the research_per_day=10 cap fires.
  const caps = { ...DEFAULT_CAPS, research_per_day: 10 };
  const u = usage({ research: 10, modelByCard: [['c1', 7]] });
  assert.match(overCap('research', 'c1', u, caps)!, /10 research requests a day/);
});

test('overCap research: 20 model + 10 research refuses a model request', () => {
  const caps = { ...DEFAULT_CAPS, model_per_day: 30 };
  const u = usage({ model: 20, research: 10, modelByCard: [['c1', 10]] });
  assert.match(overCap('research', 'c1', u, caps)!, /30 model requests a day/);
});

test('caps 0 refuses everything of that class', () => {
  const capsZeroStatic   = { ...DEFAULT_CAPS, static_per_day: 0 };
  const capsZeroModel    = { ...DEFAULT_CAPS, model_per_day: 0 };
  const capsZeroResearch = { ...DEFAULT_CAPS, research_per_day: 0 };

  assert.ok(overCap('static',   'c1', usage(), capsZeroStatic)   !== null, 'static=0 refuses with 0 usage');
  assert.ok(overCap('model',    'c1', usage(), capsZeroModel)    !== null, 'model=0 refuses with 0 usage');
  assert.ok(overCap('research', 'c1', usage(), capsZeroResearch) !== null, 'research=0 refuses with 0 usage');
});

test('every cap refusal survives finishReply whole: it names its setting without a dotted name', () => {
  const identity = { mask: (t: string) => t, hasDetail: () => false };
  const refusals: [string, string][] = [
    [overCap('static', 'c1', usage({ static: 100 }), DEFAULT_CAPS)!, 'static_per_day'],
    [overCap('model', 'c1', usage({ model: 30 }), DEFAULT_CAPS)!, 'model_per_day'],
    [overCap('model', 'c1', usage({ model: 8, modelByCard: [['c1', 8]] }), DEFAULT_CAPS)!, 'model_per_card_per_day'],
    [overCap('research', 'c1', usage({ research: 10 }), DEFAULT_CAPS)!, 'research_per_day'],
  ];
  for (const [text, key] of refusals) {
    const [part, ...rest] = finishReply({ text, author: 'usera', marker: { actionId: 'a'.repeat(24), cls: 'refusal' }, masker: identity, allowedLinks: [] });
    assert.equal(rest.length, 0);
    assert.doesNotMatch(part!, /link removed/, text);
    const shown = part!.split('\n')[0]!.replace(/\\(.)/g, '$1');
    assert.ok(shown.includes(`raise \`${key}\` under caps on the Settings card`), shown);
  }
});
