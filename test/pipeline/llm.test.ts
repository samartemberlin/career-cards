import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  MODEL_TOOL_FLAGS, QuotaExhausted, callLLM, claudeUsage, classifyClaudeFailure, coolDown, createLimiter, isCooling, isDailyQuota,
  llmConfig, providerProblems, rankModels, retryHint, runModelProcess,
} from '../../src/pipeline/llm.ts';
import type { FetchJson, LlmConfig, Message, SpawnLike } from '../../src/pipeline/llm.ts';

// A fetch stand-in: only the fields the LLM layer reads.
type Res = Awaited<ReturnType<FetchJson>>;
const okJson = (content: string, usage: object = {}): Res =>
  ({ status: 200, ok: true, json: async () => ({ choices: [{ message: { content } }], usage }), text: async () => '' });
const status = (code: number, text = ''): Res =>
  ({ status: code, ok: false, text: async () => text, json: async () => ({}), headers: new Headers() });

/** Run f with every setTimeout firing at once (backoff and pacing sleeps). */
async function fast<T>(f: () => Promise<T>): Promise<T> {
  const t = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => t(fn, 0)) as typeof setTimeout;
  try { return await f(); } finally { globalThis.setTimeout = t; }
}

test('llmConfig: provider order comes from settings, keys from env; explicit LLM_* wins and is used alone', () => {
  const both = llmConfig({ GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' }, { providers: ['gemini', 'openrouter'] });
  assert.deepEqual(both.providers?.map((p) => p.name), ['gemini', 'openrouter']);
  assert.match(both.baseUrl, /generativelanguage/);
  assert.deepEqual(llmConfig({ OPENROUTER_API_KEY: 'o' }, { providers: ['gemini', 'openrouter'] }).providers?.map((p) => p.name), ['openrouter']);
  const env = { GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o', LLM_PROVIDERS: 'gemini' };
  assert.deepEqual(llmConfig(env, { providers: ['openrouter', 'gemini'] }).providers?.map((p) => p.name), ['openrouter', 'gemini']);
  const custom = llmConfig({ GEMINI_API_KEY: 'g', LLM_BASE_URL: 'http://x/', LLM_API_KEY: 'l', LLM_MODEL: 'm' }, { providers: ['gemini'] });
  assert.deepEqual(custom.providers?.map((p) => [p.name, p.apiKey, p.baseUrl]), [['custom', 'l', 'http://x']]);
  assert.equal(llmConfig({}, { providers: [] }).name, 'none');
});

test('llmConfig: settings.models pins a provider model', () => {
  const c = llmConfig({ GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' }, { providers: ['gemini', 'openrouter'], models: { openrouter: 'x/y:free' } });
  assert.equal(c.providers?.[1]?.model, 'x/y:free');
  assert.equal(c.providers?.[1]?.auto, false);
  assert.equal(c.providers?.[0]?.model, 'gemini-flash-lite-latest');
  assert.equal(c.providers?.[0]?.auto, true);
});

test('any OpenAI-compatible provider can be added by naming convention; known hosts need only a model', () => {
  const env = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'a', GROQ_MODEL: 'm1',
    MY_HOST_API_KEY: 'b', MY_HOST_MODEL: 'm2', MY_HOST_BASE_URL: 'https://h.example/v1/', CEREBRAS_API_KEY: 'c' };
  const settings = { providers: ['gemini', 'groq', 'my-host', 'cerebras'] };
  const list = llmConfig(env, settings).providers ?? [];
  assert.deepEqual(list.map((p) => p.name), ['gemini', 'groq', 'my-host']); // cerebras has no model → skipped
  assert.equal(list[1]?.baseUrl, 'https://api.groq.com/openai/v1'); assert.equal(list[1]?.model, 'm1');
  assert.equal(list[2]?.baseUrl, 'https://h.example/v1');
  assert.deepEqual(providerProblems(env, settings), ['cerebras: skipped, needs CEREBRAS_API_KEY, CEREBRAS_MODEL']);
  assert.deepEqual(providerProblems({ ...env, CEREBRAS_MODEL: 'x' }, settings), []);
  assert.deepEqual(providerProblems(env, { ...settings, models: { cerebras: 'x' } }), []); // a model from settings counts
  assert.deepEqual(providerProblems({ GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' }, { providers: ['gemini', 'openrouter'] }), []);
  assert.match(providerProblems({ GEMINI_API_KEY: 'g' }, { providers: ['weird'] })[0] ?? '', /WEIRD_API_KEY, WEIRD_MODEL and WEIRD_BASE_URL/);
});

test('llmConfig: cloudflare needs account id and token, and builds its account-scoped URL', () => {
  const settings = { providers: ['cloudflare'] };
  const c = llmConfig({ CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 't' }, settings).providers?.[0];
  assert.equal(c?.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acc1/ai/v1');
  assert.match(c?.model ?? '', /^@cf\//);
  assert.equal(providerProblems({ CLOUDFLARE_API_TOKEN: 't' }, settings).length, 1); // no account id → skipped
});

test('retryHint reads the server message and the Retry-After header', () => {
  assert.equal(retryHint('quota exceeded. Please retry in 8.615148009s.', null), 8.615148009);
  assert.equal(retryHint('', '30'), 30);
  assert.equal(retryHint('nothing here', null), null);
});

test('limiter spaces concurrent callers by 60/rpm and rpm=0 is unlimited', async () => {
  const wait = createLimiter(1200); // 50ms gap
  const t = Date.now();
  await Promise.all([wait(), wait(), wait(), wait()]);
  const el = Date.now() - t;
  assert.ok(el >= 140 && el < 600, `elapsed ${el}`);
  const free = createLimiter(0); const t2 = Date.now(); await Promise.all([free(), free(), free()]);
  assert.ok(Date.now() - t2 < 30);
  const s = { providers: ['gemini'] };
  assert.equal(llmConfig({}, s).rpm, 12); assert.equal(llmConfig({ LLM_RPM: '0' }, s).rpm, 0);
  assert.equal(typeof llmConfig({ GEMINI_API_KEY: 'g' }, s).providers?.[0]?.wait, 'function'); // pacing is wired in
});

test('callLLM fails over to the next provider when the first is out of quota, and remembers it', async () => {
  const hits: string[] = [];
  const fetchImpl: FetchJson = async (url) => { hits.push(url); return url.includes('first') ? status(429, 'quota') : okJson('{"ok":1}'); };
  const cfg: LlmConfig = { name: 'first', baseUrl: 'http://first', apiKey: 'a', model: 'm',
    providers: [{ name: 'first', baseUrl: 'http://first', apiKey: 'a', model: 'm' }, { name: 'second', baseUrl: 'http://second', apiKey: 'b', model: 'n' }] };
  await fast(async () => {
    const r1 = await callLLM(cfg, [], { fetchImpl });
    assert.equal(r1.provider, 'second');
    const before = hits.length;
    await callLLM(cfg, [], { fetchImpl });
    assert.equal(hits.slice(before).filter((u) => u.includes('first')).length, 0); // cooling down
  });
});

test('callLLM: one provider, all fail → clear error', async () => {
  await fast(() => assert.rejects(
    callLLM({ name: 'solo', apiKey: 'k', baseUrl: 'http://x', model: 'm' }, [], { fetchImpl: async () => status(500), retries: 1 }),
    /all providers failed: solo: HTTP 500/,
  ));
});

test('callLLM retries 429 then succeeds', async () => {
  let n = 0;
  const fetchImpl: FetchJson = async () => (++n < 2 ? status(429) : okJson('{}'));
  await fast(() => callLLM({ apiKey: 'k', baseUrl: 'http://x', model: 'm' }, [], { fetchImpl }));
  assert.equal(n, 2);
});

const limited = (text = 'rate limit'): FetchJson => async () => status(429, text);
const twoProviders = (n: number): LlmConfig => ({ name: `a${n}`, baseUrl: 'http://a', apiKey: 'k', model: 'm',
  providers: [{ name: `a${n}`, baseUrl: 'http://a', apiKey: 'k', model: 'm' }, { name: `b${n}`, baseUrl: 'http://b', apiKey: 'k', model: 'm' }] });

test('both providers rate-limited: fails fast with QuotaExhausted instead of waiting forever', async () => {
  const cfg = twoProviders(1); let calls = 0;
  const counting: FetchJson = async (...a) => { calls++; return limited()(...a); };
  await fast(async () => {
    await assert.rejects(callLLM(cfg, [], { fetchImpl: counting }), QuotaExhausted);
    const before = calls;
    await assert.rejects(callLLM(cfg, [], { fetchImpl: counting }), /cooling down/); // second call: no requests at all
    assert.equal(calls, before);
  });
});

test('daily quota errors are recognised and park the provider for hours', async () => {
  assert.ok(isDailyQuota('Quota exceeded for metric ... PerDay')); assert.ok(isDailyQuota('free-models-per-day limit')); assert.ok(!isDailyQuota('retry in 8s'));
  await fast(() => assert.rejects(callLLM(twoProviders(2), [], { fetchImpl: limited('Quota exceeded: requests per day') }), QuotaExhausted));
  // a cooled provider is skipped, so a later healthy second provider would serve at once
  const ok: FetchJson = async (u) => (u.includes('//b') ? okJson('{}') : status(429, 'requests per day'));
  assert.equal((await fast(() => callLLM(twoProviders(3), [], { fetchImpl: ok }))).provider, 'b3');
});

test('rankModels: newest flash-lite first for gemini, free JSON-capable text models for openrouter', () => {
  const g = rankModels('gemini', ['models/gemini-3.1-flash-lite', 'models/gemini-3.5-flash-lite', 'models/gemini-3.5-flash-lite-tts', 'models/gemini-3.8-flash', 'models/gemma-4-31b', 'models/gemini-3.5-flash-live'].map((id) => ({ id })));
  assert.deepEqual(g, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash']);
  const o = rankModels('openrouter', [
    { id: 'a/small:free', context_length: 65536, supported_parameters: ['response_format'] },
    { id: 'b/big:free', context_length: 262144, supported_parameters: ['response_format'] },
    { id: 'c/nojson:free', context_length: 262144, supported_parameters: [] },
    { id: 'd/paid', context_length: 262144, supported_parameters: ['response_format'] },
    { id: 'e/guard:free', context_length: 262144, supported_parameters: ['response_format'] },
  ]);
  assert.deepEqual(o, ['b/big:free', 'a/small:free']);
});

test('callLLM: a withdrawn default model (404) is replaced by one the provider lists now; a pinned model is not', async () => {
  const mk = (auto: boolean): LlmConfig => ({ name: 'openrouter', apiKey: 'k', baseUrl: 'http://x', model: 'old:free', auto });
  const fetchImpl: FetchJson = async (url, init) => {
    if (url.endsWith('/models')) return { status: 200, ok: true, text: async () => '', json: async () => ({ data: [{ id: 'new:free', context_length: 100000, supported_parameters: ['response_format'] }] }) };
    const model = JSON.parse(String(init?.body)).model;
    return model === 'old:free' ? status(404, 'Not found') : okJson('{}');
  };
  const cfg = mk(true);
  const log: string[] = [];
  assert.equal((await callLLM(cfg, [], { fetchImpl, log: (m) => log.push(m) })).model, 'new:free');
  assert.equal(cfg.model, 'new:free');
  assert.match(log[0] ?? '', /old:free is gone, now using new:free/);
  await assert.rejects(callLLM(mk(false), [], { fetchImpl }), /HTTP 404/);
});

// --- claude provider: the real `claude -p` CLI, here replaced by a fake runner ---
const cliOut = (o: object): string =>
  JSON.stringify({ is_error: false, usage: { input_tokens: 2, cache_creation_input_tokens: 600, output_tokens: 50 }, ...o });
const userMsg: Message[] = [{ role: 'user', content: 'x' }];

test('claude provider: configured by token or CLAUDE_USE_LOGIN, flagged otherwise', () => {
  const s = { providers: ['claude'] };
  assert.deepEqual(llmConfig({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, s).providers?.map((p) => [p.name, p.kind, p.model]), [['claude', 'claude-cli', 'haiku']]);
  assert.equal(llmConfig({ CLAUDE_USE_LOGIN: '1' }, s).providers?.[0]?.name, 'claude');
  assert.match(providerProblems({}, s)[0] ?? '', /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('claude provider: no tools, minimal env, no saved session, posting on stdin not argv, usage mapped', async () => {
  const cfg = llmConfig({ CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_MODEL: 'sonnet', PATH: '/bin', HOME: '/h', SECRET: 's' }, { providers: ['claude'] });
  let seen: { args: string[]; input: string; opts: Parameters<typeof runModelProcess>[2] } | undefined;
  const execImpl: typeof runModelProcess = async (args, input, opts) => {
    seen = { args, input, opts };
    return cliOut({ result: '{"key":"k","score":6,"reason":"fits well","flags":[]}' });
  };
  const msgs: Message[] = [{ role: 'system', content: 'RUBRIC' }, { role: 'user', content: 'SECRET-POSTING' }];
  const r = await callLLM(cfg, msgs, { execImpl });
  assert.deepEqual([r.provider, r.model, r.usage.total_tokens], ['claude', 'sonnet', 652]);
  assert.ok(seen);
  const a = seen.args;
  assert.equal(seen.opts.tools, 'none');
  assert.deepEqual(seen.opts.env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.ok(seen.opts.cwd);
  assert.ok(a.includes('--no-session-persistence') && a.includes('--disable-slash-commands'));
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.equal(a[a.indexOf('--system-prompt') + 1], 'RUBRIC');
  assert.ok(seen.input.includes('SECRET-POSTING') && !a.some((x) => x.includes('SECRET-POSTING')));
});

test('claude provider: local login passes no token, only PATH and HOME', async () => {
  const cfg = llmConfig({ CLAUDE_USE_LOGIN: '1', PATH: '/bin', HOME: '/h' }, { providers: ['claude'] });
  let env: Record<string, string> | undefined;
  await callLLM(cfg, userMsg, { execImpl: async (_a, _i, o) => { env = o.env; return cliOut({ result: 'ok' }); } });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('claude provider: usage limit and auth errors park the provider; plain errors throw QuotaExhausted', async () => {
  const cfg = () => llmConfig({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, { providers: ['claude'] });
  const failing = (stdout: string): typeof runModelProcess => async () => {
    throw Object.assign(new Error('claude exited with code 1'), { code: 1, stdout, stderr: '' });
  };
  const limit = failing(cliOut({ is_error: true, api_error_status: 429, result: 'Claude usage limit reached. Your limit resets at 5pm' }));
  await assert.rejects(callLLM(cfg(), userMsg, { execImpl: limit }), (e) => e instanceof QuotaExhausted && !e.transient);
  const auth = failing(cliOut({ is_error: true, api_error_status: 401, result: 'Invalid authentication credentials' }));
  await assert.rejects(callLLM(cfg(), userMsg, { execImpl: auth }), /auth failed/);
  const errOnZero: typeof runModelProcess = async () => cliOut({ is_error: true, result: 'something broke' });
  await assert.rejects(callLLM(cfg(), userMsg, { execImpl: errOnZero }), /claude CLI error/);
  const boom: typeof runModelProcess = async () => { throw new Error('spawn claude ENOENT'); };
  await assert.rejects(callLLM(cfg(), userMsg, { execImpl: boom }), QuotaExhausted);
});

test('classifyClaudeFailure: 401 → 6 h cool, usage limit → 6 h, other → 2 min', () => {
  const HOUR = 3600 * 1000;
  const base = { code: 1, stderr: '', stdout: '' };
  const auth = classifyClaudeFailure({ ...base, apiErrorStatus: 401, result: 'Invalid authentication credentials' });
  assert.match(auth.message, /auth failed/);
  assert.equal(auth.coolMs, 6 * HOUR);
  assert.equal(classifyClaudeFailure({ ...base, stderr: 'Not logged in' }).coolMs, 6 * HOUR);
  const limit = classifyClaudeFailure({ ...base, apiErrorStatus: 429, result: 'Claude usage limit reached. Your limit resets at 5pm' });
  assert.match(limit.message, /claude CLI limit/);
  assert.equal(limit.coolMs, 6 * HOUR);
  assert.equal(classifyClaudeFailure({ ...base, result: 'API overloaded' }).coolMs, 120000);
  const other = classifyClaudeFailure({ ...base, result: 'something\n  broke' });
  assert.equal(other.message, 'claude CLI error (exit 1): something broke');
  assert.equal(other.coolMs, 120000);
  assert.match(classifyClaudeFailure({ code: 2, stderr: '', stdout: 'raw out' }).message, /exit 2\): raw out/);
});

test('claudeUsage maps the CLI usage, cache reads counted as prompt tokens', () => {
  assert.deepEqual(claudeUsage({ input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 8, output_tokens: 50 }),
    { prompt_tokens: 610, completion_tokens: 50, total_tokens: 660 });
  assert.deepEqual(claudeUsage(undefined), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('isCooling is true after coolDown and false after it passes; a shorter cool never shortens a longer one', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  assert.equal(isCooling('cool-test'), false);
  coolDown('cool-test', 1000);
  assert.equal(isCooling('cool-test'), true);
  coolDown('cool-test', 10);
  t.mock.timers.tick(999);
  assert.equal(isCooling('cool-test'), true);
  t.mock.timers.tick(1);
  assert.equal(isCooling('cool-test'), false);
});

test('claude paces on its own limit, so the free tiers keep theirs', () => {
  const rpmOf = (env: Record<string, string>, name: string) =>
    llmConfig({ CLAUDE_USE_LOGIN: '1', GEMINI_API_KEY: 'k', ...env }, { providers: ['claude', 'gemini'] }).providers?.find((p) => p.name === name)?.rpm;
  assert.equal(rpmOf({}, 'claude'), 30);
  assert.equal(rpmOf({}, 'gemini'), 12);
  assert.equal(rpmOf({ CLAUDE_RPM: '10' }, 'claude'), 10);
  assert.equal(rpmOf({ CLAUDE_RPM: '' }, 'claude'), 30); // an unset GitHub variable arrives as an empty string
  assert.equal(rpmOf({ LLM_RPM: '5' }, 'claude'), 30);
  assert.equal(rpmOf({ LLM_RPM: '5' }, 'gemini'), 5);
});

// --- runModelProcess: a spawn stand-in runs `node` instead of `claude` ---
const nodeInstead = (script: string, seen: { cmd?: string; args?: string[]; cwd?: string } = {}): SpawnLike =>
  (cmd, args, options) => {
    Object.assign(seen, { cmd, args, cwd: options.cwd });
    return spawn(process.execPath, ['-e', script], options);
  };

// Variables some OSes add to every child on their own; none on Linux.
const OS_ADDED = new Set(['__CF_USER_TEXT_ENCODING']);

test('runModelProcess passes only the given env', async () => {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FOO: '1' };
  process.env.CAREER_CARDS_TEST_LEAK = 'leak'; // set in the parent: must not reach the child
  try {
    const out = await runModelProcess(['-p'], '', {
      env, cwd: process.cwd(), tools: 'none',
      spawnImpl: nodeInstead('console.log(Object.keys(process.env).sort().join(","))'),
    });
    const keys = out.trim().split(',').filter((k) => !OS_ADDED.has(k));
    assert.deepEqual(keys, ['FOO', 'HOME', 'PATH']);
  } finally { delete process.env.CAREER_CARDS_TEST_LEAK; }
});

test('runModelProcess: tool flags, cwd and stdin', async () => {
  const seen: { cmd?: string; args?: string[]; cwd?: string } = {};
  const out = await runModelProcess(['-p', '--model', 'haiku'], 'POSTING', {
    env: { PATH: process.env.PATH ?? '' }, cwd: '/', tools: 'none',
    spawnImpl: nodeInstead('process.stdin.pipe(process.stdout)', seen),
  });
  assert.equal(out, 'POSTING');
  assert.equal(seen.cmd, 'claude');
  assert.equal(seen.cwd, '/');
  assert.deepEqual(seen.args, ['-p', '--model', 'haiku', ...MODEL_TOOL_FLAGS.none]);
  const a = seen.args ?? [];
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));

  const web: { args?: string[] } = {};
  await runModelProcess([], '', { env: {}, cwd: '/', tools: 'web', spawnImpl: nodeInstead('', web) });
  const w = web.args ?? [];
  assert.equal(w[w.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(w[w.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
});

test('runModelProcess: a non-zero exit rejects with code, stdout and stderr', async () => {
  await assert.rejects(
    runModelProcess([], '', { env: {}, cwd: '/', tools: 'none',
      spawnImpl: nodeInstead('process.stdout.write("{}"); process.stderr.write("bad"); process.exit(3)') }),
    (e: Error & { code?: number; stdout?: string; stderr?: string }) => e.code === 3 && e.stdout === '{}' && e.stderr === 'bad',
  );
});

test('MODEL_TOOL_FLAGS.none disables all tools and MCP servers', () => {
  assert.deepEqual([...MODEL_TOOL_FLAGS.none], ['--tools', '', '--strict-mcp-config']);
});

test('MODEL_TOOL_FLAGS.web names exactly WebSearch,WebFetch', () => {
  assert.deepEqual([...MODEL_TOOL_FLAGS.web],
    ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--strict-mcp-config']);
});

// --- aborts: the caller gave up, so it is not a provider failure ---
const alphaBeta = () => llmConfig({
  ALPHA_API_KEY: 'a', ALPHA_MODEL: 'm', ALPHA_BASE_URL: 'http://alpha.example/v1',
  BETA_API_KEY: 'b', BETA_MODEL: 'm', BETA_BASE_URL: 'http://beta.example/v1', LLM_RPM: '0',
}, { providers: ['alpha', 'beta'] });

test('an aborted stage call stops the HTTP request and does not fail over', async () => {
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const ac = new AbortController();
  const hanging: FetchJson = (url, init) => {
    urls.push(url);
    const s = init?.signal as AbortSignal;
    signals.push(s);
    if (urls.length === 1) queueMicrotask(() => ac.abort());
    return new Promise((_res, rej) => s.addEventListener('abort', () => rej(s.reason), { once: true }));
  };
  await assert.rejects(callLLM(alphaBeta(), userMsg, { fetchImpl: hanging, signal: ac.signal }), { name: 'AbortError' });
  assert.deepEqual(urls, ['http://alpha.example/v1/chat/completions']);
  assert.equal(signals[0]?.aborted, true);

  const after: string[] = [];
  const ok: FetchJson = async (url) => { after.push(url); return okJson('{"x":1}'); };
  await callLLM(alphaBeta(), userMsg, { fetchImpl: ok });
  assert.deepEqual(after, ['http://alpha.example/v1/chat/completions'], 'alpha was not cooled down');
});

test('an already-aborted signal makes no call', async () => {
  let calls = 0;
  const f: FetchJson = async () => { calls++; return okJson('{}'); };
  await assert.rejects(callLLM(alphaBeta(), userMsg, { fetchImpl: f, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('an aborted signal wins over every other outcome, even with no provider to try', async () => {
  await assert.rejects(callLLM({ ...alphaBeta(), providers: [] }, userMsg, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('an abort during claude does not cool the provider down', async () => {
  const cfg = () => llmConfig({ CLAUDE_CODE_OAUTH_TOKEN: 't', GEMINI_API_KEY: 'g', CLAUDE_RPM: '0', LLM_RPM: '0' }, { providers: ['claude', 'gemini'] });
  const ac = new AbortController();
  let gotSignal: AbortSignal | undefined;
  const execImpl: typeof runModelProcess = (_a, _i, o) => {
    gotSignal = o.signal;
    queueMicrotask(() => ac.abort());
    return new Promise((_res, rej) => o.signal?.addEventListener('abort', () => rej(o.signal?.reason), { once: true }));
  };
  let fetched = 0;
  const fetchImpl: FetchJson = async () => { fetched++; return okJson('{}'); };
  await assert.rejects(callLLM(cfg(), userMsg, { execImpl, fetchImpl, signal: ac.signal }), { name: 'AbortError' });
  assert.equal(gotSignal?.aborted, true);
  assert.equal(fetched, 0);
  let ran = 0;
  await callLLM(cfg(), userMsg, { execImpl: async () => { ran++; return cliOut({ result: 'ok' }); }, fetchImpl });
  assert.equal(ran, 1);
});

/** A child that never exits on its own, records kill(), and exits on any signal unless `ignoresTerm`. */
function stuckChild(kills: (string | number | undefined)[], o: { ignoresTerm?: boolean } = {}): SpawnLike {
  return () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill(sig?: NodeJS.Signals | number) {
        kills.push(sig);
        if (!o.ignoresTerm || sig === 'SIGKILL') setImmediate(() => child.emit('close', null, sig ?? 'SIGTERM'));
        return true;
      },
    });
    return child as unknown as ChildProcess;
  };
}

test('an abort kills the claude child', async () => {
  const kills: (string | number | undefined)[] = [];
  const ac = new AbortController();
  const p = runModelProcess([], 'in', { env: {}, cwd: '/', tools: 'none', spawnImpl: stuckChild(kills), signal: ac.signal });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(kills, [undefined], 'no SIGKILL for a child that exited on SIGTERM');
});

test('an abort SIGKILLs a claude child that ignores SIGTERM', async () => {
  const kills: (string | number | undefined)[] = [];
  const ac = new AbortController();
  const spawnImpl = stuckChild(kills, { ignoresTerm: true });
  const p = runModelProcess([], 'in', { env: {}, cwd: '/', tools: 'none', spawnImpl, signal: ac.signal, killAfterMs: 10 });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.deepEqual(kills, [undefined]);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(kills, [undefined, 'SIGKILL']);
});

test('runModelProcess with an already-aborted signal spawns nothing', async () => {
  let spawned = 0;
  const spawnImpl: SpawnLike = (...a) => { spawned++; return stuckChild([])(...a); };
  await assert.rejects(runModelProcess([], '', { env: {}, cwd: '/', tools: 'none', spawnImpl, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(spawned, 0);
});
