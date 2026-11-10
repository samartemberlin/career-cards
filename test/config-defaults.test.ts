import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultsDir = join(root, 'config', 'defaults');

describe('default sources parse', () => {
  for (const name of ['portals.yml', 'extra-sources.yml', 'scan-profile.yml']) {
    it(`${name} loads as valid YAML`, () => {
      const text = readFileSync(join(defaultsDir, name), 'utf8');
      const parsed = load(text);
      assert.ok(parsed !== null && parsed !== undefined, `${name} should not be empty`);
    });
  }

  it('portals.yml has tracked_companies with at least one entry', () => {
    const text = readFileSync(join(defaultsDir, 'portals.yml'), 'utf8');
    const parsed = load(text) as { tracked_companies?: unknown[] };
    assert.ok(Array.isArray(parsed.tracked_companies), 'tracked_companies must be an array');
    assert.ok(parsed.tracked_companies.length > 0, 'tracked_companies must not be empty');
  });
});
