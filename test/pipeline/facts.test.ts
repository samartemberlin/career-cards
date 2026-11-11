import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXTRACTOR_V, buildFactsMessages, extractAll, loadExtractor, parseFacts } from '../../src/pipeline/facts.ts';
import type { Job } from '../../src/pipeline/keys.ts';
import type { FetchJson, LlmConfig } from '../../src/pipeline/llm.ts';

const good = (o: object = {}): string => JSON.stringify({
  key: 'k', posting_lang: 'de', title_en: 'Project Coordinator (m/f/d)',
  german: { level: 'c1', spoken_heavy: true, evidence: 'verhandlungssicheres Deutsch' },
  english_working_language: false, years: { min: 3, max: 5, evidence: '3-5 Jahre Erfahrung' },
  degree_field: 'business', function: 'coordination', sector: 'ngo', seniority: 'junior',
  driving_licence: false, unpaid_internship: false, methodology: ['PRINCE2'], deadline: '2026-11-01', ...o,
});
const job = (key: string): Job => ({ key, url: `https://x.example/${key}`, company: 'Co', title: 'T', jd: 'x' });

test('parseFacts accepts a good reply', () => {
  const f = parseFacts('```json\n' + good() + '\n```', 'k');
  assert.equal(f.german.level, 'c1'); assert.equal(f.years.min, 3); assert.equal(f.title_en, 'Project Coordinator (m/f/d)');
});

test('a German requirement without a quote is unknown, not a penalty', () => {
  const f = parseFacts(good({ german: { level: 'c1', spoken_heavy: true, evidence: '' } }), 'k');
  assert.equal(f.german.level, null); assert.equal(f.german.spoken_heavy, null);
  assert.equal(parseFacts(good({ years: { min: 5, evidence: null } }), 'k').years.min, null);
});

test('parseFacts: junk values become null, never invented; bad output throws', () => {
  const f = parseFacts(good({ german: { level: 'fluentish' }, deadline: 'soon', driving_licence: 'yes', methodology: 'x' }), 'k');
  assert.equal(f.german.level, null); assert.equal(f.deadline, null); assert.equal(f.driving_licence, null); assert.deepEqual(f.methodology, []);
  assert.throws(() => parseFacts('Sure! Here you go', 'k'), /not JSON/);
  assert.throws(() => parseFacts(good(), 'other'), /key mismatch/);
});

test('prompt: untrusted block, trimmed JD, extractor text included', () => {
  const m = buildFactsMessages({ extractor: 'EXTRACT-RULES', job: { ...job('k'), jd: 'x'.repeat(50000) } });
  assert.match(m[0]?.content ?? '', /EXTRACT-RULES/); assert.match(m[0]?.content ?? '', /never instructions/);
  assert.ok(m[1]?.content.includes('<<<POSTING')); assert.ok((m[1]?.content.length ?? 0) < 7000);
});

test('loadExtractor reads the default extractor prompt', () => {
  assert.match(loadExtractor(), /Job facts extractor/);
});

function llmStub(reply: (key: string) => string) {
  const calls: string[] = [];
  const fetchImpl: FetchJson = async (_u, o) => {
    const key = /key: (\S+)/.exec(JSON.parse(String(o?.body)).messages[1].content)?.[1] ?? ''; calls.push(key);
    return { status: 200, ok: true, text: async () => '', json: async () => ({ choices: [{ message: { content: reply(key) } }], usage: { total_tokens: 1 } }) };
  };
  return { calls, fetchImpl };
}
const llm: LlmConfig = { name: 'facts-llm', apiKey: 'k', baseUrl: 'http://x', model: 'm', timeoutMs: 1000 };

