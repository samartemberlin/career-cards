import type { Profile, UserConfig } from './config/schema.ts';
import type { LlmConfig } from './pipeline/llm.ts';

export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyError';
  }
}

export type Masker = {
  mask(text: string): string;
  /** True when a listed detail is in `text`; for text that must stay verbatim, such as an allowed link. */
  hasDetail(text: string): boolean;
};

// Ported from samjobs' anonymize.mjs. All matching runs on NFKC text without soft hyphens or zero-width characters,
// so artefacts of text pasted from a PDF cannot hide a name from the masking or from the fail-closed check.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const normalize = (s: string): string => s.normalize('NFKC').replace(INVISIBLE, '');

// Starts only where the run starts, or a long run of letters without `@` takes quadratic time.
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/giu;
// Links without a scheme, such as linkedin.com/in/x. A fixed TLD list keeps Node.js, e.g. and 3.91 out.
const TLDS = 'com|de|org|net|io|eu|co|uk|me|app|dev|info|berlin|fm|ly|at|ch|nl|fr|it|es|us|edu|gov|ai|tv|xyz|blog|page|site|online|cc';
const DOMAIN = `(?:[\\p{L}\\p{N}-]+\\.)+(?:${TLDS})`;
const BARE_DOMAIN = new RegExp(`(?<![\\p{L}\\p{N}@.-])${DOMAIN}(?![\\p{L}\\p{N}])(?:/[^\\s)>\\]"]*)?`, 'giu');
const BARE_DOMAIN_ONLY = new RegExp(`^${DOMAIN}(?:/\\S*)?$`, 'iu');
const PHONE = /\+?\d[\d\s()\/–-]{5,}\d/gu;

const digitCount = (s: string): number => s.replace(/\D/g, '').length;
/** Two numbers of about the same length joined by a dash: a year or salary range. Area codes start with 0. */
function isNumberRange(s: string): boolean {
  const m = /^(\d+)\s*[–-]\s*(\d+)$/.exec(s);
  return !!m && !m[1]!.startsWith('0') && !m[2]!.startsWith('0') && Math.abs(m[1]!.length - m[2]!.length) <= 1;
}
function isPhone(match: string): boolean {
  const s = match.trim();
  return digitCount(s) >= 7 && !/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNumberRange(s);
}

