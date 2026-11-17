import { readFileSync } from 'node:fs';
import type { CardKey } from '../config/cards.ts';
import { QuotaExhausted, callLLM, orAbort } from '../pipeline/llm.ts';
import type { CallOpts, LlmConfig, Message } from '../pipeline/llm.ts';
import { PrivacyError } from '../privacy.ts';
import type { Masker } from '../privacy.ts';
import { StageOutputInvalid, parseJsonObject } from '../bot/stages/call.ts';
import { CompiledSchema, unusable } from './schema.ts';
import type { Compiled } from './schema.ts';

export type CardText = { key: CardKey; name: string; text: string };
export type CompileInput = {
  dealBreakers: CardText[];
  profiles: { name: string; cards: CardText[] }[];
};

export class CompileFailed extends Error {
  problems: { card: string; reason: string }[];
  model?: string;
  tokens?: number;
  constructor(problems: { card: string; reason: string }[], opts?: { model?: string; tokens?: number }) {
    super(`unusable cards: ${problems.map((p) => `${p.card}: ${p.reason}`).join('; ')}`);
    this.name = 'CompileFailed';
    this.problems = problems;
    if (opts?.model !== undefined) this.model = opts.model;
    if (opts?.tokens !== undefined) this.tokens = opts.tokens;
  }
}

export class CompileUnavailable extends Error {
  kind: 'quota' | 'invalid';
  reason: string;
  model?: string;
  tokens?: number;
  constructor(message: string, kind: 'quota' | 'invalid', reason: string, opts?: { model?: string; tokens?: number }) {
    super(message);
    this.name = 'CompileUnavailable';
    this.kind = kind;
    this.reason = reason;
    if (opts?.model !== undefined) this.model = opts.model;
    if (opts?.tokens !== undefined) this.tokens = opts.tokens;
  }
}

const SYSTEM = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');

export const displayName = (profile: string | null, card: string): string => (profile ? `${profile} › ${card}` : card);

// Quoting every line keeps a card's text from faking a heading the code writes.
const quote = (text: string): string => text.split('\n').map((l) => `> ${l}`).join('\n');

export function buildCompileMessages(input: CompileInput, masker: Masker): Message[] {
  const card = (profile: string | null, c: CardText) => `### ${displayName(profile, c.name)}\n${quote(masker.mask(c.text))}\n`;
  const parts = ['## Deal-breakers\n', ...input.dealBreakers.map((c) => card(null, c))];
  for (const p of input.profiles) {
    if (masker.hasDetail(p.name)) throw new PrivacyError('a profile name contains a personal detail');
    parts.push(`## Profile: ${p.name}\n`, ...p.cards.map((c) => card(p.name, c)));
  }
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: parts.join('\n') }];
}

const firstLine = (s: string): string => s.split('\n')[0]!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keep only the input's profiles, under the input's spelling of their names. */
function matchProfiles(c: Compiled, input: CompileInput): Compiled {
  const profiles: Compiled['profiles'] = [];
  for (const p of c.profiles) {
    const name = input.profiles.find((x) => x.name.toLowerCase() === p.name.toLowerCase())?.name;
    if (name && !profiles.some((x) => x.name === name)) profiles.push({ ...p, name });
  }
  return { ...c, profiles };
}

export async function compileCards(input: CompileInput, o: {
  llm: LlmConfig; masker: Masker; call?: CallOpts; log: (s: string) => void;
  deadline?: number; attempts?: number; pauseMs?: number; signal?: AbortSignal;
}): Promise<{ compiled: Compiled; model: string; tokens: number }> {
  const attempts = o.attempts ?? 3;
  const pauseMs = o.pauseMs ?? 20000;
  const messages = buildCompileMessages(input, o.masker);
  const opts: CallOpts = { ...o.call };
  if (o.signal) opts.signal = o.signal;
  let last = '';
  let lastWasQuota = false;
  // Set when the last attempt's result was unusable by code checks alone: thrown as CompileFailed if no attempt is left.
  let lastUnusable: { card: string; reason: string }[] | null = null;
  let lastModel: string | undefined;
  let lastTokens: number | undefined;
  for (let n = 1; n <= attempts; n++) {
    o.signal?.throwIfAborted();
    if (n > 1) {
      if (o.deadline !== undefined && Date.now() + pauseMs >= o.deadline) break;
      await orAbort(sleep(pauseMs), o.signal);
    }
    try {
      const r = await callLLM(o.llm, messages, opts);
      const model = `${r.provider}:${r.model}`;
      const u = r.usage;
      const tokens = u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
      lastModel = model;
      lastTokens = tokens;
      o.log(`compile: model ${r.provider}/${r.model}`);
      const parsed = CompiledSchema.safeParse(parseJsonObject(r.text));
      // Paths only: the values are model output.
      if (!parsed.success) throw new StageOutputInvalid(`schema: ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`);
      const compiled = matchProfiles(parsed.data, input);
      const problems = unusable(compiled, input.profiles.map((p) => p.name));
      if (problems.length) {
        lastUnusable = problems;
        o.log(`compile: attempt ${n} failed: unusable: ${[...new Set(problems.map((p) => p.card))].join(', ')}`);
        continue;
      }
      return { compiled, model, tokens };
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      if (!(e instanceof QuotaExhausted || e instanceof StageOutputInvalid)) throw e;
      lastWasQuota = e instanceof QuotaExhausted;
      lastUnusable = null;
      last = firstLine(e.message);
      o.log(`compile: attempt ${n} failed: ${last}`);
    }
  }
  if (lastUnusable) throw new CompileFailed(lastUnusable, { model: lastModel, tokens: lastTokens });
  throw new CompileUnavailable(`could not read the Profiles cards: ${last}`, lastWasQuota ? 'quota' : 'invalid', last, { model: lastModel, tokens: lastTokens });
}
