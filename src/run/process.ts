// One run's jobs, from scan rows to scored jobs: dedup against the board, free filters, descriptions, filters again,
// the per-run cap, scoring, then facts for the scored jobs. Ported from samjobs' processPerson, without its files: the
// board is the state, and a job not scored here (cap, quota, time, missing description) gets no card, so the next run
// sees it again.
import { extractAll } from '../pipeline/facts.ts';
import type { Facts } from '../pipeline/facts.ts';
import type { FetchJdResult } from '../pipeline/jd.ts';
import type { Job } from '../pipeline/keys.ts';
import type { CallOpts } from '../pipeline/llm.ts';
import { scoreAll } from '../pipeline/score.ts';
import { applyPenalties } from '../pipeline/prefs.ts';
import type { Penalties, Preferences } from '../pipeline/prefs.ts';
import type { MaskedContext } from '../privacy.ts';
import type { ScoredJob } from '../trello/writer.ts';
import { ruleId } from './stats.ts';
import type { RunStats } from './stats.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDateIn(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export type ProcessDeps = {
  fetchJd: (job: { key: string; url: string }) => Promise<FetchJdResult | null>;
  /** null when masking failed: then nothing is described or scored. */
  ctx: MaskedContext | null;
  extractor: string;
  call?: CallOpts;
  /** When given, penalties are computed for each scored job with facts and logged, never applied (shadow mode). */
  preferences?: Preferences;
  log: (s: string) => void;
};

export type ProcessedJob = ScoredJob & { shadow?: Penalties };

export type ProcessOpts = {
  cap: number;
  /** Epoch ms after which facts and scoring start no new job. */
  deadline: number;
  /** `YYYY-MM-DD` in the user's time zone; a deadline before it is expired. */
  today: string;
  dryRun: boolean;
  fetchConcurrency?: number;
  maxFetch?: number;
  maxLinkedinJd?: number;
};

const isLinkedin = (j: Job): boolean => j.key.startsWith('linkedin:');

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Newest `posted` first; jobs without an ISO date go after, in scan order (Array.sort is stable). */
function newestFirst(jobs: Job[]): Job[] {
  const iso = (j: Job) => (j.posted && ISO_DATE.test(j.posted) ? j.posted : '');
  return [...jobs].sort((a, b) => iso(b).localeCompare(iso(a)));
}

