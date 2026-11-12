// The bot token also sees real users' boards. These checks keep the sample tool on its own three boards.
import type { TrelloApi } from '../../src/trello/api.ts';

export const SAMPLE_NAMES = {
  jobs: 'career-cards sample · Jobs',
  profiles: 'career-cards sample · Profiles',
  system: 'career-cards sample · System',
} as const;

export type SampleBoard = keyof typeof SAMPLE_NAMES;
/** `guests`: member ids the `share` command added (the test bot); nobody else may be a member. */
export type SampleState = { workspace: string; guests?: string[] } & Record<SampleBoard, string>;

export class SampleGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SampleGuardError';
  }
}

function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

// `/members/me?boards=all` lists boards too, so any board-ish query on a member or workspace is refused.
function listsBoards(u: URL): boolean {
  const p = u.pathname.replace(/^\/1(?=\/)/, '');
  if (/^\/search(\/|$)/i.test(p)) return true;
  const owner = /^\/(members|organizations)\/[^/]+(\/.*)?$/i.exec(p);
  if (!owner) return false;
  if (/^\/board/i.test(owner[2] ?? '')) return true;
  return [...u.searchParams.keys()].some((k) => /^board/i.test(k));
}

export function denyBoardListing(f: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = urlOf(input);
    if (listsBoards(u)) throw new SampleGuardError(`refused: ${u.pathname} lists boards or searches (board listing refused)`);
    return f(input, init);
  }) as typeof fetch;
}

export async function pickBotWorkspace(api: TrelloApi): Promise<string> {
  const me = await api.me();
  const orgs = await api.myOrganizations();
  const own: string[] = [];
  for (const o of orgs) {
    const members = await api.organizationMembers(o.id);
    if (members.length === 1 && members[0]!.id === me.id) own.push(o.id);
  }
  if (own.length === 1) return own[0]!;
  const names = orgs.map((o) => o.displayName).join(', ') || '(none)';
  throw new SampleGuardError(
    `need exactly one workspace whose only member is the bot, found ${own.length}; the bot's workspaces: ${names}`,
  );
}

export async function verifySampleBoards(api: TrelloApi, state: SampleState): Promise<void> {
  const me = await api.me();
  for (const which of Object.keys(SAMPLE_NAMES) as SampleBoard[]) {
    const b = await api.board(state[which]);
    if (b.name !== SAMPLE_NAMES[which]) throw new SampleGuardError(`the ${which} board is not a sample board`);
    if (b.idOrganization !== state.workspace) throw new SampleGuardError(`the ${which} board is not in the bot's workspace`);
    if (b.prefs.permissionLevel !== 'private') throw new SampleGuardError(`the ${which} board is not private`);
    const allowed = new Set([me.id, ...(state.guests ?? [])]);
    const members = await api.boardMembers(b.id);
    if (!members.some((m) => m.id === me.id) || members.some((m) => !allowed.has(m.id))) {
      throw new SampleGuardError(`the ${which} board has members other than the bot and its shared guests`);
    }
  }
}

/** Rewrites the `allowed_members:` line of the Settings card's YAML block; refuses a card without exactly one. */
export function withAllowedMembers(desc: string, usernames: string[]): string {
  const block = /```yaml\n([\s\S]*?)```/.exec(desc);
  const lines = block?.[1]!.split('\n') ?? [];
  if (lines.filter((l) => /^allowed_members:/.test(l)).length !== 1) {
    throw new SampleGuardError('the Settings card has no single allowed_members line');
  }
  const body = lines.map((l) => (/^allowed_members:/.test(l) ? `allowed_members: [${usernames.join(', ')}]` : l)).join('\n');
  return desc.slice(0, block!.index) + '```yaml\n' + body + '```' + desc.slice(block!.index + block![0].length);
}
