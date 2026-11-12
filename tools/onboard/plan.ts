// What the onboarding tool would do to a user's three boards. It creates what is missing and never edits.
import type { BotApi, TCard, TList } from '../../src/trello/api.ts';
import { TrelloError } from '../../src/trello/client.ts';
import { ConfigInvalid, readSettings, readUserConfig } from '../../src/trello/config.ts';
import type { ConfigProblem } from '../../src/trello/config.ts';
import type { CardSpec } from '../sample/layout.ts';
import { starterLayout } from './starter.ts';

export type Role = 'jobs' | 'profiles' | 'system';
export type BoardIds = { jobs: string; profiles: string; system: string };

const ROLES: Role[] = ['jobs', 'profiles', 'system'];
const TITLE: Record<Role, string> = { jobs: 'Jobs', profiles: 'Profiles', system: 'System' };

export type ObservedList = { name: string; cards: string[] };
/** `exists: false` with an `id` is an id that was given but that neither client could read. */
export type ObservedBoard =
  | { exists: false; id?: string }
  | { exists: true; id: string; name: string; permissionLevel: string; closed: boolean; members: string[]; lists: ObservedList[] };

export type Observed = {
  bot: string;
  /** The account that holds the owner client, which creates boards; the bot when no owner token is given. */
  owner: string;
  boards: Record<Role, ObservedBoard>;
  /** From the Settings card; undefined when the card is missing or unreadable. */
  allowedMembers?: string[];
  /** Items on Shared › Personal details; undefined when the card is missing. */
  personalDetails?: number;
  /** readUserConfig's problems ([] when it passes), or only the Settings card's without a Profiles board; undefined without a System board. */
  config?: { problems: ConfigProblem[] };
};

export type Action =
  | { kind: 'createBoard'; board: Role; name: string }
  | { kind: 'addMember'; board: Role; username: string }
  | { kind: 'createList'; board: Role; list: string }
  | { kind: 'createCard'; board: Role; list: string; card: CardSpec }
  | { kind: 'webhook'; board: Role; callbackURL: string };

export type OnboardPlan = { refuse: string[]; actions: Action[]; notes: string[] };

const norm = (s: string): string => s.trim().toLowerCase();
const PERSONAL_EMPTY = 'Personal details is empty: the run will refuse until it lists your name, email, phone';

export function planOnboarding(o: { observed: Observed; owner: string; url?: string; name?: string }): OnboardPlan {
  const { observed } = o;
  const starter = starterLayout(o.owner);
  const refuse: string[] = [];
  const actions: Action[] = [];
  const notes: string[] = [];
  const members = [o.owner, observed.bot];
  const allowed = new Set([...members, observed.owner].map(norm));

  for (const role of ROLES) {
    const b = observed.boards[role];
    const t = TITLE[role];
    if (!b.exists) {
      if (b.id !== undefined) {
        refuse.push(`${t}: the board id given cannot be read by the bot or the owner (wrong id, or no access)`);
        continue;
      }
      actions.push({ kind: 'createBoard', board: role, name: `${o.name ?? 'career-cards'} · ${t}` });
      for (const m of members) if (norm(m) !== norm(observed.owner)) actions.push({ kind: 'addMember', board: role, username: m });
      for (const ls of starter[role].lists) {
        actions.push({ kind: 'createList', board: role, list: ls.name });
        for (const card of ls.cards) actions.push({ kind: 'createCard', board: role, list: ls.name, card });
      }
      continue;
    }

    const before = refuse.length;
    if (b.permissionLevel !== 'private') refuse.push(`${t}: not private (${b.permissionLevel})`);
    if (b.closed) refuse.push(`${t}: closed`);
    for (const m of b.members) if (!allowed.has(norm(m))) refuse.push(`${t}: extra member ${m}`);
    // A board id from the wrong role (or someone else's board) is caught by its name.
    if (!b.name.endsWith(` · ${t}`)) refuse.push(`${t}: the board is named "${b.name}", not "… · ${t}" (wrong id?)`);
    if (refuse.length > before) continue;

    const have = new Set(b.members.map(norm));
    for (const m of members) if (!have.has(norm(m))) actions.push({ kind: 'addMember', board: role, username: m });

    // The config reader looks for System cards anywhere on the board, and for Profiles cards in their column.
    const anywhere = new Set(b.lists.flatMap((l) => l.cards.map(norm)));
    for (const ls of starter[role].lists) {
      const list = b.lists.find((l) => norm(l.name) === norm(ls.name));
      if (!list) actions.push({ kind: 'createList', board: role, list: ls.name });
      const inList = new Set((list?.cards ?? []).map(norm));
      for (const card of ls.cards) {
        const there = role === 'system' ? anywhere.has(norm(card.name)) : inList.has(norm(card.name));
        if (!there) actions.push({ kind: 'createCard', board: role, list: ls.name, card });
      }
    }
  }

  if (o.url !== undefined) {
    const callbackURL = `${o.url.replace(/\/+$/, '')}/trello`;
    for (const role of ROLES) if (!refuse.some((r) => r.startsWith(`${TITLE[role]}:`))) actions.push({ kind: 'webhook', board: role, callbackURL });
  }

  if (observed.allowedMembers && !observed.allowedMembers.some((m) => norm(m) === norm(o.owner))) {
    notes.push(`Settings: allowed_members does not include ${o.owner}`);
  }
  const personalEmpty = !observed.personalDetails;
  if (personalEmpty) notes.push(PERSONAL_EMPTY);
  for (const p of observed.config?.problems ?? []) {
    if (personalEmpty && /personal details/i.test(p.where)) continue;
    notes.push(`${p.where}: ${p.message}${p.card ? ` (${p.card.url})` : ''}`);
  }

  return { refuse, actions, notes };
}

