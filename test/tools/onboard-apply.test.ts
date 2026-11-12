import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import type { TMember, TrelloApi } from '../../src/trello/api.ts';
import { ImmutableCardError, OriginalsWriteError, scopeUserBoards } from '../../src/trello/scoped.ts';
import { starterLayout } from '../../tools/onboard/starter.ts';
import type { BoardIds, OnboardPlan, Role } from '../../tools/onboard/plan.ts';
import { SaveIdsFailed, applyPlan, automationRule, checklistWriter, ensureWebhooks } from '../../tools/onboard/apply.ts';
import { denyBoardListing } from '../../tools/sample/guard.ts';
import { main } from '../../tools/onboard.ts';

const ROLES: Role[] = ['jobs', 'profiles', 'system'];
const OWNER: TMember = { id: 'a1'.padEnd(24, '0'), username: 'usera' };
const BOT: TMember = { id: 'b0'.padEnd(24, '0'), username: 'samplebot' };
const WS = 'e'.repeat(24);
const ENV = {
  TRELLO_KEY: 'key-bot-SECRET',
  TRELLO_TOKEN: 'tok-bot-SECRET',
  OWNER_TRELLO_KEY: 'key-owner-SECRET',
  OWNER_TRELLO_TOKEN: 'tok-owner-SECRET',
};

type Call = { actor: string; method: string; path: string };

/**
 * One FakeTrello seen by two accounts, told apart by the token in the auth header. Like Trello, the creator of a
 * board becomes its member. Any board listing fails the test.
 */
function twoMembers(fake: FakeTrello, calls: Call[] = [], o: { failNth?: { method: string; path: RegExp; n: number } } = {}): typeof fetch {
  const byToken: Record<string, TMember> = { [ENV.TRELLO_TOKEN]: BOT, [ENV.OWNER_TRELLO_TOKEN]: OWNER };
  const members = new Set<string>();
  let seen = 0;
  const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const path = u.pathname.replace(/^\/1(?=\/)/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const actor = byToken[/oauth_token="([^"]*)"/.exec(auth)?.[1] ?? ''];
    if (!actor) throw new Error('unknown token');
    calls.push({ actor: actor.username, method, path });
    if (/^\/(members|organizations)\/[^/]+\/boards/.test(path) || u.searchParams.has('boards') || path.startsWith('/search')) {
      throw new Error(`listed boards: ${path}`);
    }
    if (o.failNth && method === o.failNth.method && o.failNth.path.test(path) && ++seen === o.failNth.n) {
      return new Response('server error', { status: 500 });
    }
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/members/me') return json(actor);
    if (method === 'GET' && (m = /^\/members\/([^/]+)$/.exec(path))) {
      const k = [BOT, OWNER].find((x) => x.username === m![1] || x.id === m![1]);
      return k ? json(k) : new Response('not found', { status: 404 });
    }
    if (method === 'PUT' && (m = /^\/boards\/([^/]+)\/members\/([^/]+)$/.exec(path))) {
      const k = [BOT, OWNER].find((x) => x.id === m![2]);
      if (!k) return new Response('invalid member', { status: 400 });
      if (!members.has(`${m[1]}/${k.id}`)) fake.addBoardMember(m[1]!, k);
      members.add(`${m[1]}/${k.id}`);
      return json({ id: m[1] });
    }
    const res = await fake.fetch(input, init);
    if (method === 'POST' && path === '/boards' && res.ok) {
      const b = await res.clone().json() as { id: string };
      fake.addBoardMember(b.id, actor);
      members.add(`${b.id}/${actor.id}`);
    }
    return res;
  }) as typeof fetch;
}

const clientFor = (f: typeof fetch, who: 'bot' | 'owner'): TrelloApi => createTrelloClient({
  key: who === 'bot' ? ENV.TRELLO_KEY : ENV.OWNER_TRELLO_KEY,
  token: who === 'bot' ? ENV.TRELLO_TOKEN : ENV.OWNER_TRELLO_TOKEN,
  fetchImpl: denyBoardListing(f),
  sleep: async () => {},
});

