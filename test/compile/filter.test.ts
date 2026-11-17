import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledFilter, isRemote, normEmployment, RULE_TEXT } from '../../src/compile/filter.ts';
import type { Compiled, CompiledProfile } from '../../src/compile/schema.ts';
import type { Job } from '../../src/pipeline/keys.ts';

const BASE_PROFILE: CompiledProfile = {
  name: 'Editor',
  search_terms: ['content editor'],
  title_include: ['editor', 'redakteur'],
  title_exclude: ['senior'],
  examples: [],
};

const BASE: Compiled = {
  places: { anywhere: false, keep: ['Germany', 'Deutschland', 'Berlin', 'Remote (EU)'], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [],
  text_exclude: [],
  languages: {},
  years_experience: null,
  profiles: [BASE_PROFILE],
  unused: [],
  problems: [],
};

function compiled(overrides: {
  places?: Partial<Compiled['places']>;
  employment?: Partial<Compiled['employment']>;
  company_exclude?: string[];
  text_exclude?: string[];
  profiles?: CompiledProfile[];
} = {}): Compiled {
  return {
    ...BASE,
    ...overrides,
    places: { ...BASE.places, ...(overrides.places ?? {}) },
    employment: { ...BASE.employment, ...(overrides.employment ?? {}) },
    profiles: overrides.profiles ?? BASE.profiles,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return { key: 'test:1', url: 'https://example.com/1', company: 'Acme GmbH', title: 'Content Editor', ...overrides };
}

const filter = (c: Compiled) => compiledFilter(c, ['Editor']);

test('passes: Content Editor in Berlin', () => {
  assert.equal(filter(compiled())(job({ location: 'Berlin, Germany' })), null);
});

test('passes: Content Editor location absent', () => {
  assert.equal(filter(compiled())(job({})), null);
});

test('PLACE_NOT_KEPT: Zürich, Switzerland', () => {
  assert.equal(filter(compiled())(job({ location: 'Zürich, Switzerland' })), 'PLACE_NOT_KEPT: "Zürich, Switzerland"');
});

test('PLACE_DROPPED: Munich, Germany', () => {
  const c = compiled({ places: { drop: ['Munich'] } });
  assert.equal(filter(c)(job({ location: 'Munich, Germany' })), 'PLACE_DROPPED: "Munich, Germany"');
});

test('passes: Chefredakteur in Berlin', () => {
  assert.equal(filter(compiled())(job({ title: 'Chefredakteur', location: 'Berlin, Germany' })), null);
});

test('TITLE_EXCLUDED: Senior Editor', () => {
  assert.equal(filter(compiled())(job({ title: 'Senior Editor', location: 'Berlin, Germany' })), 'TITLE_EXCLUDED: "Senior"');
});

test('TITLE_NOT_INCLUDED: Sales Manager in Berlin', () => {
  assert.equal(filter(compiled())(job({ title: 'Sales Manager', location: 'Berlin, Germany' })), 'TITLE_NOT_INCLUDED: "Sales Manager"');
});

test('COMPANY_EXCLUDED: Example Staffing GmbH', () => {
  const c = compiled({ company_exclude: ['Example Staffing'] });
  assert.equal(filter(c)(job({ company: 'Example Staffing GmbH' })), 'COMPANY_EXCLUDED: "Example Staffing"');
});

test('TEXT_EXCLUDED: unpaid in jd', () => {
  const c = compiled({ text_exclude: ['unpaid'] });
  assert.equal(filter(c)(job({ jd: 'This is an unpaid role' })), 'TEXT_EXCLUDED: "unpaid"');
});

test('REMOTE_NEEDS: Remote (EU), PART_TIME', () => {
  const c = compiled({ employment: { remote_only: ['full_time'] } });
  assert.equal(filter(c)(job({ location: 'Remote (EU)', employment_type: 'PART_TIME' })), 'REMOTE_NEEDS: "part_time"');
});

test('passes: Remote (EU), employment_type absent', () => {
  const c = compiled({ employment: { remote_only: ['full_time'] } });
  assert.equal(filter(c)(job({ location: 'Remote (EU)' })), null);
});

test('passes: Berlin, PART_TIME, remote_only full_time', () => {
  const c = compiled({ employment: { remote_only: ['full_time'] } });
  assert.equal(filter(c)(job({ location: 'Berlin', employment_type: 'PART_TIME' })), null);
});

test('EMPLOYMENT: Teilzeit', () => {
  const c = compiled({ employment: { keep: ['full_time'] } });
  assert.equal(filter(c)(job({ employment_type: 'Teilzeit' })), 'EMPLOYMENT: "part_time"');
});

test('passes: C++ Developer with title_include [C++]', () => {
  const c = compiled({ profiles: [{ ...BASE_PROFILE, title_include: ['C++'] }] });
  assert.equal(filter(c)(job({ title: 'C++ Developer', location: 'Berlin' })), null);
});

test('passes: Sales Manager when second profile includes sales', () => {
  const c = compiled({
    profiles: [
      BASE_PROFILE,
      { name: 'Sales', search_terms: ['sales'], title_include: ['sales'], title_exclude: [], examples: [] },
    ],
  });
  const f = compiledFilter(c, ['Editor', 'Sales']);
  assert.equal(f(job({ title: 'Sales Manager', location: 'Berlin' })), null);
});

test('passes: anywhere true, Tokyo', () => {
  const c = compiled({ places: { anywhere: true } });
  assert.equal(filter(c)(job({ location: 'Tokyo' })), null);
});

// isRemote
test('isRemote: Remote (EU) is remote', () => {
  assert.equal(isRemote('Remote (EU)'), true);
});

test('isRemote: Berlin is not remote', () => {
  assert.equal(isRemote('Berlin'), false);
});

// normEmployment
test('normEmployment: FULL_TIME → full_time', () => {
  assert.equal(normEmployment('FULL_TIME'), 'full_time');
});

test('normEmployment: PART_TIME → part_time', () => {
  assert.equal(normEmployment('PART_TIME'), 'part_time');
});

test('normEmployment: Teilzeit → part_time', () => {
  assert.equal(normEmployment('Teilzeit'), 'part_time');
});

test('normEmployment: undefined → null', () => {
  assert.equal(normEmployment(undefined), null);
});

test('normEmployment: unknown string → null', () => {
  assert.equal(normEmployment('something_else'), null);
});

// RULE_TEXT
test('RULE_TEXT: PLACE_NOT_KEPT is exactly correct', () => {
  assert.equal(RULE_TEXT['PLACE_NOT_KEPT'], 'location not in your places');
});
