// Test helpers for Trello webhook payloads.
import type { TMember } from '../../src/trello/api.ts';
import { trelloSignature } from '../../src/serve/auth.ts';

/** Returns the body Trello POSTs to the callback URL for a commentCard action. */
export function commentWebhook(o: {
  cardId: string;
  boardId: string;
  listName?: string;
  author: TMember;
  text: string;
  date?: string;
  id?: string;
}): unknown {
  const id = o.id ?? `fa4e${Math.random().toString(16).slice(2).padStart(20, '0')}`;
  const date = o.date ?? new Date().toISOString();
  const listId = `fa4e${Math.random().toString(16).slice(2).padStart(20, '0')}`;
  return {
    action: {
      id,
      type: 'commentCard',
      date,
      idMemberCreator: o.author.id,
      memberCreator: { id: o.author.id, username: o.author.username },
      data: {
        text: o.text,
        card: { id: o.cardId, name: '', shortLink: '' },
        board: { id: o.boardId, name: '' },
        list: { id: listId, name: o.listName ?? '' },
      },
    },
    model: { id: o.boardId },
  };
}

/** Serializes `payload` once and signs those exact bytes the way Trello does. */
export function signedWebhook(
  payload: unknown,
  callbackUrl: string,
  appSecret: string,
): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return { body, signature: trelloSignature(body, callbackUrl, appSecret) };
}
