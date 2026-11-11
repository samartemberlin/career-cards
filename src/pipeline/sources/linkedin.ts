// LinkedIn via the public *guest* endpoints (no login, no account involved), ported from the
// legacy pipeline. Automated access is against LinkedIn's terms of service; the volume is therefore
// deliberately small: a couple of pages per query, a pause between requests, descriptions only for
// jobs that survived free filters and a per-run cap. On any block signal (429/999) we stop at
// once instead of retrying.
import { htmlToText, decodeEntities } from '../html.ts';
import type { FetchLike } from '../jd.ts';
import type { ScanRow, SourceError, SourceResult } from './types.ts';


const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LinkedInBlocked extends Error {}

const field = (re: RegExp, card: string): string => {
  const m = re.exec(card);
  return m ? decodeEntities(m[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
};

export type SearchCard = { id: string; title: string; company: string; location: string; posted: string; url: string };

/** Split a guest-search response into postings. Pure: tests feed it saved HTML. */
export function parseCards(html: string): SearchCard[] {
  const out: SearchCard[] = [];
  for (const card of html.split(/<li>\s*(?=<div class="base-card)/).slice(1)) {
    const id = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(card)?.[1];
    const title = field(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/, card);
    if (!id || !title) continue;
    out.push({
      id,
      title,
      company: field(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/, card),
      location: field(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/, card),
      posted: /datetime="(\d{4}-\d{2}-\d{2})/.exec(card)?.[1] ?? '',
      url: `https://www.linkedin.com/jobs/view/${id}/`,
    });
  }
  return out;
}

/** Text of the description block of a guest job page; '' if the page has none (e.g. a block page). */
export function parseJobPosting(html: string): string {
  const start = /<div class="show-more-less-html__markup[^"]*"[^>]*>/.exec(html);
  if (!start) return '';
  let depth = 1;
  const tag = /<(\/?)div\b/gi;
  tag.lastIndex = start.index + start[0].length;
  let end = html.length; // a truncated response keeps whatever text there is
  for (let m: RegExpExecArray | null; (m = tag.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { end = m.index; break; }
  }
  return htmlToText(html.slice(start.index + start[0].length, end));
}

const DEFAULT_WAITS_MIN = [1, 3, 7, 15]; // between retries of a blocked request; a pipeline may run for an hour

type PatientOpts = {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  waitsMin?: number[];
  deadline?: number;
  random?: () => number;
  log?: (msg: string) => void;
};

/**
 * GET with patience: a block (429/999) or a flaky answer (5xx, network) is retried after growing waits.
 * Throws LinkedInBlocked once the waits are used up or the overall deadline would be passed.
 */
async function getPatient(url: string, opts: PatientOpts): Promise<string> {
  const { fetchImpl, sleep, waitsMin = DEFAULT_WAITS_MIN, deadline = Infinity, random = Math.random, log = (): void => {} } = opts;
  for (let attempt = 0; ; attempt++) {
    try { return await get(url, fetchImpl); }
    catch (e) {
      const blocked = e instanceof LinkedInBlocked;
      const transient = blocked || /^HTTP 5\d\d$|fetch failed|timeout|aborted/i.test((e as Error).message);
      if (!transient) throw e;
      const waitMs = blocked ? (waitsMin[attempt] ?? null) : (attempt < 1 ? 0.1 : null);
      if (waitMs === null || waitMs === undefined) throw blocked ? e : new Error((e as Error).message);
      const ms = waitMs * 60000 * (0.85 + random() * 0.3);
      if (Date.now() + ms > deadline) throw new LinkedInBlocked(`${(e as Error).message}; no time left to wait ${Math.round(ms / 60000)} min`);
      log(`linkedin: ${(e as Error).message}; waiting ${(ms / 60000).toFixed(1)} min before retry ${attempt + 1}`);
      await sleep(ms);
    }
  }
}

async function get(url: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(25000) });
  if (res.status === 429 || res.status === 999) throw new LinkedInBlocked(`LinkedIn answered HTTP ${res.status} (rate limited)`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export type LinkedInConfig = {
  location?: string;
  recency_days?: number;
  max_pages_per_query?: number;
  delay_seconds?: number;
  max_total_minutes?: number;
  queries?: string[];
  block_waits_minutes?: number[];
  searches?: Array<{ location: string; remote?: boolean; queries?: string[] }>;
};

/**
 * cfg: {location, recency_days, max_pages_per_query, delay_seconds, queries, searches?: [{location, remote?, queries?}]}
 * Returns scanned-job rows; `.errors` lists what failed. Stops entirely when LinkedIn blocks us.
 */
export async function fetchLinkedinSearch(
  cfg: LinkedInConfig,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; log?: (msg: string) => void; random?: () => number } = {},
): Promise<SourceResult> {
  const { fetchImpl = fetch as FetchLike, sleep = sleepMs, log = console.error, random = Math.random } = opts;
  const errors: SourceError[] = [];
  const rows: ScanRow[] = [];
  const seen = new Set<string>();
  const searches = cfg.searches?.length ? cfg.searches : [{ location: cfg.location ?? 'Berlin, Germany' }];
  const secs = Math.round((cfg.recency_days ?? 3) * 86400);
  const pages = cfg.max_pages_per_query ?? 2;
  const delay = (cfg.delay_seconds ?? 2) * 1000;
  const deadline = Date.now() + (cfg.max_total_minutes ?? 40) * 60000;
  const patient: PatientOpts = { fetchImpl, sleep, waitsMin: cfg.block_waits_minutes ?? DEFAULT_WAITS_MIN, deadline, random, log };
  try {
    for (const s of searches) {
      for (const q of s.queries ?? cfg.queries ?? []) {
        for (let page = 0; page < pages; page++) {
          const url = `${SEARCH}?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(s.location)}&f_TPR=r${secs}&start=${page * 10}${s.remote ? '&f_WT=2' : ''}`;
          let cards: SearchCard[];
          if (Date.now() > deadline) throw new LinkedInBlocked(`time budget of ${cfg.max_total_minutes ?? 40} min used up`);
          try { cards = parseCards(await getPatient(url, patient)); }
          catch (e) { if (e instanceof LinkedInBlocked) throw e; errors.push({ company: 'LinkedIn', error: `"${q}" @ ${s.location}: ${(e as Error).message}` }); break; }
          await sleep(delay * (0.75 + random() * 0.5)); // jitter: a fixed beat looks like a bot
          if (!cards.length) break; // no more pages
          for (const c of cards) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            rows.push({ url: c.url, title: c.title, company: c.company, location: c.location, posted: c.posted, source: 'linkedin' });
          }
        }
      }
    }
  } catch (e) {
    if (!(e instanceof LinkedInBlocked)) throw e;
    log(`linkedin: ${e.message}; stopped after ${rows.length} jobs`);
    errors.push({ company: 'LinkedIn', error: `${e.message}; stopped after ${rows.length} jobs` });
    jdState.disabled = `search was blocked: ${e.message}`; // descriptions come from the same host, so they would be blocked too
  }
  return Object.assign(rows, { errors });
}

// ---- descriptions: one request per job, paced, capped per process -----------------------

type JdState = { calls: number; last: number; disabled: string; waitedMs: number };
const jdState: JdState = { calls: 0, last: 0, disabled: '', waitedMs: 0 };

export function resetLinkedinJdBudget(): void {
  Object.assign(jdState, { calls: 0, last: 0, disabled: '', waitedMs: 0 });
}

type FetchLinkedinJdOpts = {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Maximum description fetches per process (default 40). */
  cap?: number;
  gapMs?: number;
  maxWaitMin?: number;
  /** Epoch ms after which a block is not waited out. */
  deadline?: number;
  random?: () => number;
  log?: (msg: string) => void;
};

/**
 * Description text, or null (cap reached, still blocked after waiting, gone, or no description).
 * A block is waited out (growing waits, at most `maxWaitMin` in total per process); if it persists,
 * description fetching is switched off for the rest of the run and the jobs are retried tomorrow.
 * Cap comes from the option (default 40), never from an environment variable.
 */
export async function fetchLinkedinJd(id: string, opts: FetchLinkedinJdOpts = {}): Promise<string | null> {
  const {
    fetchImpl = fetch as FetchLike,
    sleep = sleepMs,
    cap = 40,
    gapMs = 2000,
    maxWaitMin = 20,
    deadline = Infinity,
    random = Math.random,
    log = console.error,
  } = opts;
  if (jdState.disabled || jdState.calls >= cap) return null; // the job stays unfetched and is retried on a later run
  jdState.calls++;
  const wait = jdState.last + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  const budgetLeft = maxWaitMin * 60000 - jdState.waitedMs;
  const trackedSleep = async (ms: number): Promise<void> => { jdState.waitedMs += ms; await sleep(ms); };
  try {
    const html = await getPatient(POSTING + id, { fetchImpl, sleep: trackedSleep, deadline: Math.min(deadline, Date.now() + Math.max(0, budgetLeft)), random, log });
    jdState.last = Date.now();
    const text = parseJobPosting(html);
    return text.length >= 200 ? text : null;
  } catch (e) {
    jdState.last = Date.now();
    if (e instanceof LinkedInBlocked) { jdState.disabled = e.message; log(`linkedin: descriptions switched off for this run (${e.message})`); }
    return null;
  }
}
