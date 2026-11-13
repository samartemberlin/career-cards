// Every bot comment is built here. Reply text can carry whatever a job page, a search result or a user's own comment
// planted in it, so these checks, not the model, decide what reaches Trello. The reply is plain text: every character
// Markdown or HTML can act on is escaped, so no construct renders, whatever it is. Links are never taken from the
// text: every one is removed, and the allowed links the text mentioned are listed after it by this code, in one form.
import { REPLY_MAX } from './catalogue.ts';
import { formatMarker } from './marker.ts';
import type { ReplyMarker } from './marker.ts';
import { PrivacyError } from '../privacy.ts';
import type { Masker } from '../privacy.ts';

export const REPLY_PARTS_MAX = 3;

const REMOVED = '[link removed]';
const CUT = '… (cut)';
const HTTP_URL = /https?:\/\/[^\s<>"`\[\]]+/gi;
const TRAILING = /[).,;:!?'"*_~]+$/;

/** http(s) links in `text`, as they would be compared with the allowed links. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(HTTP_URL)].map((m) => m[0].replace(TRAILING, ''));
}

// Decoded first, in case Trello decodes entities: `h&#116;tps:` must meet the link checks as `https:`.
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

const STRIPPED = /[\u0000-\u0008\u000E-\u001F\u007F\u00AD\u200B-‏‪-‮⁠-⁤⁦-⁩\uFEFF\uE000-\uF8FF]/g;
const LINE_BREAK = /\r\n?|[\u000B\u000C\u0085\u2028\u2029]/g;
// The output escapes every backslash, so none of these could unescape on Trello; they go so that the link and detail
// checks see `https\://` and `jane\@mail.test` as what they would read as.
const MD_ESCAPE = /(?<!\\)\\+(?=[!-/:-@[-`{-~])/g;
const normalize = (text: string): string =>
  decodeEntities(text).normalize('NFKC').replace(STRIPPED, '').replace(LINE_BREAK, '\n').replace(MD_ESCAPE, '');

// Any line that mentions the prefix goes, not just lines that start with it.
const MARKER_WORD = 'career-cards-reply';
const dropMarkerLines = (text: string): string =>
  text.split('\n').filter((l) => !l.toLowerCase().includes(MARKER_WORD)).join('\n');

// A listed link is emitted as a CommonMark autolink, which allows no space, `<` or `>` inside; RFC 3986 characters
// only, so nothing in it can end the autolink or be read as anything else.
export const SAFE_LINK = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+$/;
export const LINK_MAX = 1000;
const LINKS_MAX = 10;

function isSafeLink(link: string, masker: Masker): boolean {
  if (link.length > LINK_MAX || !SAFE_LINK.test(link) || masker.hasDetail(link)) return false;
  try {
    return new URL(link).hostname.length > 0;
  } catch {
    return false;
  }
}

/** Every http(s) link becomes `[link N]` when allowed, else `[link removed]`. */
function takeLinks(text: string, allowedLinks: Iterable<string>, masker: Masker): { text: string; links: string[] } {
  const allowed = new Set([...allowedLinks].map((l) => l.trim()).filter((l) => isSafeLink(l, masker)));
  const links: string[] = [];
  text = text.replace(HTTP_URL, (match: string) => {
    const link = match.replace(TRAILING, '');
    const rest = match.slice(link.length);
    let i = links.indexOf(link);
    if (i < 0 && allowed.has(link) && links.length < LINKS_MAX) i = links.push(link) - 1;
    return (i < 0 ? REMOVED : `[link ${i + 1}]`) + rest;
  });
  return { text, links };
}

const SCHEME_URL = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const RISKY_SCHEME = /\b(?:https?|ftps?|sftp|file|javascript|vbscript|data|blob|mailto|tel|sms|callto|intent|xmpp|wss?):\S+/gi;
const PROTOCOL_RELATIVE = /\/\/[^\s/]\S*/gu;
// A label is what linkify-it counts as one: anything but space, punctuation and control characters, so emoji,
// symbols and combining marks are in (`😀😀.ws`, `evil\u034F.io`); emphasis marks and `-` too (`evil*.ninja`).
// The alternatives must not overlap and a match may start only where a label starts, or a long run without a dot
// backtracks for seconds.
const HOST = /(?<![^\s\p{P}\p{Z}\p{Cc}]|[*_-])(?:[^\s\p{P}\p{Z}\p{Cc}]|[*_-])+(?:\.(?:[^\s\p{P}\p{Z}\p{Cc}]|[*_-])+)+/gu;
const IPV4 = /(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{L}\p{N}])/gu;
// Any ending of two or more letters may be a top-level domain some linkifier knows, so a dotted word goes unless its
// endings are all on this short list of file extensions that are not domains (`Node.js`). `e.g.` and `3.91` stay.
const NOT_TLD = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'txt', 'csv', 'html', 'htm', 'css',
  'scss', 'xml', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'docx', 'xlsx', 'pptx', 'exe', 'dll', 'sql', 'php']);
