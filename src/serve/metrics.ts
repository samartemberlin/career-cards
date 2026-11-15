// Small hosts kill the container from outside (OOM, or failed health checks while the CPU is throttled) without a log
// line, and some (Render free) show no metrics. This logs what the container itself can see: cgroup v2 and /proc.
// Missing files (macOS, cgroup v1) leave fields out.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CpuStat = { periods: number; throttled: number; throttledUsec: number };

/** Bytes; `null` is an unlimited ("max") limit. */
export type Cgroup = {
  memCurrent?: number;
  memPeak?: number;
  memMax?: number | null;
  oom?: number;
  oomKill?: number;
  cpu?: CpuStat;
  cpuMax?: { quota: number; period: number } | null;
};

export type Proc = { pid: number; ppid: number; rss: number };

export type Sample = { cg: Cgroup; serveRss: number; run?: { rss: number; kids: number[] } };

const MB = 2 ** 20;
const mb = (bytes: number) => Math.round(bytes / MB);

async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function keyed(s: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of (s ?? '').split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && /^\d+$/.test(v)) out.set(k, Number(v));
  }
  return out;
}

const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

/** The unified-hierarchy (`0::`) line of /proc/self/cgroup; in a container with its own cgroup namespace it is `/`. */
export async function cgroupDir(selfCgroup = '/proc/self/cgroup', root = '/sys/fs/cgroup'): Promise<string | null> {
  const line = (await text(selfCgroup))?.split('\n').find((l) => l.startsWith('0::'));
  return line === undefined ? null : join(root, line.slice(3).trim() || '/');
}

export async function readCgroup(dir: string): Promise<Cgroup> {
  const [current, peak, max, events, cpuStat, cpuMax] = await Promise.all(
    ['memory.current', 'memory.peak', 'memory.max', 'memory.events', 'cpu.stat', 'cpu.max'].map((f) => text(join(dir, f))),
  );
  const cg: Cgroup = {};
  const cur = num(current);
  if (cur !== undefined) cg.memCurrent = cur;
  const pk = num(peak);
  if (pk !== undefined) cg.memPeak = pk;
  if (max !== undefined) cg.memMax = max.trim() === 'max' ? null : (num(max) ?? null);
  const ev = keyed(events);
  if (ev.has('oom')) cg.oom = ev.get('oom')!;
  if (ev.has('oom_kill')) cg.oomKill = ev.get('oom_kill')!;
  const st = keyed(cpuStat);
  if (st.has('nr_periods')) {
    cg.cpu = { periods: st.get('nr_periods')!, throttled: st.get('nr_throttled') ?? 0, throttledUsec: st.get('throttled_usec') ?? 0 };
  }
  if (cpuMax !== undefined) {
    const [q, p] = cpuMax.trim().split(/\s+/);
    cg.cpuMax = q === 'max' || num(q) === undefined || num(p) === undefined ? null : { quota: num(q)!, period: num(p)! };
  }
  return cg;
}

export async function readProcs(procRoot = '/proc'): Promise<Proc[]> {
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const procs = await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n): Promise<Proc | null> => {
    const st = keyed((await text(join(procRoot, n, 'status')))?.replace(/:/g, ''));
    const rss = st.get('VmRSS');
    const ppid = st.get('PPid');
    return rss === undefined || ppid === undefined ? null : { pid: Number(n), ppid, rss: rss * 1024 };
  }));
  return procs.filter((p) => p !== null);
}

export function descendants(procs: Proc[], pid: number): Proc[] {
  const out: Proc[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const p of procs) if (p.ppid === parent) { out.push(p); queue.push(p.pid); }
  }
  return out;
}

export function throttledPct(prev: CpuStat | undefined, cur: CpuStat | undefined): number | undefined {
  if (!cur) return undefined;
  const periods = cur.periods - (prev?.periods ?? 0);
  return periods > 0 ? Math.round((100 * (cur.throttled - (prev?.throttled ?? 0))) / periods) : 0;
}

