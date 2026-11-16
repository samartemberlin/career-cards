import type { RunStarter } from '../serve/runs.ts';
import type { RunTrigger } from '../run/stats.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type GhRunEnv = {
  GITHUB_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_API_URL?: string;
  RUN_WORKFLOW?: string;
  RUN_REF?: string;
  GITHUB_REF_NAME?: string;
};

/** RunStarter backed by GitHub Actions workflow_dispatch. */
export function ghRunStarter(env: GhRunEnv, o?: { fetchImpl?: FetchLike; now?: () => Date }): RunStarter {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  if (!env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is not set');
  const ref = env.RUN_REF ?? env.GITHUB_REF_NAME;
  if (!ref) throw new Error('RUN_REF or GITHUB_REF_NAME must be set');
  const fetchImpl = o?.fetchImpl ?? (fetch as FetchLike);
  const now = o?.now ?? (() => new Date());
  const workflow = env.RUN_WORKFLOW ?? 'run.yml';
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  const base = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const token = env.GITHUB_TOKEN;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function checkStatus(status: string): Promise<boolean> {
    const res = await fetchImpl(
      `${base}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?status=${status}&per_page=1`,
      { headers },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status} listing ${status} runs`);
    const data = await res.json() as { total_count: number };
    return data.total_count > 0;
  }

  return {
    async isRunning() {
      return (await checkStatus('queued')) || (await checkStatus('in_progress'));
    },

    async start(trigger: RunTrigger) {
      const d = now();
      const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
      const dd = d.getUTCDate().toString().padStart(2, '0');
      const hh = d.getUTCHours().toString().padStart(2, '0');
      const min = d.getUTCMinutes().toString().padStart(2, '0');
      const label = `${mm}${dd}-${hh}${min}z`;
      const res = await fetchImpl(
        `${base}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ref, inputs: { trigger, label } }),
        },
      );
      if (!res.ok) throw new Error(`GitHub API ${res.status} dispatching ${workflow}`);
    },
  };
}
