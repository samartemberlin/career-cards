// CLI entrypoint: --cap can only lower the cap from Settings (never raise it).
import { readFileSync } from 'node:fs';
import { createTrelloClient } from './trello/client.ts';
import type { TrelloApi } from './trello/api.ts';
import { runOnce } from './run/run-once.ts';
import type { RunDeps, RunOpts } from './run/run-once.ts';
import { scanAll, runCareerOpsScan } from './run/scan.ts';
import type { ScanDeps } from './run/scan.ts';
import { loadDefaults } from './run/sources-plan.ts';
import type { UserBoards } from './trello/scoped.ts';
import type { RunTrigger } from './run/stats.ts';
import type { Env } from './pipeline/llm.ts';
import { fetchJd } from './pipeline/jd.ts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const USAGE = 'Usage: run.ts [--dry-run] [--trigger scheduled|manual] [--boards <file>] [--cap <n>]';

export function parseRunArgs(argv: string[]): {
  dryRun: boolean;
  trigger: RunTrigger;
  boardsFile?: string;
  cap?: number;
} {
  let dryRun = false;
  let trigger: RunTrigger = 'manual';
  let boardsFile: string | undefined;
  let cap: number | undefined;

  const args = [...argv];
  while (args.length) {
    const flag = args.shift()!;
    if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--trigger') {
      const val = args.shift();
      if (val !== 'scheduled' && val !== 'manual') {
        throw new UsageError(`--trigger must be 'scheduled' or 'manual'\n${USAGE}`);
      }
      trigger = val;
    } else if (flag === '--boards') {
      const val = args.shift();
      if (!val || val.startsWith('--')) throw new UsageError(`--boards requires a file path\n${USAGE}`);
      boardsFile = val;
    } else if (flag === '--cap') {
      const val = args.shift();
      const n = Number(val);
      if (!val || isNaN(n) || n < 0 || !Number.isInteger(n)) {
        throw new UsageError(`--cap must be a non-negative integer\n${USAGE}`);
      }
      cap = n;
    } else {
      throw new UsageError(`Unknown flag: ${flag}\n${USAGE}`);
    }
  }

  return { dryRun, trigger, ...(boardsFile !== undefined ? { boardsFile } : {}), ...(cap !== undefined ? { cap } : {}) };
}

/** Reads board ids from a JSON file (sample tool's state shape) or from env vars. */
export function resolveBoards(env: Env, file?: string): UserBoards {
  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${file}: expected an object with 'jobs', 'profiles' and 'system' string ids`);
    }
    const obj = raw as Record<string, unknown>;
    const jobs = obj['jobs'];
    const profiles = obj['profiles'];
    const system = obj['system'];
    if (typeof jobs !== 'string' || typeof profiles !== 'string' || typeof system !== 'string') {
      throw new Error(`${file}: 'jobs', 'profiles' and 'system' must be non-empty strings`);
    }
    return { jobs, profiles, system };
  }
  const missing: string[] = [];
  if (!env.JOBS_BOARD_ID) missing.push('JOBS_BOARD_ID');
  if (!env.PROFILES_BOARD_ID) missing.push('PROFILES_BOARD_ID');
  if (!env.SYSTEM_BOARD_ID) missing.push('SYSTEM_BOARD_ID');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    jobs: env.JOBS_BOARD_ID!,
    profiles: env.PROFILES_BOARD_ID!,
    system: env.SYSTEM_BOARD_ID!,
  };
}

export async function main(
  argv: string[],
  env: Env,
  o: {
    trello?: TrelloApi;
    scan?: RunDeps['scan'];
    /** Replaces single sources of the real scan. */
    sources?: Partial<Omit<ScanDeps, 'log'>>;
    out?: (s: string) => void;
  } = {},
): Promise<number> {
  const out = o.out ?? ((s: string) => process.stdout.write(s + '\n'));

  let parsed: ReturnType<typeof parseRunArgs>;
  try {
    parsed = parseRunArgs(argv);
  } catch (e) {
    out(e instanceof UsageError ? e.message : String(e));
    return 1;
  }

  const key = env.TRELLO_KEY;
  const token = env.TRELLO_TOKEN;

  let trello: TrelloApi;
  if (o.trello) {
    trello = o.trello;
  } else {
    const missing: string[] = [];
    if (!key) missing.push('TRELLO_KEY');
    if (!token) missing.push('TRELLO_TOKEN');
    if (missing.length) {
      out(`Missing environment variables: ${missing.join(', ')}`);
      return 1;
    }
    trello = createTrelloClient({ key: key!, token: token! });
  }

  let boards: UserBoards;
  try {
    boards = resolveBoards(env, parsed.boardsFile);
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }

  let budgetMs: number | undefined;
  if (env.RUN_BUDGET_MIN !== undefined) {
    const n = Number(env.RUN_BUDGET_MIN);
    if (!Number.isFinite(n) || n <= 0) {
      out(`RUN_BUDGET_MIN must be a positive number (got ${JSON.stringify(env.RUN_BUDGET_MIN)})`);
      return 1;
    }
    budgetMs = n * 60_000;
  }

  const defaults = loadDefaults();

  // scanAll turns a thrown career-ops error (ScanFailed too) into a source error; the run reports it as ⚠️.
  const scan: RunDeps['scan'] = o.scan ?? ((plan, so) => scanAll(plan, {
    careerOps: (portals) => runCareerOpsScan(portals, { env }),
    ...o.sources,
    log: so.log,
  }));

  const opts: RunOpts = {
    trigger: parsed.trigger,
    dryRun: parsed.dryRun,
    ...(parsed.cap !== undefined ? { cap: parsed.cap } : {}),
    ...(budgetMs !== undefined ? { budgetMs } : {}),
  };

  const deps: RunDeps = {
    trello,
    boards,
    scan,
    fetchJd,
    env,
    defaults,
    now: () => new Date(),
    sink: out,
  };

  const result = await runOnce(deps, opts);
  out(result.report);
  return result.exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env as Env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
