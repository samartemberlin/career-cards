import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

describe('smoke', () => {
  it('zod string parse returns the value', () => {
    assert.strictEqual(z.string().parse('ok'), 'ok');
  });
});
