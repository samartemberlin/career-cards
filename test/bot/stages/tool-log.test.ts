import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseToolLog } from '../../../src/bot/stages/tool-log.ts';

// Captured from `claude -p --output-format stream-json --verbose` (Claude Code 2.1.322) with MODEL_TOOL_FLAGS.web,
// then scrubbed of session ids and local paths.
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/claude/${name}`, import.meta.url), 'utf8');

const line = (o: object) => JSON.stringify(o);
const fetchUse = (id: string, url: string) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'WebFetch', input: { url, prompt: 'p' } }] } });
const toolResult = (id: string, extra: object = {}, top: object = {}) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'page text', ...extra }] }, ...top });
const resultEvent = (o: object = {}) =>
  line({ type: 'result', is_error: false, result: 'done', api_error_status: null, usage: { input_tokens: 3, output_tokens: 4 }, ...o });

test('parseToolLog reads the captured stream', () => {
  const log = parseToolLog(fixture('research-stream.jsonl'));
  assert.deepEqual(log.tools, ['WebFetch', 'WebSearch']);
  assert.ok(log.fetches.some((f) => f.url === 'https://example.com' && f.ok));
  assert.ok(log.fetches.some((f) => f.url.includes('nonexistent.invalid') && !f.ok));
  assert.ok(log.searches.length >= 1);
  assert.ok(log.result?.trim());
  assert.equal(log.isError, false);
  assert.equal(log.apiErrorStatus, null);
  assert.ok((log.usage.prompt_tokens ?? 0) > 0 && (log.usage.completion_tokens ?? 0) > 0);
});

test('parseToolLog: a WebFetch answered with HTTP 404 is not ok, though the CLI does not mark it is_error', () => {
  const log = parseToolLog(fixture('research-stream-404.jsonl'));
  assert.equal(log.fetches.length, 1);
  assert.equal(log.fetches[0]?.ok, false);
});

test('parseToolLog without a result event is an error', () => {
  const log = parseToolLog([fetchUse('a', 'https://a.example'), toolResult('a')].join('\n'));
  assert.equal(log.isError, true);
  assert.equal(log.result, null);
  assert.equal(log.tools, null);
  assert.deepEqual(log.fetches, [{ url: 'https://a.example', ok: true }]);
});

test('parseToolLog ignores garbage lines', () => {
  const stdout = ['not json', '{"type":', '', '42', 'null', '[]', '{"type":"user","message":null}',
    '{"type":"assistant","message":{"content":"text"}}', fetchUse('a', 'https://a.example'), toolResult('a'), resultEvent()].join('\n');
  const log = parseToolLog(stdout);
  assert.deepEqual(log.fetches, [{ url: 'https://a.example', ok: true }]);
  assert.equal(log.result, 'done');
  assert.equal(log.isError, false);
  assert.deepEqual(log.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('parseToolLog: a WebFetch with no tool_result counts as not ok', () => {
  const log = parseToolLog([fetchUse('a', 'https://a.example'), fetchUse('b', 'https://b.example'), toolResult('b'), resultEvent()].join('\n'));
  assert.deepEqual(log.fetches, [{ url: 'https://a.example', ok: false }, { url: 'https://b.example', ok: true }]);
});

test('parseToolLog: is_error or a non-2xx status makes a fetch not ok; other tools and odd inputs are skipped', () => {
  const stdout = [
    fetchUse('a', 'https://a.example'), toolResult('a', { is_error: true }),
    fetchUse('b', 'https://b.example'), toolResult('b', {}, { tool_use_result: { code: 301, url: 'https://b.example' } }),
    fetchUse('c', 'https://c.example'), toolResult('c', {}, { tool_use_result: { code: 200 } }),
    line({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'd', name: 'WebFetch', input: {} },
      { type: 'tool_use', name: 'WebFetch', input: { url: 'https://no-id.example' } },
      { type: 'tool_use', id: 'e', name: 'WebSearch', input: { query: 'acme engineering blog' } },
      { type: 'tool_use', id: 'f', name: 'Bash', input: { command: 'ls' } },
    ] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'orphan' }] } }),
    resultEvent({ is_error: true, api_error_status: 429, result: 'limit' }),
  ].join('\n');
  const log = parseToolLog(stdout);
  assert.deepEqual(log.fetches, [
    { url: 'https://a.example', ok: false }, { url: 'https://b.example', ok: false }, { url: 'https://c.example', ok: true },
    { url: 'https://no-id.example', ok: false },
  ]);
  assert.deepEqual(log.searches, ['acme engineering blog']);
  assert.deepEqual([log.isError, log.apiErrorStatus, log.result], [true, 429, 'limit']);
});
