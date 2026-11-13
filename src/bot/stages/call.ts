// One model call for a bot stage. No repair retry: an answer that fails the schema gets the sorry reply and runs
// nothing, so a model steered by job text can't talk its way through a second attempt.
import type { z } from 'zod';
import { QuotaExhausted, callLLM } from '../../pipeline/llm.ts';
import type { CallOpts, LlmConfig, Message } from '../../pipeline/llm.ts';
import { PrivacyError } from '../../privacy.ts';

export class StageOutputInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageOutputInvalid';
  }
}

export const QUOTA_REPLY = 'No AI provider is available right now (quota or outage). Try again later.';
export const MASKING_REPLY = (message: string): string =>
  `Masking failed, so nothing was sent to a model: ${message}. Check the Personal details card.`;
export const JOB_ONLY_REPLY = (verb: string): string => `\`${verb}\` works on job cards only.`;
const INVALID_REPLY = "Sorry, the model's answer didn't check out. Try again.";
export const TIMEOUT_REPLY = 'Sorry, that took too long.';
const ERROR_REPLY = 'Sorry, something went wrong.';

/**
 * The JSON object in a model answer: the whole text, else the outermost `{…}`, after a code fence is removed.
 * Whole text that is valid JSON but not an object (an array, say) is rejected, not searched.
 */
export function parseJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  const isObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const tryParse = (s: string): { v: unknown } | null => { try { return { v: JSON.parse(s) }; } catch { return null; } };
  const whole = tryParse(t);
  if (whole) {
    if (isObject(whole.v)) return whole.v;
    throw new StageOutputInvalid('the answer is JSON but not an object');
  }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  const inner = start >= 0 && end > start ? tryParse(t.slice(start, end + 1)) : null;
  if (inner && isObject(inner.v)) return inner.v;
  throw new StageOutputInvalid('no JSON object in the answer');
}

export async function callStage<T>(
  messages: Message[],
  schema: z.ZodType<T>,
  o: { llm: LlmConfig; call?: CallOpts; signal?: AbortSignal; log?: (s: string) => void },
): Promise<{ value: T; model: string; tokens: number }> {
  const opts: CallOpts = { ...o.call };
  if (o.signal) opts.signal = o.signal;
  if (o.log) opts.log = o.log;
  const r = await callLLM(o.llm, messages, opts);
  const parsed = schema.safeParse(parseJsonObject(r.text));
  // Paths only: the values are model output.
  if (!parsed.success) throw new StageOutputInvalid(`schema: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`);
  const u = r.usage;
  return { value: parsed.data, model: r.model, tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) };
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');

/** The user-facing line for a failed stage; only unexpected errors are logged. */
export function stageErrorReply(e: unknown, log: (s: string) => void = console.error): string {
  if (e instanceof QuotaExhausted) return QUOTA_REPLY;
  if (e instanceof PrivacyError) return MASKING_REPLY(e.message);
  if (e instanceof StageOutputInvalid) return INVALID_REPLY;
  if (isAbort(e)) return TIMEOUT_REPLY;
  log(`stage failed: ${(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split('\n')[0]}`);
  return ERROR_REPLY;
}
