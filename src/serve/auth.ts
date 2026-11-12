import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Trello's X-Trello-Webhook value: base64 HMAC-SHA1 of the raw body bytes followed by the registered callback URL. */
export function trelloSignature(body: Buffer, callbackUrl: string, appSecret: string): string {
  return digest(body, callbackUrl, appSecret).toString('base64');
}

function digest(body: Buffer, callbackUrl: string, appSecret: string): Buffer {
  return createHmac('sha1', appSecret).update(Buffer.concat([body, Buffer.from(callbackUrl, 'utf8')])).digest();
}

/** `body` must be the bytes as received; `callbackUrl` must come from configuration, never from the request. */
export function verifyTrelloSignature(
  body: Buffer,
  header: string | undefined,
  callbackUrl: string,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const given = Buffer.from(header, 'base64');
  // Node's base64 decoder skips invalid characters; a round trip rejects anything but the canonical encoding.
  if (given.toString('base64') !== header) return false;
  const expected = digest(body, callbackUrl, appSecret);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Hashing first keeps the comparison constant-time without revealing the expected secret's length. */
export function secretMatches(given: string | null | undefined, expected: string): boolean {
  if (!expected || typeof given !== 'string') return false;
  const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(sha(given), sha(expected));
}

export function callbackUrl(publicUrl: string): string {
  let end = publicUrl.length;
  while (end > 0 && publicUrl[end - 1] === '/') end--;
  return `${publicUrl.slice(0, end)}/trello`;
}
