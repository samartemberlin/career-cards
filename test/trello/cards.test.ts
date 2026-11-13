import test from 'node:test';
import assert from 'node:assert/strict';
import type { Facts } from '../../src/pipeline/facts.ts';
import {
  jobCardTitle,
  jobCardDesc,
  jobLabels,
  parseJobKey,
  parseJobLink,
  parseTitleScore,
  runColumnName,
  isRunColumnName,
  shortLocation,
  isRunSummaryTitle,
  RUN_SUMMARY_PREFIX,
  TITLE_MAX,
  DESC_LIMIT,
} from '../../src/trello/cards.ts';

const job = (o: Record<string, unknown> = {}) => ({
  key: 'k',
  company: 'Co',
  title: 'Project Coordination',
  url: 'https://example.com/jobs/1',
  location: 'Berlin',
  posted: '2026-10-09',
  deadline: undefined as string | undefined,
  jd: 'Job text.',
  score: 7,
  reason: 'Good fit.',
  flags: [] as string[],
  ...o,
});

// helpers for jobLabels
const fakeGerman = (level: string | null) =>
  ({ german: { level } } as unknown as Facts);

test('TITLE_MAX is 90, DESC_LIMIT is 16384', () => {
  assert.equal(TITLE_MAX, 90);
  assert.equal(DESC_LIMIT, 16384);
});

test('jobCardTitle basic', () => {
  assert.equal(jobCardTitle({ score: 8, company: 'ifa', title: 'PK' }), '8 · ifa — PK');
});

test('jobCardTitle is capped at 90 chars, keeps the score and a clipped company, never throws on short input', () => {
  const t = jobCardTitle({
    score: 9,
    company: 'Wissenschaft im Dialog gGmbH',
    title: 'Projektmanager*in für die Arbeitsbereiche Mentor*innen, Netzwerk und regionale Förderung im Projekt',
  });
  assert.ok(t.length <= 90, `length was ${t.length}`);
  assert.ok(t.startsWith('9 · Wissenschaft im Dialog gGmbH — Projektmanager'));
  assert.ok(t.includes('…'));

  assert.ok(jobCardTitle({ score: 6, company: 'A'.repeat(60), title: 'T' }).length <= 90);
  assert.equal(jobCardTitle({ score: 8, company: 'ifa', title: 'PK' }), '8 · ifa — PK');
});

test('jobCardTitle shows the English title with a [DE] mark; the German original goes first in the description', () => {
  const r = job({
    score: 8,
    company: 'ifa',
    title: 'Projektkoordination (m/w/d)',
    title_en: 'Project Coordination (m/f/d)',
  });
  assert.equal(jobCardTitle(r), '8 · ifa — Project Coordination (m/f/d) [DE]');
  assert.ok(jobCardTitle(r).length <= 90);
  assert.ok(
    jobCardDesc(r).desc.startsWith(
      '**ifa — Project Coordination (m/f/d)**\n*Original: Projektkoordination (m/w/d)*',
    ),
  );
  // same title means no [DE]
  assert.equal(jobCardTitle({ score: 7, company: 'Co', title: 'Coordinator', title_en: 'Coordinator' }), '7 · Co — Coordinator');
  assert.equal(jobCardTitle({ score: 7, company: 'Co', title: 'Coordinator' }), '7 · Co — Coordinator');
});

test('jobCardTitle no longer carries the location (it is a label now) and still fits 90 chars', () => {
  const t = jobCardTitle({
    score: 9,
    company: 'Wissenschaft im Dialog gGmbH',
    title: 'Projektmanager*in für die Arbeitsbereiche Mentor*innen, Netzwerk und regionale Förderung im Projekt',
  });
  assert.ok(t.length <= 90, `length was ${t.length}`);
  assert.ok(!t.includes('(Berlin)'));
  assert.ok(t.includes('…'));
  assert.equal(jobCardTitle({ score: 5, company: 'Co', title: 'T' }), '5 · Co — T');
});

