import { CATALOGUE } from './catalogue.ts';
import type { CommentAction } from '../serve/gate.ts';
import { startRun } from '../serve/runs.ts';
import type { RunStarter } from '../serve/runs.ts';
import { findRunsList, parseStatusCard } from '../run/status.ts';
import type { ProcessDeps } from '../run/process.ts';
import type { BotApi, TMember } from '../trello/api.ts';
import type { UserBoards } from '../trello/scoped.ts';
import type { Settings, UserConfig } from '../config/schema.ts';
import { explainFilter } from './why.ts';

export type OpenResult = { verdict: 'open' | 'closed' | 'unknown'; reason: string };
export type NetDeps = { fetchJd: ProcessDeps['fetchJd']; checkOpen: (url: string) => Promise<OpenResult> };

export type CommandCtx = {
  api: BotApi;
  boards: UserBoards;
  me: TMember;
  settings: Settings;
  action: CommentAction;
  now: Date;
  /** Read once per comment, on first use. */
  config: () => Promise<UserConfig>;
  starter: RunStarter;
  net: NetDeps;
  log: (s: string) => void;
};

export type HandlerResult = { text: string; links?: string[] };
export type Handler = (ctx: CommandCtx, args: unknown) => Promise<HandlerResult>;

async function showLastRun(ctx: CommandCtx): Promise<HandlerResult> {
  const runs = await findRunsList(ctx.api, ctx.boards.system, { create: false });
  if (!runs) return { text: 'No runs yet.' };
  const cards = (await ctx.api.cards(ctx.boards.system, { filter: 'open' }))
    .filter((c) => c.idList === runs.id)
    .sort((a, b) => a.pos - b.pos);
  const last = cards.find((c) => parseStatusCard(c) !== null);
  if (!last) return { text: 'No runs yet.' };
  return { text: `Last run: ${last.name}\n${last.shortUrl}`, links: [last.shortUrl] };
}

const START_COPY = {
  started: 'Run started. Its status card will appear on top of System › Runs.',
  busy: 'A run is already in progress. Its status card will appear when it ends.',
  unknown: "I couldn't check whether a run is in progress, so I didn't start one. Try again in a few minutes.",
  failed: "The run couldn't be started. The service log has details.",
} as const;

async function runNow(ctx: CommandCtx): Promise<HandlerResult> {
  return { text: START_COPY[await startRun(ctx.starter, 'manual', ctx.log)] };
}

export const HANDLERS: Partial<Record<string, Handler>> = {
  show_last_run: showLastRun,
  start_run: runNow,
  explain_filter: explainFilter as Handler,
};

export function helpText(botName: string): string {
  const lines = CATALOGUE.filter((s) => HANDLERS[s.id]).map((s) => `@${botName} ${s.usage} — ${s.about}`);
  lines.push(`@${botName} yes / @${botName} no — confirm or cancel what I proposed on this card.`);
  return lines.join('\n');
}
