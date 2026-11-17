import { z } from 'zod';
import type { TCard, TChecklist, TList, BotApi } from './api.ts';
import { ConfigError, SettingsSchema, SourcesSchema, parseYamlBlock } from '../config/schema.ts';
import type { Settings, UserConfig } from '../config/schema.ts';
import { readProfilesBoard } from './profiles-board.ts';
import type { UserBoards } from './scoped.ts';
export type { UserBoards } from './scoped.ts';
export type CardRef = { id: string; name: string; url: string; board: 'profiles' | 'system' };
export type ConfigProblem = { message: string; card?: CardRef; where: string };

export class ConfigInvalid extends ConfigError {
  problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(problems.map((p) => `${p.where}: ${p.message}${p.card ? ` (${p.card.url})` : ''}`).join('\n'));
    this.name = 'ConfigInvalid';
    this.problems = problems;
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** Where a value in the raw config came from, so a zod issue on it can name the card. */
type Origin = { where: string; card?: CardRef; label?: string };

type Column = {
  board: CardRef['board'];
  /** Names the column in messages, e.g. `in column "Copywriter"`. */
  label: string;
  /** For problems about the column itself, such as a missing card. */
  where: string;
  /** Prefix of a card's `where`. */
  prefix: string;
  cards: TCard[];
};

class Collector {
  problems: ConfigProblem[] = [];
  private origins = new Map<string, Origin>();
  // Paths already covered by a reading problem; zod issues under them would only repeat it.
  private reported = new Set<string>();

  origin(path: string, o: Origin): void {
    this.origins.set(path, o);
  }

  fail(o: Origin, message: string, ...covers: string[]): void {
    this.problems.push({ message: o.label ? `${o.label}: ${message}` : message, where: o.where, ...(o.card ? { card: o.card } : {}) });
    for (const path of covers) this.reported.add(path);
  }

  issue(path: (string | number)[], message: string): void {
    const keys = path.map(String);
    for (let n = keys.length; n >= 0; n--) {
      if (this.reported.has(keys.slice(0, n).join('.'))) return;
    }
    for (let n = keys.length; n >= 0; n--) {
      const o = this.origins.get(keys.slice(0, n).join('.'));
      if (!o) continue;
      const rest = keys.slice(n);
      const at = rest.length ? (o.label ? `item ${Number(rest[0]) + 1}` : rest.join('.')) : '';
      this.fail(o, at ? `${at}: ${message}` : message);
      return;
    }
    this.fail({ where: 'config' }, `${keys.join('.')}: ${message}`);
  }
}

const ref = (card: TCard, board: CardRef['board']): CardRef => ({ id: card.id, name: card.name, url: card.shortUrl, board });

const itemsOf = (checklists: TChecklist[] | undefined): string[] =>
  (checklists ?? []).flatMap((cl) => [...cl.checkItems].sort((a, b) => a.pos - b.pos).map((i) => i.name));

function pick(c: Collector, col: Column, title: string, required: boolean, path: string): TCard | undefined {
  const found = col.cards.filter((card) => norm(card.name) === norm(title));
  if (found.length > 1) {
    c.fail(
      { where: `${col.prefix} › ${title}`, card: ref(found[0]!, col.board) },
      `${found.length} cards titled "${title}" ${col.label}, keep one: ${found.map((f) => f.shortUrl).join(', ')}`,
      path,
    );
    return undefined;
  }
  if (!found.length && required) c.fail({ where: col.where }, `missing the "${title}" card ${col.label}`, path);
  return found[0];
}

function cardOrigin(col: Column, title: string, card: TCard): Origin {
  return { where: `${col.prefix} › ${title}`, card: ref(card, col.board) };
}

function yamlOf(c: Collector, o: Origin, card: TCard, path: string): unknown {
  try {
    return parseYamlBlock(card.desc);
  } catch (e) {
    // js-yaml appends a multi-line snippet after the first line; one problem stays one line.
    c.fail(o, (e instanceof ConfigError ? e.message : String(e)).split('\n')[0]!.trim(), path);
    return undefined;
  }
}

/** Open lists by position, each with its open cards by position. */
function columns(lists: TList[], cards: TCard[]): { list: TList; cards: TCard[] }[] {
  const open = lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos);
  return open.map((list) => ({ list, cards: cards.filter((c) => !c.closed && c.idList === list.id).sort((a, b) => a.pos - b.pos) }));
}

