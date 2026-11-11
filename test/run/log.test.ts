import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunLog, secretsFromEnv } from '../../src/run/log.ts';

// ── secretsFromEnv ────────────────────────────────────────────────────────

test('secretsFromEnv picks TRELLO_TOKEN, GEMINI_API_KEY; skips PATH and a 4-char value', () => {
  const secrets = secretsFromEnv({
    TRELLO_TOKEN: 'tokenvalue123',
    GEMINI_API_KEY: 'keyvalue456',
    PATH: '/usr/bin:/usr/local/bin',
    SHORT_SECRET: 'ab1',
    OTHER_VAR: 'notasecretvalue',
    UNDEFINED_VAR: undefined,
  });
  assert.ok(secrets.includes('tokenvalue123'), 'TRELLO_TOKEN value should be included');
  assert.ok(secrets.includes('keyvalue456'), 'GEMINI_API_KEY value should be included');
  assert.ok(!secrets.includes('/usr/bin:/usr/local/bin'), 'PATH value should be excluded (name has no KEY/TOKEN/SECRET)');
  assert.ok(!secrets.includes('ab1'), 'SHORT_SECRET value should be excluded (< 8 chars)');
  assert.ok(!secrets.includes('notasecretvalue'), 'OTHER_VAR value should be excluded (name has no KEY/TOKEN/SECRET)');
  assert.equal(secrets.length, 2);
});

// ── createRunLog ──────────────────────────────────────────────────────────

test('createRunLog redacts every secret in the sink and in lines(), including inside a longer word', () => {
  const sinked: string[] = [];
  const log = createRunLog({
    sink: (line) => sinked.push(line),
    secrets: ['supersecret123'],
  });
  log.log('token is supersecret123 and prefixsupersecret123suffix here');
  assert.equal(sinked.length, 1);
  assert.equal(sinked[0], 'token is *** and prefix***suffix here');
  assert.deepEqual(log.lines(), ['token is *** and prefix***suffix here']);
});

test('createRunLog keeps the last 200 lines (default keep)', () => {
  const log = createRunLog({ sink: () => {}, secrets: [] });
  for (let i = 0; i < 250; i++) log.log(`line ${i}`);
  const lines = log.lines();
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'line 50');
  assert.equal(lines[199], 'line 249');
});

test('createRunLog respects explicit keep', () => {
  const log = createRunLog({ sink: () => {}, secrets: [], keep: 3 });
  log.log('a');
  log.log('b');
  log.log('c');
  log.log('d');
  assert.deepEqual(log.lines(), ['b', 'c', 'd']);
});

test('redact replaces secrets in an arbitrary string', () => {
  const log = createRunLog({ sink: () => {}, secrets: ['hunter2'] });
  assert.equal(log.redact('my password is hunter2 ok'), 'my password is *** ok');
  assert.equal(log.redact('no secret here'), 'no secret here');
});

test('createRunLog sink receives redacted lines', () => {
  const sinked: string[] = [];
  const log = createRunLog({
    sink: (line) => sinked.push(line),
    secrets: ['topsecretvalue'],
  });
  log.log('connecting with token topsecretvalue done');
  assert.equal(sinked[0], 'connecting with token *** done');
});
