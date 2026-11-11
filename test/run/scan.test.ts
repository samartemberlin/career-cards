import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCareerOpsScan, scanAll, ScanFailed, TMP_PREFIX } from '../../src/run/scan.ts';
import type { ScanDeps } from '../../src/run/scan.ts';
import type { ScanPlan } from '../../src/run/sources-plan.ts';
import type { ScanRow, SourceError, SourceResult } from '../../src/pipeline/sources/types.ts';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'career-ops-fake');
const ENV = { PATH: process.env.PATH, HOME: '/home/nobody', LANG: 'C.UTF-8' };

const scanDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_PREFIX));

const result = (rows: ScanRow[], errors: SourceError[] = []): SourceResult => Object.assign([...rows], { errors });

const PLAN: ScanPlan = {
  portals: { tracked_companies: [] },
  rss: [{ name: 'Feed', url: 'https://feed.example/rss' }],
  pages: [{ name: 'Page', type: 'listing-jsonld', url: 'https://page.example/jobs' }],
  linkedin: { searches: [{ location: 'Berlin, Germany' }] },
  warnings: [],
};

const quiet = (): void => {};

test('runCareerOpsScan returns added rows and receipt errors', async () => {
  const r = await runCareerOpsScan({ tracked_companies: [] }, { careerOpsDir: FAKE, env: ENV });
  assert.deepEqual([...r], [{
    url: 'https://boards.greenhouse.io/acme/jobs/111',
    title: 'Data Analyst',
    company: 'Acme Robotics',
    location: 'Berlin',
    posted: '2024-11-08',
    source: 'greenhouse-api',
  }]);
  assert.deepEqual(r.errors, [{ company: 'Gone GmbH', error: 'HTTP 404' }]);
});

test('career-ops gets no secret', async () => {
  const env = { ...ENV, TRELLO_TOKEN: 'trello-token-123456', GEMINI_API_KEY: 'gemini-key-123456', SHELL: '/bin/sh' };
  const r = await runCareerOpsScan({ note: 'FAKE_REPORT_ENV' }, { careerOpsDir: FAKE, env });
  const names = r.errors.find((e) => e.company === 'fake-env')!.error.split(' ');
  assert.ok(names.includes('CAREER_OPS_PORTALS'));
  for (const n of names) assert.ok(['PATH', 'HOME', 'LANG'].includes(n) || n.startsWith('CAREER_OPS_'), `unexpected env ${n}`);
});

test('a failing scan throws ScanFailed and removes the temp dir', async () => {
  const before = scanDirs();
  await assert.rejects(
    runCareerOpsScan({ note: 'FAKE_SCAN_EXIT=1' }, { careerOpsDir: FAKE, env: ENV }),
    (e: unknown) => e instanceof ScanFailed && /exit 1/.test(e.message) && /boom/.test(e.message),
  );
  assert.deepEqual(scanDirs(), before);
});

test('a scan past its timeout throws ScanFailed', async () => {
  const before = scanDirs();
  await assert.rejects(
    runCareerOpsScan({ note: 'FAKE_SCAN_HANG' }, { careerOpsDir: FAKE, env: ENV, timeoutMs: 300 }),
    (e: unknown) => e instanceof ScanFailed && /timed out/.test(e.message),
  );
  assert.deepEqual(scanDirs(), before);
});

test('a scan stops at the run deadline', async () => {
  const before = scanDirs();
  await assert.rejects(
    runCareerOpsScan({ note: 'FAKE_SCAN_HANG' }, { careerOpsDir: FAKE, env: ENV, deadline: Date.now() + 300 }),
    (e: unknown) => e instanceof ScanFailed && /timed out/.test(e.message),
  );
  await assert.rejects(
    runCareerOpsScan({ tracked_companies: [] }, { careerOpsDir: FAKE, env: ENV, deadline: Date.now() - 1 }),
    (e: unknown) => e instanceof ScanFailed && /no time left/.test(e.message),
  );
  assert.deepEqual(scanDirs(), before);
});

const row = (url: string, company: string, title: string, source: string): ScanRow => ({ url, company, title, source });

test('scanAll: LinkedIn throwing leaves the other sources\' jobs', async () => {
  const deps: ScanDeps = {
    careerOps: async () => result([row('https://jobs.lever.co/acme/0b5d2c3e-1111-2222-3333-444455556666', 'Acme', 'Analyst', 'lever-api')]),
    rss: async () => result([row('https://feed.example/job/1', 'Feedco', 'Writer', 'rss:Feed')]),
    pages: async () => result([row('https://page.example/job/2', 'Pageco', 'Editor', 'page:Page')]),
    linkedin: async () => { throw new Error('blocked'); },
    log: quiet,
  };
  const out = await scanAll(PLAN, deps);
  assert.deepEqual(out.jobs.map((j) => j.company), ['Acme', 'Feedco', 'Pageco']);
  assert.deepEqual(out.errors, [{ company: 'LinkedIn', error: 'blocked' }]);
  assert.deepEqual(out.bySource, { 'lever-api': 1, 'rss:Feed': 1, 'page:Page': 1 });
});

