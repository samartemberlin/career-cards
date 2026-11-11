import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchLinkedinJd, fetchLinkedinSearch, LinkedInBlocked, parseCards, parseJobPosting, resetLinkedinJdBudget } from '../../../src/pipeline/sources/linkedin.ts';
import { jobKey } from '../../../src/pipeline/keys.ts';

const searchHtml = readFileSync(new URL('../../fixtures/linkedin-search.html', import.meta.url), 'utf8');
const jobHtml = readFileSync(new URL('../../fixtures/linkedin-job.html', import.meta.url), 'utf8');

type FetchResult = { ok: boolean; status: number; text: () => Promise<string> };
const ok = (body: string) => async (): Promise<FetchResult> => ({ ok: true, status: 200, text: async () => body });
const res = (status: number, body = ''): FetchResult => ({ ok: status < 400, status, text: async () => body });
const noSleep = async (_ms: number): Promise<void> => {};

test('parseCards reads the real guest-search response', () => {
  const cards = parseCards(searchHtml);
  assert.equal(cards.length, 3);
  assert.match(cards[0]!.id, /^\d{8,}$/);
  assert.ok(cards[0]!.title.length > 3);
  assert.ok(cards[0]!.company.length > 1);
  assert.match(cards[0]!.url, /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/);
  assert.match(cards[0]!.posted, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!/[<>]/.test(cards[0]!.title + cards[0]!.company + cards[0]!.location));
});

test('parseJobPosting extracts the description of a real posting, not the page chrome', () => {
  const text = parseJobPosting(jobHtml);
  assert.ok(text.length > 500, `len ${text.length}`);
  assert.ok(!/Join now|Sign in|Anmelden/i.test(text.slice(0, 300)));
  assert.equal(parseJobPosting('<html>authwall</html>'), '');
});

test('LinkedIn job urls become linkedin:<id> keys, with or without slug and tracking', () => {
  assert.equal(jobKey('https://www.linkedin.com/jobs/view/4476236349/'), 'linkedin:4476236349');
  assert.equal(jobKey('https://de.linkedin.com/jobs/view/projektassistenz-w-m-d-at-bundesamt-4476236349?position=1&pageNum=0'), 'linkedin:4476236349');
});

test('search: paginates until empty, dedups across queries, marks remote searches, sleeps between requests', async () => {
  const urls: string[] = [];
  let n = 0;
  const fetchImpl = async (u: string): Promise<FetchResult> => {
    urls.push(u);
    return { ok: true, status: 200, text: async () => (n++ % 2 === 0 ? searchHtml : '') };
  };
  let sleeps = 0;
  const rows = await fetchLinkedinSearch(
    { recency_days: 3, max_pages_per_query: 3, delay_seconds: 2, queries: ['A', 'B'], searches: [{ location: 'Berlin, Germany' }, { location: 'European Union', remote: true, queries: ['C'] }] },
    { fetchImpl, sleep: async () => { sleeps++; }, log() {} },
  );
  assert.equal(rows.length, 3);                      // same 3 cards every time → deduped
  assert.ok(urls.some((u) => u.includes('f_WT=2') && u.includes('European%20Union')));
  assert.ok(!urls.filter((u) => u.includes('Berlin')).some((u) => u.includes('f_WT')));
  assert.ok(urls[0]!.includes('f_TPR=r259200'));
  assert.ok(sleeps >= 3);
  assert.equal(rows.errors.length, 0);
});

test('a block is waited out with growing waits and the same request is retried', async () => {
  const seq = [429, 429, 200, 200];
  const waits: number[] = [];
  const urls: string[] = [];
  const fetchImpl = async (u: string): Promise<FetchResult> => {
    urls.push(u);
    const st = seq.shift() ?? 200;
    return res(st, st === 200 ? (urls.length === 3 ? searchHtml : '') : '');
  };
  const rows = await fetchLinkedinSearch(
    { queries: ['A'], max_pages_per_query: 1, block_waits_minutes: [1, 3, 7], delay_seconds: 0 },
    { fetchImpl, sleep: async (ms) => { waits.push(ms); }, log() {}, random: () => 0.5 },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.errors.length, 0);
  assert.deepEqual(waits.filter((w) => w >= 60000), [60000, 180000]);        // 1 min, then 3 min (jitter midpoint)
  assert.equal(urls[0], urls[1]);
  assert.equal(urls[1], urls[2]);                                             // same request each time
});

