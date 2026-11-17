import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRubric } from '../../src/compile/rubric.ts';
import type { ScoringText } from '../../src/compile/rubric.ts';
import type { Compiled } from '../../src/compile/schema.ts';

const C: Compiled = {
  places: { anywhere: true, keep: [], drop: [] },
  employment: { keep: [], remote_only: [] },
  linkedin_locations: [],
  company_exclude: [],
  text_exclude: [],
  languages: {},
  years_experience: null,
  profiles: [
    {
      name: 'Editor',
      search_terms: ['editor'],
      title_include: ['editor'],
      title_exclude: [],
      examples: [
        { role: 'Content Editor at a tech startup', score: 8 },
        { role: 'Editorial intern', score: 3 },
      ],
    },
    {
      name: 'Designer',
      search_terms: ['designer'],
      title_include: ['designer'],
      title_exclude: [],
      examples: [],
    },
  ],
  unused: [],
  problems: [],
};

const T: ScoringText = {
  niceToHave: [
    { name: 'Company size', text: 'small startup, up to 50 people' },
    { name: 'Industries I like', text: 'none' },
  ],
  profiles: [
    { name: 'Editor', dream: 'A content lead role at a modern media company', examples: 'Love: digital media. Skip: PR agencies.' },
    { name: 'Designer', dream: 'Visual design at a small agency', examples: '' },
  ],
};

const EXPECTED_EDITOR = `Score 0-10 how well a job fits this candidate: 8-10 apply now, 5-7 worth a look, 3-4 a stretch, 0-2 not a fit.

## Profile: Editor
### Dream job (the candidate's words)
A content lead role at a modern media company
### Jobs they would love or skip (the candidate's words)
Love: digital media. Skip: PR agencies.
### Example roles
| Role | Score |
|---|---|
| Content Editor at a tech startup | 8 |
| Editorial intern | 3 |

## What matters to the candidate
**Company size:** small startup, up to 50 people`;

test('buildRubric: exact text for one active profile with two examples and one nice-to-have card', () => {
  const result = buildRubric(C, T, ['Editor']);
  assert.equal(result, EXPECTED_EDITOR);
});

test('buildRubric: "none" card is left out', () => {
  const result = buildRubric(C, T, ['Editor']);
  assert.ok(!result.includes('Industries I like'));
});

test('buildRubric: inactive profile is left out', () => {
  const result = buildRubric(C, T, ['Editor']);
  assert.ok(!result.includes('## Profile: Designer'));
});

test('buildRubric: empty examples omits Example roles block', () => {
  const result = buildRubric(C, T, ['Designer']);
  assert.ok(!result.includes('### Example roles'));
  assert.ok(result.includes('## Profile: Designer'));
  assert.ok(result.includes('Visual design at a small agency'));
});
