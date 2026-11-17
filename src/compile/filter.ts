import { findPhrase, fold } from '../pipeline/match.ts';
import type { Job } from '../pipeline/keys.ts';
import { EMPLOYMENT } from './schema.ts';
import type { Compiled } from './schema.ts';

export const RULE_TEXT: Record<string, string> = {
  COMPANY_EXCLUDED: 'company on your exclusion list',
  PLACE_DROPPED: 'location on your drop list',
  PLACE_NOT_KEPT: 'location not in your places',
  EMPLOYMENT: 'employment type not accepted',
  REMOTE_NEEDS: 'remote employment type not accepted',
  TEXT_EXCLUDED: 'excluded word or phrase found',
  TITLE_EXCLUDED: 'title contains excluded word',
  TITLE_NOT_INCLUDED: 'title does not match any included role',
};

export function isRemote(location: string): boolean {
  return findPhrase(location, 'remote', 'word') !== null;
}

export function normEmployment(raw: string | undefined): (typeof EMPLOYMENT)[number] | null {
  if (!raw) return null;
  const f = fold(raw.trim()).replace(/[\s\-]+/g, '_');
  const matched = new Set<(typeof EMPLOYMENT)[number]>();
  if (f === 'full_time' || f === 'full' || f.includes('vollzeit')) matched.add('full_time');
  if (f === 'part_time' || f === 'part' || f.includes('teilzeit')) matched.add('part_time');
  if (f === 'contract' || f === 'contractor' || f.includes('befristet')) matched.add('contract');
  if (f === 'internship' || f.includes('intern') || f.includes('praktik')) matched.add('internship');
  if (f === 'temporary') matched.add('temporary');
  if (f === 'freelance' || f.includes('freiberuf')) matched.add('freelance');
  // Two or more types in one value → ambiguous, treat as unknown to avoid a wrong rejection.
  if (matched.size !== 1) return null;
  return [...matched][0]!;
}

/** `null` when some active profile accepts the job; else `RULE_ID: "evidence"` (first profile's reason). */
export function compiledFilter(c: Compiled, activeProfiles: string[]): (job: Job) => string | null {
  const activeLower = new Set(activeProfiles.map(n => n.toLowerCase()));
  const active = c.profiles.filter(p => activeLower.has(p.name.toLowerCase()));

  return (job: Job): string | null => {
    const loc = job.location ?? '';

    // 1. COMPANY_EXCLUDED
    for (const phrase of c.company_exclude) {
      const hit = findPhrase(job.company, phrase, 'word');
      if (hit !== null) return `COMPANY_EXCLUDED: "${hit}"`;
    }

    // 2. PLACE_DROPPED — evidence is the whole location
    for (const phrase of c.places.drop) {
      if (findPhrase(loc, phrase, 'word') !== null) return `PLACE_DROPPED: "${loc}"`;
    }

    // 3. PLACE_NOT_KEPT — location present, anywhere false, no keep phrase matches
    if (loc && !c.places.anywhere) {
      const kept = c.places.keep.some(phrase => findPhrase(loc, phrase, 'word') !== null);
      if (!kept) return `PLACE_NOT_KEPT: "${loc}"`;
    }

    // 4. EMPLOYMENT
    const emp = normEmployment(job.employment_type);
    if (c.employment.keep.length > 0 && emp !== null && !c.employment.keep.includes(emp)) {
      return `EMPLOYMENT: "${emp}"`;
    }

    // 5. REMOTE_NEEDS
    if (loc && isRemote(loc) && c.employment.remote_only.length > 0 && emp !== null && !c.employment.remote_only.includes(emp)) {
      return `REMOTE_NEEDS: "${emp}"`;
    }

    // 6. TEXT_EXCLUDED — evidence is the matched slice
    const textHay = `${job.title}\n${job.jd ?? ''}`;
    for (const phrase of c.text_exclude) {
      const hit = findPhrase(textHay, phrase, 'word');
      if (hit !== null) return `TEXT_EXCLUDED: "${hit}"`;
    }

    // 7. Per profile: TITLE_EXCLUDED then TITLE_NOT_INCLUDED.
    // Job passes when any active profile passes. Return first profile's reason when all reject.
    let firstReason: string | null = null;
    for (const profile of active) {
      let rejected = false;

      for (const phrase of profile.title_exclude) {
        const hit = findPhrase(job.title, phrase, 'word');
        if (hit !== null) {
          if (firstReason === null) firstReason = `TITLE_EXCLUDED: "${hit}"`;
          rejected = true;
          break;
        }
      }
      if (rejected) continue;

      if (profile.title_include.length > 0) {
        const mode = (phrase: string): 'substring' | 'word' => phrase.length >= 4 ? 'substring' : 'word';
        const included = profile.title_include.some(phrase => findPhrase(job.title, phrase, mode(phrase)) !== null);
        if (!included) {
          if (firstReason === null) firstReason = `TITLE_NOT_INCLUDED: "${job.title}"`;
          continue;
        }
      }

      return null; // this profile accepts the job
    }

    return firstReason;
  };
}
