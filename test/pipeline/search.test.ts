import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { mergeLinkedin, mergePortals } from '../../src/pipeline/search.ts';

// loadSearch / loadSearches are file-loading helpers dropped in this port (PR 2 builds searches
// from Trello cards). Tests that depended on a personal search.yml are also dropped.

type AnyObject = Record<string, unknown>;
const read = (rel: string): AnyObject =>
  loadYaml(readFileSync(new URL(`../../config/defaults/${rel}`, import.meta.url), 'utf8')) as AnyObject;

test('shared LinkedIn settings survive the merge', () => {
  const merged = mergeLinkedin({ delay_seconds: 4, enabled: true }, []);
  assert.equal((merged as AnyObject).delay_seconds, 4);
  assert.deepEqual((merged as { searches: unknown[] }).searches, []);
});

test('two people share a query once, and their queries take turns', () => {
  const s = (queries: string[]) => ({
    linkedin: [{ location: 'Berlin', queries }],
    board_keywords: [],
    companies: [],
  });
  const merged = mergeLinkedin({}, [s(['a1', 'a2', 'Both']), s(['b1', 'both', 'b2'])]);
  assert.deepEqual((merged as { searches: unknown[] }).searches, [
    { location: 'Berlin', queries: ['a1', 'b1', 'a2', 'both', 'b2'] },
  ]);
});

test('remote and on-site searches for one location stay separate', () => {
  const s = {
    linkedin: [
      { location: 'Germany', queries: ['x'] },
      { location: 'Germany', remote: true, queries: ['y'] },
    ],
    board_keywords: [],
    companies: [],
  };
  assert.deepEqual((mergeLinkedin({}, [s]) as { searches: unknown[] }).searches, [
    { location: 'Germany', queries: ['x'] },
    { location: 'Germany', remote: true, queries: ['y'] },
  ]);
});

test('board keywords union ignores case', () => {
  const base = { job_boards: [{ provider: 'arbeitsagentur', arbeitsagentur: {} }], tracked_companies: [] };
  const s = (board_keywords: string[]) => ({ board_keywords, linkedin: [], companies: [] });
  const got = mergePortals(base, [s(['CRM', 'Eventmanagement']), s(['crm', 'RevOps'])]);
  assert.deepEqual(
    ((got.job_boards as AnyObject[])[0]!.arbeitsagentur as AnyObject).keywords,
    ['CRM', 'Eventmanagement', 'RevOps'],
  );
});

test('a company in the base wins over the same name in a person file', () => {
  const base = { job_boards: [], tracked_companies: [{ name: 'Acme', careers_url: 'base' }] };
  const got = mergePortals(base, [
    { board_keywords: [], linkedin: [], companies: [{ name: 'ACME', careers_url: 'person' }, { name: 'New', careers_url: 'n' }] },
  ]);
  assert.deepEqual(
    (got.tracked_companies as AnyObject[]).map((c) => c.careers_url),
    ['base', 'n'],
  );
});

test('the merged scan has no positive title list, and keeps the negative one', () => {
  const merged = mergePortals(read('portals.yml'), []);
  assert.equal((merged.title_filter as AnyObject).positive, undefined);
  assert.ok(((merged.title_filter as AnyObject).negative as string[]).includes('Pflichtpraktikum'));
});

test('mergePortals does not change the base it was given', () => {
  const base = {
    title_filter: { positive: ['x'] },
    job_boards: [{ provider: 'arbeitsagentur', arbeitsagentur: {} }],
    tracked_companies: [],
  };
  mergePortals(base, [{ board_keywords: ['k'], linkedin: [], companies: [{ name: 'c' }] }]);
  assert.deepEqual(base, {
    title_filter: { positive: ['x'] },
    job_boards: [{ provider: 'arbeitsagentur', arbeitsagentur: {} }],
    tracked_companies: [],
  });
});
