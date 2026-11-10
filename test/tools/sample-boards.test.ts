import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import type { FetchLike } from '../../src/trello/client.ts';
import { SAMPLE_NAMES, denyBoardListing, pickBotWorkspace, verifySampleBoards } from '../../tools/sample/guard.ts';
import { personalStrings, scrubRecording, scrubRecordings } from '../../tools/sample/scrub.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const ME = { id: 'a'.repeat(24), username: 'samplebot' };
const OTHER = { id: 'b'.repeat(24), username: 'someone' };
const WS = 'c'.repeat(24);
const STATE = { workspace: WS, jobs: '1'.repeat(24), profiles: '2'.repeat(24), system: '3'.repeat(24) };

type Routes = Record<string, unknown>;

/** A client over a stub fetch answering GETs by path; records every request. */
function stubApi(routes: Routes) {
  const requests: { method: string; path: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/1/, '');
    requests.push({ method, path });
    if (method !== 'GET' || !(path in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = createTrelloClient({ key: 'k', token: 't', fetchImpl, sleep: async () => {} });
  return { api, requests };
}

const board = (id: string, name: string, idOrganization = WS) => ({
  id, name, closed: false, idOrganization, prefs: { permissionLevel: 'private' },
});

function sampleRoutes(): Routes {
  return {
    '/members/me': ME,
    [`/boards/${STATE.jobs}`]: board(STATE.jobs, SAMPLE_NAMES.jobs),
    [`/boards/${STATE.profiles}`]: board(STATE.profiles, SAMPLE_NAMES.profiles),
    [`/boards/${STATE.system}`]: board(STATE.system, SAMPLE_NAMES.system),
    [`/boards/${STATE.jobs}/members`]: [ME],
    [`/boards/${STATE.profiles}/members`]: [ME],
    [`/boards/${STATE.system}/members`]: [ME],
  };
}

test('verifySampleBoards accepts the three sample boards', async () => {
  const { api } = stubApi(sampleRoutes());
  await verifySampleBoards(api, STATE);
});

test('verifySampleBoards refuses a board named "My Trello board"', async () => {
  const routes = sampleRoutes();
  routes[`/boards/${STATE.profiles}`] = board(STATE.profiles, 'My Trello board');
  const { api, requests } = stubApi(routes);
  await assert.rejects(verifySampleBoards(api, STATE), /not a sample board/);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
});

test('verifySampleBoards refuses a sample-named board with another member', async () => {
  const routes = sampleRoutes();
  routes[`/boards/${STATE.system}/members`] = [ME, OTHER];
  const { api, requests } = stubApi(routes);
  await assert.rejects(verifySampleBoards(api, STATE), /members/);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
});

test('verifySampleBoards refuses a sample-named board in another workspace', async () => {
  const routes = sampleRoutes();
  routes[`/boards/${STATE.jobs}`] = board(STATE.jobs, SAMPLE_NAMES.jobs, 'd'.repeat(24));
  const { api, requests } = stubApi(routes);
  await assert.rejects(verifySampleBoards(api, STATE), /workspace/);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
});

test('verifySampleBoards refuses a sample-named board that is not private', async () => {
  const routes = sampleRoutes();
  routes[`/boards/${STATE.jobs}`] = { ...board(STATE.jobs, SAMPLE_NAMES.jobs), prefs: { permissionLevel: 'org' } };
  const { api } = stubApi(routes);
  await assert.rejects(verifySampleBoards(api, STATE), /private/);
});

test('pickBotWorkspace picks the one workspace whose only member is the bot', async () => {
  const { api } = stubApi({
    '/members/me': ME,
    '/members/me/organizations': [{ id: 'e'.repeat(24), displayName: 'Shared' }, { id: WS, displayName: 'Bot' }],
    [`/organizations/${'e'.repeat(24)}/members`]: [ME, OTHER],
    [`/organizations/${WS}/members`]: [ME],
  });
  assert.equal(await pickBotWorkspace(api), WS);
});

test('pickBotWorkspace refuses when the bot\'s workspaces all have other members', async () => {
  const { api } = stubApi({
    '/members/me': ME,
    '/members/me/organizations': [{ id: 'e'.repeat(24), displayName: 'Family' }, { id: WS, displayName: 'Team' }],
    [`/organizations/${'e'.repeat(24)}/members`]: [ME, OTHER],
    [`/organizations/${WS}/members`]: [OTHER, ME],
  });
  await assert.rejects(pickBotWorkspace(api), (e: Error) => {
    assert.match(e.message, /Family, Team/);
    assert.doesNotMatch(e.message, /someone|eeee|cccc/);
    return true;
  });
});

test('denyBoardListing throws on /members/me/boards, /organizations/x/boards, /search', async () => {
  const calls: string[] = [];
  const inner = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('[]');
  }) as typeof fetch;
  const f = denyBoardListing(inner);
  for (const u of [
    'https://api.trello.com/1/members/me/boards',
    'https://api.trello.com/1/members/somebot/boards?filter=open',
    'https://api.trello.com/1/organizations/x/boards',
    'https://api.trello.com/1/search?query=cv',
    'https://api.trello.com/1/search/members',
    'https://api.trello.com/1/members/me?boards=all',
  ]) {
    await assert.rejects(async () => f(new URL(u)), /board listing/, u);
  }
  assert.deepEqual(calls, []);
  await f(new URL('https://api.trello.com/1/members/me/organizations?fields=id'));
  await f('https://api.trello.com/1/boards/abc/lists');
  assert.equal(calls.length, 2);
});

