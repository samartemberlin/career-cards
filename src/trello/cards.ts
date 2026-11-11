// Job card and run column formatting for Trello.
// Ported from samjobs' views/trello.mjs (card functions only) and views/status.mjs (parseCardScore).
// Board I/O, batch selection and list lifecycle are not ported.
import type { Job } from '../pipeline/keys.ts';
import type { Facts } from '../pipeline/facts.ts';

export const TITLE_MAX = 90; // what fits on a card in the board view without wrapping to five lines
export const DESC_LIMIT = 16384;

// --- title helpers -------------------------------------------------------

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

/** The English title to show when the scorer translated one that differs from the original; else ''. */
const translated = (r: { title: string; title_en?: string }): string =>
  r.title_en && r.title_en.trim().toLowerCase() !== r.title.trim().toLowerCase()
    ? r.title_en.trim()
    : '';

/** "8 · Company — Title [DE]", at most 90 chars. A translated title carries a [DE] mark. */
export function jobCardTitle(r: {
  score: number;
  company: string;
  title: string;
  title_en?: string;
}): string {
  const en = translated(r);
  const company = clip(r.company.replace(/\s+/g, ' ').trim(), 28);
  const prefix = `${r.score} · ${company} — `;
  const mark = en ? ' [DE]' : '';
  const title = (en || r.title).replace(/\s+/g, ' ').trim();
  return prefix + clip(title, Math.max(20, TITLE_MAX - prefix.length - mark.length)) + mark;
}

// --- description ---------------------------------------------------------

/** Description with the key footer always intact; JD trimmed to fit Trello's limit.
 * The score lives only in the card title; the reason is shown here without it. Facts become labels (jobLabels). */
export function jobCardDesc(r: Job & {
  reason?: string;
  flags?: string[];
  title_en?: string;
}): { desc: string; truncated: boolean } {
  const en = translated(r);
  const head = [
    `**${r.company} — ${en || r.title}**`,
    en ? `*Original: ${r.title}*` : '',
    '',
    `**Link:** ${r.url}`,
    `**Location:** ${r.location || '—'}  ·  **Posted:** ${r.posted || '—'}  ·  **Deadline:** ${r.deadline || '—'}`,
    '',
    r.reason ? `**Why:** ${r.reason}` : '',
    r.flags?.length ? `**Flags:** ${r.flags.join(', ')}` : '',
    '',
    '---',
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
  const foot = `\n\n---\ncareer-cards-key: ${r.key}`;
  const budget = DESC_LIMIT - head.length - foot.length - 120;
  const jd = r.jd || '(no description available)';
  const truncated = jd.length > budget;
  const body = truncated
    ? `${jd.slice(0, budget).trimEnd()}\n\n… *(truncated — full text attached)*`
    : jd;
  return { desc: head + body + foot, truncated };
}

// --- key parsing ---------------------------------------------------------

// Only the last line: the footer follows the job text, which is untrusted and may carry a key line of its own.
const KEY_RE = /(?:^|\n)(?:career-cards|samjobs)-key:[ \t]*(\S+)\s*$/;

/** Reads `career-cards-key:` or `samjobs-key:` from the last line of a card description. */
export function parseJobKey(desc: string): string | null {
  return KEY_RE.exec(desc)?.[1] ?? null;
}

// --- score parsing -------------------------------------------------------

/** The score encoded in a card title ("8 · Company — Title"): integer 0-10, else null.
 * Ported from samjobs' parseCardScore. */
export function parseTitleScore(title: string): number | null {
  const m = /^\s*(\d{1,2})\s*·/.exec(title ?? '');
  const n = m ? Number(m[1]) : null;
  return n !== null && n >= 0 && n <= 10 ? n : null;
}

// --- run column name -----------------------------------------------------

// Fixed month abbreviations: Intl short-month output is ICU-version-dependent
// (Node 24 returns "Sept" for September in en-GB). This guarantees the format is stable.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Nov 10 · 01:00" in the user's timezone. Handles DST correctly via Intl. */
export function runColumnName(start: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(start);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const month = MONTHS[parseInt(get('month'), 10) - 1]!;
  return `${month} ${get('day')} · ${get('hour')}:${get('minute')}`;
}

// --- location helper -----------------------------------------------------

const REMOTE_RE = /remote|home ?office|work from/i;
const WORLD_RE = /worldwide|anywhere|global|work from/i;

/** "Berlin, Berlin, Germany" → "Berlin"; "Anywhere in the World" → "Worldwide";
 *  "Europe (Remote)" → "Europe / Remote". */
export function shortLocation(loc: string | null | undefined): string {
  const raw = String(loc ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (WORLD_RE.test(raw)) return 'Worldwide';
  const parts = raw
    .split(/[,;·|]| - /)
    .map((p) => p.replace(/\(.*?\)/g, '').trim())
    .filter((p) => p && !/^(germany|deutschland)$/i.test(p) && !REMOTE_RE.test(p));
  const place = parts[0] ?? '';
  const out = REMOTE_RE.test(raw)
    ? place
      ? `${place} / Remote`
      : 'Remote'
    : place || raw;
  return clip(out, 26);
}

// --- labels --------------------------------------------------------------

const GERMAN_LABELS: Record<string, [string, string]> = {
  none: ['English OK', 'lime'],
  a2: ['German A2', 'yellow'],
  b1: ['German B1', 'yellow'],
  b2: ['German B2', 'orange'],
  c1: ['German C1+', 'red'],
  native: ['German C1+', 'red'],
};

/** Labels for a card: where (Berlin / Remote / a city) and how much German is required (from job facts). */
export function jobLabels(r: Job & { facts?: Facts }): { name: string; color: string }[] {
  const out: { name: string; color: string }[] = [];
  const loc = shortLocation(r.location);
  for (const part of loc === 'Worldwide' ? ['Remote'] : loc.split(' / ').filter(Boolean)) {
    out.push({ name: part, color: part === 'Berlin' ? 'green' : part === 'Remote' ? 'blue' : 'sky' });
  }
  const level = r.facts?.german?.level;
  const g = level != null ? GERMAN_LABELS[level] : undefined;
  if (g) out.push({ name: g[0], color: g[1] });
  return out;
}

// --- run column name predicate -------------------------------------------

// "Nov 10 · 01:00" (runColumnName output): Mon D · HH:MM
// Also accepts "Sept" for columns created before the ICU-stable fix.
const RUN_COLUMN_RE = /^[A-Z][a-z]{2,3} \d{1,2} · \d{2}:\d{2}$/u;

/** True when a list name was produced by runColumnName. */
export function isRunColumnName(name: string): boolean {
  return RUN_COLUMN_RE.test(name);
}

// --- run summary card ----------------------------------------------------

export const RUN_SUMMARY_PREFIX = 'ℹ️ Run';

export function isRunSummaryTitle(title: string): boolean {
  return title.startsWith(RUN_SUMMARY_PREFIX);
}
