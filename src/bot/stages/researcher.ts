// The researcher stage: `claude -p` with WebSearch and WebFetch only, in an empty directory, seeing the four public
// fields of ResearchInput. What it opened comes from the CLI's tool log, never from the model's own account: a point
// counts only if it cites a page that loaded, and one fetch of an internal address discards the whole run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BlockedUrlError, assertPublicUrl } from '../../net/safe-fetch.ts';
import type { UrlGuard } from '../../net/safe-fetch.ts';
import { QuotaExhausted, classifyClaudeFailure, coolDown, isCooling, runModelProcess } from '../../pipeline/llm.ts';
import type { LlmConfig, ModelProcessError, Provider } from '../../pipeline/llm.ts';
import { researcherMessages } from '../prompt.ts';
import { LINK_MAX, SAFE_LINK, linksIn } from '../reply.ts';
import { StageOutputInvalid, oneLine, parseJsonObject, stageErrorReply } from './call.ts';
import type { ResearchInput } from './research-input.ts';
import { parseToolLog } from './tool-log.ts';

export const ResearchSchema = z.object({
  summary: z.string().max(600),
  points: z.array(z.object({
    section: z.string().max(60),
    text: z.string().max(400),
    source: z.string().max(500),
  }).strict()).max(20),
}).strict();
export type Research = z.infer<typeof ResearchSchema>;

/** `sources`: the opened pages the kept points cite, as `sourceUrl` gives them, in first-cited order. */
export type ResearchResult = { research: Research; sources: string[]; tokens: number };

export class ResearchRefused extends Error {
  reason: 'no_sources' | 'internal_address' | 'tool_set';
  constructor(reason: ResearchRefused['reason']) {
    super(`research refused: ${reason}`);
    this.name = 'ResearchRefused';
    this.reason = reason;
  }
}

// Below the 300 s comment timeout: `deep` still needs an advisor call after this.
export const RESEARCH_TIMEOUT_MS = 180_000;
const MAX_TURNS = '12';
const HOUR = 3600 * 1000;
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const FOOTER_SOURCES_MAX = 8;

export const RESEARCH_UNAVAILABLE =
  "Web research needs the claude provider (CLAUDE_CODE_OAUTH_TOKEN), which isn't available right now.";

const REFUSED_REPLY: Record<ResearchRefused['reason'], string> = {
  no_sources: "Couldn't research this: no web page could be read.",
  internal_address: "Couldn't research this: a page pointed to an internal address, so the result was discarded.",
  tool_set: "Couldn't research this: web research is misconfigured. The service log has details.",
};

export function researchErrorReply(e: unknown, log: (s: string) => void = console.error): string {
  return e instanceof ResearchRefused ? REFUSED_REPLY[e.reason] : stageErrorReply(e, log);
}

/**
 * The form a page is compared and cited in: an http(s) URL without its fragment, and only if the reply's link check
 * would read it back unchanged (a URL ending in `)` or `.` would be trimmed there, so it can't be listed exactly).
 */
export function sourceUrl(u: string): string | null {
  let url: URL;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const href = url.href;
  if (href.length > LINK_MAX || !SAFE_LINK.test(href)) return null;
  const found = linksIn(href);
  return found.length === 1 && found[0] === href ? href : null;
}

/** The claude provider, the only one with web tools; null when it isn't configured or is cooling down. */
export function researcherFor(llm: LlmConfig): Provider | null {
  const p = (llm.providers ?? [llm]).find((x) => x.kind === 'claude-cli' && x.apiKey);
  return p && !isCooling(p.name ?? 'claude') ? p : null;
}

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return '(not a URL)'; } };

