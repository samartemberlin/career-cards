import { CompileFailed, CompileUnavailable, displayName } from '../compile/compile.ts';
import { readingText } from '../compile/reading.ts';
import { LISTS, PROFILE } from '../config/cards.ts';
import type { UserConfig } from '../config/schema.ts';
import { PrivacyError } from '../privacy.ts';
import { compileUser } from '../run/profiles.ts';
import { ConfigInvalid } from '../trello/config.ts';
import type { ConfigProblem } from '../trello/config.ts';
import { loadCardContext } from './context.ts';
import type { CommandCtx, HandlerResult } from './handlers.ts';
import { MASKING_REPLY, QUOTA_REPLY } from './stages/call.ts';
import { stageOpts } from './stages/handler.ts';

const WORKS_ON = '`check` works on the cards of your Profiles board (not CV or Personal details).';
const FIX_HEADER = 'These cards need a fix before a run can start:';
const NOT_ACTIVE = "This card is not read by tonight's run (its profile is not active).";
const EMPTY = "This card is empty, so tonight's run skips it.";
const NOT_READ = 'This card is not one the run reads.';

const norm = (s: string) => s.trim().toLowerCase();

/** The config problems as a reply: card and list names only, links dropped. */
export function configFixText(problems: ConfigProblem[]): string {
  const clean = (s: string) => s.replace(/https?:\/\/\S+/g, '').replace(/[\s,:]+$/, '');
  return `${FIX_HEADER}\n${problems.map((p) => `- ${p.where}: ${clean(p.message)}`).join('\n')}`;
}

/** The card's display name in the run's reading, or the reply when the run does not read it. */
function readCard(cfg: UserConfig, list: string, card: string): { name: string } | { reply: string } {
  const fixed = [
    { list: LISTS.dealBreakers, cards: cfg.board.dealBreakers },
    { list: LISTS.niceToHave, cards: cfg.board.niceToHave },
  ].find((f) => norm(f.list) === norm(list));
  if (fixed) {
    const c = fixed.cards.find((x) => norm(x.name) === norm(card));
    return c ? { name: c.name } : { reply: NOT_READ };
  }
  const profile = cfg.board.profiles.find((p) => norm(p.name) === norm(list));
  const spec = PROFILE.find((s) => s.key !== 'active' && norm(s.name) === norm(card));
  if (!profile || !spec) return { reply: NOT_READ };
  if (!profile.active) return { reply: NOT_ACTIVE };
  if (!profile.cards.find((c) => c.key === spec.key)?.text) return { reply: EMPTY };
  return { name: displayName(profile.name, spec.name) };
}

export async function checkCard(ctx: CommandCtx): Promise<HandlerResult> {
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);

  if (cc.board !== 'profiles' || norm(cc.card.list) === norm(LISTS.aboutMe)) {
    return { text: WORKS_ON, uncounted: true };
  }

  let reading;
  let name: string;
  try {
    const cfg = await ctx.config();
    const read = readCard(cfg, cc.card.list, cc.card.name);
    if ('reply' in read) return { text: read.reply, uncounted: true };
    name = read.name;
    ({ reading } = await compileUser(cfg, { ...stageOpts(ctx), attempts: 1 }));
  } catch (e) {
    if (e instanceof ConfigInvalid) return { text: configFixText(e.problems), uncounted: true };
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    if (e instanceof CompileFailed) {
      const lines = e.problems.map((p) => `- ${p.card}: ${p.reason}`).join('\n');
      return { text: `${FIX_HEADER}\n${lines}` };
    }
    if (e instanceof CompileUnavailable) return { text: QUOTA_REPLY };
    throw e;
  }

  const entry = reading.find((r) => norm(r.card) === norm(name));
  // readingOf has an entry for every card readCard accepts; the model was called, so this counts.
  if (!entry) return { text: NOT_READ };
  return { text: `How a run would read this card:\n${readingText([entry])}` };
}
