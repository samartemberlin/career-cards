// One run for one user: config cards, private-board check, masking, scan, scoring, the run column, archiving, all
// reported on a status card in System › Runs. Ties together the modules in src/run and src/trello.
import { parseYamlBlock } from '../config/schema.ts';
import type { UserConfig } from '../config/schema.ts';
import { loadExtractor } from '../pipeline/facts.ts';
import { llmConfig, providerProblems } from '../pipeline/llm.ts';
import type { CallOpts, Env } from '../pipeline/llm.ts';
import { buildScoreContext, PrivacyError } from '../privacy.ts';
import type { MaskedContext } from '../privacy.ts';
import type { TCard, TList, TrelloApi } from '../trello/api.ts';
import { runColumnName } from '../trello/cards.ts';
import { ConfigInvalid, readUserConfig } from '../trello/config.ts';
import type { ConfigProblem, UserBoards } from '../trello/config.ts';
import { loadJobIndex } from '../trello/job-index.ts';
import { checkBoardsPrivate } from '../trello/private.ts';
import { readOnlyClient } from '../trello/read-only.ts';
import { isGuardError, scopeUserBoards } from '../trello/scoped.ts';
import { archiveRunCards, writeRunColumn } from './column.ts';
import { createRunLog, secretsFromEnv } from './log.ts';
import { isoDateIn, processJobs } from './process.ts';
import type { ProcessDeps } from './process.ts';
import { activeProfiles, combinedFilter, scoringProfile } from './profiles.ts';
import type { ScanOutput } from './scan.ts';
import { buildScanPlan, loadDefaults } from './sources-plan.ts';
import type { Defaults, ScanPlan } from './sources-plan.ts';
import { emptyStats } from './stats.ts';
import type { RunState, RunStats, RunTrigger } from './stats.ts';
import {
  activeRun, createStatusCard, findRunsList, runningCards, staleRuns, statusDesc, updateStatusCard, STALE_MS,
} from './status.ts';
import type { StatusView } from './status.ts';

export type RunDeps = {
  /** The raw client; runOnce scopes it to `boards`. */
  trello: TrelloApi;
  boards: UserBoards;
  scan: (plan: ScanPlan) => Promise<ScanOutput>;
  fetchJd: ProcessDeps['fetchJd'];
  env: Env;
  call?: CallOpts;
  defaults?: Defaults;
  extractor?: string;
  now: () => Date;
  sink: (line: string) => void;
};

export type RunOpts = {
  trigger: RunTrigger;
  dryRun: boolean;
  /** Can only lower Settings' scoring_cap. */
  cap?: number;
  budgetMs?: number;
};

export type RunOutcome = {
  state: RunState;
  exitCode: 0 | 1 | 3;
  column: string;
  statusUrl: string | null;
  stats: RunStats;
  problems: string[];
  /** The status card's description text (for a dry run, what would have been done, then that text). */
  report: string;
};

const DEFAULT_TZ = 'Europe/Berlin';
const DEFAULT_BUDGET_MS = 55 * 60_000;
const SCORING_MARGIN_MS = 5 * 60_000;
const ARCHIVE_MARGIN_MS = 60_000;
const COMMENT_MAX = 2000;
const SOURCE_ERROR_MAX = 300;
const SKIP_REASON = 'another run in progress';
const EXIT: Record<RunState, 0 | 1 | 3> = { ok: 0, failed: 1, skipped: 3, running: 1 };

