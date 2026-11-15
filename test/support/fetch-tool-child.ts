// The fetch_page MCP server with a test guard: `pages.test` resolves to 127.0.0.1, the only address allowed, so a
// test can serve pages locally. Everything else (other names, IP literals) stays as the real guard decides.
import { serveStdio } from '../../src/net/fetch-tool.ts';

serveStdio({
  lookup: async (host) => {
    if (host !== 'pages.test') throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return [{ address: '127.0.0.1', family: 4 }];
  },
  allow: (ip) => ip === '127.0.0.1',
});