const id = (n: number) => n.toString(16).padStart(24, '9');

test('scrub keeps id order and maps the same id the same way across files', () => {
  // Two "files" that mention the same board id; ids appear out of order.
  const big = 'ff' + id(1).slice(2);
  const small = '11' + id(2).slice(2);
  const mid = '88' + id(3).slice(2);
  const files: Record<string, Recording> = {
    a: [{ method: 'GET', path: `/boards/${mid}/cards/all`, query: { before: big, limit: '1000' }, status: 200, body: [{ id: big, idBoard: mid }] }],
    b: [{ method: 'GET', path: `/cards/${small}`, query: {}, status: 200, body: { id: small, idBoard: mid, nodeId: `ari:card/${small}` } }],
  };
  const out = scrubRecordings(files, { botUsername: 'realbot' });
  const sid = (s: string) => {
    assert.match(s, /^fa4e[0-9a-f]{20}$/);
    return s;
  };
  const [a] = out.a!;
  const [b] = out.b!;
  const boardA = sid((a!.body as { idBoard: string }[])[0]!.idBoard);
  const boardB = sid((b!.body as { idBoard: string }).idBoard);
  assert.equal(boardA, boardB);
  assert.equal(a!.path, `/boards/${boardA}/cards/all`);
  const sBig = sid(a!.query.before!);
  const sSmall = sid((b!.body as { id: string }).id);
  assert.ok(sSmall < boardA && boardA < sBig, 'sorted order of real ids is kept');
  assert.equal(b!.path, `/cards/${sSmall}`);
  assert.equal((b!.body as { nodeId: string }).nodeId, `ari:card/${sSmall}`);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(`${big}|${small}|${mid}`));
});

test('scrub removes usernames, url, shortLink and background images', () => {
  const rec: Recording = [{
    method: 'GET', path: '/boards/x', query: {}, status: 200,
    body: {
      name: 'Board of RealBot',
      url: 'https://trello.com/b/AbCd/real',
      shortLink: 'AbCd',
      shortUrl: 'https://trello.com/b/AbCd',
      prefs: { permissionLevel: 'private', backgroundImage: 'https://x/y.jpg', backgroundImageScaled: [{ url: 'https://x' }], background: 'blue' },
      members: [{ id: 'm', username: 'realbot', fullName: 'Real Person', avatarUrl: 'https://a', initials: 'RP', email: 'r@x' }],
      cards: [{ shortUrl: 'https://trello.com/c/Qwer' }, { shortUrl: 'https://trello.com/c/Zxcv' }, { shortUrl: 'https://trello.com/c/Qwer' }],
      memberCreator: { id: 'm', fullName: 'Real Person' },
      entities: [{ type: 'member', username: 'realbot', text: 'Real Person' }],
    },
  }];
  const [r] = scrubRecording(rec, { botUsername: 'RealBot' });
  const body = r!.body as Record<string, any>;
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /realbot|Real Person|AbCd|https:\/\/x|https:\/\/a|r@x|"RP"/i);
  assert.equal(body.url, undefined);
  assert.equal(body.entities, undefined);
  assert.equal(body.shortLink, undefined);
  assert.deepEqual(body.prefs, { permissionLevel: 'private', background: 'blue' });
  assert.equal(body.members[0].username, 'samplebot');
  assert.equal(body.name, 'Board of samplebot');
  assert.deepEqual(body.cards.map((c: { shortUrl: string }) => c.shortUrl), [
    'https://trello.com/c/sample002', 'https://trello.com/c/sample003', 'https://trello.com/c/sample002',
  ]);
  assert.equal(body.shortUrl, 'https://trello.com/c/sample001');
});

test('the layout\'s YAML blocks pass the config schemas, and the Jobs board needs two pages', async () => {
  const { LAYOUT, cardCount } = await import('../../tools/sample/layout.ts');
  const { parseYamlBlock, SettingsSchema, ProfileMetaSchema, PreferencesSchema } = await import('../../src/config/schema.ts');
  const card = (board: 'profiles' | 'system', list: string, name: string) =>
    LAYOUT[board].lists.find((l) => l.name === list)!.cards.find((c) => c.name === name)!.desc;
  SettingsSchema.parse(parseYamlBlock(card('system', 'Config', 'Settings')));
  PreferencesSchema.parse(parseYamlBlock(card('profiles', 'Shared', 'Preferences')));
  assert.equal(ProfileMetaSchema.parse(parseYamlBlock(card('profiles', 'Content editor', 'Profile'))).active, true);
  assert.equal(ProfileMetaSchema.parse(parseYamlBlock(card('profiles', 'Copywriter', 'Profile'))).active, false);
  assert.equal(cardCount(LAYOUT.jobs), 1062);
});

test('personalStrings finds member names, initials and emails, comment entities included', () => {
  const rec: Recording = [{
    method: 'POST', path: '/x', query: {}, status: 200,
    body: { memberCreator: { fullName: 'Real Person', initials: 'RP', username: 'realbot' }, entities: [{ type: 'member', text: 'Shown Name' }, { type: 'text', text: 'on' }] },
  }];
  assert.deepEqual(personalStrings(rec).sort(), ['RP', 'Real Person', 'Shown Name', 'realbot']);
});
