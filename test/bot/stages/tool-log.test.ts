import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseToolLog } from '../../../src/bot/stages/tool-log.ts';
import { FETCH_TOOL } from '../../../src/net/fetch-tool.ts';

// Captured from `claude -p --output-format stream-json --verbose` (Claude Code 2.1.322), then scrubbed of session ids
// and local paths. research-stream-mcp.jsonl: MODEL_TOOL_FLAGS.web, fetching example.com and the metadata address.
// research-stream.jsonl: the old flags, with the CLI's WebFetch.
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/claude/${name}`, import.meta.url), 'utf8');

const line = (o: object) => JSON.stringify(o);
const fetchUse = (id: string, url: string) =>
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: FETCH_TOOL, input: { url } }] } });
const text = (t: string) => [{ type: 'text', text: t }];
const toolResult = (id: string, content: unknown = text(`status: 200 https://${id}.example/\n\npage text`), extra: object = {}) =>
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const resultEvent = (o: object = {}) =>
  line({ type: 'result', is_error: false, result: 'done', api_error_status: null, usage: { input_tokens: 3, output_tokens: 4 }, ...o });

test('parseToolLog reads the captured stream: example.com loaded, the metadata address did not', () => {
  const log = parseToolLog(fixture('research-stream-mcp.jsonl'));
  assert.deepEqual(log.tools, ['WebSearch', FETCH_TOOL]);
  assert.deepEqual(log.fetches, [
    { url: 'https://example.com/', ok: true },
    { url: 'http://169.254.169.254/latest/meta-data/', ok: false },
  ]);
  assert.deepEqual(log.searches, ['IANA example domain']);
  assert.ok(log.result?.trim());
  assert.equal(log.isError, false);
  assert.equal(log.apiErrorStatus, null);
  assert.ok((log.usage.prompt_tokens ?? 0) > 0 && (log.usage.completion_tokens ?? 0) > 0);
});

test('parseToolLog on a WebFetch stream: the tool set shows it, and its fetches are not ours', () => {
  const log = parseToolLog(fixture('research-stream.jsonl'));
  assert.deepEqual(log.tools, ['WebFetch', 'WebSearch']);
  assert.deepEqual(log.fetches, []);
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

test('parseToolLog: a fetch with no tool_result counts as not ok', () => {
  const log = parseToolLog([fetchUse('a', 'https://a.example'), fetchUse('b', 'https://b.example'), toolResult('b'), resultEvent()].join('\n'));
  assert.deepEqual(log.fetches, [{ url: 'https://a.example', ok: false }, { url: 'https://b.example', ok: true }]);
});

test('parseToolLog: loaded only when not is_error and the first line says a 2xx status', () => {
  const stdout = [
    fetchUse('a', 'https://a.example'), toolResult('a', 'blocked: not a public address', { is_error: true }),
    fetchUse('b', 'https://b.example'), toolResult('b', text('status: 404 https://b.example/\nnot loaded: HTTP 404'), { is_error: true }),
    // Without is_error a non-2xx header still fails, and so does a missing header.
    fetchUse('c', 'https://c.example'), toolResult('c', text('status: 301 https://c.example/\n\nmoved')),
    fetchUse('d', 'https://d.example'), toolResult('d', text('page text\nstatus: 200 https://d.example/')),
    fetchUse('e', 'https://e.example'), toolResult('e', 'status: 204 https://e.example/\n\n'),
    fetchUse('f', 'https://f.example'), toolResult('f', text('status: 200 https://f.example/\n\nok'), { is_error: true }),
    fetchUse('g', 'https://g.example'), toolResult('g', [{ type: 'image', data: '' }]),
    fetchUse('h', 'https://h.example'), toolResult('h', text('status: 2000 https://h.example/\n\nx')),
    line({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'x', name: FETCH_TOOL, input: {} },
      { type: 'tool_use', name: FETCH_TOOL, input: { url: 'https://no-id.example' } },
      { type: 'tool_use', id: 'w', name: 'WebFetch', input: { url: 'https://webfetch.example' } },
      { type: 'tool_use', id: 's', name: 'WebSearch', input: { query: 'acme engineering blog' } },
      { type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'ls' } },
    ] } }),
    toolResult('w', 'page'),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'orphan' }] } }),
    resultEvent({ is_error: true, api_error_status: 429, result: 'limit' }),
  ].join('\n');
  const log = parseToolLog(stdout);
  assert.deepEqual(log.fetches, [
    { url: 'https://a.example', ok: false }, { url: 'https://b.example', ok: false }, { url: 'https://c.example', ok: false },
    { url: 'https://d.example', ok: false }, { url: 'https://e.example', ok: true }, { url: 'https://f.example', ok: false },
    { url: 'https://g.example', ok: false }, { url: 'https://h.example', ok: false }, { url: 'https://no-id.example', ok: false },
  ]);
  assert.deepEqual(log.searches, ['acme engineering blog']);
  assert.deepEqual([log.isError, log.apiErrorStatus, log.result], [true, 429, 'limit']);
});
