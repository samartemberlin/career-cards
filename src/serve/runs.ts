import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Env, SpawnLike } from '../pipeline/llm.ts';
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

export const SERVICE_ONLY_ENV = ['TRELLO_APP_SECRET', 'TRIGGER_SECRET', 'NORTHFLANK_API_TOKEN', 'PUBLIC_URL', 'PORT'] as const;

export function runChildEnv(env: Env): Record<string, string> {
  const drop = new Set<string>(SERVICE_ONLY_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return out;
}

const RUN_SCRIPT = fileURLToPath(new URL('../run.ts', import.meta.url));

/**
 * Runs the CLI as a child of the service (local use). `isRunning` only knows this service's own child; a run started
 * elsewhere on the same machine is still refused by the run's lock file.
 */
export function localRunStarter(o: { env: Env; log: (s: string) => void; spawn?: SpawnLike; script?: string }): RunStarter {
  const spawn = o.spawn ?? nodeSpawn;
  let child: ChildProcess | null = null;

  const forward = (stream: Readable | null) => {
    if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on('line', (l) => o.log(`run: ${l}`));
  };

  return {
    async isRunning() {
      return child !== null;
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
      return new Promise<void>((resolve, reject) => {
        c.once('spawn', () => resolve());
        c.once('error', (e) => {
          if (child === c) child = null;
          reject(e);
        });
        c.once('close', (code, signal) => {
          if (child === c) child = null;
          o.log(signal ? `run exited by signal ${signal}` : `run exited with code ${code}`);
        });
      });
    },
  };
}