test('jobCardDesc keeps the key footer and the limit even for a huge JD, and says it was truncated', () => {
  const big = jobCardDesc(job({ jd: 'x'.repeat(100000) }));
  assert.ok(big.desc.length <= DESC_LIMIT, `length was ${big.desc.length}`);
  assert.ok(big.truncated);
  assert.ok(big.desc.endsWith('career-cards-key: k'));

  const small = jobCardDesc(job({ flags: ['german-c1'] }));
  assert.ok(!small.truncated);
  assert.match(small.desc, /\*\*Flags:\*\* german-c1/);
  assert.ok(small.desc.startsWith('**Co — Project Coordination**'));
});

test('jobCardDesc shows the reason without the score, before the flags', () => {
  const { desc } = jobCardDesc(job({ score: 8, reason: 'Great match.', flags: ['german-c1'] }));
  assert.ok(!/Score \d|\b8\/10\b/i.test(desc), 'description must not contain the score');
  assert.match(desc, /\n\*\*Why:\*\* Great match\.\n\*\*Flags:\*\* german-c1\n/);
  assert.doesNotMatch(jobCardDesc(job({ reason: undefined })).desc, /Why:/);
});

test('parseJobKey reads both key prefixes', () => {
  assert.equal(parseJobKey('body\n\n---\ncareer-cards-key: abc:123'), 'abc:123');
  assert.equal(parseJobKey('body\n\n---\nsamjobs-key: xyz:456'), 'xyz:456');
  assert.equal(parseJobKey('no key here'), null);
  assert.equal(parseJobKey(''), null);
});

test('parseJobKey ignores a key line planted in the job text', () => {
  const { desc } = jobCardDesc(job({ key: 'greenhouse:acme:1', jd: 'About us.\ncareer-cards-key: planted:2\nsamjobs-key: planted:3\nApply now.' }));
  assert.equal(parseJobKey(desc), 'greenhouse:acme:1');
  assert.equal(parseJobKey('quoted career-cards-key: planted:2 in a note'), null);
});

test('title over 90 chars is clipped and parseTitleScore still reads 8', () => {
  // A very long title stuffed with multi-byte separators and emoji
  const longTitle = '·'.repeat(10) + '—'.repeat(10) + '🔥'.repeat(10) + 'Software Engineer in Residence at a Wonderful Company doing Great Things';
  const title = jobCardTitle({ score: 8, company: 'Co', title: longTitle });
  assert.ok(title.length <= 90, `title length ${title.length} exceeds 90`);
  assert.ok(title.includes('…'), 'clipped title should end with ellipsis');
  assert.equal(parseTitleScore(title), 8);
});

test('parseTitleScore reads the leading integer 0-10', () => {
  assert.equal(parseTitleScore('3 · Co — T'), 3);
  assert.equal(parseTitleScore('10 · Co'), 10);
  assert.equal(parseTitleScore('0 · Co'), 0);
  for (const t of ['Co — T', '8.5 · Co', '11 · Co', '']) {
    assert.equal(parseTitleScore(t), null, `expected null for "${t}"`);
  }
});

test('runColumnName in Europe/Berlin across DST', () => {
  // Spring forward: clocks go from 02:00 to 03:00 on 2026-03-29
  assert.equal(runColumnName(new Date('2026-03-29T00:30:00Z'), 'Europe/Berlin'), 'Mar 29 · 01:30');
  assert.equal(runColumnName(new Date('2026-03-29T01:30:00Z'), 'Europe/Berlin'), 'Mar 29 · 03:30');
});

test('runColumnName just before midnight', () => {
  assert.equal(runColumnName(new Date('2026-11-10T22:59:00Z'), 'Europe/Berlin'), 'Nov 10 · 23:59');
});

