import { z } from 'zod';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPublicUrl, BlockedUrlError, safeFetch } from '../net/safe-fetch.ts';
import type { SafeResponse } from '../net/safe-fetch.ts';
import { htmlToText } from '../pipeline/html.ts';
import { careerOpsEnv } from '../pipeline/career-ops-env.ts';
import type { Env, SpawnLike } from '../pipeline/llm.ts';
import type { OpenResult, CommandCtx, HandlerResult } from './handlers.ts';
import { parseJobKey, parseJobLink } from '../trello/cards.ts';
import { classifyLiveness } from '#career-ops/liveness-core.mjs';

const LivenessSchema = z.union([
  z.object({ result: z.enum(['active', 'expired', 'uncertain']), code: z.string(), reason: z.string() }),
  z.null(),
]);
type ApiResult = z.infer<typeof LivenessSchema>;

const DEFAULT_CHILD = fileURLToPath(new URL('./liveness-child.ts', import.meta.url));

/** Runs the liveness-child process, returns its result or null on any failure. */
export async function apiLiveness(
  url: string,
  o: { env: Env; timeoutMs?: number; script?: string; spawn?: SpawnLike },
): Promise<Exclude<ApiResult, null> | null> {
  const { env, timeoutMs = 20_000, script = DEFAULT_CHILD, spawn = nodeSpawn } = o;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, url], {
      env: careerOpsEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d; });
    child.once('close', (code: number | null) => {
      if (code !== 0) { resolve(null); return; }
      try {
        const parsed = LivenessSchema.safeParse(JSON.parse(stdout.trim()));
        resolve(parsed.success && parsed.data !== null ? parsed.data : null);
      } catch {
        resolve(null);
      }
    });
    child.once('error', () => resolve(null));
  });
}

/** Checks whether a job posting URL is still open.
 *
 * Always calls assertPublicUrl first: the card link is user-editable, and the career-ops
 * liveness child fetches without a public-address guard. The child is never spawned for a
 * private address. Note: the child re-resolves DNS itself, so a name that resolves to a
 * private address AFTER the initial check can still reach it. */
export async function checkOpen(
  url: string,
  o: { env: Env; api?: typeof apiLiveness; fetch?: (url: string) => Promise<SafeResponse> },
): Promise<OpenResult> {
  const { env, api = apiLiveness, fetch: fetchFn = safeFetch } = o;

  try {
    await assertPublicUrl(url);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      return { verdict: 'unknown', reason: "the posting's address isn't public" };
    }
    throw e;
  }

  const liveness = await api(url, { env });
  if (liveness !== null) {
    if (liveness.result === 'active') return { verdict: 'open', reason: liveness.reason };
    if (liveness.result === 'expired') return { verdict: 'closed', reason: liveness.reason };
    return { verdict: 'unknown', reason: liveness.reason };
  }

  try {
    const res = await fetchFn(url);
    const bodyText = htmlToText(res.text);
    // Extract interactive-element text so classifyLiveness can detect apply controls.
    const applyControls: string[] = [];
    for (const m of res.text.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)) {
      const t = htmlToText(m[1]!).trim();
      if (t) applyControls.push(t);
    }
    const classified = classifyLiveness({
      status: res.status,
      requestedUrl: url,
      finalUrl: res.url,
      bodyText,
      applyControls,
    });
    // insufficient_content (page needs JS) and listing_page (redirect to a job
    // board search page) are ambiguous — not a genuine expiry signal.
    const ambiguous = classified.code === 'insufficient_content' || classified.code === 'listing_page';
    if (classified.result === 'expired' && !ambiguous) return { verdict: 'closed', reason: classified.reason };
    if (classified.result === 'active') return { verdict: 'open', reason: classified.reason };
    return { verdict: 'unknown', reason: classified.reason };
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      return { verdict: 'unknown', reason: "the posting's address isn't public" };
    }
    return { verdict: 'unknown', reason: "the page didn't answer" };
  }
}

/** `@bot open` — checks whether the job posting on this card is still accepting applications. */
export async function handleOpen(ctx: CommandCtx, _args: unknown): Promise<HandlerResult> {
  const card = await ctx.api.card(ctx.action.cardId);
  const key = parseJobKey(card.desc);
  const link = parseJobLink(card.desc);
  if (!key || !link) return { text: '`open` works on a job card.' };

  const result = await ctx.net.checkOpen(link);
  if (result.verdict === 'open') return { text: `Still open: ${result.reason}.` };
  if (result.verdict === 'closed') return { text: `Looks closed: ${result.reason}.` };
  return { text: `Unknown: ${result.reason}. Check it yourself: ${link}`, links: [link] };
}
