import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLock, lockHeld } from '../../src/run/lock.ts';

function lockPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'career-cards-lock-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'run.lock');
}

test('one holder at a time; release frees the lock', async (t) => {
  const path = lockPath(t);
  const a = fileLock(path);
  const b = fileLock(path);
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  await a.release();
  assert.equal(existsSync(path), false);
  assert.equal(await b.acquire(), true);
  await b.release();
});

test('a lock file older than 2 hours is stale and taken over', async (t) => {
  const path = lockPath(t);
  writeFileSync(path, 'left by a crashed run');
  const old = (Date.now() - 2 * 3600_000 - 1000) / 1000;
  utimesSync(path, old, old);
  const lock = fileLock(path);
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test('a lock file under 2 hours old holds', async (t) => {
  const path = lockPath(t);
  writeFileSync(path, 'another run');
  const recent = (Date.now() - 2 * 3600_000 + 60_000) / 1000;
  utimesSync(path, recent, recent);
  assert.equal(await fileLock(path).acquire(), false);
  assert.equal(existsSync(path), true);
});

test('release without acquire leaves another holder\'s lock alone', async (t) => {
  const path = lockPath(t);
  const holder = fileLock(path);
  assert.equal(await holder.acquire(), true);
  const loser = fileLock(path);
  assert.equal(await loser.acquire(), false);
  await loser.release();
  assert.equal(existsSync(path), true);
  await holder.release();
});

test('lockHeld: no file → false; fresh → true; stale → false', async (t) => {
  const path = lockPath(t);
  assert.equal(await lockHeld(path), false);
  writeFileSync(path, 'a run');
  assert.equal(await lockHeld(path), true);
  const old = (Date.now() - 2 * 3600_000 - 1000) / 1000;
  utimesSync(path, old, old);
  assert.equal(await lockHeld(path), false);
});