type Cli = { code: number; out: string };

function cli(fake: FakeTrello, state: { ids: Partial<BoardIds>; saves?: number }, f: typeof fetch = twoMembers(fake)) {
  return async (argv: string[], env: Record<string, string> = ENV): Promise<Cli> => {
    const lines: string[] = [];
    const code = await main(argv, env, {
      fetch: f,
      sleep: async () => {},
      out: (s) => lines.push(s),
      readState: () => ({ ...state.ids }),
      writeState: (_file, ids) => {
        state.ids = { ...ids };
        state.saves = (state.saves ?? 0) + 1;
      },
    });
    return { code, out: lines.join('\n') };
  };
}

const writes = (fake: FakeTrello) => fake.requests.filter((r) => r.method !== 'GET');

/** Titles per list on each board, read straight from the fake. */
async function titles(fake: FakeTrello, ids: BoardIds): Promise<Record<Role, Record<string, string[]>>> {
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const out = {} as Record<Role, Record<string, string[]>>;
  for (const r of ROLES) {
    const lists = await raw.lists(ids[r], 'open');
    const cards = await raw.cards(ids[r], { filter: 'open' });
    out[r] = Object.fromEntries(lists.map((l) => [l.name, cards.filter((c) => c.idList === l.id).map((c) => c.name).sort()]));
  }
  return out;
}

const expected = (): Record<Role, Record<string, string[]>> => {
  const layout = starterLayout('usera');
  return Object.fromEntries(ROLES.map((r) => [r, Object.fromEntries(layout[r].lists.map((l) => [l.name, l.cards.map((c) => c.name).sort()]))])) as Record<Role, Record<string, string[]>>;
};

