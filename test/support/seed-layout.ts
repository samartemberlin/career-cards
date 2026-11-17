import { createTrelloClient } from '../../src/trello/client.ts';
import type { FakeTrello } from './fake-trello.ts';
import { LAYOUT } from '../../tools/sample/layout.ts';
import type { BoardLayout } from '../../tools/sample/layout.ts';

const clientOf = (fake: FakeTrello) => createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });

/** Seed a FakeTrello board from a BoardLayout, on a new board or on `o.board`. Returns the board id. */
export async function seedLayout(fake: FakeTrello, layout: BoardLayout, o: { board?: string } = {}): Promise<string> {
  const api = clientOf(fake);
  const board = o.board ?? (await api.createBoard('Test Board', 'fake-org')).id;

  for (const listSpec of layout.lists) {
    const list = await api.createList(board, listSpec.name, 'bottom');
    if (listSpec.closed) await api.setListClosed(list.id, true);

    for (const cardSpec of listSpec.cards) {
      const card = await api.createCard({ idList: list.id, name: cardSpec.name, desc: cardSpec.desc ?? '', pos: 'bottom' });
      if (cardSpec.closed) await api.setCardClosed(card.id, true);

      for (const clSpec of cardSpec.checklists ?? []) {
        const cl = await api.createChecklist(card.id, clSpec.name);
        for (const item of clSpec.items) await api.addCheckItem(cl.id, item);
      }
    }
  }

  return board;
}

/**
 * The recordings in test/fixtures/trello still hold the old checklist Profiles board and a Settings card with
 * `locations`. This archives the recorded Profiles lists, adds LAYOUT.profiles on the same board (ids, members and
 * privacy stay as recorded) and gives the Settings card LAYOUT's text.
 */
export function useSampleConfig(fake: FakeTrello, boards: { profiles: string; system: string }): void {
  fake.replaceLists(boards.profiles, LAYOUT.profiles.lists);
  const desc = LAYOUT.system.lists.flatMap((l) => l.cards).find((c) => c.name === 'Settings')!.desc;
  fake.setCardDesc(fake.openCardId(boards.system, 'Settings'), desc);
}
