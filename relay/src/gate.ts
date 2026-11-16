// The cheap gate on an unverified Trello webhook body. The workflow re-fetches the action and trusts nothing from here,
// so this only saves Actions minutes; it must never forward comment text beyond one verb.

export const MAX_BODY = 256 * 1024;
// Trello's published webhook source subnet (104.192.142.240/28).
const SUBNET = (104 << 24) | (192 << 16) | (142 << 8) | 240;
const MASK = ~0 << 4;

export function inSubnet(ip: string): boolean {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return false;
  const parts = m.slice(1).map((p) => (p.length > 1 && p.startsWith('0') ? NaN : Number(p)));
  if (parts.some((n) => !(n >= 0 && n <= 255))) return false;
  const n = parts.reduce((a, b) => (a << 8) | b, 0);
  return (n & MASK) === (SUBNET & MASK);
}

export type Forward = { action_id: string; card_id: string; board_id: string; label: string };
export type Decision = { forward: Forward } | { drop: string };

const HEX24 = /^[0-9a-f]{24}$/;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function decide(body: unknown, now: Date): Decision {
  const action = obj(obj(body).action);
  if (action.type !== 'commentCard') return { drop: 'not-comment' };
  const data = obj(action.data);
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text.startsWith('/') && !text.includes('@')) return { drop: 'no-keyword' };
  // The bot's own replies mention the asker and end with a marker line (src/bot/marker.ts); the job would drop them anyway.
  if (text.includes('career-cards-reply:')) return { drop: 'own-reply' };
  const card = obj(data.card);
  const ids = { action_id: action.id, card_id: card.id, board_id: obj(data.board).id ?? obj(obj(body).model).id };
  if (!Object.values(ids).every((v) => typeof v === 'string' && HEX24.test(v))) return { drop: 'bad-ids' };
  return { forward: { ...(ids as Omit<Forward, 'label'>), label: buildLabel(text, card, now) } };
}

/** `<verb>-<shortLink>-<MMDD>-<HHMM>z` (UTC). The verb is the token after a leading `/…` or `@…`, else `ask`. */
export function buildLabel(text: string, card: { shortLink?: unknown; id?: unknown }, now: Date): string {
  const tokens = text.trim().split(/\s+/);
  const lead = tokens[0] ?? '';
  const next = tokens[1] ?? '';
  const verb = (lead.startsWith('/') || lead.startsWith('@')) && /^[a-z-]{1,20}$/.test(next) ? next : 'ask';
  const sl = card.shortLink;
  const hex = typeof card.id === 'string' ? /^[0-9a-f]{8}/i.exec(card.id)?.[0].toLowerCase() : undefined;
  const short = typeof sl === 'string' && /^[A-Za-z0-9]{8}$/.test(sl) ? sl : (hex ?? '00000000');
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `${verb}-${short}-${t}z`;
}
