import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Env, SpawnLike } from '../pipeline/llm.ts';
import { lockHeld } from '../run/lock.ts';
import type { RunTrigger } from '../run/stats.ts';

/** PR 5's platform starter implements this too: `isRunning` asks for an active job run, `start` creates one. */
export type RunStarter = { isRunning(): Promise<boolean>; start(trigger: RunTrigger): Promise<void> };

export type StartResult = 'started' | 'busy' | 'unknown' | 'failed';

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

export async function startRun(s: RunStarter, trigger: RunTrigger, log: (s: string) => void): Promise<StartResult> {
  let running: boolean;
  try {
    running = await s.isRunning();
  } catch (e) {
    // Fails closed: when the run state is unknown, starting could put two runs on the same boards.
    log(`run state unknown: ${firstLine(e)}`);
    return 'unknown';
  }
  if (running) return 'busy';
  try {
    await s.start(trigger);
  } catch (e) {
    log(`run start failed: ${firstLine(e)}`);
    return 'failed';
  }
  return 'started';
}

/**
 * One check-and-start at a time across every caller (the trigger and `@bot run`), so two callers can't both see no
 * run and both start one. A `false` from `isRunning` claims the slot until the `start` that follows settles, so a
 * caller must start after a `false` (as `startRun` does).
 */
export function serialStarter(s: RunStarter): RunStarter {
  let tail: Promise<unknown> = Promise.resolve();
  let claimed = false;
  return {
    isRunning() {
      const check = tail.then(async () => {
        if (claimed) return true;
        const running = await s.isRunning();
        if (!running) claimed = true;
        return running;
      });
      tail = check.catch(() => {});
      return check;
    },
    async start(trigger) {
      try {
        await s.start(trigger);
      } finally {
        claimed = false;
      }
    },
  };
}

export const SERVICE_ONLY_ENV = ['TRELLO_APP_SECRET', 'TRIGGER_SECRET', 'NORTHFLANK_API_TOKEN', 'PUBLIC_URL', 'PORT'] as const;

export function runChildEnv(env: Env): Record<string, string> {
  const drop = new Set<string>(SERVICE_ONLY_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return out;
}

const RUN_SCRIPT = fileURLToPath(new URL('../run.ts', import.meta.url));

/**
 * The job path has `activeDeadlineSeconds: 3600`; this is the same bound for a run the service starts itself. It stays
 * below `LOCK_STALE_MS`, so a run is killed before another one could take over its lock.
 */
export const RUN_DEADLINE_MS = 3600_000;
const KILL_GRACE_MS = 10_000;

export type SetTimer = (fn: () => void, ms: number) => () => void;

const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

/** Removes the lock only if `pid` wrote it (fileLock's content starts with the pid), so a later run's lock stays. */
async function dropLockOf(path: string, pid: number): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')).startsWith(`${pid} `)) await unlink(path);
  } catch {
    // Left in place, the lock goes stale after LOCK_STALE_MS.
  }
}

/**
 * Runs the CLI as a child of the service (local use). `isRunning` sees this service's own child and, through
 * `lockFile`, a run started elsewhere on the machine or left behind by a restarted service. A child past the deadline
 * gets SIGTERM, then SIGKILL.
 */
export function localRunStarter(o: {
  env: Env;
  log: (s: string) => void;
  spawn?: SpawnLike;
  script?: string;
  lockFile?: string;
  setTimer?: SetTimer;
}): RunStarter {
  const spawn = o.spawn ?? nodeSpawn;
  const setTimer = o.setTimer ?? realTimer;
  let child: ChildProcess | null = null;

  const forward = (stream: Readable | null) => {
    if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => o.log(`run: ${l}`));
  };

  return {
    async isRunning() {
      return child !== null || (o.lockFile ? await lockHeld(o.lockFile) : false);
    },
    start(trigger) {
      if (child) return Promise.reject(new Error('a run started by this service is still running'));
      const c = spawn(process.execPath, [o.script ?? RUN_SCRIPT, '--trigger', trigger], {
        env: runChildEnv(o.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = c;
      forward(c.stdout);
      forward(c.stderr);

      let killed = false;
      let exited: [number | null, NodeJS.Signals | null] | null = null;
      let cancelKill = () => {};
      const cancelDeadline = setTimer(() => {
        killed = true;
        if (exited) {
          o.log('run output still open after deadline');
          void end(...exited);
          return;
        }
        o.log('run killed after deadline');
        c.kill('SIGTERM');
        cancelKill = setTimer(() => c.kill('SIGKILL'), KILL_GRACE_MS);
      }, RUN_DEADLINE_MS);

      let ended = false;
      const end = async (code: number | null, signal: NodeJS.Signals | null) => {
        if (ended) return;
        ended = true;
        cancelDeadline();
        cancelKill();
        // The killed run never releases its own lock.
        if (killed && o.lockFile && c.pid !== undefined) await dropLockOf(o.lockFile, c.pid);
        if (child === c) child = null;
        o.log(signal ? `run exited by signal ${signal}` : `run exited with code ${code}`);
      };

      return new Promise<void>((resolve, reject) => {
        c.once('spawn', () => resolve());
        c.once('error', (e) => {
          cancelDeadline();
          if (child === c) child = null;
          reject(e);
        });
        // A run's orphaned grandchildren (scan, claude) can keep its pipes open, so 'close' may never come. Past the
        // deadline, 'exit' is enough.
        c.once('exit', (code, signal) => {
          exited = [code, signal];
          if (killed) void end(code, signal);
        });
        c.once('close', (code, signal) => void end(code, signal));
      });
    },
  };
}
