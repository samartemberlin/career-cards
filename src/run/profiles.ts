// The active profiles of one user, seen as one: a job any of them accepts is kept, and one scoring call covers all.
import { personFilterFromProfile } from '../config/person.ts';
import { filterJob } from '../pipeline/filter.ts';
import type { Job } from '../pipeline/keys.ts';
import type { Profile, Settings, UserConfig } from '../config/schema.ts';

export function activeProfiles(cfg: UserConfig): Profile[] {
  return cfg.profiles.filter((p) => p.active);
}

/** `null` if any profile accepts the job, else the first profile's rejection reason. */
export function combinedFilter(profiles: Profile[], settings: Settings): (job: Job) => string | null {
  if (!profiles.length) throw new Error('combinedFilter needs at least one profile');
  const filters = profiles.map((p) => personFilterFromProfile(p, settings));
  return (job) => {
    let first: string | null = null;
    for (const f of filters) {
      const why = filterJob(job, f);
      if (!why) return null;
      first ??= why;
    }
    return first;
  };
}

export const MIXED_CV_WARNING = 'active profiles have different CV cards; scoring uses the Shared CV';

/** The rubric and CV override to score with. `cv` undefined means the Shared CV. */
export function scoringProfile(cfg: UserConfig): { rubric: string; cv?: string; warning?: string } {
  const active = activeProfiles(cfg);
  if (active.length === 1) return { rubric: active[0]!.rubric, cv: active[0]!.cv };
  const rubric = active.map((p) => `## ${p.name}\n\n${p.rubric.trim()}`).join('\n\n');
  const cvs = new Set(active.map((p) => p.cv));
  if (cvs.size === 1) return { rubric, cv: active[0]!.cv };
  return { rubric, cv: undefined, warning: MIXED_CV_WARNING };
}
