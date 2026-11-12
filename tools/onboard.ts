// Sets up a user's three boards. Only `--dry-run` exists so far: it reads the boards and prints the plan.
// Usage: node --env-file=<file> tools/onboard.ts --dry-run [--state <file>] [--workspace <id>] [--owner-user <username>]
//          [--name <prefix>] [--url <https base>]
// Env: TRELLO_KEY, TRELLO_TOKEN (the bot); optional OWNER_TRELLO_KEY, OWNER_TRELLO_TOKEN (the board owner).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../src/trello/client.ts';
import type { BotApi, TrelloApi } from '../src/trello/api.ts';
import { scopeBotClient, scopeUserBoards } from '../src/trello/scoped.ts';
import { readOnlyClient } from '../src/trello/read-only.ts';
import { denyBoardListing } from './sample/guard.ts';
import { formatPlan, planOnboarding, readBoards } from './onboard/plan.ts';
import type { BoardIds } from './onboard/plan.ts';

const DEFAULT_STATE = join(import.meta.dirname, '.onboard.json');
const USAGE = 'usage: tools/onboard.ts --dry-run [--state <file>] [--workspace <id>] [--owner-user <username>] [--name <prefix>] [--url <https base>]';
const TRELLO_ID = /^[0-9a-f]{24}$/;
// Also keeps a username from turning `/members/<username>` into another path.
const USERNAME = /^[a-z0-9_]{1,100}$/i;

class UsageError extends Error {}

type Args = { dryRun: boolean; state: string; workspace?: string; ownerUser?: string; name: string; url?: string };

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, state: DEFAULT_STATE, name: 'career-cards' };
  const rest = [...argv];
  const value = (flag: string): string => {
    const v = rest.shift();
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  while (rest.length) {
    const flag = rest.shift()!;
    if (flag === '--dry-run') a.dryRun = true;
    else if (flag === '--state') a.state = value(flag);
    else if (flag === '--workspace') a.workspace = value(flag);
    else if (flag === '--owner-user') a.ownerUser = value(flag);
    else if (flag === '--name') a.name = value(flag);
    else if (flag === '--url') a.url = value(flag);
    else throw new UsageError(`unknown flag ${flag}`);
  }
  if (a.workspace !== undefined && !TRELLO_ID.test(a.workspace)) throw new UsageError('--workspace must be a 24-hex Trello id');
  if (a.ownerUser !== undefined && !USERNAME.test(a.ownerUser)) throw new UsageError('--owner-user must be a Trello username');
  if (a.url !== undefined) {
    let u: URL;
    try {
      u = new URL(a.url);
    } catch {
      throw new UsageError('--url must be a URL');
    }
    if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) throw new UsageError('--url must be a plain https URL');
  }
  return a;
}

function readStateFile(file: string): unknown {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Board ids come only from here: the tool never lists boards to find them. */
function boardIds(raw: unknown): Partial<BoardIds> {
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('the state file must hold a JSON object');
  const ids: Partial<BoardIds> = {};
  for (const role of ['jobs', 'profiles', 'system'] as const) {
    const v = (raw as Record<string, unknown>)[role];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !TRELLO_ID.test(v)) throw new UsageError(`the state file's ${role} must be a 24-hex Trello id`);
    ids[role] = v;
  }
  return ids;
}

/** Scoped to the given ids only; with all three it is exactly the run's own scope. */
function scoped(raw: TrelloApi, ids: Partial<BoardIds>): BotApi {
  if (ids.jobs && ids.profiles && ids.system) return scopeUserBoards(raw, { jobs: ids.jobs, profiles: ids.profiles, system: ids.system });
  return scopeBotClient(raw, { boards: Object.values(ids), ...(ids.profiles ? { profilesBoard: ids.profiles } : {}) });
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  o: { fetch?: typeof fetch; out?: (s: string) => void; readState?: (file: string) => unknown } = {},
): Promise<number> {
  const out = o.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const f = o.fetch ?? fetch;
  try {
    const args = parseArgs(argv);
    if (!args.dryRun) throw new UsageError('only --dry-run exists so far; applying the plan comes in a later change');
    const ids = boardIds((o.readState ?? readStateFile)(args.state));

    const { TRELLO_KEY: key, TRELLO_TOKEN: token, OWNER_TRELLO_KEY: ownerKey, OWNER_TRELLO_TOKEN: ownerToken } = env;
    if (!key || !token) throw new UsageError('TRELLO_KEY and TRELLO_TOKEN (the bot) must be set');
    if (Boolean(ownerKey) !== Boolean(ownerToken)) throw new UsageError('set both OWNER_TRELLO_KEY and OWNER_TRELLO_TOKEN, or neither');

    const botRaw = createTrelloClient({ key, token, fetchImpl: denyBoardListing(f) });
    const ownerRaw = ownerKey && ownerToken ? createTrelloClient({ key: ownerKey, token: ownerToken, fetchImpl: denyBoardListing(f) }) : botRaw;
    const bot = readOnlyClient(scoped(botRaw, ids));
    const owner = ownerRaw === botRaw ? bot : readOnlyClient(scoped(ownerRaw, ids));

    let ownerUser: string;
    if (ownerRaw !== botRaw) {
      const me = (await owner.me()).username;
      if (args.ownerUser !== undefined && args.ownerUser.toLowerCase() !== me.toLowerCase()) {
        throw new UsageError(`--owner-user ${args.ownerUser} is not the account of OWNER_TRELLO_TOKEN`);
      }
      ownerUser = me;
    } else {
      if (args.ownerUser === undefined) throw new UsageError('without OWNER_TRELLO_KEY and OWNER_TRELLO_TOKEN, --owner-user names the user');
      try {
        ownerUser = (await botRaw.member(args.ownerUser)).username;
      } catch (e) {
        if ((e as { status?: number }).status === 404) throw new UsageError(`no Trello user ${args.ownerUser}`);
        throw e;
      }
    }

    const observed = await readBoards(owner, bot, ids);
    const plan = planOnboarding({ observed, owner: ownerUser, name: args.name, ...(args.url !== undefined ? { url: args.url } : {}) });
    out(formatPlan(plan));
    out('Dry run: nothing was changed.');
    return plan.refuse.length ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      out(`${e.message}\n${USAGE}`);
      return 2;
    }
    out(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
