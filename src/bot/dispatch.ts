// One webhook comment in, at most one reply out. Every reply goes through finishReply with the user's masker; the
// only exceptions are CONFIG_BROKEN, NOT_PRIVATE and MASKING_FAILED, constants that carry no personal detail.
import { gate } from '../serve/gate.ts';
import type { CommentAction, GateDeps } from '../serve/gate.ts';
import type { RunStarter } from '../serve/runs.ts';
import { matchStatic } from './catalogue.ts';
import type { ActionSpec } from './catalogue.ts';
import { capClassOf, loadUsage, overCap } from './caps.ts';
import { findPending, finishProposal } from './confirm.ts';
import type { CapClass, Proposal, ReplyClass } from './marker.ts';
import { handleFreeText } from './router.ts';
import { finishReply, linksIn } from './reply.ts';
import { HANDLERS, helpText } from './handlers.ts';
import type { CommandCtx, HandlerResult, NetDeps } from './handlers.ts';
import { PrivacyError, buildMasker } from '../privacy.ts';
import type { Masker } from '../privacy.ts';
import { ConfigInvalid, readUserConfig } from '../trello/config.ts';
import { checkBoardsPrivate } from '../trello/private.ts';
import { createRunLog, secretsFromEnv } from '../run/log.ts';
import type { CallOpts, Env } from '../pipeline/llm.ts';
import type { UserConfig } from '../config/schema.ts';
import type { BotApi } from '../trello/api.ts';
import { TIMEOUT_REPLY } from './stages/call.ts';

export type DispatchDeps = GateDeps & {
  starter: RunStarter; net: NetDeps; env: Env;
  /** Tests only: the model transports. */
  call?: CallOpts;
  commentTimeoutMs?: number; commentGraceMs?: number;
};

export const COMMENT_MAX = 2000;
export const COMMENT_TIMEOUT_MS = 300_000;
export const COMMENT_GRACE_MS = 30_000;
const MASKING_FAILED = "I couldn't post my answer: masking failed on it. Check the Personal details card.";
const CONFIG_BROKEN = "I can't answer until the config cards are fixed. The next run's status card names the problem.";
const NOT_PRIVATE = "I can't work while the boards aren't private. The next run's status card names the problem.";
const IDENTITY: Masker = { mask: (t) => t, hasDetail: () => false };

const firstLine = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split('\n')[0];

const unavailable = (spec: ActionSpec) => `\`${spec.verbs[0]}\` isn't available yet.`;

type Reply = HandlerResult & { cls: ReplyClass; resolves?: string; proposal?: Proposal };

/** `api` whose writes throw once `signal` is aborted; reads pass through. */
export function guardWrites(api: BotApi, signal: AbortSignal): BotApi {
  const guard = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return f(...a);
  };
  return {
    ...api,
    comment: guard(api.comment.bind(api)),
    createCard: guard(api.createCard.bind(api)),
    archiveCard: guard(api.archiveCard.bind(api)),
    attachText: guard(api.attachText.bind(api)),
    createList: guard(api.createList.bind(api)),
    createLabel: guard(api.createLabel.bind(api)),
  };
}

// The check is refused, not the start: serialStarter's `false` claims the slot until the start that follows settles,
// so refusing that start would leave every later caller "busy" until a restart.
const guardStarter = (s: RunStarter, signal: AbortSignal): RunStarter => ({
  isRunning: () => (signal.aborted ? Promise.reject(signal.reason) : s.isRunning()),
  start: (t) => s.start(t),
});

// Two webhooks for one card must not both read the same pending proposal, so each card's comments run in order.
const tails = new Map<string, Promise<void>>();

export function handleComment(d: DispatchDeps, a: CommentAction): Promise<void> {
  const run = (tails.get(a.cardId) ?? Promise.resolve()).then(() => bounded(d, a));
  tails.set(a.cardId, run);
  void run.then(() => {
    if (tails.get(a.cardId) === run) tails.delete(a.cardId);
  });
  return run;
}

