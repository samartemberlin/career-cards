// The planted-text fixtures under test/fixtures/injection: front matter with `covers: [...]` (the catalogue ids an
// attack targets) and, for web pages, `url:`, then the text.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type InjectionFixture = { name: string; covers: string[]; url: string; text: string };

export function readInjectionFixtures(dir: string): InjectionFixture[] {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const m = /^---\ncovers: \[([^\]]*)\]\n(?:url: (\S+)\n)?---\n([\s\S]*)$/.exec(readFileSync(join(dir, f), 'utf8'));
    assert.ok(m, `${f}: front matter`);
    return { name: f.replace(/\.md$/, ''), covers: m[1]!.split(',').map((s) => s.trim()).filter(Boolean), url: m[2] ?? '', text: m[3]!.trim() };
  });
}
