import type { BotApi } from './api.ts';

export class DryRunWriteError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Dry-run: write method '${method}' is not allowed`);
    this.name = 'DryRunWriteError';
    this.method = method;
  }
}

/** Wraps a BotApi so every read passes through and every write throws DryRunWriteError
 *  before any network request. Used by --dry-run. */
export function readOnlyClient(api: BotApi): BotApi {
  async function deny(method: string): Promise<never> {
    throw new DryRunWriteError(method);
  }

  return {
    // Reads
    me: () => api.me(),
    board: (id) => api.board(id),
    boardMembers: (id) => api.boardMembers(id),
    lists: (boardId, filter) => api.lists(boardId, filter),
    list: (id) => api.list(id),
    cards: (boardId, opts) => api.cards(boardId, opts),
    allCards: (boardId) => api.allCards(boardId),
    card: (id) => api.card(id),
    checklist: (id) => api.checklist(id),
    labels: (boardId) => api.labels(boardId),

    // Writes — async so the guard fires as a rejected Promise, not a synchronous throw
    archiveCard: (_cardId) => deny('archiveCard'),
    attachText: (_cardId, _name, _text) => deny('attachText'),
    comment: (_cardId, _text) => deny('comment'),
    createCard: (_c) => deny('createCard'),
    createList: (_boardId, _name, _pos) => deny('createList'),
    createLabel: (_boardId, _name, _color) => deny('createLabel'),
  };
}
