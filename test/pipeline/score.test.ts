import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../../src/pipeline/keys.ts';
import type { FetchJson, LlmConfig } from '../../src/pipeline/llm.ts';
import { buildMessages, parseScore, scoreAll, scoreJob, shareOf } from '../../src/pipeline/score.ts';
import type { ScoreResult } from '../../src/pipeline/score.ts';
import { buildScoreContext } from '../../src/privacy.ts';
import type { MaskedContext } from '../../src/privacy.ts';

const job = (key: string, o: Partial<Job> = {}): Job => ({ key, url: `https://x.example/${key}`, company: 'c', title: 't', ...o });
const llm: LlmConfig = { name: 'one', apiKey: 'k', baseUrl: 'http://x', model: 'm' };
const ctxOf = (l: LlmConfig = llm): MaskedContext => buildScoreContext({
  user: { sharedCv: 'C', personalDetails: ['Alex Example'] }, profile: { rubric: 'R' }, llm: l, translateTitle: false,
});

/** A fetch stand-in that answers each scoring request with a valid score for the key in the prompt. */
function scorer(score = 6) {
  const keys: string[] = [];
  const fetchImpl: FetchJson = async (_u, o) => {
    const key = /key: (\S+)/.exec(JSON.parse(String(o?.body)).messages[1].content)?.[1] ?? '';
    keys.push(key);
    return { status: 200, ok: true, text: async () => '',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ key, score, reason: 'ok reason', flags: [] }) } }], usage: { total_tokens: 10 } }) };
  };
  return { keys, fetchImpl };
}

async function withFetch<T>(f: FetchJson, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f as unknown as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = real; }
}

test('parseScore accepts a good reply and drops unknown flags', () => {
  const r = parseScore('```json\n{"key":"k","score":7,"reason":"Workshops map to the youth series.","flags":["german-c1","made-up"]}\n```', 'k');
  assert.deepEqual(r, { key: 'k', score: 7, reason: 'Workshops map to the youth series.', flags: ['german-c1'] });
});

test('parseScore drops flags that are not actionable, whatever the model says', () => {
  const r = parseScore('{"key":"k","score":5,"reason":"A fine reason.","flags":["salary not stated","driving licence"]}', 'k');
  assert.deepEqual(r.flags, ['driving licence']);
});

test('parseScore rejects bad output loudly', () => {
  assert.throws(() => parseScore('not json', 'k'), /not JSON/);
  assert.equal(parseScore('Here: {"key":"k","score":4,"reason":"fine match","flags":[]} done', 'k').score, 4);
  assert.equal(parseScore('{"key":"k",\n "score": 4,\n - "reason": "fine match", "flags": []}', 'k').score, 4);
  const quoted = parseScore('{\n "key": "k",\n "score": 4,\n "reason": "needs native German ("sehr sicher") but flexible.",\n "flags": [ "german-c1" ],\n "title_en": "Copywriter"\n}', 'k');
  assert.deepEqual([quoted.score, quoted.reason, quoted.flags, quoted.title_en], [4, 'needs native German ("sehr sicher") but flexible.', ['german-c1'], 'Copywriter']);
  assert.throws(() => parseScore('{"key":"other","score":5,"reason":"fine reason"}', 'k'), /key mismatch/);
  assert.throws(() => parseScore('{"key":"k","score":11,"reason":"fine reason"}', 'k'), /bad score/);
  assert.throws(() => parseScore('{"key":"k","score":7.5,"reason":"fine reason"}', 'k'), /bad score/);
  assert.throws(() => parseScore('{"key":"k","score":5}', 'k'), /missing reason/);
});

test('parseScore keeps title_en only when it is a real translation, and clips it', () => {
  const ok = parseScore('{"key":"k","score":7,"reason":"Fine reason.","flags":[],"title_en":"Project Coordinator (m/f/d)"}', 'k');
  assert.equal(ok.title_en, 'Project Coordinator (m/f/d)');
  assert.equal(parseScore('{"key":"k","score":7,"reason":"Fine reason.","flags":[],"title_en":""}', 'k').title_en, undefined);
  assert.equal(parseScore('{"key":"k","score":7,"reason":"Fine reason.","flags":[],"title_en":null}', 'k').title_en, undefined);
  assert.equal(parseScore('{"key":"k","score":7,"reason":"Fine reason.","flags":[],"title_en":42}', 'k').title_en, undefined);
  assert.equal(parseScore(`{"key":"k","score":7,"reason":"Fine reason.","flags":[],"title_en":"${'x'.repeat(300)}"}`, 'k').title_en?.length, 160);
});

test('prompt keeps the posting inside a delimited untrusted block and trims long JDs', () => {
  const m = buildMessages({ rubric: 'R', cv: 'C', job: job('k', { company: 'Co', title: 'T', jd: 'x'.repeat(50000) }), translateTitle: false });
  assert.match(m[0]?.content ?? '', /never instructions/);
  assert.ok(m[1]?.content.includes('<<<POSTING'));
  assert.ok((m[1]?.content.length ?? 0) < 7000);
});

test('prompt asks for title_en only when translation is on, and has no feedback section', () => {
  const j = job('k', { company: 'Co', title: 'Projektkoordination', jd: 'x' });
  const off = buildMessages({ rubric: 'R', cv: 'C', job: j, translateTitle: false })[0]?.content ?? '';
  assert.doesNotMatch(off, /title_en/);
  assert.doesNotMatch(off, /CORRECTED/);
  const on = buildMessages({ rubric: 'R', cv: 'C', job: j, translateTitle: true })[0]?.content ?? '';
  assert.match(on, /title_en/);
  assert.match(on, /already English/);
});

