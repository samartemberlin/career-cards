import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createTrelloClient } from './trello/client.ts';
import type { TrelloApi } from './trello/api.ts';
import { scopeUserBoards } from './trello/scoped.ts';
import type { UserBoards } from './trello/scoped.ts';
import { UsageError, resolveBoards, runLockPath } from './run.ts';
import { createApp } from './serve/app.ts';
import { callbackUrl } from './serve/auth.ts';
import { createRecentIds } from './serve/gate.ts';
import { createQueue } from './serve/queue.ts';
import type { Queue } from './serve/queue.ts';
import { selectStarter } from './serve/northflank.ts';
import { localRunStarter, serialStarter } from './serve/runs.ts';
import type { LocalRunStarter, RunStarter } from './serve/runs.ts';
import { readOwnCgroup, startMetrics } from './serve/metrics.ts';
import { handleComment } from './bot/dispatch.ts';
import type { DispatchDeps } from './bot/dispatch.ts';
import type { NetDeps } from './bot/handlers.ts';
import { botNet } from './bot/net.ts';
import type { UrlGuard } from './net/safe-fetch.ts';
import { createRunLog, secretsFromEnv } from './run/log.ts';
import type { Env } from './pipeline/llm.ts';

export type ServeConfig = {
  port: number;
  publicUrl: string;
  appSecret: string;
  triggerSecret: string;
  trello: { key: string; token: string };
  boards: UserBoards;
  /** From RUN_HEAP_MB; unset → `defaultRunHeapMb` of the container's memory limit. */
  runHeapMb?: number;
};

const REQUIRED = [
  'TRELLO_KEY', 'TRELLO_TOKEN', 'TRELLO_APP_SECRET', 'TRIGGER_SECRET', 'PUBLIC_URL',
  'JOBS_BOARD_ID', 'PROFILES_BOARD_ID', 'SYSTEM_BOARD_ID',
] as const;

export const TRIGGER_SECRET_MIN = 32;
export const QUEUE_MAX = 50;
/**
 * Old-space MB for the local run and each of its node children on a small host. Measured in a 512 MB / 0.15 vCPU
 * container (scan and description fetches; scoring failed fast on dummy keys): the run's heapUsed stayed near 80 MB
 * and the container peaked at 375 MB with this cap; without caps it was OOM-killed.
 */
export const SMALL_HOST_HEAP_MB = 160;
const SMALL_HOST_MAX_BYTES = 1024 * 2 ** 20;

/** Caps only hosts of at most 1 GB; a bigger or unlimited one keeps node's own defaults. */
export function defaultRunHeapMb(memMax: number | null | undefined): number | undefined {
  return typeof memMax === 'number' && memMax <= SMALL_HOST_MAX_BYTES ? SMALL_HOST_HEAP_MB : undefined;
}

/** Problems name the variable, never its value. */
export function parseServeEnv(env: Env): ServeConfig {
  const problems: string[] = [];
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) problems.push(`Missing environment variables: ${missing.join(', ')}`);

  const secret = env.TRIGGER_SECRET ?? '';
  if (secret && secret.length < TRIGGER_SECRET_MIN) problems.push(`TRIGGER_SECRET must be at least ${TRIGGER_SECRET_MIN} characters`);

  // The signature covers the callback URL, so it comes from here and never from a request's Host header.
  const publicUrl = env.PUBLIC_URL ?? '';
  if (publicUrl) {
    let u: URL | null = null;
    try { u = new URL(publicUrl); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
      // The app routes `/trello` only, so a path would make every webhook a 404.
      problems.push('PUBLIC_URL must be an https:// origin without path, credentials, query or fragment');
    }
  }

  let port = 8080;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = Number(env.PORT);
    if (!/^\d+$/.test(env.PORT) || port > 65535) problems.push('PORT must be a port number');
  }

  let runHeapMb: number | undefined;
  if (env.RUN_HEAP_MB !== undefined && env.RUN_HEAP_MB !== '') {
    runHeapMb = Number(env.RUN_HEAP_MB);
    if (!/^\d+$/.test(env.RUN_HEAP_MB) || runHeapMb < 1) problems.push('RUN_HEAP_MB must be a positive whole number of MB');
  }

  if (problems.length) throw new UsageError(problems.join('\n'));
  return {
    port,
    publicUrl,
    appSecret: env.TRELLO_APP_SECRET!,
    triggerSecret: secret,
    trello: { key: env.TRELLO_KEY!, token: env.TRELLO_TOKEN! },
    boards: resolveBoards(env),
    ...(runHeapMb !== undefined ? { runHeapMb } : {}),
  };
}

export async function main(
  env: Env,
  o: {
    trello?: TrelloApi;
    starter?: RunStarter;
    net?: NetDeps;
    /** Tests only: lets the real bot fetches reach loopback. */
    urlGuard?: UrlGuard;
    listen?: boolean;
    out?: (s: string) => void;
  } = {},
): Promise<{ server: Server; queue: Queue; metrics: Promise<void>; close(): Promise<void> }> {
  const cfg = parseServeEnv(env);
  const log = createRunLog({
    sink: o.out ?? ((s) => process.stdout.write(`${s}\n`)),
    secrets: secretsFromEnv(env),
    keep: 0,
  }).log;

  let local: LocalRunStarter | undefined;
  const heapMb = cfg.runHeapMb ?? defaultRunHeapMb((await readOwnCgroup()).memMax);
  const selected = o.starter ?? selectStarter(env, () => {
    local = localRunStarter({ env, log, lockFile: runLockPath(env, cfg.boards), ...(heapMb !== undefined ? { heapMb } : {}) });
    return local;
  });
  if (!o.starter) log(`starter: ${local ? 'local' : 'northflank'}`);
  const starter = serialStarter(selected);

  const api = scopeUserBoards(o.trello ?? createTrelloClient(cfg.trello), cfg.boards);
  const me = await api.me();
  for (const id of [cfg.boards.jobs, cfg.boards.profiles, cfg.boards.system]) await api.board(id);
  const metrics = startMetrics({ log, runPid: () => local?.pid(), ...(local && heapMb !== undefined ? { runHeapMb: heapMb } : {}) });

  const deps: DispatchDeps = {
    api,
    boards: cfg.boards,
    me,
    seen: createRecentIds(),
    now: () => new Date(),
    log,
    starter,
    net: o.net ?? botNet({ env, ...(o.urlGuard ? { guard: o.urlGuard } : {}) }),
    env,
  };
  const queue = createQueue({ max: QUEUE_MAX, log });
  const app = createApp({
    appSecret: cfg.appSecret,
    callbackUrl: callbackUrl(cfg.publicUrl),
    triggerSecret: cfg.triggerSecret,
    onComment: (a) => queue.push(() => handleComment(deps, a)),
    starter,
    log,
  });

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, app);
  if (o.listen ?? true) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    log(`listening on ${typeof addr === 'object' && addr ? addr.port : cfg.port} as @${me.username}`);
  }

  return {
    server,
    queue,
    metrics: metrics.ready,
    async close() {
      metrics.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await queue.idle();
    },
  };
}

if (import.meta.main) {
  const env = process.env as Env;
  main(env).catch((e: unknown) => {
    const { redact } = createRunLog({ sink: () => {}, secrets: secretsFromEnv(env), keep: 0 });
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    process.exit(1);
  });
}
