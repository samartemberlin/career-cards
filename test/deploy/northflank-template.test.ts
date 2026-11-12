import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const text = readFileSync(join(root, 'deploy/northflank/template.json'), 'utf-8');

type Step = {
  kind: string;
  ref: string;
  spec: {
    activeDeadlineSeconds?: number;
    backoffLimit?: number;
    runOnSourceChange?: string;
    deployment: {
      instances?: number;
      docker: { configType: string; customCommand?: string };
      external?: { imagePath: string };
    };
    ports?: Array<{ name: string; internalPort: number; public: boolean; protocol: string }>;
    healthChecks?: Array<{
      type: string;
      protocol: string;
      path: string;
      port: number;
      initialDelaySeconds: number;
      periodSeconds: number;
      timeoutSeconds: number;
      failureThreshold: number;
    }>;
    runtimeEnvironment: Record<string, string>;
  };
};
type Template = {
  apiVersion: string;
  name: string;
  arguments: Record<string, string>;
  spec: { kind: string; spec: { type: string; context: { projectId: string }; steps: Step[] } };
};

const tpl = JSON.parse(text) as Template;
const steps = tpl.spec.spec.steps;
const args = tpl.arguments;
const job = steps.find((s) => s.kind === 'ManualJob')!;
const svc = steps.find((s) => s.kind === 'DeploymentService')!;

describe('Northflank template', () => {
  it('every ${args.X} used is declared in arguments, and every argument is used', () => {
    const used = new Set([...text.matchAll(/\$\{args\.([A-Z_]+)\}/g)].map((m) => m[1]));
    const declared = new Set(Object.keys(args));
    for (const name of used) assert.ok(declared.has(name), `${name} used but not declared`);
    for (const name of declared) assert.ok(used.has(name), `${name} declared but not used`);
  });

  it('the job: run command, 1 h deadline, no retries, never runs on source change', () => {
    assert.equal(job.spec.activeDeadlineSeconds, 3600);
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(job.spec.runOnSourceChange, 'never');
    assert.equal(job.spec.deployment.docker.customCommand, 'run');
  });

  it('the service: one instance, port 8080 public, /healthz, starts the job by ref', () => {
    assert.equal(svc.spec.deployment.instances, 1);
    const port = svc.spec.ports?.find((p) => p.internalPort === 8080);
    assert.ok(port, 'no port 8080');
    assert.equal(port?.public, true);
    const hc = svc.spec.healthChecks?.find((h) => h.path === '/healthz');
    assert.ok(hc, 'no /healthz health check');
    assert.equal(svc.spec.runtimeEnvironment['NORTHFLANK_JOB_ID'], '${refs.job.id}');
  });

  it('the job step comes before the service step', () => {
    const jobIdx = steps.findIndex((s) => s.ref === 'job');
    const svcIdx = steps.findIndex((s) => s.ref === 'serve');
    assert.ok(jobIdx !== -1, 'no step with ref "job"');
    assert.ok(svcIdx !== -1, 'no step with ref "serve"');
    assert.ok(jobIdx < svcIdx, `job at ${jobIdx}, service at ${svcIdx}`);
  });

  it('no secret names or values: no KEY/TOKEN/SECRET variable, no secret groups', () => {
    assert.doesNotMatch(text, /"[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*"\s*:/);
    assert.doesNotMatch(text, /"SecretGroup"/);
  });

  it('the job never gets the Northflank variables', () => {
    for (const key of Object.keys(job.spec.runtimeEnvironment)) {
      assert.ok(!key.startsWith('NORTHFLANK_'), `job has ${key}`);
    }
  });

  it('board ids have no defaults', () => {
    for (const name of ['JOBS_BOARD_ID', 'PROFILES_BOARD_ID', 'SYSTEM_BOARD_ID']) {
      assert.equal(args[name], '', `${name} should have empty default`);
    }
  });
});