function systemColumn(lists: TList[], cards: TCard[]): Column {
  return {
    board: 'system', label: 'on the System board', where: 'System board', prefix: 'System',
    cards: columns(lists, cards).flatMap((x) => x.cards),
  };
}

function readSettingsCard(c: Collector, raw: Record<string, unknown>, col: Column): void {
  const settings = pick(c, col, 'Settings', true, 'settings');
  if (settings) {
    const o = cardOrigin(col, 'Settings', settings);
    c.origin('settings', o);
    raw['settings'] = yamlOf(c, o, settings, 'settings');
  }
}

function readSystem(c: Collector, raw: Record<string, unknown>, lists: TList[], cards: TCard[]): void {
  const col = systemColumn(lists, cards);
  readSettingsCard(c, raw, col);

  const sources = pick(c, col, 'Sources', false, 'sources');
  const add: string[] = [];
  const drop: string[] = [];
  const o: Origin = sources ? cardOrigin(col, 'Sources', sources) : { where: 'System board' };
  for (const cl of sources?.checklists ?? []) {
    const names = itemsOf([cl]);
    if (norm(cl.name) === 'add') add.push(...names);
    else if (norm(cl.name) === 'drop') drop.push(...names);
    else c.fail(o, `unknown checklist "${cl.name}"; the Sources checklists are "Add", "Drop"`);
  }
  raw['sources'] = { add, drop };
  c.origin('sources', o);
  c.origin('sources.add', { ...o, label: 'Add' });
  c.origin('sources.drop', { ...o, label: 'Drop' });
}

const SystemSchema = z.object({ settings: SettingsSchema, sources: SourcesSchema });

/** Reads the Profiles and System boards. Every problem is collected, then thrown once as ConfigInvalid. */
export async function readUserConfig(api: Pick<BotApi, 'lists' | 'cards'>, boards: UserBoards): Promise<UserConfig> {
  const [pLists, pCards, sLists, sCards] = await Promise.all([
    api.lists(boards.profiles, 'open'),
    api.cards(boards.profiles, { filter: 'open' }),
    api.lists(boards.system, 'open'),
    api.cards(boards.system, { filter: 'open', checklists: true }),
  ]);
  const c = new Collector();
  const raw: Record<string, unknown> = {};
  readSystem(c, raw, sLists, sCards);
  const parsed = SystemSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) c.issue(issue.path, issue.message);
  const { board, problems } = readProfilesBoard(pLists, pCards);
  c.problems.push(...problems);
  if (c.problems.length || !parsed.success || !board) throw new ConfigInvalid(c.problems);
  return { ...parsed.data, board, sharedCv: board.cv, personalDetails: board.personalDetails };
}

/** Reads only the System board's Settings card, with the same problems as `readUserConfig`. */
export async function readSettings(api: Pick<BotApi, 'lists' | 'cards'>, boards: UserBoards): Promise<Settings> {
  const [lists, cards] = await Promise.all([api.lists(boards.system, 'open'), api.cards(boards.system, { filter: 'open' })]);
  const c = new Collector();
  const raw: Record<string, unknown> = {};
  readSettingsCard(c, raw, systemColumn(lists, cards));
  const parsed = SettingsSchema.safeParse(raw['settings']);
  if (!parsed.success) for (const issue of parsed.error.issues) c.issue(['settings', ...issue.path], issue.message);
  if (c.problems.length || !parsed.success) throw new ConfigInvalid(c.problems);
  return parsed.data;
}
