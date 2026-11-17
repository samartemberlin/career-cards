import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { seedLayout } from '../support/seed-layout.ts';
import { readProfilesBoard } from '../../src/trello/profiles-board.ts';
import { SAMPLE_PROFILES, starterProfiles } from '../../tools/sample/profiles.ts';
import { DEAL_BREAKERS, NICE_TO_HAVE, PROFILE, ABOUT_ME, LISTS, templateOf, specOf } from '../../src/config/cards.ts';
import type { TList, TCard } from '../../src/trello/api.ts';
import type { BoardLayout } from '../../tools/sample/layout.ts';

async function setup(layout: BoardLayout = SAMPLE_PROFILES): Promise<{ lists: TList[]; cards: TCard[] }> {
  const fake = new FakeTrello();
  const boardId = await seedLayout(fake, layout);
  const client = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const [lists, cards] = await Promise.all([
    client.lists(boardId, 'open'),
    client.cards(boardId, { filter: 'open' }),
  ]);
  return { lists, cards };
}

const norm = (s: string) => s.trim().toLowerCase();

// ── happy path ─────────────────────────────────────────────────────────────

test('SAMPLE_PROFILES reads with no problems', async () => {
  const { lists, cards } = await setup();
  const { board, problems } = readProfilesBoard(lists, cards);

  assert.equal(problems.length, 0, `unexpected problems: ${problems.map((p) => p.message).join(', ')}`);
  assert.ok(board !== null);
  assert.equal(board.profiles.length, 2);
  assert.equal(board.profiles.filter((p) => p.active).length, 1);
  assert.equal(board.personalDetails.length, 5);

  const whereCard = board.dealBreakers.find((c) => c.key === 'where');
  assert.ok(whereCard, 'where card missing');
  assert.equal(whereCard.text, 'Berlin, onsite or hybrid. Remote is fine anywhere in Germany or the EU, but only full-time. Not Munich.');
});

test('starter yields 12 "not filled in" problems, none for examples card', async () => {
  const { lists, cards } = await setup(starterProfiles());
  const { problems } = readProfilesBoard(lists, cards);

  assert.equal(problems.length, 12, `got ${problems.length} problems: ${problems.map((p) => p.message).join('\n')}`);
  for (const p of problems) {
    assert.ok(p.message.includes('not filled in'), `unexpected problem: ${p.message}`);
  }
  const examplesSpec = specOf('examples');
  assert.ok(!problems.some((p) => p.message.includes(examplesSpec.name)), 'examples card should not cause a problem');
});

// ── case-insensitive matching ─────────────────────────────────────────────

test('card found when its name differs only in case', async () => {
  const { lists, cards } = await setup();
  const whereCard = cards.find((c) => norm(c.name) === norm(DEAL_BREAKERS[0]!.name));
  assert.ok(whereCard);
  whereCard.name = whereCard.name.toUpperCase();
  const { board, problems } = readProfilesBoard(lists, cards);
  assert.equal(problems.length, 0, problems.map((p) => p.message).join(', '));
  assert.ok(board !== null);
  assert.ok(board.dealBreakers.length > 0);
});

test('unknown card name in a list is ignored', async () => {
  const { lists, cards } = await setup();
  const firstList = lists[0]!;
  cards.push({
    id: 'fake000000000000000000a1',
    name: 'This card name is not in the spec',
    desc: 'some content',
    idList: firstList.id,
    idBoard: 'fake-board',
    closed: false,
    pos: 999999,
    shortUrl: 'https://trello.com/c/unknown01',
  });
  const { board, problems } = readProfilesBoard(lists, cards);
  assert.equal(problems.length, 0, problems.map((p) => p.message).join(', '));
  assert.ok(board !== null);
});

test('closed profile list is ignored', async () => {
  const { lists, cards } = await setup();
  const profileList = lists.find((l) => norm(l.name) === 'content editor');
  assert.ok(profileList);
  profileList.closed = true;
  const { board, problems } = readProfilesBoard(lists, cards);
  // Only Copywriter (inactive) remains; "at least one profile must be active" fires
  assert.ok(problems.some((p) => p.message === 'at least one profile must be active'));
  assert.ok(board === null);
});

test('inactive profile with missing cards produces no problems', async () => {
  const { lists, cards } = await setup();
  // Keep only the Active card for the Copywriter (inactive) profile
  const copywriterList = lists.find((l) => norm(l.name) === 'copywriter');
  assert.ok(copywriterList);
  const copywriterCards = cards.filter((c) => c.idList === copywriterList.id);
  for (const card of copywriterCards) {
    if (norm(card.name) !== 'active') {
      cards.splice(cards.indexOf(card), 1);
    }
  }
  const { board, problems } = readProfilesBoard(lists, cards);
  assert.equal(problems.length, 0, problems.map((p) => p.message).join(', '));
  assert.ok(board !== null);
  const copywriter = board.profiles.find((p) => norm(p.name) === 'copywriter');
  assert.ok(copywriter);
  assert.equal(copywriter.active, false);
  assert.equal(copywriter.cards.length, 0);
});

// ── per-problem mutations ─────────────────────────────────────────────────

test('no "<list>" column', async () => {
  const { lists, cards } = await setup();
  const filtered = lists.filter((l) => norm(l.name) !== norm(LISTS.dealBreakers));
  const { problems } = readProfilesBoard(filtered, cards);
  assert.ok(problems.some((p) => p.message === `no "${LISTS.dealBreakers}" column`), JSON.stringify(problems));
});

