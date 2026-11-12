// FakeTrello: an in-memory Trello that mirrors captured recordings.
// Seeds from GET bodies; serves every route createTrelloClient uses.
import type { Recording } from '../../tools/sample/scrub.ts';
import type {
  TBoard, TMember, TList, TCard, TChecklist, TCheckItem, TLabel, TCardWithList, TComment,
} from '../../src/trello/api.ts';

const NOT_FOUND_BODY = 'The requested resource was not found.';

type FailEntry = { method: string; path: RegExp; status: number; remaining: number };

type CommentEntry = { id: string; idMemberCreator: string; username: string; date: string; text: string };

export class FakeTrello {
  // ── state ─────────────────────────────────────────────────────────────────
  private _me: TMember = { id: 'fa4e000000000000000000ff', username: 'samplebot' };
  private _myOrgs: { id: string; displayName: string }[] = [];
  private _boards = new Map<string, TBoard>();
  private _boardMembers = new Map<string, TMember[]>();       // boardId → members
  private _lists = new Map<string, TList>();                  // listId → list
  private _boardListIds = new Map<string, string[]>();        // boardId → listId[]
  private _cards = new Map<string, TCard>();                  // cardId → card (no checklists)
  private _boardCardIds = new Map<string, string[]>();        // boardId → cardId[]
  private _checklists = new Map<string, TChecklist>();        // checklistId → checklist
  private _cardChecklistIds = new Map<string, string[]>();    // cardId → checklistId[]
  private _labels = new Map<string, TLabel[]>();              // boardId → labels
  private _orgMembers = new Map<string, TMember[]>();         // orgId → members
  private _comments = new Map<string, CommentEntry[]>();      // cardId → comment entries
  private _attachments = new Map<string, string[]>();         // cardId → names
  private _now: Date = new Date('2026-01-01T00:00:00.000Z');

  // ── id / position generators ──────────────────────────────────────────────
  // IDs start above the highest id in the seeded recordings.
  private _idSeq = 0;
  private _posSeq = 0;
  private _shortUrlSeq = 0;

  private _genId(): string {
    this._idSeq++;
    return `fa4e${this._idSeq.toString(16).padStart(20, '0')}`;
  }
  private _genPos(): number {
    this._posSeq++;
    return this._posSeq * 16384;
  }
  private _genShortUrl(): string {
    this._shortUrlSeq++;
    return `https://trello.com/c/fake${String(this._shortUrlSeq).padStart(4, '0')}`;
  }

  /** Resolve 'top' / 'bottom' / number to a concrete pos relative to existing items. */
  private _resolvePos(rawPos: string | number, existingPos: number[]): number {
    if (typeof rawPos === 'number') return rawPos;
    if (rawPos === 'top') {
      const min = existingPos.length > 0 ? Math.min(...existingPos) : 16384;
      return Math.max(1, min - 16384);
    }
    // 'bottom' or anything else
    const max = existingPos.length > 0 ? Math.max(...existingPos) : 0;
    return max + 16384;
  }

  /** Set to false to make POST /webhooks simulate a failed HEAD check (returns 400, not WebhookExists). */
  public webhookHeadOk: boolean = true;
  private _webhooks = new Map<string, string>();  // key: `${idModel}\0${callbackURL}` → id

  // ── fail queue and request log ────────────────────────────────────────────
  private _failQueue: FailEntry[] = [];
  public requests: { method: string; path: string }[] = [];

  // ── static constructor ────────────────────────────────────────────────────

  /** Seeds boards, members, lists, cards, checklists and labels from the GET bodies. */
  static fromRecordings(...recs: Recording[]): FakeTrello {
    const fake = new FakeTrello();

    // Set _idSeq above the highest id already in recordings to avoid collisions.
    let maxN = 0;
    for (const rec of recs) {
      for (const m of JSON.stringify(rec).matchAll(/\bfa4e([0-9a-f]{20})\b/g)) {
        const n = parseInt(m[1]!, 16);
        if (n > maxN) maxN = n;
      }
    }
    fake._idSeq = maxN;

    for (const rec of recs) {
      for (const c of rec) {
        if (c.method === 'GET' && c.status === 200) {
          fake._seedGet(c.path, c.body);
        }
      }
    }
    return fake;
  }

