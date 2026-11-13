// How a comment addresses the bot: its first word is the Settings keyword (`/bot`), or it mentions `@<bot username>`.
import { isBotKeyword } from '../config/schema.ts';

export type Trigger = { botUsername: string; keyword: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (botUsername: string) => new RegExp(`@${escapeRe(botUsername)}(?![A-Za-z0-9_])`, 'gi');

/** The comment after a leading keyword or `@<botUsername>`, or null when it starts with neither. */
export function afterTrigger(text: string, t: Trigger): string | null {
  const alts = [t.keyword, t.botUsername && `@${t.botUsername}`].filter((s) => s).map(escapeRe);
  if (!alts.length) return null;
  const m = new RegExp(`^\\s*(?:${alts.join('|')})(?=\\s|$)([\\s\\S]*)$`, 'i').exec(text);
  return m ? m[1]! : null;
}

/** The request: the comment without a leading keyword and without any mention of the bot. */
export function commandText(text: string, t: Trigger): string {
  const rest = afterTrigger(text, t) ?? text;
  return (t.botUsername ? rest.replace(mentionRe(t.botUsername), ' ') : rest).replace(/[ \t]+/g, ' ').trim();
}

/** Whether the first word could be some keyword: the gate asks before it has read the Settings that name it. */
export function mayStartWithKeyword(text: string): boolean {
  return isBotKeyword(/^\s*(\S*)/.exec(text)![1]!);
}
