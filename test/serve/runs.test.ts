import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_STALE_MS } from '../../src/run/lock.ts';
import { localRunStarter, RUN_DEADLINE_MS, runChildEnv, serialStarter, startRun, SERVICE_ONLY_ENV } from '../../src/serve/runs.ts';
import type { RunStarter } from '../../src/serve/runs.ts';
import type { SpawnLike } from '../../src/pipeline/llm.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/run-fake/run.mjs', import.meta.url));
const HANG = fileURLToPath(new URL('../fixtures/run-fake/hang.mjs', import.meta.url));
const SERVE_LIKE = fileURLToPath(new URL('../fixtures/run-fake/serve-like.mjs', import.meta.url));

const children: ChildProcess[] = [];
const trackedSpawn: SpawnLike = (cmd, args, options) => {
  const child = spawn(cmd, args, options);
  children.push(child);
  return child;
};
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

function fakeStarter(o: { running?: boolean; isRunningThrows?: boolean; startThrows?: boolean }) {
  const calls: string[] = [];
  const s: RunStarter = {
    async isRunning() {
      if (o.isRunningThrows) throw new Error('platform down');
      return o.running ?? false;
    },
    async start(trigger) {
      calls.push(trigger);
      if (o.startThrows) throw new Error('quota reached\nsecond line');
    },
  };
  return { s, calls };
}

test('startRun: busy starter → busy, start not called', async () => {
  const { s, calls } = fakeStarter({ running: true });
  assert.equal(await startRun(s, 'manual', () => {}), 'busy');
  assert.deepEqual(calls, []);
});

test('startRun: isRunning throws → unknown, start not called', async () => {
  const { s, calls } = fakeStarter({ isRunningThrows: true });
  assert.equal(await startRun(s, 'manual', () => {}), 'unknown');
  assert.deepEqual(calls, []);
});

test('startRun: start throws → failed, logged with its first line', async () => {
  const { s, calls } = fakeStarter({ startThrows: true });
  const lines: string[] = [];
  assert.equal(await startRun(s, 'scheduled', (l) => lines.push(l)), 'failed');
  assert.deepEqual(calls, ['scheduled']);
  assert.ok(lines.some((l) => l.includes('quota reached')));
  assert.ok(!lines.some((l) => l.includes('second line')));
});

test('startRun: ok → started', async () => {
  const { s, calls } = fakeStarter({});
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
  assert.deepEqual(calls, ['manual']);
});

test('runChildEnv drops each service-only name and keeps the run env', () => {
  const env: Record<string, string | undefined> = {
    TRELLO_TOKEN: 't', GEMINI_API_KEY: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'c', JOBS_BOARD_ID: 'j', PATH: '/bin',
    UNSET: undefined,
  };
  for (const name of SERVICE_ONLY_ENV) env[name] = `value-of-${name}`;
  assert.deepEqual(runChildEnv(env), {
    TRELLO_TOKEN: 't', GEMINI_API_KEY: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'c', JOBS_BOARD_ID: 'j', PATH: '/bin',
  });
});

function starterWithLog(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  let onExit = () => {};
  const exited = new Promise<void>((r) => { onExit = r; });
  const s = localRunStarter({
    env,
    script: FIXTURE,
    spawn: trackedSpawn,
    log: (l) => {
      lines.push(l);
      if (/^run exited/.test(l)) onExit();
    },
  });
  return { s, lines, exited };
}

test('localRunStarter runs the fixture with --trigger scheduled and the child env', async () => {
  const { s, lines, exited } = starterWithLog({ TRIGGER_SECRET: 'trigger-secret-x', TRELLO_TOKEN: 'tok', PATH: process.env.PATH });
  assert.equal(await s.isRunning(), false);
  await s.start('scheduled');
  assert.equal(await s.isRunning(), true);
  await exited;
  assert.equal(await s.isRunning(), false);

  assert.ok(lines.includes('run: args ["--trigger","scheduled"]'), lines.join('\n'));
  const envLine = lines.find((l) => l.startsWith('run: env '));
  assert.ok(envLine, lines.join('\n'));
  const names = JSON.parse(envLine.slice('run: env '.length)) as string[];
  assert.ok(names.includes('TRELLO_TOKEN'));
  assert.ok(!names.includes('TRIGGER_SECRET'));
  assert.ok(lines.includes('run: to stderr'));
  assert.ok(lines.includes('run exited with code 0'), lines.join('\n'));
});

