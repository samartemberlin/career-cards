/**
 * Validates the reusable workflows and their template callers for correctness:
 * pinned SHAs, matching secrets, concurrency policy, checkout ref, and pin drift.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = join(import.meta.dirname, '..');
const SHA40 = /^[0-9a-f]{40}$/;

type Workflow = Record<string, unknown>;

function loadWorkflow(relPath: string): Workflow {
  return load(readFileSync(join(ROOT, relPath), 'utf8')) as Workflow;
}

function workflowCallSecrets(wf: Workflow): string[] {
  const on = wf['on'] as Record<string, unknown>;
  const wc = on['workflow_call'] as Record<string, unknown>;
  const secrets = wc['secrets'] as Record<string, unknown>;
  return Object.keys(secrets);
}

/** For a template caller (single-job workflow), returns that job object. */
function callerJob(wf: Workflow): Record<string, unknown> {
  const jobs = wf['jobs'] as Record<string, unknown>;
  const names = Object.keys(jobs);
  assert.equal(names.length, 1, 'template caller should have exactly one job');
  return jobs[names[0]!] as Record<string, unknown>;
}

/** Extracts @<SHA> from a uses: string. Returns null if not a 40-hex SHA. */
function usedSha(uses: string): string | null {
  const m = uses.match(/@([0-9a-f]{40})$/);
  return m ? m[1]! : null;
}

/** Returns all checkout steps from a job's steps array. */
function checkoutSteps(job: Record<string, unknown>): Record<string, unknown>[] {
  return (job['steps'] as Record<string, unknown>[]).filter(
    (s) => typeof s['uses'] === 'string' && (s['uses'] as string).startsWith('actions/checkout@'),
  );
}

/** Collects every uses: string from all steps across all jobs in a workflow. */
function allStepUses(wf: Workflow): string[] {
  const jobs = wf['jobs'] as Record<string, unknown>;
  const result: string[] = [];
  for (const job of Object.values(jobs)) {
    const steps = (job as Record<string, unknown>)['steps'] as Record<string, unknown>[] | undefined;
    if (!steps) continue;
    for (const step of steps) {
      if (typeof step['uses'] === 'string') result.push(step['uses'] as string);
    }
  }
  return result;
}

/** Reads the pinned claude-code version from the Dockerfile. */
function dockerfileClaudeVersion(): string {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const m = dockerfile.match(/@anthropic-ai\/claude-code@([\d.]+)/);
  assert.ok(m, 'Dockerfile should contain @anthropic-ai/claude-code@<version>');
  return m[1]!;
}

const templateBot = loadWorkflow('template/.github/workflows/bot.yml');
const templateRun = loadWorkflow('template/.github/workflows/run.yml');
const reusableBot = loadWorkflow('.github/workflows/bot.yml');
const reusableRun = loadWorkflow('.github/workflows/run.yml');

describe('template callers: pinned SHA', () => {
  it('bot caller uses: ends in @<40 hex>', () => {
    const job = callerJob(templateBot);
    const uses = job['uses'] as string;
    assert.ok(uses.includes('samartemberlin/career-cards'), `uses should reference career-cards, got: ${uses}`);
    const sha = usedSha(uses);
    assert.ok(sha !== null && SHA40.test(sha), `uses: should end in @<40 hex>, got: ${uses}`);
  });

  it('bot caller ref: input equals the SHA in uses:', () => {
    const job = callerJob(templateBot);
    const uses = job['uses'] as string;
    const sha = usedSha(uses)!;
    const withInputs = job['with'] as Record<string, unknown>;
    assert.equal(withInputs['ref'], sha, 'with.ref must equal the SHA from uses:');
  });

  it('run caller uses: ends in @<40 hex>', () => {
    const job = callerJob(templateRun);
    const uses = job['uses'] as string;
    assert.ok(uses.includes('samartemberlin/career-cards'), `uses should reference career-cards, got: ${uses}`);
    const sha = usedSha(uses);
    assert.ok(sha !== null && SHA40.test(sha), `uses: should end in @<40 hex>, got: ${uses}`);
  });

  it('run caller ref: input equals the SHA in uses:', () => {
    const job = callerJob(templateRun);
    const uses = job['uses'] as string;
    const sha = usedSha(uses)!;
    const withInputs = job['with'] as Record<string, unknown>;
    assert.equal(withInputs['ref'], sha, 'with.ref must equal the SHA from uses:');
  });
});

