import test from 'node:test';
import assert from 'node:assert/strict';
import type { Facts } from '../../src/pipeline/facts.ts';
import { applyPenalties } from '../../src/pipeline/prefs.ts';
import type { Preferences } from '../../src/pipeline/prefs.ts';

// A made-up candidate: reads German at B2, writes B1, speaks A2, one year of experience.
const alex: Preferences = { languages: { de: { read: 'B2', write: 'B1', speak: 'A2' } }, years_experience: 1,
  penalties: { german_c1_or_native: { points: 4, cap: 4 }, german_b2_or_spoken_heavy: { points: 2 }, german_working_language_with_english: { points: 1 },
    years_over: { points: 1, tolerance: 1, max: 2 }, degree_field_mismatch: { points: 1, fields_ok: ['humanities', 'literature'] },
    driving_licence: { points: 1 }, unpaid_internship: { points: 2 }, named_methodology_required: { points: 1 } } };

type FactsIn = Parameters<typeof applyPenalties>[0];
const f = (o: Partial<Facts> = {}): FactsIn => ({ german: { level: null, spoken_heavy: null, evidence: null }, english_working_language: null,
  years: { min: null, max: null, evidence: null }, degree_field: null, driving_licence: null, unpaid_internship: null, methodology: [], ...o });
const de = (level: string | null, spoken_heavy: boolean | null = null): Facts['german'] => ({ level, spoken_heavy, evidence: 'quote' });
const yrs = (min: number): Facts['years'] => ({ min, max: null, evidence: 'quote' });

const cases: [string, FactsIn, number, number | null, string[]][] = [
  ['no German mentioned', f(), 0, null, []],
  ['German not needed', f({ german: de('none') }), 0, null, []],
  ['C1 required → -4 and cap 4', f({ german: de('c1', false) }), 4, 4, ['german-c1']],
  ['native required', f({ german: de('native') }), 4, 4, ['german-c1']],
  ['B2 required, speaks A2 → -2', f({ german: de('b2') }), 2, null, ['german-c1']],
  ['B1 but spoken-heavy → -2', f({ german: de('b1', true) }), 2, null, ['german-c1']],
  ['B1 written, English also used → -1', f({ german: de('b1', false), english_working_language: true }), 1, null, []],
  ['B1 written, no English → 0', f({ german: de('b1', false) }), 0, null, []],
  ['rules do not stack: C1 + spoken-heavy + licence', f({ german: de('c1', true), driving_licence: true }), 5, 4, ['german-c1', 'driving licence']],
  ['3 years asked → -1', f({ years: yrs(3) }), 1, null, ['3+ years']],
  ['5 years → -2 (max)', f({ years: yrs(5) }), 2, null, ['3+ years']],
  ['2 years asked is fine', f({ years: yrs(2) }), 0, null, []],
  ['engineering degree', f({ degree_field: 'engineering' }), 1, null, ['degree-field']],
  ['humanities degree ok', f({ degree_field: 'humanities' }), 0, null, []],
  ['unpaid internship + PRINCE2', f({ unpaid_internship: true, methodology: ['PRINCE2'] }), 3, null, ['unpaid internship']],
];
for (const [name, facts, total, cap, flags] of cases) {
  test(`applyPenalties: ${name}`, () => {
    const r = applyPenalties(facts, alex);
    assert.equal(r.total, total); assert.equal(r.cap, cap); assert.deepEqual([...r.flags].sort(), [...flags].sort());
    assert.equal(Object.values(r.parts).reduce((a, b) => a + b, 0), total);
  });
}

test('no facts or no preferences → no penalties, no crash', () => {
  assert.deepEqual(applyPenalties(null, alex), { total: 0, cap: null, parts: {}, flags: [] });
  assert.equal(applyPenalties(f({ german: de('c1') }), {}).total, 0);
});

test('better speaking: B2 required and speak B2 → 0', () => {
  const p: Preferences = { ...alex, languages: { de: { read: 'B2', write: 'B2', speak: 'B2' } } };
  assert.equal(applyPenalties(f({ german: de('b2', false) }), p).total, 0);
});

test('unknown speaking ability costs nothing', () => {
  const p: Preferences = { ...alex, languages: { de: { read: 'B2', write: 'B2' } } };
  assert.equal(applyPenalties(f({ german: de('b2', true) }), p).total, 0);
});
