// A service process for runs.test.ts: starts a hung run (with a grandchild) and prints its lines until it is signalled.
import { fileURLToPath } from 'node:url';
import { localRunStarter } from '../../../src/serve/runs.ts';

const s = localRunStarter({
  env: { PATH: process.env.PATH, FAKE_GRANDCHILD: '1' },
  script: fileURLToPath(new URL('./hang.mjs', import.meta.url)),
  log: (l) => console.log(l),
});
await s.start('manual');
setInterval(() => {}, 1000);
