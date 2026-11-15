import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { FETCH_MCP_CONFIG, FETCH_TOOL } from '../../src/net/fetch-tool.ts';
import { fetchPage, mcpClient, startSession } from '../support/mcp-client.ts';
import type { McpClient } from '../support/mcp-client.ts';

const seen: string[] = [];
const server = createServer((req, res) => {
  const path = req.url ?? '';
  seen.push(path);
  const send = (type: string | null, body: string, status = 200) => {
    res.writeHead(status, type ? { 'content-type': type } : {}).end(body);
  };
  if (path === '/html') send('text/html; charset=utf-8', '<html><head><style>p{}</style><script>evil()</script></head><body><h1>Acme</h1><p>We make &amp; sell tea.</p></body></html>');
  else if (path === '/xhtml') send('application/xhtml+xml', '<html><body><p>X page</p></body></html>');
  else if (path === '/plain') send('text/plain', 'plain words');
  else if (path === '/json') send('application/json', '{"a":1}');
  else if (path === '/md') send('text/markdown; charset=utf-8', '# Title');
  else if (path === '/png') send('image/png', 'PNGDATA');
  else if (path === '/untyped') send(null, 'no type');
  else if (path === '/big') send('text/plain', 'x'.repeat(50_000));
  else if (path === '/to-loopback') res.writeHead(302, { location: `http://127.0.0.2:${port}/plain` }).end();
  else if (path === '/to-plain') res.writeHead(301, { location: '/plain' }).end();
  else send('text/plain', 'gone', 404);
});
let port = 0;
test.before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
test.after(() => { server.closeAllConnections(); server.close(); });
test.beforeEach(() => { seen.length = 0; });

const TEST_CHILD = fileURLToPath(new URL('../support/fetch-tool-child.ts', import.meta.url));
const page = (path: string) => `http://pages.test:${port}${path}`;

async function withTestServer(fn: (c: McpClient) => Promise<void>) {
  const c = mcpClient(process.execPath, [TEST_CHILD]);
  try {
    await startSession(c);
    await fn(c);
  } finally {
    await c.close();
  }
}

type ServerConfig = { type: string; command: string; args: string[]; env: Record<string, string> };
const realConfig = (): ServerConfig => (JSON.parse(FETCH_MCP_CONFIG) as { mcpServers: Record<string, ServerConfig> }).mcpServers.web!;

test('the MCP config starts the server with an emptied environment and names the tool the CLI will see', () => {
  const cfg = realConfig();
  assert.equal(cfg.type, 'stdio');
  assert.deepEqual(cfg.env, {});
  assert.deepEqual([cfg.command, cfg.args[0], cfg.args[1]], ['/usr/bin/env', '-i', process.execPath]);
  assert.match(cfg.args[2]!, /\/src\/net\/fetch-tool\.ts$/);
  assert.equal(cfg.args.length, 3);
  assert.equal(FETCH_TOOL, 'mcp__web__fetch_page');
});

