import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localRunStarter, runChildEnv, startRun, SERVICE_ONLY_ENV } from '../../src/serve/runs.ts';
import type { RunStarter } from '../../src/serve/runs.ts';
import type { SpawnLike } from '../../src/pipeline/llm.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/run-fake/run.mjs', import.meta.url));

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
