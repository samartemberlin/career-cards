// Every bot comment is built here. Reply text can carry whatever a job page, a search result or a user's own comment
// planted in it, so these checks, not the model, decide what reaches Trello: no image, no HTML, no link the caller
// did not allow, no listed personal detail and no line that reads as a bot marker.
import { REPLY_MAX } from './catalogue.ts';
import { formatMarker } from './marker.ts';
import type { ReplyMarker } from './marker.ts';
import { PrivacyError } from '../privacy.ts';
import type { Masker } from '../privacy.ts';

export const REPLY_PARTS_MAX = 3;

const REMOVED = '[link removed]';
const CUT = '… (cut)';
const URL_CHAR = '[^\\s<>"`\\[\\]]';
const HTTP_URL = new RegExp(`https?:\\/\\/${URL_CHAR}+`, 'gi');
const TRAILING = /[).,;:!?'"]+$/;

/** http(s) links in `text`, as they would be compared with the allowed links. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(HTTP_URL)].map((m) => m[0].replace(TRAILING, ''));
}

// Decoded before anything else, in case Trello renders entities: `h&#116;tps:` must meet the link checks as `https:`.
const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', sol: '/', bsol: '\\', period: '.',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', excl: '!', num: '#', percnt: '%',
  commat: '@', equals: '=', quest: '?', semi: ';', comma: ',', lowbar: '_', hyphen: '-', dash: '-', tab: '\t', newline: '\n',
};
function decodeEntity(_: string, e: string): string {
  const lower = e.toLowerCase();
  if (!lower.startsWith('#')) return NAMED[lower] ?? '';
  const cp = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '';
}
function decodeEntities(text: string): string {
  for (let i = 0; i < 8; i++) {
    const next = text.replace(ENTITY, decodeEntity);
    if (next === text) return text;
    text = next;
  }
  return text.replace(ENTITY, '');
}

// Private-use characters are reserved for the link placeholders below, so they can't come from the input.
const STRIPPED = /[\u0000-\u0008\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uE000-\uF8FF]/g;
const LINE_BREAK = /\r\n?|[\u000B\u000C\u0085\u2028\u2029]/g;
// Markdown renders `https\://` and `jane\@mail.test` without the backslash, so the checks must not see it either.
const MD_ESCAPE = /\\+(?=[!-/:-@[-`{-~])/g;
const normalize = (text: string): string =>
  decodeEntities(text).normalize('NFKC').replace(STRIPPED, '').replace(LINE_BREAK, '\n').replace(MD_ESCAPE, '');

const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/gi;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TAG = /<[a-z!/?][^>\n]*>/gi;
const UNCLOSED_TAG = /<[a-z!/?][^\n]*/gi;
const IMAGE = /!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])?/g;
const IMAGE_START = /!+\[/g;

// Repeated until nothing changes, because removing one piece can join the pieces around it (`<<b>img>`, `!<i></i>[x](y)`).
function dropMarkup(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text.replace(AUTOLINK, '$1').replace(HTML_COMMENT, '').replace(TAG, '').replace(UNCLOSED_TAG, '').replace(IMAGE, '');
  } while (text !== prev);
  return text.replace(IMAGE_START, '[');
}

// Any line that mentions the prefix goes, not just lines that start with it: a hard split of a long line could
// otherwise turn its middle into the start of a part's last line.
const MARKER_WORD = 'career-cards-reply';
const dropMarkerLines = (text: string): string =>
  text.split('\n').filter((l) => !l.toLowerCase().includes(MARKER_WORD)).join('\n');

// Allowed links wait behind private-use placeholders while the other link checks and the masking run (the masker
// would otherwise turn them into [LINK]).
const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const TOKEN_BASE = 0xe100;
const TOKEN_MAX = 0x1000;
const TOKEN = new RegExp(`${TOKEN_OPEN}([\\u{E100}-\\u{F0FF}])${TOKEN_CLOSE}`, 'gu');
const ONLY_TOKEN = new RegExp(
  `^<?${TOKEN_OPEN}[\\u{E100}-\\u{F0FF}]${TOKEN_CLOSE}>?(?:\\s+(?:"[^"\\n]*"|'[^'\\n]*'))?$`, 'u');
