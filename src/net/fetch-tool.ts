// The researcher's only way to read a page: a stdio MCP server the claude CLI starts, with one tool, fetch_page, that
// goes through safeFetch. The CLI's own WebFetch would run inside the worker and could reach internal addresses; here
// the address check happens before any request. Run as `node src/net/fetch-tool.ts`.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { htmlToText } from '../pipeline/html.ts';
import { BlockedUrlError, safeFetch } from './safe-fetch.ts';
import type { UrlGuard } from './safe-fetch.ts';

const SERVER = 'web';
export const FETCH_TOOL = `mcp__${SERVER}__fetch_page`;

// The CLI starts MCP servers with its whole environment (OAuth token included) merged under `env`, checked on Claude
// Code 2.1.322; `env -i` drops it before node starts.
export const FETCH_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    [SERVER]: { type: 'stdio', command: '/usr/bin/env', args: ['-i', process.execPath, fileURLToPath(import.meta.url)], env: {} },
  },
});

// The researcher runs with --max-turns 12; a few spare for parallel calls in one turn.
const FETCH_LIMIT = 15;
const PAGE_MAX_CHARS = 40_000;
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const HTML = new Set(['text/html', 'application/xhtml+xml']);
const TEXT = new Set(['text/plain', 'application/json', 'text/markdown']);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

// Reasons that name no address; any other block reads the same, so the model never learns what a name resolved to.
const SHOWN_REASONS = /^(?:more than \d+ redirects|bad redirect|credentials in URL)$/;

export async function fetchPage(url: unknown, guard: UrlGuard = {}): Promise<ToolResult> {
  if (typeof url !== 'string') return fail('url must be a string');
  let u: URL;
  try { u = new URL(url); } catch { return fail('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('only http and https URLs');
  let r;
  try {
    r = await safeFetch(u.href, {
      ...guard,
      headers: { 'user-agent': 'Mozilla/5.0 (career-cards)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    });
  } catch (e) {
    if (e instanceof BlockedUrlError) return fail(`blocked: ${SHOWN_REASONS.test(e.reason) ? e.reason : 'not a public address'}`);
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return fail('fetch failed: timed out');
    const code = (e as { code?: unknown }).code;
    return fail(`fetch failed${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? `: ${code}` : ''}`);
  }
  const header = `status: ${r.status} ${r.url}`;
  if (!r.ok) return fail(`${header}\nnot loaded: HTTP ${r.status}`);
  const type = (r.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!HTML.has(type) && !TEXT.has(type)) return fail(`${header}\nunsupported content type`);
  const text = HTML.has(type) ? htmlToText(r.text) : r.text;
  const body = text.length > PAGE_MAX_CHARS ? `${text.slice(0, PAGE_MAX_CHARS)}\n[truncated]` : text;
  return ok(`${header}\n\n${body}`);
}

const TOOL = {
  name: 'fetch_page',
  description: 'Read a public web page over http(s). Returns a first line `status: <code> <final url>`, then the page as plain text.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The http or https URL to read.' } },
    required: ['url'],
    additionalProperties: false,
  },
};

type Id = string | number | null;
type Reply = { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string } };

/** One JSON-RPC line in, the reply line out (null for a notification). Keeps the call count across lines. */
export function createHandler(guard: UrlGuard = {}): (line: string) => Promise<Reply | null> {
  let calls = 0;
  return async (line) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof (msg as { method?: unknown }).method !== 'string') {
      const id = (msg as { id?: unknown } | null)?.id;
      return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = msg as { id?: Id; method: string; params?: Record<string, unknown> };
    if (id === undefined || id === null) return null;
    const reply = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
    const error = (code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS.at(-1),
          capabilities: { tools: {} },
          serverInfo: { name: 'career-cards-fetch', version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [TOOL] });
      case 'tools/call': {
        if (params?.name !== TOOL.name) return error(-32602, 'unknown tool');
        if (++calls > FETCH_LIMIT) return reply(fail('fetch limit reached'));
        const args = params.arguments;
        return reply(await fetchPage(typeof args === 'object' && args !== null ? (args as { url?: unknown }).url : undefined, guard));
      }
      default:
        return error(-32601, 'Method not found');
    }
  };
}

/** Serves on stdin/stdout until stdin closes. Replies to parallel calls go out as each finishes. */
export function serveStdio(guard: UrlGuard = {}): void {
  const handle = createHandler(guard);
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    void handle(line).then(
      (r) => { if (r) process.stdout.write(`${JSON.stringify(r)}\n`); },
      () => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })}\n`); },
    );
  });
}

if (import.meta.main) serveStdio();
