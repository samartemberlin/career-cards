// Tests for --relay, --repo, and --replace-webhooks flags added in Task 4.
// User A is the board owner; bot is the Trello bot account.
// No personal data: usernames and board ids are generic placeholders.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTrello } from '../support/fake-trello.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import type { TMember } from '../../src/trello/api.ts';
import type { BoardIds, Role } from '../../tools/onboard/plan.ts';
import { replaceWebhooks } from '../../tools/onboard/apply.ts';
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
// RELAY_PATH_SECRET must be at least 32 characters.
const RELAY_SECRET = 'relay-path-secret-32chars-exactly!';

/** A minimal fetch that handles /members/me and delegates everything else to FakeTrello. */
function twoMembers(fake: FakeTrello): typeof fetch {
  const byToken: Record<string, TMember> = { [ENV.TRELLO_TOKEN]: BOT, [ENV.OWNER_TRELLO_TOKEN]: OWNER };
  const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const path = u.pathname.replace(/^\/1(?=\/)/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const actor = byToken[/oauth_token="([^"]*)"/.exec(auth)?.[1] ?? ''];
    if (!actor) throw new Error('unknown token');
    if (/^\/(members|organizations)\/[^/]+\/boards/.test(path) || u.searchParams.has('boards') || path.startsWith('/search')) {
      throw new Error(`listed boards: ${path}`);
    }
    if (method === 'GET' && path === '/members/me') return json(actor);
    if (method === 'GET' && /^\/members\/([^/]+)$/.test(path)) {
      const id = /^\/members\/([^/]+)$/.exec(path)?.[1];
      const k = [BOT, OWNER].find((x) => x.username === id || x.id === id);
      return k ? json(k) : new Response('not found', { status: 404 });
    }
    if (method === 'PUT' && /^\/boards\/([^/]+)\/members\/([^/]+)$/.test(path)) {
      const m = /^\/boards\/([^/]+)\/members\/([^/]+)$/.exec(path)!;
      const k = [BOT, OWNER].find((x) => x.id === m[2]);
      if (!k) return new Response('invalid member', { status: 400 });
      fake.addBoardMember(m[1]!, k);
      return json({ id: m[1] });
    }
    const res = await fake.fetch(input, init);
    if (method === 'POST' && path === '/boards' && res.ok) {
      const b = await res.clone().json() as { id: string };
      fake.addBoardMember(b.id, actor);
    }
    return res;
  }) as typeof fetch;
}

type Cli = { code: number; out: string };

function cli(fake: FakeTrello, state: { ids: Partial<BoardIds> }, fetchOverride?: typeof fetch) {
  const f = fetchOverride ?? twoMembers(fake);
  return async (argv: string[], env: Record<string, string> = ENV): Promise<Cli> => {
    const lines: string[] = [];
    const code = await main(argv, env, {
      fetch: f,
      sleep: async () => {},
      out: (s) => lines.push(s),
      readState: () => ({ ...state.ids }),
      writeState: (_file, ids) => { state.ids = { ...ids }; },
    });
    return { code, out: lines.join('\n') };
  };
}

const clientFor = (f: typeof fetch) => createTrelloClient({
  key: ENV.TRELLO_KEY,
  token: ENV.TRELLO_TOKEN,
  fetchImpl: denyBoardListing(f),
  sleep: async () => {},
});

/** Create all three boards and return their ids. */
async function boards(): Promise<{ fake: FakeTrello; ids: BoardIds }> {
  const fake = new FakeTrello();
  const state: { ids: Partial<BoardIds> } = { ids: {} };
  const { code, out } = await cli(fake, state)(['--workspace', WS]);
  assert.equal(code, 0, `board setup failed:\n${out}`);
  return { fake, ids: state.ids as BoardIds };
}

