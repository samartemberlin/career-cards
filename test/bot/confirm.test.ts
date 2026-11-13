import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSAL_BYTES_MAX, PROPOSAL_TTL_MS, findPending, finishProposal, proposal, proposalText,
} from '../../src/bot/confirm.ts';
import { formatMarker, parseMarker } from '../../src/bot/marker.ts';
import type { Proposal, ReplyMarker } from '../../src/bot/marker.ts';
import { FEEDBACK_MAX, REPLY_MAX } from '../../src/bot/catalogue.ts';
import { buildMasker } from '../../src/privacy.ts';
import type { TComment } from '../../src/trello/api.ts';

const BOT = 'b0b0b0b0b0b0b0b0b0b0b0b0';
const USER = 'a1a1a1a1a1a1a1a1a1a1a1a1';
const ASK1 = '5f2b6c1e9d3a4b7c8e1f0a21';
const ASK2 = '5f2b6c1e9d3a4b7c8e1f0a22';
const YES = '5f2b6c1e9d3a4b7c8e1f0a23';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const HOUR = 3_600_000;

let seq = 0;
const comment = (by: string, at: Date, marker: ReplyMarker, body = 'reply'): TComment => ({
  id: `c0ffee${String(++seq).padStart(18, '0')}`, idMemberCreator: by, username: by === BOT ? 'cardbot' : 'usera',
  date: at.toISOString(), text: `${body}\n\n${formatMarker(marker)}`, cardId: 'card1', boardId: 'board1',
});
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
const proposed = (actionId: string, action: { id: string; args: unknown }, made: Date): ReplyMarker =>
  ({ actionId, cls: 'static', proposal: { action, expires: new Date(made.getTime() + PROPOSAL_TTL_MS).toISOString() } });
const RUN = { id: 'start_run', args: {} };
const opts = { botId: BOT, now: NOW };

test('a fresh start_run proposal by the bot is pending', () => {
  const r = findPending([comment(BOT, ago(1), proposed(ASK1, RUN, ago(1)))], opts);
  assert.equal(r.kind, 'pending');
  assert.ok(r.kind === 'pending');
  assert.equal(r.pending.actionId, ASK1);
  assert.equal(r.pending.spec.id, 'start_run');
  assert.deepEqual(r.pending.args, {});
});

test('a proposal written by a user (same marker) is none', () => {
  assert.deepEqual(findPending([comment(USER, ago(1), proposed(ASK1, RUN, ago(1)))], opts), { kind: 'none' });
});

test('a proposal for an auto action (show_last_run) is none', () => {
  const c = comment(BOT, ago(1), proposed(ASK1, { id: 'show_last_run', args: {} }, ago(1)));
  assert.deepEqual(findPending([c], opts), { kind: 'none' });
});

test('a proposal with args outside the closed set (company topic \'stocks\') is none', () => {
  const bad = [
    { id: 'company_research', args: { topic: 'stocks' } },
    { id: 'start_run', args: { extra: 1 } },
    { id: 'record_feedback', args: { text: '' } },
    { id: 'record_feedback', args: { text: 'x'.repeat(FEEDBACK_MAX + 1) } },
    { id: 'no_such_action', args: {} },
  ];
  for (const action of bad) {
    assert.deepEqual(findPending([comment(BOT, ago(1), proposed(ASK1, action, ago(1)))], opts), { kind: 'none' }, action.id);
  }
});

test('25 h old → expired', () => {
  assert.deepEqual(findPending([comment(BOT, ago(25), proposed(ASK1, RUN, ago(25)))], opts), { kind: 'expired' });
  assert.deepEqual(findPending([comment(BOT, ago(24), proposed(ASK1, RUN, ago(24)))], opts), { kind: 'expired' }, 'at expires');
});

test('a proposal that expires further ahead than the TTL is none', () => {
  const c = comment(BOT, ago(0), proposed(ASK1, RUN, new Date(NOW.getTime() + HOUR)));
  assert.deepEqual(findPending([c], opts), { kind: 'none' });
});

test('resolved proposals are not pending', () => {
  const comments = [
    comment(BOT, ago(2), proposed(ASK1, RUN, ago(2))),
    comment(BOT, ago(1), { actionId: YES, cls: 'static', resolves: ASK1 }),
  ];
  assert.deepEqual(findPending(comments, opts), { kind: 'none' });
  assert.deepEqual(findPending([...comments].reverse(), opts), { kind: 'none' }, 'order of the list does not matter');
});

test('a user marker cannot resolve a proposal', () => {
  const comments = [
    comment(BOT, ago(2), proposed(ASK1, RUN, ago(2))),
    comment(USER, ago(1), { actionId: YES, cls: 'static', resolves: ASK1 }),
  ];
  assert.equal(findPending(comments, opts).kind, 'pending');
});

test('two proposals: the newer unresolved one wins', () => {
  const feedback = { id: 'record_feedback', args: { text: 'too senior' } };
  const comments = [
    comment(BOT, ago(1), proposed(ASK2, feedback, ago(1))),
    comment(BOT, ago(3), proposed(ASK1, RUN, ago(3))),
  ];
  const r = findPending(comments, opts);
  assert.ok(r.kind === 'pending');
  assert.equal(r.pending.actionId, ASK2);
  assert.deepEqual(r.pending.args, feedback.args);
});

test('a newer bot reply that is not a proposal closes the proposal', () => {
  const comments = [
    comment(BOT, ago(2), proposed(ASK1, RUN, ago(2))),
    comment(BOT, ago(1), { actionId: ASK2, cls: 'model' }, 'Reply @cardbot yes to record it.'),
  ];
  assert.deepEqual(findPending(comments, opts), { kind: 'none' });
});

