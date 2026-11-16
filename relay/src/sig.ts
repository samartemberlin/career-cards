// The callback path carries an HMAC of `owner/repo`, so a stranger can't aim a Trello webhook at a user's repo
// (repo names are guessable) and burn their Actions minutes.

export const SIG_LEN = 22;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export const validRepo = (owner: string, repo: string) => OWNER.test(owner) && REPO.test(repo) && !/^\.\.?$/.test(repo);
export const MIN_SECRET = 32;

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    if (keys.size >= 4) keys.clear();
    k = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keys.set(secret, k);
  }
  return k;
}

export async function hookSig(secret: string, owner: string, repo: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(`${owner}/${repo}`.toLowerCase()));
  return btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, SIG_LEN);
}

/** Constant-time for equal lengths; the length is public. */
export function sameSig(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