export async function runResearch(input: ResearchInput, o: {
  provider: Provider;
  signal: AbortSignal;
  exec?: typeof runModelProcess;
  /** Only its `lookup` is used: loopback and metadata addresses stay blocked even where tests loosen `allow`. */
  guard?: UrlGuard;
  timeoutMs?: number;
  log: (s: string) => void;
}): Promise<ResearchResult> {
  const { provider: p, signal, exec = runModelProcess, log } = o;
  const [system, user] = researcherMessages(input).map((m) => m.content);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--system-prompt', system!, '--no-session-persistence',
    '--setting-sources', '', '--disable-slash-commands', '--model', p.model, '--max-turns', MAX_TURNS];
  signal.throwIfAborted();
  await p.wait?.();
  signal.throwIfAborted();

  let stdout: string, stderr = '', code: number | null = 0;
  const cwd = mkdtempSync(join(tmpdir(), 'career-cards-research-'));
  try {
    stdout = await exec(args, user!, { env: p.procEnv ?? {}, cwd, tools: 'web', timeoutMs: o.timeoutMs ?? RESEARCH_TIMEOUT_MS, signal });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    const pe = e as Partial<ModelProcessError>;
    if (typeof pe.stdout !== 'string') {
      const msg = (e as Error).message;
      // runModelProcess reports its own timeout as a kill.
      throw Object.assign(new Error(`claude CLI failed: ${msg}`), /killed by/.test(msg) ? { name: 'TimeoutError' } : {});
    }
    ({ stdout } = pe as ModelProcessError);
    code = pe.code ?? null;
    stderr = pe.stderr ?? '';
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  const run = parseToolLog(stdout);
  // A run stopped by --max-turns can end with no result text and no is_error: that is no answer either.
  if (code !== 0 || run.isError || run.result === null) {
    const e = classifyClaudeFailure({ result: run.result, apiErrorStatus: run.apiErrorStatus, code, stderr, stdout });
    // callLLM cools a provider only when it has others to fall back to; research needs this one, so it cools here.
    if (e.coolMs >= 6 * HOUR) {
      coolDown(p.name ?? 'claude', e.coolMs);
      throw new QuotaExhausted(e.message);
    }
    throw new Error(e.message);
  }

  // A CLI upgrade that re-enabled a tool must not go unnoticed.
  const tools = [...new Set(run.tools ?? [])].sort();
  if (run.tools === null || tools.length !== run.tools.length || tools.join(',') !== WEB_TOOLS.join(',')) {
    log(`research: unexpected tool set ${JSON.stringify(run.tools)}`);
    throw new ResearchRefused('tool_set');
  }

  // Opened or not: a failed fetch may still have reached the address.
  const guard: UrlGuard = o.guard?.lookup ? { lookup: o.guard.lookup } : {};
  for (const f of run.fetches) {
    try {
      await assertPublicUrl(f.url, guard);
    } catch (e) {
      log(`research: discarded, a fetch of host ${hostOf(f.url)} failed the address check (${e instanceof BlockedUrlError ? 'blocked' : 'lookup failed'})`);
      throw new ResearchRefused('internal_address');
    }
  }

  const opened = new Set(run.fetches.filter((f) => f.ok).map((f) => sourceUrl(f.url)).filter((u): u is string => u !== null));
  if (!opened.size) throw new ResearchRefused('no_sources');

  const parsed = ResearchSchema.safeParse(parseJsonObject(run.result));
  if (!parsed.success) throw new StageOutputInvalid(`schema: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`);

  const points: Research['points'] = [];
  const sources: string[] = [];
  for (const pt of parsed.data.points) {
    const src = sourceUrl(pt.source);
    if (src === null || !opened.has(src)) continue;
    points.push({ ...pt, source: src });
    if (!sources.includes(src)) sources.push(src);
  }
  // Every claim must cite a page that loaded; a summary alone cites nothing.
  if (!points.length) throw new ResearchRefused('no_sources');
  return { research: { summary: parsed.data.summary, points }, sources, tokens: run.usage.total_tokens ?? 0 };
}

/** Plain lines: the summary, then each section with its points and their sources. */
export function renderResearch(r: Research): string {
  const sections = new Map<string, string[]>();
  for (const pt of r.points) {
    const head = oneLine(pt.section) || 'Notes';
    sections.set(head, [...(sections.get(head) ?? []), `- ${oneLine(pt.text)} (source: ${pt.source})`]);
  }
  const lines = [oneLine(r.summary)];
  for (const [head, items] of sections) lines.push('', `${head}:`, ...items);
  return (lines[0] ? lines : lines.slice(2)).join('\n');
}

export const webFooter = (sources: string[]): string =>
  `from the web, unverified, sources: ${sources.slice(0, FOOTER_SOURCES_MAX).join(', ')}`;
