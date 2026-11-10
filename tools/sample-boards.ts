// Creates and fills the three sample boards in the bot's own workspace, and captures their API responses as fixtures.
// Usage: node --env-file=<file with TRELLO_KEY, TRELLO_TOKEN> tools/sample-boards.ts setup|capture
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../src/trello/client.ts';
import { isOriginalsName, scopeClient } from '../src/trello/scoped.ts';
import type { TrelloApi, TCard, TList } from '../src/trello/api.ts';
import { parseJobKey } from '../src/trello/cards.ts';
import { SAMPLE_NAMES, SampleGuardError, denyBoardListing, pickBotWorkspace, verifySampleBoards } from './sample/guard.ts';
import type { SampleBoard, SampleState } from './sample/guard.ts';
import { LAYOUT, OLD_RUN_COLUMN, RUN_COLUMN, cardCount } from './sample/layout.ts';
import type { BoardLayout } from './sample/layout.ts';
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
  return { workspace: s.workspace, jobs: s.jobs, profiles: s.profiles, system: s.system };
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

function rawClient(fetchImpl: typeof fetch): TrelloApi {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error('TRELLO_KEY and TRELLO_TOKEN must be set (node --env-file=...)');
  return createTrelloClient({ key, token, fetchImpl });
}

type Counts = Record<'labels' | 'lists' | 'cards' | 'checklists' | 'items' | 'closedChanged', number>;

/** `asUser` writes the Originals column, which in real use only the user fills; it is still limited to the sample boards. */
async function applyLayout(api: TrelloApi, asUser: TrelloApi, boardId: string, layout: BoardLayout, made: Counts): Promise<void> {
  const labels = await api.labels(boardId);
  for (const l of layout.labels) {
    if (!labels.some((x) => x.name === l.name)) {
      labels.push(await api.createLabel(boardId, l.name, l.color));
      made.labels++;
    }
  }
  const labelId = (name: string): string => labels.find((x) => x.name === name)!.id;

  const lists = await api.lists(boardId, 'all');
  const hasChecklists = layout.lists.some((l) => l.cards.some((c) => c.checklists));
  // The Jobs board is over 1,000 cards and needs paging; the others are small and need their checklists.
  const cards: TCard[] = hasChecklists
    ? await api.cards(boardId, { filter: 'all', checklists: true })
    : await api.allCards(boardId);

  for (const ls of layout.lists) {
    let list: TList | undefined = lists.find((x) => x.name === ls.name);
    if (!list) {
      list = await api.createList(boardId, ls.name, 'bottom');
      made.lists++;
    }
    const writer = isOriginalsName(ls.name) ? asUser : api;
    for (const cs of ls.cards) {
      // Open and archived job cards share titles; their keys tell them apart.
      const key = parseJobKey(cs.desc);
      let card = cards.find((c) => c.idList === list.id && (key ? parseJobKey(c.desc) === key : c.name === cs.name));
      if (!card) {
        card = await writer.createCard({ idList: list.id, name: cs.name, desc: cs.desc, pos: 'bottom', idLabels: (cs.labels ?? []).map(labelId) });
        made.cards++;
        if (cs.comment) await api.comment(card.id, cs.comment);
        if (cs.attachment) await api.attachText(card.id, cs.attachment.name, cs.attachment.text);
      }
      for (const cls of cs.checklists ?? []) {
        let cl = card.checklists?.find((x) => x.name === cls.name);
        if (!cl) {
          cl = await api.createChecklist(card.id, cls.name);
          made.checklists++;
        }
        for (const item of cls.items) {
          if (!cl.checkItems.some((x) => x.name === item)) {
            await api.addCheckItem(cl.id, item);
            made.items++;
          }
        }
      }
      if (Boolean(cs.closed) !== card.closed) {
        await api.setCardClosed(card.id, Boolean(cs.closed));
        made.closedChanged++;
      }
    }
    if (Boolean(ls.closed) !== list.closed) {
      await api.setListClosed(list.id, Boolean(ls.closed));
      made.closedChanged++;
    }
  }
}

async function setup(): Promise<void> {
  const state = loadState();
  const counter = { n: 0 };
  const raw = rawClient(recordingFetch((c) => {
    if (c.method === 'GET' || c.status !== 200) return;
    const kind = WRITE_KINDS.find(([, re, m]) => m === c.method && re.test(c.path))?.[0];
    if (kind && !state.writes?.[kind]) {
      state.writes = { ...state.writes, [kind]: c };
      saveState(state);
    }
  }, counter));

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
  let total = boardsCreated;
  for (const b of BOARDS) {
    const made: Counts = { labels: 0, lists: 0, cards: 0, checklists: 0, items: 0, closedChanged: 0 };
    await applyLayout(api, asUser, s[b], LAYOUT[b], made);
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
  const files: Record<'jobs' | 'profiles' | 'system' | 'lookups', Recording> = { jobs: [], profiles: [], system: [], lookups: [] };
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
  const listId = (lists: TList[], name: string): string => lists.find((l) => l.name === name)!.id;
  const oldRun = jobCards.find((c) => c.idList === listId(jobLists, OLD_RUN_COLUMN))!;
  const jobCard = jobCards.find((c) => c.idList === listId(jobLists, RUN_COLUMN) && !c.closed && !c.name.startsWith('ℹ'))!;
  const profiles = read.profiles!;
  const originals = listId(profiles.lists, 'Originals');
  await api.card(oldRun.id);
  await api.card(profiles.cards.find((c) => c.idList === originals)!.id);
  await api.card(jobCard.id);
  await api.list(originals);
  const details = profiles.cards.flatMap((c) => c.checklists ?? []).find((cl) => cl.name === 'Personal details')!;
  await api.checklist(details.id);
  await api.card('0'.repeat(24)).then(
    () => { throw new Error('expected a 404 for a card that does not exist'); },
    (e: unknown) => { if ((e as { status?: number }).status !== 404) throw e; },
  );
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

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'capture') await capture();
else {
  console.error('usage: tools/sample-boards.ts setup|capture');
  process.exitCode = 2;
}