export async function processJobs(
  jobs: Job[],
  known: Set<string>,
  filter: (job: Job) => string | null,
  deps: ProcessDeps,
  opts: ProcessOpts,
  stats: RunStats,
): Promise<ProcessedJob[]> {
  const { cap, deadline, today, dryRun, fetchConcurrency = 6, maxFetch = cap * 2, maxLinkedinJd = 40 } = opts;
  const { ctx, log } = deps;
  // Every rejection is logged with its evidence: a wrong one is otherwise invisible, since rejected jobs are never scored.
  const reject = (job: Job, why: string) => {
    stats.rules[ruleId(why)] = (stats.rules[ruleId(why)] ?? 0) + 1;
    log(`rejected ${job.key} (${job.company} — ${job.title}): ${why}`);
  };

  const fresh = jobs.filter((j) => !known.has(j.key));
  stats.known += jobs.length - fresh.length;
  stats.fresh += fresh.length;

  const survivors: Job[] = [];
  for (const j of fresh) {
    const why = filter({ key: j.key, url: j.url, company: j.company, title: j.title, location: j.location });
    if (why) { reject(j, why); stats.rejectedPre++; } else survivors.push(j);
  }
  if (dryRun) return [];
  if (!ctx) {
    stats.leftUnmasked += survivors.length;
    stats.aborted ??= 'no masked scoring context: nothing scored';
    log(`${stats.aborted} (${survivors.length} jobs left for the next run)`);
    return [];
  }

  let linkedinLeft = maxLinkedinJd;
  const ordered = newestFirst(survivors);
  const toFetch = ordered.filter((j) => !isLinkedin(j) || linkedinLeft-- > 0).slice(0, maxFetch);
  stats.jd.deferred += ordered.length - toFetch.length;
  const jdOf = new Map<string, FetchJdResult>();
  const fetchOne = async (j: Job) => {
    let r: FetchJdResult | null = null;
    try { r = await deps.fetchJd({ key: j.key, url: j.url }); } catch (e) { log(`JD fetch failed ${j.key}: ${(e as Error).message}`); }
    if (r) { jdOf.set(j.key, r); stats.jd.fetched++; } else stats.jd.missing++;
  };
  // LinkedIn throttles bursts and a blocked request waits for minutes: everything else first, then LinkedIn one at a time.
  await pool(toFetch.filter((j) => !isLinkedin(j)), fetchConcurrency, fetchOne);
  await pool(toFetch.filter(isLinkedin), 1, fetchOne);

  const ready: Job[] = [];
  for (const j of toFetch) {
    const r = jdOf.get(j.key);
    if (!r) continue;
    const { employment_type, deadline: due, posted } = r.meta;
    const full: Job = {
      ...j, jd: r.jd,
      ...(employment_type ? { employment_type } : {}), ...(due ? { deadline: due } : {}), ...(posted ? { posted } : {}),
    };
    const why = filter(full) ?? (full.deadline && ISO_DATE.test(full.deadline) && full.deadline < today
      ? `EXPIRED: "deadline ${full.deadline}"` : null);
    if (why) { reject(full, why); stats.rejectedPost++; } else ready.push(full);
  }

  const batch = ready.slice(0, cap);
  stats.deferred += ready.length - batch.length;

  const res = await scoreAll(ctx, batch, { deadline, call: deps.call, log });
  stats.scored += res.results.length;
  stats.scoreErrors += res.errors.length;
  stats.tokens += res.tokens;
  for (const [m, n] of Object.entries(res.models)) stats.models[m] = (stats.models[m] ?? 0) + n;
  if (res.aborted) { stats.aborted ??= res.aborted; stats.left += res.left; }

  const order = new Map(batch.map((j, i) => [j.key, i]));
  const byKey = new Map(batch.map((j) => [j.key, j]));
  const scored = res.results.map((r) => byKey.get(r.key)!);

  // Facts come after scoring and only for scored jobs: they feed labels, card fields and the shadow penalties,
  // while the score is what the user waits for, so facts get whatever budget scoring left.
  let facts = new Map<string, Facts>();
  try {
    const r = await extractAll({ llm: ctx.llm, jobs: scored, extractor: deps.extractor, deadline, fetchImpl: deps.call?.fetchImpl, log });
    facts = r.facts;
    stats.facts.done += r.facts.size;
    stats.facts.errors += r.errors.length;
    stats.facts.aborted ??= r.aborted;
    stats.facts.tokens += r.tokens;
    for (const [m, n] of Object.entries(r.models)) stats.facts.models[m] = (stats.facts.models[m] ?? 0) + n;
  } catch (e) {
    log(`facts failed: ${(e as Error).message}`);
  }

  return res.results
    .map((r): ProcessedJob => {
      const j = byKey.get(r.key)!;
      const f = facts.get(r.key);
      const due = f?.deadline;
      // A past facts deadline would put an expired date on the card; the posting passed the EXPIRED check on its own data.
      const fill = !j.deadline && due && due >= today ? { deadline: due } : {};
      const out: ProcessedJob = {
        ...j, ...fill, score: r.score, reason: r.reason, flags: r.flags,
        ...(r.title_en ? { title_en: r.title_en } : {}), ...(f ? { facts: f } : {}),
      };
      if (f && deps.preferences) {
        const p = applyPenalties(f, deps.preferences);
        out.shadow = p;
        if (p.total > 0) {
          stats.shadow.jobs++;
          stats.shadow.points += p.total;
          log(`shadow penalty ${r.key}: -${p.total} (${Object.entries(p.parts).map(([k, v]) => `${k} ${v}`).join(', ')}), not applied to score ${r.score}`);
        }
      }
      return out;
    })
    .sort((a, b) => b.score - a.score || order.get(a.key)! - order.get(b.key)!);
}
