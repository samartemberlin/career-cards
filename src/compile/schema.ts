import { z } from 'zod';
import { specOf } from '../config/cards.ts';
import type { Preferences } from '../pipeline/prefs.ts';

const Phrase = z.string().trim().min(1).max(80);
const Phrases = (max: number) => z.array(Phrase).max(max);

export const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance'] as const;

const Level = z.enum(['none', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']);
const LanguageSkill = z.object({ read: Level.optional(), write: Level.optional(), speak: Level.optional() }).strict();

export const CompiledSchema = z.object({
  places: z.object({ anywhere: z.boolean(), keep: Phrases(300), drop: Phrases(300) }).strict(),
  employment: z.object({ keep: z.array(z.enum(EMPLOYMENT)).max(6), remote_only: z.array(z.enum(EMPLOYMENT)).max(6) }).strict(),
  linkedin_locations: z.array(z.object({ location: Phrase, remote: z.boolean().optional() }).strict()).max(5),
  company_exclude: Phrases(100),
  text_exclude: Phrases(100),
  languages: z.record(z.string().regex(/^[a-z]{2}$/), LanguageSkill).refine((v) => Object.keys(v).length <= 6, 'too many languages'),
  years_experience: z.number().min(0).max(60).nullable(),
  profiles: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    search_terms: Phrases(20),
    title_include: Phrases(60),
    title_exclude: Phrases(60),
    examples: z.array(z.object({ role: z.string().trim().min(1).max(160), score: z.number().int().min(0).max(10) }).strict()).max(12),
  }).strict()).max(10),
  unused: z.array(z.object({ card: z.string().min(1).max(120), text: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(300) }).strict()).max(40),
  problems: z.array(z.object({ card: z.string().min(1).max(120), reason: z.string().trim().min(1).max(300) }).strict()).max(20),
}).strict();

export type Compiled = z.infer<typeof CompiledSchema>;
export type CompiledProfile = Compiled['profiles'][number];

/** What makes a valid object unusable, as `{ card, reason }` with the card's display name
 *  (`"<profile> › <card>"` for profile cards). Empty means usable. */
export function unusable(c: Compiled, activeProfiles: string[]): { card: string; reason: string }[] {
  const out: { card: string; reason: string }[] = [];

  if (!c.places.anywhere && c.places.keep.length === 0) {
    out.push({ card: specOf('where').name, reason: 'no place to keep jobs in' });
  }

  for (const name of activeProfiles) {
    const profile = c.profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!profile) {
      out.push({ card: `${name} › ${specOf('roles').name}`, reason: 'profile not found' });
      continue;
    }
    if (profile.search_terms.length === 0) {
      out.push({ card: `${profile.name} › ${specOf('roles').name}`, reason: 'no search terms' });
    }
    if (profile.title_include.length === 0) {
      out.push({ card: `${profile.name} › ${specOf('roles').name}`, reason: 'no title filters' });
    }
    if (profile.examples.length < 3) {
      out.push({ card: `${profile.name} › ${specOf('dream').name}`, reason: 'fewer than 3 examples' });
    }
  }

  return out;
}

export const DEFAULT_PENALTIES: NonNullable<Preferences['penalties']> = {
  german_c1_or_native: { points: 3 },
  german_b2_or_spoken_heavy: { points: 2 },
  years_over: { points: 1, tolerance: 1, max: 3 },
};

export function preferencesOf(c: Compiled): Preferences {
  const out: Preferences = { penalties: DEFAULT_PENALTIES };
  if (c.languages.de) out.languages = { de: c.languages.de };
  if (c.years_experience !== null) out.years_experience = c.years_experience;
  return out;
}
