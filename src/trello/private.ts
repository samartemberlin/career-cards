import type { BotApi } from './api.ts';

export type PrivacyProblem = {
  board: string;
  boardName: string;
  reason: 'not private' | 'extra member' | 'closed';
  /** The visibility string for 'not private'; the username for 'extra member'; 'board is closed' for 'closed'. */
  detail: string;
};

/**
 * Returns one PrivacyProblem per violation across all boards:
 * each board must be private, open, and have no members outside allowedMembers ∪ {botUsername}.
 * Comparisons are case-insensitive. Empty result means all boards are fine.
 */
export async function checkBoardsPrivate(
  api: BotApi,
  boards: string[],
  o: { allowedMembers: string[]; botUsername: string },
): Promise<PrivacyProblem[]> {
  const allowedLower = new Set([
    ...o.allowedMembers.map((m) => m.toLowerCase()),
    o.botUsername.toLowerCase(),
  ]);

  const problems: PrivacyProblem[] = [];

  for (const boardId of boards) {
    const [board, members] = await Promise.all([api.board(boardId), api.boardMembers(boardId)]);

    if (board.prefs.permissionLevel !== 'private') {
      problems.push({ board: boardId, boardName: board.name, reason: 'not private', detail: board.prefs.permissionLevel });
    }

    if (board.closed) {
      problems.push({ board: boardId, boardName: board.name, reason: 'closed', detail: 'board is closed' });
    }

    for (const member of members) {
      if (!allowedLower.has(member.username.toLowerCase())) {
        problems.push({ board: boardId, boardName: board.name, reason: 'extra member', detail: member.username });
      }
    }
  }

  return problems;
}
