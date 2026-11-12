import { fetchJd } from '../pipeline/jd.ts';
import { safeFetch, safeFetchLike } from '../net/safe-fetch.ts';
import type { UrlGuard } from '../net/safe-fetch.ts';
import type { Env } from '../pipeline/llm.ts';
import { checkOpen } from './open.ts';
import type { NetDeps } from './handlers.ts';

/** Fetches for links from comments and card descriptions, which anyone with board access can write. */
export function botNet(o: { env: Env; guard?: UrlGuard }): NetDeps {
  const guard = o.guard ?? {};
  const fetchImpl = safeFetchLike(guard);
  return {
    // safeFetch checks the address each socket connects to, so DNS rebinding can't slip past it; checkOpen's
    // career-ops liveness child resolves the name again after its check, and that window remains.
    fetchJd: (job, jo) => fetchJd(job, { pageOnly: true, fetchImpl, ...(jo?.deadline !== undefined ? { deadline: jo.deadline } : {}) }),
    checkOpen: (url) => checkOpen(url, { env: o.env, fetch: (u) => safeFetch(u, guard) }),
    ...(o.guard ? { urlGuard: o.guard } : {}),
  };
}
