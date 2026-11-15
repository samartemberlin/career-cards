import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  cgroupDir, descendants, limitsLine, metricsLine, readCgroup, readProcs, startMetrics, throttledPct,
} from '../../src/serve/metrics.ts';
import type { Sample } from '../../src/serve/metrics.ts';

const FIX = fileURLToPath(new URL('../fixtures/cgroup/', import.meta.url));
const MB = 2 ** 20;

test('readCgroup parses cgroup v2 memory and cpu files', async () => {
  assert.deepEqual(await readCgroup(`${FIX}v2`), {
    memCurrent: 432013312, memPeak: 459276288, memMax: 536870912, oom: 1, oomKill: 1,
    cpu: { periods: 1000, throttled: 400, throttledUsec: 50000000 }, cpuMax: { quota: 15000, period: 100000 },
  });
});

test('readCgroup: "max" limits are null, missing files are left out', async () => {
  assert.deepEqual(await readCgroup(`${FIX}unlimited`), { memCurrent: 1048576, memMax: null, cpuMax: null });
  assert.deepEqual(await readCgroup(`${FIX}does-not-exist`), {});
});

test('cgroupDir follows the unified-hierarchy line of /proc/self/cgroup', async () => {
  assert.equal(await cgroupDir(`${FIX}self-cgroup`, '/sys/fs/cgroup'), '/sys/fs/cgroup/');
  assert.equal(await cgroupDir(`${FIX}self-cgroup-nested`, '/cg'), '/cg/user.slice/user-1000.slice/session-2.scope');
  assert.equal(await cgroupDir(`${FIX}nope`, '/cg'), null);
});

test('readProcs reads pid, ppid and VmRSS; skips non-pid entries and processes without RSS', async () => {
  const procs = (await readProcs(FIX + 'proc')).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(procs, [
    { pid: 1, ppid: 0, rss: 900 * 1024 },
    { pid: 7, ppid: 1, rss: 71 * MB },
    { pid: 20, ppid: 7, rss: 180 * MB },
    { pid: 21, ppid: 20, rss: 50 * MB },
    { pid: 22, ppid: 20, rss: 54 * MB },
    { pid: 30, ppid: 1, rss: 1024 * 1024 },
  ]);
  assert.deepEqual(await readProcs(FIX + 'no-proc'), []);
});

test('descendants walks the tree below a pid', async () => {
  const procs = await readProcs(FIX + 'proc');
  assert.deepEqual(descendants(procs, 20).map((p) => p.pid).sort(), [21, 22]);
  assert.deepEqual(descendants(procs, 7).map((p) => p.pid).sort(), [20, 21, 22]);
  assert.deepEqual(descendants(procs, 99), []);
});

test('throttledPct is the share of throttled periods since the previous sample', () => {
  const a = { periods: 1000, throttled: 400, throttledUsec: 0 };
  assert.equal(throttledPct(a, { periods: 1100, throttled: 437, throttledUsec: 0 }), 37);
  assert.equal(throttledPct(undefined, a), 40);
  assert.equal(throttledPct(a, a), 0);
  assert.equal(throttledPct(a, undefined), undefined);
});

const sample = (o: Partial<Sample> = {}): Sample => ({
  cg: { memCurrent: 412 * MB, memPeak: 438 * MB, memMax: 512 * MB, oomKill: 0, cpu: { periods: 1100, throttled: 437, throttledUsec: 0 } },
  serveRss: 71 * MB,
  run: { rss: 180 * MB, kids: [50 * MB, 54 * MB, 52 * MB] },
  ...o,
});

test('metricsLine formats every field', () => {
  const prev = { periods: 1000, throttled: 400, throttledUsec: 0 };
  assert.equal(metricsLine(sample(), prev), 'metrics: mem 412/512 MB peak 438 · oom_kill 0 · cpu thr 37% · serve 71 · run 180 · kids 3: 156 MB');
});

test('metricsLine leaves out what is missing (no cgroup, no run)', () => {
  assert.equal(metricsLine({ cg: {}, serveRss: 71 * MB }, undefined), 'metrics: serve 71');
  assert.equal(
    metricsLine({ cg: { memCurrent: 100 * MB, memMax: null }, serveRss: 71 * MB, run: { rss: 90 * MB, kids: [] } }, undefined),
    'metrics: mem 100 MB · serve 71 · run 90',
  );
});

test('limitsLine names memory, cpu and the run heap cap', () => {
  assert.equal(
    limitsLine({ memMax: 512 * MB, cpuMax: { quota: 15000, period: 100000 } }, 256),
    'metrics: limits mem 512 MB · cpu 0.15 · run heap 256 MB',
  );
  assert.equal(limitsLine({ memMax: null, cpuMax: null }, undefined), 'metrics: limits mem none · cpu none');
  assert.equal(limitsLine({}, undefined), 'metrics: limits unknown (no cgroup v2)');
});

function fakeClock() {
  let now = 0;
  let fn: () => void = () => {};
  let every = 0;
  return {
    now: () => now,
    setInterval: (f: () => void, ms: number) => { fn = f; every = ms; return () => { fn = () => {}; }; },
    async advance(ms: number) {
      for (let t = 0; t < ms; t += every) { now += every; fn(); await new Promise((r) => setImmediate(r)); }
    },
  };
}

test('startMetrics logs limits once, then every 30 s while a run is active and every 10 min when idle', async () => {
  const clock = fakeClock();
  const lines: string[] = [];
  let runPid: number | undefined;
  const m = startMetrics({
    log: (l) => lines.push(l),
    runPid: () => runPid,
    runHeapMb: 256,
    sample: async () => sample({ cg: {} }),
    readLimits: async () => ({ memMax: 512 * MB }),
    now: clock.now,
    setInterval: clock.setInterval,
  });
  await m.ready;
  assert.deepEqual(lines, ['metrics: limits mem 512 MB · run heap 256 MB', 'metrics: serve 71 · run 180 · kids 3: 156 MB']);

  lines.length = 0;
  await clock.advance(9 * 60_000);
  assert.equal(lines.length, 0, 'idle: nothing before 10 min');
  await clock.advance(60_000);
  assert.equal(lines.length, 1, 'idle: one line at 10 min');

  lines.length = 0;
  runPid = 20;
  await clock.advance(90_000);
  assert.equal(lines.length, 3, 'active: one line per 30 s');
  m.stop();
  await clock.advance(90_000);
  assert.equal(lines.length, 3);
});

test('startMetrics never throws: a failing sample is skipped', async () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const m = startMetrics({
    log: (l) => lines.push(l),
    runPid: () => 1,
    sample: async () => { throw new Error('boom'); },
    readLimits: async () => { throw new Error('boom'); },
    now: clock.now,
    setInterval: clock.setInterval,
  });
  await m.ready;
  await clock.advance(60_000);
  assert.deepEqual(lines, []);
  m.stop();
});

test('startMetrics with the real readers runs on this machine without throwing', async () => {
  const lines: string[] = [];
  const m = startMetrics({ log: (l) => lines.push(l), runPid: () => process.pid });
  await m.ready;
  m.stop();
  assert.ok(lines.some((l) => l.startsWith('metrics: ') && l.includes('serve ')), lines.join('\n'));
});