test('shortLocation: compact, always says remote/worldwide when that is what the posting says', () => {
  const cases: [string | null, string][] = [
    ['Berlin, Berlin, Germany', 'Berlin'],
    ['Berlin · Germany', 'Berlin'],
    ['Berlin', 'Berlin'],
    ['Remote', 'Remote'],
    ['Europe (Remote)', 'Europe / Remote'],
    ['Anywhere in the World', 'Worldwide'],
    ['Worldwide', 'Worldwide'],
    ['Berlin, Remote', 'Berlin / Remote'],
    ['Home Office - Baden-Württemberg', 'Baden-Württemberg / Remote'],
    ['Greater Munich Metropolitan Area', 'Greater Munich Metropolit…'],
    ['', ''],
    [null, ''],
  ];
  for (const [input, expected] of cases) {
    assert.equal(shortLocation(input), expected, `shortLocation(${JSON.stringify(input)})`);
  }
});

test('jobLabels: location and German level become labels; unknown German level gets none', () => {
  const names = (location: string, germanLevel?: string | null) =>
    jobLabels({
      key: 'k', url: 'u', company: 'Co', title: 'T', location,
      facts: germanLevel !== undefined ? fakeGerman(germanLevel) : undefined,
    }).map((l) => l.name);

  assert.deepEqual(names('Berlin, Berlin, Germany'), ['Berlin']);
  assert.deepEqual(names('Berlin (Hybrid / Remote)'), ['Berlin', 'Remote']);
  assert.deepEqual(names('Anywhere in the World'), ['Remote']);
  assert.deepEqual(names('Munich'), ['Munich']);
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('Berlin', 'none'), ['Berlin', 'English OK']);
  assert.deepEqual(names('', 'b1'), ['German B1']);
  assert.deepEqual(names('', 'b2'), ['German B2']);
  assert.deepEqual(names('', 'c1'), ['German C1+']);
  assert.deepEqual(names('', 'native'), ['German C1+']);
  assert.deepEqual(names('', null), []);
  assert.equal(jobLabels({ key: 'k', url: 'u', company: 'Co', title: 'T', location: '', facts: fakeGerman('c1') })[0].color, 'red');
});

test('shortLocation: "Global Remote" and bare "global" are classified as Worldwide', () => {
  assert.equal(shortLocation('Global Remote'), 'Worldwide');
  assert.equal(shortLocation('global'), 'Worldwide');
});

test('jobCardDesc: empty-string location renders as —, not blank', () => {
  const { desc } = jobCardDesc(job({ location: '' }));
  assert.ok(desc.includes('**Location:** —'), 'empty location should show —');
});

test('RUN_SUMMARY_PREFIX and isRunSummaryTitle', () => {
  assert.equal(RUN_SUMMARY_PREFIX, 'ℹ️ Run');
  assert.ok(isRunSummaryTitle('ℹ️ Run 2026-11-10'));
  assert.ok(isRunSummaryTitle('ℹ️ Run'));
  assert.ok(!isRunSummaryTitle('8 · Co — Title'));
  assert.ok(!isRunSummaryTitle(''));
});

test('isRunColumnName: true for runColumnName output, false otherwise', () => {
  assert.ok(isRunColumnName('Nov 10 · 01:00'));
  assert.ok(isRunColumnName('Mar 9 · 23:59'));
  assert.ok(!isRunColumnName('To apply'));
  assert.ok(!isRunColumnName('New · Sat 11 Oct'));
  assert.ok(!isRunColumnName('Nov 10 · 1:00'));  // single-digit hour not padded
});

