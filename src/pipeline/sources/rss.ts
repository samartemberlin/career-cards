// Extra sources career-ops has no provider for: plain RSS job feeds (WP Job Manager style).
// Returns scanned-job rows in the same shape the pipeline builds from career-ops scan history.
// Keys are assigned by the pipeline after scan.
import { decodeEntities, htmlToText } from '../html.ts';
import type { Job } from '../keys.ts';
import type { FetchLike } from '../jd.ts';

type ScanRow = Omit<Job, 'key'>;
type SourceError = { company: string; error: string };
type SourceResult = ScanRow[] & { errors: SourceError[] };

const tag = (xml: string, name: string): string => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decodeEntities(m[1]!.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim() : '';
};

export function parseRssJobs(xml: string, source: { name: string; location?: string }): ScanRow[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]!);
  const out: ScanRow[] = [];
  for (const it of items) {
    const title = htmlToText(tag(it, 'title'));
    const url = tag(it, 'link');
    if (!title || !/^https?:\/\//.test(url)) continue;
    const pub = tag(it, 'pubDate');
    const d = pub ? new Date(pub) : null;
    out.push({
      url,
      title,
      company: htmlToText(tag(it, 'job_listing:company')) || source.name,
      location: htmlToText(tag(it, 'job_listing:location')) || (source.location ?? ''),
      posted: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '',
      source: `rss:${source.name}`,
    });
  }
  return out;
}

export async function fetchRssSources(
  sources: Array<{ name: string; url: string; location?: string }> | null | undefined,
  opts: { fetchImpl?: FetchLike; log?: (msg: string) => void } = {},
): Promise<SourceResult> {
  const { fetchImpl = fetch as FetchLike, log = console.error } = opts;
  const errors: SourceError[] = [];
  const jobs: ScanRow[] = [];
  for (const s of sources ?? []) {
    try {
      const res = await fetchImpl(s.url, { headers: { 'user-agent': 'Mozilla/5.0 (career-cards)' }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseRssJobs(await res.text(), s);
      if (!parsed.length) throw new Error('feed has no job items');
      jobs.push(...parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`rss source "${s.name}" failed: ${msg}`);
      errors.push({ company: s.name, error: msg });
    }
  }
  return Object.assign(jobs, { errors }) as SourceResult;
}
