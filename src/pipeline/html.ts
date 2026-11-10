import type { Job } from './keys.ts';

const MAX_TEXT = 20_000;

/** Schema.org JobPosting fields that samjobs reads. */
export type JobPosting = {
  '@type'?: string | string[];
  '@graph'?: unknown[];
  description?: unknown;
  validThrough?: unknown;
  datePosted?: unknown;
  employmentType?: unknown;
  [key: string]: unknown;
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', ndash: '–', mdash: '—', hellip: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  if (typeof html !== 'string' || !html) return '';
  // Entity-escaped markup (&lt;p&gt;) is common in JSON-LD: decode once, then strip tags.
  const once = /&lt;\/?[a-z]/i.test(html) && !/<[a-z]/i.test(html) ? decodeEntities(html) : html;
  return decodeEntities(once
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** First schema.org JobPosting in the page, or null. */
export function extractJobPosting(html: string): JobPosting | null {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1]!); } catch { continue; }
    const stack: unknown[] = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const it = stack.shift();
      if (!it || typeof it !== 'object') continue;
      const obj = it as Record<string, unknown>;
      if (obj['@graph']) stack.push(...([] as unknown[]).concat(obj['@graph']));
      if (([] as unknown[]).concat(obj['@type'] ?? []).includes('JobPosting')) return obj as JobPosting;
    }
  }
  return null;
}

/** "FULL_TIME" → 'full_time'; any INTERN* → 'intern' so HARD_EMPLOYMENT_TYPE sees it. */
export function normalizeEmploymentType(v: unknown): string | null {
  const all = ([] as unknown[]).concat(v ?? []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  if (all.some((x) => /intern|werkstudent|working[ _-]?student/.test(x))) return 'intern';
  return all[0] ?? null;
}

const isoDate = (v: unknown): string | undefined => {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return undefined;
};

export function fromJobPosting(jp: JobPosting): Partial<Job> {
  const jd = htmlToText(String(jp.description ?? '')).slice(0, MAX_TEXT);
  return {
    jd,
    deadline: isoDate(jp.validThrough),
    posted: isoDate(jp.datePosted),
    employment_type: normalizeEmploymentType(jp.employmentType) ?? undefined,
    source: 'jsonld',
  };
}
