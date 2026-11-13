// Side-effect actions run only after `@bot yes`, and what `yes` runs is read back from the bot's own marker lines, so
// a proposal counts only if the bot wrote it, it is the bot's newest reply, it still parses as a confirm action, and it
// is fresh.
import { CATALOGUE, RouterOutputSchema } from './catalogue.ts';
import type { ActionSpec } from './catalogue.ts';
import { botMarkers } from './marker.ts';
import type { Proposal, ReplyMarker } from './marker.ts';
import { finishReply } from './reply.ts';
import type { Masker } from '../privacy.ts';
import type { TComment } from '../trello/api.ts';

export const PROPOSAL_TTL_MS = 24 * 3_600_000;
// The proposal rides in the marker line on part 1 of the reply. 2,200 bytes of JSON keep the marker near 3,000
// characters, so plain feedback of the full length still fits and part 1 keeps room for the proposal text.
export const PROPOSAL_BYTES_MAX = 2200;

const ActionSchema = RouterOutputSchema.shape.action.unwrap();

function confirmSpec(action: unknown): { spec: ActionSpec; args: unknown } | null {
  const parsed = ActionSchema.safeParse(action);
  if (!parsed.success) return null;
  const spec = CATALOGUE.find((s) => s.id === parsed.data.id);
  return spec?.router === 'confirm' ? { spec, args: parsed.data.args } : null;
}

const bytes = (p: Proposal) => Buffer.byteLength(JSON.stringify(p), 'utf8');

export function proposal(action: { id: string; args: unknown }, now: Date): Proposal {
  if (!confirmSpec(action)) throw new Error('proposal: not a confirm action');
  const expires = new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString();
  const p: Proposal = { action: { id: action.id, args: action.args }, expires };
  if (bytes(p) <= PROPOSAL_BYTES_MAX) return p;
  if (action.id !== 'record_feedback') throw new Error('proposal: too large for the marker');
  // Escaped and multi-byte characters weigh more, so keep the longest prefix of whole characters that fits.
  const chars = [...(action.args as { text: string }).text];
  const withText = (n: number): Proposal => ({ action: { id: action.id, args: { text: chars.slice(0, n).join('') } }, expires });
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(withText(mid)) <= PROPOSAL_BYTES_MAX) lo = mid;
    else hi = mid - 1;
  }
  const capped = withText(lo);
  if (lo === 0 || !confirmSpec(capped.action)) throw new Error('proposal: feedback does not fit the marker');
  return capped;
}

export function proposalText(text: string, keyword: string): string {
  return `${text}\n\nReply \`${keyword} yes\` within 24 h to run it, or \`${keyword} no\`.`;
}

const ELLIPSIS = '…';

/** A proposal reply in one comment: `text` is cut until it and the yes/no line fit part 1 beside the marker. */
export function finishProposal(r: {
  text: string;
  keyword: string;
  author: string;
  marker: ReplyMarker & { proposal: Proposal };
  masker: Masker;
  allowedLinks: Iterable<string>;
}): string[] {
  // Masked before any cut, and cut at a space where one is in the second half, as reply.ts does: half of a listed
  // detail is no longer recognised by the masker.
  const masked = r.masker.mask(r.text);
  const chars = [...masked];
  const head = (n: number): string => {
    const s = chars.slice(0, n).join('');
    const space = s.search(/\s\S*$/);
    return (space > s.length / 2 ? s.slice(0, space) : s) + ELLIPSIS;
  };
  const attempt = (n: number) => finishReply({ ...r, text: proposalText(n < chars.length ? head(n) : masked, r.keyword) });
  let parts = attempt(chars.length);
  if (parts.length === 1) return parts;
  // Masking and escaping can lengthen text, and not evenly, so the cut is searched for, not computed.
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (attempt(mid).length === 1) lo = mid;
    else hi = mid - 1;
  }
  parts = attempt(lo);
  if (parts.length !== 1) throw new Error('reply: the proposal line does not fit part 1');
  return parts;
}

export type Pending = { actionId: string; spec: ActionSpec; args: unknown };

const newestFirst = (a: TComment, b: TComment) =>
  Date.parse(b.date) - Date.parse(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function findPending(
  comments: TComment[],
  o: { botId: string; now: Date },
): { kind: 'pending'; pending: Pending } | { kind: 'expired' } | { kind: 'none' } {
  const markers = botMarkers(comments, o.botId).sort((a, b) => newestFirst(a.comment, b.comment));
  // Only while it is the bot's latest word: a later reply can be model text that asks for `yes` about something else.
  const newest = markers[0];
  if (!newest?.proposal) return { kind: 'none' };
  // Any bot marker naming it closes it, not just later ones: a stray earlier resolve can only take a confirmation away.
  if (markers.some((m) => m.resolves === newest.actionId)) return { kind: 'none' };
  const valid = confirmSpec(newest.proposal.action);
  if (!valid) return { kind: 'none' };
  const expires = Date.parse(newest.proposal.expires);
  if (!(expires <= o.now.getTime() + PROPOSAL_TTL_MS)) return { kind: 'none' };
  if (expires <= o.now.getTime() || Date.parse(newest.comment.date) + PROPOSAL_TTL_MS <= o.now.getTime()) {
    return { kind: 'expired' };
  }
  return { kind: 'pending', pending: { actionId: newest.actionId, spec: valid.spec, args: valid.args } };
}
