import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateIn, processJobs } from '../../src/run/process.ts';
import type { ProcessDeps, ProcessOpts } from '../../src/run/process.ts';
import { combinedFilter } from '../../src/run/profiles.ts';
import { emptyStats } from '../../src/run/stats.ts';
import type { RunStats } from '../../src/run/stats.ts';
import { buildScoreContext } from '../../src/privacy.ts';
import { llmConfig } from '../../src/pipeline/llm.ts';
import type { FetchJdResult } from '../../src/pipeline/jd.ts';
import type { ParsedFacts } from '../../src/pipeline/facts.ts';
import type { Job } from '../../src/pipeline/keys.ts';
import type { Profile, Settings } from '../../src/config/schema.ts';
import { fakeLlm, fakeLlmEnv } from '../support/fake-llm.ts';

const settings: Settings = {
  timezone: 'Europe/Berlin', providers: ['gemini'], scoring_cap: 150, locations: ['berlin'], linkedin_locations: [],
  linkedin: false, allowed_members: [],
  caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
};

const profile: Profile = {
  name: 'Events', active: true, rubric: 'Robin Testperson wants event work.', searchKeywords: [],
  filters: {
    includeTitles: [], excludeTitles: [{ pattern: 'senior' }], excludeCompanies: [],
    excludeText: [{ pattern: 'night shifts' }], excludeLocations: [],
  },
};
const filter = combinedFilter([profile], settings);

const job = (n: number, o: Partial<Job> = {}): Job =>
  ({ key: `url:job${n}`, url: `https://jobs.example/${n}`, company: `Company ${n}`, title: `Event Manager ${n}`, location: 'Berlin', ...o });
const jobs = (n: number, o: (i: number) => Partial<Job> = () => ({})): Job[] => Array.from({ length: n }, (_, i) => job(i, o(i)));

const JD = 'We plan events. '.repeat(20);

type Setup = {
  score?: (key: string) => number | 'quota' | 'bad';
  facts?: (key: string) => Partial<ParsedFacts>;
  jd?: (key: string) => FetchJdResult | null;
  opts?: Partial<ProcessOpts>;
};

async function run(input: Job[], s: Setup = {}, known = new Set<string>()) {
  const llm = fakeLlm({ score: s.score ?? (() => 5), ...(s.facts ? { facts: s.facts } : {}) });
  const ctx = buildScoreContext({
    user: { sharedCv: 'CV of Robin Testperson', personalDetails: ['Robin Testperson'] }, profile,
    llm: llmConfig(fakeLlmEnv, { providers: ['gemini'] }), translateTitle: false,
  });
  const fetched: string[] = [];
  const logs: string[] = [];
  const deps: ProcessDeps = {
    fetchJd: async (j) => { fetched.push(j.key); return s.jd ? s.jd(j.key) : { jd: JD, meta: {} }; },
    ctx, extractor: 'Extract facts as JSON.', call: { fetchImpl: llm.fetchImpl, retries: 0 }, log: (m) => logs.push(m),
  };
  const stats: RunStats = emptyStats();
  const result = await processJobs(input, known, filter, deps,
    { cap: 150, deadline: Infinity, today: '2026-11-10', dryRun: false, ...s.opts }, stats);
  return { result, stats, fetched, requests: llm.requests, logs };
}

