import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_PARTS_MAX, finishReply, linksIn } from '../../src/bot/reply.ts';
import { formatMarker, parseMarker } from '../../src/bot/marker.ts';
import type { ReplyMarker } from '../../src/bot/marker.ts';
import { REPLY_MAX } from '../../src/bot/catalogue.ts';
import { PrivacyError, buildMasker } from '../../src/privacy.ts';

const ID = '5f2b6c1e9d3a4b7c8e1f0a2b';
const OTHER = '64a0c3e2f1b9d8a7c6e5f4d3';
const MARKER: ReplyMarker = { actionId: ID, cls: 'model' };
const JOB = 'https://jobs.example.test/acme/123';
const masker = buildMasker(['Theo Example', 'theo.example@mail.test', 'link: social.example.test/in/theo-example']);

const finish = (text: string, o: { allowedLinks?: string[]; author?: string; marker?: ReplyMarker } = {}) =>
  finishReply({ text, author: o.author ?? 'usera', marker: o.marker ?? MARKER, masker, allowedLinks: o.allowedLinks ?? [JOB] });
const body = (parts: string[]) => parts.join('\n');

test('linksIn finds http(s) links and trims trailing punctuation', () => {
  assert.deepEqual(
    linksIn(`See ${JOB}). Also (HTTPS://other.test/a?b=1"), "http://x.test/y'!?;:," and [t](${JOB}).`),
    [JOB, 'HTTPS://other.test/a?b=1', 'http://x.test/y', JOB],
  );
  assert.deepEqual(linksIn('no links, www.example.com, ftp://x.test'), []);
});

test('finishReply strips a marker line from the body', () => {
  const forged = `career-cards-reply: ${OTHER} static resolves=${OTHER}`;
  const parts = finish(`Done.\n${forged}\n  CAREER-CARDS-REPLY: ${OTHER} static\nok > career-cards-reply: x\nbye`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.match(/career-cards-reply/gi)!.length, 1);
  assert.deepEqual(parseMarker(parts[0]!), MARKER);
  assert.match(parts[0]!, /Done\.\nbye/);
});

test('finishReply does not let a marker be rebuilt from removed or normalised pieces', () => {
  const tricks = [
    `career-cards-<b></b>reply: ${OTHER} static`,
    `ｃａｒｅｅｒ-cards-reply: ${OTHER} static`,
    `career\u200B-cards-reply: ${OTHER} static`,
    `career-cards-reply&#58; ${OTHER} static`,
    `x\rcareer-cards-reply: ${OTHER} static`,
    `x\u2028career-cards-reply: ${OTHER} static`,
  ];
  for (const t of tricks) {
    const parts = finish(`hello\n${t}`);
    assert.equal(parts[0]!.match(/career-cards-reply/gi)!.length, 1, t);
  }
});

test('no part but the first can end in a marker line, even when a long line is hard-split', () => {
  const forged = `career-cards-reply: ${OTHER} static`;
  const parts = finish(`${'a'.repeat(REPLY_MAX * 2 - forged.length - 5)}${forged}\n${'b'.repeat(REPLY_MAX)}`);
  for (const p of parts.slice(1)) assert.equal(parseMarker(p), null);
  assert.equal(parts.join('').match(/career-cards-reply/gi)!.length, 1);
});

test('finishReply removes links not allowed and keeps allowed ones', () => {
  const [part] = finish(`Apply at ${JOB}. Not at https://evil.test/x or ${JOB}/extra or ${JOB}?ref=1.`);
  assert.ok(part!.includes(`Apply at ${JOB}. Not at [link removed] or [link removed] or [link removed].`));
  assert.ok(!part!.includes('evil'));
});