export function metricsLine(s: Sample, prevCpu: CpuStat | undefined): string {
  const parts: string[] = [];
  const { cg } = s;
  if (cg.memCurrent !== undefined) {
    const max = typeof cg.memMax === 'number' ? `/${mb(cg.memMax)}` : '';
    parts.push(`mem ${mb(cg.memCurrent)}${max} MB${cg.memPeak !== undefined ? ` peak ${mb(cg.memPeak)}` : ''}`);
  }
  if (cg.oomKill !== undefined) parts.push(`oom_kill ${cg.oomKill}`);
  const thr = throttledPct(prevCpu, cg.cpu);
  if (thr !== undefined) parts.push(`cpu thr ${thr}%`);
  parts.push(`serve ${mb(s.serveRss)}`);
  if (s.run) {
    parts.push(`run ${mb(s.run.rss)}`);
    if (s.run.kids.length) parts.push(`kids ${s.run.kids.length}: ${mb(s.run.kids.reduce((a, b) => a + b, 0))} MB`);
  }
  return `metrics: ${parts.join(' · ')}`;
}

export function limitsLine(cg: Cgroup, runHeapMb: number | undefined): string {
  const parts: string[] = [];
  if (cg.memMax !== undefined) parts.push(`mem ${cg.memMax === null ? 'none' : `${mb(cg.memMax)} MB`}`);
  if (cg.cpuMax !== undefined) parts.push(`cpu ${cg.cpuMax === null ? 'none' : +(cg.cpuMax.quota / cg.cpuMax.period).toFixed(2)}`);
  if (!parts.length) parts.push('unknown (no cgroup v2)');
  if (runHeapMb !== undefined) parts.push(`run heap ${runHeapMb} MB`);
  return `metrics: limits ${parts.join(' · ')}`;
}

export async function readOwnCgroup(): Promise<Cgroup> {
  const dir = await cgroupDir();
  return dir ? readCgroup(dir) : {};
}

async function realSample(runPid: number | undefined): Promise<Sample> {
  const s: Sample = { cg: await readOwnCgroup(), serveRss: process.memoryUsage.rss() };
  if (runPid === undefined) return s;
  const procs = await readProcs();
  const run = procs.find((p) => p.pid === runPid);
  if (run) s.run = { rss: run.rss, kids: descendants(procs, runPid).map((p) => p.rss) };
  return s;
}

export const ACTIVE_MS = 30_000;
export const IDLE_MS = 10 * 60_000;

/** Samples every ACTIVE_MS; logs each sample while a run is active, otherwise one per IDLE_MS. Never throws. */
export function startMetrics(o: {
  log: (s: string) => void;
  runPid: () => number | undefined;
  runHeapMb?: number;
  sample?: (runPid: number | undefined) => Promise<Sample>;
  readLimits?: () => Promise<Cgroup>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => () => void;
}): { ready: Promise<void>; stop(): void } {
  const sample = o.sample ?? realSample;
  const now = o.now ?? Date.now;
  const every = o.setInterval ?? ((fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return () => clearInterval(t);
  });
  let prevCpu: CpuStat | undefined;
  let last = -Infinity;
  let busy = false;

  const tick = async (force: boolean) => {
    const t = now();
    const pid = o.runPid();
    if (busy || (!force && pid === undefined && t - last < IDLE_MS)) return;
    busy = true;
    try {
      const s = await sample(pid);
      o.log(metricsLine(s, prevCpu));
      prevCpu = s.cg.cpu;
      last = t;
    } catch {
      // A missed line is better than a crashed service.
    } finally {
      busy = false;
    }
  };

  const ready = (async () => {
    try {
      o.log(limitsLine(await (o.readLimits ?? readOwnCgroup)(), o.runHeapMb));
    } catch {
      // As above.
    }
    await tick(true);
  })();
  const stop = every(() => void tick(false), ACTIVE_MS);
  return { ready, stop };
}
