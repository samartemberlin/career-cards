// The setup and capture steps of tools/sample-boards.ts, on clients the caller has limited to the sample boards.
import { isOriginalsName } from '../../src/trello/scoped.ts';
import type { TrelloApi, TCard, TList } from '../../src/trello/api.ts';
import { parseJobKey } from '../../src/trello/cards.ts';
import { OLD_RUN_COLUMN, RUN_COLUMN } from './layout.ts';
import type { BoardLayout } from './layout.ts';

export type Counts = Record<'labels' | 'lists' | 'cards' | 'checklists' | 'items' | 'closedChanged' | 'descs' | 'listsArchived', number>;

/**
 * `asUser` writes the Originals column, which in real use only the user fills. `setDesc` must refuse non-sample cards.
 * With `converge`, cards whose text differs from the layout are rewritten and open lists the layout lacks are archived.
 */
export async function applyLayout(
  w: { api: TrelloApi; asUser: TrelloApi; setDesc: (cardId: string, desc: string) => Promise<void> },
  boardId: string, layout: BoardLayout, made: Counts, o: { converge: boolean },
): Promise<void> {
  const { api, asUser } = w;
  const labels = await api.labels(boardId);
  for (const l of layout.labels) {
    if (!labels.some((x) => x.name === l.name)) {
      labels.push(await api.createLabel(boardId, l.name, l.color));
      made.labels++;
    }
  }
  const labelId = (name: string): string => labels.find((x) => x.name === name)!.id;

  const lists = await api.lists(boardId, 'all');
  const hasChecklists = layout.lists.some((l) => l.cards.some((c) => c.checklists));
  // The Jobs board is over 1,000 cards and needs paging; the others are small and need their checklists.
  const cards: TCard[] = hasChecklists
    ? await api.cards(boardId, { filter: 'all', checklists: true })
    : await api.allCards(boardId);

  for (const ls of layout.lists) {
    let list: TList | undefined = lists.find((x) => x.name === ls.name);
    if (!list) {
      list = await api.createList(boardId, ls.name, 'bottom');
      made.lists++;
    }
    const writer = isOriginalsName(ls.name) ? asUser : api;
    for (const cs of ls.cards) {
      // Open and archived job cards share titles; their keys tell them apart.
      const key = parseJobKey(cs.desc);
      let card = cards.find((c) => c.idList === list.id && (key ? parseJobKey(c.desc) === key : c.name === cs.name));
      if (!card) {
        card = await writer.createCard({ idList: list.id, name: cs.name, desc: cs.desc, pos: 'bottom', idLabels: (cs.labels ?? []).map(labelId) });
        made.cards++;
        if (cs.comment) await api.comment(card.id, cs.comment);
        if (cs.attachment) await api.attachText(card.id, cs.attachment.name, cs.attachment.text);
      } else if (o.converge && card.desc !== cs.desc) {
        await w.setDesc(card.id, cs.desc);
        made.descs++;
      }
      for (const cls of cs.checklists ?? []) {
        let cl = card.checklists?.find((x) => x.name === cls.name);
        if (!cl) {
          cl = await api.createChecklist(card.id, cls.name);
          made.checklists++;
        }
        for (const item of cls.items) {
          if (!cl.checkItems.some((x) => x.name === item)) {
            await api.addCheckItem(cl.id, item);
            made.items++;
          }
        }
      }
      if (Boolean(cs.closed) !== card.closed) {
        await api.setCardClosed(card.id, Boolean(cs.closed));
        made.closedChanged++;
      }
    }
    if (Boolean(ls.closed) !== list.closed) {
      await api.setListClosed(list.id, Boolean(ls.closed));
      made.closedChanged++;
    }
  }

  if (!o.converge) return;
  for (const l of lists) {
    if (!l.closed && !layout.lists.some((x) => x.name === l.name)) {
      await api.setListClosed(l.id, true);
      made.listsArchived++;
    }
  }
}

export type BoardReads = { jobLists: TList[]; jobCards: TCard[]; profileLists: TList[]; profileCards: TCard[]; systemCards: TCard[] };

/** The id-addressed reads the fixtures need: cards, a list, a checklist and a 404. `systemCards` with checklists.
 *  Returns the run column's first job card. */
export async function captureLookups(api: TrelloApi, r: BoardReads): Promise<TCard> {
  const { jobLists, jobCards, systemCards } = r;
  const profiles = { lists: r.profileLists, cards: r.profileCards };
  const listId = (lists: TList[], name: string): string => lists.find((l) => l.name === name)!.id;
  const oldRun = jobCards.find((c) => c.idList === listId(jobLists, OLD_RUN_COLUMN))!;
  const jobCard = jobCards.find((c) => c.idList === listId(jobLists, RUN_COLUMN) && !c.closed && !c.name.startsWith('ℹ'))!;
  const originals = listId(profiles.lists, 'Originals');
  await api.card(oldRun.id);
  await api.card(profiles.cards.find((c) => c.idList === originals)!.id);
  await api.card(jobCard.id);
  await api.list(originals);
  // Personal details is plain text now; the Sources card holds the sample boards' only checklists.
  const sources = systemCards.flatMap((c) => c.checklists ?? []).find((cl) => cl.name === 'Add')!;
  await api.checklist(sources.id);
  await api.card('0'.repeat(24)).then(
    () => { throw new Error('expected a 404 for a card that does not exist'); },
    (e: unknown) => { if ((e as { status?: number }).status !== 404) throw e; },
  );
  return jobCard;
}
