// The reader stage: answers from the job card's own text, with no profile, no tools and no network.
import { z } from 'zod';
import { llmConfig } from '../../pipeline/llm.ts';
import { PrivacyError, buildBotMasking } from '../../privacy.ts';
import type { BotMasking } from '../../privacy.ts';
import { scoringProfile } from '../../run/profiles.ts';
import { isoDateIn } from '../../run/process.ts';
import type { TCard } from '../../trello/api.ts';
import { loadCardContext, parseJobCard } from '../context.ts';
import type { JobFields } from '../context.ts';
import type { CommandCtx, Handler, HandlerResult } from '../handlers.ts';
import { readerMessages } from '../prompt.ts';
import type { EarlierPosting, ReaderInput } from '../prompt.ts';
import { JOB_ONLY_REPLY, MASKING_REPLY, callStage, stageErrorReply } from './call.ts';

export const LEGIT_SIGNALS = ['freshness', 'description_quality', 'reposting', 'role_market_context',
  'employment_classification', 'benefits_country_mismatch', 'buzzword_mismatch', 'scam_markers'] as const;

export const LegitSchema = z.object({
  tier: z.enum(['high_confidence', 'proceed_with_caution', 'suspicious']),
  signals: z.array(z.object({
    signal: z.enum(LEGIT_SIGNALS),
    finding: z.string().max(300),
    weight: z.enum(['positive', 'neutral', 'concerning']),
  }).strict()).max(10),
  notes: z.string().max(600),
}).strict();
export type Legit = z.infer<typeof LegitSchema>;

export const NeedsSchema = z.object({
  documents: z.array(z.string().max(200)).max(10),
  language: z.string().max(200),
  deadline: z.string().max(100),
  how_to_apply: z.string().max(400),
  contact: z.string().max(200),
  salary: z.string().max(200),
  notes: z.string().max(600),
}).strict();
export type Needs = z.infer<typeof NeedsSchema>;

const EARLIER_MAX = 10;
const GENDER_MARK = /\(\s*(?:[mwfdxi*](?:\s*[/|,]\s*(?:[mwfdxi*]|divers|div))+|all genders?|gn\*?)\s*\)/giu;

export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(GENDER_MARK, ' ')
    .replace(/\[de\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Trello ids start with the creation time in Unix seconds.
const createdOf = (id: string): number => parseInt(id.slice(0, 8), 16) * 1000;

/** Earlier cards for the same company and title, oldest first, at most the newest 10. */
export function earlierPostings(cards: TCard[], job: JobFields, selfId: string): EarlierPosting[] {
  const company = job.company.trim().toLowerCase();
  const title = normaliseTitle(job.title);
  if (!company || !title) return [];
  const found: { j: JobFields; c: TCard; t: number }[] = [];
  for (const c of cards) {
    if (c.id === selfId || !/^[0-9a-f]{8}/i.test(c.id)) continue;
    const j = parseJobCard(c.name, c.desc);
    if (j && j.company.trim().toLowerCase() === company && normaliseTitle(j.title) === title) found.push({ j, c, t: createdOf(c.id) });
  }
  return found
    .sort((a, b) => b.t - a.t)
    .slice(0, EARLIER_MAX)
    .reverse()
    .map(({ j, c, t }) => ({ title: j.title, created: new Date(t).toISOString().slice(0, 10), closed: c.closed }));
}

const TIER_LINE: Record<Legit['tier'], string> = {
  high_confidence: 'Posting looks real: high confidence',
  proceed_with_caution: 'Mixed signals: proceed with caution',
  suspicious: 'Suspicious: check before investing time',
};
const SIGNAL_LABEL: Record<(typeof LEGIT_SIGNALS)[number], string> = {
  freshness: 'Freshness',
  description_quality: 'Description quality',
  reposting: 'Reposting',
  role_market_context: 'Role and market',
  employment_classification: 'Employment classification',
  benefits_country_mismatch: 'Benefits terms vs country',
  buzzword_mismatch: 'Buzzwords vs role',
  scam_markers: 'Scam markers',
};
const WEIGHT_EMOJI: Record<Legit['signals'][number]['weight'], string> = { positive: '✅', neutral: '➖', concerning: '⚠️' };

// Model strings are one line each, so they can't fake a line the code writes.
const line = (s: string): string => s.replace(/\s+/g, ' ').trim();

// Replies are posted as plain text (finishReply escapes Markdown), so the renders use none.
export function renderLegit(v: Legit, earlier: EarlierPosting[]): string {
  const lines = [TIER_LINE[v.tier]];
  for (const s of v.signals) lines.push(`- ${WEIGHT_EMOJI[s.weight]} ${SIGNAL_LABEL[s.signal]}: ${line(s.finding)}`);
  if (earlier.length) {
    lines.push(`Seen before on this board: ${earlier.length} ${earlier.length === 1 ? 'time' : 'times'} (${earlier.map((e) => e.created).join(', ')})`);
  }
  if (v.notes.trim()) lines.push(line(v.notes));
  return lines.join('\n');
}

const notStated = (s: string): boolean => /^\s*not stated\.?\s*$/i.test(s) || !s.trim();

/** `cardDeadline` is the card head's deadline, shown when the posting text gives none. */
export function renderNeeds(v: Needs, cardDeadline = ''): string {
  const deadline = notStated(v.deadline) && cardDeadline ? `${cardDeadline} (from the card)` : line(v.deadline);
  const lines = [
    ...(v.documents.length ? [`Documents: ${v.documents.map(line).join('; ')}`] : []),
    `Language: ${line(v.language)}`,
    `Deadline: ${deadline}`,
    `How to apply: ${line(v.how_to_apply)}`,
    `Contact: ${line(v.contact)}`,
    `Salary: ${line(v.salary)}`,
  ];
  if (!notStated(v.notes)) lines.push(line(v.notes));
  return lines.join('\n');
}

async function readerStage(ctx: CommandCtx, kind: 'legit' | 'needs'): Promise<HandlerResult> {
  const cc = await loadCardContext(ctx.api, ctx.boards, ctx.action, ctx.me.id, ctx.comments);
  if (!cc.job) return { text: JOB_ONLY_REPLY(kind), uncounted: true };
  const job = cc.job;
  const earlier = kind === 'legit' ? earlierPostings(await ctx.api.allCards(ctx.boards.jobs), job, cc.card.id) : [];
  const input: ReaderInput = { job, earlier, today: isoDateIn(ctx.now, ctx.settings.timezone) };

  let messages;
  try {
    const cfg = await ctx.config();
    const masking: BotMasking = buildBotMasking({ user: cfg, profile: scoringProfile(cfg) });
    messages = readerMessages(kind, input, masking);
  } catch (e) {
    if (e instanceof PrivacyError) return { text: MASKING_REPLY(e.message), uncounted: true };
    throw e;
  }

  const o = { llm: llmConfig(ctx.env, ctx.settings), signal: ctx.signal, log: ctx.log, ...(ctx.call ? { call: ctx.call } : {}) };
  try {
    if (kind === 'legit') return { text: renderLegit((await callStage(messages, LegitSchema, o)).value, earlier) };
    return { text: renderNeeds((await callStage(messages, NeedsSchema, o)).value, job.deadline) };
  } catch (e) {
    return { text: stageErrorReply(e, ctx.log) };
  }
}

export const checkLegit: Handler = (ctx) => readerStage(ctx, 'legit');
export const applyNeeds: Handler = (ctx) => readerStage(ctx, 'needs');