test('localRunStarter: a second start while running → startRun says busy', async () => {
  const { s, exited } = starterWithLog({ PATH: process.env.PATH });
  const before = children.length;
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
  assert.equal(await startRun(s, 'manual', () => {}), 'busy');
  assert.equal(children.length, before + 1);
  await exited;
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
  assert.equal(children.length, before + 2);
});

test('localRunStarter: a spawn failure rejects start and leaves nothing running', async () => {
  const s = localRunStarter({
    env: {},
    script: FIXTURE,
    log: () => {},
    spawn: (cmd, args, options) => trackedSpawn('/nonexistent/node-binary', args, options),
  });
  await assert.rejects(s.start('manual'));
  assert.equal(await s.isRunning(), false);
});

test('localRunStarter defaults to src/run.ts under the current node', async () => {
  let seen: { cmd: string; args: string[] } | undefined;
  const s = localRunStarter({
    env: {},
    log: () => {},
    spawn: (cmd, args, options) => {
      seen = { cmd, args };
      return trackedSpawn(cmd, [FIXTURE, ...args.slice(1)], options);
    },
  });
  await s.start('manual');
  assert.equal(seen?.cmd, process.execPath);
  assert.equal(seen?.args[0], fileURLToPath(new URL('../../src/run.ts', import.meta.url)));
  assert.deepEqual(seen?.args.slice(1), ['--trigger', 'manual']);
});

function lockDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'career-cards-runs-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockStarter(lockFile: string) {
  let spawned = 0;
  const s = localRunStarter({
    env: { PATH: process.env.PATH },
    script: FIXTURE,
    log: () => {},
    lockFile,
    spawn: (cmd, args, options) => { spawned++; return trackedSpawn(cmd, args, options); },
  });
  return { s, spawned: () => spawned };
}

test('localRunStarter: a fresh run lock (a CLI run) → busy, nothing spawned', async (t) => {
  const lock = join(lockDir(t), 'run.lock');
  writeFileSync(lock, 'a CLI run');
  const { s, spawned } = lockStarter(lock);
  assert.equal(await startRun(s, 'manual', () => {}), 'busy');
  assert.equal(spawned(), 0);
});

test('localRunStarter: a stale run lock → started', async (t) => {
  const lock = join(lockDir(t), 'run.lock');
  writeFileSync(lock, 'left by a crashed run');
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(lock, old, old);
  const { s, spawned } = lockStarter(lock);
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
  assert.equal(spawned(), 1);
});

test('localRunStarter: an unreadable run lock path → unknown, nothing spawned', async (t) => {
  const file = join(lockDir(t), 'not-a-dir');
  writeFileSync(file, '');
  const { s, spawned } = lockStarter(join(file, 'run.lock'));
  const lines: string[] = [];
  assert.equal(await startRun(s, 'manual', (l) => lines.push(l)), 'unknown');
  assert.equal(spawned(), 0);
  assert.match(lines[0] ?? '', /^run state unknown: ENOTDIR/);
});

test('serialStarter: two concurrent starts → one started, one busy; free again once it ends', async () => {
  let running = false;
  const starts: string[] = [];
  const inner: RunStarter = {
    // A slow platform answer: both checks would see "no run" without the mutex.
    isRunning: async () => { const r = running; await new Promise((ok) => setTimeout(ok, 20)); return r; },
    start: async (t) => { await new Promise((r) => setTimeout(r, 20)); starts.push(t); running = true; },
  };
  const s = serialStarter(inner);
  const results = await Promise.all([startRun(s, 'scheduled', () => {}), startRun(s, 'manual', () => {})]);
  assert.deepEqual(results.sort(), ['busy', 'started']);
  assert.equal(starts.length, 1);
  running = false;
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
});