describe('applyPlan through the CLI', () => {
  it('fresh apply then re-plan is empty, and a second apply creates nothing', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const first = await run(['--workspace', WS]);
    assert.equal(first.code, 0, first.out);
    const after = first.out.slice(first.out.indexOf('After apply:'));
    assert.match(after, /Refused:\n  \(none\)\nWill do:\n  \(none\)\nCheck by hand:\n  Personal details is empty/);
    const ids = state.ids as BoardIds;
    assert.ok(ROLES.every((r) => /^[0-9a-f]{24}$/.test(ids[r])));
    assert.deepEqual(await titles(fake, ids), expected());
    assert.match(first.out, new RegExp(`JOBS_BOARD_ID=${ids.jobs} PROFILES_BOARD_ID=${ids.profiles} SYSTEM_BOARD_ID=${ids.system}`));

    fake.requests = [];
    const second = await run(['--workspace', WS]);
    assert.equal(second.code, 0, second.out);
    assert.deepEqual(writes(fake), []);
    assert.deepEqual(await titles(fake, ids), expected());
  });

  it('an interrupted apply resumes from saved ids without duplicate boards or cards', async () => {
    const fake = new FakeTrello();
    const calls: Call[] = [];
    const state: { ids: Partial<BoardIds>; saves?: number } = { ids: {} };
    const failing = twoMembers(fake, calls, { failNth: { method: 'POST', path: /^\/cards$/, n: 5 } });
    const first = await cli(fake, state, failing)(['--workspace', WS]);
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, /failed: Profiles: create card "Search keywords" in "My profile"/);
    assert.equal(state.saves, 3);
    // Ids are saved as each board is created, before anything is put on it.
    assert.ok(calls.findIndex((c) => c.method === 'POST' && c.path === '/lists') > calls.findIndex((c) => c.path === '/boards'));

    const second = await cli(fake, state)(['--workspace', WS]);
    assert.equal(second.code, 0, second.out);
    assert.equal(fake.requests.filter((r) => r.method === 'POST' && r.path === '/boards').length, 3);
    assert.deepEqual(await titles(fake, state.ids as BoardIds), expected());
  });

  it('a failed board creation leaves its actions failed and the other boards done; the rerun creates only that board', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const first = await cli(fake, state, twoMembers(fake, [], { failNth: { method: 'POST', path: /^\/boards$/, n: 2 } }))(['--workspace', WS]);
    assert.equal(first.code, 1, first.out);
    assert.deepEqual(Object.keys(state.ids).sort(), ['jobs', 'system']);
    assert.ok(!/BOARD_ID=/.test(first.out));
    const second = await cli(fake, state)(['--workspace', WS]);
    assert.equal(second.code, 0, second.out);
    assert.equal(fake.requests.filter((r) => r.method === 'POST' && r.path === '/boards').length, 3);
    assert.deepEqual(await titles(fake, state.ids as BoardIds), expected());
  });

  it('starter cards are created by the bot, boards and membership by the owner', async () => {
    const fake = new FakeTrello();
    const calls: Call[] = [];
    const { code, out } = await cli(fake, { ids: {} }, twoMembers(fake, calls))(['--workspace', WS]);
    assert.equal(code, 0, out);
    const by = (method: string, path: RegExp) => [...new Set(calls.filter((c) => c.method === method && path.test(c.path)).map((c) => c.actor))];
    assert.deepEqual(by('POST', /^\/boards$/), ['usera']);
    assert.deepEqual(by('PUT', /^\/boards\/[^/]+\/members\//), ['usera']);
    assert.deepEqual(by('POST', /^\/lists$/), ['samplebot']);
    assert.deepEqual(by('POST', /^\/cards$/), ['samplebot']);
    assert.deepEqual(by('POST', /^\/checklists/), ['samplebot']);
    assert.equal(calls.filter((c) => c.method === 'PUT' && c.path.includes('/members/')).length, 3);
  });

  it('without an owner token the bot creates the boards and adds the user', async () => {
    const fake = new FakeTrello();
    const calls: Call[] = [];
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const { code, out } = await cli(fake, state, twoMembers(fake, calls))(['--workspace', WS, '--owner-user', 'usera'], { TRELLO_KEY: ENV.TRELLO_KEY, TRELLO_TOKEN: ENV.TRELLO_TOKEN });
    assert.equal(code, 0, out);
    assert.ok(calls.every((c) => c.actor === 'samplebot'));
    assert.ok(calls.some((c) => c.method === 'PUT' && c.path.endsWith(`/members/${OWNER.id}`)));
    assert.deepEqual(await titles(fake, state.ids as BoardIds), expected());
  });

  it('creating boards needs --workspace, and nothing is written without it', async () => {
    const fake = new FakeTrello();
    const { code, out } = await cli(fake, { ids: {} })([]);
    assert.equal(code, 1, out);
    assert.match(out, /--workspace/);
    assert.deepEqual(writes(fake), []);
  });

  it('a plan with refusals is printed and nothing is written', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    fake.setBoardPermissionLevel(state.ids.jobs!, 'org');
    fake.requests = [];
    const { code, out } = await cli(fake, state)(['--workspace', WS, '--url', 'https://worker.example.com']);
    assert.equal(code, 1, out);
    assert.match(out, /Jobs: not private \(org\)/);
    assert.deepEqual(writes(fake), []);
  });
});