test('initialize, tools/list and ping', async () => {
  await withTestServer(async (c) => {
    const again = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(again.result.protocolVersion, '2024-11-05');
    const odd = await c.request('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(odd.result.protocolVersion, '2025-06-18');
    assert.deepEqual(odd.result.capabilities, { tools: {} });
    assert.equal(typeof odd.result.serverInfo.name, 'string');

    const list = await c.request('tools/list');
    assert.equal(list.result.tools.length, 1);
    const tool = list.result.tools[0];
    assert.equal(tool.name, 'fetch_page');
    assert.deepEqual(tool.inputSchema, {
      type: 'object', properties: { url: { type: 'string', description: tool.inputSchema.properties.url.description } },
      required: ['url'], additionalProperties: false,
    });
    assert.deepEqual((await c.request('ping')).result, {});
  });
});

test('an unknown method is -32601; an unknown tool is -32602; an unknown notification gets no reply', async () => {
  await withTestServer(async (c) => {
    assert.equal((await c.request('resources/list')).error?.code, -32601);
    assert.equal((await c.request('tools/call', { name: 'Bash', arguments: {} })).error?.code, -32602);
    c.notify('notifications/cancelled', { requestId: 99 });
    assert.deepEqual((await c.request('ping')).result, {});
  });
});

test('a malformed line is a parse error with id null, and the server keeps running', async () => {
  await withTestServer(async (c) => {
    assert.equal((await c.raw('{"jsonrpc": "2.0", "id": 1, "method"')).error?.code, -32700);
    assert.equal((await c.raw('[1, 2]')).error?.code, -32600);
    assert.equal((await c.raw('{"jsonrpc": "2.0", "params": {}}')).error?.code, -32600);
    assert.deepEqual((await c.request('ping')).result, {});
  });
});

test('HTML and XHTML come back as plain text under a status header', async () => {
  await withTestServer(async (c) => {
    const r = await fetchPage(c, page('/html'));
    assert.equal(r.isError, false);
    assert.equal(r.text, `status: 200 ${page('/html')}\n\nAcme\nWe make & sell tea.`);
    assert.equal((await fetchPage(c, page('/xhtml'))).text, `status: 200 ${page('/xhtml')}\n\nX page`);
  });
});

test('plain text, JSON and Markdown come back as they are; the header names the final URL after a redirect', async () => {
  await withTestServer(async (c) => {
    for (const [path, body] of [['/plain', 'plain words'], ['/json', '{"a":1}'], ['/md', '# Title']] as const) {
      assert.deepEqual(await fetchPage(c, page(path)), { text: `status: 200 ${page(path)}\n\n${body}`, isError: false });
    }
    assert.deepEqual(await fetchPage(c, page('/to-plain')), { text: `status: 200 ${page('/plain')}\n\nplain words`, isError: false });
  });
});

test('an unsupported or missing content type is a tool error without the body', async () => {
  await withTestServer(async (c) => {
    for (const path of ['/png', '/untyped']) {
      const r = await fetchPage(c, page(path));
      assert.equal(r.isError, true, path);
      assert.match(r.text, /unsupported content type/, path);
      assert.ok(!/PNGDATA|no type/.test(r.text), path);
    }
  });
});

test('a non-2xx answer is a tool error with its status', async () => {
  await withTestServer(async (c) => {
    const r = await fetchPage(c, page('/missing'));
    assert.equal(r.isError, true);
    assert.match(r.text, new RegExp(`^status: 404 ${page('/missing').replace(/[.?]/g, '\\$&')}\n`));
    assert.ok(!r.text.includes('gone'));
  });
});

test('a long page is cut at 40,000 characters with a note', async () => {
  await withTestServer(async (c) => {
    const r = await fetchPage(c, page('/big'));
    const body = r.text.split('\n\n').slice(1).join('\n\n');
    assert.equal(body, `${'x'.repeat(40_000)}\n[truncated]`);
  });
});

test('only http(s) URLs; a redirect to a non-public address is blocked', async () => {
  await withTestServer(async (c) => {
    for (const url of ['file:///etc/passwd', 'ftp://pages.test/x', 'not a url', 42]) {
      const r = await fetchPage(c, url);
      assert.equal(r.isError, true, String(url));
      assert.ok(!r.text.startsWith('status:'), String(url));
    }
    const r = await fetchPage(c, page('/to-loopback'));
    assert.deepEqual(r, { text: 'blocked: not a public address', isError: true });
    assert.deepEqual(seen, ['/to-loopback']);
  });
});

test('at most 15 calls per server process, counting failed ones', async () => {
  await withTestServer(async (c) => {
    await fetchPage(c, 'file:///x');
    for (let i = 0; i < 14; i++) assert.equal((await fetchPage(c, page('/plain'))).isError, false);
    assert.deepEqual(await fetchPage(c, page('/plain')), { text: 'fetch limit reached', isError: true });
    assert.equal(seen.length, 14);
  });
});

test('the real server, started as the MCP config says: loopback and metadata addresses are refused before any request', async () => {
  const cfg = realConfig();
  // The CLI merges its own environment (with the OAuth token) into the server's: the config must not let it through.
  const c = mcpClient(cfg.command, cfg.args, { ...process.env as Record<string, string>, ...cfg.env, CLAUDE_CODE_OAUTH_TOKEN: 'tok-claude-0000' });
  try {
    await startSession(c);
    for (const url of [`http://127.0.0.1:${port}/plain`, `http://localhost:${port}/plain`, 'http://169.254.169.254/latest/meta-data/',
      `http://[::1]:${port}/plain`]) {
      assert.deepEqual(await fetchPage(c, url), { text: 'blocked: not a public address', isError: true }, url);
    }
    assert.deepEqual(seen, []);
    if (process.platform === 'linux') assert.equal(readFileSync(`/proc/${c.child.pid}/environ`, 'utf8'), '');
  } finally {
    await c.close();
  }
});
