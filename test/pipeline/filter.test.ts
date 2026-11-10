import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compileRules,
  applyRules,
  filterJob,
  RuleError,
} from '../../src/pipeline/filter.ts';
import type { Rule, CompiledRule, PersonFilter } from '../../src/pipeline/filter.ts';
import type { Job } from '../../src/pipeline/keys.ts';

// Rules built inline — no personal rules.json file. These are the universal hard-filter rules
// (location, employment type, seniority, years-of-experience, management responsibility, P&L)
// that apply to any person. Function/sector exclusions (HARD_FN_*) are personal choices
// and are NOT included here.
const INLINE_RULES: Rule[] = [
  {
    id: 'HARD_LOCATION_NONEU',
    where: 'location',
    action: 'reject',
    pattern:
      'united states|\\busa?\\b|u\\.s\\.|canada|australia|new zealand|singapore|japan|korea|\\bindia\\b|brazil|mexico|china|hong kong|dubai|\\buae\\b|israel|south africa|london|united kingdom|\\buk\\b|\\buki\\b',
  },
  {
    id: 'HARD_LOCATION',
    where: 'location',
    action: 'require',
    pattern:
      'berlin|deutschland|german|europe|\\beu\\b|emea|dach|hybrid|remote|worldwide|anywhere|global|work from',
  },
  {
    id: 'HARD_EMPLOYMENT_TYPE',
    where: 'employment_type',
    action: 'reject',
    pattern: '^\\s*(intern|internship|working[ _-]?student|werkstudent)\\s*$',
  },
  {
    id: 'HARD_SENIORITY',
    where: 'seniority',
    action: 'reject',
    pattern: '^\\s*(executive|student)\\s*$',
  },
  {
    id: 'HARD_WERKSTUDENT',
    where: 'text',
    action: 'reject',
    pattern: '\\bwerkstudent\\w*',
  },
  {
    id: 'HARD_ENROLLED',
    where: 'text',
    action: 'reject',
    pattern:
      '\\bpflichtpraktikum\\b|\\bimmatrikuliert\\b|currently enrolled|must be enrolled|enrolled (at|in) a (university|higher education)',
  },
  {
    id: 'HARD_EXP_5Y',
    where: 'text',
    action: 'reject',
    pattern:
      '(?<![0-9]-)(?<![0-9] -)(?<![0-9]- )(?<![0-9] - )(?<![0-9]–)(?<![0-9] –)(?<![0-9] bis )(?<![0-9] to )\\b([5-9]|1[0-9])\\s*\\+?\\s*(years?|jahre?n?)\\s+(of\\s+)?(relevant\\s+|professional\\s+|work\\s+|proven\\s+|einschlägige[nrs]?\\s+|relevante[nrs]?\\s+|nachweisliche[nrs]?\\s+|praktische[nrs]?\\s+|fundierte[nrs]?\\s+)?(experience|(?:berufs|projekt|führungs)?erfahrung)|(experience|(?:berufs|projekt|führungs)?erfahrung)[^.\\n]{0,25}(?<![0-9]-)(?<![0-9] -)\\b([5-9]|1[0-9])\\s*\\+\\s*(years?|jahre)|(?<![0-9]-)(?<![0-9] -)(?<![0-9]- )(?<![0-9] - )(?<![0-9]–)(?<![0-9] –)(?<![0-9] bis )(?<![0-9] to )\\b([5-9]|1[0-9])\\s*\\+\\s*(years?|jahre?n?)\\s+(in|as|im|als|within)\\b|(at\\s+least|mindestens|mind\\.|more\\s+than|über)\\s+([5-9]|1[0-9])\\s*\\+?\\s*(years?|jahre?n?)\\s+(in|as|im|als|within)\\b',
  },
  {
    id: 'HARD_MGMT',
    where: 'text',
    action: 'reject',
    pattern:
      '\\bdirect reports\\b|\\bf(ü|ue)hrungsverantwortung\\b|disziplinarische\\s+f(ü|ue)hrung|(lead|manage|managing|leading)\\s+a\\s+team\\s+of\\s+\\d+',
  },
  {
    id: 'HARD_PL',
    where: 'text',
    action: 'reject',
    pattern: '\\bp&l\\b|profit and loss|umsatzverantwortung|revenue (target|quota|responsibility)|sales quota',
  },
];

