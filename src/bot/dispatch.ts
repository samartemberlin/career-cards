// One webhook comment in, at most one reply out. Every reply goes through finishReply with the user's masker; the
// only exception is CONFIG_BROKEN, a constant that can carry no personal detail, posted when there is no masker.
import { gate } from '../serve/gate.ts';
import type { CommentAction, GateDeps } from '../serve/gate.ts';
import type { RunStarter } from '../serve/runs.ts';
import { matchStatic } from './catalogue.ts';
import type { ActionSpec } from './catalogue.ts';
import { capClassOf, loadUsage, overCap } from './caps.ts';
import { findPending } from './confirm.ts';
import type { CapClass, ReplyClass } from './marker.ts';
import { finishReply, linksIn } from './reply.ts';
import { HANDLERS, helpText } from './handlers.ts';
import type { CommandCtx, HandlerResult, NetDeps } from './handlers.ts';
import { PrivacyError, buildMasker } from '../privacy.ts';
import type { Masker } from '../privacy.ts';
import { ConfigInvalid, readUserConfig } from '../trello/config.ts';
import { checkBoardsPrivate } from '../trello/private.ts';
import { createRunLog, secretsFromEnv } from '../run/log.ts';
import type { Env } from '../pipeline/llm.ts';
import type { UserConfig } from '../config/schema.ts';

export type DispatchDeps = GateDeps & { starter: RunStarter; net: NetDeps; env: Env };

export const COMMENT_MAX = 2000;
const CONFIG_BROKEN = "I can't answer until the config cards are fixed. The next run's status card names the problem.";
const IDENTITY: Masker = { mask: (t) => t, hasDetail: () => false };

const firstLine = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split('\n')[0];

const unavailable = (spec: ActionSpec) => `\`${spec.verbs[0]}\` isn't available yet.`;

type Reply = HandlerResult & { cls: ReplyClass; resolves?: string };

// Two webhooks for one card must not both read the same pending proposal, so each card's comments run in order.
const tails = new Map<string, Promise<void>>();

export function handleComment(d: DispatchDeps, a: CommentAction): Promise<void> {
  const run = (tails.get(a.cardId) ?? Promise.resolve()).then(() => handle(d, a));
  tails.set(a.cardId, run);
  void run.then(() => {
    if (tails.get(a.cardId) === run) tails.delete(a.cardId);
  });
  return run;
}

async function handle(d: DispatchDeps, a: CommentAction): Promise<void> {
  const log = createRunLog({ sink: d.log, secrets: secretsFromEnv(d.env), keep: 0 }).log;
  try {
    await respond({ ...d, log }, a);
  } catch (e) {
    log(`comment ${a.id} failed: ${firstLine(e)}`);
  }
}

async function respond(d: DispatchDeps, a: CommentAction): Promise<void> {
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
    for (const part of finishReply({ text: r.text, author: a.author, marker, masker, allowedLinks: links })) {
      await d.api.comment(a.cardId, part);
    }
    d.log(`reply ${a.id} on ${a.cardId}: ${r.cls}${r.resolves ? ` resolves ${r.resolves}` : ''}`);
  };

  const problems = await checkBoardsPrivate(d.api, [d.boards.jobs, d.boards.profiles, d.boards.system], {
    allowedMembers: settings.allowed_members,
    botUsername: botName,
  });
  let refusal: string | null = null;
  if (problems.length) {
    refusal = `I can't work while the boards aren't private: ${problems.map((p) => `${p.boardName}: ${p.reason} (${p.detail})`).join('; ')}`;
  } else if (a.text.length > COMMENT_MAX) {
    refusal = 'That comment is over 2,000 characters. Please shorten it.';
  }

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
    api: d.api, boards: d.boards, me: d.me, settings, action: a, now, config, starter: d.starter, net: d.net, log: d.log,
  };

  // What to do once the cap allows it; `confirms` is the proposal a `yes` resolves.
  let cls: CapClass = 'static';
  let reply: () => Promise<Reply>;
  let confirms: { actionId: string; spec: ActionSpec; args: unknown } | null = null;

  const m = matchStatic(a.text, botName);
  if (m.kind === 'bad_args') {
    reply = async () => ({ text: m.message, cls });
  } else if (m.kind === 'none') {
    reply = async () => ({ text: `I only know these commands for now:\n${helpText(botName)}`, cls });
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
  try {
    return { ...(await HANDLERS[spec.id]!(ctx, args)), cls };
  } catch (e) {
    ctx.log(`handler ${spec.id} failed on ${ctx.action.id}: ${firstLine(e)}`);
    return { text: `Sorry, ${spec.verbs[0]} failed. The service log has details.`, cls };
  }
}
