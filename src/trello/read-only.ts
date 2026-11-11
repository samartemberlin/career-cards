import type { TrelloApi } from './api.ts';

export class DryRunWriteError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`Dry-run: write method '${method}' is not allowed`);
    this.name = 'DryRunWriteError';
    this.method = method;
  }
}

/** Wraps a TrelloApi so every read passes through and every write throws DryRunWriteError
 *  before any network request. Used by --dry-run. */
export function readOnlyClient(api: TrelloApi): TrelloApi {
  async function deny(method: string): Promise<never> {
    throw new DryRunWriteError(method);
  }

  return {
    // Reads
    me: () => api.me(),
    board: (id) => api.board(id),
    boardMembers: (id) => api.boardMembers(id),
    organizationMembers: (orgId) => api.organizationMembers(orgId),
    myOrganizations: () => api.myOrganizations(),
    lists: (boardId, filter) => api.lists(boardId, filter),
    list: (id) => api.list(id),
    cards: (boardId, opts) => api.cards(boardId, opts),
    allCards: (boardId) => api.allCards(boardId),
    card: (id) => api.card(id),
    checklist: (id) => api.checklist(id),
    labels: (boardId) => api.labels(boardId),

    // Writes — each returns a rejected Promise naming the method (async for consistent return type)
    createBoard: (_name, _idOrg) => deny('createBoard'),
    createLabel: (_boardId, _name, _color) => deny('createLabel'),
    createList: (_boardId, _name, _pos) => deny('createList'),
    setListClosed: (_listId, _closed) => deny('setListClosed'),
    createCard: (_c) => deny('createCard'),
    setCardClosed: (_cardId, _closed) => deny('setCardClosed'),
    updateCard: (_cardId, _update) => deny('updateCard'),
    comment: (_cardId, _text) => deny('comment'),
    attachText: (_cardId, _name, _text) => deny('attachText'),
    createChecklist: (_cardId, _name) => deny('createChecklist'),
    addCheckItem: (_checklistId, _name, _checked) => deny('addCheckItem'),
  };
}
