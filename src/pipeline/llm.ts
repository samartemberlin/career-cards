// LLM layer: any OpenAI-compatible chat endpoint, plus the `claude -p` CLI. Ported from samjobs' score.mjs.
// Providers are tried in the order of `settings.providers`; one that is out of quota or down is skipped for a
// cool-down and the next one is used. API keys always come from the environment, never from settings:
//   1. explicit: LLM_BASE_URL + LLM_API_KEY (+ LLM_MODEL)   → used alone
//   2. otherwise, each name in settings.providers whose keys exist:
//        gemini      GEMINI_API_KEY      model LLM_MODEL            default gemini-flash-lite-latest
//        openrouter  OPENROUTER_API_KEY  model OPENROUTER_MODEL     default nvidia/nemotron-3.5-super-vl:free
//      If a default model (not pinned by settings.models or LLM_MODEL / OPENROUTER_MODEL) is withdrawn (HTTP 404),
//      the provider's /models list is ranked (rankModels) and the best working ones are tried; the switch is logged.
//      Any other OpenAI-compatible provider, no code change: put its name in settings.providers and set
//        <NAME>_API_KEY, a model (settings.models.<name> or <NAME>_MODEL) and (unless a known host) <NAME>_BASE_URL.
//        cloudflare  CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN  model CLOUDFLARE_MODEL  default @cf/meta/llama-4-scout-17b-16e-instruct
//        nvidia      NVIDIA_API_KEY      model NVIDIA_MODEL         default openai/gpt-oss-20b
//      Known hosts (base URL built in, model required): groq, cerebras.
//        claude      CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)  model CLAUDE_MODEL  default haiku
//                    Runs the real, unmodified `claude -p` CLI (no tools, no session saved) on the owner's own
//                    Claude subscription: Anthropic permits that for the owner's own use, not as a service for
//                    other people (https://code.claude.com/docs/en/legal-and-compliance). CLAUDE_EFFORT: low|medium|high.
//                    For local runs without a token, CLAUDE_USE_LOGIN=1 uses the CLI's own login.
//   settings.models     optional per-provider model pin, wins over the env model variables
//   LLM_REASONING_EFFORT  optional: none|low|medium|high (speed/cost vs. depth)
//   LLM_TIMEOUT_MS        per request, default 240000
//   LLM_RPM               max requests/min per provider, shared by all workers (default 12; 0 = unlimited).
//   CLAUDE_RPM            the same, for the claude provider only (default 30). Gemini's free tier allows 15/min.
// The job text is untrusted: no tools, JSON only, delimited, and validated on the way back by the caller.
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
export type LlmSettings = { providers: string[]; models?: Record<string, string> };

export type Provider = {
  name?: string;
  /** 'claude-cli': not an HTTP endpoint but the `claude -p` binary; apiKey only gates "is it configured". */
  kind?: 'claude-cli';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The model was not pinned, so if the provider says it is gone we look for a working one. */
  auto?: boolean;
  effort?: string;
  rpm?: number;
  reasoningEffort?: string;
  timeoutMs?: number;
  /** claude-cli only: the whole environment its child process gets. */
  procEnv?: Record<string, string>;
  wait?: () => Promise<void>;
  triedModels?: Set<string>;
};
export type LlmConfig = Provider & { providers?: Provider[] };

/** The slice of fetch the LLM layer uses; tests pass a stand-in. */
export type FetchJson = (url: string, init?: RequestInit) => Promise<{
  ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; headers?: { get(name: string): string | null };
}>;
export type CallOpts = {
  fetchImpl?: FetchJson; retries?: number; execImpl?: typeof runModelProcess; log?: (msg: string) => void;
  /** The caller gave up: the call rejects with its reason, tries no other provider and cools none down. */
  signal?: AbortSignal;
};
export type LlmReply = { text: string; usage: Usage; provider: string; model: string };

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const HOUR = 3600 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `p`, or a rejection with the abort reason as soon as `signal` fires. */
function orAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Spaces request starts at least 60/rpm seconds apart, across concurrent callers. */
export function createLimiter(rpm: number | undefined): () => Promise<void> {
  if (!rpm || rpm <= 0) return async () => {};
  const gap = 60000 / rpm;
  let nextSlot = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await sleep(at - now);
  };
}

/** A daily/total quota error will not clear in minutes: park that provider for hours. */
export function isDailyQuota(bodyText: string | null | undefined): boolean {
  return /per ?day|daily|free-models-per-day|requests per day/i.test(bodyText ?? '');
}

