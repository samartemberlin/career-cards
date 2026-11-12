import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTrigger, dispatch } from '../src/main.ts';

describe('withTrigger', () => {
  it('run gets --trigger from RUN_TRIGGER when argv has none', () =>
    assert.deepEqual(withTrigger(['--cap', '5'], { RUN_TRIGGER: 'scheduled' }), ['--cap', '5', '--trigger', 'scheduled']));

  it('an explicit --trigger wins over RUN_TRIGGER', () =>
    assert.deepEqual(withTrigger(['--trigger', 'manual'], { RUN_TRIGGER: 'scheduled' }), ['--trigger', 'manual']));

  it('no RUN_TRIGGER leaves argv unchanged', () =>
    assert.deepEqual(withTrigger(['--cap', '5'], {}), ['--cap', '5']));
});

describe('dispatch', () => {
  it('routes run with the rest of argv and returns its exit code', async () => {
    const seen: string[][] = [];
    assert.equal(await dispatch(['run', '--dry-run'], {}, { run: async (a) => (seen.push(a), 3) }), 3);
    assert.deepEqual(seen, [['--dry-run']]);
  });

  it('no command prints usage and returns 2', async () => {
    const lines: string[] = [];
    const code = await dispatch([], {}, { out: (s) => lines.push(s) });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('serve | run')), `expected usage line, got: ${lines.join(', ')}`);
  });

  it('unknown command prints usage and returns 2', async () => {
    const lines: string[] = [];
    const code = await dispatch(['bogus'], {}, { out: (s) => lines.push(s) });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('serve | run')));
  });

  it('check with stub prints node version line', async () => {
    const lines: string[] = [];
    const code = await dispatch(
      ['check'],
      {},
      {
        check: async () => `node v24.0.0\n2.1.322 (Claude Code)`,
        out: (s) => lines.push(s),
      },
    );
    assert.equal(code, 0);
    assert.ok(lines.join('\n').includes('node v24'), `expected node v24, got: ${lines.join('\n')}`);
  });

  it('serve with stub resolves and returns 0', async () => {
    const code = await dispatch(['serve'], {}, { serve: async () => {} });
    assert.equal(code, 0);
  });
});
