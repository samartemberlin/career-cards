// Carries out an onboarding plan. It only creates: boards and membership with the owner's client, lists, cards and
// the new cards' checklists with the bot's scoped client. It never changes anything that existed before.
import type { BotApi, TChecklist, TCheckItem, TrelloApi } from '../../src/trello/api.ts';
import { TrelloError, WebhookExists } from '../../src/trello/client.ts';
import { ImmutableCardError, isGuardError, scopeBotClient, scopeClient, scopeUserBoards } from '../../src/trello/scoped.ts';
import type { Scope } from '../../src/trello/scoped.ts';
import { SampleGuardError } from '../sample/guard.ts';
import { actionLine } from './plan.ts';
import type { Action, BoardIds, OnboardPlan, Role } from './plan.ts';

const ROLES: Role[] = ['jobs', 'profiles', 'system'];
const TITLE: Record<Role, string> = { jobs: 'Jobs', profiles: 'Profiles', system: 'System' };
// Also keeps a username from turning `/members/<username>` into another path.
export const USERNAME = /^[a-z0-9_]{1,100}$/i;

const norm = (s: string): string => s.trim().toLowerCase();

function scopeOf(ids: Partial<BoardIds>): Scope {
  return { boards: ROLES.flatMap((r) => (ids[r] ? [ids[r]] : [])), ...(ids.profiles ? { profilesBoard: ids.profiles } : {}) };
}

/** Scoped to the given ids only; with all three it is exactly the run's own scope. */
export function scopedTo(raw: TrelloApi, ids: Partial<BoardIds>): BotApi {
  if (ids.jobs && ids.profiles && ids.system) return scopeUserBoards(raw, { jobs: ids.jobs, profiles: ids.profiles, system: ids.system });
  return scopeBotClient(raw, scopeOf(ids));
}

/** `BotApi` has no checklist writes; this adds them only for cards in `created`, and items only to checklists it made. */
export function checklistWriter(raw: TrelloApi, scope: Scope, created: Set<string>): {
  createChecklist(cardId: string, name: string): Promise<TChecklist>;
  addCheckItem(checklistId: string, name: string): Promise<TCheckItem>;
} {
  const inner = scopeClient(raw, scope);
  const mine = new Set<string>();
  return {
    async createChecklist(cardId, name) {
      if (!created.has(cardId)) throw new ImmutableCardError(cardId);
      const cl = await inner.createChecklist(cardId, name);
      mine.add(cl.id);
      return cl;
    },
    async addCheckItem(checklistId, name) {
      if (!mine.has(checklistId)) throw new ImmutableCardError(checklistId);
      return inner.addCheckItem(checklistId, name);
    },
  };
}

