// A scripted model behind both transports: an OpenAI-compatible endpoint (fetchImpl) and `claude -p` (execImpl).
// `script` sees the stage name from the system prompt's first line and returns the model's text.
import type { CallOpts, FetchJson, runModelProcess } from '../../src/pipeline/llm.ts';

export type RecordedCall = {
  stage: string; system: string; user: string; via: 'http' | 'claude';
  env?: Record<string, string>; cwd?: string; args?: string[]; tools?: string;
  headers?: Record<string, string>; url?: string;
};

type Script = (c: { stage: string; system: string; user: string }) => string;

const stageOf = (system: string) => /^career-cards stage: (\S+)/.exec(system)?.[1] ?? '';

export function fakeModel(script: Script): { call: CallOpts; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchJson = async (url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    const stage = stageOf(system);
    calls.push({ stage, system, user, via: 'http', url, headers: { ...(init?.headers as Record<string, string>) } });
    const content = script({ stage, system, user });
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
    };
  };
  const execImpl: typeof runModelProcess = async (args, input, opts) => {
    const system = args[args.indexOf('--system-prompt') + 1] ?? '';
    const stage = stageOf(system);
    calls.push({ stage, system, user: input, via: 'claude', env: { ...opts.env }, cwd: opts.cwd, args: [...args], tools: opts.tools });
    const result = script({ stage, system, user: input });
    return JSON.stringify({ type: 'result', result, is_error: false, usage: { input_tokens: 8, output_tokens: 2 } });
  };
  return { call: { fetchImpl, execImpl, log: () => {} }, calls };
}
