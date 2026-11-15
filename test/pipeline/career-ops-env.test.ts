import test from 'node:test';
import assert from 'node:assert/strict';
import { careerOpsEnv } from '../../src/pipeline/career-ops-env.ts';

test('careerOpsEnv passes PATH, HOME, LANG and the heap cap in NODE_OPTIONS, nothing else', () => {
  const env = careerOpsEnv(
    { PATH: '/bin', HOME: '/h', LANG: 'C', NODE_OPTIONS: '--max-old-space-size=200', TRELLO_TOKEN: 't', GEMINI_API_KEY: 'g' },
    { CAREER_OPS_DATA_DIR: '/tmp/x' },
  );
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', LANG: 'C', NODE_OPTIONS: '--max-old-space-size=200', CAREER_OPS_DATA_DIR: '/tmp/x' });
});
