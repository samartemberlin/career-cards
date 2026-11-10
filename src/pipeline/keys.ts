import { createHash } from 'node:crypto';

export type Job = {
  key: string;
  url: string;
  company: string;
  title: string;
  location?: string;
  jd?: string;
  posted?: string;
  deadline?: string;
  employment_type?: string;
  source?: string;
};

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

// [regex over the URL, key builder]. First match wins; anything else → url:<hash>.
const ID_PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/, (m) => `greenhouse:${m[1]}:${m[2]}`],
  [/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/, (m) => `lever:${m[1]}:${m[2]}`],
  [/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/, (m) => `ashby:${m[1]}:${m[2]}`],
  [/\/\/([^./]+)\.jobs\.personio\.(?:de|com)\/job\/(\d+)/, (m) => `personio:${m[1]}:${m[2]}`],
  [/arbeitsagentur\.de\/jobsuche\/jobdetail\/([^/?#]+)/, (m) => `ba:${m[1]}`],
  [/interamt\.de\/koop\/app\/stelle\?(?:[^#]*&)?id=(\d+)/, (m) => `interamt:${m[1]}`],
  // Greenhouse-hosted careers sites on the company's own domain keep the job id in gh_jid (same job, every language)
  [/\/\/([^/]+)\/.*[?&]gh_jid=(\d+)/, (m) => `gh:${m[1]!.replace(/^www\./, '').replace(/^careers\./, '')}:${m[2]}`],
  [/linkedin\.com\/jobs\/view\/(?:[\w%-]*-)?(\d{6,})/, (m) => `linkedin:${m[1]}`],
  [/join\.com\/companies\/([^/?#]+)\/(?:jobs\/)?([^/?#]+)/, (m) => `join:${m[1]}:${m[2]}`],
];

const TRACKING_PARAMS = /^(utm_|gh_src$|gclid$|fbclid$|ref$|source$)/i;

export function canonicalUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw.trim(); }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const s = u.toString();
  return s.endsWith('/') && u.pathname !== '/' ? s.slice(0, -1) : s;
}

export function jobKey(url: string): string {
  for (const [re, build] of ID_PATTERNS) {
    const m = re.exec(url);
    if (m) return build(m);
  }
  return `url:${sha1(canonicalUrl(url)).slice(0, 12)}`;
}

const LEGAL_SUFFIX = /\b(gmbh|ggmbh|ug|ag|se|e\.?v\.?|inc|ltd|llc|co|kg|mbh)\b\.?/g;

export function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\(\s*[mwfdx/*:_]+\s*\)/g, ' ') // (m/w/d) gender suffixes
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function fingerprint(company: string, title: string): string {
  return sha1(`${norm(company)}|${norm(title)}`).slice(0, 12);
}
