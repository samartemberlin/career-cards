import test from 'node:test';
import assert from 'node:assert/strict';
import { readingOf, readingText } from '../../src/compile/reading.ts';
import type { CardReading } from '../../src/compile/reading.ts';
import type { CompileInput } from '../../src/compile/compile.ts';
import type { Compiled } from '../../src/compile/schema.ts';

const SAMPLE: Compiled = {
  places: { anywhere: false, keep: ['Berlin', 'Germany', 'Deutschland'], drop: ['Munich'] },
  employment: { keep: ['full_time', 'part_time'], remote_only: ['full_time'] },
  linkedin_locations: [{ location: 'Berlin' }, { location: 'Germany', remote: true }],
  company_exclude: ['Acme Corp'],
  text_exclude: ['unpaid'],
  languages: { de: { read: 'B2', write: 'B1', speak: 'B2' } },
  years_experience: 3,
  profiles: [{
    name: 'Content editor',
    search_terms: ['content editor', 'Redakteur'],
    title_include: ['editor', 'redakteur'],
    title_exclude: ['senior'],
    examples: [
      { role: 'Editor at a culture magazine', score: 9 },
      { role: 'Copy editor at an agency', score: 6 },
      { role: 'Sales manager', score: 1 },
    ],
  }],
  unused: [
    { card: 'content editor › my dream job', text: 'at least 50k a year', reason: 'postings rarely state salary' },
    { card: 'Somewhere else', text: 'a dog-friendly office', reason: 'no field for it' },
  ],
  problems: [],
};

const INPUT: CompileInput = {
  dealBreakers: [
    { key: 'where', name: 'Where & how I work', text: 'Berlin or anywhere in Germany, not Munich' },
    { key: 'contract', name: 'Contract & visa', text: 'full or part time' },
    { key: 'languages', name: 'Languages', text: 'German B2' },
    { key: 'never', name: 'Never these companies or words', text: 'Acme Corp, unpaid' },
  ],
  profiles: [{
    name: 'Content editor',
    cards: [
      { key: 'roles', name: "Role names I'd take", text: 'Content editor' },
      { key: 'words', name: 'Words I want / avoid', text: 'avoid senior' },
      { key: 'dream', name: 'My dream job', text: 'A culture magazine, 50k at least' },
    ],
  }],
};

const NICE = [{ name: 'Company size', text: 'small teams' }, { name: 'Industries I like', text: 'None' }];

test('readingOf: the sample object reads with the exact strings, in board order', () => {
  const r = readingOf(SAMPLE, INPUT, NICE);
  assert.deepEqual(r, [
    {
      card: 'Where & how I work',
      hardRules: [
        'Keep jobs located in: Berlin, Germany, Deutschland',
        'Drop jobs located in: Munich',
        'Remote jobs only if: full_time',
        'LinkedIn searches in: Berlin, Germany (remote)',
      ],
      scoring: [], unused: [], problems: [],
    },
    { card: 'Contract & visa', hardRules: ['Keep only these contracts: full_time, part_time'], scoring: [], unused: [], problems: [] },
    {
      card: 'Languages', hardRules: [],
      scoring: [
        'German: read B2, write B1, speak B2',
        'Experience: 3 years',
        "Language and experience limits lower a job's ranking only in the run notes for now; they do not drop jobs.",
      ],
      unused: [], problems: [],
    },
    {
      card: 'Never these companies or words',
      hardRules: ['Drop these companies: Acme Corp', 'Drop jobs whose text says: unpaid'], scoring: [], unused: [], problems: [],
    },
    { card: 'Company size', hardRules: [], scoring: ['Sent to scoring as written'], unused: [], problems: [] },
    { card: 'Industries I like', hardRules: [], scoring: ['Nothing to use ("none")'], unused: [], problems: [] },
    {
      card: "Content editor › Role names I'd take",
      hardRules: ['Search for: content editor, Redakteur', 'Keep job titles containing: editor, redakteur'], scoring: [], unused: [], problems: [],
    },
    { card: 'Content editor › Words I want / avoid', hardRules: ['Drop job titles containing: senior'], scoring: [], unused: [], problems: [] },
    {
      card: 'Content editor › My dream job', hardRules: [],
      scoring: ['Sent to scoring as written', 'Example roles: Editor at a culture magazine 9, Copy editor at an agency 6, Sales manager 1'],
      unused: [{ text: 'at least 50k a year', reason: 'postings rarely state salary' }],
      problems: [],
    },
    { card: 'Other', hardRules: [], scoring: [], unused: [{ text: 'a dog-friendly office', reason: 'no field for it' }], problems: [] },
  ]);
});

test('readingOf: anywhere, and a contract card with nothing to keep', () => {
  const c: Compiled = { ...SAMPLE, places: { anywhere: true, keep: [], drop: [] }, employment: { keep: [], remote_only: [] }, linkedin_locations: [] };
  const r = readingOf(c, { dealBreakers: INPUT.dealBreakers.slice(0, 2), profiles: [] }, []);
  assert.deepEqual(r[0]!.hardRules, ['Keep jobs anywhere']);
  assert.deepEqual(r[1]!.hardRules, []);
});

