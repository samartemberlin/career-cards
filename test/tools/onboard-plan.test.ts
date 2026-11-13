import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import type { TrelloApi } from '../../src/trello/api.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import { readOnlyClient } from '../../src/trello/read-only.ts';
import { STARTER, starterLayout } from '../../tools/onboard/starter.ts';
import { formatPlan, planOnboarding, readBoards } from '../../tools/onboard/plan.ts';
import type { Observed, ObservedBoard, OnboardPlan, Role } from '../../tools/onboard/plan.ts';
import type { BoardLayout } from '../../tools/sample/layout.ts';
import { SAMPLE_NAMES, denyBoardListing } from '../../tools/sample/guard.ts';
import { main } from '../../tools/onboard.ts';

const ROLES: Role[] = ['jobs', 'profiles', 'system'];
const TITLE = { jobs: 'Jobs', profiles: 'Profiles', system: 'System' } as const;
const SETTINGS_OTHER = '```yaml\ntimezone: Europe/Paris\nproviders: [groq]\nlocations: [berlin]\nallowed_members: [usera]\n```';

const nothing: Observed = {
  bot: 'samplebot',
  owner: 'usera',
  boards: { jobs: { exists: false }, profiles: { exists: false }, system: { exists: false } },
};

function observedFrom(layout: Record<Role, BoardLayout>, members = ['usera', 'samplebot']): Observed {
  const board = (r: Role): ObservedBoard => ({
    exists: true,
    id: `${r}-id`,
    name: `career-cards · ${TITLE[r]}`,
    permissionLevel: 'private',
    closed: false,
    members: [...members],
    lists: layout[r].lists.map((l) => ({ name: l.name, cards: l.cards.map((c) => c.name) })),
  });
  return {
    bot: 'samplebot',
    owner: 'usera',
    boards: { jobs: board('jobs'), profiles: board('profiles'), system: board('system') },
    allowedMembers: ['usera'],
    personalDetails: 3,
    config: { problems: [] },
  };
}

const full = (): Observed => observedFrom(starterLayout('usera'));

describe('starter', () => {
  it('has the brief\'s lists and cards', () => {
    assert.deepEqual(STARTER.jobs.lists.map((l) => l.name), ['To apply', 'Applied', 'Interview', 'Rejected', 'Closed', 'Dismissed']);
    assert.deepEqual(STARTER.profiles.lists.map((l) => [l.name, l.cards.map((c) => c.name)]), [
      ['Originals', []],
      ['Shared', ['CV', 'Personal details']],
      ['My profile', ['Profile', 'Rubric', 'Search keywords', 'Filters', 'Feedback']],
    ]);
    assert.deepEqual(STARTER.system.lists.map((l) => [l.name, l.cards.map((c) => c.name)]), [
      ['Config', ['Settings', 'Sources', 'Schedule']],
      ['Runs', []],
    ]);
    const details = STARTER.profiles.lists[1]!.cards[1]!;
    assert.deepEqual(details.checklists, [{ name: 'Personal details', items: [] }]);
  });

  it('starterLayout puts the owner in allowed_members', () => {
    const settings = starterLayout('usera').system.lists[0]!.cards[0]!.desc;
    assert.match(settings, /timezone: Europe\/Berlin\nproviders: \[gemini\]\nlocations: \[\]\nlinkedin: false\nallowed_members: \[usera\]\n/);
  });
});

