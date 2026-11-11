// CLI entrypoint for the nightly run.
// Flags:
//   --dry-run               no Trello writes, no model calls, no JD fetches
//   --trigger scheduled|manual   default: manual
//   --boards <json file>    path to a file with { jobs, profiles, system } board ids
//   --cap <n>               scoring cap override (n ≥ 0); can only lower Settings' cap
import { readFileSync } from 'node:fs';
import { createTrelloClient } from './trello/client.ts';
import type { TrelloApi } from './trello/api.ts';
import { runOnce } from './run/run-once.ts';
import type { RunDeps, RunOpts } from './run/run-once.ts';
import { scanAll, runCareerOpsScan, ScanFailed } from './run/scan.ts';
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
      if (!val) throw new UsageError(`--boards requires a file path\n${USAGE}`);
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
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const jobs = raw['jobs'];
    const profiles = raw['profiles'];
    const system = raw['system'];
    if (!jobs || !profiles || !system) {
      throw new Error(`${file}: must have 'jobs', 'profiles' and 'system' fields`);
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
  o: { trello?: TrelloApi; scan?: RunDeps['scan']; out?: (s: string) => void } = {},
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

  const defaults = loadDefaults();

  const scanDeps: ScanDeps = {
    // Turn a ScanFailed into a source error so the run shows ⚠️ instead of failing.
    careerOps: async (portals) => {
      try {
        return await runCareerOpsScan(portals, { env: env as Record<string, string | undefined> });
      } catch (e) {
        if (e instanceof ScanFailed) {
          const rows = Object.assign([], { errors: [{ company: 'career-ops', error: e.message }] });
          return rows;
        }
        throw e;
      }
    },
    log: out,
  };

  const scan = o.scan ?? ((plan) => scanAll(plan, scanDeps));

  const budgetMs = env.RUN_BUDGET_MIN ? Number(env.RUN_BUDGET_MIN) * 60_000 : undefined;

  const opts: RunOpts = {
    trigger: parsed.trigger,
    dryRun: parsed.dryRun,
    ...(parsed.cap !== undefined ? { cap: parsed.cap } : {}),
    ...(budgetMs !== undefined && !isNaN(budgetMs) ? { budgetMs } : {}),
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

// Only run when executed directly, not when imported.
if (import.meta.main) {
  main(process.argv.slice(2), process.env as Env).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