test('readingOf: model problem shown as a reason on matching entry; unmatched goes to Other', () => {
  const c: Compiled = {
    ...SAMPLE,
    problems: [
      { card: 'contract & visa', reason: 'says employee contracts only' },
      { card: 'Unknown card', reason: 'no matching card' },
    ],
  };
  const r = readingOf(c, { dealBreakers: INPUT.dealBreakers.slice(0, 2), profiles: [] }, []);
  const contract = r.find((e) => e.card === 'Contract & visa');
  assert.ok(contract, 'Contract & visa entry expected');
  assert.deepEqual(contract!.problems, ['says employee contracts only']);
  const other = r.find((e) => e.card === 'Other');
  assert.ok(other, 'Other entry expected for unmatched problem');
  assert.deepEqual(other!.problems, ['no matching card']);
});

test('readingText: "Check this card:" renders after "Not used"', () => {
  const r: CardReading[] = [{
    card: 'Contract & visa',
    hardRules: [],
    scoring: [],
    unused: [{ text: 'freelance', reason: 'no field' }],
    problems: ['says employee contracts only'],
  }];
  const out = readingText(r);
  assert.ok(out.includes('Not used: freelance (no field)'), `missing Not used: ${out}`);
  assert.ok(out.includes('Check this card: says employee contracts only'), `missing Check this card: ${out}`);
  const notUsedPos = out.indexOf('Not used:');
  const checkPos = out.indexOf('Check this card:');
  assert.ok(notUsedPos < checkPos, `"Not used" should appear before "Check this card": ${out}`);
});

test('readingOf: duplicate LinkedIn locations are deduplicated (case-insensitive, by location+remote)', () => {
  const c: Compiled = {
    ...SAMPLE,
    linkedin_locations: [
      { location: 'Berlin' },
      { location: 'berlin' },
      { location: 'Berlin', remote: true },
      { location: 'Berlin' },
    ],
  };
  const r = readingOf(c, { dealBreakers: [INPUT.dealBreakers[0]!], profiles: [] }, []);
  const where = r.find((e) => e.card === 'Where & how I work');
  const liLine = where!.hardRules.find((l) => l.startsWith('LinkedIn searches in'));
  assert.ok(liLine, `no LinkedIn line in: ${JSON.stringify(where!.hardRules)}`);
  assert.equal(liLine!, 'LinkedIn searches in: Berlin, Berlin (remote)');
});

test('readingOf: 9 places show 8 and "… and 1 more"', () => {
  const keep = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8', 'I9'];
  const c: Compiled = { ...SAMPLE, places: { anywhere: false, keep, drop: [] }, employment: { keep: [], remote_only: [] }, linkedin_locations: [] };
  const r = readingOf(c, { dealBreakers: [INPUT.dealBreakers[0]!], profiles: [] }, []);
  assert.deepEqual(r[0]!.hardRules, ['Keep jobs located in: A1, B2, C3, D4, E5, F6, G7, H8 … and 1 more']);
});

const TWO: CardReading[] = [
  { card: 'Where & how I work', hardRules: ['Keep jobs located in: Berlin', 'Drop jobs located in: Munich'], scoring: [], unused: [], problems: [] },
  {
    card: 'Content editor › My dream job', hardRules: [], scoring: ['Sent to scoring as written'],
    unused: [{ text: 'at least 50k', reason: 'postings rarely state salary' }, { text: 'a dog', reason: 'no field' }],
    problems: [],
  },
];

test('readingText: exact output for two cards', () => {
  assert.equal(readingText(TWO), [
    '**Where & how I work**',
    'Hard rules: Keep jobs located in: Berlin; Drop jobs located in: Munich',
    '',
    '**Content editor › My dream job**',
    'Hard rules: none',
    'Used by scoring: Sent to scoring as written',
    'Not used: at least 50k (postings rarely state salary); a dog (no field)',
  ].join('\n'));
});

test('readingText: model text stays on one line', () => {
  const r: CardReading[] = [{ card: 'Other', hardRules: [], scoring: [], unused: [{ text: 'a\n**Fake**', reason: 'x' }], problems: [] }];
  assert.equal(readingText(r), '**Other**\nHard rules: none\nNot used: a **Fake** (x)');
});

test('readingText: max clips with "…"', () => {
  const out = readingText(TWO, { max: 30 });
  assert.equal(out.length, 30);
  assert.ok(out.endsWith('…'));
  assert.equal(out, readingText(TWO).slice(0, 29) + '…');
});

test('readingOf: languages shows a line per language with known code names', () => {
  const c = { ...SAMPLE, languages: { en: { read: 'C1', write: 'C1', speak: 'C1' }, de: { read: 'B2', write: 'B1', speak: 'B1' } } } as unknown as typeof SAMPLE;
  const input = { dealBreakers: [{ key: 'languages' as const, name: 'Languages', text: 'English C1, German B2' }], profiles: [] };
  const r = readingOf(c, input, []);
  const scoring = r[0]!.scoring;
  assert.ok(scoring.includes('English: read C1, write C1, speak C1'), `expected English line in ${JSON.stringify(scoring)}`);
  assert.ok(scoring.includes('German: read B2, write B1, speak B1'), `expected German line in ${JSON.stringify(scoring)}`);
});
