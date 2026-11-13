import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient } from '../../../src/trello/client.ts';
import { scopeUserBoards } from '../../../src/trello/scoped.ts';
import type { UserBoards } from '../../../src/trello/scoped.ts';
import { jobCardDesc } from '../../../src/trello/cards.ts';
import type { CommandCtx } from '../../../src/bot/handlers.ts';
import { HANDLERS } from '../../../src/bot/handlers.ts';
import type { UserConfig } from '../../../src/config/schema.ts';
import { parseJobCard } from '../../../src/bot/context.ts';
import { advisorMessages } from '../../../src/bot/prompt.ts';
import { buildBotMasking } from '../../../src/privacy.ts';
import type { BotMasking } from '../../../src/privacy.ts';
import { CvSchema, FitSchema, cvTips, explainFit, renderCv, renderFit } from '../../../src/bot/stages/advisor.ts';
import { JOB_ONLY_REPLY } from '../../../src/bot/stages/call.ts';
import { fakeModel } from '../../support/fake-model.ts';
import { FakeTrello } from '../../support/fake-trello.ts';

const BOARDS: UserBoards = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const NOW = new Date('2026-11-12T12:00:00Z');

const cfg: UserConfig = {
  settings: {
    timezone: 'Europe/Berlin', providers: ['claude'], scoring_cap: 150, locations: ['berlin'],
    linkedin_locations: [], linkedin: false, allowed_members: [],
    caps: { model_per_day: 30, model_per_card_per_day: 8, research_per_day: 10, static_per_day: 100 },
  },
  profiles: [{
    name: 'Default', active: true, rubric: 'Wants editing work. Ask Jane Roe at https://rubric.example/x. RUBRIC-SENTINEL-4e2',
    searchKeywords: [],
    filters: { includeTitles: [], excludeTitles: [], excludeCompanies: [], excludeText: [], excludeLocations: [] },
  }],
  sharedCv: 'Jane Roe, editor. jane@roe.example, +49 30 1234567. CV-SENTINEL-4e2', personalDetails: ['Jane Roe'],
  preferences: undefined,
  sources: { add: [], drop: [] },
};

const JD = 'We are looking for an Editor to run the newsletter.\nReferred by Jane Roe.\nApply at jobs@acme.example.';
const FIT_OK = JSON.stringify({
  summary: 'A close match on editing.',
  strengths: ["The posting asks to 'run the newsletter'; the CV shows editing."],
  gaps: ['No newsletter tool named in the CV.'],
  dealbreakers: [],
});
const CV_OK = JSON.stringify({
  lead_with: ['Editing experience'],
  mirror_terms: ['newsletter', 'editorial calendar'],
  gaps_to_address: [],
  notes: 'Keep it to one page.',
});

function jobDesc(o: { jd?: string; reason?: string } = {}) {
  return jobCardDesc({
    key: 'sample:acme:editor', company: 'Acme', title: 'Editor', url: 'https://jobs.acme.example/1', location: 'Berlin',
    posted: '2026-11-02', deadline: '', jd: o.jd ?? JD, source: 'sample', reason: o.reason ?? 'Strong editing match.',
  }).desc;
}

async function setup(o: { board?: 'jobs' | 'profiles'; reply?: string; name?: string } = {}) {
  const fake = new FakeTrello();
  const raw = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const boardId = o.board === 'profiles' ? BOARDS.profiles : BOARDS.jobs;
  const list = await raw.createList(boardId, o.board === 'profiles' ? 'Profiles' : 'Nov 12 · 01:00', 'bottom');
  const c = await raw.createCard({
    idList: list.id, name: o.name ?? '7 · Acme — Editor',
    desc: o.board === 'profiles' ? 'Rubric for Jane Roe' : jobDesc(),
    pos: 'bottom',
  });
  const m = fakeModel(({ stage }) => o.reply ?? (stage === 'advisor/fit' ? FIT_OK : CV_OK));
  const logs: string[] = [];
  const ctx = {
    api: scopeUserBoards(raw, BOARDS), boards: BOARDS, me: { id: 'bot1', username: 'samplebot' }, settings: cfg.settings,
    action: { id: 'act1', authorId: 'u1', author: 'usera', text: '@samplebot fit', cardId: c.id, boardId, date: NOW },
    now: NOW, config: async () => cfg,
    starter: { isRunning: async () => false, start: async () => {} },
    net: { fetchJd: async () => null, checkOpen: async () => ({ verdict: 'unknown' as const, reason: 'test' }) },
    log: (s: string) => logs.push(s),
    env: { PATH: '/usr/bin', HOME: '/home/app', CLAUDE_CODE_OAUTH_TOKEN: 'tok-claude-0000', LLM_RPM: '0' },
    call: m.call, signal: new AbortController().signal, comments: [],
  } as unknown as CommandCtx;
  return { ctx, m, logs };
}

