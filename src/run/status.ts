import type { TCard, TList, BotApi } from '../trello/api.ts';
import { DESC_LIMIT } from '../trello/cards.ts';
import type { RunState, RunTrigger, RunStats } from './stats.ts';

export const RUNS_LIST = 'Runs';

export type StatusView = {
  state: RunState;
  /** Pre-computed run column name, e.g. "Nov 10 · 01:00". */
  column: string;
  trigger: RunTrigger;
  start: Date;
  stats?: RunStats;
  durationMs?: number;
  reason?: string;
  error?: string;
  problems?: string[];
  log?: string[];
  /** Applied to every caller-supplied text field (reason, error, problems) before it is written to the card.
   *  Pass RunLog.redact here to enforce the secret-free guarantee at the boundary. */
  redact?: (s: string) => string;
};

const MARKS: Record<RunState, string> = {
  ok: '✅',
  failed: '❌',
  skipped: '⏭️',
};

// Abort reasons carry every provider's error text, which can run to kilobytes.
const ABORT_MAX = 300;
const ITEM_MAX = 500;

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Card title: "<mark> <column> · <trigger> · <outcome>" */
export function statusTitle(v: StatusView): string {
  const mark = MARKS[v.state];
  let outcome: string;
  if (v.state === 'ok') {
    const created = v.stats?.cards.created ?? 0;
    outcome = `+${created} cards`;
    if (v.stats?.warnings?.length) {
      outcome += ` · ⚠️ ${v.stats.warnings.length} warnings`;
    }
  } else {
    // failed or skipped: show reason, clipped to 40 chars
    const r = v.redact ?? ((s: string) => s);
    outcome = clip(r(v.reason ?? v.state), 40);
  }
  return `${mark} ${v.column} · ${v.trigger} · ${outcome}`;
}

