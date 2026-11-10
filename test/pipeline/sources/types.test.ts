import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScanRow, SourceResult } from '../../../src/pipeline/sources/types.ts';
import { fetchLinkedinSearch } from '../../../src/pipeline/sources/linkedin.ts';
import { fetchPageSources, parseEmbeddedJobs } from '../../../src/pipeline/sources/pages.ts';
import { fetchRssSources, parseRssJobs } from '../../../src/pipeline/sources/rss.ts';

// The run (PR 3) handles every source's result the same way; one shared type keeps them from drifting apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameResult: [
  Same<Awaited<ReturnType<typeof fetchRssSources>>, SourceResult>,
  Same<Awaited<ReturnType<typeof fetchPageSources>>, SourceResult>,
  Same<Awaited<ReturnType<typeof fetchLinkedinSearch>>, SourceResult>,
  Same<ReturnType<typeof parseRssJobs>, ScanRow[]>,
  Same<ReturnType<typeof parseEmbeddedJobs>, ScanRow[]>,
] = [true, true, true, true, true];

test('every source returns the shared SourceResult', () => {
  assert.deepEqual(sameResult, [true, true, true, true, true]);
});
