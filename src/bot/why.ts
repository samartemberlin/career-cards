import { jobKey } from '../pipeline/keys.ts';
import { assertPublicUrl, BlockedUrlError } from '../net/safe-fetch.ts';
import { loadJobIndex } from '../trello/job-index.ts';
import { activeProfiles, combinedFilter } from '../run/profiles.ts';
import { describedRejection, isoDateIn } from '../run/process.ts';
import { ruleId } from '../run/stats.ts';
import type { Job } from '../pipeline/keys.ts';
import type { CommandCtx, HandlerResult } from './handlers.ts';

export async function explainFilter(ctx: CommandCtx, args: { link: string }): Promise<HandlerResult> {
  const { link } = args;
  const key = jobKey(link);

  // Check if the job already has a card (open or archived) before making any external request.
  const index = await loadJobIndex(ctx.api, ctx.boards.jobs);
  const existing = index.byKey.get(key);
  if (existing) {
    const archived = existing.closed ? ' (archived)' : '';
    return {
      text: `This job already has a card: ${existing.shortUrl}${archived}`,
      links: [existing.shortUrl],
    };
  }

  // assertPublicUrl must run before fetchJd: the link comes from a user comment, and
  // fetchJd for ATS keys may shell out to career-ops without its own address guard.
  try {
    await assertPublicUrl(link);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      return { text: "I can't check that link: it doesn't point to a public web address." };
    }
    throw e;
  }

  const result = await ctx.net.fetchJd({ key, url: link });
  if (!result) {
    return { text: "I couldn't read the posting, so I can't tell which rule would apply." };
  }

  const metaTitle = result.meta.title;
  if (!metaTitle) {
    return { text: "I couldn't find the job title on the page, so I can't tell." };
  }

  // Build a job for the filter: key and url come from the command; company defaults to empty
  // when the page doesn't name it; the full JD is included so text rules can fire.
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
  const filter = combinedFilter(activeProfiles(cfg), cfg.settings);
  const today = isoDateIn(ctx.now, cfg.settings.timezone);

  const reason = describedRejection(job, filter, today);
  if (reason) {
    return { text: `Rejected by rule \`${ruleId(reason)}\`: ${reason}` };
  }
  return {
    text: 'No filter rejects it: it would be scored. It may not be in any scanned source yet, or it waited for the scoring cap.',
  };
}
