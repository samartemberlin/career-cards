import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import { ConfigInvalid, readSettings, readUserConfig } from '../../src/trello/config.ts';
import type { ConfigProblem, UserBoards } from '../../src/trello/config.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { seedLayout } from '../support/seed-layout.ts';
import { LAYOUT } from '../../tools/sample/layout.ts';
import type { BoardLayout } from '../../tools/sample/layout.ts';

type Boards = { profiles: BoardLayout; system: BoardLayout };

/** The sample Profiles and System boards, editable before the fake is seeded. */
async function setup(edit: (b: Boards) => void = () => {}) {
  const b: Boards = structuredClone({ profiles: LAYOUT.profiles, system: LAYOUT.system });
  edit(b);
  const fake = new FakeTrello();
  const boards: UserBoards = { jobs: 'fa4e00000000000000000fff', profiles: await seedLayout(fake, b.profiles), system: await seedLayout(fake, b.system) };
  fake.requests = [];
  const api = scopeUserBoards(createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} }), boards);
  return { fake, api, boards };
}

const cardIn = (b: BoardLayout, list: string, name: string) => b.lists.find((l) => l.name === list)!.cards.find((c) => c.name === name)!;
const settingsOf = (b: Boards) => cardIn(b.system, 'Config', 'Settings');

async function problemsOf(s: Awaited<ReturnType<typeof setup>>): Promise<ConfigProblem[]> {
  try {
    await readUserConfig(s.api, s.boards);
  } catch (e) {
    assert.ok(e instanceof ConfigInvalid, `expected ConfigInvalid, got ${String(e)}`);
    assert.equal(e.message.split('\n').length, e.problems.length);
    return e.problems;
  }
  assert.fail('expected ConfigInvalid');
}

test('reads the sample boards: Settings, Sources and the free-text Profiles board', async () => {
  const s = await setup();
  const config = await readUserConfig(s.api, s.boards);
  assert.deepEqual(config.board.profiles.map((p) => [p.name, p.active]), [['Content editor', true], ['Copywriter', false]]);
  assert.deepEqual(config.board.dealBreakers.map((c) => c.key), ['where', 'contract', 'languages', 'never']);
  assert.match(config.sharedCv, /^# Alex Example/);
  assert.equal(config.sharedCv, config.board.cv);
  assert.equal(config.personalDetails.length, 5);
  assert.deepEqual(config.settings.providers, ['claude', 'gemini']);
  assert.equal(config.settings.timezone, 'Europe/Berlin');
  assert.equal(config.sources.add[0]!.name, 'Example GmbH');
  assert.deepEqual(config.sources.drop, ['Old Example AG']);
  assert.ok(!config.board.profiles.some((p) => p.name === 'Old profile' || p.name === 'Originals'));
  assert.ok(!JSON.stringify(config).includes('(original)'));
  assert.equal(s.fake.requests.length, 4);
});

test('Settings with locations: a problem on the Settings card naming the key', async () => {
  const s = await setup((b) => { settingsOf(b).desc = '```yaml\nproviders: [gemini]\nlocations: []\n```'; });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Settings');
  assert.match(problems[0]!.message, /'locations'/);
});

test('bad timezone points to the Settings card', async () => {
  const s = await setup((b) => { settingsOf(b).desc = settingsOf(b).desc.replace('Europe/Berlin', 'Europe/Atlantis'); });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Settings');
  assert.equal(problems[0]!.card?.board, 'system');
  assert.match(problems[0]!.message, /Europe\/Atlantis/);
});

test('Settings without a YAML block is a problem', async () => {
  const s = await setup((b) => { settingsOf(b).desc = 'timezone: Europe/Berlin'; });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Settings');
  assert.match(problems[0]!.message, /yaml/i);
});

test('unknown Sources checklist "Add company" is a problem on the Sources card', async () => {
  const s = await setup((b) => { cardIn(b.system, 'Config', 'Sources').checklists![0]!.name = 'Add company'; });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Sources');
  assert.equal(problems[0]!.card?.name, 'Sources');
  assert.match(problems[0]!.message, /"Add company"/);
});

test('no Sources card means nothing added or dropped', async () => {
  const s = await setup((b) => {
    const config = b.system.lists.find((l) => l.name === 'Config')!;
    config.cards = config.cards.filter((c) => c.name !== 'Sources');
  });
  assert.deepEqual((await readUserConfig(s.api, s.boards)).sources, { add: [], drop: [] });
});

test('System and Profiles board problems are reported together, each with its card', async () => {
  const s = await setup((b) => {
    settingsOf(b).desc = settingsOf(b).desc.replace('providers: [claude, gemini]', 'providers: []');
    cardIn(b.system, 'Config', 'Sources').checklists![0]!.items[0] = 'No url here';
    cardIn(b.profiles, 'Content editor', 'My dream job').desc = '_Describe it in a few sentences: role, kind of company, what it does, pay, team._';
  });
  const problems = await problemsOf(s);
  assert.deepEqual(problems.map((p) => p.where), ['System › Settings', 'System › Sources', 'Profiles › Content editor › My dream job']);
  for (const p of problems) assert.match(p.card?.url ?? '', /^https:\/\/trello\.com\/c\//, `${p.where}: ${p.message}`);
});

test('readSettings returns Settings and throws ConfigInvalid naming the card', async () => {
  const s = await setup();
  const settings = await readSettings(s.api, s.boards);
  assert.deepEqual(settings.providers, ['claude', 'gemini']);
  assert.deepEqual(settings.allowed_members, ['samplebot']);
  assert.equal(settings.caps.model_per_day, 30);
  assert.ok(s.fake.requests.every((r) => r.path.includes(s.boards.system)), 'reads only the System board');

  const broken = await setup((b) => { settingsOf(b).desc = '```yaml\nproviders: [x\n```'; });
  const e = await readSettings(broken.api, broken.boards).catch((x: unknown) => x);
  assert.ok(e instanceof ConfigInvalid, `expected ConfigInvalid, got ${String(e)}`);
  assert.equal(e.problems.length, 1);
  assert.equal(e.problems[0]!.where, 'System › Settings');
  assert.match(e.problems[0]!.card!.url, /^https:\/\/trello\.com\//);

  const invalid = await setup((b) => { settingsOf(b).desc = '```yaml\nproviders: [x]\nscoring_cap: -1\n```'; });
  const e2 = await readSettings(invalid.api, invalid.boards).catch((x: unknown) => x);
  assert.ok(e2 instanceof ConfigInvalid);
  assert.deepEqual(e2.problems.map((p) => p.where), ['System › Settings']);
  assert.match(e2.problems[0]!.message, /scoring_cap/);
});