describe('template callers: no @main', () => {
  it('bot caller has no @main anywhere', () => {
    assert.ok(
      !JSON.stringify(templateBot).includes('@main'),
      'template bot.yml must not reference @main',
    );
  });

  it('run caller has no @main anywhere', () => {
    assert.ok(
      !JSON.stringify(templateRun).includes('@main'),
      'template run.yml must not reference @main',
    );
  });
});

describe('template callers: concurrency', () => {
  it('bot caller concurrency has queue: max', () => {
    const concurrency = templateBot['concurrency'] as Record<string, unknown>;
    assert.ok(concurrency, 'bot caller should have a concurrency block');
    assert.equal(concurrency['queue'], 'max', 'bot concurrency must have queue: max');
  });
});

describe('template callers: secrets match reusable workflow_call.secrets', () => {
  it('bot caller secrets equal reusable bot secrets', () => {
    const job = callerJob(templateBot);
    const callerSecrets = Object.keys(job['secrets'] as Record<string, unknown>).sort();
    const reusableSecrets = workflowCallSecrets(reusableBot).sort();
    assert.deepEqual(callerSecrets, reusableSecrets, 'bot caller secret names must match reusable bot workflow_call.secrets');
  });

  it('run caller secrets equal reusable run secrets', () => {
    const job = callerJob(templateRun);
    const callerSecrets = Object.keys(job['secrets'] as Record<string, unknown>).sort();
    const reusableSecrets = workflowCallSecrets(reusableRun).sort();
    assert.deepEqual(callerSecrets, reusableSecrets, 'run caller secret names must match reusable run workflow_call.secrets');
  });
});

describe('reusable workflows: checkout uses inputs.ref', () => {
  it('reusable bot checks out at ${{ inputs.ref }}', () => {
    const job = (reusableBot['jobs'] as Record<string, unknown>)['handle'] as Record<string, unknown>;
    const steps = checkoutSteps(job);
    assert.ok(steps.length > 0, 'reusable bot should have a checkout step');
    const ref = (steps[0]!['with'] as Record<string, unknown>)['ref'];
    assert.equal(ref, '${{ inputs.ref }}', 'reusable bot checkout must use ref: ${{ inputs.ref }}');
  });

  it('reusable run checks out at ${{ inputs.ref }}', () => {
    const job = (reusableRun['jobs'] as Record<string, unknown>)['run'] as Record<string, unknown>;
    const steps = checkoutSteps(job);
    assert.ok(steps.length > 0, 'reusable run should have a checkout step');
    const ref = (steps[0]!['with'] as Record<string, unknown>)['ref'];
    assert.equal(ref, '${{ inputs.ref }}', 'reusable run checkout must use ref: ${{ inputs.ref }}');
  });
});

describe('pin-drift guards', () => {
  it('every uses: in reusable bot ends in @<40 hex>', () => {
    for (const uses of allStepUses(reusableBot)) {
      const sha = usedSha(uses);
      assert.ok(sha !== null && SHA40.test(sha), `reusable bot uses: should end in @<40 hex>, got: ${uses}`);
    }
  });

  it('every uses: in reusable run ends in @<40 hex>', () => {
    for (const uses of allStepUses(reusableRun)) {
      const sha = usedSha(uses);
      assert.ok(sha !== null && SHA40.test(sha), `reusable run uses: should end in @<40 hex>, got: ${uses}`);
    }
  });

  it('claude CLI version in reusable bot matches Dockerfile', () => {
    const expected = dockerfileClaudeVersion();
    const env = reusableBot['env'] as Record<string, unknown>;
    assert.equal(String(env['CLAUDE_CLI_VERSION']), expected, 'reusable bot CLAUDE_CLI_VERSION must match Dockerfile');
  });

  it('claude CLI version in reusable run matches Dockerfile', () => {
    const expected = dockerfileClaudeVersion();
    const env = reusableRun['env'] as Record<string, unknown>;
    assert.equal(String(env['CLAUDE_CLI_VERSION']), expected, 'reusable run CLAUDE_CLI_VERSION must match Dockerfile');
  });

  it('bot caller cancel-in-progress is false', () => {
    const concurrency = templateBot['concurrency'] as Record<string, unknown>;
    assert.strictEqual(concurrency['cancel-in-progress'], false, 'bot caller cancel-in-progress must be false');
  });

  it('bot caller concurrency group contains inputs.card_id', () => {
    const concurrency = templateBot['concurrency'] as Record<string, unknown>;
    const group = String(concurrency['group']);
    assert.ok(group.includes('inputs.card_id'), `bot caller concurrency group must reference inputs.card_id, got: ${group}`);
  });

  it('bot caller permissions.actions is write', () => {
    const permissions = templateBot['permissions'] as Record<string, unknown>;
    assert.equal(permissions['actions'], 'write', 'bot caller permissions.actions must be write');
  });
});