describe('planOnboarding', () => {
  it('fresh setup: three boards, bot membership, every starter list and card, no webhooks without --url', () => {
    const p = planOnboarding({ observed: nothing, owner: 'usera' });
    assert.deepEqual(p.refuse, []);
    assert.equal(p.actions.filter((a) => a.kind === 'createBoard').length, 3);
    assert.ok(p.actions.some((a) => a.kind === 'addMember' && a.username === 'samplebot'));
    assert.ok(!p.actions.some((a) => a.kind === 'webhook'));
    const lists = STARTER.jobs.lists.length + STARTER.profiles.lists.length + STARTER.system.lists.length;
    const cards = ROLES.reduce((n, r) => n + STARTER[r].lists.reduce((m, l) => m + l.cards.length, 0), 0);
    assert.equal(p.actions.filter((a) => a.kind === 'createList').length, lists);
    assert.equal(p.actions.filter((a) => a.kind === 'createCard').length, cards);
  });

  it('the board owner is not added as a member of the board it creates', () => {
    const p = planOnboarding({ observed: nothing, owner: 'usera' });
    assert.ok(!p.actions.some((a) => a.kind === 'addMember' && a.username === 'usera'));
  });

  it('with the bot as the board owner, the user is added instead', () => {
    const p = planOnboarding({ observed: { ...nothing, owner: 'samplebot' }, owner: 'usera' });
    const added = p.actions.filter((a) => a.kind === 'addMember').map((a) => a.kind === 'addMember' && a.username);
    assert.deepEqual(added, ['usera', 'usera', 'usera']);
  });

  it('fully set up boards plan nothing', () => {
    const p = planOnboarding({ observed: full(), owner: 'usera' });
    assert.deepEqual(p, { refuse: [], actions: [], notes: [] });
  });

  it('half set up: only the missing cards and lists, edited cards untouched', () => {
    const o = full();
    const profiles = o.boards.profiles as Extract<ObservedBoard, { exists: true }>;
    const mine = profiles.lists.find((l) => l.name === 'My profile')!;
    mine.cards = mine.cards.filter((c) => c !== 'Rubric');
    o.allowedMembers = ['usera'];
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.deepEqual(p.refuse, []);
    assert.deepEqual(p.actions.map((a) => a.kind), ['createCard']);
    assert.ok(p.actions[0]!.kind === 'createCard' && p.actions[0]!.card.name === 'Rubric' && p.actions[0]!.list === 'My profile');
    assert.ok(!JSON.stringify(p.actions).includes('Settings'));
  });

  it('a missing list is planned before the cards that go in it', () => {
    const o = full();
    const system = o.boards.system as Extract<ObservedBoard, { exists: true }>;
    system.lists = system.lists.filter((l) => l.name !== 'Runs');
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.deepEqual(p.actions, [{ kind: 'createList', board: 'system', list: 'Runs' }]);
  });

  it('a System card moved to another list counts as there (the config reader reads the whole board)', () => {
    const o = full();
    const system = o.boards.system as Extract<ObservedBoard, { exists: true }>;
    system.lists = [{ name: 'Config', cards: ['Sources', 'Schedule'] }, { name: 'Runs', cards: [] }, { name: 'Mine', cards: ['settings'] }];
    assert.deepEqual(planOnboarding({ observed: o, owner: 'usera' }).actions, []);
  });

  it('titles match the way the config reader matches them (trimmed, any case)', () => {
    const o = full();
    const profiles = o.boards.profiles as Extract<ObservedBoard, { exists: true }>;
    profiles.lists = profiles.lists.map((l) => ({ name: ` ${l.name.toUpperCase()} `, cards: l.cards.map((c) => c.toLowerCase()) }));
    assert.deepEqual(planOnboarding({ observed: o, owner: 'usera' }).actions, []);
  });

  it('a missing bot membership on an existing board is planned', () => {
    const o = observedFrom(starterLayout('usera'), ['usera']);
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.deepEqual(p.actions, ROLES.map((board) => ({ kind: 'addMember', board, username: 'samplebot' })));
  });

  it('plan refuses a public board and an extra member, naming them', () => {
    const o = full();
    (o.boards.jobs as Extract<ObservedBoard, { exists: true }>).permissionLevel = 'org';
    (o.boards.system as Extract<ObservedBoard, { exists: true }>).members.push('stranger');
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.deepEqual(p.refuse, ['Jobs: not private (org)', 'System: extra member stranger']);
  });

  it('plan refuses a closed board', () => {
    const o = full();
    (o.boards.profiles as Extract<ObservedBoard, { exists: true }>).closed = true;
    assert.deepEqual(planOnboarding({ observed: o, owner: 'usera' }).refuse, ['Profiles: closed']);
  });

  it('plan refuses a board whose name does not match its role (wrong id)', () => {
    const o = full();
    (o.boards.system as Extract<ObservedBoard, { exists: true }>).name = 'career-cards · Jobs';
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.equal(p.refuse.length, 1);
    assert.match(p.refuse[0]!, /^System: the board is named "career-cards · Jobs", not "… · System"/);
  });

  it('a refused board gets no actions', () => {
    const o = observedFrom({ ...starterLayout('usera'), jobs: { labels: [], lists: [] } }, ['usera']);
    (o.boards.jobs as Extract<ObservedBoard, { exists: true }>).permissionLevel = 'public';
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.ok(!p.actions.some((a) => a.board === 'jobs'));
  });

  it('plan refuses a board id that neither client can read', () => {
    const o = full();
    o.boards.jobs = { exists: false, id: 'stale-id' };
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.equal(p.refuse.length, 1);
    assert.match(p.refuse[0]!, /^Jobs: /);
    assert.ok(!p.actions.some((a) => a.kind === 'createBoard'));
  });

  it('the sample boards pass the name check', () => {
    const o = full();
    for (const r of ROLES) (o.boards[r] as Extract<ObservedBoard, { exists: true }>).name = SAMPLE_NAMES[r];
    assert.deepEqual(planOnboarding({ observed: o, owner: 'usera' }).refuse, []);
  });

  it('notes when allowed_members lacks the owner and when Personal details is empty', () => {
    const o = full();
    o.allowedMembers = ['someoneelse'];
    o.personalDetails = 0;
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.ok(p.notes.includes('Settings: allowed_members does not include usera'));
    assert.ok(p.notes.includes('Personal details is empty: the run will refuse until it lists your name, email, phone'));
  });

  it('a fresh setup notes the empty Personal details too', () => {
    const p = planOnboarding({ observed: nothing, owner: 'usera' });
    assert.ok(p.notes.includes('Personal details is empty: the run will refuse until it lists your name, email, phone'));
  });

  it('notes each config problem with its card; the empty Personal details problem is said once', () => {
    const o = full();
    o.personalDetails = 0;
    o.config = {
      problems: [
        { where: 'System › Settings', message: 'providers: Required', card: { id: 'c1', name: 'Settings', url: 'https://trello.com/c/abc', board: 'system' } },
        { where: 'Profiles › Shared › Personal details', message: 'Array must contain at least 1 element(s)' },
        { where: 'Profiles board', message: 'at least one profile must be active' },
      ],
    };
    const p = planOnboarding({ observed: o, owner: 'usera' });
    assert.deepEqual(p.notes, [
      'Personal details is empty: the run will refuse until it lists your name, email, phone',
      'System › Settings: providers: Required (https://trello.com/c/abc)',
      'Profiles board: at least one profile must be active',
    ]);
  });

  it('--url adds one webhook per board at <url>/trello', () => {
    const p = planOnboarding({ observed: full(), owner: 'usera', url: 'https://worker.example.com/' });
    const hooks = p.actions.filter((a) => a.kind === 'webhook');
    assert.equal(hooks.length, 3);
    for (const h of hooks) assert.ok(h.kind === 'webhook' && h.callbackURL === 'https://worker.example.com/trello');
    assert.deepEqual(hooks.map((h) => h.board), ROLES);
  });

  it('new boards are named <prefix> · <Role>', () => {
    const p = planOnboarding({ observed: nothing, owner: 'usera', name: 'my cards' });
    assert.deepEqual(
      p.actions.filter((a) => a.kind === 'createBoard').map((a) => a.kind === 'createBoard' && a.name),
      ['my cards · Jobs', 'my cards · Profiles', 'my cards · System'],
    );
  });
});

