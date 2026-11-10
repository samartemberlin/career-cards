import type { Recording } from '../../tools/sample/scrub.ts';

const keyOf = (method: string, path: string, query: Record<string, string>): string =>
  `${method} ${path}?${Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')}`;

/** Serves recorded responses; the first recorded call with the same method, path and query wins. */
export function replayFetch(rec: Recording): typeof fetch {
  const byKey = new Map<string, Recording[number]>();
  for (const c of rec) {
    const k = keyOf(c.method, c.path, c.query);
    if (!byKey.has(k)) byKey.set(k, c);
  }
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const k = keyOf(method, u.pathname.replace(/^\/1(?=\/)/, ''), Object.fromEntries(u.searchParams));
    const c = byKey.get(k);
    if (!c) throw new Error(`replayFetch: no recorded response for ${k}`);
    return typeof c.body === 'string'
      ? new Response(c.body, { status: c.status, headers: { 'content-type': 'text/plain' } })
      : new Response(JSON.stringify(c.body), { status: c.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

