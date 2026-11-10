// Career pages career-ops has no provider for, read without a browser. Two shapes cover what we found:
//   embedded-json   the page ships its job list inside __NEXT_DATA__ (Vinted: Greenhouse-shaped objects)
//   listing-jsonld  a listing page links to detail pages that carry schema.org JobPosting (WWF / Prescreen)
// Keys are assigned by the pipeline after scan.
import { extractJobPosting, htmlToText } from '../html.ts';
import type { FetchLike } from '../jd.ts';
import type { ScanRow, SourceError, SourceResult } from './types.ts';


const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clean = (v: unknown): string => htmlToText(String(v ?? '')).replace(/\s+/g, ' ').trim();

async function getText(url: string, fetchImpl: FetchLike): Promise<{ text: string; url: string }> {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9,de;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), url: (res as { url?: string }).url ?? url };
}

type RawJobLike = {
  title?: unknown;
  name?: unknown;
  absolute_url?: unknown;
  url?: unknown;
  applyUrl?: unknown;
  location?: unknown;
  city?: unknown;
  first_published?: unknown;
  updated_at?: unknown;
  datePosted?: unknown;
  [key: string]: unknown;
};

/** Job-like objects anywhere in a JSON tree: a title/name plus a link and (optionally) a location. */
export function findJobObjects(node: unknown, out: Array<{ title: string; url: string; location: string; posted: string }> = [], seen = new Set<object>()): Array<{ title: string; url: string; location: string; posted: string }> {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (!Array.isArray(node)) {
    const n = node as RawJobLike;
    const title = n.title ?? n.name;
    const url = n.absolute_url ?? n.url ?? n.applyUrl;
    if (typeof title === 'string' && title.length > 3 && typeof url === 'string' && /^https?:\/\//.test(url)) {
      const rawLoc = n.location;
      const locName = rawLoc && typeof rawLoc === 'object' ? (rawLoc as { name?: unknown }).name : undefined;
      const loc: unknown = locName ?? rawLoc ?? n.city ?? '';
      out.push({ title, url, location: typeof loc === 'string' ? loc : '', posted: String(n.first_published ?? n.updated_at ?? n.datePosted ?? '').slice(0, 10) });
    }
  }
  for (const v of Object.values(node as object)) findJobObjects(v, out, seen);
  return out;
}

export function parseEmbeddedJobs(html: string, source: { name: string }): ScanRow[] {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return [];
  let data: { props?: unknown } | unknown[];
  try { data = JSON.parse(m[1]!) as { props?: unknown } | unknown[]; } catch { return []; }
  const byUrl = new Map<string, ScanRow>();
  const root = Array.isArray(data) ? data : ((data as { props?: unknown }).props ?? data);
  for (const j of findJobObjects(root)) {
    const url = j.url.replace(/[?#].*$/, '');
    if (!byUrl.has(url)) byUrl.set(url, { url: j.url, title: clean(j.title), company: source.name, location: clean(j.location), posted: /^\d{4}-\d{2}-\d{2}$/.test(j.posted) ? j.posted : '', source: `page:${source.name}` });
  }
  return [...byUrl.values()];
}

export function listingLinks(html: string, baseUrl: string, linkRe: string): string[] {
  const re = new RegExp(linkRe);
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"#]+)"/g)) {
    const href = m[1]!.replace(/&amp;/g, '&');
    if (!re.test(href)) continue;
    try { out.add(new URL(href, baseUrl).href); } catch { /* not a URL */ }
  }
  return [...out];
}

type JsonLdJobPosting = {
  title?: unknown;
  hiringOrganization?: { name?: unknown };
  jobLocation?: unknown;
  jobLocationType?: unknown;
  datePosted?: unknown;
  [key: string]: unknown;
};

export function jobFromJsonLd(jp: JsonLdJobPosting, source: { name: string; url: string }): ScanRow {
  const loc = ([] as unknown[]).concat(jp.jobLocation ?? [])[0] as { address?: unknown } | undefined;
  const addr = loc?.address;
  const place = typeof addr === 'string' ? addr : [
    (addr as { addressLocality?: string } | undefined)?.addressLocality,
    (addr as { addressRegion?: string } | undefined)?.addressRegion,
  ].filter(Boolean).join(', ');
  const isRemote = /telecommute/i.test(String(jp.jobLocationType ?? ''));
  return {
    url: source.url,
    title: clean(jp.title),
    company: clean(jp.hiringOrganization?.name) || source.name,
    location: clean(place) || (isRemote ? 'Remote' : ''),
    posted: String(jp.datePosted ?? '').slice(0, 10),
    source: `page:${source.name}`,
  };
}

type PageSource = {
  name: string;
  type: string;
  url: string;
  max_pages?: number;
  link?: string;
  keep_location?: string;
};

/**
 * sources: [{name, type, url, max_pages?, link?}]. `url` may contain {page} for embedded-json paging.
 */
export async function fetchPageSources(
  sources: PageSource[] | null | undefined,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; log?: (msg: string) => void } = {},
): Promise<SourceResult> {
  const { fetchImpl = fetch as FetchLike, sleep = sleepMs, log = console.error } = opts;
  const errors: SourceError[] = [];
  const jobs: ScanRow[] = [];
  for (const s of sources ?? []) {
    try {
      const got: ScanRow[] = [];
      if (s.type === 'embedded-json') {
        for (let page = 1; page <= (s.max_pages ?? 1); page++) {
          const { text } = await getText(s.url.replace('{page}', String(page)), fetchImpl);
          const parsed = parseEmbeddedJobs(text, s);
          const fresh = parsed.filter((j) => !got.some((g) => g.url === j.url));
          if (!fresh.length) break;
          got.push(...fresh);
          await sleep(1000);
        }
      } else if (s.type === 'listing-jsonld') {
        const { text, url } = await getText(s.url, fetchImpl);
        for (const link of listingLinks(text, url, s.link ?? '/job')) {
          try {
            const jp = extractJobPosting((await getText(link, fetchImpl)).text);
            if (jp) got.push(jobFromJsonLd(jp as JsonLdJobPosting, { name: s.name, url: link }));
          } catch { /* one dead detail page */ }
          await sleep(500);
        }
      } else throw new Error(`unknown page source type "${s.type}"`);
      if (!got.length) throw new Error('no jobs found (markup changed, or the board is empty)');
      const keep = s.keep_location ? new RegExp(s.keep_location, 'i') : null;
      jobs.push(...(keep ? got.filter((j) => !j.location || keep.test(j.location!)) : got));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`page source "${s.name}" failed: ${msg}`);
      errors.push({ company: s.name, error: msg });
    }
  }
  return Object.assign(jobs, { errors });
}