/** Seconds the server asks us to wait ("Please retry in 8.6s" or a Retry-After header), or null. */
export function retryHint(bodyText: string | null | undefined, retryAfterHeader: string | null | undefined): number | null {
  const h = Number(retryAfterHeader);
  if (Number.isFinite(h) && h > 0) return h;
  const m = /retry in ([\d.]+)\s*s/i.exec(bodyText ?? '');
  return m ? Number(m[1]) : null;
}

/** Model child processes get PATH, HOME and the one provider token they need, nothing else. */
function minimalEnv(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.PATH) out.PATH = env.PATH;
  if (env.HOME) out.HOME = env.HOME;
  return { ...out, ...extra };
}

export const PROVIDER_DEFS: Record<string, (env: Env) => Provider> = {
  claude: (env) => {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN || '';
    return {
      kind: 'claude-cli', baseUrl: '', apiKey: token || (env.CLAUDE_USE_LOGIN ? 'local-login' : ''),
      model: env.CLAUDE_MODEL || 'haiku', effort: env.CLAUDE_EFFORT || 'low', auto: false,
      rpm: env.CLAUDE_RPM ? Number(env.CLAUDE_RPM) : 30, // not a free tier: LLM_RPM's 12/min made scoring the slowest step
      procEnv: minimalEnv(env, token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    };
  },
  gemini: (env) => ({ baseUrl: DEFAULT_BASE, apiKey: env.GEMINI_API_KEY ?? '', model: env.LLM_MODEL || 'gemini-flash-lite-latest', auto: !env.LLM_MODEL }),
  // Free 10,000 Neurons/day, shared by all models; the base URL carries the account id.
  cloudflare: (env) => ({
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    apiKey: env.CLOUDFLARE_ACCOUNT_ID ? env.CLOUDFLARE_API_TOKEN ?? '' : '', model: env.CLOUDFLARE_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct', auto: false,
  }),
  // build.nvidia.com free credits. Its /models list includes models that answer 404 (withdrawn), so the default is one that was tested.
  nvidia: (env) => ({ baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: env.NVIDIA_API_KEY ?? '', model: env.NVIDIA_MODEL || 'openai/gpt-oss-20b', auto: false }),
  openrouter: (env) => ({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY ?? '', model: env.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-super-vl:free', auto: !env.OPENROUTER_MODEL }),
};

const NOT_TEXT_CHAT = /tts|live|image|audio|transcribe|embed|robotics|computer|omni|veo|lyria|banana|imagen|guard|safety|moderation|code/i;
const versionOf = (id: string): number => Number((/(\d+(?:\.\d+)?)/.exec(id) ?? [0, 0])[1]);

type ListedModel = { id: string; context_length?: number; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } };

/** Rank a provider's model list for cheap JSON scoring, best first. Pure; the list comes from the provider's /models. */
export function rankModels(name: string | undefined, models: ListedModel[]): string[] {
  const id = (m: ListedModel) => String(m.id).replace(/^models\//, '');
  if (name === 'gemini') {
    const ok = models.map(id).filter((m) => /^gemini-/.test(m) && !NOT_TEXT_CHAT.test(m));
    const lite = ok.filter((m) => /flash-lite/.test(m)), flash = ok.filter((m) => /flash/.test(m) && !/lite/.test(m));
    const pre = (m: string) => Number(/preview|exp/.test(m));
    const byNew = (a: string, b: string) => versionOf(b) - versionOf(a) || pre(a) - pre(b);
    return [...lite.sort(byNew), ...flash.sort(byNew)];
  }
  if (name === 'openrouter') {
    return models
      .filter((m) => String(m.id).endsWith(':free') && (m.supported_parameters ?? []).includes('response_format')
        && (m.architecture?.output_modalities ?? ['text']).join() === 'text' && (m.context_length ?? 0) >= 32000 && !NOT_TEXT_CHAT.test(m.id))
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0)).map(id);
  }
  return [];
}

/** Ask the provider which models it has now, ranked; empty when it cannot say. */
async function discoverModels(p: Provider, fetchImpl: FetchJson, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetchImpl(`${p.baseUrl}/models`, { headers: { authorization: `Bearer ${p.apiKey}` }, signal: signal ? AbortSignal.any([AbortSignal.timeout(20000), signal]) : AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const body = await res.json();
    return rankModels(p.name, body.data ?? body.models ?? []);
  } catch { return []; }
}

// Hosts whose base URL we know. Their model names change too often to hard-code: a model is required.
const KNOWN_HOSTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
};

const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** Generic provider from <NAME>_API_KEY / model / _BASE_URL; null if incomplete. */
function genericProvider(name: string, env: Env, model?: string): Provider | null {
  const N = envName(name);
  const apiKey = env[`${N}_API_KEY`], m = model || env[`${N}_MODEL`];
  const baseUrl = (env[`${N}_BASE_URL`] || KNOWN_HOSTS[name] || '').replace(/\/$/, '');
  return apiKey && m && baseUrl ? { name, baseUrl, apiKey, model: m } : null;
}

/** One configured provider by name, with the settings' model pin applied; null if it cannot be built. */
function buildProvider(name: string, env: Env, settings: LlmSettings): Provider | null {
  const pinned = settings.models?.[name];
  const def = PROVIDER_DEFS[name];
  if (!def) return genericProvider(name, env, pinned);
  const p: Provider = { name, ...def(env) };
  if (pinned) { p.model = pinned; p.auto = false; }
  return p;
}

/** Names in settings.providers that cannot be used, with the reason, for a loud warning. */
export function providerProblems(env: Env, settings: LlmSettings): string[] {
  if (env.LLM_BASE_URL && env.LLM_API_KEY) return [];
  const out: string[] = [];
  for (const n of settings.providers.map((x) => x.trim()).filter(Boolean)) {
    if (buildProvider(n, env, settings)?.apiKey) continue;
    const N = envName(n);
    if (n === 'claude') { out.push('claude: skipped, needs CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) or CLAUDE_USE_LOGIN=1'); continue; }
    if (n === 'cloudflare') { out.push('cloudflare: skipped, needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN'); continue; }
    out.push(`${n}: skipped, needs ${N}_API_KEY${PROVIDER_DEFS[n] ? '' : `, ${N}_MODEL${KNOWN_HOSTS[n] ? '' : ` and ${N}_BASE_URL`}`}`);
  }
  return out;
}

/** The provider list for a run: order from settings, keys from env. Each provider gets its own pacing limiter. */
export function llmConfig(env: Env, settings: LlmSettings): LlmConfig {
  const common = {
    rpm: env.LLM_RPM === undefined ? 12 : Number(env.LLM_RPM),
    reasoningEffort: env.LLM_REASONING_EFFORT || '',
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 240000,
  };
  let list: Provider[];
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    list = [{ name: 'custom', baseUrl: env.LLM_BASE_URL.replace(/\/$/, ''), apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || 'gemini-flash-lite-latest' }];
  } else {
    list = settings.providers.map((n) => n.trim()).filter(Boolean)
      .map((n) => buildProvider(n, env, settings))
      .filter((p): p is Provider => Boolean(p?.apiKey));
  }
  if (!list.length) list = [{ ...PROVIDER_DEFS.gemini!({}), name: 'none', apiKey: '' }];
  const providers = list.map((p) => {
    const full: Provider = { ...common, ...p };
    full.wait = createLimiter(full.rpm);
    return full;
  });
  return { ...providers[0]!, providers };
}

