import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import { ConfigInvalid, readUserConfig } from '../../src/trello/config.ts';
import type { ConfigProblem, UserBoards } from '../../src/trello/config.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

type RawChecklist = { id: string; name: string; idCard: string; checkItems: { id: string; name: string; state: string; pos: number }[] };
type RawCard = { id: string; name: string; desc: string; idList: string; closed: boolean; pos: number; shortUrl: string; checklists?: RawChecklist[] };
type RawList = { id: string; name: string; closed: boolean };
type Board = { lists: RawList[]; cards: RawCard[] };

function boardId(rec: Recording): string {
  const call = rec.find((c) => /^\/boards\/[^/]+$/.test(c.path));
  if (!call) throw new Error('recording has no board call');
  return call.path.split('/')[2]!;
}

function part<T>(rec: Recording, suffix: string): T {
  const call = rec.find((c) => c.method === 'GET' && c.path.endsWith(suffix));
  if (!call) throw new Error(`recording has no ${suffix} call`);
  return call.body as T;
}

/** The captured Profiles and System boards, editable before the fake is seeded. */
function setup(edit: (b: { profiles: Board; system: Board }) => void = () => {}) {
  const profiles = load('profiles');
  const system = load('system');
  const view = (rec: Recording): Board => ({ lists: part(rec, '/lists'), cards: part(rec, '/cards/open') });
  edit({ profiles: view(profiles), system: view(system) });
  const fake = FakeTrello.fromRecordings(profiles, system);
  const api = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const boards: UserBoards = { jobs: 'fa4e00000000000000000fff', profiles: boardId(profiles), system: boardId(system) };
  return { fake, api, boards };
}

const listNamed = (b: Board, name: string) => b.lists.find((l) => l.name === name)!;
const cardIn = (b: Board, list: string, name: string) =>
  b.cards.find((c) => c.name === name && c.idList === listNamed(b, list).id)!;

let nextId = 0xf00;
function cloneCard(card: RawCard, changes: Partial<RawCard> = {}): RawCard {
  const id = `fa4e${(nextId++).toString(16).padStart(20, '0')}`;
  return { ...structuredClone(card), id, shortUrl: `https://trello.com/c/test${nextId}`, checklists: [], ...changes };
}

async function problemsOf(s: ReturnType<typeof setup>): Promise<ConfigProblem[]> {
  try {
    await readUserConfig(s.api, s.boards);
  } catch (e) {
    assert.ok(e instanceof ConfigInvalid, `expected ConfigInvalid, got ${String(e)}`);
    assert.equal(e.message.split('\n').length, e.problems.length);
    return e.problems;
  }
  assert.fail('expected ConfigInvalid');
}