describe('applyPlan', () => {
  const plan = (actions: OnboardPlan['actions'], refuse: string[] = []): OnboardPlan => ({ refuse, actions, notes: [] });

  it('apply refuses a plan with refusals before any write', async () => {
    const fake = new FakeTrello();
    const calls: Call[] = [];
    const f = twoMembers(fake, calls);
    await assert.rejects(
      () => applyPlan(plan([{ kind: 'createBoard', board: 'jobs', name: 'career-cards · Jobs' }], ['Jobs: not private (org)']), {
        owner: clientFor(f, 'owner'), bot: clientFor(f, 'bot'), ids: {}, workspace: WS, saveIds: () => {}, out: () => {},
      }),
      /refus/i,
    );
    assert.deepEqual(calls, []);
  });

  it('a board id that cannot be saved stops the apply and names the board', async () => {
    const fake = new FakeTrello();
    const calls: Call[] = [];
    const f = twoMembers(fake, calls);
    const actions: OnboardPlan['actions'] = [
      { kind: 'createBoard', board: 'jobs', name: 'career-cards · Jobs' },
      { kind: 'createList', board: 'jobs', list: 'To apply' },
      { kind: 'createBoard', board: 'profiles', name: 'career-cards · Profiles' },
    ];
    const lines: string[] = [];
    const err = await applyPlan(plan(actions), {
      owner: clientFor(f, 'owner'), bot: clientFor(f, 'bot'), ids: {}, workspace: WS, out: (s) => lines.push(s),
      saveIds: () => { throw new Error('ENOENT: no such directory'); },
    }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof SaveIdsFailed);
    assert.match(err.message, /Jobs board [0-9a-f]{24} was created/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });

  it('a failed board creation tells the user to look in Trello before rerunning', async () => {
    const fake = new FakeTrello();
    const f = twoMembers(fake, [], { failNth: { method: 'POST', path: /^\/boards$/, n: 1 } });
    const r = await applyPlan(plan([{ kind: 'createBoard', board: 'jobs', name: 'career-cards · Jobs' }]), {
      owner: clientFor(f, 'owner'), bot: clientFor(f, 'bot'), ids: {}, workspace: WS, out: () => {}, saveIds: () => {},
    });
    assert.match(r.failed[0]!, /if the board shows in Trello, put its id in the state file/);
  });

  it('no existing card is changed', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    const ids = state.ids as BoardIds;
    const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
    const before = [...await raw.cards(ids.system, { filter: 'open', checklists: true }), ...await raw.cards(ids.profiles, { filter: 'open', checklists: true })];
    const settings = before.find((c) => c.name === 'Settings')!;
    const edited = '```yaml\ntimezone: Europe/Paris\nproviders: [groq]\nlocations: [berlin]\nallowed_members: [usera]\n```';
    fake.setCardDesc(settings.id, edited);
    // A missing card makes the apply write something next to the existing ones.
    await raw.setCardClosed(before.find((c) => c.name === 'Rubric')!.id, true);
    fake.requests = [];

    const { code, out } = await cli(fake, state)(['--workspace', WS]);
    assert.equal(code, 0, out);
    const w = writes(fake);
    assert.deepEqual(w.map((r) => `${r.method} ${r.path}`), ['POST /cards']);
    const now = [...await raw.cards(ids.system, { filter: 'open', checklists: true }), ...await raw.cards(ids.profiles, { filter: 'open', checklists: true })];
    assert.equal(now.find((c) => c.id === settings.id)!.desc, edited);
    for (const c of before.filter((x) => x.name !== 'Rubric')) {
      const n = now.find((x) => x.id === c.id)!;
      assert.deepEqual({ ...n, desc: '' }, { ...c, desc: '' });
    }
    const bot = scopeUserBoards(clientFor(fake.fetch, 'bot'), ids);
    assert.deepEqual(Object.keys(bot).filter((k) => /^(update|set|move|edit|rename)|^createChecklist$|^addCheckItem$/i.test(k)), []);
  });

  it('a checklist can only be added to a card created in this apply', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    const ids = state.ids as BoardIds;
    const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
    const sources = (await raw.cards(ids.system, { filter: 'open', checklists: true })).find((c) => c.name === 'Sources')!;
    fake.requests = [];
    const w = checklistWriter(clientFor(fake.fetch, 'bot'), { boards: ROLES.map((r) => ids[r]), profilesBoard: ids.profiles }, new Set());
    await assert.rejects(() => w.createChecklist(sources.id, 'More'), ImmutableCardError);
    await assert.rejects(() => w.addCheckItem(sources.checklists![0]!.id, 'x'), ImmutableCardError);
    assert.deepEqual(fake.requests, []);
  });

  it('a guard error stops everything; other failures are recorded and the rest continue', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    const ids = state.ids as BoardIds;
    const f = twoMembers(fake);
    const c = { owner: clientFor(f, 'owner'), bot: clientFor(f, 'bot'), ids, saveIds: () => {}, out: () => {} };
    const card = { name: 'Extra', desc: 'x' };
    fake.requests = [];
    await assert.rejects(
      () => applyPlan(plan([
        { kind: 'createCard', board: 'profiles', list: 'Originals', card },
        { kind: 'createCard', board: 'profiles', list: 'Shared', card },
      ]), c),
      OriginalsWriteError,
    );
    assert.deepEqual(writes(fake), []);

    const r = await applyPlan(plan([
      { kind: 'createCard', board: 'jobs', list: 'No such list', card },
      { kind: 'createCard', board: 'jobs', list: 'Applied', card },
    ]), c);
    assert.equal(r.done, 1);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0]!, /No such list/);
  });
});

