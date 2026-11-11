import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeProfiles, combinedFilter, scoringProfile } from '../../src/run/profiles.ts';
import type { Profile, Settings, UserConfig } from '../../src/config/schema.ts';
import type { Job } from '../../src/pipeline/keys.ts';

const settings: Settings = {
  timezone: 'Europe/Berlin', providers: ['gemini'], scoring_cap: 150, locations: ['berlin'], linkedin_locations: [],
  linkedin: false, allowed_members: [],
  caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
};

function profile(name: string, o: Partial<Profile> = {}, f: Partial<Profile['filters']> = {}): Profile {
  return {
    name, active: true, rubric: `rubric of ${name}`, searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [], ...f },
    ...o,
  };
}

const config = (profiles: Profile[]): UserConfig => ({
  settings, profiles, sharedCv: 'shared cv', personalDetails: ['Robin Testperson'], sources: { add: [], drop: [] },
});

const job = (title: string): Job => ({ key: `url:${title}`, url: 'https://jobs.example/1', company: 'Acme', title, location: 'Berlin' });

describe('activeProfiles', () => {
  it('keeps only active profiles', () => {
    const cfg = config([profile('Events'), profile('Office', { active: false })]);
    assert.deepEqual(activeProfiles(cfg).map((p) => p.name), ['Events']);
  });
});

describe('combinedFilter', () => {
  const events = profile('Events', {}, { includeTitles: [{ pattern: 'event' }] });
  const office = profile('Office', {}, { includeTitles: [{ pattern: 'office' }] });

  it('keeps a job one of two profiles accepts', () => {
    const f = combinedFilter([events, office], settings);
    assert.equal(f(job('Office Manager')), null);
    assert.equal(f(job('Event Manager')), null);
  });

  it("returns the first profile's reason when all reject", () => {
    const f = combinedFilter([events, office], settings);
    assert.equal(f(job('Accountant')), 'NOT_INCLUDED: "Accountant"');
    const g = combinedFilter([profile('A', {}, { excludeTitles: [{ pattern: 'senior' }] }), office], settings);
    assert.match(g(job('Senior Accountant'))!, /^EXCLUDE_TITLE:/);
  });
});

describe('scoringProfile', () => {
  it('one profile → its rubric and CV', () => {
    assert.deepEqual(scoringProfile(config([profile('Events', { cv: 'events cv' })])), { rubric: 'rubric of Events', cv: 'events cv' });
    assert.deepEqual(scoringProfile(config([profile('Events')])), { rubric: 'rubric of Events', cv: undefined });
  });

  it('two profiles → both headed rubrics', () => {
    const r = scoringProfile(config([profile('Events'), profile('Office'), profile('Off', { active: false })]));
    assert.equal(r.rubric, '## Events\n\nrubric of Events\n\n## Office\n\nrubric of Office');
    assert.equal(r.cv, undefined);
    assert.equal(r.warning, undefined);
  });

  it('two profiles with the same CV card → that CV', () => {
    const r = scoringProfile(config([profile('Events', { cv: 'one cv' }), profile('Office', { cv: 'one cv' })]));
    assert.equal(r.cv, 'one cv');
    assert.equal(r.warning, undefined);
  });

  it('different CV cards → shared CV and the warning', () => {
    for (const cvs of [['a', 'b'], ['a', undefined]]) {
      const r = scoringProfile(config([profile('Events', { cv: cvs[0] }), profile('Office', { cv: cvs[1] })]));
      assert.equal(r.cv, undefined);
      assert.equal(r.warning, 'active profiles have different CV cards; scoring uses the Shared CV');
    }
  });
});