test('a block that never lifts: waits are used up, the source stops, collected jobs are kept and the error is reported', async () => {
  let calls = 0;
  const waits: number[] = [];
  const fetchImpl = async (): Promise<FetchResult> => (++calls === 1 ? res(200, searchHtml) : res(999));
  const rows = await fetchLinkedinSearch(
    { queries: ['A', 'B', 'C'], max_pages_per_query: 2, block_waits_minutes: [1, 2], delay_seconds: 0 },
    { fetchImpl, sleep: async (ms) => { waits.push(ms); }, log() {}, random: () => 0.5 },
  );
  assert.equal(rows.length, 3);
  assert.match(rows.errors[0]!.error, /rate limited/);
  assert.equal(calls, 1 + 3);                        // first ok, then the blocked request tried 1 + 2 retries, then stop
  assert.equal(waits.filter((w) => w >= 60000).length, 2);
});

test('the overall time budget is respected even if retries remain', async () => {
  const rows = await fetchLinkedinSearch(
    { queries: ['A'], block_waits_minutes: [30, 30], max_total_minutes: 1, delay_seconds: 0 },
    { fetchImpl: async () => res(429), sleep: async () => { throw new Error('must not sleep 30 minutes'); }, log() {}, random: () => 0.5 },
  );
  assert.equal(rows.length, 0);
  assert.match(rows.errors[0]!.error, /no time left/);
});

test('a transient 5xx is retried once quickly; a persistent non-block error only skips that query', async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<FetchResult> => {
    calls++;
    return calls <= 2 ? res(500) : res(200, calls === 3 ? searchHtml : '');
  };
  const rows = await fetchLinkedinSearch(
    { queries: ['A', 'B'], max_pages_per_query: 1, delay_seconds: 0 },
    { fetchImpl, sleep: async () => {}, log() {}, random: () => 0.5 },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.errors.length, 1);   // query A: 500 twice → recorded; query B ok
});

test('descriptions: a block is waited out up to the budget, then switched off for the run (jobs retried tomorrow)', async () => {
  resetLinkedinJdBudget();
  const waits: number[] = [];
  const blocked = async (): Promise<FetchResult> => res(429);
  const a = await fetchLinkedinJd('1', { fetchImpl: blocked, sleep: async (ms) => { waits.push(ms); }, maxWaitMin: 5, random: () => 0.5, log() {} });
  assert.equal(a, null);
  assert.ok(waits.some((w) => w >= 60000));
  let calls = 0;
  const b = await fetchLinkedinJd('2', { fetchImpl: async () => { calls++; return res(200, jobHtml); }, sleep: noSleep, log() {} });
  assert.equal(b, null);
  assert.equal(calls, 0);     // disabled: not even tried
  resetLinkedinJdBudget();
  assert.ok(await fetchLinkedinJd('3', { fetchImpl: ok(jobHtml), sleep: noSleep, log() {} }));
  resetLinkedinJdBudget();
});

test('descriptions: a block is not waited out past the run deadline', async () => {
  resetLinkedinJdBudget();
  const waits: number[] = [];
  const r = await fetchLinkedinJd('1', {
    fetchImpl: async () => res(429), sleep: async (ms) => { waits.push(ms); }, maxWaitMin: 20, random: () => 0.5, log() {},
    deadline: Date.now() + 1000,
  });
  assert.equal(r, null);
  assert.ok(!waits.some((w) => w >= 60000), `waited ${waits.join(', ')} ms`);
  resetLinkedinJdBudget();
});

test('a search block also switches descriptions off (same host, same block)', async () => {
  resetLinkedinJdBudget();
  await fetchLinkedinSearch(
    { queries: ['A'], block_waits_minutes: [], delay_seconds: 0 },
    { fetchImpl: async () => res(429), sleep: async () => {}, log() {}, random: () => 0.5 },
  );
  let calls = 0;
  assert.equal(
    await fetchLinkedinJd('9', { fetchImpl: async () => { calls++; return res(200, jobHtml); }, sleep: noSleep, log() {} }),
    null,
  );
  assert.equal(calls, 0);
  resetLinkedinJdBudget();
});

test('JD fetches are capped per process; over the cap returns null so the job is retried later', async () => {
  resetLinkedinJdBudget();
  const a = await fetchLinkedinJd('1', { fetchImpl: ok(jobHtml), sleep: noSleep, cap: 2 });
  const b = await fetchLinkedinJd('2', { fetchImpl: ok(jobHtml), sleep: noSleep, cap: 2 });
  const c = await fetchLinkedinJd('3', { fetchImpl: ok(jobHtml), sleep: noSleep, cap: 2 });
  assert.ok(a && b);
  assert.equal(c, null);
  resetLinkedinJdBudget();
  assert.equal(await fetchLinkedinJd('4', { fetchImpl: async () => res(429), sleep: noSleep }), null);
  resetLinkedinJdBudget();
});

test('LinkedInBlocked is an Error subclass', () => {
  const e = new LinkedInBlocked('blocked');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof LinkedInBlocked);
  assert.equal(e.message, 'blocked');
});
