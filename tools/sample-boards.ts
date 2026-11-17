// Creates and fills the three sample boards in the bot's own workspace, and captures their API responses as fixtures.
// Usage: node --env-file=<file with TRELLO_KEY, TRELLO_TOKEN> tools/sample-boards.ts setup|capture|share <member id>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../src/trello/client.ts';
import { scopeClient } from '../src/trello/scoped.ts';
import type { TrelloApi, TCard, TList } from '../src/trello/api.ts';
import { applyLayout, captureLookups } from './sample/apply.ts';
import type { Counts } from './sample/apply.ts';
import {
  SAMPLE_NAMES, SampleGuardError, denyBoardListing, pickBotWorkspace, rawPut, sampleDescWriter, verifySampleBoards, withAllowedMembers,
} from './sample/guard.ts';
import type { SampleBoard, SampleState } from './sample/guard.ts';
import { LAYOUT, cardCount } from './sample/layout.ts';
import { personalStrings, scrubRecordings } from './sample/scrub.ts';
import type { RecordedCall, Recording } from './sample/scrub.ts';

const STATE_FILE = join(import.meta.dirname, '.sample-boards.json');
const FIXTURES = join(import.meta.dirname, '..', 'test', 'fixtures', 'trello');
const BOARDS: SampleBoard[] = ['jobs', 'profiles', 'system'];

// Raw write responses from setup, kept until capture scrubs them with the same id map as the reads.
type State = Partial<SampleState> & { writes?: Record<string, RecordedCall> };

const WRITE_KINDS: [string, RegExp, string][] = [
  ['createCard', /^\/cards$/, 'POST'],
  ['comment', /^\/cards\/[^/]+\/actions\/comments$/, 'POST'],
  ['attachText', /^\/cards\/[^/]+\/attachments$/, 'POST'],
  ['setCardClosed', /^\/cards\/[^/]+$/, 'PUT'],
  ['createList', /^\/lists$/, 'POST'],
  ['setListClosed', /^\/lists\/[^/]+\/closed$/, 'PUT'],
  ['createLabel', /^\/labels$/, 'POST'],
  ['createChecklist', /^\/checklists$/, 'POST'],
  ['addCheckItem', /^\/checklists\/[^/]+\/checkItems$/, 'POST'],
];

function loadState(): State {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : {};
}

function saveState(s: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 });
}

function complete(s: State): SampleState {
  if (!s.workspace || !s.jobs || !s.profiles || !s.system) throw new Error(`${STATE_FILE} is incomplete: run setup`);
  return { workspace: s.workspace, jobs: s.jobs, profiles: s.profiles, system: s.system, ...(s.guests ? { guests: s.guests } : {}) };
}

/** Every request goes through denyBoardListing; `onCall` sees each response (credentials are in a header, never here). */
function recordingFetch(onCall: (c: RecordedCall) => void, counter: { n: number }): typeof fetch {
  const guarded = denyBoardListing(fetch);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    counter.n++;
    const res = await guarded(input, init);
    const u = new URL(input instanceof Request ? input.url : String(input));
    const query = Object.fromEntries([...u.searchParams].filter(([k]) => k !== 'key' && k !== 'token'));
    const text = await res.clone().text();
    let body: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
    onCall({ method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname.replace(/^\/1(?=\/)/, ''), query, status: res.status, body });
    return res;
  }) as typeof fetch;
}

function auth(): { key: string; token: string } {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error('TRELLO_KEY and TRELLO_TOKEN must be set (node --env-file=...)');
  return { key, token };
}

function rawClient(fetchImpl: typeof fetch): TrelloApi {
  return createTrelloClient({ ...auth(), fetchImpl });
}

