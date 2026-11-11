import type { TCard, TList, TrelloApi } from '../trello/api.ts';
import { DESC_LIMIT } from '../trello/cards.ts';
import type { RunState, RunTrigger, RunStats } from './stats.ts';

export const RUNS_LIST = 'Runs';
// A running card older than this is considered abandoned and will be marked ❌.
export const STALE_MS = 2 * 3600_000;

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
  running: '⏳',
  ok: '✅',
  failed: '❌',
  skipped: '⏭️',
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Card title: "<mark> <column> · <trigger> · <outcome>" */
export function statusTitle(v: StatusView): string {
  const mark = MARKS[v.state];
  let outcome: string;
  if (v.state === 'running') {
    outcome = 'running';
  } else if (v.state === 'ok') {
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
  if (s.facts.aborted) factsLine += ` · aborted: ${s.facts.aborted}`;
  if (s.facts.tokens) factsLine += ` · tokens: ${s.facts.tokens}`;
  lines.push(factsLine);

  let scoredLine = `Scored: ${s.scored} · errors: ${s.scoreErrors} · deferred: ${s.deferred} · left: ${s.left}`;
  if (s.leftUnmasked) scoredLine += ` · not masked: ${s.leftUnmasked}`;
  if (s.aborted) scoredLine += ` · aborted: ${s.aborted}`;
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
    const r = v.redact ?? ((s: string) => s);
    lines.push('', `Error: ${r(v.error)}`);
  }

  return lines;
}

/** Card description with counts, source errors, problems, log excerpt, and the contract line.
 *  Always ends with the contract line `career-cards-run: <ISO> <state>`.
 *  When over DESC_LIMIT the log excerpt is cut first, then the source-error list. */
export function statusDesc(v: StatusView): string {
  const contract = `career-cards-run: ${v.start.toISOString()} ${v.state}`;
  const CONTRACT_SEP = '\n\n';
  // Space available for everything before the contract separator and line.
  const budget = DESC_LIMIT - CONTRACT_SEP.length - contract.length;

  const countLines = buildCountLines(v);
  const r = v.redact ?? ((s: string) => s);

  // Source-error text can contain provider URLs with keys in the query string — redact the full line.
  const allErrLines = (v.stats?.sourceErrors ?? []).map((e) => r(`${e.company}: ${e.error}`));

  // Problems and warnings are never truncated — they appear between errors and the log excerpt.
  const problemLines: string[] = v.problems?.length
    ? ['', 'Problems:', ...v.problems.map((p) => `- ${r(p)}`)]
    : [];
  const warnings = v.stats?.warnings ?? [];
  if (warnings.length) problemLines.push('', 'Warnings:', ...warnings.map((w) => `- ${r(w)}`));

  // Log lines clipped individually; only the last 40 are shown.
  const rawLogLines = (v.log ?? [])
    .slice(-40)
    .map((l) => (l.length > 200 ? l.slice(0, 199) + '…' : l));

  function buildBody(errLines: string[], logLines: string[]): string {
    const parts = [...countLines];
    if (errLines.length) {
      parts.push('', `Source errors (${errLines.length}):`, ...errLines);
    }
    parts.push(...problemLines);
    if (logLines.length) {
      parts.push('', `Log (last ${logLines.length} lines):`, ...logLines);
    }
    return parts.join('\n');
  }

  // Try full content first.
  let body = buildBody(allErrLines, rawLogLines);
  if (body.length <= budget) return body + CONTRACT_SEP + contract;

  // Cut log lines from the front (at most 40 iterations).
  for (let n = rawLogLines.length - 1; n >= 0; n--) {
    body = buildBody(allErrLines, n > 0 ? rawLogLines.slice(-n) : []);
    if (body.length <= budget) return body + CONTRACT_SEP + contract;
  }

  // Log fully removed; binary-search the max error lines that fit.
  let lo = 0;
  let hi = allErrLines.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    body = buildBody(allErrLines.slice(0, mid), []);
    if (body.length <= budget) lo = mid;
    else hi = mid - 1;
  }

  return buildBody(allErrLines.slice(0, lo), []) + CONTRACT_SEP + contract;
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
  if (state !== 'running' && state !== 'ok' && state !== 'failed' && state !== 'skipped') return null;
  return { state: state as RunState, start };
}

/** Returns the open list named 'Runs' on the system board, creating it at the bottom when asked. */
export async function findRunsList(
  api: TrelloApi,
  systemBoard: string,
  o: { create: boolean },
): Promise<TList | null> {
  const lists = await api.lists(systemBoard, 'open');
  const found = lists.find((l) => l.name.trim() === RUNS_LIST);
  if (found) return found;
  if (!o.create) return null;
  return api.createList(systemBoard, RUNS_LIST, 'bottom');
}

/** Cards in state 'running', newest start first. */
export function runningCards(cards: TCard[]): { card: TCard; start: Date }[] {
  const result: { card: TCard; start: Date }[] = [];
  for (const card of cards) {
    const parsed = parseStatusCard({ name: card.name, desc: card.desc });
    if (parsed?.state === 'running') {
      result.push({ card, start: parsed.start });
    }
  }
  result.sort((a, b) => b.start.getTime() - a.start.getTime());
  return result;
}

/** The first running card younger than STALE_MS, or null if all running cards are stale. */
export function activeRun(
  cards: TCard[],
  now: Date,
): { card: TCard; start: Date } | null {
  return runningCards(cards).find((r) => now.getTime() - r.start.getTime() < STALE_MS) ?? null;
}

/** Running cards at or over the staleness threshold. */
export function staleRuns(
  cards: TCard[],
  now: Date,
): { card: TCard; start: Date }[] {
  return runningCards(cards).filter((r) => now.getTime() - r.start.getTime() >= STALE_MS);
}

/** Creates a new status card at the top of the given list. */
export async function createStatusCard(
  api: TrelloApi,
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

/** Updates the name and description of an existing status card (must be in the System board's Runs list). */
export async function updateStatusCard(
  api: TrelloApi,
  cardId: string,
  v: StatusView,
): Promise<TCard> {
  return api.updateCard(cardId, {
    name: statusTitle(v),
    desc: statusDesc(v),
  });
}
