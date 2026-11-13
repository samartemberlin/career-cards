import { CATALOGUE } from './catalogue.ts';
import type { CommentAction } from '../serve/gate.ts';
import { startRun } from '../serve/runs.ts';
import type { RunStarter } from '../serve/runs.ts';
import { findRunsList, parseStatusCard } from '../run/status.ts';
import type { ProcessDeps } from '../run/process.ts';
import type { BotApi, TComment, TMember } from '../trello/api.ts';
import type { UserBoards } from '../trello/scoped.ts';
import type { Settings, UserConfig } from '../config/schema.ts';
import { explainFilter } from './why.ts';
import { handleOpen } from './open.ts';
import { applyNeeds, checkLegit } from './stages/reader.ts';
import { cvTips, explainFit } from './stages/advisor.ts';
import { recordFeedback } from './feedback.ts';
import { companyResearch } from './stages/company.ts';
import type { Openings } from './stages/company.ts';
import type { UrlGuard } from '../net/safe-fetch.ts';
import type { CallOpts, Env } from '../pipeline/llm.ts';

export type OpenResult = { verdict: 'open' | 'closed' | 'unknown'; reason: string };
export type NetDeps = {
  fetchJd: ProcessDeps['fetchJd'];
  checkOpen: (url: string) => Promise<OpenResult>;
  /** The company's other open roles from its careers board, or null when none is found. Absent: straight to the researcher. */
  openings?: (company: string, exclude: string) => Promise<Openings | null>;
  /** Tests only: lets loopback pass the address checks. */
  urlGuard?: UrlGuard;
};

export type CommandCtx = {
  /** Its writes throw once `signal` is aborted. */
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
  env: Env;
  /** Tests only: the model transports. */
  call?: CallOpts;
  /** Aborted when the comment times out: pass it to every model call. */
  signal: AbortSignal;
  /** The card's newest 50 comments, as the gate read them. */
  comments: TComment[];
  /** The research cap's refusal line, or null: for a research action the router picked, whose comment counts as `model`. */
  researchCap: () => Promise<string | null>;
};

/** `uncounted`: no model call was made, so the reply does not count against a cap. */
export type HandlerResult = { text: string; links?: string[]; uncounted?: true };
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
  check_open: handleOpen,
  check_legit: checkLegit,
  apply_needs: applyNeeds,
  explain_fit: explainFit,
  cv_tips: cvTips,
  company_research: companyResearch,
  record_feedback: recordFeedback,
};

export function helpText(botName: string): string {
  const lines = CATALOGUE.filter((s) => HANDLERS[s.id]).map((s) => `@${botName} ${s.usage} — ${s.about}`);
  lines.push(`@${botName} yes / @${botName} no — confirm or cancel what I proposed on this card.`);
  return lines.join('\n');
}