/** A planned stop: the run fails with this reason and these problems on the status card. */
class RunStop extends Error {
  readonly reason: string;
  readonly problems: string[];
  constructor(reason: string, problems: string[] = []) {
    super(reason);
    this.reason = reason;
    this.problems = problems;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? '';
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The Settings card's timezone when its YAML parses and names a zone Intl knows; else Europe/Berlin. The full
 *  config is read later, but the status card needs its column name before that. */
function timezoneOf(systemCards: TCard[]): string {
  const card = systemCards.find((c) => c.name.trim().toLowerCase() === 'settings');
  if (!card) return DEFAULT_TZ;
  try {
    const tz = (parseYamlBlock(card.desc) as { timezone?: unknown } | null)?.timezone;
    if (typeof tz !== 'string') return DEFAULT_TZ;
    runColumnName(new Date(0), tz);
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

function abandonedView(r: { card: TCard; start: Date }, tz: string): StatusView {
  const m = /^\S+ (.+) · (scheduled|manual) · /u.exec(r.card.name);
  return {
    state: 'failed',
    column: m?.[1] ?? runColumnName(r.start, tz),
    trigger: (m?.[2] as RunTrigger | undefined) ?? 'scheduled',
    start: r.start,
    reason: 'abandoned',
    problems: [`still running after ${STALE_MS / 3_600_000} hours; marked failed by a later run`],
  };
}

function problemText(p: ConfigProblem): string {
  return `${p.where}: ${p.message}${p.card ? ` (${p.card.url})` : ''}`;
}

/** One comment per card that broke the config; a failed comment is logged, the run still fails on the config. */
async function commentOnBadCards(
  api: TrelloApi, problems: ConfigProblem[], column: string, redact: (s: string) => string, log: (s: string) => void,
): Promise<void> {
  const byCard = new Map<string, string[]>();
  for (const p of problems) {
    if (!p.card) continue;
    byCard.set(p.card.id, [...(byCard.get(p.card.id) ?? []), p.message]);
  }
  for (const [id, msgs] of byCard) {
    const text = `career-cards: this card stopped the run of ${column}:\n${msgs.map((m) => `- ${m}`).join('\n')}`;
    try {
      await api.comment(id, clip(redact(text), COMMENT_MAX));
    } catch (e) {
      if (isGuardError(e)) throw e;
      log(`comment on config card ${id} failed: ${firstLine(message(e))}`);
    }
  }
}

/** Scan counts into stats. career-ops' failure message carries up to 2,000 chars of its output: the full text goes to
 *  the log (redacted, and clipped per line on the card), only its first line to the source errors and warnings. */
function recordScan(out: ScanOutput, known: Set<string>, stats: RunStats, log: (s: string) => void): void {
  stats.scanned = out.jobs.length;
  for (const j of out.jobs) {
    const s = (stats.bySource[j.source ?? 'unknown'] ??= { returned: 0, new: 0 });
    s.returned++;
    if (!known.has(j.key)) s.new++;
  }
  stats.sourceErrors = out.errors.map((e) => {
    const short = clip(firstLine(e.error), SOURCE_ERROR_MAX);
    if (short !== e.error.trim()) log(`${e.company}: ${clip(e.error, 1000)}`);
    return { ...e, error: short };
  });
  for (const e of stats.sourceErrors) {
    if (e.company === 'career-ops') stats.warnings.push(`career-ops scan failed: ${e.error}`);
  }
}

/** One run end to end. Never throws: every failure ends in the returned outcome, and once the ⏳ status card is
 *  written, on that card too. */
export async function runOnce(deps: RunDeps, opts: RunOpts): Promise<RunOutcome> {
  const start = deps.now();
  // scoreAll and archiveRunCards compare their deadlines with Date.now(), so the budget runs on the real clock.
  const t0 = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const runLog = createRunLog({ sink: deps.sink, secrets: secretsFromEnv(deps.env) });
  const log = (s: string): void => runLog.log(s);
  const stats = emptyStats();
  const problems: string[] = [];
  const scoped = scopeUserBoards(deps.trello, deps.boards);
  const api = opts.dryRun ? readOnlyClient(scoped) : scoped;
  let column = runColumnName(start, DEFAULT_TZ);
  let tz = DEFAULT_TZ;
  let statusCard: TCard | null = null;
  let dryLines: string[] = [];

  const view = (state: RunState, extra: Partial<StatusView> = {}): StatusView => ({
    state, column, trigger: opts.trigger, start, stats, problems, log: runLog.lines(), redact: runLog.redact,
    ...(state === 'running' ? {} : { durationMs: Date.now() - t0 }), ...extra,
  });

  const outcome = (v: StatusView, exitCode: 0 | 1 | 3 = EXIT[v.state]): RunOutcome => ({
    state: v.state, exitCode, column, statusUrl: statusCard?.shortUrl ?? null, stats, problems: problems.map(runLog.redact),
    report: [...dryLines, statusDesc(v)].join('\n\n'),
  });

  async function finish(state: RunState, extra: Partial<StatusView> = {}): Promise<RunOutcome> {
    log(`run ${column}: ${state}${extra.reason ? ` (${extra.reason})` : ''}`);
    const v = view(state, extra);
    if (!statusCard) return outcome(v);
    try {
      await updateStatusCard(api, statusCard.id, v);
    } catch (e) {
      log(`status card update failed: ${firstLine(message(e))}`);
      return outcome(view(state, extra), 1);
    }
    return outcome(v);
  }

  function failure(e: unknown): Promise<RunOutcome> {
    if (e instanceof RunStop) {
      problems.push(...e.problems);
      return finish('failed', { reason: e.reason });
    }
    const line = firstLine(message(e)) || 'unknown error';
    return finish('failed', { reason: line, error: line });
  }

  log(`run ${column} (${opts.trigger}${opts.dryRun ? ', dry run' : ''})`);

  // Steps 2-3: the Runs list, the time zone, other runs, our ⏳ card. Before that card exists a failure has no card.
  let runs: TList | null = null;
  try {
    runs = await findRunsList(api, deps.boards.system, { create: !opts.dryRun });
    const systemCards = await api.cards(deps.boards.system, { filter: 'open' });
    tz = timezoneOf(systemCards);
    column = runColumnName(start, tz);
    if (!opts.dryRun && runs) {
      const runsId = runs.id;
      const runCards = systemCards.filter((c) => c.idList === runsId);
      for (const r of staleRuns(runCards, start)) {
        try {
          await updateStatusCard(api, r.card.id, abandonedView(r, tz));
          log(`marked the run started ${r.start.toISOString()} as abandoned`);
        } catch (e) {
          if (isGuardError(e)) throw e;
          log(`could not mark the run started ${r.start.toISOString()} as abandoned: ${firstLine(message(e))}`);
        }
      }
      const active = activeRun(runCards, start);
      if (active) {
        log(`the run started ${active.start.toISOString()} is still running`);
        const v = view('skipped', { reason: SKIP_REASON });
        statusCard = await createStatusCard(api, runsId, v);
        return outcome(v);
      }
      statusCard = await createStatusCard(api, runsId, view('running'));
    }
  } catch (e) {
    log(`run could not start: ${firstLine(message(e))}`);
    return failure(e);
  }

  try {
    if (statusCard && runs) {
      // Two runs can pass the check above at once; the one with the earlier start (then the lower id) goes on.
      const ours = statusCard;
      const runsId = runs.id;
      const others = (await api.cards(deps.boards.system, { filter: 'open' }))
        .filter((c) => c.idList === runsId && c.id !== ours.id);
      const earlier = runningCards(others).find((r) =>
        start.getTime() - r.start.getTime() < STALE_MS &&
        (r.start < start || (r.start.getTime() === start.getTime() && r.card.id < ours.id)));
      if (earlier) {
        log(`the run started ${earlier.start.toISOString()} started first`);
        return await finish('skipped', { reason: SKIP_REASON });
      }
    }

    let cfg: UserConfig;
    try {
      cfg = await readUserConfig(api, deps.boards);
    } catch (e) {
      if (!(e instanceof ConfigInvalid)) throw e;
      problems.push(...e.problems.map(problemText));
      if (!opts.dryRun) await commentOnBadCards(api, e.problems, column, runLog.redact, log);
      throw new RunStop('config error');
    }
    const { settings } = cfg;

    const me = await api.me();
    const privacy = await checkBoardsPrivate(
      api, [deps.boards.jobs, deps.boards.profiles, deps.boards.system],
      { allowedMembers: settings.allowed_members, botUsername: me.username },
    );
    if (privacy.length) {
      throw new RunStop('boards not private', privacy.map((p) => `${p.boardName}: ${p.reason} (${p.detail})`));
    }

    // Providers and masking are checked before any model call.
    const llmSettings = { providers: settings.providers, ...(settings.models ? { models: settings.models } : {}) };
    stats.warnings.push(...providerProblems(deps.env, llmSettings));
    const llm = llmConfig(deps.env, llmSettings);
    if (!llm.apiKey && !opts.dryRun) throw new RunStop('no scoring provider');
    const profile = scoringProfile(cfg);
    if (profile.warning) stats.warnings.push(profile.warning);
    let ctx: MaskedContext;
    try {
      ctx = buildScoreContext({ user: cfg, profile: { rubric: profile.rubric, cv: profile.cv }, llm, translateTitle: true });
    } catch (e) {
      if (e instanceof PrivacyError) throw new RunStop('masking failed', [`masking: ${e.message}`]);
      throw e;
    }

    const index = await loadJobIndex(api, deps.boards.jobs);
    const active = activeProfiles(cfg);
    const plan = buildScanPlan({ defaults: deps.defaults ?? loadDefaults(), sources: cfg.sources, profiles: active, settings });
    stats.warnings.push(...plan.warnings);
    const scanned = await deps.scan(plan);
    recordScan(scanned, index.keys, stats, log);
    const cap = Math.min(settings.scoring_cap, opts.cap ?? Infinity);
    const jobs = await processJobs(
      scanned.jobs, index.keys, combinedFilter(active, settings),
      {
        fetchJd: deps.fetchJd, ctx, extractor: deps.extractor ?? loadExtractor(), log,
        ...(deps.call ? { call: deps.call } : {}), ...(cfg.preferences ? { preferences: cfg.preferences } : {}),
      },
      { cap, deadline: t0 + budgetMs - SCORING_MARGIN_MS, today: isoDateIn(start, tz), dryRun: opts.dryRun },
      stats,
    );

    if (opts.dryRun || !statusCard) {
      const passed = stats.fresh - stats.rejectedPre;
      dryLines = [
        'Dry run: nothing written, no description fetched, no model called.',
        `Would describe and score: up to ${Math.min(passed, cap)} of the ${passed} jobs that passed the filters (cap ${cap})`,
        `Would archive: ${index.toArchive.length} cards`,
      ];
      return await finish('ok');
    }

    if (jobs.length) {
      try {
        const r = await writeRunColumn(api, {
          board: deps.boards.jobs, name: column, jobs, stats, statusUrl: statusCard.shortUrl, log,
          ...(settings.labels ? { labels: settings.labels } : {}),
        });
        stats.cards = { created: r.created, failed: r.failed };
        if (!r.summary) stats.warnings.push(`the summary card of ${column} could not be written`);
        if (r.created === 0) stats.warnings.push(`none of the ${jobs.length} job cards could be written`);
      } catch (e) {
        if (isGuardError(e)) throw e;
        stats.cards = { created: 0, failed: jobs.length };
        stats.warnings.push(`the run column ${column} could not be created: ${firstLine(message(e))}`);
        log(`run column ${column} failed: ${firstLine(message(e))}`);
      }
    }
    stats.archived = await archiveRunCards(api, index.toArchive, { deadline: t0 + budgetMs - ARCHIVE_MARGIN_MS, log });

    return await finish('ok');
  } catch (e) {
    if (!(e instanceof RunStop)) log(`run failed: ${clip(message(e), 1000)}`);
    return failure(e);
  }
}