  private _seedGet(path: string, body: unknown): void {
    if (path === '/members/me') {
      this._me = body as TMember;
      return;
    }
    if (path === '/members/me/organizations') {
      this._myOrgs = body as { id: string; displayName: string }[];
      return;
    }

    let m: RegExpExecArray | null;

    // /boards/{id}
    if ((m = /^\/boards\/([^/]+)$/.exec(path))) {
      const b = body as TBoard;
      this._boards.set(b.id, { id: b.id, name: b.name, closed: b.closed, idOrganization: b.idOrganization, prefs: { permissionLevel: b.prefs.permissionLevel } });
      return;
    }
    // /boards/{id}/members
    if ((m = /^\/boards\/([^/]+)\/members$/.exec(path))) {
      this._boardMembers.set(m[1]!, (body as TMember[]).map((x) => ({ id: x.id, username: x.username })));
      return;
    }
    // /boards/{id}/lists
    if ((m = /^\/boards\/([^/]+)\/lists$/.exec(path))) {
      const boardId = m[1]!;
      const existing = new Set(this._boardListIds.get(boardId) ?? []);
      for (const raw of body as TList[]) {
        this._lists.set(raw.id, { id: raw.id, name: raw.name, closed: raw.closed, pos: raw.pos, idBoard: raw.idBoard });
        existing.add(raw.id);
      }
      this._boardListIds.set(boardId, [...existing]);
      return;
    }
    // /boards/{id}/labels
    if ((m = /^\/boards\/([^/]+)\/labels$/.exec(path))) {
      this._labels.set(m[1]!, (body as TLabel[]).map((x) => ({ id: x.id, name: x.name, color: x.color })));
      return;
    }
    // /boards/{id}/cards/{filter}
    if ((m = /^\/boards\/([^/]+)\/cards\/([^/]+)$/.exec(path))) {
      const boardId = m[1]!;
      const existing = new Set(this._boardCardIds.get(boardId) ?? []);
      for (const raw of body as TCard[]) {
        if (!this._cards.has(raw.id)) {
          this._cards.set(raw.id, { id: raw.id, name: raw.name, desc: raw.desc, idList: raw.idList, idBoard: raw.idBoard, closed: raw.closed, pos: raw.pos, shortUrl: raw.shortUrl });
          existing.add(raw.id);
        }
        // Checklists embedded in cards/open?checklists=all responses
        if (raw.checklists) {
          for (const cl of raw.checklists) this._seedChecklist(cl);
        }
      }
      this._boardCardIds.set(boardId, [...existing]);
      return;
    }
    // /lists/{id}
    if ((m = /^\/lists\/([^/]+)$/.exec(path))) {
      const raw = body as TList;
      this._lists.set(raw.id, { id: raw.id, name: raw.name, closed: raw.closed, pos: raw.pos, idBoard: raw.idBoard });
      this._addToBoard('list', raw.idBoard, raw.id);
      return;
    }
    // /cards/{id} — card with embedded list
    if ((m = /^\/cards\/([^/]+)$/.exec(path))) {
      const raw = body as TCardWithList;
      if (!this._cards.has(raw.id)) {
        this._cards.set(raw.id, { id: raw.id, name: raw.name, desc: raw.desc, idList: raw.idList, idBoard: raw.idBoard, closed: raw.closed, pos: raw.pos, shortUrl: raw.shortUrl });
        this._addToBoard('card', raw.idBoard, raw.id);
      }
      // Seed the embedded list (may have only id+name from some recordings)
      if (!this._lists.has(raw.list.id)) {
        this._lists.set(raw.list.id, { id: raw.list.id, name: raw.list.name, closed: false, pos: 0, idBoard: raw.idBoard });
        this._addToBoard('list', raw.idBoard, raw.list.id);
      } else {
        const existing = this._lists.get(raw.list.id)!;
        this._lists.set(raw.list.id, { ...existing, name: raw.list.name });
      }
      return;
    }
    // /checklists/{id}
    if ((m = /^\/checklists\/([^/]+)$/.exec(path))) {
      this._seedChecklist(body as TChecklist);
      return;
    }
    // /organizations/{id}/members
    if ((m = /^\/organizations\/([^/]+)\/members$/.exec(path))) {
      this._orgMembers.set(m[1]!, (body as TMember[]).map((x) => ({ id: x.id, username: x.username })));
      return;
    }
  }

