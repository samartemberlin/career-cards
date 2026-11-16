import { parseWebhook } from '../serve/gate.ts';
import { handleCommentNow } from './dispatch.ts';
import type { DispatchDeps } from './dispatch.ts';
import { botMarkers } from './marker.ts';
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

  // Re-check the marker right before the first comment post on this card: if another job ran the same
  // action concurrently (misconfig or overlap during migration), skip the duplicate.
  let answeredBeforePost = false;
  const originalComment = d.api.comment.bind(d.api);
  let firstCommentOnCard = true;
  const wrappedApi: DispatchDeps['api'] = {
    ...d.api,
    comment: async (cardId, text) => {
      if (firstCommentOnCard && cardId === a.cardId) {
        firstCommentOnCard = false;
        const existing = await d.api.cardComments(a.cardId, { limit: 50 });
        if (botMarkers(existing, d.me.id).some((m) => m.actionId === a.id)) {
          answeredBeforePost = true;
        }
      }
      if (answeredBeforePost) return { id: 'noop' as const };
      return originalComment(cardId, text);
    },
  };

  const t0 = d.now().getTime();
  const status = await handleCommentNow({
    ...d,
    api: wrappedApi,
    maxAgeMs: BOT_ACTION_MAX_AGE_MS,
    onGate: () => d.log('bot: gate ok'),
    onVerb: (v) => d.log(`bot: verb ${v}`),
  }, a);

  if (answeredBeforePost) {
    d.log(`drop ${id}: answered`);
    return 0;
  }
  if (status === 'failed') return 1;
  if (status === 'dropped') return 0;
  d.log(`bot: replied in ${d.now().getTime() - t0} ms`);
  d.log(`bot: action ${id} handled`);
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

  if (!env.TRELLO_KEY) { process.stderr.write('missing TRELLO_KEY\n'); return 1; }
  if (!env.TRELLO_TOKEN) { process.stderr.write('missing TRELLO_TOKEN\n'); return 1; }
  const boards = resolveBoards(env);
  const trello = createTrelloClient({ key: env.TRELLO_KEY, token: env.TRELLO_TOKEN });
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
