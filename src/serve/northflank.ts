import { z } from 'zod';
import type { Env } from '../pipeline/llm.ts';
import type { RunTrigger } from '../run/stats.ts';
import type { RunStarter } from './runs.ts';

export type NorthflankOpts = {
  token: string;
  projectId: string;
  jobId: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

/** A run started this recently counts as active even when the runs list doesn't show it yet. */
export const JUST_STARTED_MS = 120_000;

const RunsReply = z.object({
  data: z.object({
    runs: z.array(z.object({ id: z.string(), runName: z.string(), concluded: z.boolean(), status: z.string() })),
  }),
});
const StartReply = z.object({ data: z.object({ id: z.string(), runName: z.string() }) });

/** Errors carry the status only: a reply body or a fetch error could echo the token. */
class NorthflankError extends Error {
  readonly refused: boolean;
  constructor(what: string, op: 'list' | 'start', refused = false) {
    super(`northflank ${what} on ${op}`);
    this.refused = refused;
  }
}

/**
 * The deployed run lock: Northflank's concurrency policy doesn't cover API-started runs, so `isRunning` asks for an
 * unconcluded run. Wrap it in `serialStarter` so the check and the start that follows can't interleave.
 */
export function northflankStarter(o: NorthflankOpts): RunStarter {
  const base = (o.apiBase ?? 'https://api.northflank.com').replace(/\/+$/, '');
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const runsUrl = `${base}/v1/projects/${encodeURIComponent(o.projectId)}/jobs/${encodeURIComponent(o.jobId)}/runs`;
  let startedAt = -Infinity;

  async function call<T>(op: 'list' | 'start', url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    // Races the signal as well, so a fetch that ignores it still settles and `serialStarter` releases its claim.
    const timedOut = new Promise<never>((_, reject) => {
      const fail = () => reject(new NorthflankError('timeout', op));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    const work = (async () => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          ...init,
          headers: { authorization: `Bearer ${o.token}`, accept: 'application/json', ...init.headers },
          signal,
          // A redirect would carry the bearer header away from apiBase.
          redirect: 'error',
        });
      } catch {
        throw new NorthflankError(signal.aborted ? 'timeout' : 'unreachable', op);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new NorthflankError(String(res.status), op, res.status >= 400 && res.status < 500 && res.status !== 408);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new NorthflankError(signal.aborted ? 'timeout' : 'bad reply', op);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new NorthflankError('bad reply', op);
      return parsed.data;
    })();
    work.catch(() => {});
    return Promise.race([work, timedOut]);
  }

  return {
    async isRunning() {
      if (now() - startedAt < JUST_STARTED_MS) return true;
      const { data } = await call('list', `${runsUrl}?per_page=20`, { method: 'GET' }, RunsReply);
      return data.runs.some((r) => !r.concluded);
    },
    async start(trigger: RunTrigger) {
      const body = JSON.stringify({ runtimeEnvironment: { RUN_TRIGGER: trigger } });
      try {
        await call('start', runsUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, StartReply);
      } catch (e) {
        // Only a refusal proves no run was created; after a timeout or a 5xx the run may exist but not be listed yet.
        if (!(e instanceof NorthflankError && e.refused)) startedAt = now();
        throw e;
      }
      startedAt = now();
    },
  };
}

const NORTHFLANK_VARS = ['NORTHFLANK_API_TOKEN', 'NORTHFLANK_PROJECT_ID', 'NORTHFLANK_JOB_ID'] as const;

/** Northflank when all three variables are set, the local starter when none are; a partial set is a startup error. */
export function selectStarter(
  env: Env,
  local: () => RunStarter,
  o: Pick<NorthflankOpts, 'apiBase' | 'fetchImpl' | 'now' | 'timeoutMs'> = {},
): RunStarter {
  const missing = NORTHFLANK_VARS.filter((k) => !env[k]);
  if (missing.length === NORTHFLANK_VARS.length) return local();
  if (missing.length) throw new Error(`NORTHFLANK_* variables are incomplete: missing ${missing.join(', ')}`);
  return northflankStarter({
    ...o,
    token: env.NORTHFLANK_API_TOKEN!,
    projectId: env.NORTHFLANK_PROJECT_ID!,
    jobId: env.NORTHFLANK_JOB_ID!,
  });
}