// Explicit prefix overrides content-based classification.
export function classifyDetail(s: string): 'name' | 'email' | 'phone' | 'address' | 'link' {
  const lower = s.trim().toLowerCase();
  if (lower.startsWith('address:')) return 'address';
  if (lower.startsWith('link:')) return 'link';
  if (lower.startsWith('email:')) return 'email';
  if (lower.startsWith('phone:')) return 'phone';

  const val = normalize(s).trim();
  if (/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(val)) return 'email';
  if (/^(?:https?:\/\/|www\.)/i.test(val) || BARE_DOMAIN_ONLY.test(val)) return 'link';
  if (/^\+?[\d\s()\-+]{7,}$/.test(val) && (val.match(/\d/g)?.length ?? 0) >= 7) return 'phone';

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

// Flexible whitespace so "Jane  Roe" (double space) matches the detail "Jane Roe". Names under 5 characters need
// word boundaries ("Theo" must not eat "Theory"); longer ones also match inside words joined by a PDF paste.
function detailPattern(stripped: string, kind: DetailKind): string {
  const pat = escapeRegex(stripped).replace(/\s+/g, '\\s+');
  return kind === 'name' && stripped.length < 5 ? `(?<![\\p{L}\\p{N}])${pat}(?![\\p{L}\\p{N}])` : pat;
}

interface CompiledDetail {
  originalIndex: number;
  strippedLen: number;
  placeholder: string;
  replaceRe: RegExp;
  checkRe: RegExp;
}

function compileDetail(raw: string, originalIndex: number): CompiledDetail {
  const kind = classifyDetail(raw);
  const stripped = normalize(stripPrefix(raw)).trim();
  const pat = detailPattern(stripped, kind);
  return {
    originalIndex,
    strippedLen: stripped.length,
    placeholder: PLACEHOLDER[kind],
    replaceRe: new RegExp(pat, 'giu'),
    // Non-global: .test() on a global RegExp advances lastIndex, causing missed matches on reuse.
    checkRe: new RegExp(pat, 'iu'),
  };
}

function applyMask(text: string, compiled: readonly CompiledDetail[], patterns: boolean): string {
  let out = normalize(text);

  for (const { replaceRe, placeholder } of compiled) {
    out = out.replace(replaceRe, placeholder);
  }

  // Pattern-based passes run after detail substitution so a listed email/phone/link
  // is already replaced and these passes only catch unlisted occurrences. Links go before phones,
  // so digits in a link do not become [PHONE] inside it.
  if (patterns) {
    out = out.replace(EMAIL, '[EMAIL]');
    out = out.replace(URL_RE, '[LINK]');
    out = out.replace(BARE_DOMAIN, '[LINK]');
    out = out.replace(PHONE, (m) => (isPhone(m) ? '[PHONE]' : m));
  }

  // Fail closed: every detail must be absent from the output.
  // Error names the index only — never the value — so it cannot leak personal data.
  for (const { originalIndex, checkRe } of compiled) {
    if (checkRe.test(out)) {
      throw new PrivacyError(`detail at index ${originalIndex} still present after masking`);
    }
  }

  return out;
}

/** `patterns: false` replaces the listed details only, so a job posting keeps its contact email and apply link. */
export function buildMasker(details: string[], o: { patterns?: boolean } = {}): Masker {
  const patterns = o.patterns ?? true;
  if (!details.length) throw new PrivacyError('no personal details');

  const compiled = details
    .map((raw, i) => compileDetail(raw, i))
    .sort((a, b) => b.strippedLen - a.strippedLen);

  return {
    mask: (text: string) => applyMask(text, compiled, patterns),
    hasDetail: (text: string) => {
      const out = normalize(text);
      return compiled.some(({ checkRe }) => checkRe.test(out));
    },
  };
}

export function maskText(text: string, m: Masker): string {
  return m.mask(text);
}

declare const MASKED: unique symbol;

/** Everything the scorer sends about a person. Only buildScoreContext makes one: the brand stops a hand-built
 * object at compile time, and isMaskedContext stops a cast or a copy at run time. */
export type MaskedContext = Readonly<{ rubric: string; cv: string; llm: LlmConfig; translateTitle: boolean }> & {
  readonly [MASKED]: true;
};

const built = new WeakSet<object>();

/** The one place prompt text about a person is built. Throws PrivacyError (fails closed) if masking cannot be trusted. */
export function buildScoreContext(input: {
  user: Pick<UserConfig, 'sharedCv' | 'personalDetails'>;
  profile: Pick<Profile, 'rubric' | 'cv'>;
  llm: LlmConfig;
  translateTitle: boolean;
}): MaskedContext {
  const m = buildMasker(input.user.personalDetails);
  const ctx = Object.freeze({
    rubric: maskText(input.profile.rubric, m),
    cv: maskText(input.profile.cv ?? input.user.sharedCv, m),
    llm: input.llm,
    translateTitle: input.translateTitle,
  }) as MaskedContext;
  built.add(ctx);
  return ctx;
}

export function isMaskedContext(ctx: unknown): ctx is MaskedContext {
  return typeof ctx === 'object' && ctx !== null && built.has(ctx);
}

declare const BOT_MASKED: unique symbol;

/** Every piece of person text in a bot prompt comes from here. Only buildBotMasking makes one, checked the same
 * way as MaskedContext. */
export type BotMasking = Readonly<{
  profile: Readonly<{ rubric: string; cv: string }>;
  /** For job text, the request and the conversation: keeps a posting's contact email and links. */
  details(text: string): string;
  /** For the CV, the rubric and Profiles-board cards. */
  all(text: string): string;
}> & { readonly [BOT_MASKED]: true };

const botBuilt = new WeakSet<object>();

export function buildBotMasking(input: {
  user: Pick<UserConfig, 'sharedCv' | 'personalDetails'>;
  profile: { rubric: string; cv?: string };
}): BotMasking {
  const all = buildMasker(input.user.personalDetails);
  const details = buildMasker(input.user.personalDetails, { patterns: false });
  const m = Object.freeze({
    profile: Object.freeze({
      rubric: all.mask(input.profile.rubric),
      cv: all.mask(input.profile.cv ?? input.user.sharedCv),
    }),
    details: (text: string) => details.mask(text),
    all: (text: string) => all.mask(text),
  }) as BotMasking;
  botBuilt.add(m);
  return m;
}

export function isBotMasking(x: unknown): x is BotMasking {
  return typeof x === 'object' && x !== null && botBuilt.has(x);
}
