import { CompileFailed, CompileUnavailable } from '../compile/compile.ts';
import { readingText } from '../compile/reading.ts';
import { LISTS } from '../config/cards.ts';
import { compileUser } from '../run/profiles.ts';
import { ConfigInvalid } from '../trello/config.ts';
import { loadCardContext } from './context.ts';
import type { CommandCtx, HandlerResult } from './handlers.ts';
import { QUOTA_REPLY } from './stages/call.ts';
import { stageOpts } from './stages/handler.ts';

const WORKS_ON = '`check` works on the cards of your Profiles board (not CV or Personal details).';
const FIX_HEADER = 'These cards need a fix before a run can start:';
const NOT_READ = "This card is not read by tonight's run (its profile is not active).";

export async function checkCard(ctx: CommandCtx): Promise<HandlerResult> {
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);

  if (cc.board !== 'profiles' || cc.card.list === LISTS.aboutMe) {
    return { text: WORKS_ON, uncounted: true };
  }

  const isFixed = cc.card.list === LISTS.dealBreakers || cc.card.list === LISTS.niceToHave;
  const displayName = isFixed ? cc.card.name : `${cc.card.list} › ${cc.card.name}`;

  let reading;
  try {
    const cfg = await ctx.config();
    ({ reading } = await compileUser(cfg, { ...stageOpts(ctx), attempts: 1 }));
  } catch (e) {
    if (e instanceof ConfigInvalid) {
      const lines = e.problems.map((p) => `- ${p.where}: ${p.message}`).join('\n');
      return { text: `${FIX_HEADER}\n${lines}`, uncounted: true };
    }
    if (e instanceof CompileFailed) {
      const lines = e.problems.map((p) => `- ${p.card}: ${p.reason}`).join('\n');
      return { text: `${FIX_HEADER}\n${lines}` };
    }
    if (e instanceof CompileUnavailable) return { text: QUOTA_REPLY };
    throw e;
  }

  const entry = reading.find((r) => r.card.toLowerCase() === displayName.toLowerCase());
  if (!entry) {
    return { text: NOT_READ, uncounted: true };
  }

  return { text: `How a run would read this card:\n${readingText([entry])}` };
}
