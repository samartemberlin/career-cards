export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyError';
  }
}

export type Masker = { mask(text: string): string };

// Explicit prefix overrides content-based classification.
export function classifyDetail(s: string): 'name' | 'email' | 'phone' | 'address' | 'link' {
  const lower = s.trim().toLowerCase();
  if (lower.startsWith('address:')) return 'address';
  if (lower.startsWith('link:')) return 'link';
  if (lower.startsWith('email:')) return 'email';
  if (lower.startsWith('phone:')) return 'phone';

  const val = s.trim();
  if (/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(val)) return 'email';
  if (/^(?:https?:\/\/|www\.)/i.test(val)) return 'link';
  if (/^\+?[\d\s()\-+.]{7,}$/.test(val) && (val.match(/\d/g)?.length ?? 0) >= 7) return 'phone';

  return 'name';
}

type DetailKind = ReturnType<typeof classifyDetail>;

const PLACEHOLDER: Record<DetailKind, string> = {
  name: '[USER]',
  email: '[EMAIL]',
  phone: '[PHONE]',
  address: '[ADDRESS]',
  link: '[LINK]',
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPrefix(raw: string): string {
  return raw.replace(/^(?:address|link|email|phone):\s*/i, '');
}

// Flexible whitespace so "Jane  Roe" (double space) matches the detail "Jane Roe".
function detailPattern(stripped: string): string {
  return escapeRegex(stripped).replace(/\s+/g, '\\s+');
}

interface CompiledDetail {
  originalIndex: number;
  placeholder: string;
  replaceRe: RegExp;
  checkRe: RegExp;
}

function compileDetail(raw: string, originalIndex: number): CompiledDetail {
  const kind = classifyDetail(raw);
  const stripped = stripPrefix(raw);
  const pat = detailPattern(stripped);
  return {
    originalIndex,
    placeholder: PLACEHOLDER[kind],
    replaceRe: new RegExp(pat, 'gi'),
    // Non-global: .test() on a global RegExp advances lastIndex, causing missed matches on reuse.
    checkRe: new RegExp(pat, 'i'),
  };
}

function applyMask(text: string, compiled: readonly CompiledDetail[]): string {
  let out = text;

  // Detail strings first, longest stripped length first (handles substring details correctly).
  for (const { replaceRe, placeholder } of compiled) {
    out = out.replace(replaceRe, placeholder);
  }

  // Pattern-based passes run after detail substitution so a listed email/phone/link
  // is already replaced and these passes only catch unlisted occurrences.
  out = out.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
  out = out.replace(/\+?[\d][\d\s()\-+.]{5,}/g, (m) =>
    (m.match(/\d/g)?.length ?? 0) >= 7 ? '[PHONE]' : m,
  );
  out = out.replace(/(?:https?:\/\/|www\.)\S+/gi, '[LINK]');

  // Fail closed: every detail must be absent from the output.
  // Error names the index only — never the value — so it cannot leak personal data.
  for (const { originalIndex, checkRe } of compiled) {
    if (checkRe.test(out)) {
      throw new PrivacyError(`detail at index ${originalIndex} still present after masking`);
    }
  }

  return out;
}

export function buildMasker(details: string[]): Masker {
  if (!details.length) throw new PrivacyError('no personal details');

  const compiled = details
    .map((raw, i) => compileDetail(raw, i))
    .sort((a, b) => stripPrefix(details[b.originalIndex]!).length - stripPrefix(details[a.originalIndex]!).length);

  return { mask: (text: string) => applyMask(text, compiled) };
}

export function maskText(text: string, m: Masker): string {
  return m.mask(text);
}
