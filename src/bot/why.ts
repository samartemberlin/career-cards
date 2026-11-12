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
  // the real bot fetchJd (Task 13) must not shell out to career-ops for ATS keys — it
  // has no public-address guard and would follow the URL without this check.
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
