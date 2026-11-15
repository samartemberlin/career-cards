// A minimal stdio MCP client for tests: newline-delimited JSON-RPC to a child process, as the claude CLI talks to it.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcReply = { jsonrpc: '2.0'; id: number | string | null; result?: any; error?: { code: number; message: string } };

export type McpClient = {
  child: ChildProcess;
  /** Sends a request and waits for the reply with its id. */
  request: (method: string, params?: object) => Promise<RpcReply>;
  /** Sends a raw line; resolves with the next reply whose id is null (parse and invalid-request errors). */
  raw: (line: string) => Promise<RpcReply>;
  notify: (method: string, params?: object) => void;
  close: () => Promise<void>;
};

export function mcpClient(command: string, args: string[], env: Record<string, string> = {}): McpClient {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number | string | null, ((r: RpcReply) => void)[]>();
  createInterface({ input: child.stdout! }).on('line', (l) => {
    const r = JSON.parse(l) as RpcReply;
    waiting.get(r.id)?.shift()?.(r);
  });
  const wait = (id: number | string | null) => new Promise<RpcReply>((resolve) => {
    waiting.set(id, [...(waiting.get(id) ?? []), resolve]);
  });
  let next = 0;
  const send = (o: object) => child.stdin!.write(`${JSON.stringify(o)}\n`);
  return {
    child,
    request: (method, params) => {
      const id = ++next;
      const p = wait(id);
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      return p;
    },
    raw: (line) => {
      const p = wait(null);
      child.stdin!.write(`${line}\n`);
      return p;
    },
    notify: (method, params) => { send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); },
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once('close', () => resolve());
      child.stdin!.end();
    }),
  };
}

/** initialize + initialized, as the CLI starts a session. */
export async function startSession(c: McpClient, protocolVersion = '2025-06-18'): Promise<RpcReply> {
  const r = await c.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  c.notify('notifications/initialized');
  return r;
}

/** The text and error flag of a fetch_page call. */
export async function fetchPage(c: McpClient, url: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await c.request('tools/call', { name: 'fetch_page', arguments: { url } });
  if (r.error) throw new Error(`tools/call failed: ${r.error.message}`);
  const content = r.result.content as { type: string; text: string }[];
  return { text: content.map((b) => b.text).join(''), isError: r.result.isError === true };
}
