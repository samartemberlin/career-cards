// Rule engine ported from samjobs/src/filter.mjs (apply_rules). Rules are data
// (Rule[] compiled by the caller); semantics are unchanged so the regression cases still hold:
//   - ordered: exact field checks first, prose regexes last
//   - `reject` rejects on match, `require` rejects on no match
//   - a field the feed did not supply never fails a `require` rule
//   - where=text means title + "\n" + jd; where=company_title means "company | title"
//
// File loading (loadRules, loadPersonFilter) is NOT here: PR 2 builds PersonFilter from Trello cards.

import type { Job } from './keys.ts';

export type Rule = {
  id: string;
  pattern: string;
  action: 'reject' | 'require';
  where?: string;
  note?: string;
};

export type CompiledRule = Omit<Rule, 'pattern'> & { pattern: string; re: RegExp };

export class RuleError extends Error {
  readonly ruleId: string;
  readonly pattern: string;
  constructor(ruleId: string, pattern: string, cause: unknown) {
    super(`Rule ${ruleId}: invalid pattern ${JSON.stringify(pattern)}: ${String(cause)}`);
    this.name = 'RuleError';
    this.ruleId = ruleId;
    this.pattern = pattern;
  }
}

export type PersonFilter = {
  rules: CompiledRule[];
  include: RegExp[];
  exclude: RegExp[];
  locationExclude: RegExp[];
  exclusions: { company: string; reason?: string }[];
};

/** Compile a list of rules, throwing RuleError (naming id and pattern) if any regex doesn't compile. */
export function compileRules(rules: Rule[]): CompiledRule[] {
  return rules.map((r) => {
    let re: RegExp;
    try {
      re = new RegExp(r.pattern, 'im');
    } catch (e) {
      throw new RuleError(r.id, r.pattern, e);
    }
    return { ...r, re };
  });
}

function haystack(post: Job, where: string): string {
  if (where === 'text') return `${post.title ?? ''}\n${post.jd ?? ''}`;
  if (where === 'company_title') return `${post.company ?? ''} | ${post.title ?? ''}`;
  return String((post as Record<string, unknown>)[where] ?? '');
}

/**
 * Returns 'RULE_ID: "evidence"  …context…' for the first rule that rejects, else null.
 * Safe to call before the JD is fetched (jd empty): text rules then see the title only,
 * which can only reject what the full text would also reject.
 */
export function applyRules(
  post: Job,
  rules: CompiledRule[],
  exclusions: { company: string; reason?: string }[] = [],
): string | null {
  const company = (post.company ?? '').trim().toLowerCase();
  for (const ex of exclusions) {
    if (company && company === (ex.company ?? '').trim().toLowerCase()) {
      return `EXCL_MANUAL: "${ex.reason || 'on the exclusions list'}"`;
    }
  }
  for (const rule of rules) {
    const hay = haystack(post, rule.where ?? 'text');
    if (!hay.trim() && rule.action === 'require') continue;
    const m = rule.re.exec(hay);
    if (rule.action === 'reject' && m) {
      const ev = m[0].trim();
      const ctx = hay
        .slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
        .replace(/\n/g, ' ')
        .trim();
      return ctx.length > ev.length ? `${rule.id}: "${ev}"  …${ctx}…` : `${rule.id}: "${ev}"`;
    }
    if (rule.action === 'require' && !m) return `${rule.id}: "${hay.trim() || '(empty)'}"`;
  }
  return null;
}

/**
 * Per-person filter: include/exclude/location rules on top of compiled rules.
 * Order: exclusions list → rules → exclude patterns → location_exclude → include.
 * Returns a rejection reason string with evidence, or null if the job passes.
 */
export function filterJob(post: Job, f: PersonFilter): string | null {
  const hit = applyRules(post, f.rules, f.exclusions);
  if (hit) return hit;
  const title = post.title ?? '';
  for (const re of f.exclude) {
    const m = re.exec(title);
    if (m) return `EXCLUDE_TITLE: "${m[0]}"  (${re.source.slice(0, 40)}…)`;
  }
  const loc = post.location ?? '';
  for (const re of f.locationExclude) {
    const m = re.exec(loc);
    if (m) return `EXCLUDE_LOCATION: "${m[0]}"`;
  }
  if (f.include.length && !f.include.some((re) => re.test(title))) return `NOT_INCLUDED: "${title}"`;
  return null;
}
