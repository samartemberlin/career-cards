import test from 'node:test';
import assert from 'node:assert/strict';
import { CompiledSchema, unusable, DEFAULT_PENALTIES, preferencesOf } from '../../src/compile/schema.ts';
import type { Compiled } from '../../src/compile/schema.ts';

const VALID: Compiled = {
  places: { anywhere: false, keep: ['Germany'], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [],
  text_exclude: [],
  languages: {},
  years_experience: null,
  profiles: [{
    name: 'Editor',
    search_terms: ['editor'],
    title_include: ['editor'],
    title_exclude: [],
    examples: [
      { role: 'Content Editor at a news outlet', score: 8 },
      { role: 'Copy Editor at a magazine', score: 7 },
      { role: 'Editorial Coordinator', score: 5 },
    ],
  }],
  unused: [],
  problems: [],
};

test('CompiledSchema: valid object parses', () => {
  assert.equal(CompiledSchema.safeParse(VALID).success, true);
});

test('CompiledSchema: extra key at top level fails', () => {
  assert.equal(CompiledSchema.safeParse({ ...VALID, extra: true }).success, false);
});

test('CompiledSchema: extra key inside places fails', () => {
  assert.equal(CompiledSchema.safeParse({ ...VALID, places: { ...VALID.places, extra: true } }).success, false);
});

test('CompiledSchema: phrase of 81 characters fails', () => {
  const longPhrase = 'a'.repeat(81);
  assert.equal(CompiledSchema.safeParse({ ...VALID, company_exclude: [longPhrase] }).success, false);
});

test('unusable: good object returns empty array', () => {
  assert.deepEqual(unusable(VALID, ['Editor']), []);
});

test('unusable: c.problems is not passed through (model problems are warnings, not blockers)', () => {
  const c: Compiled = { ...VALID, problems: [{ card: 'Some card', reason: 'bad input' }] };
  const result = unusable(c, []);
  assert.deepEqual(result, []);
});

test('unusable: places anywhere false + empty keep', () => {
  const c: Compiled = { ...VALID, places: { anywhere: false, keep: [], drop: [] } };
  const result = unusable(c, []);
  assert.ok(result.some(r => r.card === 'Where & how I work' && r.reason === 'no place to keep jobs in'));
});

test('unusable: profile missing from c.profiles', () => {
  const result = unusable(VALID, ['Nonexistent']);
  assert.ok(result.some(r => r.card.startsWith('Nonexistent') && r.card.includes("Role names I'd take")));
});

test('unusable: profile with no search_terms', () => {
  const c: Compiled = { ...VALID, profiles: [{ ...VALID.profiles[0]!, search_terms: [] }] };
  const result = unusable(c, ['Editor']);
  assert.ok(result.some(r => r.card === "Editor › Role names I'd take" && r.reason === 'no search terms'));
});

test('unusable: profile with no title_include', () => {
  const c: Compiled = { ...VALID, profiles: [{ ...VALID.profiles[0]!, title_include: [] }] };
  const result = unusable(c, ['Editor']);
  assert.ok(result.some(r => r.card === "Editor › Role names I'd take" && r.reason === 'no title filters'));
});

test('unusable: profile with fewer than 3 examples', () => {
  const c: Compiled = { ...VALID, profiles: [{ ...VALID.profiles[0]!, examples: [{ role: 'Editor', score: 5 }] }] };
  const result = unusable(c, ['Editor']);
  assert.ok(result.some(r => r.card === 'Editor › My dream job' && r.reason === 'fewer than 3 examples'));
});

test('DEFAULT_PENALTIES has correct values', () => {
  assert.equal(DEFAULT_PENALTIES.german_c1_or_native!.points, 3);
  assert.equal(DEFAULT_PENALTIES.german_b2_or_spoken_heavy!.points, 2);
  assert.equal(DEFAULT_PENALTIES.years_over!.points, 1);
  assert.equal(DEFAULT_PENALTIES.years_over!.tolerance, 1);
  assert.equal(DEFAULT_PENALTIES.years_over!.max, 3);
});

test('preferencesOf: returns languages, years_experience and default penalties', () => {
  const c: Compiled = {
    ...VALID,
    languages: { de: { read: 'B2', write: 'B1', speak: 'A2' } },
    years_experience: 5,
  };
  const prefs = preferencesOf(c);
  assert.deepEqual(prefs.languages?.de, { read: 'B2', write: 'B1', speak: 'A2' });
  assert.equal(prefs.years_experience, 5);
  assert.deepEqual(prefs.penalties, DEFAULT_PENALTIES);
});

test('preferencesOf: omits languages and years_experience when absent', () => {
  const prefs = preferencesOf(VALID);
  assert.equal(prefs.languages, undefined);
  assert.equal(prefs.years_experience, undefined);
});

test('CompiledSchema: languages with two two-letter codes (en + de) parses', () => {
  const c = { ...VALID, languages: { en: { read: 'C1', write: 'C1', speak: 'C1' }, de: { read: 'B2', write: 'B1', speak: 'B1' } } };
  assert.equal(CompiledSchema.safeParse(c).success, true);
});

test('CompiledSchema: languages rejects a word-length key ("english")', () => {
  const c = { ...VALID, languages: { english: { read: 'C1' } } };
  assert.equal(CompiledSchema.safeParse(c).success, false);
});

test('CompiledSchema: languages rejects more than 6 entries', () => {
  const langs = Object.fromEntries(['de', 'en', 'fr', 'es', 'it', 'nl', 'pl'].map((k) => [k, { read: 'B1' }]));
  assert.equal(CompiledSchema.safeParse({ ...VALID, languages: langs }).success, false);
});

test('preferencesOf: en + de languages → de is used for preferences, en is not', () => {
  const c = { ...VALID, languages: { en: { read: 'C1', write: 'C1', speak: 'C1' }, de: { read: 'B2', write: 'B1', speak: 'A2' } } } as unknown as Compiled;
  const prefs = preferencesOf(c);
  assert.deepEqual(prefs.languages?.de, { read: 'B2', write: 'B1', speak: 'A2' });
  assert.ok(!prefs.languages || !('en' in prefs.languages), 'en must not be in preferences');
});
