import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const text = readFileSync(join(root, 'deploy/northflank/template-local.json'), 'utf-8');

type Step = {
  kind: string;
  ref: string;
  spec: {
    deployment: {
      instances?: number;
      docker: { configType: string };
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
const svc = steps.find((s) => s.kind === 'DeploymentService')!;

describe('Northflank template-local', () => {
  it('no ManualJob step', () => {
    const job = steps.find((s) => s.kind === 'ManualJob');
    assert.equal(job, undefined, 'template-local must not contain a ManualJob step');
  });

  it('the service env has no NORTHFLANK_* variable', () => {
    for (const key of Object.keys(svc.spec.runtimeEnvironment)) {
      assert.ok(!key.startsWith('NORTHFLANK_'), `service has ${key}`);
    }
  });

  it('every ${args.X} used is declared in arguments, and every argument is used', () => {
    const used = new Set([...text.matchAll(/\$\{args\.([A-Z_]+)\}/g)].map((m) => m[1]));
    const declared = new Set(Object.keys(args));
    for (const name of used) assert.ok(declared.has(name), `${name} used but not declared`);
    for (const name of declared) assert.ok(used.has(name), `${name} declared but not used`);
  });

  it('no secret names or values: no KEY/TOKEN/SECRET variable, no secret groups', () => {
    assert.doesNotMatch(text, /"[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*"\s*:/);
    assert.doesNotMatch(text, /"SecretGroup"/);
  });

  it('board ids have no defaults', () => {
    for (const name of ['JOBS_BOARD_ID', 'PROFILES_BOARD_ID', 'SYSTEM_BOARD_ID']) {
      assert.equal(args[name], '', `${name} should have empty default`);
    }
  });

  it('service: one instance, port 8080 public, /healthz', () => {
    assert.equal(svc.spec.deployment.external?.imagePath, '${args.IMAGE}');
    assert.equal(svc.spec.deployment.instances, 1);
    const port = svc.spec.ports?.find((p) => p.internalPort === 8080);
    assert.ok(port, 'no port 8080');
    assert.equal(port?.public, true);
    const hc = svc.spec.healthChecks?.find((h) => h.path === '/healthz');
    assert.ok(hc, 'no /healthz health check');
  });
});