test('missing required card in a column', async () => {
  const { lists, cards } = await setup();
  const whereSpec = DEAL_BREAKERS[0]!;
  const idx = cards.findIndex((c) => norm(c.name) === norm(whereSpec.name));
  assert.ok(idx >= 0);
  cards.splice(idx, 1);
  const { problems } = readProfilesBoard(lists, cards);
  const dbList = lists.find((l) => norm(l.name) === norm(LISTS.dealBreakers))!;
  assert.ok(problems.some((p) =>
    p.message === `missing the "${whereSpec.name}" card in column "${dbList.name.trim()}"`,
  ), JSON.stringify(problems));
});

test('duplicate cards in a column', async () => {
  const { lists, cards } = await setup();
  const whereSpec = DEAL_BREAKERS[0]!;
  const original = cards.find((c) => norm(c.name) === norm(whereSpec.name))!;
  cards.push({
    ...original,
    id: 'fake000000000000000000a2',
    shortUrl: 'https://trello.com/c/dupe0001',
    pos: original.pos + 1,
  });
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message.startsWith(`2 cards titled "${whereSpec.name}" in column`)),
    JSON.stringify(problems),
  );
  assert.ok(problems.some((p) => p.message.includes(original.shortUrl)));
});

test('required card is not filled in', async () => {
  const { lists, cards } = await setup();
  const whereSpec = DEAL_BREAKERS[0]!;
  const card = cards.find((c) => norm(c.name) === norm(whereSpec.name))!;
  card.desc = templateOf(whereSpec);
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message === `the "${whereSpec.name}" card is not filled in (it still holds only its questions)`),
    JSON.stringify(problems),
  );
});

test('Active card must start with yes or no', async () => {
  const { lists, cards } = await setup();
  const activeSpec = PROFILE.find((s) => s.key === 'active')!;
  const activeCard = cards.find((c) => norm(c.name) === 'active' &&
    lists.find((l) => l.id === c.idList && norm(l.name) === 'content editor'));
  assert.ok(activeCard);
  activeCard.desc = 'maybe';
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message === `the "${activeSpec.name}" card must start with yes or no`),
    JSON.stringify(problems),
  );
});

test('two open columns with same name', async () => {
  const { lists, cards } = await setup();
  const contentEditorList = lists.find((l) => norm(l.name) === 'content editor')!;
  lists.push({
    id: 'fake000000000000000000b1',
    name: 'Content editor',
    closed: false,
    pos: contentEditorList.pos + 1,
    idBoard: contentEditorList.idBoard,
  });
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message === `two open columns named "Content editor", rename or archive one`),
    JSON.stringify(problems),
  );
});

test('no profile column found', async () => {
  const { lists, cards } = await setup();
  const fixedNames = new Set([norm(LISTS.dealBreakers), norm(LISTS.niceToHave), norm(LISTS.aboutMe), 'originals']);
  const profileListIds = new Set(
    lists.filter((l) => !fixedNames.has(norm(l.name))).map((l) => l.id),
  );
  const filteredLists = lists.filter((l) => !profileListIds.has(l.id));
  const filteredCards = cards.filter((c) => !profileListIds.has(c.idList));
  const { problems } = readProfilesBoard(filteredLists, filteredCards);
  assert.ok(
    problems.some((p) => p.message === 'no profile column found'),
    JSON.stringify(problems),
  );
});

test('at least one profile must be active', async () => {
  const { lists, cards } = await setup();
  for (const card of cards) {
    if (norm(card.name) === 'active') card.desc = 'no';
  }
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message === 'at least one profile must be active'),
    JSON.stringify(problems),
  );
});

test('Personal details: list at least one item, one per line', async () => {
  const { lists, cards } = await setup();
  const detailsSpec = ABOUT_ME.find((s) => s.key === 'details')!;
  const detailsCard = cards.find((c) => norm(c.name) === norm(detailsSpec.name))!;
  // Template question + a bare bullet "- " with no content.
  // answerOf strips the question and trims "- " to "-" (non-empty → no "not filled in").
  // personalDetailsOf sees "- " with its trailing space intact → strips prefix → "" → blank → drops.
  detailsCard.desc = `${templateOf(detailsSpec)}\n- `;
  const { problems } = readProfilesBoard(lists, cards);
  assert.ok(
    problems.some((p) => p.message === 'Personal details: list at least one item, one per line'),
    JSON.stringify(problems),
  );
});

// ── about me: CV ──────────────────────────────────────────────────────────

test('ProfilesBoard.cv is the user text without the template question', async () => {
  const { lists, cards } = await setup();
  const cvSpec = specOf('cv');
  const cvCard = cards.find((c) => norm(c.name) === norm(cvSpec.name))!;
  cvCard.desc = `${templateOf(cvSpec)}\nEditor, 5 years at a magazine.`;
  const { board, problems } = readProfilesBoard(lists, cards);
  assert.equal(problems.length, 0);
  assert.ok(board !== null);
  assert.equal(board.cv, 'Editor, 5 years at a magazine.');
});

test('a CV card that says only "none" is a problem', async () => {
  const { lists, cards } = await setup();
  const cvSpec = specOf('cv');
  const cvCard = cards.find((c) => norm(c.name) === norm(cvSpec.name))!;
  cvCard.desc = `${templateOf(cvSpec)}\nNone.`;
  const { board, problems } = readProfilesBoard(lists, cards);
  assert.equal(board, null);
  assert.deepEqual(problems.map((p) => p.message), ['the CV card must hold your CV']);
});

test('the CV question asks for the CV text, with no "none" hint', () => {
  const q = specOf('cv').questions.join('\n');
  assert.match(q, /CV/);
  assert.doesNotMatch(q, /none|shared/i);
});
