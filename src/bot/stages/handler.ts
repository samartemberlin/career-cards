// The steps every model-stage handler shares: the job card, the masking, the call options.
import { llmConfig } from '../../pipeline/llm.ts';
import type { CallOpts, LlmConfig } from '../../pipeline/llm.ts';
import { PrivacyError, buildBotMasking, buildMasker } from '../../privacy.ts';
import type { BotMasking } from '../../privacy.ts';
import { scoringProfile } from '../../run/profiles.ts';
import { loadCardContext } from '../context.ts';
import type { CardContext, JobFields } from '../context.ts';
import type { CommandCtx, HandlerResult } from '../handlers.ts';
import { JOB_ONLY_REPLY, MASKING_REPLY } from './call.ts';
import { researchInputFromJob } from './research-input.ts';
import type { ResearchInput, ResearchTopic } from './research-input.ts';

/** True for a reply a helper returned instead of its value. */
export const isReply = (x: unknown): x is HandlerResult =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && 'text' in x;

export function stageOpts(ctx: CommandCtx): { llm: LlmConfig; call?: CallOpts; signal: AbortSignal; log: (s: string) => void } {
  return { llm: llmConfig(ctx.env, ctx.settings), signal: ctx.signal, log: ctx.log, ...(ctx.call ? { call: ctx.call } : {}) };
}

export async function loadJob(ctx: CommandCtx, verb: string): Promise<{ cc: CardContext; job: JobFields } | HandlerResult> {
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);
  if (!cc.job) return { text: JOB_ONLY_REPLY(verb), uncounted: true };
  return { cc, job: cc.job };
}

/** `build` runs inside the same guard, so a detail left after masking is refused before any model call too. */
export async function withMasking<T>(ctx: CommandCtx, build: (m: BotMasking) => T): Promise<T | HandlerResult> {
  try {
    const cfg = await ctx.config();
    return build(buildBotMasking({ user: cfg, profile: scoringProfile(cfg) }));
  } catch (e) {
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    throw e;
  }
}

export const botMaskingFor = (ctx: CommandCtx): Promise<BotMasking | HandlerResult> => withMasking(ctx, (m) => m);

/**
 * The researcher's input, refused when the company, title or link holds a listed personal detail: those fields go to
 * web search unmasked, so a card made from a person's own name (their own firm, say) must not be researched.
 */
export async function researchInputFor(ctx: CommandCtx, job: JobFields, topic: ResearchTopic): Promise<ResearchInput | HandlerResult> {
  const input = researchInputFromJob(job, topic);
  try {
    const m = buildMasker((await ctx.config()).personalDetails, { patterns: false });
    if (![input.company, input.title, input.postingUrl].some((s) => m.hasDetail(s))) return input;
    return { text: MASKING_REPLY('a personal detail is in the company or title'), uncounted: true };
  } catch (e) {
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    throw e;
  }
}