describe('ensureWebhooks', () => {
  async function boards(): Promise<{ fake: FakeTrello; ids: BoardIds }> {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    return { fake, ids: state.ids as BoardIds };
  }

  it('ensureWebhooks: created, then exists on re-run', async () => {
    const { fake, ids } = await boards();
    const bot = clientFor(fake.fetch, 'bot');
    const first = await ensureWebhooks(bot, ids, 'https://worker.example.com');
    assert.deepEqual(first, ROLES.map((board) => ({ board, result: 'created' })));
    const again = await ensureWebhooks(bot, ids, 'https://worker.example.com/');
    assert.deepEqual(again, ROLES.map((board) => ({ board, result: 'exists' })));
  });

  it('ensureWebhooks: unreachable service is reported per board, not thrown', async () => {
    const { fake, ids } = await boards();
    fake.webhookHeadOk = false;
    const r = await ensureWebhooks(clientFor(fake.fetch, 'bot'), ids, 'https://worker.example.com');
    assert.deepEqual(r, ROLES.map((board) => ({
      board,
      result: 'service not reachable at https://worker.example.com/trello (deploy first, check PUBLIC_URL)',
    })));
  });
});

describe('automationRule', () => {
  it('automationRule prints the placeholder, never a secret', () => {
    const s = automationRule('https://w.example');
    assert.match(s, /\/trigger\/run\?key=<TRIGGER_SECRET>/);
    assert.equal(s, [
      'every day at 01:00, send a POST request to https://w.example/trigger/run?key=<TRIGGER_SECRET>',
      "paste TRIGGER_SECRET from your platform's secrets; Trello has no API for automations",
    ].join('\n'));
    assert.match(automationRule('https://w.example/', '06:30'), /^every day at 06:30, send a POST request to https:\/\/w\.example\/trigger\/run\?key=<TRIGGER_SECRET>\n/);
  });
});

describe('the CLI and secrets', () => {
  it('the CLI never prints an env value whose name matches KEY|TOKEN|SECRET', async () => {
    const env: Record<string, string> = {
      ...ENV,
      TRELLO_APP_SECRET: 'app-SECRET-1',
      TRIGGER_SECRET: 'trigger-SECRET-2',
      GEMINI_API_KEY: 'gemini-SECRET-3',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-SECRET-4',
      NORTHFLANK_API_TOKEN: 'nf-SECRET-5',
    };
    const secrets = Object.entries(env).filter(([k]) => /KEY|TOKEN|SECRET/.test(k)).map(([, v]) => v);
    const outs: string[] = [];
    for (const headOk of [true, false]) {
      const fake = new FakeTrello();
      fake.webhookHeadOk = headOk;
      const state: { ids: Partial<BoardIds> } = { ids: {} };
      const f = twoMembers(fake, [], { failNth: { method: 'POST', path: /^\/cards$/, n: 2 } });
      const { out } = await cli(fake, state, f)(['--workspace', WS, '--url', 'https://worker.example.com'], env);
      outs.push(out);
    }
    const all = outs.join('\n');
    assert.match(all, /<TRIGGER_SECRET>/);
    assert.match(all, /failed: /);
    assert.match(all, /service not reachable/);
    for (const s of secrets) assert.ok(!all.includes(s), `printed ${s}`);
  });
});
