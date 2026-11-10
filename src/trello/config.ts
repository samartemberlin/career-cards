import type { TCard, TChecklist, TList, TrelloApi } from './api.ts';
import { ConfigError, ProfileMetaSchema, UserConfigSchema, hasYamlBlock, parseYamlBlock } from '../config/schema.ts';
import type { UserConfig } from '../config/schema.ts';

export type UserBoards = { jobs: string; profiles: string; system: string };
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

const FILTER_CHECKLISTS = [
  ['Include titles', 'includeTitles'],
  ['Exclude titles', 'excludeTitles'],
  ['Exclude companies', 'excludeCompanies'],
  ['Exclude text', 'excludeText'],
  ['Exclude locations', 'excludeLocations'],
] as const;

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

function readSystem(c: Collector, raw: Record<string, unknown>, lists: TList[], cards: TCard[]): void {
  const col: Column = {
    board: 'system', label: 'on the System board', where: 'System board', prefix: 'System',
    cards: columns(lists, cards).flatMap((x) => x.cards),
  };

  const settings = pick(c, col, 'Settings', true, 'settings');
  if (settings) {
    const o = cardOrigin(col, 'Settings', settings);
    c.origin('settings', o);
    raw['settings'] = yamlOf(c, o, settings, 'settings');
  }

  const sources = pick(c, col, 'Sources', false, 'sources');
  const add: string[] = [];
  const drop: string[] = [];
  const o: Origin = sources ? cardOrigin(col, 'Sources', sources) : { where: 'System board' };
  for (const cl of sources?.checklists ?? []) {
    const names = itemsOf([cl]);
    if (norm(cl.name) === 'add') add.push(...names);
    else if (norm(cl.name) === 'drop') drop.push(...names);
  }
  raw['sources'] = { add, drop };
  c.origin('sources', o);
  c.origin('sources.add', { ...o, label: 'Add' });
  c.origin('sources.drop', { ...o, label: 'Drop' });
}

function readProfiles(c: Collector, raw: Record<string, unknown>, lists: TList[], cards: TCard[]): void {
  c.origin('profiles', { where: 'Profiles board' });

  const byName = new Map<string, { list: TList; cards: TCard[] }>();
  for (const column of columns(lists, cards)) {
    const key = norm(column.list.name);
    if (key === 'originals') continue;
    if (byName.has(key)) {
      c.fail({ where: 'Profiles board' }, `two open columns named "${column.list.name.trim()}", rename or archive one`);
      continue;
    }
    byName.set(key, column);
  }

  const toColumn = (x: { list: TList; cards: TCard[] }): Column => {
    const name = x.list.name.trim();
    return { board: 'profiles', label: `in column "${name}"`, where: `Profiles › ${name}`, prefix: `Profiles › ${name}`, cards: x.cards };
  };

  let basics = '';
  const shared = byName.get('shared');
  byName.delete('shared');
  if (!shared) {
    c.fail({ where: 'Profiles board' }, 'no "Shared" column (it holds the CV and Personal details cards)', 'sharedCv', 'personalDetails');
  } else {
    const col = toColumn(shared);
    const cv = pick(c, col, 'CV', true, 'sharedCv');
    if (cv) {
      c.origin('sharedCv', cardOrigin(col, 'CV', cv));
      raw['sharedCv'] = cv.desc;
    }
    const details = pick(c, col, 'Personal details', true, 'personalDetails');
    if (details) {
      c.origin('personalDetails', cardOrigin(col, 'Personal details', details));
      raw['personalDetails'] = itemsOf(details.checklists);
    }
    basics = pick(c, col, 'Rubric basics', false, 'rubricBasics')?.desc.trim() ?? '';
    const prefs = pick(c, col, 'Preferences', false, 'preferences');
    if (prefs) {
      const o = cardOrigin(col, 'Preferences', prefs);
      c.origin('preferences', o);
      raw['preferences'] = yamlOf(c, o, prefs, 'preferences');
    }
  }

  raw['profiles'] = [...byName.values()].map((x, i) => readProfile(c, toColumn(x), `profiles.${i}`, basics));
}

function readProfile(c: Collector, col: Column, path: string, basics: string): Record<string, unknown> {
  const p: Record<string, unknown> = { name: col.where.slice('Profiles › '.length) };
  c.origin(path, { where: col.where });

  const meta = pick(c, col, 'Profile', true, `${path}.active`);
  if (meta) {
    const o = cardOrigin(col, 'Profile', meta);
    c.origin(`${path}.active`, o);
    const yaml = hasYamlBlock(meta.desc) ? yamlOf(c, o, meta, `${path}.active`) : {};
    const parsed = ProfileMetaSchema.safeParse(yaml ?? {});
    if (parsed.success) p['active'] = parsed.data.active;
    else c.fail(o, parsed.error.issues.map((i) => [...i.path, i.message].join(': ')).join('; '), `${path}.active`);
  }

  const rubric = pick(c, col, 'Rubric', true, `${path}.rubric`);
  if (rubric) {
    c.origin(`${path}.rubric`, cardOrigin(col, 'Rubric', rubric));
    p['rubric'] = [basics, rubric.desc.trim()].filter(Boolean).join('\n\n');
  }

  const keywords = pick(c, col, 'Search keywords', true, `${path}.searchKeywords`);
  if (keywords) {
    c.origin(`${path}.searchKeywords`, cardOrigin(col, 'Search keywords', keywords));
    p['searchKeywords'] = itemsOf(keywords.checklists);
  }

  const filters = pick(c, col, 'Filters', true, `${path}.filters`);
  if (filters) {
    const o = cardOrigin(col, 'Filters', filters);
    c.origin(`${path}.filters`, o);
    const out: Record<string, string[]> = Object.fromEntries(FILTER_CHECKLISTS.map(([, key]) => [key, []]));
    for (const [title, key] of FILTER_CHECKLISTS) c.origin(`${path}.filters.${key}`, { ...o, label: title });
    for (const cl of filters.checklists ?? []) {
      const known = FILTER_CHECKLISTS.find(([title]) => norm(title) === norm(cl.name));
      if (!known) {
        c.fail(o, `unknown checklist "${cl.name}"; the Filters checklists are ${FILTER_CHECKLISTS.map(([t]) => `"${t}"`).join(', ')}`);
        continue;
      }
      out[known[1]]!.push(...itemsOf([cl]));
    }
    p['filters'] = out;
  }

  const cv = pick(c, col, 'CV', false, `${path}.cv`);
  if (cv) {
    c.origin(`${path}.cv`, cardOrigin(col, 'CV', cv));
    p['cv'] = cv.desc;
  }
  return p;
}

/** Reads the Profiles and System boards. Every problem is collected, then thrown once as ConfigInvalid. */
export async function readUserConfig(api: TrelloApi, boards: UserBoards): Promise<UserConfig> {
  const [pLists, pCards, sLists, sCards] = await Promise.all([
    api.lists(boards.profiles, 'open'),
    api.cards(boards.profiles, { filter: 'open', checklists: true }),
    api.lists(boards.system, 'open'),
    api.cards(boards.system, { filter: 'open', checklists: true }),
  ]);
  const c = new Collector();
  const raw: Record<string, unknown> = {};
  readSystem(c, raw, sLists, sCards);
  readProfiles(c, raw, pLists, pCards);

  const parsed = UserConfigSchema.safeParse(raw);
  if (!parsed.success) for (const issue of parsed.error.issues) c.issue(issue.path, issue.message);
  if (c.problems.length || !parsed.success) throw new ConfigInvalid(c.problems);
  return parsed.data;
}
