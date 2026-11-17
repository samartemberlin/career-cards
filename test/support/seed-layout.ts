import { createTrelloClient } from '../../src/trello/client.ts';
import type { FakeTrello } from './fake-trello.ts';
import type { BoardLayout } from '../../tools/sample/layout.ts';

/** Seed a FakeTrello board from a BoardLayout. Returns the new board id. */
export async function seedLayout(fake: FakeTrello, layout: BoardLayout): Promise<string> {
  const api = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const board = await api.createBoard('Test Board', 'fake-org');

  for (const listSpec of layout.lists) {
    const list = await api.createList(board.id, listSpec.name, 'bottom');
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

  return board.id;
}