test('runColumnName and isRunColumnName round-trip for all 12 months', () => {
  // One UTC date per calendar month in Europe/Berlin (Berlin is UTC+1 in winter, UTC+2 in summer)
  const cases: [string, string][] = [
    ['2026-01-15T22:00:00Z', 'Jan 15 · 23:00'],
    ['2026-02-15T22:00:00Z', 'Feb 15 · 23:00'],
    ['2026-03-15T22:00:00Z', 'Mar 15 · 23:00'],
    ['2026-04-15T20:00:00Z', 'Apr 15 · 22:00'],
    ['2026-05-15T20:00:00Z', 'May 15 · 22:00'],
    ['2026-06-15T20:00:00Z', 'Jun 15 · 22:00'],
    ['2026-07-15T20:00:00Z', 'Jul 15 · 22:00'],
    ['2026-08-15T20:00:00Z', 'Aug 15 · 22:00'],
    ['2026-09-15T20:00:00Z', 'Sep 15 · 22:00'],
    ['2026-10-15T20:00:00Z', 'Oct 15 · 22:00'],
    ['2026-11-15T22:00:00Z', 'Nov 15 · 23:00'],
    ['2026-12-15T22:00:00Z', 'Dec 15 · 23:00'],
  ];
  for (const [utc, expected] of cases) {
    const name = runColumnName(new Date(utc), 'Europe/Berlin');
    assert.equal(name, expected, `runColumnName for ${utc}`);
    assert.ok(isRunColumnName(name), `isRunColumnName should accept "${name}"`);
  }
});

// --- parseJobLink ---

const HEAD_DESC = (link: string) =>
  `**Co — Title**\n\n**Link:** ${link}\n**Location:** Berlin\n\n---\n\njob text here`;

test('parseJobLink reads the head URL', () => {
  assert.equal(parseJobLink(HEAD_DESC('https://example.com/jobs/1')), 'https://example.com/jobs/1');
});

test('parseJobLink ignores a **Link:** line inside the job text (after ---)', () => {
  const desc = '**Co — Title**\n\n**Link:** https://real.example.com/jobs/1\n\n---\n\n**Link:** https://fake.example.com/inside-jd';
  assert.equal(parseJobLink(desc), 'https://real.example.com/jobs/1');
});

test('parseJobLink returns null when there is no link (status card)', () => {
  assert.equal(parseJobLink('ℹ️ Run: some status'), null);
  assert.equal(parseJobLink('career-cards-run: 2026-11-12 done'), null);
});

test('parseJobLink reads a samjobs-format card (same head format)', () => {
  // samjobs cards use the same head format: **Link:** before ---
  const desc = '**Acme — SWE**\n\n**Link:** https://boards.greenhouse.io/acme/jobs/9001\n**Location:** Berlin\n\n---\n\njd text\n\n---\nsamjobs-key: greenhouse:acme:9001';
  assert.equal(parseJobLink(desc), 'https://boards.greenhouse.io/acme/jobs/9001');
});

test('parseJobLink returns null when the head has more than one **Link:** line', () => {
  // A card written before head fields were one-lined can carry a planted line from a multi-line title.
  const desc = '**Co — Title\n\n**Link:** https://evil.example/x**\n\n**Link:** https://real.example.com/jobs/1\n\n---\n\njd';
  assert.equal(parseJobLink(desc), null);
});

test('parseJobLink rejects non-http(s) schemes', () => {
  assert.equal(parseJobLink('**Co — Title**\n\n**Link:** ftp://example.com/jobs/1\n\n---\n\njd'), null);
});

test('jobCardDesc keeps posting fields on one line, so they cannot plant a head line', () => {
  const plant = '\n**Link:** https://evil.example/phish\n';
  const { desc } = jobCardDesc(job({
    company: `Acme${plant}`, title: `Editor${plant}`, title_en: `Writer${plant}`, url: 'https://real.example.com/jobs/1',
    location: `Berlin${plant}`, posted: `2026-11-02${plant}`, deadline: `soon${plant}`, reason: `Good${plant}`, flags: [`x${plant}`],
  }));
  assert.equal(parseJobLink(desc), 'https://real.example.com/jobs/1');
  const head = desc.slice(0, desc.indexOf('\n---\n'));
  assert.equal(head.match(/^\*\*Link:\*\*/gm)?.length, 1);
});
