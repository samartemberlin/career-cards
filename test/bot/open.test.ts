import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../src/trello/client.ts';
import { scopeUserBoards } from '../../src/trello/scoped.ts';
import type { UserBoards } from '../../src/trello/scoped.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import type { CommandCtx } from '../../src/bot/handlers.ts';
import { apiLiveness, checkOpen, handleOpen } from '../../src/bot/open.ts';
import type { SafeResponse } from '../../src/net/safe-fetch.ts';

const FIXTURE = new URL('../fixtures/liveness-fake/api.mjs', import.meta.url).pathname;
const JOBS_BOARD = 'fa4e00000000000000000005';
const BOARDS: UserBoards = {
  jobs: JOBS_BOARD,
  profiles: 'fa4e0000000000000000000c',
  system: 'fa4e0000000000000000000d',
};
const ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

// --- apiLiveness ---

test('apiLiveness: passes careerOpsEnv only (no TRELLO_TOKEN)', async () => {
  const result = await apiLiveness('https://8.8.8.8/env', {
    env: { ...ENV, TRELLO_TOKEN: 'secret', TRELLO_KEY: 'key' },
    script: FIXTURE,
  });
  assert.ok(result !== null, 'should return a result');
  assert.ok(!result!.reason.split(',').includes('TRELLO_TOKEN'), 'TRELLO_TOKEN must not reach the child');
  assert.ok(!result!.reason.split(',').includes('TRELLO_KEY'), 'TRELLO_KEY must not reach the child');
  assert.ok(result!.reason.split(',').includes('PATH'), 'PATH should be in env');
});

test('apiLiveness: bad JSON → null', async () => {
  const result = await apiLiveness('https://8.8.8.8/badjson', { env: ENV, script: FIXTURE });
  assert.equal(result, null);
});

test('apiLiveness: exit 1 → null', async () => {
  const result = await apiLiveness('https://8.8.8.8/exit1', { env: ENV, script: FIXTURE });
  assert.equal(result, null);
});

// --- checkOpen ---

const noFetch = (): Promise<SafeResponse> => { throw new Error('safeFetch must not be called'); };
const noApi = async (): Promise<null> => null;

test('checkOpen: api active → open, without fetching the page', async () => {
  const result = await checkOpen('https://8.8.8.8/active', {
    env: ENV,
    api: async () => ({ result: 'active', code: 'test_active', reason: 'ATS says live' }),
    fetch: noFetch,
  });
  assert.equal(result.verdict, 'open');
  assert.equal(result.reason, 'ATS says live');
});

test('checkOpen: api null, page 404 → closed (http_gone)', async () => {
  const result = await checkOpen('https://8.8.8.8/jobs/1', {
    env: ENV,
    api: noApi,
    fetch: async () => ({ ok: false, status: 404, url: 'https://8.8.8.8/jobs/1', text: 'Not Found' }),
  });
  assert.equal(result.verdict, 'closed');
  assert.match(result.reason, /HTTP 404/);
});

test('checkOpen: api null, page 200 with an apply button → open', async () => {
  const result = await checkOpen('https://8.8.8.8/jobs/2', {
    env: ENV,
    api: noApi,
    fetch: async () => ({
      ok: true,
      status: 200,
      url: 'https://8.8.8.8/jobs/2',
      text: '<html><body><h1>Engineer</h1>' +
        '<p>Join us.</p>'.repeat(20) +
        '<a class="apply-btn">Apply now</a></body></html>',
    }),
  });
  assert.equal(result.verdict, 'open');
});

test('checkOpen: api null, page 403 bot wall → unknown, never closed', async () => {
  const result = await checkOpen('https://8.8.8.8/jobs/3', {
    env: ENV,
    api: noApi,
    fetch: async () => ({ ok: false, status: 403, url: 'https://8.8.8.8/jobs/3', text: 'Forbidden' }),
  });
  assert.equal(result.verdict, 'unknown');
  assert.notEqual(result.verdict, 'closed');
});

test('checkOpen: api null, SPA page (insufficient_content) → unknown, not closed', async () => {
  // Pages that need JS render near-empty HTML. classifyLiveness returns
  // expired/insufficient_content — but that is ambiguous, not a real expiry signal.
  const result = await checkOpen('https://8.8.8.8/jobs/4', {
    env: ENV,
    api: noApi,
    fetch: async () => ({ ok: true, status: 200, url: 'https://8.8.8.8/jobs/4', text: '<html><body></body></html>' }),
  });
  assert.equal(result.verdict, 'unknown');
  assert.notEqual(result.verdict, 'closed');
});

test('checkOpen: blocked address → unknown, neither api nor fetch called', async () => {
  let apiCalled = false;
  let fetchCalled = false;
  const result = await checkOpen('http://10.0.0.5/jobs/1', {
    env: ENV,
    api: async () => { apiCalled = true; return null; },
    fetch: async () => { fetchCalled = true; return { ok: false, status: 0, url: '', text: '' }; },
  });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /isn't public/);
  assert.equal(apiCalled, false, 'api must not be called for private address');
  assert.equal(fetchCalled, false, 'fetch must not be called for private address');
});

// --- check_open handler (handleOpen) ---

function setupCtx(cardDesc: string, cardName: string, checkOpenFn?: (url: string) => Promise<{ verdict: 'open' | 'closed' | 'unknown'; reason: string }>) {
  const fake = new FakeTrello();
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const ctx = {
    api: scopeUserBoards(raw, BOARDS),
    boards: BOARDS,
    me: { id: 'bot1', username: 'samplebot' },
    settings: {
      timezone: 'UTC', providers: ['gemini'], scoring_cap: 150, locations: [],
      linkedin_locations: [], linkedin: false, allowed_members: [],
      caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
    },
    action: { id: 'act1', idMemberCreator: 'u1', text: '', cardId: 'placeholder', boardId: JOBS_BOARD, date: new Date().toISOString() },
    now: new Date('2026-11-12T12:00:00Z'),
    config: async () => ({ settings: {} } as never),
    starter: { isRunning: async () => false, start: async () => {} },
    net: {
      fetchJd: async () => null,
      checkOpen: checkOpenFn ?? (async () => ({ verdict: 'open' as const, reason: 'live' })),
    },
    log: () => {},
  } as unknown as CommandCtx;
  return { fake, raw, ctx };
}

test('open on a non-job card (no key) → the job-card hint', async () => {
  const { fake, raw, ctx } = setupCtx('No key here', 'Some card');
  const list = await raw.createList(JOBS_BOARD, 'Nov 12 · 01:00', 'bottom');
  const card = await raw.createCard({ idList: list.id, name: 'Some card', desc: 'No key here', pos: 'bottom' });
  (ctx.action as { cardId: string }).cardId = card.id;
  const result = await handleOpen(ctx, {});
  assert.ok(result.text.includes('`open` works on a job card'), `unexpected: ${result.text}`);
});

test('open on a non-job card (key but no link) → the job-card hint', async () => {
  const { fake, raw, ctx } = setupCtx('Some text.\n\n---\ncareer-cards-key: test:co:1', 'Co — Role');
  const list = await raw.createList(JOBS_BOARD, 'Nov 12 · 01:00', 'bottom');
  const card = await raw.createCard({
    idList: list.id,
    name: 'Co — Role',
    desc: 'Some text.\n\n---\ncareer-cards-key: test:co:1',
    pos: 'bottom',
  });
  (ctx.action as { cardId: string }).cardId = card.id;
  const result = await handleOpen(ctx, {});
  assert.ok(result.text.includes('`open` works on a job card'), `unexpected: ${result.text}`);
});
