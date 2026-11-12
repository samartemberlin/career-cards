// Fetching URLs that come from untrusted text (job pages, user comments) must not reach the service's own network:
// cloud metadata, loopback, private ranges. Every hop and every socket address is checked.
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { LookupFunction } from 'node:net';
import { promises as dns } from 'node:dns';
import type { FetchLike } from '../pipeline/jd.ts';

export class BlockedUrlError extends Error {
  url: string;
  constructor(url: string, reason: string) {
    const shown = withoutCredentials(url);
    super(`blocked ${shown}: ${reason}`);
    this.name = 'BlockedUrlError';
    this.url = shown;
  }
}

function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return '[unparsable url]';
  }
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
}

const V4_RANGES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

function publicV4(n: number): boolean {
  return !V4_RANGES.some(({ net, mask }) => ((n & mask) >>> 0) === net);
}

/** `ip` must already pass isIPv6 (no zone id). */
function v6Hextets(ip: string): number[] {
  let s = ip;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':') + 1;
    const n = v4ToInt(s.slice(cut));
    s = `${s.slice(0, cut)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const groups = (part: string): number[] => (part ? part.split(':').map((x) => parseInt(x, 16)) : []);
  const [head = '', tail] = s.split('::');
  if (tail === undefined) return groups(head);
  const h = groups(head);
  const t = groups(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

const v4Of = (h: number[], i: number): number => ((h[i]! << 16) >>> 0) + h[i + 1]!;

/** False for anything that is not a plain public unicast address, including strings that are not IP addresses. */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return publicV4(v4ToInt(ip));
  const base = ip.split('%')[0]!;
  if (!isIPv6(base)) return false;
  const h = v6Hextets(base);
  const zeros = (from: number, to: number): boolean => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 6)) return false; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (zeros(0, 5) && h[5] === 0xffff) return publicV4(v4Of(h, 6));
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return publicV4(v4Of(h, 6));
  if (h[0] === 0x64 && h[1] === 0xff9b) return zeros(2, 6) && publicV4(v4Of(h, 6));
  if (h[0] === 0x2002) return publicV4(v4Of(h, 1));
  if (h[0] === 0x2001 && h[1] === 0) return false; // Teredo: the embedded client address can be anything
  return (h[0]! & 0xe000) === 0x2000; // global unicast 2000::/3; ULA, link-local, multicast and the rest fall outside
}

export type LookupAll = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

const systemLookup: LookupAll = async (host) =>
  (await dns.lookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

type Guard = { lookup?: LookupAll; allow?: (ip: string) => boolean };

/** Resolves and checks every address; throws BlockedUrlError unless all of them pass `allow`. */
async function resolveAllowed(url: string, host: string, lookup: LookupAll, allow: (ip: string) => boolean) {
  const addrs = await lookup(host);
  if (addrs.length === 0) throw new BlockedUrlError(url, 'no address');
  const bad = addrs.find((a) => !allow(a.address));
  if (bad) throw new BlockedUrlError(url, `address ${bad.address}`);
  return addrs;
}

function hostOf(u: URL): string {
  return u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
}

export async function assertPublicUrl(url: string, o: Guard = {}): Promise<URL> {
  const { lookup = systemLookup, allow = isPublicAddress } = o;
  let u: URL;
  try { u = new URL(url); } catch { throw new BlockedUrlError(url, 'not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(url, `scheme ${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrlError(url, 'credentials in URL');
  const host = hostOf(u);
  if (isIP(host)) {
    if (!allow(host)) throw new BlockedUrlError(url, `address ${host}`);
    return u;
  }
  // A name that resolves elsewhere through a custom resolver still means "this machine" to many clients.
  const name = host.toLowerCase().replace(/\.+$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) throw new BlockedUrlError(url, 'localhost');
  await resolveAllowed(url, host, lookup, allow);
  return u;
}

