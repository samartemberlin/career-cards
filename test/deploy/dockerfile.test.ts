import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve project root relative to this test file (test/deploy/ → ../../)
const root = new URL('../../', import.meta.url).pathname;
const df = readFileSync(join(root, 'Dockerfile'), 'utf-8');
const ignore = readFileSync(join(root, '.dockerignore'), 'utf-8');

describe('Dockerfile', () => {
  it('pins the base image by digest', () => assert.match(df, /^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}/m));

  it('pins the claude CLI to the version MODEL_TOOL_FLAGS was checked against', () =>
    assert.match(df, /@anthropic-ai\/claude-code@2\.1\.322\b/));

  it('runs as the node user', () => assert.match(df, /^USER node$/m));

  it('declares no secret-looking ENV or ARG', () => assert.doesNotMatch(df, /^(ENV|ARG)\s+\S*(KEY|TOKEN|SECRET)/im));

  it('entrypoint is main.ts, default command serve', () => {
    assert.match(df, /ENTRYPOINT\s+\["node",\s*"src\/main\.ts"\]/);
    assert.match(df, /CMD\s+\["serve"\]/);
  });
});

describe('.dockerignore', () => {
  it('keeps secrets and worktrees out', () =>
    ['.env*', '.worktrees', 'tools/.*.json', '**/.git'].forEach((p) => assert.ok(ignore.includes(p), `missing: ${p}`)));
});
