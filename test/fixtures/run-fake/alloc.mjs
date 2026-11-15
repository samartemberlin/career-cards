// Stands in for a run that outgrows its heap in runs.test.ts; prints its priority and NODE_OPTIONS first.
import { getPriority } from 'node:os';

console.log(`priority ${getPriority()}`);
console.log(`node_options ${process.env.NODE_OPTIONS ?? ''}`);
if (process.env.FAKE_QUOTE) console.error('rejected job: "JavaScript heap out of memory" in the title');
if (process.env.FAKE_FAIL) process.exit(3);
if (process.env.FAKE_ALLOC) {
  const keep = [];
  for (;;) keep.push(new Array(100_000).fill(keep.length));
}