const rules: CompiledRule[] = compileRules(INLINE_RULES);

// Ported from samjobs/test/filter.test.mjs: every case is a deliberate decision.
// [fn]/[us]/[ux] groups depend on personal rules.json and are not included.
const cases = JSON.parse(
  readFileSync(new URL('../fixtures/rules-cases.json', import.meta.url), 'utf8'),
) as { label: string; post: Job; expect: string | null }[];

for (const c of cases) {
  test(c.label, () => {
    const got = applyRules(c.post, rules, []);
    assert.equal(got ? got.split(':')[0] : null, c.expect, got ?? '');
  });
}

test('manual company exclusion wins over everything', () => {
  const got = applyRules(
    { key: 'k', url: 'u', company: 'Acme', title: 'Project Coordinator', location: 'Berlin' },
    rules,
    [{ company: 'ACME', reason: 'bad employer' }],
  );
  assert.equal(got, 'EXCL_MANUAL: "bad employer"');
});

test('pre-fetch call (no JD) never rejects what the full text would pass', () => {
  assert.equal(
    applyRules({ key: 'k', url: 'u', company: 'X', title: 'Projektkoordinator:in', location: 'Berlin', jd: '' }, rules),
    null,
  );
});

test('compileRules throws RuleError on an invalid pattern', () => {
  const bad: Rule[] = [{ id: 'TEST_BAD', pattern: '(abc', action: 'reject' }];
  assert.throws(
    () => compileRules(bad),
    (e: unknown) => {
      assert.ok(e instanceof RuleError, 'should be RuleError');
      assert.ok(String(e.message).includes('TEST_BAD'), 'message should contain rule id');
      assert.ok(String(e.message).includes('(abc'), 'message should contain pattern');
      return true;
    },
  );
});

// PersonFilter built inline — same inline rules, plus title/location patterns.
const f: PersonFilter = {
  rules,
  include: [/projekt/i, /coordinator/i, /event/i, /kommunikation/i, /assistant/i, /chief of staff/i, /founder/i, /leitung/i, /entrepreneurs/i],
  exclude: [],
  locationExclude: [/\btoronto\b/i],
  exclusions: [],
};

const must = cases.filter((c) => c.expect === null);

// Every case the fixture decided "must pass" survives the combined filter too.
test('combined filter keeps the old must-pass postings (title/location level)', () => {
  const lost: string[] = [];
  for (const c of must) {
    const got = filterJob({ ...c.post, jd: '' }, f);
    if (got) lost.push(`${c.label} → ${got}`);
  }
  assert.deepEqual(lost, []);
});

test('combined filter: location rejects and seniority-light titles pass', () => {
  const t = (title: string, location = 'Berlin'): string | null =>
    filterJob({ key: 'k', url: 'u', company: 'X', title, location, jd: '' }, f);
  // HARD_LOCATION_NONEU fires via applyRules (before locationExclude)
  assert.match(t('Project Coordinator', 'Toronto, Canada')!, /^HARD_LOCATION_NONEU/);
  // locationExclude fires for a city that passes HARD_LOCATION but is on the person's list
  // f has locationExclude: [/\btoronto\b/i]; "Toronto, Germany" passes HARD_LOCATION then hits locationExclude
  assert.match(t('Project Coordinator', 'Toronto, Germany')!, /^EXCLUDE_LOCATION/);
  assert.equal(t('Projektkoordination Klimaschutz (m/w/d)'), null);
  assert.equal(t('Co-Leitung von Young Entrepreneurs in Science'), null);
  assert.equal(t('Chief of Staff Ops'), null);
});

test('filterJob: include list rejects titles that match nothing', () => {
  const got = filterJob(
    { key: 'k', url: 'u', company: 'X', title: 'Lagerarbeiter (m/w/d)', location: 'Berlin', jd: '' },
    f,
  );
  assert.match(got!, /^NOT_INCLUDED/);
});

test('filterJob: exclude pattern rejects matching titles', () => {
  const fWithExclude: PersonFilter = {
    ...f,
    exclude: [/\bsales\b/i],
  };
  const got = filterJob(
    { key: 'k', url: 'u', company: 'X', title: 'Sales Manager', location: 'Berlin', jd: '' },
    fWithExclude,
  );
  assert.match(got!, /^EXCLUDE_TITLE/);
});
