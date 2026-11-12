import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src');

// The CLI entry point builds the one raw client and hands it to runOnce, which scopes it with scopeUserBoards.
const RAW_CLIENT_ALLOWED = new Set(['run.ts']);

test('outside src/trello/, nothing imports scopeClient, and only the CLI entry point imports createTrelloClient', () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const rel = relative(SRC, join(entry.parentPath, entry.name)).split('\\').join('/');
    if (rel.startsWith('trello/')) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    if (/\bscopeClient\b/.test(text)) offenders.push(`${rel}: scopeClient`);
    if (/\bcreateTrelloClient\b/.test(text) && !RAW_CLIENT_ALLOWED.has(rel)) offenders.push(`${rel}: createTrelloClient`);
  }
  assert.deepEqual(offenders, []);
});
