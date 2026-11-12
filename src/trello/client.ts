import { z } from 'zod';
import {
  TMemberSchema,
  TBoardSchema,
  TLabelSchema,
  TListSchema,
  TCardSchema,
  TCardWithListSchema,
  TChecklistSchema,
  TCheckItemSchema,
} from './api.ts';
import type { TrelloApi, NewCard } from './api.ts';

const API = 'https://api.trello.com/1';

// The client only passes URL objects; this narrower type lets tests inject a simple fake.
export type FetchLike = (url: URL, init?: RequestInit) => Promise<Response>;

export class TrelloError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(status: number, method: string, path: string, body: string) {
    super(`Trello ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'TrelloError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

// Methods whose side effects are unknown after a non-429 failure: never retry.
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT']);

// Backoff delays for successive retries: 2 s, 4 s, 8 s, 16 s.
const BACKOFF_MS = [2000, 4000, 8000, 16000] as const;
const MAX_RETRIES = BACKOFF_MS.length;

export function createTrelloClient(o: {
  key: string;
  token: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxPer10s?: number;
}): TrelloApi {
  const {
    key,
    token,
    fetchImpl = fetch as FetchLike,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    maxPer10s = 80,
  } = o;

  // Rolling window of request start times, oldest first.
  const window: number[] = [];

  async function pace(): Promise<void> {
    const cutoff = () => now() - 10000;
    while (window.length > 0 && window[0]! <= cutoff()) window.shift();

    if (window.length >= maxPer10s) {
      // Oldest entry in the window is the one that "leaves" the window last.
      // We must wait until 10 s after the oldest entry.
      const waitUntil = window[0]! + 10000;
      const delay = waitUntil - now();
      if (delay > 0) await sleep(delay);
      while (window.length > 0 && window[0]! <= now() - 10000) window.shift();
    }
    window.push(now());
  }

  // Redact credentials from an error body before surfacing it.
  function redact(s: string): string {
    return s.replaceAll(key, '[KEY]').replaceAll(token, '[TOKEN]');
  }

  async function call<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
      form?: FormData;
      schema?: z.ZodType<T>;
    } = {},
  ): Promise<T> {
    await pace();

    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`,
      accept: 'application/json',
    };
    const baseInit: Omit<RequestInit, 'signal'> = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      baseInit.body = JSON.stringify(opts.body);
    }
    if (opts.form) {
      baseInit.body = opts.form;
    }

    const isIdempotent = IDEMPOTENT_METHODS.has(method);

    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { ...baseInit, signal: AbortSignal.timeout(30000) };
      let res: Response;
      try {
        res = await fetchImpl(url, init);
      } catch (err) {
        if (isIdempotent && attempt < MAX_RETRIES) {
          await sleep(BACKOFF_MS[attempt]!);
          continue;
        }
        throw err;
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep(BACKOFF_MS[attempt]!);
        continue;
      }

      if (res.status >= 500 && isIdempotent && attempt < MAX_RETRIES) {
        await sleep(BACKOFF_MS[attempt]!);
        continue;
      }

      if (!res.ok) {
        const body = redact(await res.text());
        throw new TrelloError(res.status, method, path, body);
      }

      const json = await res.json() as unknown;
      if (opts.schema) {
        return opts.schema.parse(json);
      }
      return json as T;
    }
  }

  return {
    me: () => call('GET', '/members/me', {
      query: { fields: 'id,username' },
      schema: TMemberSchema,
    }),

    board: (id) => call('GET', `/boards/${id}`, {
      query: { fields: 'id,name,closed,idOrganization,prefs' },
      schema: TBoardSchema,
    }),

    boardMembers: (id) => call('GET', `/boards/${id}/members`, {
      query: { fields: 'id,username' },
      schema: z.array(TMemberSchema),
    }),

    organizationMembers: (orgId) => call('GET', `/organizations/${orgId}/members`, {
      query: { fields: 'id,username' },
      schema: z.array(TMemberSchema),
    }),

    myOrganizations: () => call('GET', '/members/me/organizations', {
      query: { fields: 'id,displayName' },
      schema: z.array(z.object({ id: z.string(), displayName: z.string() }).strip()),
    }),

    lists: (boardId, filter) => call('GET', `/boards/${boardId}/lists`, {
      query: { filter, fields: 'id,name,closed,pos,idBoard' },
      schema: z.array(TListSchema),
    }),

    list: (id) => call('GET', `/lists/${id}`, {
      query: { fields: 'id,name,closed,pos,idBoard' },
      schema: TListSchema,
    }),

    cards: (boardId, opts) => call('GET', `/boards/${boardId}/cards/${opts.filter}`, {
      query: {
        fields: 'id,name,desc,idList,idBoard,closed,pos,shortUrl',
        checklists: opts.checklists ? 'all' : undefined,
        before: opts.before,
        limit: opts.limit,
      },
      schema: z.array(TCardSchema),
    }),

    async allCards(boardId) {
      const limit = 1000;
      const all: z.infer<typeof TCardSchema>[] = [];
      const seen = new Set<string>();
      let before: string | undefined;

      for (;;) {
        const page = await call('GET', `/boards/${boardId}/cards/all`, {
          query: { fields: 'id,name,desc,idList,idBoard,closed,pos,shortUrl', limit, before },
          schema: z.array(TCardSchema),
        });

        if (page.length === 0) break;

        // Detect a stuck cursor: if the smallest id on this page hasn't moved, loop is infinite.
        const pageIds = page.map((c) => c.id).sort();
        const oldestId = pageIds[0]!;
        if (before !== undefined && oldestId >= before) {
          throw new Error(`allCards: cursor before=${before} did not move (oldest id on page: ${oldestId})`);
        }

        for (const card of page) {
          if (!seen.has(card.id)) {
            seen.add(card.id);
            all.push(card);
          }
        }

        if (page.length < limit) break;
        before = oldestId;
      }

      return all;
    },

    card: (id) => call('GET', `/cards/${id}`, {
      query: { fields: 'id,name,desc,idList,idBoard,closed,pos,shortUrl', list: 'true', list_fields: 'name' },
      schema: TCardWithListSchema,
    }),

    checklist: (id) => call('GET', `/checklists/${id}`, {
      query: { fields: 'id,name,idCard,idBoard', checkItems: 'all', checkItem_fields: 'id,name,state,pos' },
      schema: TChecklistSchema,
    }),

    labels: (boardId) => call('GET', `/boards/${boardId}/labels`, {
      query: { fields: 'id,name,color', limit: 1000 },
      schema: z.array(TLabelSchema),
    }),

    createLabel: (boardId, name, color) => call('POST', '/labels', {
      body: { idBoard: boardId, name, color },
      schema: TLabelSchema,
    }),

    createBoard: (name, idOrganization) => call('POST', '/boards', {
      body: { name, idOrganization, defaultLists: false, prefs_permissionLevel: 'private' },
      schema: TBoardSchema,
    }),

    createList: (boardId, name, pos) => call('POST', '/lists', {
      body: { idBoard: boardId, name, pos },
      schema: TListSchema,
    }),

    setListClosed: (listId, closed) => call('PUT', `/lists/${listId}/closed`, {
      body: { value: closed },
      schema: TListSchema,
    }),

    // Allow-listed so a stray runtime key (idCardSource copies an existing card) can never reach Trello.
    createCard: (c: NewCard) => call('POST', '/cards', {
      body: {
        idList: c.idList, name: c.name, desc: c.desc, pos: c.pos,
        ...(c.idLabels !== undefined ? { idLabels: c.idLabels } : {}),
        ...(c.start !== undefined ? { start: c.start } : {}),
        ...(c.due !== undefined ? { due: c.due } : {}),
      },
      schema: TCardSchema,
    }),

    setCardClosed: (cardId, closed) => call('PUT', `/cards/${cardId}`, {
      body: { closed },
      schema: TCardSchema,
    }),

    comment: (cardId, text) => call('POST', `/cards/${cardId}/actions/comments`, {
      body: { text },
      schema: z.object({ id: z.string() }).strip(),
    }),

    attachText(cardId, name, text) {
      const form = new FormData();
      form.set('name', name);
      form.set('mimeType', 'text/markdown');
      form.set('file', new Blob([text], { type: 'text/markdown' }), name);
      return call('POST', `/cards/${cardId}/attachments`, {
        form,
        schema: z.object({ id: z.string() }).strip(),
      });
    },

    createChecklist: (cardId, name) => call('POST', '/checklists', {
      body: { idCard: cardId, name },
      schema: TChecklistSchema,
    }),

    addCheckItem: (checklistId, name, checked) => call('POST', `/checklists/${checklistId}/checkItems`, {
      body: { name, ...(checked !== undefined ? { state: checked ? 'complete' : 'incomplete' } : {}) },
      schema: TCheckItemSchema,
    }),
  };
}
