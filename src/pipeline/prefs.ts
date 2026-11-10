// Preferences → penalties: a pure function over job facts (layered scoring, layer 2). Ported from samjobs' prefs.mjs;
// reading preferences.yml is the config layer's job now.
import type { Facts } from './facts.ts';

/** A CEFR level ('A2', 'B1', ... 'C2') or 'native' / 'none', any case. */
export type LanguageLevel = string;
export type Penalty = { points: number; cap?: number };

/** A person's preferences (preferences.yml). The config schema is typed against this. */
export type Preferences = {
  languages?: { de?: { read?: LanguageLevel; write?: LanguageLevel; speak?: LanguageLevel } };
  years_experience?: number;
  penalties?: {
    german_c1_or_native?: Penalty;
    german_b2_or_spoken_heavy?: Penalty;
    german_working_language_with_english?: Penalty;
    years_over?: Penalty & { tolerance?: number; max?: number };
    degree_field_mismatch?: Penalty & { fields_ok?: string[] };
    driving_licence?: Penalty;
    unpaid_internship?: Penalty;
    named_methodology_required?: Penalty;
  };
};

export type PenaltyFacts = Pick<Facts, 'german' | 'english_working_language' | 'years' | 'degree_field' | 'driving_licence' | 'unpaid_internship' | 'methodology'>;
export type Penalties = { total: number; cap: number | null; parts: Record<string, number>; flags: string[] };

const RANK: Record<string, number> = { none: 0, a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6, native: 6 };
const rank = (l: string | null | undefined): number | null => (l == null ? null : RANK[String(l).toLowerCase()] ?? null);

export function applyPenalties(facts: PenaltyFacts | null | undefined, prefs: Preferences | null | undefined): Penalties {
  const out: Penalties = { total: 0, cap: null, parts: {}, flags: [] };
  const rules = prefs?.penalties ?? {};
  if (!facts) return out;
  const hit = (id: keyof NonNullable<Preferences['penalties']>, points: number | undefined, flag: string | null) => {
    if (!(points != null && points > 0)) return;
    out.parts[id] = points; out.total += points;
    if (flag && !out.flags.includes(flag)) out.flags.push(flag);
    const cap = rules[id]?.cap;
    if (cap != null) out.cap = out.cap == null ? cap : Math.min(out.cap, cap);
  };

  // German: the first matching rule wins, they do not stack.
  const de = prefs?.languages?.de ?? {};
  const req = rank(facts.german?.level);
  const readWrite = Math.max(rank(de.read) ?? 0, rank(de.write) ?? 0);
  const speak = rank(de.speak); // unknown speaking ability costs nothing
  const german = ((): 'german_c1_or_native' | 'german_b2_or_spoken_heavy' | 'german_working_language_with_english' | null => {
    if (req == null) return null;
    if (req >= 5 && readWrite < 5) return 'german_c1_or_native';
    if (req >= 4 && speak != null && speak < 4) return 'german_b2_or_spoken_heavy';
    if (facts.german?.spoken_heavy === true && req >= 3 && speak != null && speak < 4) return 'german_b2_or_spoken_heavy';
    if (req >= 3 && req <= 4 && facts.english_working_language === true) return 'german_working_language_with_english';
    return null;
  })();
  if (german && rules[german]) hit(german, rules[german].points, german === 'german_working_language_with_english' ? null : 'german-c1');

  const y = rules.years_over;
  if (y && facts.years?.min != null) {
    const over = facts.years.min - (prefs?.years_experience ?? 0) - (y.tolerance ?? 0);
    if (over > 0) hit('years_over', Math.min(y.max ?? Infinity, y.points * over), '3+ years');
  }
  const d = rules.degree_field_mismatch;
  if (d && facts.degree_field && !(d.fields_ok ?? []).map((x) => x.toLowerCase()).includes(facts.degree_field.toLowerCase())) hit('degree_field_mismatch', d.points, 'degree-field');
  if (rules.driving_licence && facts.driving_licence === true) hit('driving_licence', rules.driving_licence.points, 'driving licence');
  if (rules.unpaid_internship && facts.unpaid_internship === true) hit('unpaid_internship', rules.unpaid_internship.points, 'unpaid internship');
  if (rules.named_methodology_required && facts.methodology?.length) hit('named_methodology_required', rules.named_methodology_required.points, null);
  return out;
}