// ---- model child processes -------------------------------------------------------------------------------------------

export type SpawnLike = (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;

// Tool flags for `claude -p`, checked against `claude --help` of Claude Code 2.1.322 (2026-11-10):
//   --tools <tools...>          "Use "" to disable all tools ... or specify tool names (e.g. "Bash,Edit,Read")"
//   --allowedTools <tools...>   tools allowed without a permission prompt (none can be answered in -p mode)
//   --strict-mcp-config         "Only use MCP servers from --mcp-config": we pass none, so no MCP servers at all
// Re-check these when the CLI is upgraded: a renamed flag must not silently re-enable tools.
// `--restricted` (in the help of 2.1.323) is left out until a test shows the pinned CLI accepts it: an unknown flag
// would make every claude call fail.
export const MODEL_TOOL_FLAGS = {
  none: ['--tools', '', '--strict-mcp-config'],
  web: ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch', '--strict-mcp-config'],
} as const satisfies Record<string, readonly string[]>;

export type ModelProcessOpts = {
  timeoutMs?: number;
  /** The child's whole environment, passed as given: never merged with process.env. */
  env: Record<string, string>;
  cwd: string;
  tools: 'none' | 'web';
  spawnImpl?: SpawnLike;
  /** Kills the child; the promise rejects with the abort reason. */
  signal?: AbortSignal;
  /** After an abort, SIGKILL a child still alive this long after SIGTERM. */
  killAfterMs?: number;
};

/** A non-zero exit: what the process printed, for the caller to classify. */
export type ModelProcessError = Error & { code: number | null; stdout: string; stderr: string };

/**
 * Spawn `claude <args> <tool flags>`; resolves its stdout. stdin carries the (untrusted) input, never argv.
 * A non-zero exit rejects with a ModelProcessError; a kill (timeout) or spawn failure rejects with a plain Error.
 */
export function runModelProcess(args: string[], input: string, opts: ModelProcessOpts): Promise<string> {
  const { timeoutMs = 240000, env, cwd, tools, spawnImpl = spawn, signal, killAfterMs = 5000 } = opts;
  const toolFlags = MODEL_TOOL_FLAGS[tools];
  if (!toolFlags) return Promise.reject(new Error(`unknown tools mode: ${String(tools)}`));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawnImpl('claude', [...args, ...toolFlags], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    let killer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill();
      killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      killer.unref();
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => { signal?.removeEventListener('abort', onAbort); clearTimeout(killer); });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`claude killed by ${signal} (timeout?)`));
      if (code !== 0) return reject(Object.assign(new Error(`claude exited with code ${code}`), { code, stdout, stderr }));
      resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

