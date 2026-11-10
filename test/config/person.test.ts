import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileSchema, SettingsSchema, SourcesSchema } from '../../src/config/schema.ts';
import { personFilterFromProfile, searchFromProfile } from '../../src/config/person.ts';
import { filterJob } from '../../src/pipeline/filter.ts';
import { mergeLinkedin, mergePortals } from '../../src/pipeline/search.ts';
import type { Job } from '../../src/pipeline/keys.ts';

const settings = SettingsSchema.parse({
  providers: ['gemini'], locations: ['berlin', 'remote-de'],
  linkedin_locations: [{ location: 'Berlin, Germany' }, { location: 'Germany', remote: true }],
});

const profileIn = {
  name: 'Content', active: true, rubric: '# rubric', searchKeywords: ['editor', 'content manager'],
  filters: {
    includeTitles: ['editor|content'],
    excludeTitles: ['senior — too senior'],
    excludeCompanies: ['Acme.* GmbH — said no', 'Globex'],
    excludeText: ['unpaid — no pay'],
    excludeLocations: ['munich|münchen'],
  },
};
const profile = ProfileSchema.parse(profileIn);

const post = (o: Partial<Job> = {}): Job =>
  ({ key: 'k', url: 'https://example.com/1', company: 'Initech', title: 'Content Editor', location: 'Berlin', jd: 'Paid role.', ...o });

test('excludeCompanies items are exact names with an optional reason, not regexes', () => {
  assert.deepEqual(profile.filters.excludeCompanies, [{ company: 'Acme.* GmbH', reason: 'said no' }, { company: 'Globex' }]);
  assert.ok(ProfileSchema.parse({ ...profileIn, filters: { ...profileIn.filters, excludeCompanies: ['Broken( Ltd'] } }));
});

test('personFilterFromProfile maps each checklist to its filter, with the default location rules first', () => {
  const f = personFilterFromProfile(profile, settings);
  assert.equal(filterJob(post(), f), null);
  assert.match(filterJob(post({ location: 'New York, United States' }), f)!, /^HARD_LOCATION_NONEU/);
  assert.match(filterJob(post({ company: 'globex' }), f)!, /^EXCL_MANUAL: "on the exclusions list"/);
  assert.match(filterJob(post({ company: 'Acme.* GmbH' }), f)!, /^EXCL_MANUAL: "said no"/);
  assert.equal(filterJob(post({ company: 'Acme Berlin GmbH' }), f), null);
  assert.match(filterJob(post({ jd: 'This is an unpaid role.' }), f)!, /^EXCLUDE_TEXT: "unpaid"/);
  assert.match(filterJob(post({ title: 'Senior Content Editor' }), f)!, /^EXCLUDE_TITLE: "Senior"/);
  assert.match(filterJob(post({ location: 'München, Germany' }), f)!, /^EXCLUDE_LOCATION: "München"/);
  assert.match(filterJob(post({ title: 'Accountant' }), f)!, /^NOT_INCLUDED/);
});

test('searchFromProfile: the search keywords are both the board keywords and the LinkedIn queries per Settings location', () => {
  const s = searchFromProfile(profile, settings);
  assert.deepEqual(s, {
    board_keywords: ['editor', 'content manager'],
    linkedin: [
      { location: 'Berlin, Germany', queries: ['editor', 'content manager'] },
      { location: 'Germany', remote: true, queries: ['editor', 'content manager'] },
    ],
  });
  assert.deepEqual(mergeLinkedin({}, [s]).searches?.map((g) => g.location), ['Berlin, Germany', 'Germany']);
  const base = { job_boards: [{ provider: 'arbeitsagentur' }] };
  assert.deepEqual((mergePortals(base, [s]).job_boards as { arbeitsagentur: { keywords: string[] } }[])[0]!.arbeitsagentur.keywords,
    ['editor', 'content manager']);
});

test('linkedin_locations defaults to none and rejects unknown keys', () => {
  assert.deepEqual(SettingsSchema.parse({ providers: ['gemini'], locations: [] }).linkedin_locations, []);
  assert.throws(() => SettingsSchema.parse({ providers: ['gemini'], locations: [], linkedin_locations: [{ location: 'X', remot: true }] }), /remot/);
});

test('Sources: added companies are "Name — careers_url", dropped ones are names', () => {
  const s = SourcesSchema.parse({ add: ['Initech — https://jobs.ashbyhq.com/initech'], drop: ['Globex'] });
  assert.deepEqual(s, { add: [{ name: 'Initech', careers_url: 'https://jobs.ashbyhq.com/initech' }], drop: ['Globex'] });
  assert.deepEqual(mergePortals({ tracked_companies: [] }, [{ companies: s.add }]).tracked_companies, s.add);
  assert.throws(() => SourcesSchema.parse({ add: ['Initech'], drop: [] }), /careers_url/);
  assert.throws(() => SourcesSchema.parse({ add: ['Initech — ftp://x'], drop: [] }), /careers_url/);
});
