import type { BotApi, TCard } from './api.ts';
import { parseJobKey, isRunColumnName } from './cards.ts';

export type JobIndex = {
  keys: Set<string>;
  /** Open and archived cards that carry a job key, keyed by that key. Summary and keyless cards are excluded. */
  byKey: Map<string, TCard>;
  toArchive: TCard[];
  cardCount: number;
};

/** Loads every job key on the Jobs board and identifies run-column cards to archive.
 *
 * toArchive: open cards with a key whose list is both closed and a run column name.
 * Summary and keyless cards are in neither set. */
export async function loadJobIndex(api: BotApi, jobsBoard: string): Promise<JobIndex> {
  const [lists, cards] = await Promise.all([
    api.lists(jobsBoard, 'all'),
    api.allCards(jobsBoard),
  ]);

  // IDs of closed lists that were created by the bot's runColumnName (safe to archive their contents)
  const archivableListIds = new Set(
    lists.filter((l) => l.closed && isRunColumnName(l.name)).map((l) => l.id),
  );

  const keys = new Set<string>();
  const byKey = new Map<string, TCard>();
  const toArchive: TCard[] = [];

  for (const card of cards) {
    const key = parseJobKey(card.desc);
    if (key === null) continue;
    keys.add(key);
    byKey.set(key, card);
    if (!card.closed && archivableListIds.has(card.idList)) {
      toArchive.push(card);
    }
  }

  return { keys, byKey, toArchive, cardCount: cards.length };
}