/** Top N rules by count, highest first. */
export function topRules(rules: Record<string, number>, n: number): [string, number][] {
  return Object.entries(rules)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function buildCountLines(v: StatusView): string[] {
  const s = v.stats;
  if (!s) return [];
  const r = v.redact ?? ((t: string) => t);
  // Redact before clipping: a clip through the middle of a secret would leave a prefix no redaction can find.
  const abortText = (t: string): string => clip(r(t), ABORT_MAX);

  const lines: string[] = [];

  // Per-source scan counts
  const sources = Object.entries(s.bySource);
  if (sources.length) {
    lines.push(`Scan: ${sources.map(([name, d]) => `${name}: ${d.returned} returned, ${d.new} new`).join(' | ')}`);
  }

  lines.push(
    `Scanned: ${s.scanned} · Known: ${s.known} · Fresh: ${s.fresh} · Rejected pre: ${s.rejectedPre} · post: ${s.rejectedPost}`,
  );

  const top = topRules(s.rules, 5);
  if (top.length) {
    lines.push(`Top rules: ${top.map(([r, n]) => `${r}: ${n}`).join(', ')}`);
  }

  lines.push(`JD: ${s.jd.fetched} fetched · ${s.jd.missing} missing · ${s.jd.deferred} deferred`);

  let factsLine = `Facts: ${s.facts.done} done · ${s.facts.errors} errors`;
  if (s.facts.aborted) factsLine += ` · aborted: ${abortText(s.facts.aborted)}`;
  if (s.facts.tokens) factsLine += ` · tokens: ${s.facts.tokens}`;
  lines.push(factsLine);

  let scoredLine = `Scored: ${s.scored} · errors: ${s.scoreErrors} · deferred: ${s.deferred} · left: ${s.left}`;
  if (s.leftUnmasked) scoredLine += ` · not masked: ${s.leftUnmasked}`;
  if (s.aborted) scoredLine += ` · aborted: ${abortText(s.aborted)}`;
  lines.push(scoredLine);
  if (s.shadow.jobs) lines.push(`Shadow penalties (not applied): ${s.shadow.jobs} jobs · ${s.shadow.points} points`);

  lines.push(`Cards: ${s.cards.created} created · ${s.cards.failed} failed`);
  lines.push(`Archived: ${s.archived.archived} · failed: ${s.archived.failed} · left: ${s.archived.left}`);

  const modelParts = Object.entries(s.models).map(([m, n]) => `${m}: ${n}`);
  lines.push(`Models: ${modelParts.length ? modelParts.join(', ') : '(none)'} · Tokens: ${s.tokens}`);

  if (v.durationMs !== undefined) {
    lines.push(`Duration: ${Math.round(v.durationMs / 1000)}s`);
  }

  if (v.error) {
    lines.push('', `Error: ${r(v.error)}`);
  }

  return lines;
}

/** Card description with counts, source errors, problems, warnings, log excerpt, and the contract line.
 *  Always ends with the contract line `career-cards-run: <ISO> <state>`, under Trello's DESC_LIMIT: when over, the
 *  log excerpt is cut first, then the source errors, then warnings and last problems, each list ending with
 *  "… and N more". */
export function statusDesc(v: StatusView): string {
  const contract = `career-cards-run: ${v.start.toISOString()} ${v.state}`;
  const CONTRACT_SEP = '\n\n';
  const budget = DESC_LIMIT - CONTRACT_SEP.length - contract.length;

  const countLines = buildCountLines(v);
  const r = v.redact ?? ((s: string) => s);

  // Source-error text can contain provider URLs with keys in the query string — redact the full line.
  const allErrLines = (v.stats?.sourceErrors ?? []).map((e) => r(`${e.company}: ${e.error}`));
  const item = (t: string): string => `- ${clip(r(t), ITEM_MAX)}`;
  const problems = (v.problems ?? []).map(item);
  const warnings = (v.stats?.warnings ?? []).map(item);
  const section = (title: string, lines: string[], keep: number): string[] => (lines.length
    ? ['', title, ...lines.slice(0, keep), ...(keep < lines.length ? [`- … and ${lines.length - keep} more`] : [])]
    : []);

  const rawLogLines = (v.log ?? [])
    .slice(-40)
    .map((l) => (l.length > 200 ? l.slice(0, 199) + '…' : l));

  function buildBody(errLines: string[], logLines: string[], keepProblems: number, keepWarnings: number): string {
    const parts = [...countLines];
    if (errLines.length) {
      parts.push('', `Source errors (${errLines.length}):`, ...errLines);
    }
    parts.push(...section('Problems:', problems, keepProblems), ...section('Warnings:', warnings, keepWarnings));
    if (logLines.length) {
      parts.push('', `Log (last ${logLines.length} lines):`, ...logLines);
    }
    // Every field is redacted where it is built; this pass also covers fields added later.
    return r(parts.join('\n'));
  }
  const fits = (body: string): boolean => body.length <= budget;
  const done = (body: string): string => body + CONTRACT_SEP + contract;
  /** The largest k in 0..n for which ok(k) holds, assuming ok is monotone; 0 when none does. */
  const largest = (n: number, ok: (k: number) => boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ok(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const P = problems.length;
  const W = warnings.length;

  let body = buildBody(allErrLines, rawLogLines, P, W);
  if (fits(body)) return done(body);

  for (let n = rawLogLines.length - 1; n >= 0; n--) {
    body = buildBody(allErrLines, n > 0 ? rawLogLines.slice(-n) : [], P, W);
    if (fits(body)) return done(body);
  }

  const errs = largest(allErrLines.length, (k) => fits(buildBody(allErrLines.slice(0, k), [], P, W)));
  body = buildBody(allErrLines.slice(0, errs), [], P, W);
  if (fits(body)) return done(body);

  const keepW = largest(W, (k) => fits(buildBody([], [], P, k)));
  body = buildBody([], [], P, keepW);
  if (fits(body)) return done(body);

  const keepP = largest(P, (k) => fits(buildBody([], [], k, 0)));
  return done(clip(buildBody([], [], keepP, 0), budget));
}

/** Parses the status and start time from the last line of a status card description.
 *  Returns null when the last line is not the contract line `career-cards-run: <ISO> <state>`. */
export function parseStatusCard(c: { name: string; desc: string }): { state: RunState; start: Date } | null {
  const last = c.desc.trimEnd().split('\n').at(-1)?.trim() ?? '';
  const m = /^career-cards-run: (\S+) (\S+)$/.exec(last);
  if (!m) return null;
  const start = new Date(m[1]!);
  if (isNaN(start.getTime())) return null;
  const state = m[2]!;
  if (state !== 'ok' && state !== 'failed' && state !== 'skipped') return null;
  return { state: state as RunState, start };
}

/** Returns the open list named 'Runs' on the system board, creating it at the bottom when asked. */
export async function findRunsList(
  api: BotApi,
  systemBoard: string,
  o: { create: boolean },
): Promise<TList | null> {
  const lists = await api.lists(systemBoard, 'open');
  const found = lists.find((l) => l.name.trim() === RUNS_LIST);
  if (found) return found;
  if (!o.create) return null;
  return api.createList(systemBoard, RUNS_LIST, 'bottom');
}

/** Creates a new status card at the top of the given list. */
export async function createStatusCard(
  api: BotApi,
  listId: string,
  v: StatusView,
): Promise<TCard> {
  return api.createCard({
    idList: listId,
    name: statusTitle(v),
    desc: statusDesc(v),
    pos: 'top',
  });
}