// Where a link may start; anything else glued in front could make it a different link (`javascript:https://…`).
const LINK_START = /[\s(\[{"'*_~>|`]/;

const MD_TARGET = /\]\(([^)\n]*)\)/g;
// Not anchored to the line start: a definition also works inside a blockquote or a list item.
const REF_DEF = /\[([^\]\n]+)\]:[ \t]*(.*)$/gm;
const SCHEME_URL = new RegExp(`[a-z][a-z0-9+.-]*:\\/\\/${URL_CHAR}*`, 'gi');
const RISKY_SCHEME = new RegExp(
  `\\b(?:https?|ftps?|sftp|file|javascript|vbscript|data|blob|mailto|tel|sms|callto|intent|wss?):${URL_CHAR}+`, 'gi');
const WWW = new RegExp(`(?<![\\p{L}\\p{N}.-])www\\.${URL_CHAR}+`, 'giu');
const PROTOCOL_RELATIVE = new RegExp(`(?<![\\p{L}\\p{N}:/])\\/\\/[\\p{L}\\p{N}]${URL_CHAR}*`, 'gu');
// The domain endings a linkifier turns into links without a scheme: linkify-it's defaults (all two-letter country
// codes and the old generic ones), common newer ones, and IDN. `Node.js` and `e.g.` stay text.
const CC_TLD = 'a[cdefgilmnoqrstuwxz]|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|' +
  'g[abdefghilmnpqrstuwy]|h[kmnrtu]|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|' +
  'm[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|' +
  't[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]';
const G_TLD = 'biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф|int|mobi|travel|app|dev|' +
  'xyz|online|site|top|club|store|tech|cloud|live|blog|page|link|click|berlin|website|space|jobs|careers|email|' +
  'digital|agency|network|systems|solutions|ninja|wtf|zip|mov|social|lol|fun|icu|today|world|life|art|design|studio|' +
  'media|zone|xn--[a-z0-9-]+';
const BARE_DOMAIN = new RegExp(
  `(?<![\\p{L}\\p{N}@._-])(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?\\.)+(?:${G_TLD}|${CC_TLD})` +
  `(?![\\p{L}\\p{N}_-])(?::\\d{1,5})?(?:[/?#]${URL_CHAR}*)?`, 'giu');

function guardLinks(text: string, allowedLinks: Iterable<string>): { text: string; links: string[] } {
  const allowed = new Set([...allowedLinks].map((l) => l.trim()));
  const links: string[] = [];
  text = text.replace(HTTP_URL, (match: string, offset: number, whole: string) => {
    const link = match.replace(TRAILING, '');
    const rest = match.slice(link.length);
    const atStart = offset === 0 || LINK_START.test(whole[offset - 1]!);
    if (!atStart || !allowed.has(link)) return REMOVED + rest;
    let i = links.indexOf(link);
    if (i < 0) {
      if (links.length >= TOKEN_MAX) return REMOVED + rest;
      i = links.push(link) - 1;
    }
    return TOKEN_OPEN + String.fromCharCode(TOKEN_BASE + i) + TOKEN_CLOSE + rest;
  });
  text = text
    .replace(MD_TARGET, (m: string, target: string) => (ONLY_TOKEN.test(target.trim()) ? m : `] (${REMOVED})`))
    .replace(REF_DEF, (m: string, label: string, target: string) => (ONLY_TOKEN.test(target.trim()) ? m : `[${label}] ${REMOVED}`))
    .replace(SCHEME_URL, REMOVED)
    .replace(RISKY_SCHEME, REMOVED)
    .replace(WWW, REMOVED)
    .replace(PROTOCOL_RELATIVE, REMOVED)
    .replace(BARE_DOMAIN, REMOVED);
  return { text, links };
}

function restoreLinks(text: string, links: string[], masker: Masker): string {
  return text
    .replace(TOKEN, (_: string, c: string) => {
      const link = links[c.charCodeAt(0) - TOKEN_BASE];
      return link === undefined || masker.hasDetail(link) ? REMOVED : link;
    })
    .replace(/[\uE000-\uF8FF]/g, '');
}

/** Where to cut `s` to at most `max` characters: at the last space in the second half, else hard, never inside a
 * surrogate pair. Returns the head and the rest. */
function cut(s: string, max: number): [string, string] {
  const space = s.lastIndexOf(' ', max);
  if (space > max / 2) return [s.slice(0, space), s.slice(space + 1)];
  const at = /[\uD800-\uDBFF]/.test(s[max - 1] ?? '') && max > 1 ? max - 1 : max;
  return [s.slice(0, at), s.slice(at)];
}

function split(text: string, firstMax: number): string[] {
  const parts: string[] = [];
  let cur: string | null = null;
  for (let line of text.split('\n')) {
    for (;;) {
      if (parts.length > REPLY_PARTS_MAX) return parts;
      const max = parts.length === 0 ? firstMax : REPLY_MAX;
      if (cur !== null) {
        if (cur.length + 1 + line.length <= max) {
          cur += `\n${line}`;
          break;
        }
        parts.push(cur);
        cur = null;
        continue;
      }
      if (line.length <= max) {
        cur = line;
        break;
      }
      const [head, rest] = cut(line, max);
      parts.push(head);
      line = rest;
    }
  }
  if (cur !== null) parts.push(cur);
  return parts;
}

const EMPHASIS_IN_WORD = /(?<=[\p{L}\p{N}])[*_~`]+|[*_~`]+(?=[\p{L}\p{N}])/gu;
const USERNAME = /^[a-z0-9_]{1,100}$/i;

export function finishReply(r: {
  text: string;
  author: string;
  marker: ReplyMarker;
  masker: Masker;
  allowedLinks: Iterable<string>;
}): string[] {
  if (!USERNAME.test(r.author)) throw new Error('reply: author is not a Trello username');
  const marker = formatMarker(r.marker);
  const firstMax = REPLY_MAX - 2 - marker.length;
  if (firstMax < 100) throw new Error('reply: marker leaves no room for the reply');

  // Emphasis marks inside or around a word render as nothing, so `Th_eo_ Exa**mple**` shows a name the masker didn't
  // see, and `evil*.ninja` may show a link. A reply whose text, without those marks, would not pass the checks
  // unchanged is rebuilt from the text without them, through every check again.
  const check = (text: string): { body: string; unsafe: boolean } => {
    const guarded = guardLinks(dropMarkerLines(dropMarkup(text)), r.allowedLinks);
    const masked = r.masker.mask(guarded.text).replace(IMAGE_START, '[');
    const bare = masked.replace(EMPHASIS_IN_WORD, '');
    const unsafe = r.masker.hasDetail(bare) || guardLinks(dropMarkerLines(dropMarkup(bare)), []).text !== bare;
    return { body: dropMarkerLines(restoreLinks(masked, guarded.links, r.masker)).trim(), unsafe };
  };
  const text = normalize(r.text);
  let result = check(text);
  if (result.unsafe) result = check(text.replace(EMPHASIS_IN_WORD, ''));
  if (result.unsafe || r.masker.hasDetail(result.body)) throw new PrivacyError('reply: a personal detail or link is left after the checks');
  const body = result.body;

  let parts = split(body ? `@${r.author} ${body}` : `@${r.author}`, firstMax);
  if (parts.length > REPLY_PARTS_MAX) {
    parts = parts.slice(0, REPLY_PARTS_MAX);
    parts[REPLY_PARTS_MAX - 1] = `${cut(parts[REPLY_PARTS_MAX - 1]!, REPLY_MAX - CUT.length - 1)[0]}\n${CUT}`;
  }
  parts[0] = `${parts[0]}\n\n${marker}`;
  return parts;
}