describe('--relay and --repo', () => {
  it('callback URL is built from --relay and --repo (sig present, boards created, variables printed)', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--workspace', WS, '--relay', 'https://relay.example.com', '--repo', 'org/myrepo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    // The callback URL is a relay path; it should not say /trello.
    const webhookCalls = fake.requests.filter((r) => r.method === 'POST' && r.path === '/webhooks');
    assert.equal(webhookCalls.length, 3, `expected 3 webhook creates, got:\n${out}`);
    // Variables block: JOBS_BOARD_ID, PROFILES_BOARD_ID, SYSTEM_BOARD_ID, BOT_USERNAME
    assert.match(out, /JOBS_BOARD_ID=[0-9a-f]{24}/);
    assert.match(out, /PROFILES_BOARD_ID=[0-9a-f]{24}/);
    assert.match(out, /SYSTEM_BOARD_ID=[0-9a-f]{24}/);
    assert.match(out, /BOT_USERNAME=samplebot/);
    // No automation-rule hint with --relay
    assert.ok(!/automation rule/i.test(out), `unexpected automation hint:\n${out}`);
    assert.ok(!/Create this/.test(out), `unexpected automation hint:\n${out}`);
  });

  it('--relay builds a /hook/<owner>/<repo>/<sig> URL, not /trello', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--workspace', WS, '--relay', 'https://relay.example.com', '--repo', 'org/myrepo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    // Inspect the webhook callback URLs registered in FakeTrello.
    // FakeTrello stores them keyed by `${idModel}\0${callbackURL}`.
    // We verify via tokenWebhooks().
    const bot = clientFor(fake.fetch);
    const hooks = await bot.tokenWebhooks();
    assert.equal(hooks.length, 3);
    for (const h of hooks) {
      assert.match(h.callbackURL, /^https:\/\/relay\.example\.com\/hook\/org\/myrepo\/[A-Za-z0-9_-]{22}$/);
      assert.ok(!h.callbackURL.endsWith('/trello'), `callback must not end with /trello: ${h.callbackURL}`);
    }
    // All three boards get the same callback URL.
    const urls = new Set(hooks.map((h) => h.callbackURL));
    assert.equal(urls.size, 1);
  });

  it('a bad --repo (extra slash) → usage 2', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--relay', 'https://relay.example.com', '--repo', 'org/repo/extra'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 2, out);
    assert.match(out, /--repo/);
  });

  it('a bad --repo (empty part) → usage 2', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--relay', 'https://relay.example.com', '--repo', '/repo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 2, out);
  });

  it('--relay without --repo → usage 2', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const { code, out } = await cli(fake, state)(
      ['--relay', 'https://relay.example.com'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 2, out);
    assert.match(out, /--relay requires --repo/);
  });

  it('--url and --relay together → usage 2', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const { code, out } = await cli(fake, state)(
      ['--url', 'https://host.example.com', '--relay', 'https://relay.example.com', '--repo', 'org/repo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 2, out);
    assert.match(out, /mutually exclusive/);
  });

  it('no automation rule is printed with --relay', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--workspace', WS, '--relay', 'https://relay.example.com', '--repo', 'org/myrepo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    assert.ok(!/Create this automation rule/.test(out), `should not print automation rule:\n${out}`);
    assert.ok(!/TRIGGER_SECRET/.test(out), `should not print TRIGGER_SECRET:\n${out}`);
  });

  it('--url still prints the automation rule (unchanged behaviour)', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--workspace', WS, '--url', 'https://host.example.com'],
    );
    assert.equal(code, 0, out);
    assert.match(out, /Create this automation rule/);
    assert.match(out, /TRIGGER_SECRET/);
    assert.ok(!/BOT_USERNAME/.test(out), `should not print BOT_USERNAME with --url:\n${out}`);
  });

  it('the relay sig (derived from RELAY_PATH_SECRET) is never printed in output', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    const run = cli(fake, state);
    const { code, out } = await run(
      ['--workspace', WS, '--relay', 'https://relay.example.com', '--repo', 'org/myrepo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    // We verify the full relay hook path (containing the sig) is not in the output.
    assert.ok(!out.includes('/hook/'), `relay hook path must not appear in output:\n${out}`);
    // The secret itself must not appear.
    assert.ok(!out.includes(RELAY_SECRET), `RELAY_PATH_SECRET must not appear in output:\n${out}`);
  });
});