// An empty directory, so the CLI picks up no CLAUDE.md or project settings. Made once per process.
let emptyDir: string | undefined;
const modelCwd = () => (emptyDir ??= mkdtempSync(join(tmpdir(), 'career-cards-model-')));

const withCool = (message: string, coolMs: number) => Object.assign(new Error(message), { coolMs });

/** One call through the Claude Code CLI. Returns the same shape as an HTTP provider call. */
async function callClaudeCli(p: Provider, messages: Message[], execImpl: typeof runModelProcess, signal?: AbortSignal): Promise<LlmReply> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  const args = ['-p', '--output-format', 'json', '--system-prompt', system, '--no-session-persistence',
    '--setting-sources', '', '--disable-slash-commands', '--model', p.model, ...(p.effort ? ['--effort', p.effort] : [])];
  await orAbort(p.wait?.() ?? Promise.resolve(), signal);
  let code: number | null = 0, stdout: string, stderr = '';
  try {
    stdout = await execImpl(args, user, { timeoutMs: p.timeoutMs ?? 240000, env: p.procEnv ?? {}, cwd: modelCwd(), tools: 'none', signal });
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    const pe = e as Partial<ModelProcessError>;
    if (typeof pe.stdout !== 'string') throw withCool(`claude CLI failed: ${(e as Error).message}`, 120000);
    ({ stdout } = pe as ModelProcessError); code = pe.code ?? null; stderr = pe.stderr ?? '';
  }
  let out: any;
  try { out = JSON.parse(stdout); } catch { out = null; }
  if (!out || code !== 0 || out.is_error) {
    const msg = String(out?.result ?? (stderr || stdout)).replace(/\s+/g, ' ').slice(0, 200);
    const status = out?.api_error_status;
    if (status === 401 || /not logged in|invalid (api key|token)|authentication|oauth/i.test(msg)) {
      throw withCool(`claude CLI auth failed (refresh CLAUDE_CODE_OAUTH_TOKEN): ${msg}`, 6 * HOUR);
    }
    if (status === 429 || /usage limit|rate limit|limit reached|overloaded/i.test(msg)) {
      throw withCool(`claude CLI limit: ${msg}`, /usage limit|limit reached|resets/i.test(msg) ? 6 * HOUR : 120000);
    }
    throw withCool(`claude CLI error (exit ${code}): ${msg}`, 120000);
  }
  if (typeof out.result !== 'string' || !out.result.trim()) throw new Error('empty completion');
  const u = out.usage ?? {};
  const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { text: out.result, usage: { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0) }, provider: p.name ?? 'claude', model: p.model };
}

type ProviderCallOpts = { fetchImpl: FetchJson; retries: number; execImpl: typeof runModelProcess; signal?: AbortSignal };