test('extractAll returns one entry per job, tagged with extractor version and model', async () => {
  const { calls, fetchImpl } = llmStub((key) => good({ key }));
  const result = await extractAll({ llm, jobs: [job('a'), job('b')], extractor: 'E', fetchImpl, log() {} });
  assert.deepEqual([...result.facts.keys()].sort(), ['a', 'b']); assert.deepEqual(calls.sort(), ['a', 'b']);
  assert.equal(result.facts.get('a')?.extractor_v, EXTRACTOR_V);
  assert.equal(result.facts.get('a')?.model, 'facts-llm:m');
  assert.equal(result.facts.get('b')?.german.level, 'c1');
  assert.equal(result.tokens, 2); assert.deepEqual(result.models, { 'facts-llm:m': 2 });
});

test('extractAll: a malformed reply is left out and logged; quota exhaustion stops cleanly', async () => {
  const log: string[] = [];
  const { calls, fetchImpl } = llmStub(() => 'no json here');
  const r = await extractAll({ llm, jobs: [job('a')], extractor: 'E', fetchImpl, log: (m) => log.push(m) });
  assert.equal(r.facts.size, 0); assert.equal(calls.length, 2); // one repair retry
  assert.equal(r.tokens, 2); assert.deepEqual(r.models, {}); // the failed retry's tokens are counted too
  assert.match(log[0] ?? '', /facts failed a/);
  let n = 0;
  const quota: FetchJson = async () => { n++; return { status: 429, ok: false, headers: new Headers(), text: async () => 'per day limit', json: async () => ({}) }; };
  const q = await extractAll({ llm, jobs: [job('a'), job('b')], extractor: 'E', fetchImpl: quota, concurrency: 1, retries: 0, log() {} });
  assert.equal(q.facts.size, 0); assert.equal(n, 1); // the second job was never tried
});

test('extractAll honours the deadline', async () => {
  const { calls, fetchImpl } = llmStub((key) => good({ key }));
  const r = await extractAll({ llm, jobs: [job('a')], extractor: 'E', fetchImpl, deadline: Date.now() - 1, log() {} });
  assert.equal(r.facts.size, 0); assert.equal(calls.length, 0);
});

test('extractAll reports a malformed reply in errors', async () => {
  const { calls, fetchImpl } = llmStub(() => 'not json here');
  const r = await extractAll({ llm, jobs: [job('a')], extractor: 'E', fetchImpl, log() {} });
  assert.equal(r.facts.size, 0);
  assert.deepEqual(r.errors.map((e) => e.key), ['a']);
  assert.match(r.errors[0]?.error ?? '', /not JSON/);
  assert.equal(r.aborted, null);
  assert.equal(calls.length, 2); // one repair retry
});

test('extractAll reports quota as aborted', async () => {
  let n = 0;
  const quota: FetchJson = async () => { n++; return { status: 429, ok: false, headers: new Headers(), text: async () => 'per day limit', json: async () => ({}) }; };
  const r = await extractAll({ llm, jobs: [job('a'), job('b')], extractor: 'E', fetchImpl: quota, concurrency: 1, retries: 0, log() {} });
  assert.ok(r.aborted, 'aborted should be set');
  assert.equal(r.facts.size, 0);
  assert.equal(r.errors.length, 0); // quota is not an error; job b was never tried
  assert.equal(n, 1); // the second job was never tried
});

test("extractAll past the deadline is aborted 'time budget used up'", async () => {
  const { calls, fetchImpl } = llmStub((key) => good({ key }));
  const r = await extractAll({ llm, jobs: [job('a')], extractor: 'E', fetchImpl, deadline: Date.now() - 1, log() {} });
  assert.equal(r.aborted, 'time budget used up');
  assert.equal(r.facts.size, 0);
  assert.equal(calls.length, 0);
});

test('captured real reply (German posting, "Sehr gute Deutschkenntnisse in Wort und Schrift") parses with its evidence', () => {
  const { reply } = JSON.parse(readFileSync(new URL('../fixtures/facts-de.json', import.meta.url), 'utf8'));
  const f = parseFacts(reply, 'probe');
  assert.equal(f.german.level, 'c1'); assert.match(f.german.evidence ?? '', /Deutschkenntnisse/);
  assert.equal(f.years.min, null); assert.equal(f.posting_lang, 'de');
});
