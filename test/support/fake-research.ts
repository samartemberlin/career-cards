// A scripted `claude -p --output-format stream-json` run for the researcher: the tool log a real run would print.
// The shapes follow test/fixtures/claude/research-stream-mcp.jsonl (Claude Code 2.1.322).
import { FETCH_MCP_CONFIG, FETCH_TOOL } from '../../src/net/fetch-tool.ts';
import type { runModelProcess } from '../../src/pipeline/llm.ts';
import type { fakeModel } from './fake-model.ts';
import { fetchPage, mcpClient, startSession } from './mcp-client.ts';

export type WebAnswer = {
  /** `content`: the page text after the tool's status line when ok, the tool's whole error text when not. */
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
  const out = [line({ type: 'system', subtype: 'init', tools: a.tools ?? ['WebSearch', FETCH_TOOL] })];
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
    const id = use(FETCH_TOOL, { url: f.url });
    const result = f.ok
      ? { content: [{ type: 'text', text: `status: 200 ${f.url}\n\n${f.content ?? 'page text'}` }] }
      : { content: f.content ?? 'blocked: not a public address', is_error: true };
    out.push(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, ...result }] } }));
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
export function withWeb(m: Model, web: (c: { stage: string; user: string; args: string[] }) => WebAnswer | Promise<WebAnswer>): Model {
  const inner = m.call.execImpl!;
  const execImpl: typeof runModelProcess = async (args, input, opts) => {
    if (opts.tools !== 'web') return inner(args, input, opts);
    const system = args[args.indexOf('--system-prompt') + 1] ?? '';
    const stage = stageOf(system);
    m.calls.push({ stage, system, user: input, via: 'claude', env: { ...opts.env }, cwd: opts.cwd, args: [...args], tools: opts.tools });
    const a = await web({ stage, user: input, args: [...args] });
    const stdout = streamJson(a);
    if (a.exitCode) throw Object.assign(new Error(`claude exited with code ${a.exitCode}`), { code: a.exitCode, stdout, stderr: '' });
    return stdout;
  };
  return { call: { ...m.call, execImpl }, calls: m.calls };
}

/**
 * Fetches `urls` through the real fetch tool, started as the CLI would from FETCH_MCP_CONFIG, and returns them as
 * WebAnswer fetches: what a researcher that really called the tool would have seen.
 */
export async function throughFetchTool(urls: string[]): Promise<{ results: WebAnswer['fetches']; texts: string[] }> {
  const cfg = (JSON.parse(FETCH_MCP_CONFIG) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> })
    .mcpServers.web!;
  const c = mcpClient(cfg.command, cfg.args, cfg.env);
  try {
    await startSession(c);
    const results: WebAnswer['fetches'] = [];
    const texts: string[] = [];
    for (const url of urls) {
      const r = await fetchPage(c, url);
      texts.push(r.text);
      const ok = !r.isError && /^status: 2\d\d /.test(r.text);
      results.push({ url, ok, content: ok ? r.text.slice(r.text.indexOf('\n\n') + 2) : r.text });
    }
    return { results, texts };
  } finally {
    await c.close();
  }
}
