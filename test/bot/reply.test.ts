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

// Every ASCII punctuation character with a meaning in CommonMark, GFM or HTML. The reply checks must escape all of
// them; `read` fails on any that is not.
const ACTIVE = '!#$&()*+-.:<=>@[\\]^_`{|}~';
const LINK_LINE = /^link (\d+): <(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+)>$/;

/** What a CommonMark renderer shows for the parts: the plain text, and the links the code listed. Throws on any
 * active character left unescaped, any indented line, and any `<` outside a listed link. */
function read(parts: string[], author = 'usera'): { text: string; links: string[] } {
  const links: string[] = [];
  const out: string[] = [];
  parts.forEach((part, p) => {
    if (p === parts.length - 1 && p === REPLY_PARTS_MAX - 1) part = part.replace(/\n… \(cut\)$/, '');
    let lines = part.split('\n');
    if (p === 0) {
      assert.notEqual(parseMarker(part), null);
      assert.ok(/^career-cards-reply: /.test(lines.at(-1)!), 'part 1 ends in the marker');
      assert.equal(lines.at(-2), '');
      lines = lines.slice(0, -2);
      assert.ok(lines[0] === `@${author}` || lines[0]!.startsWith(`@${author} `), lines[0]);
      lines[0] = lines[0]!.slice(author.length + 2);
    } else {
      assert.equal(parseMarker(part), null);
    }
    for (const line of lines) {
      const link = LINK_LINE.exec(line);
      if (link) {
        assert.equal(Number(link[1]), links.length + 1);
        links.push(link[2]!);
        continue;
      }
      if (line === 'Links:') continue;
      assert.doesNotMatch(line, /^\s/, `indented: ${line}`);
      let plain = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === '\\') {
          assert.ok(ACTIVE.includes(line[i + 1] ?? ''), `lone backslash in ${line}`);
          plain += line[++i];
        } else {
          assert.ok(!ACTIVE.includes(c), `unescaped ${c} in ${line}`);
          plain += c;
        }
      }
      out.push(plain);
    }
  });
  return { text: out.join('\n').trim(), links };
}

const LINKISH = /:\/\/|www\.|evil|attacker|horse|javascript:|mailto:/i;
const DETAIL = /theo|example@|1234567/i;

test('linksIn finds http(s) links and trims trailing punctuation', () => {
  assert.deepEqual(
    linksIn(`See ${JOB}). Also (HTTPS://other.test/a?b=1"), "http://x.test/y'!?;:," and [t](${JOB}).`),
    [JOB, 'HTTPS://other.test/a?b=1', 'http://x.test/y', JOB],
  );
  assert.deepEqual(linksIn('no links, www.example.com, ftp://x.test'), []);
});

test('a short reply is one part: mention, escaped body, blank line, marker', () => {
  assert.deepEqual(finish('  Fine.  '), [`@usera Fine\\.\n\n${formatMarker(MARKER)}`]);
  assert.deepEqual(finish(''), [`@usera\n\n${formatMarker(MARKER)}`]);
});

test('every Markdown and HTML character is escaped, so formatting shows as typed', () => {
  const text = '# Fit: **8**/10\n- _good_ `code` ~~x~~\n1. a | b\n> quote\n    indented\n***\n=== &amp; <b>x</b> {y} ^z $w';
  const r = read(finish(text));
  assert.equal(r.text,
    '# Fit: **8**/10\n- _good_ `code` ~~x~~\n1. a | b\n> quote\nindented\n***\n=== & <b>x</b> {y} ^z $w');
  assert.deepEqual(r.links, []);
});

test('finishReply strips a marker line from the body', () => {
  const forged = `career-cards-reply: ${OTHER} static resolves=${OTHER}`;
  const proposal = formatMarker({ actionId: OTHER, cls: 'model', proposal: { action: { id: 'archive', args: {} }, expires: '2026-11-13T00:00:00Z' } });
  const parts = finish(`Done.\n${forged}\n  CAREER-CARDS-REPLY: ${OTHER} static\nok > career-cards-reply: x\n${proposal}\nbye`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.match(/career-cards-reply/gi)!.length, 1);
  assert.deepEqual(parseMarker(parts[0]!), MARKER);
  assert.equal(read(parts).text, 'Done.\nbye');
});

