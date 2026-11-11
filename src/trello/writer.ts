import type { TrelloApi, TCard } from './api.ts';
import type { Job } from '../pipeline/keys.ts';
import type { ParsedScore } from '../pipeline/score.ts';
import type { Facts } from '../pipeline/facts.ts';
import { jobCardTitle, jobCardDesc } from './cards.ts';
import { isGuardError } from './scoped.ts';

export type ScoredJob = Job & Pick<ParsedScore, 'score' | 'reason' | 'flags' | 'title_en'> & { facts?: Facts };

// ISO date YYYY-MM-DD — the only format Trello accepts for start/due.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function keyFilename(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.md`;
}

/** Returns a resolver that maps label names to board label ids.
 *
 * Board labels are loaded once per resolver instance and cached.
 * A missing label is created; a creation failure is logged and that label is omitted — never throws. */
export function createLabelResolver(
  api: TrelloApi,
  boardId: string,
  log: (s: string) => void,
): (labels: { name: string; color: string }[]) => Promise<string[]> {
  // Loaded lazily; the same Map is mutated as labels are created.
  let cacheP: Promise<Map<string, string>> | undefined;

  function cache(): Promise<Map<string, string>> {
    if (!cacheP) {
      cacheP = api.labels(boardId).then((ls) => new Map(ls.map((l) => [l.name, l.id])));
    }
    return cacheP;
  }

  return async (labels) => {
    let byName: Map<string, string>;
    try {
      byName = await cache();
    } catch (err) {
      log(`labels failed to load: ${err instanceof Error ? err.message : String(err)}`);
      cacheP = undefined;
      return [];
    }
    const ids: string[] = [];
    for (const { name, color } of labels) {
      if (byName.has(name)) {
        ids.push(byName.get(name)!);
      } else {
        try {
          const created = await api.createLabel(boardId, name, color);
          byName.set(name, created.id);
          ids.push(created.id);
        } catch (err) {
          log(`label "${name}" could not be created: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return ids;
  };
}

/** Creates a job card at the bottom of the given list.
 *
 * start and due are only set when the job's posted/deadline fields are ISO YYYY-MM-DD dates.
 * When the description is truncated, the full JD is attached; an attach failure is logged and the card is still returned. */
export async function createJobCard(
  api: TrelloApi,
  o: { listId: string; job: ScoredJob; labelIds: string[]; log: (s: string) => void },
): Promise<TCard> {
  const { listId, job, labelIds, log } = o;
  const { desc, truncated } = jobCardDesc(job);

  const card = await api.createCard({
    idList: listId,
    name: jobCardTitle(job),
    desc,
    pos: 'bottom',
    ...(labelIds.length > 0 ? { idLabels: labelIds } : {}),
    ...(job.posted && DATE_RE.test(job.posted) ? { start: job.posted } : {}),
    ...(job.deadline && DATE_RE.test(job.deadline) ? { due: `${job.deadline}T12:00:00.000Z` } : {}),
  });

  if (truncated && job.jd) {
    try {
      await api.attachText(card.id, keyFilename(job.key), job.jd);
    } catch (err) {
      log(`attach JD for ${job.key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return card;
}

/** Archives cards one by one with setCardClosed. A failure is logged and counted; the rest continue. */
export async function archiveCards(
  api: TrelloApi,
  cards: TCard[],
  log: (s: string) => void,
): Promise<{ archived: number; failed: number }> {
  let archived = 0;
  let failed = 0;
  for (const card of cards) {
    try {
      await api.setCardClosed(card.id, true);
      archived++;
    } catch (err) {
      if (isGuardError(err)) throw err;
      log(`archive ${card.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  return { archived, failed };
}
