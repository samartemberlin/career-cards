// Job-description fetching.
//   1. LinkedIn guest endpoint, paced and capped (see linkedin.ts, Task 3)
//   2. Known ATS (greenhouse/lever/ashby/workday) → upstream career-ops fetch-jd.mjs
//   3. Schema.org JobPosting JSON-LD in the page (Bundesagentur, Arbeitnow, many others)
//   4. Visible page text, as a last resort (source: 'html')
// A miss returns null: never a fabricated JD.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { careerOpsEnv } from './career-ops-env.ts';
import type { ParentEnv } from './career-ops-env.ts';
import type { Job } from './keys.ts';
import { extractJobPosting, fromJobPosting, htmlToText } from './html.ts';
import { fetchLinkedinJd } from './sources/linkedin.ts';

const MAX_HTML = 3_000_000;
const MAX_TEXT = 20_000;
const MIN_TEXT = 200;

const ATS_KEY = /^(greenhouse|lever|ashby|workday):/;

/** Minimal fetch-compatible interface accepted by fetchJd. */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

type AtsFetch = (dir: string, url: string, env: Record<string, string>, timeoutMs?: number) => Promise<string | null>;
type LinkedinFetch = (id: string, o: { deadline?: number }) => Promise<string | null>;

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAREER_OPS_DIR = join(__dir, '..', '..', 'career-ops');

function runFetchJd(careerOpsDir: string, url: string, env: Record<string, string>, timeoutMs = 30000): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['fetch-jd.mjs', url], {
      cwd: careerOpsDir,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    p.stdout.on('data', (d: Buffer) => { out += d; });
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code: number | null) => {
      clearTimeout(t);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

async function getHtml(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (career-cards)', 'accept-language': 'de,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, MAX_HTML);
}

export type FetchJdResult = { jd: string; meta: Partial<Job> };

export type FetchJdOpts = {
  fetchImpl?: FetchLike;
  atsFetch?: AtsFetch;
  careerOpsDir?: string;
  linkedinFetch?: LinkedinFetch;
  /** Only PATH, HOME and LANG of it reach fetch-jd.mjs. */
  env?: ParentEnv;
  /** Epoch ms: no request runs past it. */
  deadline?: number;
  /** For links from comments: only `fetchImpl` runs. career-ops' fetch-jd child has no public-address guard, and the
   *  LinkedIn guest API gives no title. */
  pageOnly?: boolean;
};

export async function fetchJd(
  job: { key: string; url: string },
  opts: FetchJdOpts = {},
): Promise<FetchJdResult | null> {
  const {
    fetchImpl = fetch as FetchLike,
    atsFetch = runFetchJd,
    careerOpsDir = DEFAULT_CAREER_OPS_DIR,
    env = process.env,
    deadline = Infinity,
    pageOnly = false,
    // LinkedIn guest endpoint, paced and capped; injectable for tests.
    linkedinFetch = (id: string, o: { deadline?: number }): Promise<string | null> => fetchLinkedinJd(id, o),
  } = opts;
  const timeout = (ms: number): number => Math.max(1, Math.min(ms, deadline - Date.now()));

  if (!pageOnly && job.key.startsWith('linkedin:')) {
    const id = job.key.slice('linkedin:'.length);
    const text = await linkedinFetch(id, { deadline });
    return text
      ? { jd: text.slice(0, MAX_TEXT), meta: { source: 'linkedin' } }
      : null;
  }

  if (!pageOnly && ATS_KEY.test(job.key)) {
    const text = await atsFetch(careerOpsDir, job.url, careerOpsEnv(env), timeout(30000));
    if (text && text.length >= MIN_TEXT) {
      return { jd: text.slice(0, MAX_TEXT), meta: { source: 'ats-api' } };
    }
  }

  let html: string;
  try { html = await getHtml(job.url, fetchImpl, timeout(25000)); } catch { return null; }

  const jp = extractJobPosting(html);
  if (jp) {
    const r = fromJobPosting(jp);
    if (r.jd && r.jd.length >= MIN_TEXT) return { jd: r.jd, meta: r };
  }

  const jd = htmlToText(html).slice(0, MAX_TEXT);
  return jd.length >= MIN_TEXT * 3 ? { jd, meta: { source: 'html' } } : null;
}
