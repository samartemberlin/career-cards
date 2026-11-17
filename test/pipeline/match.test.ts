import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, findPhrase } from '../../src/pipeline/match.ts';

test('fold normalises umlauts and sharp s', () => {
  assert.equal(fold('Münchner Straße'), 'munchner strasse');
});

test('findPhrase word mode: matches whole word', () => {
  assert.equal(findPhrase('Senior Online-Redakteur (m/w/d)', 'redakteur', 'word'), 'Redakteur');
});

test('findPhrase word mode: no match when phrase is a word-interior substring', () => {
  assert.equal(findPhrase('Chefredakteur', 'redakteur', 'word'), null);
});

test('findPhrase substring mode: matches inside a word', () => {
  assert.equal(findPhrase('Chefredakteur', 'redakteur', 'substring'), 'redakteur');
});

test('findPhrase word mode: eu inside "Reuters" is not a word boundary hit', () => {
  assert.equal(findPhrase('Reuters, London', 'EU', 'word'), null);
});

test('findPhrase word mode: EU in parens is a whole-word match', () => {
  assert.equal(findPhrase('Remote (EU)', 'eu', 'word'), 'EU');
});

test('findPhrase word mode: C++ is a whole-word match', () => {
  assert.equal(findPhrase('C++ Developer', 'C++', 'word'), 'C++');
});

test('findPhrase word mode: (m/w/d) matches whole token', () => {
  assert.equal(findPhrase('Developer (m/w/d)', '(m/w/d)', 'word'), '(m/w/d)');
});

test('findPhrase word mode: Zürich found by folded phrase zurich', () => {
  assert.equal(findPhrase('Zürich', 'zurich', 'word'), 'Zürich');
});

test('findPhrase returns null for empty phrase', () => {
  assert.equal(findPhrase('anything', '', 'word'), null);
});

test('findPhrase returns null for whitespace-only phrase not in text', () => {
  assert.equal(findPhrase('anything', '   ', 'substring'), null);
});
