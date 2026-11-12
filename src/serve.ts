// Service entrypoint: Trello webhooks and the scheduled trigger.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createTrelloClient } from './trello/client.ts';
import type { TrelloApi } from './trello/api.ts';
import { scopeUserBoards } from './trello/scoped.ts';
import type { UserBoards } from './trello/scoped.ts';
import { UsageError, resolveBoards } from './run.ts';
import { createApp } from './serve/app.ts';
import { callbackUrl } from './serve/auth.ts';
import { createRecentIds } from './serve/gate.ts';
import { createQueue } from './serve/queue.ts';
import type { Queue } from './serve/queue.ts';
import { localRunStarter } from './serve/runs.ts';
import type { RunStarter } from './serve/runs.ts';
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
};

const REQUIRED = [
  'TRELLO_KEY', 'TRELLO_TOKEN', 'TRELLO_APP_SECRET', 'TRIGGER_SECRET', 'PUBLIC_URL',
  'JOBS_BOARD_ID', 'PROFILES_BOARD_ID', 'SYSTEM_BOARD_ID',
] as const;

export const TRIGGER_SECRET_MIN = 32;
export const QUEUE_MAX = 50;

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
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
      problems.push('PUBLIC_URL must be an https:// URL without credentials, query or fragment');
    }
  }

  let port = 8080;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = Number(env.PORT);
    if (!/^\d+$/.test(env.PORT) || port > 65535) problems.push('PORT must be a port number');
  }

  if (problems.length) throw new UsageError(problems.join('\n'));
  return {
    port,
    publicUrl,
    appSecret: env.TRELLO_APP_SECRET!,
    triggerSecret: secret,
    trello: { key: env.TRELLO_KEY!, token: env.TRELLO_TOKEN! },
    boards: resolveBoards(env),
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
): Promise<{ server: Server; queue: Queue; close(): Promise<void> }> {
  const cfg = parseServeEnv(env);
  const log = createRunLog({
    sink: o.out ?? ((s) => process.stdout.write(`${s}\n`)),
    secrets: secretsFromEnv(env),
    keep: 0,
  }).log;

  const api = scopeUserBoards(o.trello ?? createTrelloClient(cfg.trello), cfg.boards);
  const me = await api.me();
  for (const id of [cfg.boards.jobs, cfg.boards.profiles, cfg.boards.system]) await api.board(id);

  const starter = o.starter ?? localRunStarter({ env, log });
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
    async close() {
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
