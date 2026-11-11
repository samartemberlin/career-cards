import type { TrelloApi, TCard, TList } from '../trello/api.ts';
import type { Settings } from '../config/schema.ts';
import { createJobCard, createLabelResolver, archiveCards } from '../trello/writer.ts';
import type { ScoredJob } from '../trello/writer.ts';
import { jobLabels, isRunColumnName, RUN_SUMMARY_PREFIX } from '../trello/cards.ts';
import { isGuardError } from '../trello/scoped.ts';
import { topRules } from './status.ts';
import type { RunStats } from './stats.ts';

const ARCHIVE_CHUNK = 50;

const filtered = (s: RunStats): number => s.rejectedPre + s.rejectedPost;
const deferred = (s: RunStats): number => s.deferred + s.left + s.jd.deferred;

/** `ℹ️ Run · 23 new · 412 filtered · 3 deferred`; "new" is the number of cards this run writes (every scored job). */
export function summaryTitle(s: RunStats): string {
  return `${RUN_SUMMARY_PREFIX} · ${s.scored} new · ${filtered(s)} filtered · ${deferred(s)} deferred`;
}

/** Headline counts and a link to the status card. Carries no key line, so memory and archiving skip this card. */
export function summaryDesc(s: RunStats, statusUrl: string): string {
  const lines = [
    `**Scanned:** ${s.scanned}`,
    `**New:** ${s.scored}`,
    `**Filtered:** ${filtered(s)}`,
    `**Deferred:** ${deferred(s)} (picked up by the next run)`,
  ];
  const top = topRules(s.rules, 5);
  if (top.length) {
    lines.push('', '**Top rules:**', ...top.map(([r, n]) => `- ${r}: ${n}`));
  }
  lines.push('', `Full status: ${statusUrl}`);
  return lines.join('\n');
}

/** Just left of the leftmost open run column, so the newest run reads first; `'bottom'` when there is none. */
export function runColumnPos(lists: TList[]): number | 'bottom' {
  const open = lists.filter((l) => !l.closed).sort((a, b) => a.pos - b.pos);
  const i = open.findIndex((l) => isRunColumnName(l.name));
  if (i < 0) return 'bottom';
  const run = open[i]!;
  const before = open[i - 1];
  return before ? (before.pos + run.pos) / 2 : run.pos / 2;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Creates the run column: the summary card, then one card per job in the given order (callers pass best first).
 *  No jobs, no column. A failed job card is logged and counted; scope-guard errors are rethrown. */
export async function writeRunColumn(
  api: TrelloApi,
  o: {
    board: string;
    name: string;
    jobs: ScoredJob[];
    stats: RunStats;
    statusUrl: string;
    labels?: Settings['labels'];
    log: (s: string) => void;
  },
): Promise<{ listId: string | null; created: number; failed: number; summary: boolean }> {
  if (o.jobs.length === 0) return { listId: null, created: 0, failed: 0, summary: false };

  const list = await api.createList(o.board, o.name, runColumnPos(await api.lists(o.board, 'open')));

  let summary = false;
  try {
    await api.createCard({
      idList: list.id,
      name: summaryTitle(o.stats),
      desc: summaryDesc(o.stats, o.statusUrl),
      pos: 'bottom',
    });
    summary = true;
  } catch (e) {
    if (isGuardError(e)) throw e;
    o.log(`summary card for ${o.name} failed: ${message(e)}`);
  }

  const colour = new Map((o.labels ?? []).map((l) => [l.name, l.color]));
  const resolve = createLabelResolver(api, o.board, o.log);
  let created = 0;
  let failed = 0;
  for (const job of o.jobs) {
    try {
      const labelIds = await resolve(
        jobLabels(job).map((l) => ({ name: l.name, color: colour.get(l.name) ?? l.color })),
      );
      await createJobCard(api, { listId: list.id, job, labelIds, log: o.log });
      created++;
    } catch (e) {
      if (isGuardError(e)) throw e;
      o.log(`card for ${job.key} failed: ${message(e)}`);
      failed++;
    }
  }
  return { listId: list.id, created, failed, summary };
}

/** Archives cards in chunks, starting no chunk at or after the deadline; the rest are archived by the next run. */
export async function archiveRunCards(
  api: TrelloApi,
  cards: TCard[],
  o: { deadline: number; log: (s: string) => void },
): Promise<{ archived: number; failed: number; left: number }> {
  let archived = 0;
  let failed = 0;
  let done = 0;
  while (done < cards.length && Date.now() < o.deadline) {
    const r = await archiveCards(api, cards.slice(done, done + ARCHIVE_CHUNK), o.log);
    archived += r.archived;
    failed += r.failed;
    done = Math.min(done + ARCHIVE_CHUNK, cards.length);
  }
  const left = cards.length - done;
  if (left) o.log(`archiving stopped at the time budget: ${left} cards left for the next run`);
  return { archived, failed, left };
}