/**
 * At the timeout the handler is aborted: its own writes and run starts are refused from then on, and a stage it is
 * in answers that it took too long. The card's chain waits up to the grace for that reply. Then it releases the
 * card, and the comment's reply is refused too, so work that ignores the abort can't hold the card (and, through the
 * serial queue, the service) nor act alongside the card's next comment.
 */
async function bounded(d: DispatchDeps, a: CommentAction): Promise<void> {
  const abort = new AbortController();
  const release = new AbortController();
  const work = handle(d, a, abort.signal, release.signal);
  if (await settlesWithin(work, d.commentTimeoutMs ?? COMMENT_TIMEOUT_MS)) return;
  d.log(`comment ${a.id} timed out`);
  abort.abort();
  if (await settlesWithin(work, d.commentGraceMs ?? COMMENT_GRACE_MS)) return;
  release.abort();
  d.log(`comment ${a.id} still running after the grace; its writes are refused`);
}

async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function handle(d: DispatchDeps, a: CommentAction, signal: AbortSignal, released: AbortSignal): Promise<void> {
  const log = createRunLog({ sink: d.log, secrets: secretsFromEnv(d.env), keep: 0 }).log;
  try {
    await respond({ ...d, api: guardWrites(d.api, released), log }, a, signal);
  } catch (e) {
    log(`comment ${a.id} failed: ${firstLine(e)}`);
  }
}

