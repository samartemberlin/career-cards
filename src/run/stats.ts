import type { SourceError } from '../pipeline/sources/types.ts';

export type RunTrigger = 'scheduled' | 'manual';
export type RunState = 'running' | 'ok' | 'failed' | 'skipped';

export type RunStats = {
  scanned: number;
  bySource: Record<string, { returned: number; new: number }>;
  known: number;
  fresh: number;
  rejectedPre: number;
  rejectedPost: number;
  rules: Record<string, number>;
  jd: { fetched: number; missing: number; deferred: number };
  facts: { done: number; errors: number; aborted: string | null; tokens: number; models: Record<string, number> };
  scored: number;
  scoreErrors: number;
  deferred: number;
  /** Not attempted because scoring stopped early (quota, time budget). */
  left: number;
  /** Not scored because the personal details could not be masked. */
  leftUnmasked: number;
  aborted: string | null;
  /** Preference penalties, computed but not applied to any score (shadow mode). */
  shadow: { jobs: number; points: number };
  cards: { created: number; failed: number };
  archived: { archived: number; failed: number; left: number };
  models: Record<string, number>;
  tokens: number;
  sourceErrors: SourceError[];
  warnings: string[];
};

export function emptyStats(): RunStats {
  return {
    scanned: 0,
    bySource: {},
    known: 0,
    fresh: 0,
    rejectedPre: 0,
    rejectedPost: 0,
    rules: {},
    jd: { fetched: 0, missing: 0, deferred: 0 },
    facts: { done: 0, errors: 0, aborted: null, tokens: 0, models: {} },
    scored: 0,
    scoreErrors: 0,
    deferred: 0,
    left: 0,
    leftUnmasked: 0,
    aborted: null,
    shadow: { jobs: 0, points: 0 },
    cards: { created: 0, failed: 0 },
    archived: { archived: 0, failed: 0, left: 0 },
    models: {},
    tokens: 0,
    sourceErrors: [],
    warnings: [],
  };
}

/** The rule id from a rejection reason: the text before the first ':', e.g. 'EXCLUDE_TITLE'. */
export function ruleId(reason: string): string {
  const idx = reason.indexOf(':');
  return idx >= 0 ? reason.slice(0, idx) : reason;
}