describe('formatPlan', () => {
  it('dry-run output lists refusals, actions and notes and no card text', () => {
    const cv = STARTER.profiles.lists[1]!.cards[0]!;
    const plan: OnboardPlan = {
      refuse: ['Jobs: not private (org)'],
      actions: [
        { kind: 'createBoard', board: 'system', name: 'career-cards · System' },
        { kind: 'addMember', board: 'system', username: 'samplebot' },
        { kind: 'createList', board: 'profiles', list: 'Shared' },
        { kind: 'createCard', board: 'profiles', list: 'Shared', card: cv },
        { kind: 'webhook', board: 'jobs', callbackURL: 'https://worker.example.com/trello' },
      ],
      notes: ['Settings: allowed_members does not include usera'],
    };
    const out = formatPlan(plan);
    assert.equal(out, [
      'Refused:',
      '  Jobs: not private (org)',
      'Will do:',
      '  System: create board "career-cards · System"',
      '  System: add member samplebot',
      '  Profiles: create list "Shared"',
      '  Profiles: create card "CV" in "Shared"',
      '  Jobs: webhook to https://worker.example.com/trello',
      'Check by hand:',
      '  Settings: allowed_members does not include usera',
    ].join('\n'));
    assert.ok(cv.desc.length > 20 && !out.includes(cv.desc.slice(0, 20)));
  });

  it('empty sections say none', () => {
    assert.equal(formatPlan({ refuse: [], actions: [], notes: [] }), 'Refused:\n  (none)\nWill do:\n  (none)\nCheck by hand:\n  (none)');
  });
});

