import type { BotApi, TComment } from '../trello/api.ts';
import type { UserBoards } from '../trello/scoped.ts';
import type { CommentAction } from '../serve/gate.ts';
import { parseJobKey, parseJobLink, parseTitleScore, isRunSummaryTitle } from '../trello/cards.ts';

export type BoardKind = 'jobs' | 'profiles' | 'system';

export type JobFields = {
  key: string;
  company: string;
  title: string;
  url: string;
  location: string;
  posted: string;
  deadline: string;
  why: string;
  jd: string;
  score: number | null;
};

export type ConversationItem = {
  author: string;
  byBot: boolean;
  date: string;
  text: string;
};

export type CardContext = {
  card: { id: string; name: string; desc: string; url: string; list: string };
  board: BoardKind;
  job: JobFields | null;
  conversation: ConversationItem[];
};

const COMPANY_TITLE_RE = /^\*\*(.+?) — (.+?)\*\*/m;
const TITLE_FALLBACK_RE = /^\d+ · (.+?) — (.+?)( \[DE\])?$/;
const normaliseBlank = (s: string): string => (s === '—' ? '' : s);

/** Parses a Trello card name + description into structured job fields, or null if not a job card. */
export function parseJobCard(name: string, desc: string): JobFields | null {
  if (isRunSummaryTitle(name)) return null;
  const key = parseJobKey(desc);
  if (!key) return null;

  const url = parseJobLink(desc);

  if (!url) {
    const m = TITLE_FALLBACK_RE.exec(name);
    const company = m?.[1] ?? '';
    const title = m?.[2] ?? '';
    const jd = desc
      .replace(/\n\n---\n(?:career-cards|samjobs)-key:[ \t]*\S+\s*$/, '')
      .replace(/\n(?:career-cards|samjobs)-key:[ \t]*\S+\s*$/, '')
      .trim();
    return { key, company, title, url: '', location: '', posted: '', deadline: '', why: '', jd, score: parseTitleScore(name) };
  }

  const sepIdx = desc.search(/\n---\n/);
  if (sepIdx < 0) {
    return { key, company: '', title: '', url, location: '', posted: '', deadline: '', why: '', jd: desc, score: parseTitleScore(name) };
  }
  const head = desc.slice(0, sepIdx);

  const ctMatch = COMPANY_TITLE_RE.exec(head);
  const company = ctMatch?.[1] ?? '';
  const title = ctMatch?.[2] ?? '';

  const locLine = /^\*\*Location:\*\* .+$/m.exec(head)?.[0] ?? '';
  const parts = locLine.split('  ·  ');
  const location = normaliseBlank(/\*\*Location:\*\* (.+)/.exec(parts[0] ?? '')?.[1]?.trim() ?? '');
  const posted   = normaliseBlank(/\*\*Posted:\*\* (.+)/.exec(parts[1] ?? '')?.[1]?.trim() ?? '');
  const deadline = normaliseBlank(/\*\*Deadline:\*\* (.+)/.exec(parts[2] ?? '')?.[1]?.trim() ?? '');

  const why = normaliseBlank(/^\*\*Why:\*\* (.+)$/m.exec(head)?.[1]?.trim() ?? '');

  // Anchored at end: untrusted job text may embed a fake key line before the real footer.
  const afterSep = desc.slice(sepIdx + '\n---\n'.length);
  const footerMatch = /\n\n---\n(?:career-cards|samjobs)-key:[ \t]*\S+\s*$/.exec(afterSep);
  const jd = footerMatch
    ? afterSep.slice(0, footerMatch.index).trim()
    : afterSep.replace(/\n(?:career-cards|samjobs)-key:[ \t]*\S+\s*$/, '').trim();

  return { key, company, title, url, location, posted, deadline, why, jd, score: parseTitleScore(name) };
}

function boardKindOf(idBoard: string, boards: UserBoards): BoardKind {
  if (idBoard === boards.jobs) return 'jobs';
  if (idBoard === boards.profiles) return 'profiles';
  return 'system';
}

/** Assembles the full context for a webhook comment, using comments the gate already read.
 *  comments must be newest-first (the order cardComments returns them). */
export async function loadCardContext(
  api: BotApi,
  boards: UserBoards,
  a: Pick<CommentAction, 'id' | 'cardId'>,
  botId: string,
  comments: TComment[],
): Promise<CardContext> {
  const card = await api.card(a.cardId);
  const board = boardKindOf(card.idBoard, boards);

  const conversation: ConversationItem[] = comments
    .filter((c) => c.id !== a.id)
    .slice(0, 20)
    .reverse()
    .map((c) => ({
      author: c.username ?? 'unknown',
      byBot: c.idMemberCreator === botId,
      date: c.date,
      text: c.text,
    }));

  const job = board === 'jobs' ? parseJobCard(card.name, card.desc) : null;

  return {
    card: { id: card.id, name: card.name, desc: card.desc, url: card.shortUrl, list: card.list.name },
    board,
    job,
    conversation,
  };
}