test('serialStarter: a failed start or check frees the slot', async () => {
  let fail: 'check' | 'start' | null = 'start';
  const s = serialStarter({
    isRunning: async () => { if (fail === 'check') throw new Error('platform down'); return false; },
    start: async () => { if (fail === 'start') throw new Error('no capacity'); },
  });
  assert.equal(await startRun(s, 'manual', () => {}), 'failed');
  fail = 'check';
  assert.equal(await startRun(s, 'manual', () => {}), 'unknown');
  fail = null;
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
});

test('RUN_DEADLINE_MS is below LOCK_STALE_MS', () => {
  assert.equal(RUN_DEADLINE_MS, 3600_000);
  assert.ok(RUN_DEADLINE_MS < LOCK_STALE_MS);
});

/** Timers the test fires by hand: the deadline never waits in real time. */
function manualTimers() {
  const timers: { ms: number; fire: () => void; cleared: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t = { ms, fire: fn, cleared: false };
    timers.push(t);
    return () => { t.cleared = true; };
  };
  return { timers, setTimer };
}

function hangStarter(env: Record<string, string | undefined>, lockFile?: string) {
  const lines: string[] = [];
  const waiters: { re: RegExp; done: () => void }[] = [];
  const { timers, setTimer } = manualTimers();
  const s = localRunStarter({
    env: { PATH: process.env.PATH, ...env },
    script: HANG,
    spawn: trackedSpawn,
    setTimer,
    ...(lockFile ? { lockFile } : {}),
    log: (l) => {
      lines.push(l);
      for (const w of waiters) if (w.re.test(l)) w.done();
    },
  });
  const seen = (re: RegExp) =>
    lines.some((l) => re.test(l)) ? Promise.resolve() : new Promise<void>((done) => waiters.push({ re, done }));
  return { s, lines, timers, seen };
}

test('localRunStarter: a run past the deadline is killed and the slot frees', { timeout: 10_000 }, async (t) => {
  const lock = join(lockDir(t), 'run.lock');
  const { s, lines, timers, seen } = hangStarter({ FAKE_IGNORE_SIGTERM: '1', FAKE_LOCK_FILE: lock }, lock);
  assert.equal(await startRun(s, 'manual', () => {}), 'started');
  await seen(/^run: ready$/);
  assert.deepEqual(timers.map((x) => x.ms), [RUN_DEADLINE_MS]);
  assert.equal(await startRun(s, 'manual', () => {}), 'busy');

  timers[0]!.fire();
  assert.ok(lines.includes('run killed after deadline'), lines.join('\n'));
  // SIGTERM is ignored by this child: it stays, and so does the slot, until the grace timer sends SIGKILL.
  assert.equal(timers.length, 2);
  assert.equal(await s.isRunning(), true);

  timers[1]!.fire();
  await seen(/^run exited by signal SIGKILL$/);
  assert.equal(existsSync(lock), false, 'the killed run\'s lock is removed');
  assert.equal(await s.isRunning(), false);
  assert.equal(lines.filter((l) => /^run exited/.test(l)).length, 1, lines.join('\n'));
});

test('localRunStarter: a run that stops on SIGTERM frees the slot and cancels the SIGKILL', { timeout: 10_000 }, async () => {
  const { s, timers, seen } = hangStarter({});
  await s.start('manual');
  await seen(/^run: ready$/);
  timers[0]!.fire();
  await seen(/^run exited by signal SIGTERM$/);
  assert.equal(await s.isRunning(), false);
  assert.equal(timers[1]?.cleared, true);
});

test('localRunStarter: a run that ends in time cancels its deadline', { timeout: 10_000 }, async () => {
  const { timers, setTimer } = manualTimers();
  let onExit = () => {};
  const exited = new Promise<void>((r) => { onExit = r; });
  const s = localRunStarter({
    env: { PATH: process.env.PATH }, script: FIXTURE, spawn: trackedSpawn, setTimer,
    log: (l) => { if (/^run exited/.test(l)) onExit(); },
  });
  await s.start('manual');
  await exited;
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.cleared, true);
});

