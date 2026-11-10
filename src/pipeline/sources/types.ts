import type { Job } from '../keys.ts';

/** A posting as a source reports it; the run derives the key. */
export type ScanRow = Omit<Job, 'key'>;
export type SourceError = { company: string; error: string };
/** The rows found, plus what failed: one broken source never stops the others. */
export type SourceResult = ScanRow[] & { errors: SourceError[] };