test('scanAll: career-ops throwing is a source error, not a failed scan', async () => {
  const deps: ScanDeps = {
    careerOps: async () => { throw new ScanFailed('scan failed (exit 1)\nboom'); },
    rss: async () => result([row('https://feed.example/job/1', 'Feedco', 'Writer', 'rss:Feed')], [{ company: 'Other feed', error: 'HTTP 500' }]),
    pages: async () => result([]),
    linkedin: async () => result([]),
    log: quiet,
  };
  const out = await scanAll(PLAN, deps);
  assert.deepEqual(out.jobs.map((j) => j.key), [out.jobs[0]!.key]);
  assert.equal(out.jobs[0]!.company, 'Feedco');
  assert.deepEqual(out.errors, [
    { company: 'career-ops', error: 'scan failed (exit 1)\nboom' },
    { company: 'Other feed', error: 'HTTP 500' },
  ]);
});

test('scanAll dedups by key, then by company and title', async () => {
  const deps: ScanDeps = {
    careerOps: async () => result([
      row('https://boards.greenhouse.io/acme/jobs/111', 'Acme GmbH', 'Data Analyst (m/w/d)', 'greenhouse-api'),
      row('https://boards.greenhouse.io/acme/jobs/111?gh_src=abc', 'Acme GmbH', 'Data Analyst (m/w/d)', 'greenhouse-api'),
      row('', 'No Url', 'Ghost', 'greenhouse-api'),
    ]),
    rss: async () => result([]),
    pages: async () => result([]),
    linkedin: async () => result([
      row('https://www.linkedin.com/jobs/view/data-analyst-at-acme-4012345678', 'Acme', 'Data Analyst', 'linkedin'),
      row('https://www.linkedin.com/jobs/view/4099999999', 'Acme', 'Data Engineer', 'linkedin'),
    ]),
    log: quiet,
  };
  const out = await scanAll(PLAN, deps);
  assert.deepEqual(out.jobs.map((j) => j.key), ['greenhouse:acme:111', 'linkedin:4099999999']);
  assert.deepEqual(out.bySource, { 'greenhouse-api': 1, linkedin: 1 });
  assert.deepEqual(out.errors, []);
});

test('scanAll skips LinkedIn when the plan has none', async () => {
  let called = false;
  const deps: ScanDeps = {
    careerOps: async () => result([]),
    rss: async () => result([]),
    pages: async () => result([]),
    linkedin: async () => { called = true; return result([]); },
    log: quiet,
  };
  await scanAll({ ...PLAN, linkedin: null }, deps);
  assert.equal(called, false);
});

test('scanAll: a row dropped on company and title still claims its key', async () => {
  const deps: ScanDeps = {
    careerOps: async () => result([
      row('https://jobs.example/a', 'Acme', 'Analyst', 'x'),
      row('https://jobs.example/b', 'Acme', 'Analyst', 'x'),
      row('https://jobs.example/b', 'Acme', 'Engineer', 'x'),
    ]),
    rss: async () => result([]),
    pages: async () => result([]),
    log: quiet,
  };
  const out = await scanAll({ ...PLAN, linkedin: null }, deps);
  assert.deepEqual(out.jobs.map((j) => j.url), ['https://jobs.example/a']);
});

test('a career-ops dir that cannot start throws ScanFailed', async () => {
  await assert.rejects(
    runCareerOpsScan({}, { careerOpsDir: join(FAKE, 'missing'), env: ENV }),
    (e: unknown) => e instanceof ScanFailed,
  );
});

test('scanAll: career-ops gets the deadline and LinkedIn at most the minutes left', async () => {
  const deadline = Date.now() + 10 * 60_000;
  let careerOpsDeadline = 0;
  let liMinutes: number | undefined;
  await scanAll({ ...PLAN, linkedin: { ...PLAN.linkedin, max_total_minutes: 40 } }, {
    careerOps: async (_p, o) => { careerOpsDeadline = o.deadline; return result([]); },
    rss: async () => result([]),
    pages: async () => result([]),
    linkedin: async (cfg) => { liMinutes = cfg.max_total_minutes; return result([]); },
    log: quiet,
    deadline,
  });
  assert.equal(careerOpsDeadline, deadline);
  assert.ok(liMinutes !== undefined && liMinutes <= 10 && liMinutes > 9, `LinkedIn got ${liMinutes} min`);
});

test('scanAll: past the deadline LinkedIn is not started', async () => {
  let called = false;
  const out = await scanAll(PLAN, {
    careerOps: async () => result([]),
    rss: async () => result([]),
    pages: async () => result([]),
    linkedin: async () => { called = true; return result([]); },
    log: quiet,
    deadline: Date.now() - 1,
  });
  assert.equal(called, false);
  assert.deepEqual(out.errors, [{ company: 'LinkedIn', error: 'no time left in the run budget' }]);
});
