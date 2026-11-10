// User config read from Trello: the Settings card, one card per profile, the shared CV, personal details, preferences.
import { z } from 'zod';
import { load } from 'js-yaml';
import type { Preferences } from '../pipeline/prefs.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export const SettingsSchema = z.object({
  timezone: z.string().default('Europe/Berlin')
    // Intl's list leaves out names its own formatter accepts, such as UTC.
    .refine((tz) => TIMEZONES.has(tz) || isFormatterZone(tz), (tz) => ({ message: `unknown timezone ${JSON.stringify(tz)}` })),
  providers: z.array(z.string().min(1)).min(1),
  models: z.record(z.string(), z.string()).optional(),
  scoring_cap: z.number().int().positive().default(150),
  locations: z.array(z.string()),
  labels: z.array(z.object({ name: z.string().min(1), color: z.string().min(1) })).optional(),
  linkedin: z.boolean().default(false),
  allowed_members: z.array(z.string().min(1)).default([]),
  caps: z.object({
    model_per_day: z.number().int().nonnegative().default(30),
    model_per_card_per_day: z.number().int().nonnegative().default(8),
    research_per_day: z.number().int().nonnegative().default(10),
    static_per_day: z.number().int().nonnegative().default(100),
  }).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

function isFormatterZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ProfileMetaSchema = z.object({ active: z.boolean().default(false) });
export type ProfileMeta = z.infer<typeof ProfileMetaSchema>;

const NOTE_SEPARATOR = ' — ';

/** One checklist item, `pattern — note`. Patterns are matched case-insensitively, like the samjobs filters. */
export const FilterItemSchema = z.string().transform((item, ctx) => {
  const at = item.indexOf(NOTE_SEPARATOR);
  const pattern = (at < 0 ? item : item.slice(0, at)).trim();
  const note = at < 0 ? '' : item.slice(at + NOTE_SEPARATOR.length).trim();
  if (!pattern) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `empty pattern in filter item ${JSON.stringify(item)}` });
    return z.NEVER;
  }
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid pattern ${JSON.stringify(pattern)}: ${String(e)}` });
    return z.NEVER;
  }
  return note ? { pattern, note } : { pattern };
});
export type FilterItem = z.infer<typeof FilterItemSchema>;

export const ProfileSchema = z.object({
  name: z.string().min(1),
  active: z.boolean(),
  rubric: z.string(),
  searchKeywords: z.array(z.string().min(1)),
  filters: z.object({
    includeTitles: z.array(FilterItemSchema),
    excludeTitles: z.array(FilterItemSchema),
    excludeCompanies: z.array(FilterItemSchema),
    excludeText: z.array(FilterItemSchema),
  }),
  cv: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const LevelSchema = z.string();
const PenaltySchema = z.object({ points: z.number(), cap: z.number().optional() });

export const PreferencesSchema: z.ZodType<Preferences> = z.object({
  languages: z.object({
    de: z.object({ read: LevelSchema.optional(), write: LevelSchema.optional(), speak: LevelSchema.optional() }).optional(),
  }).optional(),
  years_experience: z.number().nonnegative().optional(),
  penalties: z.object({
    german_c1_or_native: PenaltySchema.optional(),
    german_b2_or_spoken_heavy: PenaltySchema.optional(),
    german_working_language_with_english: PenaltySchema.optional(),
    years_over: PenaltySchema.extend({ tolerance: z.number().optional(), max: z.number().optional() }).optional(),
    degree_field_mismatch: PenaltySchema.extend({ fields_ok: z.array(z.string()).optional() }).optional(),
    driving_licence: PenaltySchema.optional(),
    unpaid_internship: PenaltySchema.optional(),
    named_methodology_required: PenaltySchema.optional(),
  }).optional(),
});

export const UserConfigSchema = z.object({
  settings: SettingsSchema,
  profiles: z.array(ProfileSchema)
    .refine((ps) => ps.some((p) => p.active), { message: 'at least one profile must be active' }),
  sharedCv: z.string(),
  // The masking list; with nothing in it, masking has nothing to remove, so the user is not run.
  personalDetails: z.array(z.string().min(1)).min(1),
  preferences: PreferencesSchema.optional(),
  sources: z.object({ add: z.array(z.string()), drop: z.array(z.string()) }),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

const YAML_BLOCK = /```yaml[ \t]*\r?\n([\s\S]*?)```/;

export function parseYamlBlock(desc: string): unknown {
  const m = YAML_BLOCK.exec(desc);
  if (!m) throw new ConfigError('no ```yaml block in the card description');
  try {
    return load(m[1]!);
  } catch (e) {
    throw new ConfigError(`invalid YAML in the card description: ${String(e)}`);
  }
}
