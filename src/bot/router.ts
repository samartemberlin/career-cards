// Free text goes to the router, which may only answer or pick one catalogued action. Whatever it picks, code decides
// what runs: confirm actions become a code-written proposal, and the router's own reply is dropped for any action.
import { CATALOGUE, RouterOutputSchema } from './catalogue.ts';
import type { RouterOutput } from './catalogue.ts';
import { proposal } from './confirm.ts';
import type { Proposal } from './marker.ts';
import { loadCardContext } from './context.ts';
import { HANDLERS } from './handlers.ts';
import type { CommandCtx, HandlerResult } from './handlers.ts';
import { routerMessages } from './prompt.ts';
import { linksIn, removesLinks } from './reply.ts';
import type { RouterInput } from './prompt.ts';
import { MASKING_REPLY, StageOutputInvalid, TIMEOUT_REPLY, callStage, stageErrorReply } from './stages/call.ts';
import { llmConfig } from '../pipeline/llm.ts';
import type { CallOpts, LlmConfig } from '../pipeline/llm.ts';
import { PrivacyError, buildBotMasking } from '../privacy.ts';
import { scoringProfile } from '../run/profiles.ts';

export const SORRY_REPLY = (): string => {
  const verbs = CATALOGUE.filter((s) => HANDLERS[s.id]).map((s) => s.verbs[0]);
  return `Sorry, I couldn't work that out. Try again, or use one of: ${verbs.join(', ')}.`;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The comment without any `@<botName>` mention. */
export function requestOf(text: string, botName: string): string {
  return text.replace(new RegExp(`@${escapeRe(botName)}(?![A-Za-z0-9_])`, 'gi'), ' ').replace(/[ \t]+/g, ' ').trim();
}

export async function route(
  input: RouterInput,
  o: { llm: LlmConfig; call?: CallOpts; signal?: AbortSignal; log?: (s: string) => void },
): Promise<RouterOutput> {
  return (await callStage(routerMessages(input), RouterOutputSchema, o)).value;
}

/** What the comment gets: the reply, or a proposal for `@bot yes` to run. Posting is the dispatcher's job. */
export async function handleFreeText(ctx: CommandCtx, botName: string): Promise<HandlerResult & { proposal?: Proposal }> {
  const request = requestOf(ctx.action.text, botName);
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);

  const cfg = await ctx.config();
  let out: RouterOutput;
  try {
    const input = { request, ctx: cc, masking: buildBotMasking({ user: cfg, profile: scoringProfile(cfg) }) };
    out = await route(input, { llm: llmConfig(ctx.env, ctx.settings), signal: ctx.signal, log: ctx.log, ...(ctx.call ? { call: ctx.call } : {}) });
  } catch (e) {
    // Masking runs before the model call, and the call itself never throws a PrivacyError.
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    if (e instanceof StageOutputInvalid) {
      ctx.log(`router output invalid on ${ctx.action.id}: ${e.message}`);
      return { text: SORRY_REPLY() };
    }
    return { text: stageErrorReply(e, ctx.log) };
  }

  const { action } = out;
  if (!action) return { text: out.reply.trim() || SORRY_REPLY() };
  const spec = CATALOGUE.find((s) => s.id === action.id)!;
  ctx.log(`router picked ${spec.id} on ${ctx.action.id}`);

  // A link the router passes on must be one the user wrote: a link planted in card text or an earlier reply can't
  // make the bot fetch it, nor ride into feedback (whose shown proposal has its links removed, so a `yes` can't vet them).
  const args = action.args as { link?: unknown; text?: unknown };
  const foreignLink = typeof args.link === 'string' && !linksIn(request).includes(args.link);
  if (foreignLink || (typeof args.text === 'string' && removesLinks(args.text, linksIn(request)))) {
    ctx.log(`router link not in the request on ${ctx.action.id}`);
    return { text: SORRY_REPLY() };
  }

  if (spec.router === 'confirm') {
    try {
      const p = proposal({ id: action.id, args: action.args }, ctx.now);
      return { text: proposalText(p), proposal: p };
    } catch (e) {
      ctx.log(`router proposal failed on ${ctx.action.id}: ${e instanceof Error ? e.message : String(e)}`);
      return { text: SORRY_REPLY() };
    }
  }
  const handler = HANDLERS[spec.id];
  if (!handler) return { text: `\`${spec.verbs[0]}\` isn't available yet.` };
  if (ctx.signal.aborted) return { text: TIMEOUT_REPLY };
  try {
    // The router call already counts, so a handler's `uncounted` doesn't apply here.
    const { text, links } = await handler(ctx, action.args);
    return links ? { text, links } : { text };
  } catch (e) {
    if (ctx.signal.aborted) return { text: TIMEOUT_REPLY };
    ctx.log(`handler ${spec.id} failed on ${ctx.action.id}: ${(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split('\n')[0]}`);
    return { text: `Sorry, ${spec.verbs[0]} failed. The service log has details.` };
  }
}

// Written from the proposal itself, so the user sees exactly what `yes` will run.
function proposalText(p: Proposal): string {
  if (p.action.id === 'record_feedback') return `Post this on the Feedback card?\n${(p.action.args as { text: string }).text}`;
  if (p.action.id === 'start_run') return 'Start a manual run now?';
  throw new Error(`router: no proposal text for ${p.action.id}`);
}
