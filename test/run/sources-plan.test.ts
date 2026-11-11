import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadDefaults, buildScanPlan } from '../../src/run/sources-plan.ts';
import type { Sources, Settings, Profile } from '../../src/config/schema.ts';

// --- helpers ----------------------------------------------------------------

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    timezone: 'Europe/Berlin',
    providers: ['gemini'],
    scoring_cap: 150,
    locations: ['berlin'],
    linkedin_locations: [],
    linkedin: false,
    allowed_members: [],
    caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
    ...overrides,
  };
}

function makeProfile(name: string, keywords: string[], active = true): Profile {
  return {
    name,
    active,
    rubric: '',
    searchKeywords: keywords,
    filters: {
      includeTitles: [],
      excludeTitles: [],
      excludeCompanies: [],
      excludeText: [],
      excludeLocations: [],
    },
  };
}

function emptySources(): Sources { return { add: [], drop: [] }; }

// --- loadDefaults -----------------------------------------------------------

describe('loadDefaults', () => {
  it('loads portals and extra sources from the defaults directory', () => {
    const d = loadDefaults();
    // portals.yml has tracked_companies and job_boards
    assert.ok(Array.isArray((d.portals as { tracked_companies?: unknown[] }).tracked_companies));
    assert.ok((d.portals as { tracked_companies: unknown[] }).tracked_companies.length > 0);
    // extra-sources.yml has pages with Vinted
    assert.ok(Array.isArray(d.extra.pages));
    assert.ok(d.extra.pages!.some((p) => p.name === 'Vinted'));
    // has rss
    assert.ok(Array.isArray(d.extra.rss));
    assert.ok(d.extra.rss!.length > 0);
  });
});

// --- buildScanPlan: Drop ----------------------------------------------------