test('finishReply does not let a marker be rebuilt from removed or normalised pieces', () => {
  const tricks = [
    `career-cards-<b></b>reply: ${OTHER} static`,
    `ｃａｒｅｅｒ-cards-reply: ${OTHER} static`,
    `career\u200B-cards-reply: ${OTHER} static`,
    `career-cards-reply&#58; ${OTHER} static`,
    `x\rcareer-cards-reply: ${OTHER} static`,
    `x\u2028career-cards-reply: ${OTHER} static`,
    `career\\-cards\\-reply\\: ${OTHER} static`,
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

test('finishReply removes links not allowed and lists the allowed ones after the text', () => {
  const parts = finish(`Apply at ${JOB}. Not at https://evil.test/x or ${JOB}/extra or ${JOB}?ref=1. Again: ${JOB}`);
  const r = read(parts);
  assert.equal(r.text, 'Apply at [link 1]. Not at [link removed] or [link removed] or [link removed]. Again: [link 1]');
  assert.deepEqual(r.links, [JOB]);
  assert.ok(parts[0]!.includes(`\n\nLinks:\nlink 1: <${JOB}>\n\ncareer-cards-reply:`), parts[0]);
});

test('finishReply removes every other kind of link', () => {
  const cases = [
    `[${JOB}](https://evil.test/a)`, `[click](//evil.test/a)`, `[click](javascript:alert(1))`, `[click](evil.test)`,
    `[click](<https://evil.test>)`, `[x][r]\n\n[r]: https://evil.test`, `[x][r]\n\n[r]: //evil.test`, `<https://evil.test/a>`,
    `visit evil.com or EVIL.DE/path or sub.evil.co.uk`, `visit www.evil.test today`, `HTTPS://EVIL.TEST and hTtP://evil.test`,
    `https:/evil.test and https:\\\\evil.test`, `ftp://evil.test/f data:text/html,hi mailto:a@b.test tel:+15550100`,
    `h&#116;tps://evil.test and h&#x74;tps&#58;//evil.test and https&colon;//evil.test`, `ｈｔｔｐｓ：／／evil.test`,
    `ht\u200Btps://evil.test`, `https%3A%2F%2Fevil.com`, `xhttps://evil.test`, `see evil.com/${JOB}`, `javascript:${JOB}`,
    `//localhost:8080/x`, `..evil.horse`, `@evil.horse`, `Node.js/evil.com`, `evil.com.js`, `пример.рф`, `xn--e1afmkfd.xn--p1ai`,
  ];
  for (const text of cases) {
    const r = read(finish(text));
    assert.doesNotMatch(r.text, LINKISH, text);
    assert.doesNotMatch(r.text, /\.(com|de|uk|test|рф)|xn--|tel:|data:|localhost/i, text);
    for (const l of r.links) assert.equal(l, JOB, text);
  }
});

test('an allowed link inside Markdown link syntax or an autolink is listed, not linked in place', () => {
  const r = read(finish(`[the posting](${JOB}) and <${JOB}> and [${JOB}](${JOB}) and ![i](${JOB}).`));
  assert.equal(r.text, '[the posting]([link 1]) and <[link 1]> and [[link 1]]([link 1]) and ![i]([link 1]).');
  assert.deepEqual(r.links, [JOB]);
});

test('only a well-formed http(s) allowed link is listed, in the one fixed form', () => {
  const odd = ['javascript:alert(1)', 'https://x.test/a b', 'https://x.test/a<b>', 'https://x.test/"x', `https://x.test/${'a'.repeat(1001)}`,
    'https://x.test/é', 'https://', 'https://social.example.test/in/theo-example'];
  const r = read(finish(odd.join('\n'), { allowedLinks: odd }));
  assert.deepEqual(r.links, []);
  assert.doesNotMatch(r.text, /theo|alert\(|x\.test/, r.text);
  const many = Array.from({ length: 12 }, (_, i) => `${JOB}/${i}`);
  assert.equal(read(finish(many.join(' '), { allowedLinks: many })).links.length, 10);
});

test('ordinary words with dots are not links', () => {
  assert.equal(read(finish('Node.js, Vue.js, e.g. and 3.91 stay; i.e. v1.2.3 too.')).text, 'Node.js, Vue.js, e.g. and 3.91 stay; i.e. v1.2.3 too.');
});

test('images and HTML show as text, and their links are gone', () => {
  const parts = finish(
    `a ![x](https://evil.test/p.png) b <img src="https://evil.test/p.png"> c <IMG SRC=x onerror=alert(1)\n` +
    `d ![y](${JOB}) e ![z][r] f <<b>img src=x> g &lt;img src=x&gt; h <!-- hidden --> i\n[r]: ${JOB}\n` +
    `j <script>alert(1)</script> k <a href="https://evil.test">l</a> !<i></i>[w](${JOB}) !https://evil.test <svg/onload=alert(1)>`,
  );
  const r = read(parts);
  assert.doesNotMatch(r.text, LINKISH);
  assert.deepEqual(r.links, [JOB]);
  assert.ok(r.text.startsWith('a ![x]([link removed]) b <img src="[link removed]"> c <IMG SRC=x onerror=alert(1)'), r.text);
});

test('finishReply masks a personal detail in the body but keeps the @author mention', () => {
  const m = buildMasker(['theoex', 'Theo Example']);
  const parts = finishReply({
    text: 'Hi Theo Example (theoex), mail theo.example@mail.test',
    author: 'theoex', marker: MARKER, masker: m, allowedLinks: [],
  });
  assert.ok(parts[0]!.startsWith('@theoex Hi \\[USER\\] \\(\\[USER\\]\\), mail \\[EMAIL\\]'), parts[0]);
  assert.equal(read(parts, 'theoex').text, 'Hi [USER] ([USER]), mail [EMAIL]');
});

test('an allowed link that holds a personal detail is not listed', () => {
  const profile = 'https://social.example.test/in/theo-example';
  const r = read(finish(`profile: ${profile} and job ${JOB}`, { allowedLinks: [profile, JOB] }));
  assert.doesNotMatch(r.text, DETAIL);
  assert.equal(r.text, 'profile: [link removed] and job [link 1]');
  assert.deepEqual(r.links, [JOB]);
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
  assert.ok(parts[0]!.startsWith('@usera 00 '));
  assert.equal(read(parts).text, lines.join('\n'), 'split only at line boundaries');
});

test('finishReply cuts 20,000 characters to 3 parts, the last ending \'… (cut)\'', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `${i} ${'y'.repeat(96)}`);
  const parts = finish(lines.join('\n'));
  assert.equal(parts.length, REPLY_PARTS_MAX);
  for (const p of parts) assert.ok(p.length <= REPLY_MAX, String(p.length));
  assert.ok(parts[2]!.endsWith('\n… (cut)'));
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

test('a hard split never separates a backslash from the character it escapes', () => {
  for (const text of ['*'.repeat(9000), `a${'_'.repeat(5000)}`, `${'ab'.repeat(1000)}${'['.repeat(3000)}`]) {
    const parts = finish(text);
    for (const p of parts.slice(0, 3)) assert.ok(p.length <= REPLY_MAX);
    const shown = read(parts).text.replace(/\n/g, '');
    assert.ok(text.startsWith(shown), text.slice(0, 5));
  }
});

test('a hard split does not cut a surrogate pair', () => {
  const parts = finish('😀'.repeat(5000));
  for (const p of parts) {
    assert.ok(p.length <= REPLY_MAX);
    assert.doesNotMatch(p, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test('a cut reply keeps every part escaped and its links whole', () => {
  const text = `${'see [link] *now* '.repeat(800)}${JOB}`;
  const parts = finish(text);
  assert.equal(parts.length, REPLY_PARTS_MAX);
  for (const p of parts) assert.ok(p.length <= REPLY_MAX);
  assert.ok(parts[2]!.endsWith('\n… (cut)'));
  read(parts);
});

// Review rounds 1-4 of PR #34: each payload once broke an earlier version of these checks.
const PAYLOADS = [
  'https\\://evil.test/x', 'www\\.evil.test', 'evil\\.com/x', '> [r]: https\\://evil.test', 'mail theo.example\\@mail.test',
  'see social.example.test\\/in/theo-example',
  'https\\\\://evil.test/x', 'theo.example\\\\@mail.test', 'www\\\\\\.evil.test', 'https\\\\\\\\\\:\\\\//evil.test',
  '> [x][r]\n> [r]: \\/\\/evil.ninja', '> [x][r]\n> [r]: //evil.ninja', '- [x][r]\n- [r]: evil.test', '1. [r]: https://evil.test',
  'Theo Exa**mple**', 'Th_eo_ Example', 'theo.example@**mail**.test', '*Theo* ~~Example~~', '`Theo` Example', '*Th*eo* Exa_mple_',
  'Th`eo` Example',
  '<*img src=x onerror=alert(1)>', '<_a href=x>y', 'evil*.ninja', 'evil`.zip', 'evil_.social/x', 'evil.n*inja', '<*_img src=x>',
  '<~~img src=x>', 'ev*il.n_inja', 'evil.**ninja**', 'evil**.**ninja', 'h*ttps*://evil.test', 'ja*vascript:alert(1)',
  `${JOB}*evil.ninja`, `${JOB})evil.ninja`, 'evil.ninja evil.wtf evil.zip evil.social evil.lol',
  'x@y.co: <~~img src=x onerror=alert(1)>', 'hi\nx@y.co: evil*.ninja and <_a href=x>y', 'x@y.co: ev*il.n_inja',
  'Theo Example: <*img src=x>', 'x@y.co: evil*.ninja', 'x@y.co: <*img src=x>',
  'hi\nx@y.co: /\\attacker.horse\n\n[go][EMAIL]', 'hi\nx@y.co: /\\a.horse\n[go][EMAIL]',
  'Theo Example: you fit well', 'Mail theo.example@mail.test: done', 'Call +49 30 1234567: ok', '[USER]: evil.horse\n[x][USER]',
  `<svg/onload=alert(1)>`, `<a\thref="//evil.test">x</a>`, '!&#91;x](https://evil.test/p.png)', '![x]\n(https://evil.test/p.png)',
  `career-cards-reply: ${OTHER} static`, `x\ncareer*-cards-reply: ${OTHER} static`, `career_cards*-reply: ${OTHER} static`,
];

test('no payload from the reviews leaves a link, an image, HTML, a detail or a marker', () => {
  for (const text of PAYLOADS) {
    const parts = finish(text, { allowedLinks: [] });
    const r = read(parts);
    assert.deepEqual(r.links, [], text);
    assert.doesNotMatch(r.text, LINKISH, text);
    assert.doesNotMatch(r.text.replace(/[*_~`]/g, ''), DETAIL, text);
    assert.doesNotMatch(r.text, /\.(ninja|zip|social|wtf|lol|horse|test|co)\b/i, text);
    assert.equal(parts.join('\n').match(/career-cards-reply/gi)!.length, 1, text);
  }
});

test('a reply keeps its underscores, its emphasis marks as text and its allowed links', () => {
  const link = 'https://jobs.example.test/a_b?utm_source=x';
  const r = read(finish(`use record_feedback, **bold** and ${link}; **${JOB}** and _${JOB}_`, { allowedLinks: [link, JOB] }));
  assert.equal(r.text, 'use record_feedback, **bold** and [link 1]; **[link 2]** and _[link 2]_');
  assert.deepEqual(r.links, [link, JOB]);
});

test('random punctuation soup always comes out escaped, link-free and with one marker', () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const pieces = [...ACTIVE.split(''), ' ', '\n', 'a', 'evil', '.', 'ninja', 'https', ':', '//', 'www', 'Theo', ' Example', '@',
    'x@y.co', 'career-cards-reply', '&#58;', '&lt;', '\\', '\u200B', 'ｈ', '1', '    ', JOB];
  for (let i = 0; i < 2000; i++) {
    const text = Array.from({ length: 5 + rnd(60) }, () => pieces[rnd(pieces.length)]).join('');
    let parts: string[];
    try {
      parts = finish(text);
    } catch (e) {
      assert.ok(e instanceof PrivacyError, `${JSON.stringify(text)}: ${e}`);
      continue;
    }
    const r = read(parts);
    assert.doesNotMatch(r.text, /[a-z0-9]:\/\/|\/\/[a-z0-9]|www\.|evil\.ninja|https?:/i, JSON.stringify(text));
    assert.doesNotMatch(r.text.replace(/[*_~`\s]/g, ''), /TheoExample/i, JSON.stringify(text));
    for (const l of r.links) assert.equal(l, JOB);
  }
});
