// Stands in for a hung src/run.ts in runs.test.ts: holds the run lock the way fileLock writes it, then never ends (unless FAKE_EXIT).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_LOCK_FILE) writeFileSync(process.env.FAKE_LOCK_FILE, `${process.pid} 2026-11-13T00:00:00.000Z fake`);
if (process.env.FAKE_IGNORE_SIGTERM) process.on('SIGTERM', () => {});
if (process.env.FAKE_GRANDCHILD) {
  // Like scan.ts, whose child inherits stderr: it keeps the run's pipes open after the run itself dies. `own-group`
  // stands in for one that left the run's process group, which a group kill misses.
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.env.FAKE_GRANDCHILD === 'own-group',
  });
  console.log(`grandchild ${g.pid}`);
}
console.log(`pid ${process.pid}`);
console.log('ready');
if (process.env.FAKE_EXIT) process.exit(0);
setInterval(() => {}, 1000);