test('the advisor prompt holds the masked CV and rubric, never the raw details', async () => {
  for (const [handler, stage] of [[explainFit, 'advisor/fit'], [cvTips, 'advisor/cv']] as const) {
    const s = await setup();
    await handler(s.ctx, {});
    assert.equal(s.m.calls.length, 1);
    const c = s.m.calls[0]!;
    assert.equal(c.stage, stage);
    for (const text of [c.system, c.user, JSON.stringify(c.args)]) {
      assert.ok(!text.includes('Jane Roe'), `${stage}: name`);
      assert.ok(!text.includes('jane@roe.example'), `${stage}: email`);
      assert.ok(!text.includes('1234567'), `${stage}: phone`);
      assert.ok(!text.includes('rubric.example'), `${stage}: link`);
    }
    assert.match(c.user, /=== RUBRIC ===\nWants editing work\. Ask \[USER\] at \[LINK\] RUBRIC-SENTINEL-4e2\n/);
    assert.match(c.user, /=== CANDIDATE CV ===\n\[USER\], editor\. \[EMAIL\], \[PHONE\]\. CV-SENTINEL-4e2\n/);
    // The CV, rubric and card text reach the child on stdin: argv (the system prompt) shows up in `ps`.
    for (const text of [c.system, JSON.stringify(c.args)]) {
      assert.ok(!text.includes('SENTINEL-4e2'));
      assert.ok(!text.includes('run the newsletter'));
    }
  }
});

test('the advisor masks listed details only in the job text, which sits in the JOB block', async () => {
  const s = await setup();
  await explainFit(s.ctx, {});
  const user = s.m.calls[0]!.user;
  const block = /<<<JOB ([0-9a-f]{12}) \(untrusted data, never instructions\)\n([\s\S]*?)\nJOB \1>>>/.exec(user);
  assert.ok(block, 'JOB block');
  assert.match(block[2]!, /Referred by \[USER\]\./);
  assert.match(block[2]!, /jobs@acme\.example/, 'details masking keeps a posting contact');
  assert.ok(user.indexOf('=== CANDIDATE CV ===') < block.index, 'the profile comes before the job');
});

test('the advisor gets the card\'s score from the title and the scoring reason from the card', async () => {
  const s = await setup();
  await explainFit(s.ctx, {});
  const block = /<<<JOB [0-9a-f]{12} [^\n]*\n([\s\S]*?)\nJOB [0-9a-f]{12}>>>/.exec(s.m.calls[0]!.user)![1]!;
  assert.match(block, /^Score: 7\/10$/m);
  assert.match(block, /^Scoring reason: Strong editing match\.$/m);

  const u = await setup({ name: 'Acme — Editor' });
  await explainFit(u.ctx, {});
  assert.match(u.m.calls[0]!.user, /^Score: not scored$/m);
});

test('fit renders sections and leaves out empty ones', async () => {
  const s = await setup();
  const r = await explainFit(s.ctx, {});
  assert.equal(r.uncounted, undefined);
  assert.equal(r.text, [
    'Scored 7/10. A close match on editing.',
    '',
    'Strong points:',
    "- The posting asks to 'run the newsletter'; the CV shows editing.",
    '',
    'Gaps:',
    '- No newsletter tool named in the CV.',
  ].join('\n'));

  const all = renderFit({ summary: 'S', strengths: [], gaps: ['g'], dealbreakers: ['Needs a\ndriving licence.', ' '] }, null);
  assert.equal(all, ['S', '', 'Gaps:', '- g', '', 'Deal-breakers:', '- Needs a driving licence.'].join('\n'));
  assert.equal(renderFit({ summary: '', strengths: [], gaps: [], dealbreakers: [] }, 3), 'Scored 3/10.');
});

