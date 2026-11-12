// One run at a time is decided outside Trello: the bot never edits a card, so a card can't serve as the lock.
// Locally (CLI) a lock file; deployed, the platform's job concurrency and the service (PR 4/5).
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';

export type RunLock = {
  /** False when another run holds the lock. */
  acquire(): Promise<boolean>;
  /** Frees the lock if this instance holds it; otherwise does nothing. */
  release(): Promise<void>;
};

/** A run that crashed without releasing leaves its file behind; past this age the next run takes it over. */
export const LOCK_STALE_MS = 2 * 3600_000;

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** True while a fresh lock file exists. Errors other than a missing file throw, so callers can fail closed. */
export async function lockHeld(path: string, staleMs = LOCK_STALE_MS): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs < staleMs;
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
}

export function fileLock(path: string, o: { staleMs?: number } = {}): RunLock {
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  let token: string | null = null;

  async function create(): Promise<boolean> {
    const mine = `${process.pid} ${new Date().toISOString()} ${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(path, mine, { flag: 'wx' });
      token = mine;
      return true;
    } catch (e) {
      if (code(e) === 'EEXIST') return false;
      throw e;
    }
  }

  return {
    async acquire() {
      if (await create()) return true;
      let age: number;
      try {
        age = Date.now() - (await stat(path)).mtimeMs;
      } catch (e) {
        if (code(e) === 'ENOENT') return create();
        throw e;
      }
      if (age < staleMs) return false;
      // Two runs finding the same stale file in the same moment could both get in; that needs a crashed run plus two
      // simultaneous starts, and the deployed lock is the platform's anyway.
      try {
        await unlink(path);
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
      }
      return create();
    },
    async release() {
      if (token === null) return;
      try {
        if ((await readFile(path, 'utf8')) === token) await unlink(path);
      } catch (e) {
        if (code(e) !== 'ENOENT') throw e;
      } finally {
        token = null;
      }
    },
  };
}
