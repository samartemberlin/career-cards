import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigError, FilterItemSchema, PreferencesSchema, ProfileMetaSchema, ProfileSchema, SettingsSchema, UserConfigSchema, parseYamlBlock,
} from '../../src/config/schema.ts';

const settingsIn = { providers: ['gemini'], locations: ['Berlin'] };

test('settings defaults', () => {
  const s = SettingsSchema.parse(settingsIn);
  assert.equal(s.scoring_cap, 150);
  assert.equal(s.timezone, 'Europe/Berlin');
  assert.equal(s.linkedin, false);
  assert.deepEqual(s.allowed_members, []);
  assert.deepEqual(s.caps, { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 });
});

test('settings: one cap overridden keeps the other defaults', () => {
  const s = SettingsSchema.parse({ ...settingsIn, caps: { model_per_day: 5 } });
  assert.deepEqual(s.caps, { model_per_day: 5, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 });
});

test('settings need at least one provider', () => {
  assert.throws(() => SettingsSchema.parse({ ...settingsIn, providers: [] }));
});

test('unknown timezone rejected', () => {
  assert.throws(() => SettingsSchema.parse({ ...settingsIn, timezone: 'Europe/Atlantis' }), /timezone/i);
  assert.equal(SettingsSchema.parse({ ...settingsIn, timezone: 'America/New_York' }).timezone, 'America/New_York');
  assert.equal(SettingsSchema.parse({ ...settingsIn, timezone: 'UTC' }).timezone, 'UTC');
});

test('filter item parses pattern and note', () => {
  assert.deepEqual(FilterItemSchema.parse('senior|lead — too senior'), { pattern: 'senior|lead', note: 'too senior' });
  assert.deepEqual(FilterItemSchema.parse('  werkstudent  '), { pattern: 'werkstudent' });
});

test('filter item with invalid regex is rejected with the pattern in the message', () => {
  const r = FilterItemSchema.safeParse('manager(  — broken');
  assert.equal(r.success, false);
  assert.match(r.error!.message, /manager\(/);
});

test('missing active means false', () => {
  assert.deepEqual(ProfileMetaSchema.parse({}), { active: false });
  assert.deepEqual(ProfileMetaSchema.parse({ active: true }), { active: true });
});

const profile = (active: boolean) => ({
  name: 'Content', active, rubric: '# rubric', searchKeywords: ['editor'],
  filters: { includeTitles: ['editor'], excludeTitles: ['senior — too senior'], excludeCompanies: [], excludeText: [] },
});

const userIn = (over: Record<string, unknown> = {}) => ({
  settings: settingsIn, profiles: [profile(true), profile(false)], sharedCv: '# CV', personalDetails: ['Alex Example'],
  sources: { add: [], drop: [] }, ...over,
});

test('user config needs one active profile and one personal detail', () => {
  assert.ok(UserConfigSchema.parse(userIn()));
  assert.throws(() => UserConfigSchema.parse(userIn({ profiles: [profile(false)] })), /active/);
  assert.throws(() => UserConfigSchema.parse(userIn({ personalDetails: [] })));
});

test('profile filters compile', () => {
  const p = ProfileSchema.parse(profile(true));
  assert.deepEqual(p.filters.excludeTitles, [{ pattern: 'senior', note: 'too senior' }]);
});

test('preferences: the preferences.yml shape parses', () => {
  const prefs = { languages: { de: { read: 'B2', speak: 'A2' } }, years_experience: 1,
    penalties: { german_c1_or_native: { points: 4, cap: 4 }, years_over: { points: 1, tolerance: 1, max: 2 },
      degree_field_mismatch: { points: 1, fields_ok: ['humanities'] } } };
  assert.deepEqual(PreferencesSchema.parse(prefs), prefs);
  assert.throws(() => PreferencesSchema.parse({ penalties: { driving_licence: { points: 'two' } } }));
  assert.ok(UserConfigSchema.parse(userIn({ preferences: prefs })).preferences);
});

test('parseYamlBlock reads the first yaml fence', () => {
  const desc = 'Settings for the bot.\n\n```yaml\nproviders: [gemini]\nlocations: [Berlin]\n```\n\n```yaml\nignored: true\n```';
  assert.deepEqual(parseYamlBlock(desc), { providers: ['gemini'], locations: ['Berlin'] });
});

test('parseYamlBlock throws ConfigError without a yaml block or on bad yaml', () => {
  assert.throws(() => parseYamlBlock('no block here'), ConfigError);
  assert.throws(() => parseYamlBlock('```yaml\na: [1\n```'), ConfigError);
});