describe('buildScanPlan', () => {
  it('drops a default company, ignoring case and spaces', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: { add: [], drop: [' vinted '] },
      profiles: [makeProfile('alice', [])],
      settings: makeSettings(),
    });
    assert.equal(plan.warnings.length, 0);
    assert.ok(!plan.pages.some((p) => p.name.toLowerCase() === 'vinted'), 'Vinted should be dropped');
  });

  it('a Drop typo is a warning naming the item', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: { add: [], drop: ['VintedXXX'] },
      profiles: [makeProfile('alice', [])],
      settings: makeSettings(),
    });
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /VintedXXX/);
    // nothing was removed
    assert.ok(plan.pages.some((p) => p.name === 'Vinted'));
  });

  it('a Drop name in tracked_companies is removed', () => {
    const defaults = loadDefaults();
    // Pick a real company from the portals defaults
    const companies = (defaults.portals as { tracked_companies: Array<{ name: string }> }).tracked_companies;
    const target = companies[0]!.name;
    const plan = buildScanPlan({
      defaults,
      sources: { add: [], drop: [target] },
      profiles: [makeProfile('alice', [])],
      settings: makeSettings(),
    });
    const remaining = (plan.portals as { tracked_companies: Array<{ name: string }> }).tracked_companies;
    assert.ok(!remaining.some((c) => c.name.toLowerCase() === target.toLowerCase()), `${target} should be dropped`);
    assert.equal(plan.warnings.length, 0);
  });

  // --- Add ----------------------------------------------------------------

  it('Add appends a tracked company', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: { add: [{ name: 'Acme GmbH', careers_url: 'https://acme.example.com/careers' }], drop: [] },
      profiles: [makeProfile('alice', [])],
      settings: makeSettings(),
    });
    const companies = (plan.portals as { tracked_companies: Array<{ name: string; careers_url: string }> }).tracked_companies;
    const added = companies.find((c) => c.name === 'Acme GmbH');
    assert.ok(added, 'Acme GmbH should be in tracked_companies');
    assert.equal(added!.careers_url, 'https://acme.example.com/careers');
  });

  it('Add with a default name replaces its careers_url', () => {
    const defaults = loadDefaults();
    const companies = (defaults.portals as { tracked_companies: Array<{ name: string }> }).tracked_companies;
    const target = companies[0]!.name;
    const newUrl = 'https://new-url.example.com/jobs';
    const plan = buildScanPlan({
      defaults,
      sources: { add: [{ name: target, careers_url: newUrl }], drop: [] },
      profiles: [makeProfile('alice', [])],
      settings: makeSettings(),
    });
    const result = (plan.portals as { tracked_companies: Array<{ name: string; careers_url: string }> }).tracked_companies;
    const found = result.filter((c) => c.name.toLowerCase() === target.toLowerCase());
    assert.equal(found.length, 1, 'exactly one entry for the replaced company');
    assert.equal(found[0]!.careers_url, newUrl);
  });

  // --- Board keywords / profiles ------------------------------------------

  it('board keywords of two active profiles are merged once each', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: emptySources(),
      profiles: [
        makeProfile('alice', ['CRM', 'Eventmanagement']),
        makeProfile('bob', ['crm', 'RevOps']),
      ],
      settings: makeSettings(),
    });
    const boards = (plan.portals as { job_boards: Array<{ provider: string; arbeitsagentur?: { keywords?: string[] } }> }).job_boards;
    const aa = boards.find((b) => b.provider === 'arbeitsagentur');
    assert.ok(aa, 'arbeitsagentur board expected');
    const kw = aa!.arbeitsagentur?.keywords ?? [];
    // CRM appears once despite being in both profiles (case-insensitive)
    assert.equal(kw.filter((k) => k.toLowerCase() === 'crm').length, 1);
    assert.ok(kw.map((k) => k.toLowerCase()).includes('eventmanagement'));
    assert.ok(kw.map((k) => k.toLowerCase()).includes('revops'));
  });

  // --- LinkedIn -----------------------------------------------------------

  it('linkedin off → null', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: emptySources(),
      profiles: [makeProfile('alice', ['crm'])],
      settings: makeSettings({ linkedin: false }),
    });
    assert.equal(plan.linkedin, null);
    assert.equal(plan.warnings.length, 0);
  });

  it('linkedin on → searches per linkedin_locations with the profiles keywords', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: emptySources(),
      profiles: [makeProfile('alice', ['crm']), makeProfile('bob', ['event'])],
      settings: makeSettings({
        linkedin: true,
        linkedin_locations: [{ location: 'Berlin, Germany' }, { location: 'Germany', remote: true }],
      }),
    });
    assert.ok(plan.linkedin !== null, 'linkedin should be set');
    const searches = (plan.linkedin as { searches?: Array<{ location: string; queries: string[] }> }).searches;
    assert.ok(Array.isArray(searches));
    const berlin = searches!.find((s) => s.location === 'Berlin, Germany');
    assert.ok(berlin, 'Berlin search expected');
    assert.ok(berlin!.queries.map((q) => q.toLowerCase()).includes('crm'));
    assert.ok(berlin!.queries.map((q) => q.toLowerCase()).includes('event'));
  });

  it('linkedin on without locations → null and a warning', () => {
    const defaults = loadDefaults();
    const plan = buildScanPlan({
      defaults,
      sources: emptySources(),
      profiles: [makeProfile('alice', ['crm'])],
      settings: makeSettings({ linkedin: true, linkedin_locations: [] }),
    });
    assert.equal(plan.linkedin, null);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /linkedin_locations/i);
  });

  // --- No mutation --------------------------------------------------------

  it('defaults are not mutated', () => {
    const defaults = loadDefaults();
    // Deep-clone for comparison
    const before = JSON.stringify(defaults);
    buildScanPlan({
      defaults,
      sources: { add: [{ name: 'NewCo', careers_url: 'https://newco.example.com/jobs' }], drop: ['Vinted'] },
      profiles: [makeProfile('alice', ['crm'])],
      settings: makeSettings({ linkedin: true, linkedin_locations: [{ location: 'Berlin, Germany' }] }),
    });
    assert.equal(JSON.stringify(defaults), before, 'defaults must not be mutated');
  });
});
