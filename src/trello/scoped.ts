// Scope guard for TrelloApi: restricts all calls to an allow-listed set of boards
// and prevents any write that would touch a list named "Originals" on the Profiles board.
//
// Security boundary: the bot token can see boards belonging to other users.
// Every call that takes a board id is checked before any network request is made.
// Id-addressed reads (card, list, checklist) do one lookup to verify the board.
// Every write does a fresh lookup (never cached) so a card moved into Originals is caught.
import type { TrelloApi, TCardWithList, TList } from './api.ts';

export class ScopeError extends Error {
  readonly target: string;
  constructor(target: string) {
    super(`Board ${target} is outside the allowed scope`);
    this.name = 'ScopeError';
    this.target = target;
  }
}

export class OriginalsWriteError extends Error {
  readonly cardId?: string;
  readonly listId?: string;
  constructor(o: { cardId?: string; listId?: string }) {
    super(
      o.cardId
        ? `Write to card ${o.cardId} rejected: card is in Originals on the Profiles board`
        : `Write to list ${o.listId} rejected: list is Originals on the Profiles board`,
    );
    this.name = 'OriginalsWriteError';
    this.cardId = o.cardId;
    this.listId = o.listId;
  }
}

/** Returns true for any list name that trims to "originals" (case-insensitive). */
export function isOriginalsName(name: string): boolean {
  return name.trim().toLowerCase() === 'originals';
}

export type Scope = {
  /** Boards this client is allowed to touch. */
  boards: string[];
  /** If set, writes into any list named "Originals" on this board are blocked. */
  profilesBoard?: string;
};

/** Wraps api so that every call is restricted to the given scope.
 *  Board-addressed calls throw ScopeError before any request.
 *  Id-addressed reads verify the board with one lookup.
 *  Writes do a fresh lookup and throw ScopeError or OriginalsWriteError as needed. */
export function scopeClient(api: TrelloApi, scope: Scope): TrelloApi {
  const allowed = new Set(scope.boards);

  function assertBoard(boardId: string): void {
    if (!allowed.has(boardId)) throw new ScopeError(boardId);
  }

  // Verifies a card's board is in scope and returns the card.
  // Throws ScopeError if the board is out of scope.
  async function verifyCard(cardId: string): Promise<TCardWithList> {
    const c = await api.card(cardId);
    assertBoard(c.idBoard);
    return c;
  }

  // Verifies a list's board is in scope and returns the list.
  async function verifyList(listId: string): Promise<TList> {
    const l = await api.list(listId);
    assertBoard(l.idBoard);
    return l;
  }

  // Throws OriginalsWriteError if the card is in an Originals list on the Profiles board.
  function assertNotOriginals(card: TCardWithList, cardId: string): void {
    if (
      scope.profilesBoard !== undefined &&
      card.idBoard === scope.profilesBoard &&
      isOriginalsName(card.list.name)
    ) {
      throw new OriginalsWriteError({ cardId });
    }
  }

  // Throws OriginalsWriteError if the list is Originals on the Profiles board.
  function assertListNotOriginals(list: TList): void {
    if (
      scope.profilesBoard !== undefined &&
      list.idBoard === scope.profilesBoard &&
      isOriginalsName(list.name)
    ) {
      throw new OriginalsWriteError({ listId: list.id });
    }
  }

  return {
    // Passthrough: no board id involved
    me: () => api.me(),
    myOrganizations: () => api.myOrganizations(),
    organizationMembers: (orgId) => api.organizationMembers(orgId),

    // Board-addressed: check before any request (async so the check is always a Promise rejection)
    board: async (id) => { assertBoard(id); return api.board(id); },
    boardMembers: async (id) => { assertBoard(id); return api.boardMembers(id); },
    lists: async (boardId, filter) => { assertBoard(boardId); return api.lists(boardId, filter); },
    cards: async (boardId, opts) => { assertBoard(boardId); return api.cards(boardId, opts); },
    allCards: async (boardId) => { assertBoard(boardId); return api.allCards(boardId); },
    labels: async (boardId) => { assertBoard(boardId); return api.labels(boardId); },
    createLabel: async (boardId, name, color) => { assertBoard(boardId); return api.createLabel(boardId, name, color); },
    createList: async (boardId, name, pos) => { assertBoard(boardId); return api.createList(boardId, name, pos); },

    // createBoard is never permitted through the scoped client
    createBoard: async (_name, _idOrganization) => {
      throw new ScopeError('(new board)');
    },

    // Id-addressed reads: one lookup to verify board
    card: async (id) => {
      return verifyCard(id);
    },

    list: async (id) => {
      return verifyList(id);
    },

    checklist: async (id) => {
      const cl = await api.checklist(id);
      const c = await api.card(cl.idCard);
      assertBoard(c.idBoard);
      return cl;
    },

    // Writes: fresh lookup, then scope + Originals check

    setCardClosed: async (cardId, closed) => {
      const c = await api.card(cardId);
      assertBoard(c.idBoard);
      assertNotOriginals(c, cardId);
      return api.setCardClosed(cardId, closed);
    },

    comment: async (cardId, text) => {
      const c = await api.card(cardId);
      assertBoard(c.idBoard);
      assertNotOriginals(c, cardId);
      return api.comment(cardId, text);
    },

    attachText: async (cardId, name, text) => {
      const c = await api.card(cardId);
      assertBoard(c.idBoard);
      assertNotOriginals(c, cardId);
      return api.attachText(cardId, name, text);
    },

    createChecklist: async (cardId, name) => {
      const c = await api.card(cardId);
      assertBoard(c.idBoard);
      assertNotOriginals(c, cardId);
      return api.createChecklist(cardId, name);
    },

    addCheckItem: async (checklistId, name, checked) => {
      // Look up the checklist, then its card
      const cl = await api.checklist(checklistId);
      const c = await api.card(cl.idCard);
      assertBoard(c.idBoard);
      assertNotOriginals(c, cl.idCard);
      return api.addCheckItem(checklistId, name, checked);
    },

    setListClosed: async (listId, closed) => {
      const l = await api.list(listId);
      assertBoard(l.idBoard);
      assertListNotOriginals(l);
      return api.setListClosed(listId, closed);
    },

    createCard: async (c) => {
      // Check the target list's board and whether it is Originals
      const l = await api.list(c.idList);
      assertBoard(l.idBoard);
      assertListNotOriginals(l);
      return api.createCard(c);
    },
  };
}