export const actionLine = (a: Action): string => {
  const t = TITLE[a.board];
  switch (a.kind) {
    case 'createBoard': return `${t}: create board "${a.name}"`;
    case 'addMember': return `${t}: add member ${a.username}`;
    case 'createList': return `${t}: create list "${a.list}"`;
    case 'createCard': return `${t}: create card "${a.card.name}" in "${a.list}"`;
    case 'webhook': return `${t}: webhook to ${a.callbackURL}`;
  }
};

/** Card descriptions are never printed: only titles. */
export function formatPlan(p: OnboardPlan): string {
  const section = (title: string, lines: string[]): string[] => [title, ...(lines.length ? lines : ['(none)']).map((l) => `  ${l}`)];
  return [
    ...section('Refused:', p.refuse),
    ...section('Will do:', p.actions.map(actionLine)),
    ...section('Check by hand:', p.notes),
  ].join('\n');
}

export type BoardReader = Pick<BotApi, 'me' | 'board' | 'boardMembers' | 'lists' | 'cards'>;

// Trello answers 401 for a private board the token's account is not a member of.
const noAccess = (e: unknown): boolean => e instanceof TrelloError && [401, 403, 404].includes(e.status);

type Read = { board: ObservedBoard; reader?: BoardReader; lists: TList[]; cards: TCard[] };

async function readOne(id: string, readers: BoardReader[]): Promise<Read> {
  for (const r of readers) {
    let b;
    try {
      b = await r.board(id);
    } catch (e) {
      if (noAccess(e)) continue;
      throw e;
    }
    const [members, lists, cards] = await Promise.all([r.boardMembers(id), r.lists(id, 'open'), r.cards(id, { filter: 'open', checklists: true })]);
    const open = lists.filter((l) => !l.closed).sort((x, y) => x.pos - y.pos);
    return {
      board: {
        exists: true, id, name: b.name, permissionLevel: b.prefs.permissionLevel, closed: b.closed,
        members: members.map((m) => m.username),
        lists: open.map((l) => ({
          name: l.name,
          cards: cards.filter((c) => !c.closed && c.idList === l.id).sort((x, y) => x.pos - y.pos).map((c) => c.name),
        })),
      },
      reader: r, lists: open, cards,
    };
  }
  return { board: { exists: false, id }, lists: [], cards: [] };
}

/**
 * Reads only the boards whose ids are given, with the bot, or with the owner where the bot is not a member yet.
 * It never lists boards: the bot's token also sees real users' boards.
 */
export async function readBoards(owner: BoardReader, bot: BoardReader, ids: Partial<BoardIds>): Promise<Observed> {
  const readers = bot === owner ? [bot] : [bot, owner];
  const [botMe, ownerMe] = await Promise.all([bot.me(), owner.me()]);
  const read = {} as Record<Role, Read>;
  for (const role of ROLES) {
    const id = ids[role];
    read[role] = id === undefined ? { board: { exists: false }, lists: [], cards: [] } : await readOne(id, readers);
  }
  const observed: Observed = {
    bot: botMe.username,
    owner: ownerMe.username,
    boards: { jobs: read.jobs.board, profiles: read.profiles.board, system: read.system.board },
  };

  const shared = read.profiles.lists.find((l) => norm(l.name) === 'shared');
  const details = read.profiles.cards.find((c) => !c.closed && c.idList === shared?.id && norm(c.name) === 'personal details');
  if (details) observed.personalDetails = (details.checklists ?? []).reduce((n, cl) => n + cl.checkItems.length, 0);

  const p = read.profiles.reader;
  const s = read.system.reader;
  if (s) {
    const lists = (boardId: string, f: 'open' | 'all') => (boardId === ids.profiles && p ? p : s).lists(boardId, f);
    const cards: BoardReader['cards'] = (boardId, o) => (boardId === ids.profiles && p ? p : s).cards(boardId, o);
    const boards = { jobs: ids.jobs ?? '', profiles: ids.profiles ?? '', system: ids.system! };
    try {
      observed.allowedMembers = (await readSettings({ lists, cards }, boards)).allowed_members;
      if (!p) observed.config = { problems: [] };
    } catch (e) {
      if (!(e instanceof ConfigInvalid)) throw e;
      if (!p) observed.config = { problems: e.problems };
    }
    if (p) {
      try {
        await readUserConfig({ lists, cards }, boards);
        observed.config = { problems: [] };
      } catch (e) {
        if (!(e instanceof ConfigInvalid)) throw e;
        observed.config = { problems: e.problems };
      }
    }
  }
  return observed;
}
