import { z } from 'zod';

// Zod schemas for Trello API response shapes.
// Each schema uses .strip() (the default) to drop unknown fields at the boundary.
// Field lists match the `fields=` query parameters the client requests.

export const TMemberSchema = z.object({ id: z.string(), username: z.string() }).strip();
export type TMember = z.infer<typeof TMemberSchema>;

export const TBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean(),
  idOrganization: z.string().nullable(),
  prefs: z.object({
    permissionLevel: z.union([z.literal('private'), z.literal('org'), z.literal('public'), z.string()]),
  }).strip(),
}).strip();
export type TBoard = z.infer<typeof TBoardSchema>;

export const TLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
}).strip();
export type TLabel = z.infer<typeof TLabelSchema>;

export const TListSchema = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean(),
  pos: z.number(),
  idBoard: z.string(),
}).strip();
export type TList = z.infer<typeof TListSchema>;

export const TCheckItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.union([z.literal('complete'), z.literal('incomplete')]),
  pos: z.number(),
}).strip();
export type TCheckItem = z.infer<typeof TCheckItemSchema>;

export const TChecklistSchema = z.object({
  id: z.string(),
  name: z.string(),
  idCard: z.string(),
  idBoard: z.string().optional(),
  checkItems: z.array(TCheckItemSchema),
}).strip();
export type TChecklist = z.infer<typeof TChecklistSchema>;

export const TCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string(),
  idList: z.string(),
  idBoard: z.string(),
  closed: z.boolean(),
  pos: z.number(),
  shortUrl: z.string(),
  checklists: z.array(TChecklistSchema).optional(),
}).strip();
export type TCard = z.infer<typeof TCardSchema>;

export const TCardWithListSchema = TCardSchema.extend({
  list: z.object({ id: z.string(), name: z.string() }).strip(),
}).strip();
export type TCardWithList = z.infer<typeof TCardWithListSchema>;

export type NewCard = {
  idList: string;
  name: string;
  desc: string;
  pos: 'top' | 'bottom' | number;
  idLabels?: string[];
  start?: string;
  due?: string;
};

export interface TrelloApi {
  me(): Promise<TMember>;
  board(id: string): Promise<TBoard>;
  boardMembers(id: string): Promise<TMember[]>;
  organizationMembers(orgId: string): Promise<TMember[]>;
  /** GET /members/me/organizations — workspaces, not boards */
  myOrganizations(): Promise<{ id: string; displayName: string }[]>;
  lists(boardId: string, filter: 'open' | 'all'): Promise<TList[]>;
  list(id: string): Promise<TList>;
  cards(boardId: string, opts: { filter: 'open' | 'all'; checklists?: boolean; before?: string; limit?: number }): Promise<TCard[]>;
  /** Open and archived cards, paged by 1,000 */
  allCards(boardId: string): Promise<TCard[]>;
  /** GET /cards/{id} with list=true&list_fields=name */
  card(id: string): Promise<TCardWithList>;
  checklist(id: string): Promise<TChecklist>;
  labels(boardId: string): Promise<TLabel[]>;
  createLabel(boardId: string, name: string, color: string): Promise<TLabel>;
  /** defaultLists=false, prefs_permissionLevel=private */
  createBoard(name: string, idOrganization: string): Promise<TBoard>;
  createList(boardId: string, name: string, pos: 'top' | 'bottom' | number): Promise<TList>;
  setListClosed(listId: string, closed: boolean): Promise<TList>;
  createCard(c: NewCard): Promise<TCard>;
  setCardClosed(cardId: string, closed: boolean): Promise<TCard>;
  /** text in the JSON body, not the query */
  comment(cardId: string, text: string): Promise<{ id: string }>;
  /** multipart, text/markdown */
  attachText(cardId: string, name: string, text: string): Promise<{ id: string }>;
  createChecklist(cardId: string, name: string): Promise<TChecklist>;
  addCheckItem(checklistId: string, name: string, checked?: boolean): Promise<TCheckItem>;
}