// A linkifier may end the host at any character after the ending's letters (`evil.io*1`), and the URL parser drops
// combining marks and format characters inside it (`evil.i\u034Fo`), so only the leading letters count, read
// through those and through emphasis marks (`evil.n*inja`).
function mayBeTld(label: string): boolean {
  const bare = label.replace(/[\p{M}\p{Cf}*_~`]/gu, '').toLowerCase();
  const letters = /^\p{L}*/u.exec(bare)![0];
  return bare.startsWith('xn--') || (letters.length >= 2 && !NOT_TLD.has(letters));
}
const dropHost = (host: string): string => (host.split('.').slice(1).some(mayBeTld) ? REMOVED : host);

/** Removes every other link form, repeated until nothing changes. */
function stripLinks(text: string): string {
  for (let i = 0; i < 16; i++) {
    const next = text
      .replace(SCHEME_URL, REMOVED)
      .replace(RISKY_SCHEME, REMOVED)
      .replace(PROTOCOL_RELATIVE, REMOVED)
      .replace(IPV4, REMOVED)
      .replace(HOST, dropHost);
    if (next === text) return text;
    text = next;
  }
  throw new PrivacyError('reply: links do not settle');
}

const MARKS = /[*_~`]/g;
// Every ASCII punctuation character CommonMark, GFM or HTML give a meaning to. Left out: , ; ? " ' % / which mean
// something only inside a link, a tag or an entity, and each of those needs an escaped character to start.
const ACTIVE = /[!#$&()*+\-.:<=>@[\\\]^_`{|}~]/g;
export const escapeText = (line: string): string => line.replace(ACTIVE, '\\$&');

/** The plain text of the reply: links taken out, details masked, one space between words, no marker line. */
// Never more than fits the parts, and it bounds the time the patterns below take; again after normalising, because
// NFKC can make text longer (`㌖` is six letters). Cut at a space if there is one in the second half, so the cut
// does not leave half of a listed detail that the masking would no longer recognise.
const TEXT_MAX = REPLY_MAX * REPLY_PARTS_MAX;
function capped(text: string): string {
  if (text.length <= TEXT_MAX) return text;
  const space = text.slice(0, TEXT_MAX).search(/\s\S*$/);
  if (space > TEXT_MAX / 2) return text.slice(0, space);
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[TEXT_MAX - 1]!) ? TEXT_MAX - 1 : TEXT_MAX);
}

function plainText(r: { text: string; masker: Masker; allowedLinks: Iterable<string> }): { text: string; links: string[] } {
  const taken = takeLinks(dropMarkerLines(capped(normalize(capped(r.text)))), r.allowedLinks, r.masker);
  let masked = r.masker.mask(taken.text);
  // Marks are shown, not rendered, but `Th_eo_ Exa**mple**` still reads as the name.
  if (r.masker.hasDetail(masked.replace(MARKS, ''))) masked = r.masker.mask(taken.text.replace(MARKS, ''));
  const plain = dropMarkerLines(stripLinks(masked))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (r.masker.hasDetail(plain) || r.masker.hasDetail(plain.replace(MARKS, ''))) {
    throw new PrivacyError('reply: a personal detail is left after masking');
  }
  return { text: plain, links: taken.links };
}

/**
 * Whether a reply of `text` would drop anything: a link form other than the allowed http(s) links, or a marker line.
 * True as well when it can't tell (a literal `[link removed]`, or links that don't settle).
 */
export function removesLinks(text: string, allowedLinks: Iterable<string>): boolean {
  if (text.includes(REMOVED) || /career-cards-reply/i.test(text)) return true;
  try {
    return plainText({ text, masker: { mask: (t) => t, hasDetail: () => false }, allowedLinks }).text.includes(REMOVED);
  } catch {
    return true;
  }
}

/** Where to cut an escaped line to at most `max` characters: at the last space in the second half, else after the
 * last whole character, never between a backslash and what it escapes, nor inside a surrogate pair. */
function cut(s: string, max: number): [string, string] {
  const space = s.lastIndexOf(' ', max);
  if (space > max / 2) return [s.slice(0, space), s.slice(space + 1)];
  let at = 0;
  while (at < s.length) {
    const width = s[at] === '\\' || /[\uD800-\uDBFF]/.test(s[at]!) ? 2 : 1;
    if (at + width > max) break;
    at += width;
  }
  return [s.slice(0, at), s.slice(at).trimStart()];
}

type Line = { text: string; atomic: boolean };

function split(lines: Line[], firstMax: number): string[] {
  const parts: string[] = [];
  let cur: string | null = null;
  for (let { text: line, atomic } of lines) {
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
      if (atomic) throw new Error('reply: a link line does not fit a part');
      const [head, rest] = cut(line, max);
      parts.push(head);
      line = rest;
    }
  }
  if (cur !== null) parts.push(cur);
  return parts;
}

function cutLast(part: string): string {
  const lines = part.split('\n');
  const room = REPLY_MAX - CUT.length - 1;
  while (lines.join('\n').length > room) {
    if (lines.length > 1) lines.pop();
    else lines[0] = cut(lines[0]!, room)[0];
  }
  return `${lines.join('\n')}\n${CUT}`;
}

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

  const plain = plainText(r);
  const [first, ...rest] = plain.text ? plain.text.split('\n').map(escapeText) : [];
  const lines: Line[] = [{ text: first ? `@${r.author} ${first}` : `@${r.author}`, atomic: false }];
  for (const text of rest) lines.push({ text, atomic: false });
  if (plain.links.length) {
    lines.push({ text: '', atomic: false }, { text: 'Links:', atomic: false });
    plain.links.forEach((link, i) => lines.push({ text: `link ${i + 1}: <${link}>`, atomic: true }));
  }

  let parts = split(lines, firstMax);
  if (parts.length > REPLY_PARTS_MAX) {
    parts = parts.slice(0, REPLY_PARTS_MAX);
    parts[REPLY_PARTS_MAX - 1] = cutLast(parts[REPLY_PARTS_MAX - 1]!);
  }
  parts[0] = `${parts[0]}\n\n${marker}`;
  return parts;
}
