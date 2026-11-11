import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import { checkBoardsPrivate } from '../../src/trello/private.ts';
import type { PrivacyProblem } from '../../src/trello/private.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

function boardId(rec: Recording): string {
  const call = rec.find((c) => /^\/boards\/[^/]+$/.test(c.path));
  if (!call) throw new Error('recording has no board call');
  return call.path.split('/')[2]!;
}

/** Seed FakeTrello from one or more recordings and return a client + the board ids. */
function setup(...names: ('jobs' | 'profiles' | 'system')[]) {
  const recs = names.map(load);
  const fake = FakeTrello.fromRecordings(...recs);
  const api = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const boards = recs.map((r) => boardId(r));
  return { fake, api, boards };
}

test('captured sample boards are private', async () => {
  const { api, boards } = setup('jobs', 'profiles', 'system');
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  assert.deepEqual(problems, []);
});

test('workspace-visible board is refused (org)', async () => {
  const { fake, api, boards } = setup('jobs');
  fake.setBoardPermissionLevel(boards[0]!, 'org');
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.reason, 'not private');
  assert.ok(problems[0]!.detail.includes('org'), `expected detail to contain 'org', got '${problems[0]!.detail}'`);
  assert.equal(problems[0]!.board, boards[0]);
});

test('workspace-visible board is refused (public)', async () => {
  const { fake, api, boards } = setup('jobs');
  fake.setBoardPermissionLevel(boards[0]!, 'public');
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.reason, 'not private');
  assert.ok(problems[0]!.detail.includes('public'), `expected detail to contain 'public', got '${problems[0]!.detail}'`);
});

test('extra member is refused, naming the username', async () => {
  const { fake, api, boards } = setup('jobs');
  fake.addBoardMember(boards[0]!, { id: 'fa4e000000000000000000a1', username: 'extra.user' });
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  const extraProblems = problems.filter((p): p is PrivacyProblem => p.reason === 'extra member');
  assert.equal(extraProblems.length, 1);
  assert.equal(extraProblems[0]!.detail, 'extra.user');
});

test('allowed member matches regardless of case', async () => {
  const { fake, api, boards } = setup('jobs');
  fake.addBoardMember(boards[0]!, { id: 'fa4e000000000000000000a2', username: 'Alex.Example' });
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: ['alex.example'], botUsername: 'samplebot' });
  assert.deepEqual(problems, []);
});

test('closed board is refused', async () => {
  const { fake, api, boards } = setup('jobs');
  fake.setBoardClosed(boards[0]!, true);
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  const closedProblems = problems.filter((p): p is PrivacyProblem => p.reason === 'closed');
  assert.equal(closedProblems.length, 1);
  assert.equal(closedProblems[0]!.board, boards[0]);
  assert.equal(closedProblems[0]!.detail, 'board is closed');
});

test('checkBoardsPrivate works through scopeUserBoards', async () => {
  const { fake, boards } = setup('jobs', 'profiles', 'system');
  const inner = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeUserBoards(inner, { jobs: boards[0]!, profiles: boards[1]!, system: boards[2]! });
  const problems = await checkBoardsPrivate(api, boards, { allowedMembers: [], botUsername: 'samplebot' });
  assert.deepEqual(problems, []);
});
