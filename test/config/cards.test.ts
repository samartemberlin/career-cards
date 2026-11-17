import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAL_BREAKERS, NICE_TO_HAVE, PROFILE, ABOUT_ME,
  specOf, templateOf, answerOf,
} from '../../src/config/cards.ts';

test('template-only card has no answer', () => {
  for (const s of [...DEAL_BREAKERS, ...NICE_TO_HAVE, ...PROFILE.filter((c) => c.key !== 'active'), ...ABOUT_ME]) {
    assert.equal(answerOf(s, templateOf(s)), '');
    assert.equal(answerOf(s, `\n${templateOf(s)}\n\n  \n`), '');
  }
});

test('answer keeps the user text, drops the questions', () => {
  const s = specOf('where');
  assert.equal(
    answerOf(s, `${templateOf(s)}\n\nBerlin, onsite or hybrid.\nRemote only if full-time.`),
    'Berlin, onsite or hybrid.\nRemote only if full-time.',
  );
  assert.equal(answerOf(s, 'none'), 'none');
});

test('the Active template answers yes', () => assert.equal(answerOf(specOf('active'), templateOf(specOf('active'))), 'yes'));

test('card names are unique', () => {
  const all = [...DEAL_BREAKERS, ...NICE_TO_HAVE, ...PROFILE, ...ABOUT_ME];
  const names = all.map((s) => s.name.toLowerCase());
  assert.equal(new Set(names).size, all.length);
});

test('specOf returns the matching spec', () => {
  assert.equal(specOf('where').name, 'Where & how I work');
  assert.equal(specOf('active').required, true);
  assert.equal(specOf('examples').required, false);
});

test('templateOf wraps questions in underscores', () => {
  const s = specOf('dream');
  const t = templateOf(s);
  for (const q of s.questions) {
    assert.ok(t.includes(`_${q}_`), `missing question: ${q}`);
  }
});

test('Active template ends with yes on its own line', () => {
  const t = templateOf(specOf('active'));
  assert.equal(t.split('\n').at(-1), 'yes');
});