test('when the newer is resolved, the older is not revived', () => {
  const comments = [
    comment(BOT, ago(3), proposed(ASK1, RUN, ago(3))),
    comment(BOT, ago(2), proposed(ASK2, RUN, ago(2))),
    comment(BOT, ago(1), { actionId: YES, cls: 'static', resolves: ASK2 }),
  ];
  assert.deepEqual(findPending(comments, opts), { kind: 'none' });
});

test('a newer invalid proposal hides an older valid one', () => {
  const comments = [
    comment(BOT, ago(3), proposed(ASK1, RUN, ago(3))),
    comment(BOT, ago(2), proposed(ASK2, { id: 'show_last_run', args: {} }, ago(2))),
  ];
  assert.deepEqual(findPending(comments, opts), { kind: 'none' });
});

test('no proposal on the card is none', () => {
  assert.deepEqual(findPending([], opts), { kind: 'none' });
  assert.deepEqual(findPending([comment(BOT, ago(1), { actionId: ASK1, cls: 'model' })], opts), { kind: 'none' });
});

test('proposal sets expires one TTL ahead and checks the action', () => {
  assert.deepEqual(proposal(RUN, NOW), { action: RUN, expires: new Date(NOW.getTime() + PROPOSAL_TTL_MS).toISOString() });
  assert.throws(() => proposal({ id: 'show_last_run', args: {} }, NOW));
  assert.throws(() => proposal({ id: 'company_research', args: { topic: 'stocks' } }, NOW));
});

test('proposalText appends the yes/no line', () => {
  assert.equal(proposalText('Start a run now?', 'cardbot'),
    'Start a run now?\n\nReply `@cardbot yes` within 24 h to run it, or `@cardbot no`.');
});

const big = (unit: string) => unit.repeat(Math.ceil(FEEDBACK_MAX / unit.length)).slice(0, FEEDBACK_MAX);

test('a record_feedback proposal is capped to the marker budget and still pending', () => {
  for (const unit of ['a', 'ü', '€', '😀', '\u0001', '"\\']) {
    const text = big(unit);
    const p = proposal({ id: 'record_feedback', args: { text } }, NOW);
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= PROPOSAL_BYTES_MAX, JSON.stringify(unit));
    const kept = (p.action.args as { text: string }).text;
    assert.ok(kept.length > 0 && text.startsWith(kept), 'a prefix of the feedback, whole characters');
    assert.equal(kept.isWellFormed(), true);
    const c = comment(BOT, NOW, { actionId: ASK1, cls: 'static', proposal: p });
    const r = findPending([c], opts);
    assert.ok(r.kind === 'pending');
    assert.deepEqual(r.pending.args, { text: kept });
  }
  const ascii = proposal({ id: 'record_feedback', args: { text: big('a') } }, NOW);
  assert.equal((ascii.action.args as { text: string }).text.length, FEEDBACK_MAX, 'plain feedback of the full length fits');
});

test('a very long record_feedback proposal still yields a part 1 that ends with a parseable marker', () => {
  const masker = buildMasker(['Theo Example']);
  for (const unit of ['a ', 'ü', '😀', '\u0001', '*a.io ', '&#xFDFA;', 'x']) {
    const text = big(unit);
    const p: Proposal = proposal({ id: 'record_feedback', args: { text } }, NOW);
    const marker = { actionId: ASK1, cls: 'static' as const, proposal: p, resolves: YES };
    const botName = 'b'.repeat(100);
    const parts = finishProposal({
      text: `Record this feedback: "${(p.action.args as { text: string }).text}"`, botName,
      author: 'u'.repeat(100), marker, masker, allowedLinks: [],
    });
    assert.equal(parts.length, 1, JSON.stringify(unit));
    assert.ok(parts[0]!.length <= REPLY_MAX);
    const lines = parts[0]!.split('\n');
    assert.deepEqual(parseMarker(lines.at(-1)!), marker);
    assert.match(parts[0]!, new RegExp(`Reply \\\\\`\\\\@${botName} yes\\\\\` within 24 h`), 'the yes/no line is in part 1');
  }
});

test('finishProposal keeps a short proposal whole', () => {
  const masker = buildMasker(['Theo Example']);
  const marker = { actionId: ASK1, cls: 'static' as const, proposal: proposal(RUN, NOW) };
  const [part] = finishProposal({ text: 'Start a run now?', botName: 'cardbot', author: 'usera', marker, masker, allowedLinks: [] });
  assert.ok(part!.startsWith('@usera Start a run now?\n\nReply \\`\\@cardbot yes\\` within 24 h'));
});

test('finishProposal never posts part of a listed detail at the cut', () => {
  const masker = buildMasker(['Theo Example', '+49 30 1234567']);
  const marker = { actionId: ASK1, cls: 'static' as const, proposal: proposal({ id: 'record_feedback', args: { text: big('a') } }, NOW) };
  for (let k = 0; k < 40; k++) {
    const text = 'w'.repeat(k) + ' Theo Example +49 30 1234567x'.repeat(200);
    const [part, ...rest] = finishProposal({ text, botName: 'cardbot', author: 'usera', marker, masker, allowedLinks: [] });
    assert.equal(rest.length, 0);
    assert.doesNotMatch(part!, /Theo|Exa|\+49|\\\+49|1234/, `shift ${k}`);
  }
});

test('a proposal older than the TTL by its comment date is expired, whatever its expires says', () => {
  const c = comment(BOT, ago(25), proposed(ASK1, RUN, ago(1)));
  assert.deepEqual(findPending([c], opts), { kind: 'expired' });
});
