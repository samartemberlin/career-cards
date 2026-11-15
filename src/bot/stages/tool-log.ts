// What a `claude -p --output-format stream-json --verbose` run did, read from its stdout: which tools it had, which
// pages our fetch tool (src/net/fetch-tool.ts) opened and whether they loaded, what it searched for, and the final
// result. The researcher trusts only this log, never the model's own account of its sources.
import { FETCH_TOOL } from '../../net/fetch-tool.ts';
import { claudeUsage } from '../../pipeline/llm.ts';
import type { Usage } from '../../pipeline/llm.ts';

export type ToolLog = {
  tools: string[] | null;
  result: string | null;
  isError: boolean;
  apiErrorStatus: number | null;
  usage: Usage;
  fetches: { url: string; ok: boolean }[];
  searches: string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const blocks = (ev: Obj): Obj[] => {
  const content = isObj(ev.message) ? ev.message.content : undefined;
  return Array.isArray(content) ? content.filter(isObj) : [];
};
// The CLI passes an MCP result's content blocks through, but a tool error as a plain string.
const resultText = (b: Obj): string => typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) ? b.content.filter(isObj).map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('') : '';
const LOADED = /^status: 2\d\d /;

export function parseToolLog(stdout: string): ToolLog {
  let tools: string[] | null = null;
  let final: Obj | null = null;
  const uses: { id: string | null; url: string }[] = [];
  const searches: string[] = [];
  const loaded = new Map<string, boolean>();
  for (const raw of stdout.split('\n')) {
    let ev: unknown;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (!isObj(ev)) continue;
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.tools)) {
      tools = ev.tools.filter((t): t is string => typeof t === 'string');
    } else if (ev.type === 'assistant') {
      for (const b of blocks(ev)) {
        if (b.type !== 'tool_use' || !isObj(b.input)) continue;
        if (b.name === FETCH_TOOL && typeof b.input.url === 'string') uses.push({ id: typeof b.id === 'string' ? b.id : null, url: b.input.url });
        if (b.name === 'WebSearch' && typeof b.input.query === 'string') searches.push(b.input.query);
      }
    } else if (ev.type === 'user') {
      for (const b of blocks(ev)) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          loaded.set(b.tool_use_id, b.is_error !== true && LOADED.test(resultText(b)));
        }
      }
    } else if (ev.type === 'result') {
      final = ev;
    }
  }
  return {
    tools,
    result: typeof final?.result === 'string' ? final.result : null,
    isError: final ? final.is_error === true : true,
    apiErrorStatus: typeof final?.api_error_status === 'number' ? final.api_error_status : null,
    usage: claudeUsage(final?.usage),
    fetches: uses.map((u) => ({ url: u.url, ok: u.id !== null && loaded.get(u.id) === true })),
    searches,
  };
}