test('reads the captured sample boards', async () => {
  const s = setup();
  const config = await readUserConfig(s.api, s.boards);

  assert.deepEqual(config.profiles.map((p) => [p.name, p.active]), [['Content editor', true], ['Copywriter', false]]);
  assert.match(config.sharedCv, /^# Alex Example/);
  assert.equal(config.personalDetails.length, 5);
  const editor = config.profiles[0]!;
  assert.ok(editor.rubric.startsWith('Prefer Berlin or remote roles.'));
  assert.match(editor.rubric, /\n\nScore 0-10 how well a job fits a content editor/);
  assert.deepEqual(editor.searchKeywords, ['content editor', 'redakteur', 'content manager']);
  assert.deepEqual(editor.filters.excludeTitles, [{ pattern: 'senior|lead', note: 'too senior for now' }]);
  assert.deepEqual(editor.filters.excludeCompanies, [{ company: 'Example Staffing GmbH', reason: 'agency' }]);
  assert.equal(editor.cv, undefined);
  assert.deepEqual(config.settings.providers, ['claude', 'gemini']);
  assert.equal(config.settings.timezone, 'Europe/Berlin');
  assert.equal(config.sources.add[0]!.name, 'Example GmbH');
  assert.deepEqual(config.sources.drop, ['Old Example AG']);
  assert.equal(config.preferences?.years_experience, 3);
  assert.ok(!config.profiles.some((p) => p.name === 'Old profile' || p.name === 'Originals'));
  assert.ok(!JSON.stringify(config).includes('(original)'));
  assert.equal(s.fake.requests.length, 4);
});

test('fixed titles match with stray spaces and other case', async () => {
  const s = setup(({ profiles }) => {
    cardIn(profiles, 'Content editor', 'Rubric').name = ' rubric ';
    cardIn(profiles, 'Shared', 'Personal details').name = 'PERSONAL DETAILS';
    cardIn(profiles, 'Content editor', 'Filters').checklists![1]!.name = ' exclude TITLES ';
  });
  const config = await readUserConfig(s.api, s.boards);
  assert.match(config.profiles[0]!.rubric, /content editor/);
  assert.equal(config.personalDetails.length, 5);
  assert.equal(config.profiles[0]!.filters.excludeTitles.length, 1);
});

test('ticked checklist items still count', async () => {
  const s = setup(({ profiles }) => {
    for (const item of cardIn(profiles, 'Content editor', 'Search keywords').checklists![0]!.checkItems) item.state = 'complete';
  });
  const config = await readUserConfig(s.api, s.boards);
  assert.equal(config.profiles[0]!.searchKeywords.length, 3);
});

test('a card in an archived list is ignored', async () => {
  const s = setup(({ profiles }) => {
    const old = listNamed(profiles, 'Old profile');
    profiles.cards.push(cloneCard(cardIn(profiles, 'Shared', 'CV'), { idList: old.id, desc: 'stale CV' }));
    // Counted, this archived second Shared column would give two Rubric basics cards.
    profiles.lists.push({ ...old, id: 'fa4e00000000000000000ffe', name: 'Shared', closed: true });
    profiles.cards.push(cloneCard(cardIn(profiles, 'Shared', 'Rubric basics'), { idList: 'fa4e00000000000000000ffe' }));
  });
  const config = await readUserConfig(s.api, s.boards);
  assert.match(config.sharedCv, /^# Alex Example/);
  assert.deepEqual(config.profiles.map((p) => p.name), ['Content editor', 'Copywriter']);
});

test('two Rubric cards in one column is a problem naming the column', async () => {
  let urls: string[] = [];
  const s = setup(({ profiles }) => {
    const rubric = cardIn(profiles, 'Content editor', 'Rubric');
    const copy = cloneCard(rubric, { name: 'Rubric ' });
    profiles.cards.push(copy);
    urls = [rubric.shortUrl, copy.shortUrl];
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  const p = problems[0]!;
  assert.equal(p.where, 'Profiles › Content editor › Rubric');
  assert.match(p.message, /Content editor/);
  for (const u of urls) assert.ok(p.message.includes(u), `message names ${u}`);
});

test('unknown Filters checklist "Exclude Title" is a problem on the Filters card', async () => {
  const s = setup(({ profiles }) => {
    cardIn(profiles, 'Content editor', 'Filters').checklists![1]!.name = 'Exclude Title';
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'Profiles › Content editor › Filters');
  assert.equal(problems[0]!.card?.name, 'Filters');
  assert.match(problems[0]!.message, /"Exclude Title"/);
});

test('invalid regex in Exclude titles points to the Filters card and quotes the pattern', async () => {
  let filtersId = '';
  const s = setup(({ profiles }) => {
    const filters = cardIn(profiles, 'Content editor', 'Filters');
    filtersId = filters.id;
    const items = filters.checklists![1]!.checkItems;
    items.push({ ...items[0]!, id: 'fa4e00000000000000000ffd', name: 'junior (assistant — broken', pos: 99999 });
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  const p = problems[0]!;
  assert.equal(p.where, 'Profiles › Content editor › Filters');
  assert.equal(p.card?.id, filtersId);
  assert.match(p.message, /Exclude titles/);
  assert.ok(p.message.includes('"junior (assistant"'), p.message);
});

test('bad timezone points to the Settings card', async () => {
  const s = setup(({ system }) => {
    const settings = system.cards.find((c) => c.name === 'Settings')!;
    settings.desc = settings.desc.replace('Europe/Berlin', 'Europe/Atlantis');
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Settings');
  assert.equal(problems[0]!.card?.board, 'system');
  assert.match(problems[0]!.message, /Europe\/Atlantis/);
});

test('Settings without a YAML block is a problem', async () => {
  const s = setup(({ system }) => {
    system.cards.find((c) => c.name === 'Settings')!.desc = 'timezone: Europe/Berlin';
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Settings');
  assert.match(problems[0]!.message, /yaml/i);
});

test('a Profile card without a YAML block is inactive; broken YAML is a problem', async () => {
  const quiet = setup(({ profiles }) => {
    cardIn(profiles, 'Copywriter', 'Profile').desc = 'No block here.';
  });
  assert.equal((await readUserConfig(quiet.api, quiet.boards)).profiles[1]!.active, false);

  const broken = setup(({ profiles }) => {
    cardIn(profiles, 'Copywriter', 'Profile').desc = '```yaml\nactive: [true\n```';
  });
  const problems = await problemsOf(broken);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'Profiles › Copywriter › Profile');
});

test('missing Personal details card is a problem', async () => {
  const s = setup(({ profiles }) => {
    profiles.cards.splice(profiles.cards.indexOf(cardIn(profiles, 'Shared', 'Personal details')), 1);
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'Profiles › Shared');
  assert.match(problems[0]!.message, /Personal details/);
});

test('missing required cards in a profile column are each a problem', async () => {
  const s = setup(({ profiles }) => {
    for (const name of ['Search keywords', 'Filters']) {
      profiles.cards.splice(profiles.cards.indexOf(cardIn(profiles, 'Copywriter', name)), 1);
    }
  });
  const problems = await problemsOf(s);
  assert.deepEqual(problems.map((p) => p.where), ['Profiles › Copywriter', 'Profiles › Copywriter']);
});

test('unknown Sources checklist "Add company" is a problem on the Sources card', async () => {
  const s = setup(({ system }) => {
    cardIn(system, 'Config', 'Sources').checklists![0]!.name = 'Add company';
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.where, 'System › Sources');
  assert.equal(problems[0]!.card?.name, 'Sources');
  assert.match(problems[0]!.message, /"Add company"/);
});

test('no Sources card means nothing added or dropped', async () => {
  const s = setup(({ system }) => {
    system.cards.splice(system.cards.findIndex((c) => c.name === 'Sources'), 1);
  });
  assert.deepEqual((await readUserConfig(s.api, s.boards)).sources, { add: [], drop: [] });
});

test('several problems are reported together', async () => {
  const s = setup(({ profiles, system }) => {
    const settings = system.cards.find((c) => c.name === 'Settings')!;
    settings.desc = settings.desc.replace('providers: [claude, gemini]', 'providers: []');
    cardIn(profiles, 'Content editor', 'Filters').checklists![4]!.checkItems[0]!.name = '(berlin';
  });
  const problems = await problemsOf(s);
  assert.deepEqual(problems.map((p) => p.where).sort(), ['Profiles › Content editor › Filters', 'System › Settings']);
});

test('every problem has a card url when a card exists', async () => {
  const s = setup(({ profiles, system }) => {
    system.cards.find((c) => c.name === 'Settings')!.desc = '```yaml\nproviders: [x]\nlocations: [berlin]\nscoring_cap: -1\n```';
    cardIn(profiles, 'Shared', 'Preferences').desc = '```yaml\nyears_experience: -2\n```';
    cardIn(profiles, 'Content editor', 'Filters').checklists![0]!.name = 'Include title';
    cardIn(system, 'Config', 'Sources').checklists![0]!.checkItems[0]!.name = 'No url here';
    profiles.cards.splice(profiles.cards.indexOf(cardIn(profiles, 'Copywriter', 'Rubric')), 1);
  });
  const problems = await problemsOf(s);
  assert.equal(problems.length, 5);
  for (const p of problems) {
    if (p.where === 'Profiles › Copywriter') {
      assert.equal(p.card, undefined);
      continue;
    }
    assert.match(p.card?.url ?? '', /^https:\/\/trello\.com\/c\//, `${p.where}: ${p.message}`);
  }
});

test('readUserConfig works through scopeUserBoards', async () => {
  const { fake, boards } = setup();
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeUserBoards(inner, boards);
  const config = await readUserConfig(api, boards);
  assert.ok(config.profiles.length > 0, 'at least one profile loaded');
});