test('localRunStarter: a lock taken over by another run is left alone after a deadline kill', { timeout: 10_000 }, async (t) => {
  const lock = join(lockDir(t), 'run.lock');
  const { s, timers, seen } = hangStarter({ FAKE_LOCK_FILE: lock }, lock);
  await s.start('manual');
  await seen(/^run: ready$/);
  writeFileSync(lock, '999999 2026-11-13T00:00:00.000Z another run');
  timers[0]!.fire();
  await seen(/^run exited by signal SIGTERM$/);
  assert.equal(existsSync(lock), true);
  assert.equal(await s.isRunning(), true);
});

const pidAfter = (lines: string[], prefix: string) => Number(lines.find((l) => l.startsWith(prefix))!.slice(prefix.length));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

test('localRunStarter: a deadline kill takes the run\'s grandchildren with it', { timeout: 10_000 }, async (t) => {
  const { s, lines, timers, seen } = hangStarter({ FAKE_GRANDCHILD: '1', FAKE_IGNORE_SIGTERM: '1' });
  await s.start('manual');
  await seen(/^run: ready$/);
  const pid = pidAfter(lines, 'run: grandchild ');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  timers[0]!.fire();
  // The grandchild doesn't ignore SIGTERM: the group's SIGTERM ends it while the run itself waits for SIGKILL.
  assert.equal(await gone(pid), true);
  timers[1]!.fire();
  await seen(/^run exited by signal SIGKILL$/);
  assert.equal(await s.isRunning(), false);
});

test('localRunStarter: a grandchild that ignores SIGTERM gets SIGKILL once the run has stopped', { timeout: 10_000 }, async (t) => {
  const { s, lines, timers, seen } = hangStarter({ FAKE_GRANDCHILD: 'stubborn' });
  await s.start('manual');
  await seen(/^run: grandchild ready$/);
  const pid = pidAfter(lines, 'run: grandchild ');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  timers[0]!.fire();
  await seen(/^run exited by signal SIGTERM$/);
  assert.equal(await gone(pid), true);
});

test('localRunStarter: a stopped service takes its run and the run\'s grandchildren with it', { timeout: 10_000 }, async (t) => {
  const svc = spawn(process.execPath, [SERVE_LIKE], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(svc);
  const lines: string[] = [];
  await new Promise<void>((ready) => {
    svc.stdout.setEncoding('utf8').on('data', (d: string) => {
      lines.push(...d.split('\n'));
      if (lines.includes('run: ready')) ready();
    });
  });
  const run = pidAfter(lines, 'run: pid ');
  const grandchild = pidAfter(lines, 'run: grandchild ');
  t.after(() => { for (const p of [run, grandchild]) try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } });
  svc.kill('SIGINT');
  const [, signal] = await new Promise<unknown[]>((r) => svc.once('exit', (...a) => r(a)));
  assert.equal(signal, 'SIGINT');
  assert.equal(await gone(run), true);
  assert.equal(await gone(grandchild), true);
});

test('localRunStarter: a killed run frees the slot even while a grandchild outside its group holds its pipes', { timeout: 10_000 }, async (t) => {
  const { s, lines, timers, seen } = hangStarter({ FAKE_GRANDCHILD: 'own-group' });
  await s.start('manual');
  await seen(/^run: ready$/);
  const pid = pidAfter(lines, 'run: grandchild ');
  // Also on a timeout: a live grandchild holds this test process's pipes and would keep the suite from ending.
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  timers[0]!.fire();
  await seen(/^run exited by signal SIGTERM$/);
  assert.equal(await s.isRunning(), false);
});

test('localRunStarter: a run that ended while a grandchild outside its group holds its pipes frees the slot at the deadline', { timeout: 10_000 }, async (t) => {
  const { s, lines, timers, seen } = hangStarter({ FAKE_GRANDCHILD: 'own-group', FAKE_EXIT: '1' });
  await s.start('manual');
  const c = children.at(-1)!;
  await seen(/^run: ready$/);
  const pid = pidAfter(lines, 'run: grandchild ');
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  if (c.exitCode === null) await new Promise((r) => c.once('exit', r));
  assert.equal(await s.isRunning(), true);
  timers[0]!.fire();
  await seen(/^run exited with code 0$/);
  assert.equal(await s.isRunning(), false);
});