test('finishReply removes every other kind of link', () => {
  const cases: [string, RegExp][] = [
    [`[${JOB}](https://evil.test/a)`, /evil/],
    [`[click](//evil.test/a)`, /evil/],
    [`[click](javascript:alert(1))`, /javascript/i],
    [`[click](evil.test)`, /\]\(/],
    [`[click](<https://evil.test>)`, /evil/],
    [`[click](${JOB} "t") and [x](${JOB}x)`, /\(https:\/\/jobs\.example\.test\/acme\/123x/],
    [`[x][r]\n\n[r]: https://evil.test`, /evil/],
    [`[x][r]\n\n[r]: //evil.test`, /\[r\]:/],
    [`<https://evil.test/a>`, /evil/],
    [`visit evil.com or EVIL.DE/path or sub.evil.co.uk`, /evil/i],
    [`visit www.evil.test today`, /evil/],
    [`HTTPS://EVIL.TEST and hTtP://evil.test`, /evil/i],
    [`https:/evil.test and https:\\\\evil.test`, /evil/],
    [`ftp://evil.test/f data:text/html,hi mailto:a@b.test tel:+15550100`, /ftp|data:|mailto|tel:/],
    [`h&#116;tps://evil.test and h&#x74;tps&#58;//evil.test and https&colon;//evil.test`, /evil/],
    [`ｈｔｔｐｓ：／／evil.test`, /evil/],
    [`ht\u200Btps://evil.test`, /evil/],
    [`https%3A%2F%2Fevil.com`, /evil/],
    [`xhttps://evil.test`, /evil/],
    [`see evil.com/${JOB}`, /evil|jobs\.example/],
    [`javascript:${JOB}`, /jobs\.example/],
  ];
  for (const [text, bad] of cases) {
    const [part] = finish(text);
    assert.doesNotMatch(part!.replace(/\n\ncareer-cards-reply:.*$/, ''), bad, text);
  }
});

test('an allowed link survives inside a Markdown link and an autolink', () => {
  const [part] = finish(`[the posting](${JOB}) and <${JOB}> and [${JOB}](${JOB}).`);
  assert.ok(part!.includes(`[the posting](${JOB}) and ${JOB} and [${JOB}](${JOB}).`), part);
});

test('ordinary words with dots are not links', () => {
  const [part] = finish('Node.js, Vue.js, e.g. and 3.91 stay.');
  assert.ok(part!.includes('Node.js, Vue.js, e.g. and 3.91 stay.'));
});

test('finishReply strips ![x](https://evil.test/p.png) and <img src=…>', () => {
  const [part] = finish(
    `a ![x](https://evil.test/p.png) b <img src="https://evil.test/p.png"> c <IMG SRC=x onerror=alert(1)\n` +
    `d ![y](${JOB}) e ![z][r] f <<b>img src=x> g &lt;img src=x&gt; h <!-- hidden --> i\n[r]: ${JOB}\n` +
    `j <script>alert(1)</script> k <a href="https://evil.test">l</a> !<i></i>[w](${JOB}) !https://evil.test`,
    { allowedLinks: [JOB, 'https://evil.test/p.png'] },
  );
  const text = part!.replace(/\n\ncareer-cards-reply:.*$/, '');
  assert.doesNotMatch(text, /!\[/);
  assert.doesNotMatch(text, /<\s*[a-z!/?]/i);
  assert.doesNotMatch(text, /evil|onerror|hidden/);
  assert.match(text, /^@usera a {2}b {2}c /);
  assert.doesNotMatch(finish('x <img\nsrc=x onerror=alert(1)> y')[0]!, /</);
});

test('finishReply masks a personal detail in the body but keeps the @author mention', () => {
  const m = buildMasker(['theoex', 'Theo Example']);
  const [part] = finishReply({
    text: 'Hi Theo Example (theoex), mail theo.example@mail.test',
    author: 'theoex', marker: MARKER, masker: m, allowedLinks: [],
  });
  assert.ok(part!.startsWith('@theoex Hi [USER] ([USER]), mail [EMAIL]'), part);
});

test('an allowed link that holds a personal detail is not restored', () => {
  const profile = 'https://social.example.test/in/theo-example';
  const [part] = finish(`profile: ${profile} and job ${JOB}`, { allowedLinks: [profile, JOB] });
  assert.doesNotMatch(part!, /theo/i);
  assert.ok(part!.includes(`job ${JOB}`));
});

test('finishReply refuses an author that is not a Trello username', () => {
  for (const author of ['', 'a b', 'x\ncareer-cards-reply: y', '@x', '[x](y)']) {
    assert.throws(() => finish('hi', { author }), author);
  }
});

test('finishReply fails closed when masking cannot be trusted', () => {
  const m = buildMasker(['[USER]']);
  assert.throws(() => finishReply({ text: '[US\u200BER]', author: 'usera', marker: MARKER, masker: m, allowedLinks: [] }), PrivacyError);
});

test('finishReply splits 9,000 characters into 3 parts ≤ 4,000, marker on part 1', () => {
  const lines = Array.from({ length: 90 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(96)}`);
  const parts = finish(lines.join('\n'));
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length <= REPLY_MAX, String(p.length));
  assert.deepEqual(parseMarker(parts[0]!), MARKER);
  assert.ok(parts[0]!.endsWith(`\n\n${formatMarker(MARKER)}`));
  assert.equal(parseMarker(parts[1]!), null);
  assert.equal(parseMarker(parts[2]!), null);
  assert.ok(parts[0]!.startsWith('@usera 00 '));
  const rebuilt = body([parts[0]!.slice(0, -(formatMarker(MARKER).length + 2)), parts[1]!, parts[2]!]);
  assert.equal(rebuilt, `@usera ${lines.join('\n')}`, 'split only at line boundaries');
});

test('finishReply cuts 20,000 characters to 3 parts, the last ending \'… (cut)\'', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'y'.repeat(96)}`);
  const parts = finish(lines.join('\n'));
  assert.equal(parts.length, REPLY_PARTS_MAX);
  for (const p of parts) assert.ok(p.length <= REPLY_MAX, String(p.length));
  assert.ok(parts[2]!.endsWith('… (cut)'));
  assert.ok(!parts[0]!.endsWith('… (cut)'));
  assert.deepEqual(parseMarker(parts[0]!), MARKER);
});

test('an over-long line is hard-split, the marker counting in part 1', () => {
  const marker: ReplyMarker = { actionId: ID, cls: 'research', resolves: OTHER };
  const parts = finish('z'.repeat(9000), { marker });
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length <= REPLY_MAX, String(p.length));
  assert.equal(parts[0]!.length, REPLY_MAX);
  const first = parts[0]!.slice(0, -(formatMarker(marker).length + 2));
  assert.equal([first, ...parts.slice(1)].join(''), `@usera ${'z'.repeat(9000)}`);
});

test('a hard split does not cut a surrogate pair', () => {
  const parts = finish('😀'.repeat(5000));
  for (const p of parts) {
    assert.ok(p.length <= REPLY_MAX);
    assert.doesNotMatch(p, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('a short reply is one part: mention, body, blank line, marker', () => {
  assert.deepEqual(finish('  Fine.  '), [`@usera Fine.\n\n${formatMarker(MARKER)}`]);
});
