import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTrelloClient } from '../../../src/trello/client.ts';
import { scopeUserBoards } from '../../../src/trello/scoped.ts';
import type { UserBoards } from '../../../src/trello/scoped.ts';
import type { TMember } from '../../../src/trello/api.ts';
import { jobCardDesc } from '../../../src/trello/cards.ts';
import { createRecentIds, parseWebhook } from '../../../src/serve/gate.ts';
import { handleComment } from '../../../src/bot/dispatch.ts';
import type { DispatchDeps } from '../../../src/bot/dispatch.ts';
import { HANDLERS } from '../../../src/bot/handlers.ts';
import { botNet } from '../../../src/bot/net.ts';
import { formatMarker, parseMarker } from '../../../src/bot/marker.ts';
import { loadUsage } from '../../../src/bot/caps.ts';
import { CATALOGUE } from '../../../src/bot/catalogue.ts';
import { JOB_ONLY_REPLY } from '../../../src/bot/stages/call.ts';
import { RESEARCH_UNAVAILABLE } from '../../../src/bot/stages/researcher.ts';
import { companyResearch, findOpenings, renderOpenings } from '../../../src/bot/stages/company.ts';
import { jobKey } from '../../../src/pipeline/keys.ts';
import type { RunTrigger } from '../../../src/run/stats.ts';
import { FakeTrello } from '../../support/fake-trello.ts';
import { commentWebhook } from '../../support/webhook.ts';
import { fakeModel } from '../../support/fake-model.ts';
import { withWeb } from '../../support/fake-research.ts';
import type { WebAnswer } from '../../support/fake-research.ts';
import type { Recording } from '../../../tools/sample/scrub.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const FAKE = join(FIX, 'career-ops-fake');
const load = (name: string): Recording => JSON.parse(readFileSync(join(FIX, 'trello', `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const JOB_CARD = 'fa4e00000000000000000012';
const SETTINGS_CARD = 'fa4e00000000000000000476';
const CV_CARD = 'fa4e00000000000000000441';
const USER_A: TMember = { id: 'fa4e0000000000000000a001', username: 'usera' };
const NOW = new Date('2026-11-12T12:00:00.000Z');
const POSTING = 'https://boards.greenhouse.io/acme-robotics/jobs/1005';

const ABOUT = 'https://acme.example/about';
const NEWS = 'https://news.example/acme';
const WEB: WebAnswer = {
  searches: ['Acme Robotics'],
  fetches: [{ url: ABOUT, ok: true }, { url: NEWS, ok: true }],
  answer: { summary: 'Acme Robotics builds warehouse robots.', points: [
    { section: 'What they do', text: 'Warehouse robots.', source: ABOUT },
    { section: 'News', text: 'Opened a Berlin office.', source: NEWS },
  ] },
};

let nextId = 0xe000;
const newId = () => `fa4e${(nextId++).toString(16).padStart(20, '0')}`;

type Opts = { company?: string; router?: unknown; providers?: string; openings?: boolean };

async function setup(o: Opts = {}) {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  fake.setNow(NOW);
  fake.setCardDesc(SETTINGS_CARD, `\`\`\`yaml\nproviders: [${o.providers ?? 'claude'}]\nlocations: [berlin]\nallowed_members: [usera]\n\`\`\``);
  fake.setCardDesc(JOB_CARD, jobCardDesc({
    key: jobKey(POSTING), company: o.company ?? 'Acme Robotics', title: 'Robotics Engineer', url: POSTING, location: 'Berlin',
    posted: '2026-11-05', deadline: '', jd: 'Build robots.', source: 'greenhouse-api', reason: 'Robotics role.',
  }).desc);
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const api = scopeUserBoards(raw, BOARDS);
  const home = mkdtempSync(join(tmpdir(), 'company-test-home-'));
  const logs: string[] = [];
  const m = withWeb(
    fakeModel(({ stage }) => {
      if (stage === 'router') return JSON.stringify({ reply: 'ROUTER-REPLY', action: o.router ?? null });
      throw new Error(`unexpected stage ${stage}`);
    }),
    () => WEB,
  );
  const deps: DispatchDeps = {
    api, boards: BOARDS, me: await api.me(), seen: createRecentIds(), now: () => NOW, log: (s) => logs.push(s),
    starter: { isRunning: async () => false, start: async (_t: RunTrigger) => {} },
    net: {
      fetchJd: async () => null,
      checkOpen: async () => ({ verdict: 'unknown', reason: 'test' }),
      urlGuard: { lookup: async () => [{ address: '203.0.113.7', family: 4 }] },
      ...(o.openings === false ? {} : {
        openings: (company: string, exclude: string) =>
          findOpenings(company, { careerOpsDir: FAKE, env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', SECRET: 'nope' }, exclude }),
      }),
    },
    env: { PATH: '/usr/bin', HOME: '/home/app', CLAUDE_CODE_OAUTH_TOKEN: 'tok-claude-0000', GEMINI_API_KEY: 'gem-0000', LLM_RPM: '0', CLAUDE_RPM: '0' },
    call: m.call,
  };
  const record = () => {
    const f = join(home, 'discover-record.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as { argv: string[]; env: string[]; portals: string; input: unknown } : null;
  };
  return { fake, api, deps, logs, m, record, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
type S = Awaited<ReturnType<typeof setup>>;

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const body = (c: string) => unescape(c.split('\n').filter((l) => !l.startsWith('career-cards-reply:')).join('\n').trim());

async function say(s: S, text: string, o: { cardId?: string; boardId?: string; listName?: string } = {}) {
  const cardId = o.cardId ?? JOB_CARD;
  const before = s.fake.commentsOn(cardId).length;
  const a = parseWebhook(commentWebhook({
    cardId, boardId: o.boardId ?? BOARDS.jobs, listName: o.listName ?? 'Nov 9 · 01:00', author: USER_A, text,
    date: new Date(NOW.getTime() - 60_000).toISOString(), id: newId(),
  }));
  assert.ok(a);
  await handleComment(s.deps, a);
  return s.fake.commentsOn(cardId).slice(before);
}

const usage = (s: S) => loadUsage(s.api, BOARDS, { botId: s.deps.me.id, now: NOW });
const seed = (s: S, cls: 'research' | 'model', n: number) => {
  for (let i = 0; i < n; i++) {
    s.fake.addComment(CV_CARD, s.deps.me, `ok\n\n${formatMarker({ actionId: newId(), cls })}`, new Date(NOW.getTime() - 3_600_000));
  }
};

test('company about: the researcher runs with topic about, and the reply ends with the unverified footer listing opened sources', async () => {
  const s = await setup();
  try {
    const posted = await say(s, '@samplebot company');
    assert.deepEqual(s.m.calls.map((c) => c.stage), ['researcher/about']);
    assert.equal(posted.length, 1);
    // The footer is the reply's last line; the Links list after it is finishReply's.
    assert.match(body(posted[0]!), /\n\nfrom the web, unverified, sources: \[link 1\], \[link 2\]\n\nLinks:\n/);
    assert.match(posted[0]!, /\nLinks:\nlink 1: <https:\/\/acme\.example\/about>\nlink 2: <https:\/\/news\.example\/acme>/);
    assert.equal(parseMarker(posted[0]!)!.cls, 'research');
    assert.equal(s.record(), null, 'no openings lookup for topic about');
  } finally { s.cleanup(); }
});

test('company openings resolves in code and calls no model', async () => {
  const s = await setup();
  try {
    const posted = await say(s, '@samplebot company openings');
    assert.equal(s.m.calls.length, 0);
    assert.equal(posted.length, 1);
    const text = posted[0]!;
    assert.match(body(text), /^@usera Open roles at Acme Robotics \(from its careers board, read just now\):\n- Role 12: \[link 1\]\n- Role 11 · Berlin: \[link 2\]/);
    assert.ok(!/Role 5\b/.test(text), 'this card\'s own job is left out');
    assert.ok(!text.includes('[link removed]'));
    assert.ok((text.match(/^link \d+: /gm) ?? []).length <= 10);
    // 11 other jobs: 9 shown, then the careers board.
    assert.match(body(text), /\n\.\.\.and 2 more: \[link 10\]/);
    assert.match(text, /^link 10: <https:\/\/job-boards\.greenhouse\.io\/acme-robotics>$/m);
    assert.equal(parseMarker(text)!.cls, 'research');
  } finally { s.cleanup(); }
});

test('company openings falls back to the researcher when discovery resolves nothing', async () => {
  const s = await setup({ company: 'Nobody Ltd' });
  try {
    const posted = await say(s, '@samplebot company openings');
    assert.deepEqual(s.m.calls.map((c) => c.stage), ['researcher/openings']);
    assert.ok(body(posted[0]!).includes('from the web, unverified, sources:'));
    assert.deepEqual((s.record()!.input as { companies: unknown[] }).companies, [{ name: 'Nobody Ltd' }]);
  } finally { s.cleanup(); }
});

test('discover-ats failing falls back to the researcher', async () => {
  const s = await setup({ company: 'Broken Board' });
  try {
    const posted = await say(s, '@samplebot company openings');
    assert.deepEqual(s.m.calls.map((c) => c.stage), ['researcher/openings']);
    assert.ok(body(posted[0]!).includes('from the web, unverified, sources:'));
    assert.ok(s.logs.some((l) => /openings failed/.test(l)), s.logs.join('\n'));
  } finally { s.cleanup(); }
});

test('discover-ats gets the company only through --in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'company-test-home-'));
  try {
    const company = '--write\n"; rm -rf ~';
    const r = await findOpenings(company, {
      careerOpsDir: FAKE, exclude: '',
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TRELLO_TOKEN: 'trello-0000', CLAUDE_CODE_OAUTH_TOKEN: 'tok-0000' },
    });
    assert.equal(r, null);
    const rec = JSON.parse(readFileSync(join(home, 'discover-record.json'), 'utf8')) as { argv: string[]; env: string[]; portals: string; input: { companies: { name: string }[] } };
    assert.equal(rec.argv[0], 'discover-ats.mjs');
    const inPath = rec.argv[2]!;
    assert.deepEqual(rec.argv.slice(1), ['--in', inPath]);
    assert.deepEqual(rec.input, { companies: [{ name: company }] });
    assert.match(rec.portals, /tracked_companies: \[\]/);
    for (const k of rec.env) assert.ok(['PATH', 'HOME', 'LANG', 'CAREER_OPS_PORTALS'].includes(k), `unexpected env ${k}`);
    assert.ok(rec.env.includes('CAREER_OPS_PORTALS'));
    assert.ok(!existsSync(inPath) && !existsSync(dirname(inPath)), 'the temp dir is removed');
    assert.ok(dirname(inPath).startsWith(tmpdir()));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('findOpenings: drops the excluded key, keeps at most 25, newest first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'company-test-home-'));
  try {
    const r = await findOpenings('Acme Robotics', { careerOpsDir: FAKE, exclude: jobKey(POSTING), env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(r!.careersUrl, 'https://job-boards.greenhouse.io/acme-robotics');
    assert.deepEqual(r!.jobs.map((j) => j.title), [12, 11, 10, 9, 8, 7, 6, 4, 3, 2, 1].map((d) => `Role ${d}`));
    assert.deepEqual(r!.jobs[0], { title: 'Role 12', url: 'https://boards.greenhouse.io/acme-robotics/jobs/1012', location: '' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('renderOpenings: plain lines; a job whose link would not survive the reply is shown without it', () => {
  const text = renderOpenings('Acme', { careersUrl: 'https://jobs.acme.example/', jobs: [
    { title: 'Editor\n**now**', url: 'https://jobs.acme.example/1', location: 'Berlin' },
    { title: 'Writer', url: 'https://jobs.acme.example/wiki_(x)', location: '' },
  ] });
  assert.equal(text, 'Open roles at Acme (from its careers board, read just now):\n- Editor **now** · Berlin: https://jobs.acme.example/1\n- Writer');
  assert.match(renderOpenings('Acme', { careersUrl: 'https://jobs.acme.example/', jobs: [] }), /^No other open roles at Acme on its careers board right now: https:\/\/jobs\.acme\.example\/$/);
});

test('the research cap reached → its refusal line and no researcher call', async () => {
  const s = await setup();
  try {
    seed(s, 'research', 10);
    const posted = await say(s, '@samplebot company news');
    assert.equal(s.m.calls.length, 0);
    assert.match(body(posted[0]!), /^@usera Daily limit reached: 10 research requests a day/);
    assert.equal(parseMarker(posted[0]!)!.cls, 'refusal');
  } finally { s.cleanup(); }
});

test('no claude provider → RESEARCH_UNAVAILABLE and no cap taken', async () => {
  const s = await setup({ providers: 'gemini' });
  try {
    const before = (await usage(s)).research;
    const posted = await say(s, '@samplebot company news');
    assert.equal(s.m.calls.length, 0);
    assert.deepEqual(posted.map(body), [`@usera ${RESEARCH_UNAVAILABLE}`]);
    assert.equal((await usage(s)).research, before);
  } finally { s.cleanup(); }
});

test('company on a Profiles CV card → JOB_ONLY_REPLY, no cap, no child process', async () => {
  const s = await setup();
  try {
    const posted = await say(s, '@samplebot company openings', { cardId: CV_CARD, boardId: BOARDS.profiles, listName: 'Shared' });
    assert.deepEqual(posted.map(body), [`@usera ${JOB_ONLY_REPLY('company')}`]);
    assert.equal(parseMarker(posted[0]!)!.cls, 'refusal');
    assert.equal(s.m.calls.length, 0);
    assert.equal(s.record(), null);
  } finally { s.cleanup(); }
});

test('router-picked company_research with topic reputation runs this handler once', async () => {
  const s = await setup({ router: { id: 'company_research', args: { topic: 'reputation' } } });
  try {
    const posted = await say(s, '@samplebot what do people say about working there?');
    assert.deepEqual(s.m.calls.map((c) => c.stage), ['router', 'researcher/reputation']);
    assert.equal(posted.length, 1);
    assert.ok(body(posted[0]!).includes('from the web, unverified, sources: [link 1], [link 2]'));
  } finally { s.cleanup(); }
});

test('a router-picked company counts once as research', async () => {
  const s = await setup({ router: { id: 'company_research', args: { topic: 'news' } } });
  try {
    const before = await usage(s);
    const posted = await say(s, '@samplebot any news about them?');
    assert.equal(posted.length, 1);
    assert.equal(parseMarker(posted[0]!)!.cls, 'research');
    const after = await usage(s);
    assert.equal(after.model, before.model);
    assert.equal(after.research, before.research + 1);
  } finally { s.cleanup(); }
});

test('a router-picked company over the research cap → the cap line, no researcher call', async () => {
  const s = await setup({ router: { id: 'company_research', args: { topic: 'news' } } });
  try {
    seed(s, 'research', 10);
    const posted = await say(s, '@samplebot any news about them?');
    assert.deepEqual(s.m.calls.map((c) => c.stage), ['router']);
    assert.match(body(posted[0]!), /^@usera Daily limit reached: 10 research requests a day/);
    assert.equal(parseMarker(posted[0]!)!.cls, 'model');
  } finally { s.cleanup(); }
});

test('a router-picked company that is uncounted (no provider) still counts the router call as model', async () => {
  const s = await setup({ providers: 'gemini', router: { id: 'company_research', args: { topic: 'news' } } });
  try {
    const posted = await say(s, '@samplebot any news about them?');
    assert.deepEqual(s.m.calls.map((c) => [c.stage, c.via]), [['router', 'http']]);
    assert.deepEqual(posted.map(body), [`@usera ${RESEARCH_UNAVAILABLE}`]);
    assert.equal(parseMarker(posted[0]!)!.cls, 'model');
  } finally { s.cleanup(); }
});

test('an unknown topic from text replies the usage', async () => {
  const s = await setup();
  try {
    const posted = await say(s, '@samplebot company salary');
    const spec = CATALOGUE.find((x) => x.id === 'company_research')!;
    assert.deepEqual(posted.map(body), [`@usera Use: ${spec.usage}`]);
    assert.equal(s.m.calls.length, 0);
  } finally { s.cleanup(); }
});

test('company_research is registered, and botNet wires openings', () => {
  assert.equal(HANDLERS.company_research, companyResearch);
  assert.equal(typeof botNet({ env: {} }).openings, 'function');
});
