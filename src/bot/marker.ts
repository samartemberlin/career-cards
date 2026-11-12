// The marker line is the bot's only memory: dedup, caps and pending confirmations are all read back from it.
// So it is read only from the bot's own comments, only from their last line, and anything malformed is ignored.
import { z } from 'zod';
import type { TComment } from '../trello/api.ts';

export type CapClass = 'static' | 'model' | 'research';
export type ReplyClass = CapClass | 'refusal';
export type Proposal = { action: { id: string; args: unknown }; expires: string };
export type ReplyMarker = { actionId: string; cls: ReplyClass; proposal?: Proposal; resolves?: string };

export const MARKER_PREFIX = 'career-cards-reply:';

const CLASSES: readonly ReplyClass[] = ['static', 'model', 'research', 'refusal'];
const ID = /^[0-9a-f]{24}$/;
const LINE = /^career-cards-reply: ([0-9a-f]{24}) (static|model|research|refusal)(?: proposal=([A-Za-z0-9_-]+))?(?: resolves=([0-9a-f]{24}))?$/;

const ProposalSchema = z.object({
  action: z.object({ id: z.string().min(1), args: z.unknown() }).strict(),
  expires: z.string().datetime({ offset: true }),
}).strict();

export function formatMarker(m: ReplyMarker): string {
  if (!ID.test(m.actionId)) throw new Error('marker: actionId is not a Trello id');
  if (!CLASSES.includes(m.cls)) throw new Error('marker: unknown class');
  if (m.resolves !== undefined && !ID.test(m.resolves)) throw new Error('marker: resolves is not a Trello id');
  let line = `${MARKER_PREFIX} ${m.actionId} ${m.cls}`;
  if (m.proposal) {
    if (!ProposalSchema.safeParse(m.proposal).success) throw new Error('marker: malformed proposal');
    line += ` proposal=${Buffer.from(JSON.stringify(m.proposal), 'utf8').toString('base64url')}`;
  }
  if (m.resolves) line += ` resolves=${m.resolves}`;
  return line;
}

function decodeProposal(b64: string): Proposal | null {
  const bytes = Buffer.from(b64, 'base64url');
  // Node's decoder skips characters it can't read; only the canonical encoding counts.
  if (bytes.toString('base64url') !== b64) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const parsed = ProposalSchema.safeParse(json);
  return parsed.success ? (parsed.data as Proposal) : null;
}

export function parseMarker(text: string): ReplyMarker | null {
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  const m = last === undefined ? null : LINE.exec(last);
  if (!m) return null;
  const marker: ReplyMarker = { actionId: m[1]!, cls: m[2] as ReplyClass };
  if (m[3] !== undefined) {
    const proposal = decodeProposal(m[3]);
    if (!proposal) return null;
    marker.proposal = proposal;
  }
  if (m[4] !== undefined) marker.resolves = m[4];
  return marker;
}

export function botMarkers(comments: TComment[], botId: string): (ReplyMarker & { comment: TComment })[] {
  const out: (ReplyMarker & { comment: TComment })[] = [];
  if (!botId) return out;
  for (const comment of comments) {
    if (comment.idMemberCreator !== botId) continue;
    const marker = parseMarker(comment.text);
    if (marker) out.push({ ...marker, comment });
  }
  return out;
}