async function setup(): Promise<void> {
  const state = loadState();
  const counter = { n: 0 };
  const recording = recordingFetch((c) => {
    if (c.method === 'GET' || c.status !== 200) return;
    const kind = WRITE_KINDS.find(([, re, m]) => m === c.method && re.test(c.path))?.[0];
    if (kind && !state.writes?.[kind]) {
      state.writes = { ...state.writes, [kind]: c };
      saveState(state);
    }
  }, counter);
  const raw = rawClient(recording);

  if (!state.workspace) {
    state.workspace = await pickBotWorkspace(raw);
    saveState(state);
  }
  let boardsCreated = 0;
  for (const b of BOARDS) {
    if (!state[b]) {
      state[b] = (await raw.createBoard(SAMPLE_NAMES[b], state.workspace)).id;
      saveState(state);
      boardsCreated++;
    }
  }
  const s = complete(state);
  await verifySampleBoards(raw, s);

  const api = scopeClient(raw, { boards: BOARDS.map((b) => s[b]), profilesBoard: s.profiles });
  const asUser = scopeClient(raw, { boards: BOARDS.map((b) => s[b]) });
  // The setup tool acts as the tester here; the bot's own client has no card edits. Not recorded: the fixtures'
  // PUT /cards/{id} is the archive call.
  const setDesc = sampleDescWriter(raw, rawPut(denyBoardListing(fetch), auth()), BOARDS.map((b) => s[b]));
  let total = boardsCreated;
  for (const b of BOARDS) {
    const made: Counts = { labels: 0, lists: 0, cards: 0, checklists: 0, items: 0, closedChanged: 0, descs: 0, listsArchived: 0 };
    await applyLayout({ api, asUser, setDesc }, s[b], LAYOUT[b], made, { converge: b !== 'jobs' });
    const n = Object.values(made).reduce((a, x) => a + x, 0);
    total += n;
    console.log(`${SAMPLE_NAMES[b]}: ${cardCount(LAYOUT[b])} cards in the layout; created ${JSON.stringify(made)}`);
  }
  const missing = WRITE_KINDS.map(([k]) => k).filter((k) => !state.writes?.[k]);
  console.log(`${boardsCreated} boards and ${total - boardsCreated} items created or changed, ${total} in all; ${counter.n} requests`);
  if (missing.length) console.log(`write kinds not recorded yet: ${missing.join(', ')}`);
}

async function capture(): Promise<void> {
  const state = loadState();
  const s = complete(state);
  const counter = { n: 0 };
  const files: Record<'jobs' | 'profiles' | 'system' | 'lookups' | 'comments', Recording> = { jobs: [], profiles: [], system: [], lookups: [], comments: [] };
  let into: Recording | null = null;
  const raw = rawClient(recordingFetch((c) => into?.push(c), counter));

  await verifySampleBoards(raw, s);
  const botUsername = (await raw.me()).username;
  const api = scopeClient(raw, { boards: BOARDS.map((b) => s[b]), profilesBoard: s.profiles });

  into = files.jobs;
  await api.board(s.jobs);
  await api.boardMembers(s.jobs);
  const jobLists = await api.lists(s.jobs, 'all');
  await api.labels(s.jobs);
  const jobCards = await api.allCards(s.jobs);
  const pages = files.jobs.filter((c) => c.path.endsWith('/cards/all')).length;

  const read: Partial<Record<SampleBoard, { lists: TList[]; cards: TCard[] }>> = {};
  for (const b of ['profiles', 'system'] as const) {
    into = files[b];
    await api.board(s[b]);
    await api.boardMembers(s[b]);
    read[b] = { lists: await api.lists(s[b], 'all'), cards: await api.cards(s[b], { filter: 'open', checklists: true }) };
  }

  into = files.lookups;
  const jobCard = await captureLookups(api, {
    jobLists, jobCards, profileLists: read.profiles!.lists, profileCards: read.profiles!.cards, systemCards: read.system!.cards,
  });
  into = null;

  // Comments: capture GET /cards/{id}/actions for the job card with a known comment,
  // and GET /boards/{id}/actions for the whole jobs board.
  // jobCard is the first open non-ℹ card in RUN_COLUMN; layout.ts adds a comment to job n=1.
  into = files.comments;
  await api.cardComments(jobCard.id);
  await api.boardComments(s.jobs, { since: '2026-01-01T00:00:00.000Z' });
  into = null;

  const missing = WRITE_KINDS.map(([k]) => k).filter((k) => !state.writes?.[k]);
  if (missing.length) throw new Error(`setup has not recorded these writes yet: ${missing.join(', ')}`);
  const writes: Recording = WRITE_KINDS.map(([k]) => state.writes![k]!);

  const all = { ...files, writes };
  assertOnlySampleBoards(all, s);
  const scrubbed = scrubRecordings(all, { botUsername });
  const personal = [botUsername, ...personalStrings(Object.values(all).flat())].filter((p) => p !== 'samplebot');
  const out = JSON.stringify(scrubbed).toLowerCase();
  // Initials are too short to search for inside words; they are only looked for as whole values.
  const survives = (p: string): boolean => out.includes(p.length < 4 ? JSON.stringify(p.toLowerCase()) : p.toLowerCase());
  if (personal.some(survives)) throw new SampleGuardError('a member name survived scrubbing: nothing written');
  for (const [name, rec] of Object.entries(scrubbed)) {
    writeFileSync(join(FIXTURES, `${name}.recording.json`), JSON.stringify(rec, null, 1) + '\n');
    console.log(`${name}.recording.json: ${rec.length} calls`);
  }
  const expected = cardCount(LAYOUT.jobs);
  console.log(`day-one check: allCards read ${jobCards.length} cards in ${pages} pages; the layout has ${expected}: ${jobCards.length === expected ? 'OK' : 'MISMATCH'}`);
  console.log(`${counter.n} requests`);
  if (jobCards.length !== expected) process.exitCode = 1;
}