const stops = (e: unknown): boolean => isGuardError(e) || e instanceof SampleGuardError;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function applyPlan(p: OnboardPlan, c: {
  owner: TrelloApi;
  bot: TrelloApi;
  /** Ids of the boards that already exist; the plan's actions on them need these. */
  ids: Partial<BoardIds>;
  workspace?: string;
  saveIds: (ids: Partial<BoardIds>) => void;
  out: (s: string) => void;
}): Promise<{ done: number; failed: string[] }> {
  if (p.refuse.length) throw new Error(`the plan has refusals, nothing was changed: ${p.refuse.join('; ')}`);
  if (!c.workspace && p.actions.some((a) => a.kind === 'createBoard')) throw new Error('creating boards needs --workspace <id>, nothing was changed');

  const ids: Partial<BoardIds> = { ...c.ids };
  const created = new Set<string>();
  // Rebuilt when a board is created, since a scope is fixed when it is made.
  let bot = scopedTo(c.bot, ids);
  let owner = scopeClient(c.owner, scopeOf(ids));
  let checklists = checklistWriter(c.bot, scopeOf(ids), created);
  const lists = new Map<string, string>();
  const read = new Set<Role>();
  const memberIds = new Map<string, string>();

  const boardOf = (role: Role): string => {
    const id = ids[role];
    if (!id) throw new Error(`the ${TITLE[role]} board was not created`);
    return id;
  };

  const listId = async (role: Role, name: string): Promise<string> => {
    const key = `${role}/${norm(name)}`;
    if (!lists.has(key) && !read.has(role)) {
      const open = (await bot.lists(boardOf(role), 'open')).filter((l) => !l.closed).sort((x, y) => y.pos - x.pos);
      read.add(role);
      // Sorted last first, so the first list of a name wins, as in the plan.
      for (const l of open) lists.set(`${role}/${norm(l.name)}`, l.id);
    }
    const id = lists.get(key);
    if (!id) throw new Error(`no list "${name}" on the ${TITLE[role]} board`);
    return id;
  };

  const memberId = async (username: string): Promise<string> => {
    if (!USERNAME.test(username)) throw new Error(`not a Trello username: ${username}`);
    if (!memberIds.has(username)) memberIds.set(username, (await c.owner.member(username)).id);
    return memberIds.get(username)!;
  };

  const run = async (a: Action): Promise<void> => {
    switch (a.kind) {
      case 'createBoard': {
        const b = await c.owner.createBoard(a.name, c.workspace!);
        ids[a.board] = b.id;
        c.saveIds({ ...ids });
        bot = scopedTo(c.bot, ids);
        owner = scopeClient(c.owner, scopeOf(ids));
        checklists = checklistWriter(c.bot, scopeOf(ids), created);
        read.add(a.board);
        return;
      }
      case 'addMember':
        return owner.addBoardMember(boardOf(a.board), await memberId(a.username));
      case 'createList': {
        const l = await bot.createList(boardOf(a.board), a.list, 'bottom');
        lists.set(`${a.board}/${norm(a.list)}`, l.id);
        return;
      }
      case 'createCard': {
        const card = await bot.createCard({ idList: await listId(a.board, a.list), name: a.card.name, desc: a.card.desc, pos: 'bottom' });
        created.add(card.id);
        for (const spec of a.card.checklists ?? []) {
          const cl = await checklists.createChecklist(card.id, spec.name);
          for (const item of spec.items) await checklists.addCheckItem(cl.id, item);
        }
        return;
      }
      case 'webhook':
        // Registered by ensureWebhooks once all three boards exist.
        return;
    }
  };

  let done = 0;
  const failed: string[] = [];
  for (const a of p.actions) {
    if (a.kind === 'webhook') continue;
    try {
      await run(a);
      done++;
      c.out(`done: ${actionLine(a)}`);
    } catch (e) {
      if (stops(e)) throw e;
      const line = `${actionLine(a)}: ${message(e)}`;
      failed.push(line);
      c.out(`failed: ${line}`);
    }
  }
  return { done, failed };
}

/** The one webhook per board that the service needs, created with the bot's token. */
export async function ensureWebhooks(bot: TrelloApi, ids: BoardIds, url: string): Promise<{ board: string; result: 'created' | 'exists' | string }[]> {
  const api = scopeClient(bot, scopeOf(ids));
  const callbackURL = `${url.replace(/\/+$/, '')}/trello`;
  const results: { board: string; result: string }[] = [];
  for (const role of ROLES) {
    let result: string;
    try {
      await api.createWebhook(ids[role], callbackURL, `career-cards ${role}`);
      result = 'created';
    } catch (e) {
      if (stops(e)) throw e;
      if (e instanceof WebhookExists) result = 'exists';
      // Trello checks the callback with a HEAD request before it creates the webhook and answers 400 when that fails.
      else if (e instanceof TrelloError && e.status === 400) result = `service not reachable at ${callbackURL} (deploy first, check PUBLIC_URL)`;
      else result = `error: ${message(e)}`;
    }
    results.push({ board: role, result });
  }
  return results;
}

/** Trello has no API for automation rules, so the user creates this one by hand on the System board. */
export function automationRule(url: string, time = '01:00'): string {
  return [
    `every day at ${time}, send a POST request to ${url.replace(/\/+$/, '')}/trigger/run?key=<TRIGGER_SECRET>`,
    "paste TRIGGER_SECRET from your platform's secrets; Trello has no API for automations",
  ].join('\n');
}
