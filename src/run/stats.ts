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
  facts: { done: number; errors: number; aborted: string | null };
  scored: number;
  scoreErrors: number;
  deferred: number;
  left: number;
  aborted: string | null;
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
    facts: { done: 0, errors: 0, aborted: null },
    scored: 0,
    scoreErrors: 0,
    deferred: 0,
    left: 0,
    aborted: null,
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