async function respond(d: DispatchDeps, a: CommentAction, signal: AbortSignal): Promise<void> {
  const g = await gate(d, a);
  if (!g.ok) return;
  const { settings } = g;
  const now = d.now();
  const botName = d.me.username;

  let cfg: Promise<UserConfig> | undefined;
  const config = () => (cfg ??= readUserConfig(d.api, d.boards));

  let allowed: Promise<string[]> | undefined;
  const allowedLinks = () => (allowed ??= d.api.card(a.cardId).then((c) => [...linksIn(c.name), ...linksIn(c.desc), ...linksIn(a.text)]));

  const post = async (masker: Masker, r: Reply): Promise<void> => {
    const marker = { actionId: a.id, cls: r.cls, ...(r.resolves ? { resolves: r.resolves } : {}) };
    const links = [...(await allowedLinks()), ...(r.links ?? [])];
    let parts: string[];
    try {
      parts = r.proposal
        ? finishProposal({ text: r.text, botName, author: a.author, marker: { ...marker, proposal: r.proposal }, masker, allowedLinks: links })
        : finishReply({ text: r.text, author: a.author, marker, masker, allowedLinks: links });
    } catch (e) {
      if (!(e instanceof PrivacyError)) throw e;
      d.log(`reply ${a.id} failed masking: ${e.message}`);
      parts = finishReply({ text: MASKING_FAILED, author: a.author, marker, masker: IDENTITY, allowedLinks: [] });
    }
    for (const part of parts) await d.api.comment(a.cardId, part);
    d.log(`reply ${a.id} on ${a.cardId}: ${r.cls}${r.resolves ? ` resolves ${r.resolves}` : ''}${r.proposal ? ` proposes ${r.proposal.action.id}` : ''}`);
  };

  const problems = await checkBoardsPrivate(d.api, [d.boards.jobs, d.boards.profiles, d.boards.system], {
    allowedMembers: settings.allowed_members,
    botUsername: botName,
  });
  if (problems.length) return post(IDENTITY, { text: NOT_PRIVATE, cls: 'refusal' });
  const refusal = a.text.length > COMMENT_MAX ? 'That comment is over 2,000 characters. Please shorten it.' : null;

  let masker: Masker;
  try {
    masker = buildMasker((await config()).personalDetails);
  } catch (e) {
    if (!(e instanceof ConfigInvalid || e instanceof PrivacyError)) throw e;
    d.log(`config unusable for ${a.id}: ${e.name}`);
    await post(IDENTITY, { text: CONFIG_BROKEN, cls: 'refusal' });
    return;
  }
  if (refusal) return post(masker, { text: refusal, cls: 'refusal' });

  const ctx: CommandCtx = {
    api: guardWrites(d.api, signal), boards: d.boards, me: d.me, settings, action: a, now, config,
    starter: guardStarter(d.starter, signal), net: d.net, log: d.log, env: d.env, signal, comments: g.comments,
    ...(d.call ? { call: d.call } : {}),
  };

  // What to do once the cap allows it; `confirms` is the proposal a `yes` resolves.
  let cls: CapClass = 'static';
  let reply: () => Promise<Reply>;
  let confirms: { actionId: string; spec: ActionSpec; args: unknown } | null = null;

  const m = matchStatic(a.text, botName);
  if (m.kind === 'bad_args') {
    reply = async () => ({ text: m.message, cls });
  } else if (m.kind === 'none') {
    // The one model cap covers the router call and whatever action it picks.
    cls = 'model';
    reply = async () => {
      if (signal.aborted) return { text: TIMEOUT_REPLY, cls: 'refusal' };
      try {
        const r = await handleFreeText(ctx, botName);
        return { ...r, cls: r.uncounted ? 'refusal' : 'model' };
      } catch (e) {
        if (signal.aborted) return { text: TIMEOUT_REPLY, cls: 'refusal' };
        d.log(`router failed on ${a.id}: ${firstLine(e)}`);
        return { text: 'Sorry, something went wrong. The service log has details.', cls: 'refusal' };
      }
    };
  } else if (m.kind === 'builtin' && m.name === 'help') {
    reply = async () => ({ text: helpText(botName), cls });
  } else if (m.kind === 'builtin') {
    const p = findPending(g.comments, { botId: d.me.id, now });
    if (p.kind === 'none') reply = async () => ({ text: 'Nothing to confirm on this card.', cls });
    else if (p.kind === 'expired') reply = async () => ({ text: 'That proposal expired (24 h). Ask again.', cls });
    else if (m.name === 'no') reply = async () => ({ text: 'Cancelled.', cls, resolves: p.pending.actionId });
    else if (!HANDLERS[p.pending.spec.id]) reply = async () => ({ text: unavailable(p.pending.spec), cls });
    else {
      confirms = p.pending;
      cls = capClassOf(p.pending.spec);
      reply = () => runHandler(ctx, p.pending.spec, p.pending.args, cls);
    }
  } else {
    const { spec, args } = m;
    cls = capClassOf(spec);
    reply = HANDLERS[spec.id] ? () => runHandler(ctx, spec, args, cls) : async () => ({ text: unavailable(spec), cls });
  }

  const over = overCap(cls, a.cardId, await loadUsage(d.api, d.boards, { botId: d.me.id, now }), settings.caps);
  if (over) return post(masker, { text: over, cls: 'refusal' });

  if (confirms) {
    await allowedLinks();
    // Too late to run it: the proposal stays open for another `yes`.
    if (signal.aborted) return post(masker, { text: TIMEOUT_REPLY, cls: 'refusal' });
    // The resolution is on the card before the action runs: if posting it fails, nothing runs, and a later `yes`
    // finds the proposal resolved even when the action's own reply never got posted. It carries the cap class, so
    // the result after it is posted as uncounted.
    await post(masker, { text: `Confirmed: ${confirms.spec.verbs[0]}.`, cls, resolves: confirms.actionId });
    await post(masker, { ...(await reply()), cls: 'refusal' });
    return;
  }
  await post(masker, await reply());
}

async function runHandler(ctx: CommandCtx, spec: ActionSpec, args: unknown, cls: CapClass): Promise<Reply> {
  if (ctx.signal.aborted) return { text: TIMEOUT_REPLY, cls: 'refusal' };
  try {
    const r = await HANDLERS[spec.id]!(ctx, args);
    return { ...r, cls: r.uncounted ? 'refusal' : cls };
  } catch (e) {
    if (ctx.signal.aborted) return { text: TIMEOUT_REPLY, cls };
    ctx.log(`handler ${spec.id} failed on ${ctx.action.id}: ${firstLine(e)}`);
    return { text: `Sorry, ${spec.verbs[0]} failed. The service log has details.`, cls };
  }
}
