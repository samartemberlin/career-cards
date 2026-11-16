import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'tools/publish-template.sh');

describe('publish-template.sh', () => {
  it('rejects a non-40-hex SHA', () => {
    const r = spawnSync('bash', [script, '--dry-run', 'notasha'], { cwd: root });
    assert.notEqual(r.status, 0, 'should fail on non-hex SHA');
    assert.match(r.stderr.toString(), /40 lowercase hex/);
  });

  it('rejects a 40-hex SHA not on origin/main', () => {
    const r = spawnSync('bash', [script, '--dry-run', '0000000000000000000000000000000000000000'], { cwd: root });
    assert.notEqual(r.status, 0, 'should fail on SHA absent from origin/main');
    assert.match(r.stderr.toString(), /not an ancestor/);
  });

  it('dry-run with a SHA on origin/main prints file list and exits 0', () => {
    let sha: string;
    try {
      sha = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main'], { encoding: 'utf-8' }).trim();
    } catch {
      // Shallow clone without origin/main — skip
      return;
    }
    const r = spawnSync('bash', [script, '--dry-run', sha], { cwd: root });
    assert.equal(r.status, 0, `dry-run failed: ${r.stderr.toString()}`);
    const out = r.stdout.toString();
    assert.match(out, /dry-run:/);
    assert.match(out, /bot\.yml/);
    assert.match(out, /run\.yml/);
  });
});