export type SafeResponse = { ok: boolean; status: number; url: string; text: string };

export type SafeFetchOpts = Guard & {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** The socket's own lookup re-checks the address it really connects to: the name may resolve differently by then. */
function guardedLookup(url: string, lookup: LookupAll, allow: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowed(url, hostname, lookup, allow).then(
      (addrs) => {
        const fam = options.family === 4 || options.family === 6 ? options.family : 0;
        const fit = fam ? addrs.filter((a) => a.family === fam) : addrs;
        if (fit.length === 0) {
          callback(Object.assign(new Error(`no IPv${fam} address`), { code: 'ENOTFOUND' }), '', 0);
        } else if (options.all) {
          callback(null, fit);
        } else {
          callback(null, fit[0]!.address, fit[0]!.family);
        }
      },
      (err: Error) => callback(err, '', 0),
    );
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

type Hop = { status: number; location?: string; text: string };
type HopOpts = Guard & { maxBytes: number; headers: Record<string, string>; signal: AbortSignal };

function hop(u: URL, o: HopOpts): Promise<Hop> {
  const { lookup = systemLookup, allow = isPublicAddress } = o;
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) { reject(o.signal.reason); return; }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
      method: 'GET',
      // No pooled sockets: each connection goes through guardedLookup. No env proxy either.
      agent: false,
      lookup: guardedLookup(u.href, lookup, allow),
      headers: { ...o.headers, 'accept-encoding': 'identity' },
    });
    const onAbort = (): void => { req.destroy(o.signal.reason as Error); reject(o.signal.reason); };
    o.signal.addEventListener('abort', onAbort, { once: true });
    const done = (): void => o.signal.removeEventListener('abort', onAbort);
    req.on('error', (err) => { done(); reject(err); });
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status) && res.headers.location !== undefined) {
        res.destroy();
        done();
        resolve({ status, location: res.headers.location, text: '' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (): void => {
        done();
        resolve({ status, text: Buffer.concat(chunks).subarray(0, o.maxBytes).toString('utf8') });
      };
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size >= o.maxBytes) { res.destroy(); finish(); }
      });
      res.on('end', finish);
      res.on('error', (err) => { done(); reject(err); });
    });
    req.end();
  });
}

/** A resolver that hangs must not outlive the call's timeout. */
function withSignal(lookup: LookupAll, signal: AbortSignal): LookupAll {
  return (host) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    lookup(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function safeFetch(url: string, o: SafeFetchOpts = {}): Promise<SafeResponse> {
  const { maxRedirects = 5, timeoutMs = 15_000, maxBytes = 3_000_000, headers = {}, lookup, allow } = o;
  const signal = o.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), o.signal]) : AbortSignal.timeout(timeoutMs);
  const timedLookup = withSignal(lookup ?? systemLookup, signal);
  let current = url;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const u = await assertPublicUrl(current, { lookup: timedLookup, allow });
    const r = await hop(u, { maxBytes, headers, lookup: timedLookup, allow, signal });
    if (r.location === undefined) {
      return { ok: r.status >= 200 && r.status < 300, status: r.status, url: u.href, text: r.text };
    }
    let next: string;
    try { next = new URL(r.location, u).href; } catch { throw new BlockedUrlError(u.href, 'bad redirect'); }
    if (redirects >= maxRedirects) throw new BlockedUrlError(next, `more than ${maxRedirects} redirects`);
    current = next;
  }
}

/** Adapter for fetchJd and the sources: GET only; init's headers and signal are kept; redirects are always followed. */
export function safeFetchLike(o: Omit<SafeFetchOpts, 'headers' | 'signal'> = {}): FetchLike {
  return async (url, init) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body != null) {
      throw new Error('safeFetchLike sends GET requests without a body only');
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const { ok, status, text } = await safeFetch(url, { ...o, headers, signal: init?.signal ?? undefined });
    return { ok, status, text: async () => text };
  };
}