describe('reusable run: retry on crash', () => {
  it('has a retry job', () => {
    const jobs = reusableRun['jobs'] as Record<string, unknown>;
    assert.ok('retry' in jobs, 'reusable run should have a retry job');
  });

  it('retry job has the exact if condition', () => {
    const jobs = reusableRun['jobs'] as Record<string, unknown>;
    const retry = jobs['retry'] as Record<string, unknown>;
    assert.equal(
      String(retry['if']),
      "${{ failure() && needs.run.outputs.reported != 'true' && !inputs.retried }}",
    );
  });

  it('retry job needs the run job', () => {
    const jobs = reusableRun['jobs'] as Record<string, unknown>;
    const retry = jobs['retry'] as Record<string, unknown>;
    assert.equal(retry['needs'], 'run');
  });

  it('run job exposes reported output from steps.run', () => {
    const jobs = reusableRun['jobs'] as Record<string, unknown>;
    const run = jobs['run'] as Record<string, unknown>;
    const outputs = run['outputs'] as Record<string, unknown> | undefined;
    assert.ok(outputs, 'run job should have outputs');
    assert.equal(outputs['reported'], '${{ steps.run.outputs.reported }}');
  });

  it('has retried input (boolean, default false)', () => {
    const on = reusableRun['on'] as Record<string, unknown>;
    const wc = on['workflow_call'] as Record<string, unknown>;
    const inputs = wc['inputs'] as Record<string, unknown>;
    const retried = inputs['retried'] as Record<string, unknown> | undefined;
    assert.ok(retried, 'reusable run should have retried input');
    assert.equal(retried['type'], 'boolean');
    assert.equal(retried['default'], false);
  });

  it('has caller_workflow input (string, default run.yml)', () => {
    const on = reusableRun['on'] as Record<string, unknown>;
    const wc = on['workflow_call'] as Record<string, unknown>;
    const inputs = wc['inputs'] as Record<string, unknown>;
    const callerWorkflow = inputs['caller_workflow'] as Record<string, unknown> | undefined;
    assert.ok(callerWorkflow, 'reusable run should have caller_workflow input');
    assert.equal(callerWorkflow['type'], 'string');
    assert.equal(callerWorkflow['default'], 'run.yml');
  });
});

describe('template run: retry inputs', () => {
  it('passes retried input', () => {
    const job = callerJob(templateRun);
    const withInputs = job['with'] as Record<string, unknown>;
    assert.ok('retried' in withInputs, 'template run should pass retried input');
  });

  it('permissions.actions is write', () => {
    const permissions = templateRun['permissions'] as Record<string, unknown> | undefined;
    assert.ok(permissions, 'template run should have a permissions block');
    assert.equal(permissions['actions'], 'write', 'template run permissions.actions must be write');
  });

  it('schedule is commented out', () => {
    const raw = readFileSync(join(ROOT, 'template/.github/workflows/run.yml'), 'utf8');
    const on = templateRun['on'] as Record<string, unknown>;
    assert.ok(!('schedule' in on), 'template run schedule must be commented out');
    assert.ok(raw.includes('# schedule:') || raw.includes('#   - cron:'), 'template run should have commented-out schedule');
  });
});
