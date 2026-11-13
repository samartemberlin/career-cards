// A scripted `claude -p --output-format stream-json` run for the researcher: the tool log a real run would print.
// The shapes follow test/fixtures/claude/research-stream.jsonl (Claude Code 2.1.322).
import type { runModelProcess } from '../../src/pipeline/llm.ts';
import type { fakeModel } from './fake-model.ts';

export type WebAnswer = {
  fetches: { url: string; ok: boolean; content?: string }[];
  searches?: string[];
  /** A string is the model's raw text; `null` is a run with no result text (stopped by --max-turns). */
  answer: object | string | null;
  isError?: boolean;
  tools?: string[];
  /** Non-zero: the process exits with this code, as runModelProcess reports it. */
  exitCode?: number;
};

const line = (o: object) => JSON.stringify(o);

export function streamJson(a: Omit<WebAnswer, 'exitCode'>): string {
  const out = [line({ type: 'system', subtype: 'init', tools: a.tools ?? ['WebFetch', 'WebSearch'] })];
  let n = 0;
  const use = (name: string, input: object) => {
    const id = `toolu_${String(++n).padStart(4, '0')}`;
    out.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }));
    return id;
  };
  for (const query of a.searches ?? []) {
    const id = use('WebSearch', { query });
    out.push(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'results' }] } }));
  }
  for (const f of a.fetches) {
    const id = use('WebFetch', { url: f.url, prompt: 'Summarise the page.' });
    out.push(line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: f.content ?? 'page text', ...(f.ok ? {} : { is_error: true }) }] },
      ...(f.ok ? { tool_use_result: { code: 200, codeText: 'OK' } } : {}),
    }));
  }
  const result = a.answer === null ? {} : { result: typeof a.answer === 'string' ? a.answer : JSON.stringify(a.answer) };
  out.push(line({
    type: 'result', subtype: a.answer === null ? 'error_max_turns' : 'success', is_error: a.isError ?? false,
    api_error_status: null, usage: { input_tokens: 30, output_tokens: 12 }, ...result,
  }));
  return `${out.join('\n')}\n`;
}

type Model = ReturnType<typeof fakeModel>;
const stageOf = (system: string) => /^career-cards stage: (\S+)/.exec(system)?.[1] ?? '';

/**
 * `m` with its `claude` transport answering web runs (`tools: 'web'`) from `web`, recorded into the same `m.calls`;
 * every other call goes to `m` as before. One `call` can then serve a researcher call and an advisor call in order.
 */
export function withWeb(m: Model, web: (c: { stage: string; user: string; args: string[] }) => WebAnswer): Model {
  const inner = m.call.execImpl!;
  const execImpl: typeof runModelProcess = async (args, input, opts) => {
    if (opts.tools !== 'web') return inner(args, input, opts);
    const system = args[args.indexOf('--system-prompt') + 1] ?? '';
    const stage = stageOf(system);
    m.calls.push({ stage, system, user: input, via: 'claude', env: { ...opts.env }, cwd: opts.cwd, args: [...args], tools: opts.tools });
    const a = web({ stage, user: input, args: [...args] });
    const stdout = streamJson(a);
    if (a.exitCode) throw Object.assign(new Error(`claude exited with code ${a.exitCode}`), { code: a.exitCode, stdout, stderr: '' });
    return stdout;
  };
  return { call: { ...m.call, execImpl }, calls: m.calls };
}
