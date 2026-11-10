// Makes captured Trello responses safe for a public repo.
export type RecordedCall = { method: string; path: string; query: Record<string, string>; status: number; body: unknown };
/** `query` never holds `key` or `token`. */
export type Recording = RecordedCall[];

const ID = /\b[0-9a-f]{24}\b/g;
// Personal fields of the bot member that show up in nested objects (action creators, comment entities, attachment owners).
const DROP = /^(url|shortLink|backgroundImage.*|fullName|initials|avatar.*|email|gravatarHash|uploadedAvatar.*|nonPublic|memberCreator|display|entities)$/;

function walk(v: unknown, visit: (s: string, key: string | undefined) => string, key?: string): unknown {
  if (typeof v === 'string') return visit(v, key);
  if (Array.isArray(v)) return v.map((x) => walk(x, visit, key));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!DROP.test(k)) out[visit(k, undefined)] = walk(x, visit, k);
    }
    return out;
  }
  return v;
}

function collectIds(rec: Recording): string[] {
  const ids = new Set<string>();
  const grab = (s: string) => {
    for (const m of s.matchAll(ID)) ids.add(m[0]);
    return s;
  };
  for (const c of rec) {
    grab(c.path);
    for (const [k, v] of Object.entries(c.query)) grab(k), grab(v);
    walk(c.body, grab);
  }
  return [...ids].sort();
}

/** Ids are renumbered in sorted order of the real ids, so `before=` paging over the scrubbed ids still works.
 *  The id and short-URL maps live for one call: scrub files that must agree together, via scrubRecordings. */
export function scrubRecording(rec: Recording, o: { botUsername: string }): Recording {
  const ids = new Map(collectIds(rec).map((id, i) => [id, `fa4e${(i + 1).toString(16).padStart(20, '0')}`]));
  const shortUrls = new Map<string, string>();
  const bot = new RegExp(o.botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const visit = (s: string, key: string | undefined): string => {
    if (key === 'username') return 'samplebot';
    if (key === 'shortUrl') {
      if (!shortUrls.has(s)) shortUrls.set(s, `https://trello.com/c/sample${String(shortUrls.size + 1).padStart(3, '0')}`);
      return shortUrls.get(s)!;
    }
    return s.replace(ID, (m) => ids.get(m)!).replace(bot, 'samplebot');
  };
  return rec.map((c) => ({
    method: c.method,
    path: visit(c.path, undefined),
    query: Object.fromEntries(
      Object.entries(c.query).filter(([k]) => k !== 'key' && k !== 'token').map(([k, v]) => [visit(k, undefined), visit(v, undefined)]),
    ),
    status: c.status,
    body: walk(c.body, visit),
  }));
}

/** Scrubs several files with one id map. */
export function scrubRecordings<K extends string>(files: Record<K, Recording>, o: { botUsername: string }): Record<K, Recording> {
  const names = Object.keys(files) as K[];
  const all = scrubRecording(names.flatMap((n) => files[n]), o);
  const out = {} as Record<K, Recording>;
  let at = 0;
  for (const n of names) {
    out[n] = all.slice(at, at + files[n].length);
    at += files[n].length;
  }
  return out;
}

/** Names, initials and emails in a raw capture: the scrubbed files must contain none of them. */
export function personalStrings(rec: Recording): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/^(fullName|initials|email|username)$/.test(k) && typeof x === 'string' && x.length > 1) out.add(x);
        else if (k === 'entities' && Array.isArray(x)) x.forEach((e) => e?.type === 'member' && typeof e.text === 'string' && out.add(e.text));
        visit(x);
      }
    }
  };
  for (const c of rec) visit(c.body);
  return [...out];
}
