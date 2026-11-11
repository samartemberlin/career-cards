// One night's scan: career-ops' scan.mjs as a child process, plus the RSS, page and LinkedIn sources it has no provider for.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as dumpYaml } from 'js-yaml';
import { careerOpsEnv } from '../pipeline/career-ops-env.ts';
import { fetchRssSources } from '../pipeline/sources/rss.ts';
import { fetchPageSources } from '../pipeline/sources/pages.ts';
import { fetchLinkedinSearch } from '../pipeline/sources/linkedin.ts';
import { fingerprint, jobKey } from '../pipeline/keys.ts';
import type { Job } from '../pipeline/keys.ts';
import type { ScanRow, SourceError, SourceResult } from '../pipeline/sources/types.ts';
import type { ScanPlan } from './sources-plan.ts';

const ROOT = join(fileURLToPath(import.meta.url), '../../..');
const CAREER_OPS_DIR = join(ROOT, 'career-ops');
const SCAN_PROFILE = join(ROOT, 'config', 'defaults', 'scan-profile.yml');
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const STDOUT_TAIL = 2_000;
export const TMP_PREFIX = 'career-cards-scan-';

// career-ops' scan-history-columns.mjs order; it reads rows by position, so the header must match.
const HISTORY_COLUMNS = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location', 'fingerprint', 'posted_at'];

export class ScanFailed extends Error {}

type Receipt = { errors?: SourceError[] };

function runNode(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new ScanFailed(`scan could not start: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, timedOut }); });
  });
}

function lastReceipt(stdout: string): Receipt | null {
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) return null;
  try { return JSON.parse(line) as Receipt; } catch { return null; }
}

function addedRows(historyFile: string): ScanRow[] {
  const rows: ScanRow[] = [];
  for (const line of readFileSync(historyFile, 'utf8').split('\n').slice(1)) {
    if (!line) continue;
    const c = line.split('\t');
    if (c[5] !== 'added') continue;
    const row: ScanRow = { url: c[0] ?? '', title: c[3] ?? '', company: c[4] ?? '', source: c[2] ?? '' };
    if (c[6]) row.location = c[6];
    if (c[8]) row.posted = c[8];
    rows.push(row);
  }
  return rows;
}

/**
 * Runs `node scan.mjs --json --quiet` against a throwaway data dir. Exit 0, or 2 (finished with per-source errors),
 * with a JSON receipt returns the `added` rows and the receipt's errors; anything else throws ScanFailed.
 */
export async function runCareerOpsScan(
  portals: Record<string, unknown>,
  o: { careerOpsDir?: string; timeoutMs?: number; deadline?: number; env?: Record<string, string | undefined> } = {},
): Promise<SourceResult> {
  const parentEnv = o.env ?? process.env;
  const timeoutMs = Math.min(o.timeoutMs ?? DEFAULT_TIMEOUT_MS, (o.deadline ?? Infinity) - Date.now());
  if (timeoutMs <= 0) throw new ScanFailed('scan not started: no time left in the run budget');
  const tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  try {
    const portalsFile = join(tmp, 'portals.yml');
    const historyFile = join(tmp, 'scan-history.tsv');
    const pipelineFile = join(tmp, 'pipeline.md');
    writeFileSync(portalsFile, dumpYaml(portals));
    writeFileSync(historyFile, HISTORY_COLUMNS.join('\t') + '\n');
    writeFileSync(pipelineFile, '');

    const env = careerOpsEnv(parentEnv, {
      CAREER_OPS_DATA_DIR: tmp,
      CAREER_OPS_PORTALS: portalsFile,
      CAREER_OPS_PROFILE: SCAN_PROFILE,
      CAREER_OPS_SCAN_HISTORY: historyFile,
      CAREER_OPS_PIPELINE: pipelineFile,
    });

    const res = await runNode(o.careerOpsDir ?? CAREER_OPS_DIR, ['scan.mjs', '--json', '--quiet'], env, timeoutMs);
    const tail = res.stdout.slice(-STDOUT_TAIL);
    if (res.timedOut) throw new ScanFailed(`scan timed out after ${Math.round(timeoutMs / 1000)}s\n${tail}`);
    const receipt = lastReceipt(res.stdout);
    if (!receipt || (res.code !== 0 && res.code !== 2)) throw new ScanFailed(`scan failed (exit ${res.code})\n${tail}`);
    return Object.assign(addedRows(historyFile), { errors: receipt.errors ?? [] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type ScanOutput = { jobs: Job[]; bySource: Record<string, number>; errors: SourceError[] };

export type ScanDeps = {
  careerOps: (portals: Record<string, unknown>, o: { deadline: number }) => Promise<SourceResult>;
  rss?: typeof fetchRssSources;
  pages?: typeof fetchPageSources;
  linkedin?: typeof fetchLinkedinSearch;
  log: (s: string) => void;
  /** Epoch ms; the run's one deadline. */
  deadline?: number;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs every source side by side; a source that throws becomes one SourceError and the others still count. */
export async function scanAll(plan: ScanPlan, deps: ScanDeps): Promise<ScanOutput> {
  const { rss = fetchRssSources, pages = fetchPageSources, linkedin = fetchLinkedinSearch, log, deadline = Infinity } = deps;
  const sources: [string, () => Promise<SourceResult>][] = [
    ['career-ops', () => deps.careerOps(plan.portals, { deadline })],
    ['RSS', () => rss(plan.rss, { log })],
    ['pages', () => pages(plan.pages, { log })],
  ];
  const li = plan.linkedin;
  if (li) {
    // LinkedIn's own time budget can be longer than what is left of the run's.
    sources.push(['LinkedIn', async () => {
      const minutesLeft = (deadline - Date.now()) / 60_000;
      if (minutesLeft <= 0) throw new Error('no time left in the run budget');
      return linkedin({ ...li, max_total_minutes: Math.min(li.max_total_minutes ?? 40, minutesLeft) }, { log });
    }]);
  }

  const settled = await Promise.allSettled(sources.map(([, run]) => run()));
  const rows: ScanRow[] = [];
  const errors: SourceError[] = [];
  settled.forEach((s, i) => {
    const name = sources[i]![0];
    if (s.status === 'rejected') {
      errors.push({ company: name, error: message(s.reason) });
      log(`${name}: failed: ${message(s.reason)}`);
      return;
    }
    rows.push(...s.value);
    errors.push(...(s.value.errors ?? []));
    log(`${name}: ${s.value.length} rows, ${s.value.errors?.length ?? 0} errors`);
  });

  const keys = new Set<string>();
  const prints = new Set<string>();
  const jobs: Job[] = [];
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    if (!r.url) continue;
    const key = jobKey(r.url);
    if (keys.has(key)) continue;
    // Key pass first, as if over the whole batch: a row dropped on its fingerprint still claims its key.
    keys.add(key);
    const print = fingerprint(r.company, r.title);
    if (prints.has(print)) continue;
    prints.add(print);
    jobs.push({ ...r, key });
    const src = r.source ?? 'unknown';
    bySource[src] = (bySource[src] ?? 0) + 1;
  }
  return { jobs, bySource, errors };
}
