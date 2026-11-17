import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeProfileNames, botRubric, compileInputOf, compileUser, scoringTextOf } from '../../src/run/profiles.ts';
import { CompileFailed } from '../../src/compile/compile.ts';
import { DEFAULT_PENALTIES } from '../../src/compile/schema.ts';
import type { UserConfig } from '../../src/config/schema.ts';
import { llmConfig } from '../../src/pipeline/llm.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import { readUserConfig } from '../../src/trello/config.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { SAMPLE_COMPILED, fakeLlm, fakeLlmEnv } from '../support/fake-llm.ts';
import type { CompileReply } from '../support/fake-llm.ts';
import { seedLayout } from '../support/seed-layout.ts';
import { LAYOUT } from '../../tools/sample/layout.ts';

async function sampleConfig(): Promise<UserConfig> {
  const fake = new FakeTrello();
  const profiles = await seedLayout(fake, LAYOUT.profiles);
  const system = await seedLayout(fake, LAYOUT.system);
  const api = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  return readUserConfig(api, { jobs: 'none', profiles, system });
}

const dreamOf = (cfg: UserConfig) => cfg.board.profiles[0]!.cards.find((c) => c.key === 'dream')!.text;

async function compile(cfg: UserConfig, reply: () => CompileReply = () => SAMPLE_COMPILED) {
  const llm = fakeLlm({ score: () => 5, compile: reply });
  const out = await compileUser(cfg, {
    llm: llmConfig(fakeLlmEnv, { providers: [] }), call: { fetchImpl: llm.fetchImpl, retries: 0 }, log: () => {}, pauseMs: 0,
  });
  return { out, requests: llm.requests };
}

describe('the sample board as the run sees it', () => {
  it('only the active profile counts', async () => {
    const cfg = await sampleConfig();
    assert.deepEqual(activeProfileNames(cfg), ['Content editor']);
    const input = compileInputOf(cfg);
    assert.deepEqual(input.dealBreakers.map((c) => c.key), ['where', 'contract', 'languages', 'never']);
    assert.deepEqual(input.profiles.map((p) => [p.name, p.cards.map((c) => c.key)]), [['Content editor', ['roles', 'words', 'dream', 'examples']]]);
  });

  it('an optional card left empty is not sent to the model', async () => {
    const cfg = await sampleConfig();
    const examples = cfg.board.profiles[0]!.cards.find((c) => c.key === 'examples')!;
    examples.text = '';
    assert.ok(!compileInputOf(cfg).profiles[0]!.cards.some((c) => c.key === 'examples'));
    assert.equal(scoringTextOf(cfg).profiles[0]!.examples, '');
  });

  it("the bot's rubric: the cards' own words, no example table, no model", async () => {
    const cfg = await sampleConfig();
    const rubric = botRubric(cfg);
    assert.match(rubric, /^## Profile: Content editor$/m);
    assert.ok(rubric.includes(dreamOf(cfg)));
    assert.ok(!rubric.includes('### Example roles'));
    assert.match(rubric, /\*\*Company size:\*\* Small or mid-size/);
  });

  it('compileUser: filter, rubric with the example table, preferences and the reading', async () => {
    const cfg = await sampleConfig();
    const { out, requests } = await compile(cfg);
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(requests).includes('Alex Example'));
    assert.match(out.rubric, /### Example roles\n\| Role \| Score \|/);
    assert.ok(out.rubric.includes(dreamOf(cfg)));
    const job = { key: 'k', url: 'https://jobs.example/1', company: 'Acme', title: 'Content Editor', location: 'Zürich' };
    assert.equal(out.filter(job), 'PLACE_NOT_KEPT: "Zürich"');
    assert.equal(out.filter({ ...job, location: 'Berlin' }), null);
    assert.deepEqual(out.preferences, { penalties: DEFAULT_PENALTIES, languages: { de: { read: 'B2', write: 'B1', speak: 'B1' } }, years_experience: 3 });
    assert.equal(out.reading[0]!.card, 'Where & how I work');
  });

  it('compileUser: a problem from the model is in compiled.problems, not CompileFailed', async () => {
    const cfg = await sampleConfig();
    const { out } = await compile(cfg, () => ({ ...SAMPLE_COMPILED, problems: [{ card: 'Languages', reason: 'unclear' }] }));
    assert.deepEqual(out.compiled.problems, [{ card: 'Languages', reason: 'unclear' }]);
  });
});