// ── through FakeTrello ────────────────────────────────────────────────────────

const USER_A = { id: 'a1'.padEnd(24, '0'), username: 'usera' };

type Built = { fake: FakeTrello; ids: Record<Role, string> };

/** Builds the starter boards in a FakeTrello, then forgets the setup requests. */
async function built(o: { personal?: string[]; botMember?: boolean } = {}): Promise<Built> {
  const fake = new FakeTrello();
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const me = await raw.me();
  const layout = starterLayout('usera');
  const ids = {} as Record<Role, string>;
  for (const r of ROLES) {
    const b = await raw.createBoard(`career-cards · ${TITLE[r]}`, 'org');
    ids[r] = b.id;
    fake.addBoardMember(b.id, USER_A);
    if (o.botMember !== false) fake.addBoardMember(b.id, me);
    for (const ls of layout[r].lists) {
      const list = await raw.createList(b.id, ls.name, 'bottom');
      for (const cs of ls.cards) {
        const card = await raw.createCard({ idList: list.id, name: cs.name, desc: cs.desc, pos: 'bottom' });
        for (const cls of cs.checklists ?? []) {
          const cl = await raw.createChecklist(card.id, cls.name);
          const items = cls.name === 'Personal details' ? (o.personal ?? []) : cls.items;
          for (const it of items) await raw.addCheckItem(cl.id, it);
        }
      }
    }
  }
  fake.requests = [];
  return { fake, ids };
}

/** Any request that lists or searches boards fails the test, even if the guard under test lets it through. */
function noBoardListing(fake: FakeTrello): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (/^\/1\/(members|organizations)\/[^/]+\/boards/.test(u.pathname) || u.searchParams.has('boards') || u.pathname.startsWith('/1/search')) {
      throw new Error(`listed boards: ${u.pathname}`);
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
}

const client = (f: typeof fetch): TrelloApi => createTrelloClient({ key: 'k', token: 't', fetchImpl: denyBoardListing(f), sleep: async () => {} });

