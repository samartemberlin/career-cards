import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { QuotaExhausted, llmConfig } from '../../../src/pipeline/llm.ts';
import type { Message } from '../../../src/pipeline/llm.ts';
import { PrivacyError } from '../../../src/privacy.ts';
import {
  MASKING_REPLY, QUOTA_REPLY, StageOutputInvalid, callStage, parseJsonObject, stageErrorReply,
} from '../../../src/bot/stages/call.ts';
import { STAGE_LINE } from '../../../src/bot/prompt.ts';
import { fakeModel } from '../../support/fake-model.ts';

const SECRETS = {
  TRELLO_KEY: 'trello-key-1111', TRELLO_TOKEN: 'trello-token-2222', TRELLO_APP_SECRET: 'app-secret-3333',
  TRIGGER_SECRET: 'trigger-4444', NORTHFLANK_API_TOKEN: 'nf-token-5555', GEMINI_API_KEY: 'gemini-key-6666',
};
const ENV = { PATH: '/usr/bin', HOME: '/home/app', CLAUDE_CODE_OAUTH_TOKEN: 'tok-claude-0000', LLM_RPM: '0', CLAUDE_RPM: '0', ...SECRETS };
const MSGS: Message[] = [{ role: 'system', content: `${STAGE_LINE('reader')}\nAnswer in JSON.` }, { role: 'user', content: 'JOB TEXT' }];
const Out = z.object({ ok: z.boolean() }).strict();

test('a claude stage child gets PATH, HOME and its own token only', async () => {
  const m = fakeModel(() => '{"ok":true}');
  const r = await callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['claude'] }), call: m.call });
  assert.deepEqual(r.value, { ok: true });
  assert.equal(m.calls.length, 1);
  const c = m.calls[0]!;
  assert.equal(c.via, 'claude');
  assert.equal(c.stage, 'reader');
  assert.deepEqual(Object.keys(c.env ?? {}).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
  assert.equal(c.env?.CLAUDE_CODE_OAUTH_TOKEN, 'tok-claude-0000');
  const seen = JSON.stringify([c.env, c.args, c.user, c.system]);
  for (const v of Object.values(SECRETS)) assert.ok(!seen.includes(v), v);
  assert.equal(c.tools, 'none');
  assert.ok(c.cwd && c.cwd !== process.cwd());
  assert.equal(readdirSync(c.cwd).length, 0);
});

test('an HTTP stage call carries only its own key', async () => {
  const m = fakeModel(() => '{"ok":true}');
  await callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['gemini'] }), call: m.call });
  const c = m.calls[0]!;
  assert.equal(c.via, 'http');
  assert.deepEqual(Object.keys(c.headers ?? {}).sort(), ['authorization', 'content-type']);
  assert.equal(c.headers?.authorization, `Bearer ${SECRETS.GEMINI_API_KEY}`);
  const seen = JSON.stringify([c.url, c.system, c.user]);
  for (const v of [...Object.values(SECRETS), ENV.CLAUDE_CODE_OAUTH_TOKEN]) assert.ok(!seen.includes(v), v);
});

test('callStage accepts JSON wrapped in prose or a fence', async () => {
  for (const text of ['{"ok":true}', 'Here you go: {"ok":true} hope it helps', '```json\n{"ok":true}\n```', '```\n{"ok": true}\n```']) {
    const m = fakeModel(() => text);
    const r = await callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['gemini'] }), call: m.call });
    assert.deepEqual(r.value, { ok: true }, text);
    assert.equal(r.tokens, 10);
    assert.equal(r.model, 'gemini-flash-lite-latest');
  }
});

test('callStage rejects non-JSON and schema misses with StageOutputInvalid', async () => {
  for (const text of ['no json here', '{"ok":"yes"}', '{"ok":true,"extra":1}', '[{"ok":true}]', '{"ok":true']) {
    const m = fakeModel(() => text);
    await assert.rejects(callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['gemini'] }), call: m.call }), StageOutputInvalid, text);
  }
});

test('callStage makes one call only', async () => {
  const m = fakeModel(() => 'not json');
  await assert.rejects(callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['gemini'] }), call: m.call }), StageOutputInvalid);
  assert.equal(m.calls.length, 1);
});

test('parseJsonObject takes the outermost object and nothing else', () => {
  assert.deepEqual(parseJsonObject('x {"a":{"b":1}} y'), { a: { b: 1 } });
  assert.throws(() => parseJsonObject('42'), StageOutputInvalid);
  assert.throws(() => parseJsonObject('null'), StageOutputInvalid);
  assert.throws(() => parseJsonObject('{"a":1} and {"b":2}'), StageOutputInvalid);
});

test('stageErrorReply maps quota, masking and invalid output to the exact lines', () => {
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  assert.equal(QUOTA_REPLY, 'No AI provider is available right now (quota or outage). Try again later.');
  assert.equal(stageErrorReply(new QuotaExhausted('all providers failed'), log), QUOTA_REPLY);
  assert.equal(stageErrorReply(new PrivacyError('no personal details'), log),
    'Masking failed, so nothing was sent to a model: no personal details. Check the Personal details card.');
  assert.equal(stageErrorReply(new PrivacyError('x'), log), MASKING_REPLY('x'));
  assert.equal(stageErrorReply(new StageOutputInvalid('bad'), log), "Sorry, the model's answer didn't check out. Try again.");
  assert.equal(stageErrorReply(new DOMException('aborted', 'AbortError'), log), 'Sorry, that took too long.');
  assert.equal(stageErrorReply(new DOMException('timed out', 'TimeoutError'), log), 'Sorry, that took too long.');
  assert.deepEqual(logs, []);
  assert.equal(stageErrorReply(new Error('boom\nsecond line'), log), 'Sorry, something went wrong.');
  assert.deepEqual(logs, ['stage failed: Error: boom']);
});

test('an aborted stage call replies "took too long" and makes no call', async () => {
  const m = fakeModel(() => '{"ok":true}');
  const ac = new AbortController();
  ac.abort();
  const err = await callStage(MSGS, Out, { llm: llmConfig(ENV, { providers: ['gemini', 'claude'] }), call: m.call, signal: ac.signal })
    .then(() => null, (e: unknown) => e);
  assert.equal(stageErrorReply(err, () => {}), 'Sorry, that took too long.');
  assert.equal(m.calls.length, 0);
});
