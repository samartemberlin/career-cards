// career-ops is third-party code, and fetch-jd.mjs reads untrusted pages: it gets no Trello, model or other secret,
// only what it needs to run.
const PASSED_ENV = ['PATH', 'HOME', 'LANG'];

export type ParentEnv = Record<string, string | undefined>;

export function careerOpsEnv(parent: ParentEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const v = parent[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...extra };
}