describe('readBoards', () => {
  it('readBoards never lists boards', async () => {
    const { fake, ids } = await built({ personal: ['A. User'] });
    const api = readOnlyClient(scopeUserBoards(client(noBoardListing(fake)), ids));
    const o = await readBoards(api, api, ids);
    assert.deepEqual(planOnboarding({ observed: o, owner: 'usera' }), { refuse: [], actions: [], notes: [] });
    assert.ok(fake.requests.every((r) => r.method === 'GET'));
    assert.ok(!fake.requests.some((r) => /\/boards$/.test(r.path) && r.path.startsWith('/members')));
  });

  it('reads only the ids given', async () => {
    const { fake, ids } = await built();
    const api = readOnlyClient(scopeUserBoards(client(fake.fetch), ids));
    const o = await readBoards(api, api, { jobs: ids.jobs });
    assert.equal(o.boards.profiles.exists, false);
    assert.equal(o.boards.system.exists, false);
    assert.ok(fake.requests.every((r) => !r.path.includes(ids.profiles) && !r.path.includes(ids.system)));
  });

  it('a board the bot cannot see yet is read with the owner client', async () => {
    const { fake, ids } = await built({ personal: ['A. User'] });
    const owner = readOnlyClient(scopeUserBoards(client(fake.fetch), ids));
    const blind = client((async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname.startsWith('/1/boards/')) return new Response('unauthorized permission requested', { status: 401 });
      return fake.fetch(input, init);
    }) as typeof fetch);
    const bot = readOnlyClient(scopeUserBoards(blind, ids));
    const o = await readBoards(owner, bot, ids);
    assert.ok(ROLES.every((r) => o.boards[r].exists));
    assert.equal(o.personalDetails, 1);
    assert.deepEqual(o.config, { problems: [] });
  });

  it('a board neither can read is observed as missing with its id', async () => {
    const { fake, ids } = await built();
    const api = readOnlyClient(scopeUserBoards(client(fake.fetch), { ...ids, jobs: 'f'.repeat(24) }));
    const o = await readBoards(api, api, { ...ids, jobs: 'f'.repeat(24) });
    assert.deepEqual(o.boards.jobs, { exists: false, id: 'f'.repeat(24) });
  });
});

// ── the CLI ───────────────────────────────────────────────────────────────────

const SECRET = 'tok-SECRET-should-never-print';

async function runCli(argv: string[], fake: FakeTrello, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, { TRELLO_KEY: 'key-SECRET', TRELLO_TOKEN: SECRET, ...env }, {
    fetch: noBoardListing(fake),
    out: (s) => lines.push(s),
    readState: () => null,
  });
  return { code, out: lines.join('\n') };
}

