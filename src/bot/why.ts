import { jobKey } from '../pipeline/keys.ts';
import { assertPublicUrl, BlockedUrlError } from '../net/safe-fetch.ts';
import { loadJobIndex } from '../trello/job-index.ts';
import { CompileFailed, CompileUnavailable } from '../compile/compile.ts';
import { RULE_TEXT } from '../compile/filter.ts';
import { PrivacyError } from '../privacy.ts';
import { compileUser } from '../run/profiles.ts';
import { describedRejection, isoDateIn } from '../run/process.ts';
import { evidenceOf, ruleId } from '../run/stats.ts';
import type { Job } from '../pipeline/keys.ts';
import type { CommandCtx, HandlerResult } from './handlers.ts';
import { MASKING_REPLY, QUOTA_REPLY } from './stages/call.ts';
import { stageOpts } from './stages/handler.ts';

const RULE_WORDS: Record<string, string> = { ...RULE_TEXT, EXPIRED: 'the application deadline has passed' };

/** Replies made before the compile call are `uncounted`: only the compile is a model call. */
export async function explainFilter(ctx: CommandCtx, args: { link: string }): Promise<HandlerResult> {
  const { link } = args;
  const key = jobKey(link);

  const index = await loadJobIndex(ctx.api, ctx.boards.jobs);
  const existing = index.byKey.get(key);
  if (existing) {
    const archived = existing.closed ? ' (archived)' : '';
    return {
      text: `This job already has a card: ${existing.shortUrl}${archived}`,
      links: [existing.shortUrl],
      uncounted: true,
    };
  }

  // The bot's fetchJd checks every hop itself (src/bot/net.ts); this check only gives the clearer reply.
  try {
    await assertPublicUrl(link, ctx.net.urlGuard);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      return { text: "I can't check that link: it doesn't point to a public web address.", uncounted: true };
    }
    throw e;
  }

  const result = await ctx.net.fetchJd({ key, url: link });
  if (!result) {
    return { text: "I couldn't read the posting, so I can't tell which rule would apply.", uncounted: true };
  }

  const metaTitle = result.meta.title;
  if (!metaTitle) {
    return { text: "I couldn't find the job title on the page, so I can't tell.", uncounted: true };
  }

  // company defaults to '' when the page doesn't name it; the full JD lets text rules fire.
  const { employment_type, deadline, posted, location, seniority, source, company } = result.meta;
  const job: Job = {
    key, url: link, jd: result.jd, company: company ?? '', title: metaTitle,
    ...(location ? { location } : {}),
    ...(deadline ? { deadline } : {}),
    ...(employment_type ? { employment_type } : {}),
    ...(posted ? { posted } : {}),
    ...(seniority ? { seniority } : {}),
    ...(source ? { source } : {}),
  };

  const cfg = await ctx.config();
  let filter: (job: Job) => string | null;
  try {
    // One attempt: a reply comment should not wait out the run's retry pauses; asking again retries.
    ({ filter } = await compileUser(cfg, { ...stageOpts(ctx), attempts: 1 }));
  } catch (e) {
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    if (e instanceof CompileFailed) return { text: `I couldn't read your Profiles cards just now: ${e.problems[0]!.card}: ${e.problems[0]!.reason}` };
    if (e instanceof CompileUnavailable) {
      if (e.kind === 'quota') return { text: QUOTA_REPLY };
      return { text: `The model's reading of your cards didn't check out (${e.reason}). Try again in a minute.` };
    }
    throw e;
  }
  const today = isoDateIn(ctx.now, cfg.settings.timezone);

  const reason = describedRejection(job, filter, today);
  if (reason) {
    const id = ruleId(reason);
    return { text: `Rejected: ${RULE_WORDS[id] ?? id} (\`${id}\`): "${evidenceOf(reason)}"` };
  }
  return {
    text: 'No filter rejects it: it would be scored. It may not be in any scanned source yet, or it waited for the scoring cap.',
  };
}
