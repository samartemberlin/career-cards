import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../src/serve/queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('queue: runs in order, one at a time', async () => {
  const q = createQueue({ max: 50, log: () => {} });
  const events: string[] = [];
  let active = 0;
  for (const name of ['a', 'b', 'c']) {
    q.push(async () => {
      active++;
      assert.equal(active, 1);
      events.push(`start ${name}`);
      await tick();
      events.push(`end ${name}`);
      active--;
    });
  }
  await q.idle();
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('queue: a throwing job is logged and the next one runs', async () => {
  const logs: string[] = [];
  const q = createQueue({ max: 50, log: (s) => logs.push(s) });
  let ran = false;
  q.push(async () => { throw new Error('boom\nsecond line'); });
  q.push(async () => { ran = true; });
  await q.idle();
  assert.ok(ran);
  assert.deepEqual(logs, ['queued job failed: boom']);
});

test('queue: the 51st push while 50 wait returns false; the queue takes jobs again once drained', async () => {
  const q = createQueue({ max: 50, log: () => {} });
  let release!: () => void;
  q.push(() => new Promise<void>((r) => { release = r; }));
  await tick();
  for (let i = 0; i < 50; i++) assert.equal(q.push(async () => {}), true, `push ${i}`);
  assert.equal(q.push(async () => {}), false);
  release();
  await q.idle();
  assert.equal(q.push(async () => {}), true);
  await q.idle();
});
