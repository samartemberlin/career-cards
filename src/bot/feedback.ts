import type { BotApi, TCard } from '../trello/api.ts';
import type { Profile } from '../config/schema.ts';
import type { JobFields } from './context.ts';
import { loadCardContext } from './context.ts';
import { activeProfiles } from '../run/profiles.ts';
import { isGuardError } from '../trello/scoped.ts';
import { JOB_ONLY_REPLY } from './stages/call.ts';
import { escapeText } from './reply.ts';
import type { CommandCtx, Handler, HandlerResult } from './handlers.ts';

/** For each profile, finds the open list by that name and the open card titled "Feedback" in it. */
export async function findFeedbackCards(
  api: BotApi,
  profilesBoard: string,
  profiles: Profile[],
): Promise<{ profile: string; card: TCard | null }[]> {
  const [lists, cards] = await Promise.all([
    api.lists(profilesBoard, 'open'),
    api.cards(profilesBoard, { filter: 'open' }),
  ]);
  return profiles.map((p) => {
    const name = p.name.trim().toLowerCase();
    const list = lists.find((l) => l.name.trim().toLowerCase() === name);
    const card = list
      ? (cards.find((c) => c.idList === list.id && c.name.trim().toLowerCase() === 'feedback') ?? null)
      : null;
    return { profile: p.name, card };
  });
}

/** Builds the comment posted on the Feedback card. The user's text is quoted verbatim; `@` signs are stripped. */
export function feedbackComment(job: JobFields, cardUrl: string, text: string): string {
  const company = escapeText(job.company);
  const title = escapeText(job.title);
  const score = job.score !== null ? String(job.score) : '–';
  const url = /^https?:\/\/[^\s<>()[\]{}`*_\\|]+$/i.test(job.url) ? job.url : '–';
  const quoted = text.replace(/@(?=[A-Za-z0-9_])/g, '').split('\n').map((l) => `> ${l}`).join('\n');
  return `Feedback on [${company} — ${title}](${cardUrl}) · score ${score}\nPosting: ${url}\n\n${quoted}`;
}

export const recordFeedback: Handler = async (ctx: CommandCtx, args: unknown): Promise<HandlerResult> => {
  const { text } = args as { text: string };
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);
  if (!cc.job) return { text: JOB_ONLY_REPLY('feedback'), uncounted: true };
  const job = cc.job;

  const cfg = await ctx.config();
  const profiles = activeProfiles(cfg);
  const feedbackCards = await findFeedbackCards(ctx.api, ctx.boards.profiles, profiles);

  const links: string[] = [];
  const noCardProfiles: string[] = [];
  const guardLines: string[] = [];

  for (const { profile, card } of feedbackCards) {
    if (!card) {
      noCardProfiles.push(profile);
      continue;
    }
    try {
      await ctx.api.comment(card.id, feedbackComment(job, card.shortUrl, text));
      links.push(card.shortUrl);
    } catch (e) {
      if (isGuardError(e)) {
        guardLines.push(`Cannot record for "${profile}": ${(e as Error).message}`);
      } else {
        throw e;
      }
    }
  }

  const parts: string[] = [];
  if (links.length) parts.push(`Recorded on: ${links.join(', ')}`);
  for (const p of noCardProfiles) parts.push(`No Feedback card in the "${p}" column; add a card titled Feedback there.`);
  for (const l of guardLines) parts.push(l);

  return { text: parts.join('\n'), links };
};
