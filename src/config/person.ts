// What one profile means to the pipeline: its filter and its share of the shared search.
import rulesDefault from '../../config/defaults/rules-default.json' with { type: 'json' };
import { compileRules } from '../pipeline/filter.ts';
import type { PersonFilter, Rule } from '../pipeline/filter.ts';
import type { FilterItem, Profile, Settings } from './schema.ts';

const DEFAULT_RULES = rulesDefault.rules as Rule[];

const regexes = (items: FilterItem[]): RegExp[] => items.map((i) => new RegExp(i.pattern, 'i'));

/**
 * Order matches samjobs: exclusions, then the default location rules, then Exclude text (prose last), then
 * Exclude titles, Exclude locations, Include titles. `settings` is taken so that callers need not change once
 * Settings.locations selects rules; today the location rules are rules-default.json for everybody.
 */
export function personFilterFromProfile(profile: Profile, _settings: Settings): PersonFilter {
  const { filters } = profile;
  const textRules: Rule[] = filters.excludeText.map((i) => ({
    id: 'EXCLUDE_TEXT', pattern: i.pattern, action: 'reject', where: 'text', ...(i.note ? { note: i.note } : {}),
  }));
  return {
    rules: compileRules([...DEFAULT_RULES, ...textRules]),
    include: regexes(filters.includeTitles),
    exclude: regexes(filters.excludeTitles),
    locationExclude: regexes(filters.excludeLocations),
    exclusions: filters.excludeCompanies,
  };
}

export type ProfileSearch = {
  board_keywords: string[];
  linkedin: { location: string; remote?: boolean; queries: string[] }[];
};

/** One profile's part of the shared search, in the shape mergePortals and mergeLinkedin read. */
export function searchFromProfile(profile: Profile, settings: Settings): ProfileSearch {
  return {
    board_keywords: [...profile.searchKeywords],
    linkedin: settings.linkedin_locations.map((l) => ({ ...l, queries: [...profile.searchKeywords] })),
  };
}