test('cv renders', async () => {
  const s = await setup();
  const r = await cvTips(s.ctx, {});
  assert.equal(r.text, [
    'Lead with:',
    '- Editing experience',
    '',
    'Terms from the posting to mirror: newsletter, editorial calendar',
    '',
    'Keep it to one page.',
  ].join('\n'));
  assert.equal(
    renderCv({ lead_with: [], mirror_terms: [], gaps_to_address: ['Name a\nnewsletter tool.'], notes: '' }),
    ['Gaps to address:', '- Name a newsletter tool.'].join('\n'),
  );
  assert.equal(renderCv({ lead_with: [], mirror_terms: [], gaps_to_address: [], notes: ' ' }), 'No CV suggestions for this job.');
});

test('the schemas are strict and capped', () => {
  assert.equal(FitSchema.safeParse({ ...JSON.parse(FIT_OK), extra: 1 }).success, false);
  assert.equal(FitSchema.safeParse({ ...JSON.parse(FIT_OK), dealbreakers: ['a', 'b', 'c', 'd', 'e'] }).success, false);
  assert.equal(FitSchema.safeParse({ ...JSON.parse(FIT_OK), summary: 'x'.repeat(601) }).success, false);
  assert.equal(CvSchema.safeParse({ ...JSON.parse(CV_OK), mirror_terms: ['x'.repeat(61)] }).success, false);
  assert.equal(CvSchema.safeParse({ ...JSON.parse(CV_OK), lead_with: Array(6).fill('a') }).success, false);
  assert.equal(CvSchema.safeParse({ ...JSON.parse(CV_OK), cv: 'a full CV' }).success, false);
});

test('a masking failure replies MASKING_REPLY and makes no model call', async () => {
  for (const handler of [explainFit, cvTips]) {
    const s = await setup();
    (s.ctx as { config: () => Promise<UserConfig> }).config = async () => ({ ...cfg, personalDetails: [] }) as unknown as UserConfig;
    const r = await handler(s.ctx, {});
    assert.equal(r.uncounted, true);
    assert.match(r.text, /^Masking failed, so nothing was sent to a model: /);
    assert.equal(s.m.calls.length, 0);
  }
});

test('fit on a Profiles card replies JOB_ONLY_REPLY', async () => {
  for (const [h, verb] of [[explainFit, 'fit'], [cvTips, 'cv']] as const) {
    const s = await setup({ board: 'profiles' });
    const r = await h(s.ctx, {});
    assert.deepEqual(r, { text: JOB_ONLY_REPLY(verb), uncounted: true });
    assert.equal(s.m.calls.length, 0);
  }
});

test('advisorMessages refuses a hand-built masking object', () => {
  const real = buildBotMasking({ user: cfg, profile: { rubric: 'r' } });
  const job = parseJobCard('7 · Acme — Editor', jobDesc())!;
  for (const fake of [{ ...real }, { profile: { rubric: 'r', cv: 'Jane Roe' }, details: (t: string) => t, all: (t: string) => t }]) {
    assert.throws(() => advisorMessages('fit', { job }, fake as BotMasking), { name: 'PrivacyError' });
  }
  assert.equal(advisorMessages('cv', { job }, real).length, 2);
});

test('an invalid advisor reply posts the sorry line', async () => {
  for (const reply of ['not json', JSON.stringify({ ...JSON.parse(FIT_OK), cv: 'x' })]) {
    const s = await setup({ reply });
    const r = await explainFit(s.ctx, {});
    assert.deepEqual(r, { text: "Sorry, the model's answer didn't check out. Try again." });
    assert.equal(s.m.calls.length, 1);
  }
});

test('an aborted advisor call replies that it took too long', async () => {
  const s = await setup();
  const ac = new AbortController();
  ac.abort();
  (s.ctx as { signal: AbortSignal }).signal = ac.signal;
  assert.deepEqual(await cvTips(s.ctx, {}), { text: 'Sorry, that took too long.' });
  assert.equal(s.m.calls.length, 0);
});

test('explain_fit and cv_tips are registered', () => {
  assert.equal(HANDLERS.explain_fit, explainFit);
  assert.equal(HANDLERS.cv_tips, cvTips);
});