/** A last check before anything is written: every board id in the capture is a sample board. */
function assertOnlySampleBoards(files: Record<string, Recording>, s: SampleState): void {
  const ok = new Set(BOARDS.map((b) => s[b]));
  const check = (v: unknown, key?: string): void => {
    if (Array.isArray(v)) return v.forEach((x) => check(x, key));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => check(x, k));
    if (key === 'idBoard' && typeof v === 'string' && !ok.has(v)) throw new SampleGuardError('capture holds a non-sample board: nothing written');
  };
  for (const rec of Object.values(files)) {
    for (const c of rec) {
      const m = /^\/boards\/([^/]+)/.exec(c.path);
      if (m && !ok.has(m[1]!)) throw new SampleGuardError('capture holds a non-sample board: nothing written');
      check(c.body);
    }
  }
}

/**
 * Adds a test bot (by member id) to the three boards and makes the account running this tool the Settings card's
 * only allowed member, so the test bot can be driven with this account as the human tester.
 * The bot's own API cannot add members or edit cards, so these two writes are raw requests.
 */
async function share(memberId: string | undefined): Promise<void> {
  if (!memberId || !/^[0-9a-f]{24}$/.test(memberId)) throw new Error('usage: tools/sample-boards.ts share <24-hex member id>');
  const state = loadState();
  const s = complete(state);
  const guarded = denyBoardListing(fetch);
  const raw = rawClient(guarded);
  await verifySampleBoards(raw, s);
  const me = await raw.me();
  if (!/^[a-z0-9_]+$/.test(me.username)) throw new Error('unexpected username format');

  const put = rawPut(guarded, auth());

  state.guests = [...new Set([...(state.guests ?? []), memberId])];
  saveState(state);
  for (const b of BOARDS) await put(`/boards/${s[b]}/members/${memberId}`, { type: 'normal' });

  const api = scopeClient(raw, { boards: BOARDS.map((b) => s[b]) });
  const config = (await api.lists(s.system, 'open')).find((l) => l.name === 'Config');
  const settings = (await api.cards(s.system, { filter: 'open' })).filter((c) => c.idList === config?.id && c.name === 'Settings');
  if (settings.length !== 1) throw new SampleGuardError('need exactly one open Settings card in System › Config');
  await put(`/cards/${settings[0]!.id}`, { desc: withAllowedMembers(settings[0]!.desc, [me.username]) });

  await verifySampleBoards(raw, complete(state));
  console.log('shared the three boards with the guest; allowed_members is now the account running this tool');
}

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'capture') await capture();
else if (cmd === 'share') await share(process.argv[3]);
else {
  console.error('usage: tools/sample-boards.ts setup|capture|share <member id>');
  process.exitCode = 2;
}