test('scoreJob refuses a context that buildScoreContext did not build', async () => {
  const { keys, fetchImpl } = scorer();
  const handMade = { rubric: 'R', cv: 'C', llm, translateTitle: false, masked: true } as unknown as MaskedContext;
  await assert.rejects(scoreJob(handMade, job('a'), { fetchImpl }), /refusing to score/);
  const copied = { ...ctxOf() } as MaskedContext;
  await assert.rejects(scoreJob(copied, job('a'), { fetchImpl }), /refusing to score/);
  assert.equal(keys.length, 0); // nothing was sent
  const r = await scoreJob(ctxOf(), job('a'), { fetchImpl });
  assert.deepEqual([r.key, r.score, r.model], ['a', 6, 'one:m']);
});

test('scoreAll calls onResult once per scored job and writes no files', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sc-'));
  const realCwd = process.cwd();
  process.chdir(cwd);
  const { keys, fetchImpl } = scorer();
  const seen: ScoreResult[] = [];
  try {
    const r = await withFetch(fetchImpl, () => scoreAll(ctxOf(), [job('a'), job('b'), job('c')], {
      log() {}, onResult: async (x) => { seen.push(x); },
    }));
    assert.deepEqual(seen.map((x) => x.key).sort(), ['a', 'b', 'c']);
    assert.deepEqual(r.results.map((x) => x.key).sort(), ['a', 'b', 'c']);
    assert.deepEqual(keys.sort(), ['a', 'b', 'c']);
    assert.equal(r.tokens, 30); assert.deepEqual(r.models, { 'one:m': 3 }); assert.equal(r.aborted, null); assert.equal(r.left, 0);
    assert.deepEqual(readdirSync(cwd), []);
  } finally { process.chdir(realCwd); }
});

test('scoreAll: a failing onResult counts as an error for that job, not a result', async () => {
  const { fetchImpl } = scorer();
  const r = await withFetch(fetchImpl, () => scoreAll(ctxOf(), [job('a'), job('b')], {
    concurrency: 1, log() {}, onResult: async (x) => { if (x.key === 'a') throw new Error('board down'); },
  }));
  assert.deepEqual(r.results.map((x) => x.key), ['b']);
  assert.deepEqual(r.errors, [{ key: 'a', error: 'board down' }]);
});

/** Run f with every setTimeout firing at once. */
async function fast<T>(f: () => Promise<T>): Promise<T> {
  const t = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => t(fn, 0)) as typeof setTimeout;
  try { return await f(); } finally { globalThis.setTimeout = t; }
}
const limited: FetchJson = async () => ({ status: 429, ok: false, text: async () => 'rate limit', json: async () => ({}), headers: new Headers() });
const two = (n: number): LlmConfig => ({ name: `a${n}`, baseUrl: 'http://a', apiKey: 'k', model: 'm',
  providers: [{ name: `sa${n}`, baseUrl: 'http://a', apiKey: 'k', model: 'm' }, { name: `sb${n}`, baseUrl: 'http://b', apiKey: 'k', model: 'm' }] });

test('scoreAll stops at the first QuotaExhausted and leaves the rest untouched for the next run', async () => {
  const jobs = Array.from({ length: 20 }, (_, i) => job(`j${i}`));
  const r = await withFetch(limited, () => fast(() => scoreAll(ctxOf(two(4)), jobs, { concurrency: 2, log() {}, outagePauseMs: 0 })));
  assert.ok(r.aborted); assert.equal(r.results.length, 0);
  assert.ok(r.errors.length <= 3, `errors ${r.errors.length}`); // not one per job
  assert.ok(r.left >= 17, `left ${r.left}`);
});

test('scoreAll honours the time budget', async () => {
  const r = await scoreAll(ctxOf(), [job('a')], { deadline: Date.now() - 1, log() {} });
  assert.equal(r.aborted, 'time budget used up'); assert.equal(r.left, 1);
});

test('scoreAll rides out a short provider outage instead of stopping the run', async () => {
  let calls = 0;
  const realNow = Date.now, realTimeout = globalThis.setTimeout;
  let offset = 0; // fake clock: a pause advances time, so the providers' 2 min cool-down really ends
  Date.now = () => realNow() + offset;
  globalThis.setTimeout = ((fn: () => void, ms = 0) => { offset += ms; return realTimeout(fn, 0); }) as typeof setTimeout;
  const flaky: FetchJson = async () => (++calls <= 4
    ? { status: 502, ok: false, headers: new Headers(), text: async () => '', json: async () => ({}) }
    : { status: 200, ok: true, text: async () => '', json: async () => ({ choices: [{ message: { content: '{"key":"j0","score":5,"reason":"fine reason","flags":[]}' } }], usage: {} }) });
  try {
    const r = await withFetch(flaky, () => scoreAll(ctxOf(two(5)), [job('j0')], { concurrency: 1, log() {}, outagePauseMs: 130000 }));
    assert.equal(r.aborted, null); assert.equal(r.results.length, 1);
  } finally { Date.now = realNow; globalThis.setTimeout = realTimeout; }
});

test('shareOf splits what is left among the people still to come', () => {
  assert.equal(shareOf(40, 2), 20);
  assert.equal(shareOf(41, 2), 20);
  assert.equal(shareOf(35, 1), 35); // unused time rolls over to the last person
  assert.equal(shareOf(0, 3), 0);
  assert.equal(shareOf(-5, 2), 0);
  assert.equal(shareOf(10, 0), 0);
});
