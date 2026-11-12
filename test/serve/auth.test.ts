import test from 'node:test';
import assert from 'node:assert/strict';
import { trelloSignature, verifyTrelloSignature, secretMatches, callbackUrl } from '../../src/serve/auth.ts';
import { signedRequest } from '../support/webhook.ts';

const cb = 'https://worker.example.test/trello';
const SECRET = 'test-app-secret';
const utf8 = Buffer.from('{"action":{"data":{"text":"@bot warum Grüße 👋"}}}', 'utf8');
const UTF8_SIG = 'eTgsPQkRUvsu5yKKtK8WIJjBGOE=';

test('trelloSignature matches openssl vectors', () => {
  assert.equal(trelloSignature(Buffer.from('{"a":1}'), cb, SECRET), 'ExAhWBkMjD6JBhW2MCUSKNl++x8=');
  assert.equal(trelloSignature(utf8, cb, SECRET), UTF8_SIG);
});

test('verifies a body with non-ASCII text', () => {
  assert.equal(verifyTrelloSignature(utf8, UTF8_SIG, cb, SECRET), true);
});

test('fails on the same JSON re-serialized', () => {
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(utf8.toString('utf8')), null, 1));
  assert.equal(verifyTrelloSignature(reserialized, UTF8_SIG, cb, SECRET), false);
  const compact = Buffer.from(JSON.stringify(JSON.parse(utf8.toString('utf8'))), 'latin1');
  assert.equal(verifyTrelloSignature(compact, UTF8_SIG, cb, SECRET), false);
});

test('fails with another callback URL', () => {
  assert.equal(verifyTrelloSignature(utf8, UTF8_SIG, `${cb}/`, SECRET), false);
  assert.equal(verifyTrelloSignature(utf8, UTF8_SIG, cb.replace('https:', 'http:'), SECRET), false);
});

test('fails with a wrong secret', () => {
  assert.equal(verifyTrelloSignature(utf8, UTF8_SIG, cb, 'other-app-secret'), false);
});

test('fails on a missing header', () => {
  assert.equal(verifyTrelloSignature(utf8, undefined, cb, SECRET), false);
  assert.equal(verifyTrelloSignature(utf8, '', cb, SECRET), false);
});

test('fails on garbage base64', () => {
  for (const h of ['!!!not base64!!!', `${UTF8_SIG}x`, UTF8_SIG.slice(0, -2), `${UTF8_SIG} `, 'AAAA', `${UTF8_SIG}AAAA`]) {
    assert.equal(verifyTrelloSignature(utf8, h, cb, SECRET), false, h);
  }
});

test('fails on an empty app secret', () => {
  const sig = trelloSignature(utf8, cb, '');
  assert.equal(verifyTrelloSignature(utf8, sig, cb, ''), false);
});

test('signedRequest produces bytes and a header that verify', () => {
  const req = signedRequest({ action: { id: 'a1' } }, { callbackUrl: cb, appSecret: SECRET });
  assert.equal(verifyTrelloSignature(req.raw, req.signature, cb, SECRET), true);
});

test('secretMatches', () => {
  assert.equal(secretMatches('s3cret-key', 's3cret-key'), true);
  assert.equal(secretMatches('s3cret', 's3cret-key'), false);
  assert.equal(secretMatches('s3cret-key!', 's3cret-key'), false);
  assert.equal(secretMatches('', 's3cret-key'), false);
  assert.equal(secretMatches(undefined, 's3cret-key'), false);
  assert.equal(secretMatches(null, 's3cret-key'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('anything', ''), false);
});

test('callbackUrl', () => {
  assert.equal(callbackUrl('https://w.example/'), 'https://w.example/trello');
  assert.equal(callbackUrl('https://w.example'), 'https://w.example/trello');
  assert.equal(callbackUrl('https://w.example//'), 'https://w.example/trello');
});