describe('processJobs', () => {
  it('known keys are skipped and counted', async () => {
    const { result, stats, fetched } = await run(jobs(3), {}, new Set(['url:job0', 'url:job2']));
    assert.equal(stats.known, 2);
    assert.equal(stats.fresh, 1);
    assert.deepEqual(fetched, ['url:job1']);
    assert.deepEqual(result.map((r) => r.key), ['url:job1']);
  });

  it('pre-filter rejections are counted by rule', async () => {
    const { result, stats, fetched } = await run(jobs(4, (i) => (i < 2 ? { title: `Senior Planner ${i}` } : {})));
    assert.equal(stats.rejectedPre, 2);
    assert.equal(stats.rules.EXCLUDE_TITLE, 2);
    assert.deepEqual(fetched, ['url:job2', 'url:job3']);
    assert.equal(result.length, 2);
  });

  it('a missing JD is neither carded nor rejected', async () => {
    const { result, stats } = await run(jobs(2), { jd: (k) => (k === 'url:job0' ? null : { jd: JD, meta: {} }) });
    assert.equal(stats.jd.missing, 1);
    assert.equal(stats.jd.fetched, 1);
    assert.equal(stats.rejectedPost, 0);
    assert.deepEqual(result.map((r) => r.key), ['url:job1']);
  });

  it('a JD fetch that throws counts as missing', async () => {
    const { result, stats } = await run(jobs(1), { jd: () => { throw new Error('boom'); } });
    assert.equal(stats.jd.missing, 1);
    assert.deepEqual(result, []);
  });

  it('post-filter sees the JD', async () => {
    const { result, stats } = await run(jobs(2), {
      jd: (k) => ({ jd: k === 'url:job0' ? `${JD} Includes night shifts.` : JD, meta: {} }),
    });
    assert.equal(stats.rejectedPost, 1);
    assert.equal(stats.rules.EXCLUDE_TEXT, 1);
    assert.deepEqual(result.map((r) => r.key), ['url:job1']);
  });

  it('an expired deadline is rejected as EXPIRED; same day is kept', async () => {
    const { result, stats, logs } = await run(jobs(2), {
      jd: (k) => ({ jd: JD, meta: { deadline: k === 'url:job0' ? '2026-11-09' : '2026-11-10' } }),
    });
    assert.equal(stats.rejectedPost, 1);
    assert.equal(stats.rules.EXPIRED, 1);
    assert.ok(logs.some((l) => l.includes('EXPIRED: "deadline 2026-11-09"')));
    assert.deepEqual(result.map((r) => r.key), ['url:job1']);
    assert.equal(result[0]!.deadline, '2026-11-10');
  });

  it('cap: 5 ready, cap 3 → 3 scored, deferred 2', async () => {
    const { result, stats } = await run(jobs(5), { opts: { cap: 3 } });
    assert.equal(stats.scored, 3);
    assert.equal(stats.deferred, 2);
    assert.equal(result.length, 3);
  });

  it('newest posted are scored first', async () => {
    const posted = ['2026-11-01', 'last week', '2026-11-09', undefined, '2026-11-05'];
    const { result } = await run(jobs(5, (i) => (posted[i] ? { posted: posted[i] } : {})), { opts: { cap: 3 } });
    assert.deepEqual(result.map((r) => r.key).sort(), ['url:job0', 'url:job2', 'url:job4']);
  });

  it('JD fetches beyond maxFetch and maxLinkedinJd are deferred, LinkedIn last', async () => {
    const input = [job(0, { key: 'linkedin:1000001' }), job(1, { key: 'linkedin:1000002' }), job(2), job(3), job(4)];
    const { fetched, stats } = await run(input, { opts: { maxFetch: 3, maxLinkedinJd: 1 } });
    assert.deepEqual(fetched, ['url:job2', 'url:job3', 'linkedin:1000001']);
    assert.equal(stats.jd.deferred, 2);
    assert.equal(stats.jd.fetched, 3);
  });

  it('quota after 2 scores → 2 results, aborted set, left counted', async () => {
    // scoreAll runs 3 workers, so up to 3 jobs can hit the quota before the stop is seen.
    const { result, stats } = await run(jobs(8), { score: (k) => (['url:job0', 'url:job1'].includes(k) ? 6 : 'quota') });
    assert.deepEqual(result.map((r) => r.key), ['url:job0', 'url:job1']);
    assert.equal(stats.scored, 2);
    assert.match(stats.aborted ?? '', /quota/);
    assert.ok(stats.left >= 3);
    assert.equal(stats.left + stats.scoreErrors, 6);
  });

  it('a bad reply counts as a score error and gets no result', async () => {
    const { result, stats } = await run(jobs(2), { score: (k) => (k === 'url:job0' ? 'bad' : 4) });
    assert.equal(stats.scoreErrors, 1);
    assert.deepEqual(result.map((r) => r.key), ['url:job1']);
  });

  it('facts failure still scores', async () => {
    const { result, stats } = await run(jobs(2), { facts: () => { throw new Error('no facts'); } });
    assert.equal(stats.facts.errors, 2);
    assert.equal(stats.facts.done, 0);
    assert.equal(stats.scored, 2);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.facts, undefined);
  });

  it('facts German level reaches the result', async () => {
    const { result, stats } = await run(jobs(1), {
      facts: () => ({ german: { level: 'b2', spoken_heavy: false, evidence: 'Deutsch B2' } }),
    });
    assert.equal(stats.facts.done, 1);
    assert.equal(result[0]!.facts?.german.level, 'b2');
  });

  it('a facts deadline fills a missing job deadline', async () => {
    const { result } = await run(jobs(1), { facts: () => ({ deadline: '2026-12-01' }) });
    assert.equal(result[0]!.deadline, '2026-12-01');
  });

  it('results are sorted by score, ties in batch order', async () => {
    const scores: Record<string, number> = { 'url:job0': 3, 'url:job1': 7, 'url:job2': 3, 'url:job3': 9, 'url:job4': 7 };
    const { result, stats } = await run(jobs(5), { score: (k) => scores[k]! });
    assert.deepEqual(result.map((r) => r.key), ['url:job3', 'url:job1', 'url:job4', 'url:job0', 'url:job2']);
    assert.deepEqual(result.map((r) => r.score), [9, 7, 7, 3, 3]);
    assert.equal(result[0]!.reason, 'fake reason for url:job3');
    assert.equal(result[0]!.jd, JD);
    assert.equal(stats.tokens, 50);
    assert.deepEqual(stats.models, { 'custom:gemini-flash-lite-latest': 5 });
  });

  it('dry run fetches no JD and calls no model', async () => {
    const { result, stats, fetched, requests } = await run(jobs(3, (i) => (i === 0 ? { title: 'Senior Planner' } : {})),
      { opts: { dryRun: true } });
    assert.deepEqual(result, []);
    assert.deepEqual(fetched, []);
    assert.deepEqual(requests, []);
    assert.equal(stats.rejectedPre, 1);
    assert.equal(stats.fresh, 3);
  });

  it('no prompt carries a personal detail', async () => {
    const { requests } = await run(jobs(2));
    assert.ok(requests.length >= 4);
    for (const r of requests) assert.ok(!`${r.system}\n${r.user}`.includes('Robin Testperson'));
    assert.ok(requests.some((r) => r.system.includes('[USER] wants event work.')));
  });
});

describe('processJobs without a masked context', () => {
  it('scores nothing and calls no model', async () => {
    const llm = fakeLlm({ score: () => 5 });
    const stats = emptyStats();
    const deps: ProcessDeps = {
      fetchJd: async () => ({ jd: JD, meta: {} }), ctx: null, extractor: 'x', call: { fetchImpl: llm.fetchImpl }, log: () => {},
    };
    const result = await processJobs(jobs(2), new Set(), filter, deps,
      { cap: 150, deadline: Infinity, today: '2026-11-10', dryRun: false }, stats);
    assert.deepEqual(result, []);
    assert.deepEqual(llm.requests, []);
    assert.equal(stats.scored, 0);
    assert.equal(stats.left, 2);
    assert.ok(stats.aborted);
  });
});

describe('isoDateIn', () => {
  it('uses the given time zone', () => {
    assert.equal(isoDateIn(new Date('2026-11-09T23:30:00Z'), 'Europe/Berlin'), '2026-11-10');
    assert.equal(isoDateIn(new Date('2026-11-09T23:30:00Z'), 'UTC'), '2026-11-09');
  });
});
