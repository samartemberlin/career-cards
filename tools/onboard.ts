// Sets up a user's three boards: reads them, prints the plan, and (without --dry-run) creates what is missing.
// Usage: node --env-file=<file> tools/onboard.ts [--dry-run] [--state <file>] [--workspace <id>] [--owner-user <username>]
//          [--name <prefix>] [--url <https base>]
// Env: TRELLO_KEY, TRELLO_TOKEN (the bot); optional OWNER_TRELLO_KEY, OWNER_TRELLO_TOKEN (the board owner).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../src/trello/client.ts';
import { readOnlyClient } from '../src/trello/read-only.ts';
import { denyBoardListing } from './sample/guard.ts';
import { formatPlan, planOnboarding, readBoards } from './onboard/plan.ts';
import type { BoardIds, Role } from './onboard/plan.ts';
import { USERNAME, applyPlan, automationRule, ensureWebhooks, scopedTo } from './onboard/apply.ts';

const DEFAULT_STATE = join(import.meta.dirname, '.onboard.json');
const USAGE = 'usage: tools/onboard.ts [--dry-run] [--state <file>] [--workspace <id>] [--owner-user <username>] [--name <prefix>] [--url <https base>]';
const TRELLO_ID = /^[0-9a-f]{24}$/;

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

/** Keeps whatever else the state file holds. */
function writeStateFile(file: string, ids: Partial<BoardIds>): void {
  const prev = readStateFile(file);
  const base = prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
  writeFileSync(file, JSON.stringify({ ...base, ...ids }, null, 2) + '\n');
}

const TITLE: Record<Role, string> = { jobs: 'Jobs', profiles: 'Profiles', system: 'System' };

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  o: {
    fetch?: typeof fetch;
    out?: (s: string) => void;
    readState?: (file: string) => unknown;
    writeState?: (file: string, ids: Partial<BoardIds>) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const out = o.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const f = o.fetch ?? fetch;
  try {
    const args = parseArgs(argv);
    const ids = boardIds((o.readState ?? readStateFile)(args.state));

    const { TRELLO_KEY: key, TRELLO_TOKEN: token, OWNER_TRELLO_KEY: ownerKey, OWNER_TRELLO_TOKEN: ownerToken } = env;
    if (!key || !token) throw new UsageError('TRELLO_KEY and TRELLO_TOKEN (the bot) must be set');
    if (Boolean(ownerKey) !== Boolean(ownerToken)) throw new UsageError('set both OWNER_TRELLO_KEY and OWNER_TRELLO_TOKEN, or neither');

    const botRaw = createTrelloClient({ key, token, fetchImpl: denyBoardListing(f), ...(o.sleep ? { sleep: o.sleep } : {}) });
    const ownerRaw = ownerKey && ownerToken ? createTrelloClient({ key: ownerKey, token: ownerToken, fetchImpl: denyBoardListing(f), ...(o.sleep ? { sleep: o.sleep } : {}) }) : botRaw;
    const read = (ids: Partial<BoardIds>) => {
      const bot = readOnlyClient(scopedTo(botRaw, ids));
      return readBoards(ownerRaw === botRaw ? bot : readOnlyClient(scopedTo(ownerRaw, ids)), bot, ids);
    };

    let ownerUser: string;
    if (ownerRaw !== botRaw) {
      const me = (await ownerRaw.me()).username;
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

    const plan = planOnboarding({ observed: await read(ids), owner: ownerUser, name: args.name, ...(args.url !== undefined ? { url: args.url } : {}) });
    out(formatPlan(plan));
    if (args.dryRun) {
      out('Dry run: nothing was changed.');
      return plan.refuse.length ? 1 : 0;
    }
    if (plan.refuse.length) {
      out('Nothing was changed: fix the refusals first.');
      return 1;
    }

    let saved = { ...ids };
    const r = await applyPlan(plan, {
      owner: ownerRaw, bot: botRaw, ids, out,
      ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      saveIds: (next) => {
        saved = { ...saved, ...next };
        (o.writeState ?? writeStateFile)(args.state, saved);
      },
    });
    // Without the url: webhooks cannot be read back, so they would always show as to do.
    const after = planOnboarding({ observed: await read(saved), owner: ownerUser, name: args.name });
    out('After apply:');
    out(formatPlan(after));
    let ok = r.failed.length === 0 && after.refuse.length === 0 && after.actions.length === 0;

    if (!saved.jobs || !saved.profiles || !saved.system) {
      out('Not all three boards exist yet: run again.');
      return 1;
    }
    const all: BoardIds = { jobs: saved.jobs, profiles: saved.profiles, system: saved.system };
    if (args.url !== undefined) {
      for (const w of await ensureWebhooks(botRaw, all, args.url)) {
        out(`${TITLE[w.board as Role]}: webhook ${w.result}`);
        ok &&= w.result === 'created' || w.result === 'exists';
      }
    }
    out(`JOBS_BOARD_ID=${all.jobs} PROFILES_BOARD_ID=${all.profiles} SYSTEM_BOARD_ID=${all.system}`);
    if (args.url !== undefined) {
      out('Create this automation rule on the System board:');
      out(automationRule(args.url));
    }
    return ok ? 0 : 1;
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