async function callProvider(p: Provider, messages: Message[], { fetchImpl, retries, execImpl, signal }: ProviderCallOpts): Promise<LlmReply> {
  if (!p.apiKey) throw new Error('no API key');
  if (p.kind === 'claude-cli') return callClaudeCli(p, messages, execImpl, signal);
  const pause = (ms: number) => orAbort(sleep(ms), signal);
  for (let attempt = 0; ; attempt++) {
    await orAbort(p.wait?.() ?? Promise.resolve(), signal);
    let res: Awaited<ReturnType<FetchJson>>;
    try {
      res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model, messages, temperature: 0, response_format: { type: 'json_object' },
          ...(p.reasoningEffort ? { reasoning_effort: p.reasoningEffort } : {}),
        }),
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(p.timeoutMs ?? 240000), signal])
          : AbortSignal.timeout(p.timeoutMs ?? 240000),
      });
    } catch (e) { // timeout / network: retry like a 5xx
      if (signal?.aborted) throw signal.reason;
      if (attempt >= retries) throw new Error(`request failed after ${retries} retries: ${(e as Error).message}`);
      await pause(2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const body = (await res.text?.().catch(() => '')) ?? '';
      const hint = retryHint(body, res.headers?.get?.('retry-after'));
      if (res.status === 429 && isDailyQuota(body)) {
        throw withCool(`HTTP 429 daily quota exhausted: ${body.replace(/\s+/g, ' ').slice(0, 120)}`, 6 * HOUR);
      }
      if (attempt >= retries) throw withCool(`HTTP ${res.status} after ${retries} retries`, Math.max(120000, (hint ?? 0) * 1000));
      await pause(Math.max(2000 * 2 ** attempt, hint ? (hint + 1) * 1000 : 0));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`), { modelGone: res.status === 404 || (res.status === 400 && /model/i.test(body)) });
    }
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty completion');
    return { text, usage: body.usage ?? {}, provider: p.name ?? 'custom', model: p.model };
  }
}

/**
 * Thrown when no provider can serve the call soon; callers treat it as "stop for this run".
 * `transient`: no provider reported a daily quota, so waiting a few minutes can help (5xx, per-minute limits).
 */
export class QuotaExhausted extends Error {
  transient: boolean;
  constructor(message: string, { transient = false }: { transient?: boolean } = {}) {
    super(message);
    this.name = 'QuotaExhausted';
    this.transient = transient;
  }
}

const coolUntil = new Map<string | undefined, number>(); // provider name → epoch ms until which it is skipped
const MAX_WAIT_MS = 60000;

type CallError = Error & { coolMs?: number; modelGone?: boolean };

/** Try each provider in order. One that exhausts its retries cools down (2 min, or hours for a daily quota). */
export async function callLLM(cfg: LlmConfig, messages: Message[], opts: CallOpts = {}): Promise<LlmReply> {
  const { fetchImpl = fetch as unknown as FetchJson, retries, execImpl = runModelProcess, log = console.log, signal } = opts;
  signal?.throwIfAborted();
  const providers = cfg.providers ?? [cfg];
  const multi = providers.length > 1;
  // With a fallback available, fail over after one retry instead of sleeping through a quota window.
  const tries = retries ?? (multi ? 1 : 4);
  const errors: string[] = [];
  let daily = false;
  const soonestCool = () => Math.min(...providers.map((p) => coolUntil.get(p.name) ?? 0)) - Date.now();
  for (let round = 0; round < 2; round++) {
    for (const p of providers) {
      if ((coolUntil.get(p.name) ?? 0) > Date.now() && multi) continue;
      signal?.throwIfAborted();
      try {
        return await callProvider(p, messages, { fetchImpl, execImpl, retries: tries, signal });
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        const e = err as CallError;
        if (e.modelGone && p.auto) { // the default model was withdrawn: try the provider's current ones, best first
          p.triedModels ??= new Set([p.model]);
          const next = (await discoverModels(p, fetchImpl, signal)).filter((m) => !p.triedModels!.has(m)).slice(0, 3);
          signal?.throwIfAborted(); // discoverModels swallows the abort as "no models"
          for (const m of next) {
            p.triedModels.add(m);
            try {
              const r = await callProvider({ ...p, model: m }, messages, { fetchImpl, execImpl, retries: tries, signal });
              log(`${p.name}: model ${p.model} is gone, now using ${m}`);
              p.model = m;
              return r;
            } catch (e2) {
              if (signal?.aborted) throw signal.reason;
              errors.push(`${p.name}/${m}: ${(e2 as Error).message}`);
            }
          }
        }
        errors.push(`${p.name ?? 'llm'}: ${e.message}`);
        if ((e.coolMs ?? 0) >= 6 * HOUR) daily = true;
        if (multi && (e.coolMs || /empty completion/.test(e.message))) coolUntil.set(p.name, Date.now() + (e.coolMs ?? 120000));
      }
    }
    if (errors.length || !multi) break;
    // Every provider was already cooling. Wait only if one is about to come back.
    const soonest = soonestCool();
    if (soonest > MAX_WAIT_MS) break;
    await orAbort(sleep(Math.max(0, soonest)), signal);
  }
  const cooling = multi && !errors.length ? 'all providers cooling down after earlier quota errors' : errors.join(' | ');
  throw new QuotaExhausted(`all providers failed: ${cooling}`, { transient: !daily && (errors.length > 0 || soonestCool() <= 10 * 60000) });
}