  private _addToBoard(kind: 'list' | 'card', boardId: string, id: string): void {
    const map = kind === 'list' ? this._boardListIds : this._boardCardIds;
    if (!map.has(boardId)) map.set(boardId, []);
    const arr = map.get(boardId)!;
    if (!arr.includes(id)) arr.push(id);
  }

  private _seedChecklist(cl: TChecklist): void {
    const stored: TChecklist = {
      id: cl.id,
      name: cl.name,
      idCard: cl.idCard,
      idBoard: cl.idBoard,
      checkItems: cl.checkItems.map((ci) => ({ id: ci.id, name: ci.name, state: ci.state, pos: ci.pos })),
    };
    this._checklists.set(cl.id, stored);
    if (!this._cardChecklistIds.has(cl.idCard)) this._cardChecklistIds.set(cl.idCard, []);
    const arr = this._cardChecklistIds.get(cl.idCard)!;
    if (!arr.includes(cl.id)) arr.push(cl.id);
  }

  // ── fetch ─────────────────────────────────────────────────────────────────

  fetch: typeof fetch = (async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = u.pathname.replace(/^\/1(?=\/)/, '');

    this.requests.push({ method, path });

    // Check fail queue — first matching entry wins; depleted entries are cleaned up after the loop.
    for (const entry of this._failQueue) {
      if (entry.remaining > 0 && entry.method === method && entry.path.test(path)) {
        entry.remaining--;
        return new Response('', { status: entry.status });
      }
    }
    this._failQueue = this._failQueue.filter((e) => e.remaining > 0);

    return this._handle(method, path, u, init);
  }) as typeof fetch;

  private async _handle(method: string, path: string, u: URL, init: RequestInit | undefined): Promise<Response> {
    const ok = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const notFound = (): Response => new Response(NOT_FOUND_BODY, { status: 404 });

    const readJson = async (): Promise<Record<string, unknown>> => {
      if (typeof init?.body === 'string') return JSON.parse(init.body) as Record<string, unknown>;
      return {};
    };

    if (method === 'GET') return this._handleGet(path, u, ok, notFound);

    let m: RegExpExecArray | null;

    if (method === 'POST') {
      // POST /labels
      if (path === '/labels') {
        const { idBoard, name, color } = await readJson() as { idBoard: string; name: string; color: string };
        const id = this._genId();
        const lbl: TLabel = { id, name, color };
        const labels = this._labels.get(idBoard) ?? [];
        labels.push(lbl);
        this._labels.set(idBoard, labels);
        return ok({ id, idBoard, name, color, uses: 0, limits: {} });
      }
      // POST /boards
      if (path === '/boards') {
        const { name, idOrganization } = await readJson() as { name: string; idOrganization: string };
        const id = this._genId();
        const board: TBoard = { id, name, closed: false, idOrganization, prefs: { permissionLevel: 'private' } };
        this._boards.set(id, board);
        return ok(board);
      }
      // POST /lists
      if (path === '/lists') {
        const { idBoard, name, pos: rawPos } = await readJson() as { idBoard: string; name: string; pos: string | number };
        const id = this._genId();
        const boardListIds = this._boardListIds.get(idBoard) ?? [];
        const existingPos = boardListIds.map((lid) => this._lists.get(lid)?.pos ?? 0).filter((p) => p > 0);
        const pos = this._resolvePos(rawPos, existingPos);
        const list: TList = { id, name, closed: false, pos, idBoard };
        this._lists.set(id, list);
        this._addToBoard('list', idBoard, id);
        return ok({ limits: {}, id, name, closed: false, color: null, idBoard, pos, subscribed: false, softLimit: null, type: null, datasource: { filter: false } });
      }
      // POST /cards
      if (path === '/cards') {
        const { idList, name, desc, pos: rawPos } = await readJson() as { idList: string; name: string; desc: string; pos: string | number };
        const list = this._lists.get(idList);
        if (!list) return notFound();
        const id = this._genId();
        const listCardIds = this._boardCardIds.get(list.idBoard) ?? [];
        const existingPos = listCardIds
          .map((cid) => this._cards.get(cid))
          .filter((c): c is TCard => !!c && c.idList === idList)
          .map((c) => c.pos);
        const pos = this._resolvePos(rawPos, existingPos);
        const card: TCard = { id, name, desc, idList, idBoard: list.idBoard, closed: false, pos, shortUrl: this._genShortUrl() };
        this._cards.set(id, card);
        this._addToBoard('card', list.idBoard, id);
        return ok(this._cardBody(card, true));
      }
      // POST /cards/{id}/actions/comments
      if ((m = /^\/cards\/([^/]+)\/actions\/comments$/.exec(path))) {
        const card = this._cards.get(m[1]!);
        if (!card) return notFound();
        const { text } = await readJson() as { text: string };
        const id = this._genId();
        const entry: CommentEntry = {
          id,
          idMemberCreator: this._me.id,
          username: this._me.username,
          date: this._now.toISOString(),
          text,
        };
        if (!this._comments.has(card.id)) this._comments.set(card.id, []);
        this._comments.get(card.id)!.push(entry);
        return ok({ id, idMemberCreator: this._me.id, data: {}, agenticIdentity: null, appCreator: null, type: 'commentCard', date: entry.date, limits: {} });
      }
      // POST /cards/{id}/attachments
      if ((m = /^\/cards\/([^/]+)\/attachments$/.exec(path))) {
        const card = this._cards.get(m[1]!);
        if (!card) return notFound();
        let name = 'attachment';
        if (init?.body instanceof FormData) {
          name = (init.body.get('name') as string | null) ?? name;
        }
        const id = this._genId();
        if (!this._attachments.has(card.id)) this._attachments.set(card.id, []);
        this._attachments.get(card.id)!.push(name);
        return ok({ id, aiSummary: null, bytes: 0, date: new Date().toISOString(), edgeColor: null, idMember: this._me.id, isMalicious: false, isUpload: true, mimeType: 'text/markdown', name, previews: [], sourceView: null, pos: this._genPos(), fileName: name, limits: {} });
      }
      // POST /checklists
      if (path === '/checklists') {
        const { idCard, name } = await readJson() as { idCard: string; name: string };
        const card = this._cards.get(idCard);
        if (!card) return notFound();
        const id = this._genId();
        const cl: TChecklist = { id, name, idCard, idBoard: card.idBoard, checkItems: [] };
        this._checklists.set(id, cl);
        if (!this._cardChecklistIds.has(idCard)) this._cardChecklistIds.set(idCard, []);
        this._cardChecklistIds.get(idCard)!.push(id);
        return ok({ id, name, idBoard: card.idBoard, idCard, pos: this._genPos(), checkItems: [], limits: {} });
      }
      // POST /checklists/{id}/checkItems
      if ((m = /^\/checklists\/([^/]+)\/checkItems$/.exec(path))) {
        const cl = this._checklists.get(m[1]!);
        if (!cl) return notFound();
        const { name, state: rawState } = await readJson() as { name: string; state?: string };
        const state: 'complete' | 'incomplete' = rawState === 'complete' ? 'complete' : 'incomplete';
        const id = this._genId();
        const pos = this._genPos();
        const item: TCheckItem = { id, name, state, pos };
        cl.checkItems.push(item);
        return ok({ id, name, nameData: { emoji: {} }, pos, state, due: null, dueReminder: null, idMember: null, idChecklist: cl.id, limits: {} });
      }
      // POST /webhooks
      if (path === '/webhooks') {
        if (!this.webhookHeadOk) {
          return new Response('HEAD request to callback URL returned a non-200 response', { status: 400 });
        }
        const { idModel, callbackURL, description } = await readJson() as { idModel: string; callbackURL: string; description: string };
        const key = `${idModel}\0${callbackURL}`;
        if (this._webhooks.has(key)) {
          const dupBody = 'A webhook with that callback, model, and token already exists';
          return new Response(dupBody, { status: 400 });
        }
        const id = this._genId();
        this._webhooks.set(key, id);
        return ok({ id, idModel, callbackURL, description, active: true, consecutiveFailures: 0, firstConsecutiveFailDate: null });
      }
    }

    if (method === 'PUT') {
      // PUT /boards/{id}/members/{memberId}
      if ((m = /^\/boards\/([^/]+)\/members\/([^/]+)$/.exec(path))) {
        const boardId = m[1]!;
        const memberId = m[2]!;
        if (!this._boards.has(boardId)) return notFound();
        const existing = this._boardMembers.get(boardId) ?? [];
        if (!existing.some((mb) => mb.id === memberId)) {
          this._boardMembers.set(boardId, [...existing, { id: memberId, username: memberId }]);
        }
        return ok({ id: boardId });
      }
      // PUT /lists/{id}/closed
      if ((m = /^\/lists\/([^/]+)\/closed$/.exec(path))) {
        const list = this._lists.get(m[1]!);
        if (!list) return notFound();
        const { value } = await readJson() as { value: boolean };
        this._lists.set(list.id, { ...list, closed: value });
        return ok({ id: list.id, name: list.name, closed: value, color: null, idBoard: list.idBoard, pos: list.pos, type: null, datasource: { filter: false } });
      }
      // PUT /cards/{id}
      if ((m = /^\/cards\/([^/]+)$/.exec(path))) {
        const card = this._cards.get(m[1]!);
        if (!card) return notFound();
        const body = await readJson() as Record<string, unknown>;
        // The bot never edits a card: archiving is the only change it may send, so anything else fails the test.
        if (Object.keys(body).some((k) => k !== 'closed') || typeof body.closed !== 'boolean') {
          return new Response('the bot never edits a card', { status: 400 });
        }
        const updated = { ...card, closed: body.closed };
        this._cards.set(card.id, updated);
        return ok(this._cardBody(updated, false));
      }
    }

    return notFound();
  }

  private _handleGet(
    path: string,
    u: URL,
    ok: (body: unknown) => Response,
    notFound: () => Response,
  ): Response {
    if (path === '/members/me') return ok(this._me);
    if (path === '/members/me/organizations') return ok(this._myOrgs);

    let m: RegExpExecArray | null;

    // /members/{idOrUsername} — look up by id or username
    if ((m = /^\/members\/([^/]+)$/.exec(path)) && m[1] !== 'me') {
      const idOrUsername = m[1]!;
      // Search by id first, then by username
      let found: TMember | undefined;
      if (idOrUsername === this._me.id || idOrUsername === this._me.username) {
        found = this._me;
      } else {
        for (const members of this._boardMembers.values()) {
          found = members.find((mb) => mb.id === idOrUsername || mb.username === idOrUsername);
          if (found) break;
        }
        if (!found) {
          for (const members of this._orgMembers.values()) {
            found = members.find((mb) => mb.id === idOrUsername || mb.username === idOrUsername);
            if (found) break;
          }
        }
      }
      return found ? ok({ id: found.id, username: found.username }) : notFound();
    }

    if ((m = /^\/boards\/([^/]+)$/.exec(path))) {
      const b = this._boards.get(m[1]!);
      return b ? ok(b) : notFound();
    }
    if ((m = /^\/boards\/([^/]+)\/members$/.exec(path))) {
      return ok(this._boardMembers.get(m[1]!) ?? []);
    }
    if ((m = /^\/boards\/([^/]+)\/lists$/.exec(path))) {
      const boardId = m[1]!;
      const filter = u.searchParams.get('filter') ?? 'open';
      const ids = this._boardListIds.get(boardId) ?? [];
      const lists = ids.map((id) => this._lists.get(id)).filter((l): l is TList => !!l);
      return ok(filter === 'all' ? lists : lists.filter((l) => !l.closed));
    }
    if ((m = /^\/boards\/([^/]+)\/labels$/.exec(path))) {
      return ok(this._labels.get(m[1]!) ?? []);
    }
    // /boards/{id}/cards/{filter} — open and all, with paging and optional checklists
    if ((m = /^\/boards\/([^/]+)\/cards\/([^/]+)$/.exec(path))) {
      const boardId = m[1]!;
      const filter = m[2]!;
      const before = u.searchParams.get('before') ?? undefined;
      const limit = parseInt(u.searchParams.get('limit') ?? '1000', 10);
      const withChecklists = u.searchParams.get('checklists') === 'all';

      const ids = this._boardCardIds.get(boardId) ?? [];
      let cards = ids.map((id) => this._cards.get(id)).filter((c): c is TCard => !!c);

      // open: return cards where closed=false regardless of list status (Trello behaviour)
      if (filter === 'open') cards = cards.filter((c) => !c.closed);

      // Sort descending by id (lexicographic on equal-length hex strings equals numeric)
      cards.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));

      if (before) cards = cards.filter((c) => c.id < before);
      cards = cards.slice(0, limit);

      if (withChecklists) {
        cards = cards.map((c) => this._withChecklists(c));
      }

      return ok(cards);
    }
    if ((m = /^\/lists\/([^/]+)$/.exec(path))) {
      const l = this._lists.get(m[1]!);
      return l ? ok(l) : notFound();
    }
    // /cards/{id} — returns card + list
    if ((m = /^\/cards\/([^/]+)$/.exec(path))) {
      const card = this._cards.get(m[1]!);
      if (!card) return notFound();
      const list = this._lists.get(card.idList);
      const listInfo = list ? { id: list.id, name: list.name } : { id: card.idList, name: 'Unknown' };
      return ok({ ...card, list: listInfo });
    }
    if ((m = /^\/checklists\/([^/]+)$/.exec(path))) {
      const cl = this._checklists.get(m[1]!);
      return cl ? ok(cl) : notFound();
    }
    if ((m = /^\/organizations\/([^/]+)\/members$/.exec(path))) {
      return ok(this._orgMembers.get(m[1]!) ?? []);
    }
    // /boards/{id}/actions?filter=commentCard
    if ((m = /^\/boards\/([^/]+)\/actions$/.exec(path))) {
      if (u.searchParams.get('filter') !== 'commentCard') return notFound();
      const boardId = m[1]!;
      const since = u.searchParams.get('since') ?? undefined;
      const cardIds = this._boardCardIds.get(boardId) ?? [];
      const all: (CommentEntry & { cardId: string })[] = [];
      for (const cardId of cardIds) {
        for (const c of this._comments.get(cardId) ?? []) {
          if (since === undefined || c.date > since) all.push({ ...c, cardId });
        }
      }
      all.sort((a, b) => b.date.localeCompare(a.date));
      return ok(all.map((c) => this._toAction(c, c.cardId, boardId)));
    }
    // /cards/{id}/actions?filter=commentCard
    if ((m = /^\/cards\/([^/]+)\/actions$/.exec(path))) {
      if (u.searchParams.get('filter') !== 'commentCard') return notFound();
      const cardId = m[1]!;
      const card = this._cards.get(cardId);
      if (!card) return notFound();
      const limit = parseInt(u.searchParams.get('limit') ?? '50', 10);
      const comments = [...(this._comments.get(cardId) ?? [])];
      comments.sort((a, b) => b.date.localeCompare(a.date));
      return ok(comments.slice(0, limit).map((c) => this._toAction(c, cardId, card.idBoard)));
    }

    return notFound();
  }

  private _toAction(c: CommentEntry & { cardId?: string }, cardId: string, boardId: string): object {
    return {
      id: c.id,
      idMemberCreator: c.idMemberCreator,
      type: 'commentCard',
      date: c.date,
      memberCreator: { id: c.idMemberCreator, username: c.username },
      data: {
        text: c.text,
        card: { id: cardId },
        board: { id: boardId },
      },
    };
  }

  private _withChecklists(card: TCard): TCard {
    const ids = this._cardChecklistIds.get(card.id) ?? [];
    const checklists = ids.map((id) => this._checklists.get(id)).filter((cl): cl is TChecklist => !!cl);
    return { ...card, checklists };
  }

  // Full write response bodies matching the captured key sets.
  private _cardBody(card: TCard, includeAttachmentsStickers: boolean): object {
    const base: Record<string, unknown> = {
      id: card.id,
      agent: null,
      badges: { attachments: 0, fogbugz: '', checkItems: 0, checkItemsChecked: 0, checkItemsEarliestDue: null, comments: 0, description: card.desc.length > 0, due: null, dueComplete: false, lastUpdatedByAi: false, start: null, externalSource: null, attachmentsByType: { trello: { board: 0, card: 0 } }, location: false, votes: 0, maliciousAttachments: 0, viewingMemberVoted: false, subscribed: false },
      checkItemStates: [],
      closed: card.closed,
      dueComplete: false,
      dateLastActivity: new Date().toISOString(),
      desc: card.desc,
      descData: { emoji: {} },
      due: null,
      dueReminder: null,
      idBoard: card.idBoard,
      idChecklists: [],
      idList: card.idList,
      idMembers: [],
      idMembersVoted: [],
      idShort: 0,
      idAttachmentCover: null,
      labels: [],
      idLabels: [],
      lastSummaryChangeEventAt: null,
      manifest: null,
      manualCoverAttachment: false,
      name: card.name,
      nodeId: `ari:cloud:trello::card/workspace/x/${card.id}`,
      pinned: false,
      pos: card.pos,
      shortUrl: card.shortUrl,
      start: null,
      subscribed: false,
      cover: { idAttachment: null, color: null, idUploadedBackground: null, size: 'normal', brightness: 'dark', yPosition: 0.5, idPlugin: null },
      isTemplate: false,
      cardRole: null,
      mirrorSourceId: null,
    };
    if (includeAttachmentsStickers) {
      base['attachments'] = [];
      base['stickers'] = [];
      base['limits'] = {};
    }
    return base;
  }

  // ── test helpers ───────────────────────────────────────────────────────────

  /** Add n cards to listId. make(i) returns the name and desc for index i. */
  addCards(listId: string, n: number, make: (i: number) => { name: string; desc: string }): void {
    const list = this._lists.get(listId);
    if (!list) throw new Error(`FakeTrello.addCards: list ${listId} not found`);
    for (let i = 0; i < n; i++) {
      const { name, desc } = make(i);
      const id = this._genId();
      const card: TCard = { id, name, desc, idList: listId, idBoard: list.idBoard, closed: false, pos: this._genPos(), shortUrl: this._genShortUrl() };
      this._cards.set(id, card);
      this._addToBoard('card', list.idBoard, id);
    }
  }

  /** Update a card's description (the user editing a card, no scope check). */
  setCardDesc(cardId: string, desc: string): void {
    const card = this._cards.get(cardId);
    if (!card) throw new Error(`FakeTrello.setCardDesc: card ${cardId} not found`);
    this._cards.set(cardId, { ...card, desc });
  }

  /** Move cardId to listId (the user acting, no Originals check). */
  moveCard(cardId: string, listId: string): void {
    const card = this._cards.get(cardId);
    if (!card) throw new Error(`FakeTrello.moveCard: card ${cardId} not found`);
    const list = this._lists.get(listId);
    if (!list) throw new Error(`FakeTrello.moveCard: list ${listId} not found`);
    this._cards.set(cardId, { ...card, idList: listId, idBoard: list.idBoard });
  }

  /** Rename a list (the user acting). */
  renameList(listId: string, name: string): void {
    const list = this._lists.get(listId);
    if (!list) throw new Error(`FakeTrello.renameList: list ${listId} not found`);
    this._lists.set(listId, { ...list, name });
  }

  /** Next `times` requests matching method + path return status. */
  failNext(method: string, path: RegExp, status: number, times = 1): void {
    this._failQueue.push({ method: method.toUpperCase(), path, status, remaining: times });
  }

  commentsOn(cardId: string): string[] {
    return (this._comments.get(cardId) ?? []).map((e) => e.text);
  }

  addComment(cardId: string, author: TMember, text: string, date?: Date): TComment {
    const card = this._cards.get(cardId);
    if (!card) throw new Error(`FakeTrello.addComment: card ${cardId} not found`);
    const id = this._genId();
    const d = date ?? this._now;
    const entry: CommentEntry = {
      id,
      idMemberCreator: author.id,
      username: author.username,
      date: d.toISOString(),
      text,
    };
    if (!this._comments.has(cardId)) this._comments.set(cardId, []);
    this._comments.get(cardId)!.push(entry);
    return { id, idMemberCreator: author.id, username: author.username, date: d.toISOString(), text, cardId, boardId: card.idBoard };
  }

  /** Move the fake's clock to d. POST /actions/comments will record this date. */
  setNow(d: Date): void {
    this._now = d;
  }

  attachmentsOn(cardId: string): string[] {
    return this._attachments.get(cardId) ?? [];
  }

  /** Replace a board's permission level (affects board() responses). */
  setBoardPermissionLevel(boardId: string, permissionLevel: string): void {
    const b = this._boards.get(boardId);
    if (!b) throw new Error(`FakeTrello.setBoardPermissionLevel: board ${boardId} not found`);
    this._boards.set(boardId, { ...b, prefs: { permissionLevel } });
  }

  /** Mark a board closed or open (affects board() responses). */
  setBoardClosed(boardId: string, closed: boolean): void {
    const b = this._boards.get(boardId);
    if (!b) throw new Error(`FakeTrello.setBoardClosed: board ${boardId} not found`);
    this._boards.set(boardId, { ...b, closed });
  }

  /** Add a member to a board's member list (affects boardMembers() responses). */
  addBoardMember(boardId: string, member: TMember): void {
    if (!this._boards.has(boardId)) throw new Error(`FakeTrello.addBoardMember: board ${boardId} not found`);
    const members = this._boardMembers.get(boardId) ?? [];
    this._boardMembers.set(boardId, [...members, { id: member.id, username: member.username }]);
  }
}
