// User config read from Trello: the System board's Settings and Sources cards, and the free-text Profiles board.
import { z } from 'zod';
import { load } from 'js-yaml';
import type { ProfilesBoard } from '../trello/profiles-board.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const BOT_KEYWORD = '/bot';
export const isBotKeyword = (s: string): boolean => s.length >= 2 && s.length <= 20 && /^\/[A-Za-z][\w-]*$/.test(s);

export const SettingsSchema = z.object({
  timezone: z.string().default('Europe/Berlin')
    // Intl's list leaves out names its own formatter accepts, such as UTC.
    .refine((tz) => TIMEZONES.has(tz) || isFormatterZone(tz), (tz) => ({ message: `unknown timezone ${JSON.stringify(tz)}` })),
  providers: z.array(z.string().min(1)).min(1),
  models: z.record(z.string(), z.string()).optional(),
  scoring_cap: z.number().int().positive().default(150),
  labels: z.array(z.object({ name: z.string().min(1), color: z.string().min(1) }).strict()).optional(),
  linkedin: z.boolean().default(false),
  allowed_members: z.array(z.string().min(1)).default([]),
  // Falls back instead of failing: one bad word here would otherwise stop the bot from answering at all.
  bot_keyword: z.string().refine(isBotKeyword).catch(BOT_KEYWORD),
  caps: z.object({
    model_per_day: z.number().int().nonnegative().default(30),
    model_per_card_per_day: z.number().int().nonnegative().default(8),
    research_per_day: z.number().int().nonnegative().default(10),
    static_per_day: z.number().int().nonnegative().default(100),
  }).strict().default({}),
}).strict();
export type Settings = z.infer<typeof SettingsSchema>;

function isFormatterZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const NOTE_SEPARATOR = ' — ';

function splitNote(item: string): [string, string] {
  const at = item.indexOf(NOTE_SEPARATOR);
  return at < 0 ? [item.trim(), ''] : [item.slice(0, at).trim(), item.slice(at + NOTE_SEPARATOR.length).trim()];
}

/** `Name — careers_url`, the shape career-ops' tracked_companies takes. */
export const CompanySourceSchema = z.string().transform((item, ctx) => {
  const [name, url] = splitNote(item);
  if (!name || !/^https?:\/\/\S+$/.test(url)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected "Name — careers_url" with an http(s) careers_url, got ${JSON.stringify(item)}` });
    return z.NEVER;
  }
  return { name, careers_url: url };
});

export const SourcesSchema = z.object({ add: z.array(CompanySourceSchema), drop: z.array(z.string().min(1)) });
export type Sources = z.infer<typeof SourcesSchema>;

export type UserConfig = { settings: Settings; sources: Sources; board: ProfilesBoard; sharedCv: string; personalDetails: string[] };

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
