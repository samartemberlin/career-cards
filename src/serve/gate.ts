// Decides which webhook comments the bot acts on. Every drop is silent on Trello: the gate only reads.
import { z } from 'zod';
import type { BotApi, TComment, TMember } from '../trello/api.ts';
import { isOriginalsName } from '../trello/scoped.ts';
import type { UserBoards } from '../trello/scoped.ts';
import { ConfigInvalid, readSettings } from '../trello/config.ts';
import type { Settings } from '../config/schema.ts';
import { botMarkers } from '../bot/marker.ts';

export type CommentAction = {
  id: string;
  date: Date;
  authorId: string;
  author: string;
  text: string;
  cardId: string;
  boardId: string;
  listName?: string;
};

// Ids end up in marker lines and logs, so anything but a Trello id is refused here.
const Id = z.string().regex(/^[0-9a-f]{24}$/);

const WebhookSchema = z.object({
  action: z.object({
    id: Id,
    type: z.literal('commentCard'),
    date: z.string().datetime({ offset: true }),
    idMemberCreator: Id,
    memberCreator: z.object({ username: z.string().min(1) }),
    data: z.object({
      text: z.string(),
      card: z.object({ id: Id }),
      board: z.object({ id: Id }),
      list: z.object({ name: z.string() }).optional(),
    }),
  }),
});

export function parseWebhook(body: unknown): CommentAction | null {
  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const a = parsed.data.action;
  const out: CommentAction = {
    id: a.id,
    date: new Date(a.date),
    authorId: a.idMemberCreator,
    author: a.memberCreator.username,
    text: a.data.text,
    cardId: a.data.card.id,
    boardId: a.data.board.id,
  };
  if (a.data.list) out.listName = a.data.list.name;
  return out;
}

export function mentions(text: string, username: string): boolean {
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The non-word character before `@` keeps e-mail addresses such as `x@bot.de` from counting.
  return new RegExp(`(?:^|\\W)@${escaped}(?!\\w)`, 'i').test(text);
}

export type RecentIds = { has(id: string): boolean; add(id: string): void };

export function createRecentIds(max = 1000): RecentIds {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      if (ids.size > max) ids.delete(ids.values().next().value!);
    },
  };
}

export const ACTION_MAX_AGE_MS = 3_600_000;

export type DropReason =
  | 'no mention'
  | 'foreign board'
  | 'own comment'
  | 'originals'
  | 'stale'
  | 'seen'
  | 'settings unreadable'
  | 'not allowed'
  | 'answered';

export type GateDeps = { api: BotApi; boards: UserBoards; me: TMember; seen: RecentIds; now: () => Date; log: (s: string) => void };

export type GateResult = { ok: true; settings: Settings; comments: TComment[] } | { ok: false; reason: DropReason };

/** The checks run in the plan's order: the cheap in-memory ones first, then the Trello reads. */
export async function gate(d: GateDeps, a: CommentAction): Promise<GateResult> {
  const drop = (reason: DropReason): GateResult => {
    d.log(`drop ${a.id}: ${reason}`);
    return { ok: false, reason };
  };
  const lower = (s: string) => s.toLowerCase();

  if (!mentions(a.text, d.me.username)) return drop('no mention');
  if (![d.boards.jobs, d.boards.profiles, d.boards.system].includes(a.boardId)) return drop('foreign board');
  if (a.authorId === d.me.id || lower(a.author) === lower(d.me.username)) return drop('own comment');
  if (a.boardId === d.boards.profiles && isOriginalsName(a.listName ?? '')) return drop('originals');
  if (d.now().getTime() - a.date.getTime() > ACTION_MAX_AGE_MS) return drop('stale');
  if (d.seen.has(a.id)) return drop('seen');
  // Before the first await: a retry that arrives while this one is still being handled is dropped as 'seen'.
  d.seen.add(a.id);

  let settings: Settings;
  try {
    settings = await readSettings(d.api, d.boards);
  } catch (e) {
    if (e instanceof ConfigInvalid) return drop('settings unreadable');
    throw e;
  }
  if (!settings.allowed_members.some((m) => lower(m) === lower(a.author))) return drop('not allowed');

  const comments = await d.api.cardComments(a.cardId, { limit: 50 });
  if (botMarkers(comments, d.me.id).some((m) => m.actionId === a.id)) return drop('answered');
  return { ok: true, settings, comments };
}