describe('tools/onboard.ts', () => {
  it('the CLI dry run makes no write', async () => {
    const { fake, ids } = await built({ personal: [], botMember: false });
    const lines: string[] = [];
    const code = await main(['--dry-run', '--owner-user', 'usera', '--url', 'https://worker.example.com'], { TRELLO_KEY: 'key-SECRET', TRELLO_TOKEN: SECRET }, {
      fetch: noBoardListing(fake),
      out: (s) => lines.push(s),
      readState: () => ids,
    });
    const out = lines.join('\n');
    assert.equal(code, 0, out);
    assert.deepEqual(fake.requests.filter((r) => r.method !== 'GET'), []);
    assert.ok(fake.requests.length > 0);
    assert.match(out, /System: add member samplebot/);
    assert.match(out, /Jobs: webhook to https:\/\/worker\.example\.com\/trello/);
    assert.match(out, /Personal details is empty/);
    assert.ok(!out.includes(SECRET) && !out.includes('key-SECRET'));
  });

  it('half set up over FakeTrello: Settings with other YAML is left alone, only the missing Rubric is planned', async () => {
    const { fake, ids } = await built({ personal: ['A. User'] });
    const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
    const sys = await raw.cards(ids.system, { filter: 'open' });
    fake.setCardDesc(sys.find((c) => c.name === 'Settings')!.id, SETTINGS_OTHER);
    const prof = await raw.cards(ids.profiles, { filter: 'open' });
    await raw.setCardClosed(prof.find((c) => c.name === 'Rubric')!.id, true);
    fake.requests = [];
    const lines: string[] = [];
    const code = await main(['--dry-run', '--owner-user', 'usera'], { TRELLO_KEY: 'k', TRELLO_TOKEN: SECRET }, {
      fetch: noBoardListing(fake),
      out: (s) => lines.push(s),
      readState: () => ids,
    });
    const out = lines.join('\n');
    assert.equal(code, 0, out);
    const willDo = out.slice(out.indexOf('Will do:'), out.indexOf('Check by hand:'));
    assert.equal(willDo, 'Will do:\n  Profiles: create card "Rubric" in "My profile"\n');
    assert.ok(!out.includes('Europe/Paris'));
    assert.deepEqual(fake.requests.filter((r) => r.method !== 'GET'), []);
  });

  it('refusals exit 1, with no write', async () => {
    const { fake, ids } = await built({ personal: ['A. User'] });
    fake.addBoardMember(ids.jobs, { id: 'c'.repeat(24), username: 'stranger' });
    const lines: string[] = [];
    const code = await main(['--dry-run', '--owner-user', 'usera'], { TRELLO_KEY: 'k', TRELLO_TOKEN: SECRET }, {
      fetch: noBoardListing(fake),
      out: (s) => lines.push(s),
      readState: () => ids,
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /Jobs: extra member stranger/);
    assert.deepEqual(fake.requests.filter((r) => r.method !== 'GET'), []);
  });

  it('a fresh dry run reads no board at all', async () => {
    const fake = new FakeTrello();
    fake.addBoardMember((await createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch }).createBoard('other', 'org')).id, USER_A);
    fake.requests = [];
    const { code, out } = await runCli(['--dry-run', '--owner-user', 'usera'], fake);
    assert.equal(code, 0, out);
    assert.match(out, /create board "career-cards · Jobs"/);
    assert.ok(fake.requests.every((r) => r.method === 'GET' && !r.path.startsWith('/boards')));
  });

  it('needs --owner-user without owner credentials', async () => {
    const { code, out } = await runCli(['--dry-run'], new FakeTrello());
    assert.equal(code, 2);
    assert.match(out, /--owner-user/);
  });

  it('an unknown --owner-user is refused', async () => {
    const { code, out } = await runCli(['--dry-run', '--owner-user', 'nobody'], new FakeTrello());
    assert.equal(code, 2);
    assert.match(out, /nobody/);
  });

  it('--owner-user must match the owner token\'s account', async () => {
    const fake = new FakeTrello();
    const { code, out } = await runCli(['--dry-run', '--owner-user', 'usera'], fake, { OWNER_TRELLO_KEY: 'ok', OWNER_TRELLO_TOKEN: 'ot' });
    assert.equal(code, 2);
    assert.match(out, /--owner-user/);
  });

  it('--url must be https', async () => {
    const { code, out } = await runCli(['--dry-run', '--owner-user', 'usera', '--url', 'http://worker.example.com'], new FakeTrello());
    assert.equal(code, 2);
    assert.match(out, /https/);
  });

  it('--url must have no path', async () => {
    const { code, out } = await runCli(['--dry-run', '--owner-user', 'usera', '--url', 'https://x.code.run/api'], new FakeTrello());
    assert.equal(code, 2);
    assert.match(out, /path/);
  });

  it('a state file with a malformed id is refused before any request', async () => {
    const fake = new FakeTrello();
    const lines: string[] = [];
    const code = await main(['--dry-run', '--owner-user', 'usera'], { TRELLO_KEY: 'k', TRELLO_TOKEN: 't' }, {
      fetch: fake.fetch,
      out: (s) => lines.push(s),
      readState: () => ({ jobs: '../members/me/boards' }),
    });
    assert.equal(code, 2);
    assert.deepEqual(fake.requests, []);
  });
});
