// Shared search merging, ported from samjobs/src/search.mjs.
// File loading (loadSearch, loadSearches) is NOT here: PR 2 builds searches from Trello cards.
//
// One shared search is built from what each active person needs. Adding a person widens it
// without touching shared files. career-ops scans with no positive title list and the code
// applies the union filter afterwards.

const lower = (s: unknown): string => String(s).trim().toLowerCase();

function uniqueBy<T>(items: T[], keyOf: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = keyOf(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type AnyObject = Record<string, unknown>;

/** The shared portals plus everybody's board keywords and employers. Never changes `base`. */
export function mergePortals(base: AnyObject, searches: AnyObject[]): AnyObject {
  const out = structuredClone(base) as AnyObject;
  if (out.title_filter) delete (out.title_filter as AnyObject).positive;
  const keywords = uniqueBy(
    searches.flatMap((s) => (s.board_keywords as string[] | undefined) ?? []),
    lower,
  );
  for (const board of (out.job_boards as AnyObject[] | undefined) ?? []) {
    if (board.provider === 'arbeitsagentur') {
      board.arbeitsagentur = { ...(board.arbeitsagentur as AnyObject | undefined), keywords };
    }
  }
  out.tracked_companies = uniqueBy(
    [
      ...((out.tracked_companies as AnyObject[] | undefined) ?? []),
      ...searches.flatMap((s) => (s.companies as AnyObject[] | undefined) ?? []),
    ],
    (c) => lower(c.name),
  );
  return out;
}

type LinkedInEntry = { location: string; remote?: boolean; queries: string[] };
type LinkedInBase = AnyObject & { searches?: LinkedInEntry[] };

/**
 * LinkedIn settings plus everybody's searches, grouped by (location, remote). Queries take turns
 * person by person: the search has a time budget, so appending one person after another could cut
 * off only the last person.
 */
export function mergeLinkedin(base: AnyObject, searches: AnyObject[]): LinkedInBase {
  const groups = new Map<string, { location: string; remote: boolean; perPerson: Map<number, string[]> }>();
  searches.forEach((s, person) => {
    for (const { location, remote, queries } of (s.linkedin as LinkedInEntry[] | undefined) ?? []) {
      const k = `${location}|${Boolean(remote)}`;
      if (!groups.has(k)) groups.set(k, { location, remote: Boolean(remote), perPerson: new Map() });
      const per = groups.get(k)!.perPerson;
      per.set(person, [...(per.get(person) ?? []), ...(queries ?? [])]);
    }
  });
  const merged = [...groups.values()].map(({ location, remote, perPerson }) => {
    const lists = [...perPerson.values()];
    const turns: string[] = [];
    for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
      for (const l of lists) if (i < l.length) turns.push(l[i]!);
    }
    return { location, ...(remote ? { remote: true } : {}), queries: uniqueBy(turns, lower) };
  });
  return { ...base, searches: merged };
}

/**
 * A person's include as regexes, plus what is wrong with it. An include that is not a list,
 * or a pattern that matches everything, would store every posting from every source, so neither
 * may count.
 */
export function compileInclude(list: unknown): { res: RegExp[]; problems: string[] } {
  if (!Array.isArray(list) || !list.length) {
    return { res: [], problems: ['include must be a non-empty list, so this adds nothing to the search'] };
  }
  const res: RegExp[] = [];
  const problems: string[] = [];
  for (const p of list as unknown[]) {
    try {
      const re = new RegExp(p as string, 'i');
      if (re.test('')) problems.push(`include pattern ${JSON.stringify(p)} matches everything, ignored`);
      else res.push(re);
    } catch (e) {
      problems.push(`bad include pattern: ${(e as Error).message}`);
    }
  }
  return { res, problems };
}

/**
 * Keep a title if any person's include matches.
 * Returns a predicate plus a list of problems from invalid or over-broad patterns.
 */
export function unionInclude(
  profiles: { name?: string; include?: unknown }[],
): { keep: (title: string) => boolean; problems: string[] } {
  const all: RegExp[] = [];
  const problems: string[] = [];
  for (const p of profiles) {
    const { res, problems: mine } = compileInclude((p as { include?: unknown }).include);
    all.push(...res);
    const prefix = (p as { name?: string }).name ? `${(p as { name?: string }).name}: ` : '';
    problems.push(...mine.map((m) => `${prefix}${m}`));
  }
  return { keep: (title) => all.some((re) => re.test(String(title ?? ''))), problems };
}