describe('--replace-webhooks', () => {
  it('replaceWebhooks deletes only differing webhooks on the three named boards', async () => {
    const { fake, ids } = await boards();
    const bot = clientFor(fake.fetch);
    // Create webhooks pointing at an old callback URL.
    const OLD_URL = 'https://old.example.com/trello';
    const NEW_URL = 'https://new.example.com/trello';
    for (const role of ROLES) {
      await bot.createWebhook(ids[role], OLD_URL, `career-cards ${role}`);
    }
    const before = await bot.tokenWebhooks();
    assert.equal(before.length, 3);
    // Replace: delete the ones pointing at OLD_URL, leave NEW_URL alone.
    const result = await replaceWebhooks(bot, ids, NEW_URL);
    assert.equal(result.length, 3, 'all three boards had differing webhooks');
    assert.ok(result.every((r) => r.deleted), 'all three should be deleted');
    const after = await bot.tokenWebhooks();
    assert.equal(after.length, 0, 'all old webhooks removed');
  });

  it('replaceWebhooks skips webhooks that already match the new URL', async () => {
    const { fake, ids } = await boards();
    const bot = clientFor(fake.fetch);
    const SAME_URL = 'https://relay.example.com/hook/org/repo/abcdefghijklmnopqrstuv';
    // Create webhooks pointing at the new callback URL already.
    for (const role of ROLES) {
      await bot.createWebhook(ids[role], SAME_URL, `career-cards ${role}`);
    }
    // No webhooks differ, nothing should be deleted.
    const result = await replaceWebhooks(bot, ids, SAME_URL);
    assert.equal(result.length, 0, 'no webhooks differ');
    const after = await bot.tokenWebhooks();
    assert.equal(after.length, 3, 'webhooks unchanged');
  });

  it('replaceWebhooks only touches the three named boards, not others', async () => {
    const { fake, ids } = await boards();
    const bot = clientFor(fake.fetch);
    const OLD_URL = 'https://old.example.com/trello';
    const NEW_URL = 'https://new.example.com/trello';
    // Create a webhook on jobs only.
    await bot.createWebhook(ids.jobs, OLD_URL, 'career-cards jobs');
    const result = await replaceWebhooks(bot, ids, NEW_URL);
    assert.equal(result.length, 1, 'only jobs webhook differs');
    assert.equal(result[0]!.board, 'jobs');
    assert.ok(result[0]!.deleted);
  });

  it('--dry-run deletes nothing', async () => {
    const { fake, ids } = await boards();
    const bot = clientFor(fake.fetch);
    const OLD_URL = 'https://old.example.com/trello';
    const NEW_URL = 'https://new.example.com/trello';
    for (const role of ROLES) {
      await bot.createWebhook(ids[role], OLD_URL, `career-cards ${role}`);
    }
    // Run with dryRun: true
    const result = await replaceWebhooks(bot, ids, NEW_URL, { dryRun: true });
    assert.equal(result.length, 3);
    assert.ok(result.every((r) => r.skipped && !r.deleted), 'dry run: skipped not deleted');
    // Webhooks still exist
    const after = await bot.tokenWebhooks();
    assert.equal(after.length, 3, 'webhooks unchanged in dry run');
    // No DELETE calls were made
    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    assert.equal(deletes.length, 0, 'no DELETE requests in dry run');
  });

  it('CLI --replace-webhooks --dry-run prints "would be deleted" and makes no DELETE calls', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    // First set up boards
    await cli(fake, state)(['--workspace', WS]);
    const ids = state.ids as BoardIds;
    // Add an old webhook on each board.
    const bot = clientFor(fake.fetch);
    const OLD_URL = 'https://old.example.com/trello';
    for (const role of ROLES) {
      await bot.createWebhook(ids[role], OLD_URL, `career-cards ${role}`);
    }
    fake.requests = [];
    const { code, out } = await cli(fake, state)(
      ['--dry-run', '--replace-webhooks', '--relay', 'https://relay.example.com', '--repo', 'org/repo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    // Should print "would be deleted" for each board
    assert.match(out, /would be deleted/);
    // No DELETE requests should be made
    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    assert.equal(deletes.length, 0, `unexpected DELETE requests in dry run:\n${out}`);
  });

  it('CLI --replace-webhooks deletes differing webhooks and prints "webhook deleted <title>"', async () => {
    const fake = new FakeTrello();
    const state: { ids: Partial<BoardIds> } = { ids: {} };
    await cli(fake, state)(['--workspace', WS]);
    const ids = state.ids as BoardIds;
    const bot = clientFor(fake.fetch);
    const OLD_URL = 'https://old.example.com/trello';
    for (const role of ROLES) {
      await bot.createWebhook(ids[role], OLD_URL, `career-cards ${role}`);
    }
    const { code, out } = await cli(fake, state)(
      ['--replace-webhooks', '--relay', 'https://relay.example.com', '--repo', 'org/repo'],
      { ...ENV, RELAY_PATH_SECRET: RELAY_SECRET },
    );
    assert.equal(code, 0, out);
    assert.match(out, /webhook deleted Jobs/);
    assert.match(out, /webhook deleted Profiles/);
    assert.match(out, /webhook deleted System/);
    // Confirm webhooks are gone
    const remaining = await bot.tokenWebhooks();
    // The new webhooks were created by ensureWebhooks, old ones were deleted
    const oldHooks = remaining.filter((h) => h.callbackURL === OLD_URL);
    assert.equal(oldHooks.length, 0, 'old webhooks should be deleted');
  });
});
