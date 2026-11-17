import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, SettingsSchema, parseYamlBlock } from '../../src/config/schema.ts';

const settingsIn = { providers: ['gemini'] };

test('settings defaults', () => {
  const s = SettingsSchema.parse(settingsIn);
  assert.equal(s.scoring_cap, 150);
  assert.equal(s.timezone, 'Europe/Berlin');
  assert.equal(s.linkedin, false);
  assert.deepEqual(s.allowed_members, []);
  assert.deepEqual(s.caps, { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 });
});

test('settings: bot_keyword defaults to /bot; an invalid one falls back to it', () => {
  assert.equal(SettingsSchema.parse(settingsIn).bot_keyword, '/bot');
  for (const ok of ['/jobs', '/my-bot_2', '/a', `/${'a'.repeat(19)}`]) assert.equal(SettingsSchema.parse({ ...settingsIn, bot_keyword: ok }).bot_keyword, ok);
  for (const bad of ['bot keyword', '', '/' + 'a'.repeat(29), `/${'a'.repeat(20)}`, '/1x', '/', 'ok', 'jobs', 'is', '@bot', '/bot.de', '//bot', 5, null]) {
    assert.equal(SettingsSchema.parse({ ...settingsIn, bot_keyword: bad }).bot_keyword, '/bot', JSON.stringify(bad));
  }
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

test('settings: locations and linkedin_locations are gone; the Profiles cards say where', () => {
  for (const key of ['locations', 'linkedin_locations']) {
    const r = SettingsSchema.safeParse({ ...settingsIn, [key]: [] });
    assert.equal(r.success, false, key);
    assert.match(r.error!.message, new RegExp(`'${key}'`));
  }
});

test('parseYamlBlock reads the first yaml fence', () => {
  const desc = 'Settings for the bot.\n\n```yaml\nproviders: [gemini]\nlocations: [Berlin]\n```\n\n```yaml\nignored: true\n```';
  assert.deepEqual(parseYamlBlock(desc), { providers: ['gemini'], locations: ['Berlin'] });
});

test('parseYamlBlock throws ConfigError without a yaml block or on bad yaml', () => {
  assert.throws(() => parseYamlBlock('no block here'), ConfigError);
  assert.throws(() => parseYamlBlock('```yaml\na: [1\n```'), ConfigError);
});

test('unknown keys fail and the message names the key', () => {
  const settings = SettingsSchema.safeParse({ ...settingsIn, allowed_member: ['alex'] });
  assert.equal(settings.success, false);
  assert.match(settings.error!.message, /allowed_member/);
  assert.match(SettingsSchema.safeParse({ ...settingsIn, scoring_cpa: 10 }).error!.message, /scoring_cpa/);
  assert.match(SettingsSchema.safeParse({ ...settingsIn, caps: { model_per_dya: 5 } }).error!.message, /model_per_dya/);
});
