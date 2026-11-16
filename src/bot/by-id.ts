import { parseWebhook } from '../serve/gate.ts';
import { handleCommentNow } from './dispatch.ts';
import type { DispatchDeps } from './dispatch.ts';
import { TrelloError } from '../trello/client.ts';
import type { Env } from '../pipeline/llm.ts';
import { createTrelloClient } from '../trello/client.ts';
import { scopeUserBoards } from '../trello/scoped.ts';
import { createRecentIds } from '../serve/gate.ts';
import { serialStarter } from '../serve/runs.ts';
import { ghRunStarter } from '../gh/runs.ts';
import { botNet } from './net.ts';
import { createRunLog, secretsFromEnv } from '../run/log.ts';
import { resolveBoards } from '../run.ts';

export const BOT_ACTION_MAX_AGE_MS = 900_000; // 15 min

export type ByIdDeps = DispatchDeps;

const Id = /^[0-9a-f]{24}$/;

export async function byId(id: string, d: ByIdDeps): Promise<number> {
  d.log('bot: fetch action');

  let raw: unknown;
  try {
    raw = await d.api.action(id);
  } catch (e) {
    if (e instanceof TrelloError && e.status === 404) {
      d.log(`drop ${id}: not found`);
      return 0;
    }
    throw e;
  }

  const a = parseWebhook({ action: raw });
  if (!a) {
    d.log(`drop ${id}: not a comment`);
    return 0;
  }

  let dropped = false;
  const log = (s: string) => { if (s.startsWith('drop ')) dropped = true; d.log(s); };

  const t0 = d.now().getTime();
  await handleCommentNow({ ...d, maxAgeMs: BOT_ACTION_MAX_AGE_MS, log }, a);

  if (!dropped) {
    d.log(`bot: replied in ${d.now().getTime() - t0} ms`);
    d.log(`bot: action ${id} handled`);
  }
  return 0;
}

/** Parses `--action <id>` from argv; returns the id or throws a usage error. */
function parseArgs(argv: string[]): string {
  const i = argv.indexOf('--action');
  if (i === -1 || argv[i + 1] === undefined) throw new Error('usage: bot --action <24-hex id>');
  const id = argv[i + 1]!;
  if (!Id.test(id)) throw new Error('usage: bot --action <24-hex id>');
  return id;
}

/** CLI entry point: wires deps from env and calls byId. */
export async function main(argv: string[], env: Env): Promise<number> {
  let id: string;
  try {
    id = parseArgs(argv);
  } catch {
    return 2;
  }

  const { log, redact } = createRunLog({
    sink: (s) => process.stdout.write(`${s}\n`),
    secrets: secretsFromEnv(env),
    keep: 0,
  });

  const boards = resolveBoards(env);
  const trello = createTrelloClient({ key: env.TRELLO_KEY!, token: env.TRELLO_TOKEN! });
  const api = scopeUserBoards(trello, boards);
  const me = await api.me();

  const starter = serialStarter(ghRunStarter(env));
  const net = botNet({ env });

  const deps: ByIdDeps = {
    api,
    boards,
    me,
    seen: createRecentIds(),
    now: () => new Date(),
    log,
    starter,
    net,
    env,
  };

  try {
    return await byId(id, deps);
  } catch (e) {
    process.stderr.write(`${redact(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
