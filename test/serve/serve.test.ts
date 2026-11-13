import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { main, parseServeEnv } from '../../src/serve.ts';
import { UsageError } from '../../src/run.ts';
import { createTrelloClient } from '../../src/trello/client.ts';
import type { TMember } from '../../src/trello/api.ts';
import type { RunTrigger } from '../../src/run/stats.ts';
import { jobKey } from '../../src/pipeline/keys.ts';
import { parseMarker } from '../../src/bot/marker.ts';
import { FakeTrello } from '../support/fake-trello.ts';
import { commentWebhook, signedRequest } from '../support/webhook.ts';
import type { Recording } from '../../tools/sample/scrub.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'trello');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.recording.json`), 'utf8')) as Recording;

const BOARDS = { jobs: 'fa4e00000000000000000005', profiles: 'fa4e0000000000000000000c', system: 'fa4e0000000000000000000d' };
const JOB_CARD = 'fa4e00000000000000000012';
const SETTINGS_CARD = 'fa4e00000000000000000476';
const USER_A: TMember = { id: 'fa4e0000000000000000a001', username: 'usera' };

const ENV = {
  TRELLO_KEY: 'key-sample-0123456789',
  TRELLO_TOKEN: 'token-sample-0123456789',
  TRELLO_APP_SECRET: 'app-secret-sample-0123456789',
  TRIGGER_SECRET: 'trigger-secret-sample-0123456789abcdef',
  PUBLIC_URL: 'https://bot.example/',
  JOBS_BOARD_ID: BOARDS.jobs,
  PROFILES_BOARD_ID: BOARDS.profiles,
  SYSTEM_BOARD_ID: BOARDS.system,
  PORT: '0',
};
const CALLBACK = 'https://bot.example/trello';

test('parseServeEnv names every missing variable', () => {
  assert.throws(() => parseServeEnv({}), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    for (const k of ['TRELLO_KEY', 'TRELLO_TOKEN', 'TRELLO_APP_SECRET', 'TRIGGER_SECRET', 'PUBLIC_URL',
      'JOBS_BOARD_ID', 'PROFILES_BOARD_ID', 'SYSTEM_BOARD_ID']) assert.match(e.message, new RegExp(k));
    return true;
  });
});

test('parseServeEnv: defaults and the callback URL source', () => {
  const cfg = parseServeEnv({ ...ENV, PORT: undefined });
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.publicUrl, 'https://bot.example/');
  assert.deepEqual(cfg.boards, BOARDS);
});

test('a short TRIGGER_SECRET is rejected', () => {
  assert.throws(() => parseServeEnv({ ...ENV, TRIGGER_SECRET: 'x'.repeat(31) }), /TRIGGER_SECRET must be at least 32/);
  assert.equal(parseServeEnv({ ...ENV, TRIGGER_SECRET: 'x'.repeat(32) }).triggerSecret, 'x'.repeat(32));
});

test('PUBLIC_URL must be https; PORT must be a port', () => {
  for (const bad of ['http://bot.example', 'bot.example', 'https://u:p@bot.example', 'https://bot.example/?a=1', 'https://bot.example/#x', 'https://bot.example/base']) {
    assert.throws(() => parseServeEnv({ ...ENV, PUBLIC_URL: bad }), /PUBLIC_URL must be an https/, bad);
  }
  assert.throws(() => parseServeEnv({ ...ENV, PUBLIC_URL: '' }), /Missing environment variables: PUBLIC_URL/);
  for (const bad of ['-1', '65536', '80a', '1e3']) assert.throws(() => parseServeEnv({ ...ENV, PORT: bad }), /PORT/, bad);
});

test('the error text holds no value', () => {
  const env = { ...ENV, TRIGGER_SECRET: 'short-secret-value', PUBLIC_URL: 'http://leaky-host.example', PORT: 'port-value', TRELLO_KEY: '' };
  assert.throws(() => parseServeEnv(env), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    for (const v of ['short-secret-value', 'leaky-host', 'port-value', ENV.TRELLO_TOKEN, ENV.TRELLO_APP_SECRET]) {
      assert.ok(!e.message.includes(v), `leaked ${v}`);
    }
    return true;
  });
});

function setup() {
  const fake = FakeTrello.fromRecordings(load('jobs'), load('profiles'), load('system'));
  fake.setNow(new Date());
  fake.setCardDesc(SETTINGS_CARD, '```yaml\nproviders: [claude]\nlocations: [berlin]\nallowed_members: [usera]\n```');
  const trello = createTrelloClient({ key: 'k', token: 't', fetchImpl: fake.fetch, sleep: async () => {} });
  const starts: RunTrigger[] = [];
  const starter = { isRunning: async () => false, start: async (t: RunTrigger) => { starts.push(t); } };
  const logs: string[] = [];
  return { fake, trello, starter, starts, logs };
}

const closers: (() => Promise<void>)[] = [];
after(async () => { for (const c of closers) await c(); });

async function start(s: ReturnType<typeof setup>, o: Parameters<typeof main>[1] = {}) {
  const svc = await main(ENV, { trello: s.trello, starter: s.starter, listen: true, out: (l) => s.logs.push(l), ...o });
  closers.push(svc.close);
  const base = `http://127.0.0.1:${(svc.server.address() as AddressInfo).port}`;
  const say = async (text: string, id?: string) => {
    const body = commentWebhook({
      cardId: JOB_CARD, boardId: BOARDS.jobs, listName: 'Nov 9 · 01:00', author: USER_A, text, ...(id ? { id } : {}),
    }) as { action: { id: string } };
    const { raw, signature } = signedRequest(body, { callbackUrl: CALLBACK, appSecret: ENV.TRELLO_APP_SECRET });
    const res = await fetch(`${base}/trello`, { method: 'POST', body: new Uint8Array(raw), headers: { 'x-trello-webhook': signature } });
    assert.equal(res.status, 200);
    await svc.queue.idle();
    return body.action.id;
  };
  return { svc, base, say };
}

test('end to end: a signed @samplebot help → one bot comment with the help text and a marker; the same request again → none', async () => {
  const s = setup();
  const { say } = await start(s);
  const id = await say('@samplebot help');
  const posted = s.fake.commentsOn(JOB_CARD);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!, /@samplebot last/);
  assert.deepEqual(parseMarker(posted[0]!), { actionId: id, cls: 'static' });

  await say('@samplebot help', id);
  assert.equal(s.fake.commentsOn(JOB_CARD).length, 1);
  assert.ok(s.logs.some((l) => l === `drop ${id}: seen`), s.logs.join('\n'));
  for (const v of [ENV.TRELLO_KEY, ENV.TRELLO_TOKEN, ENV.TRELLO_APP_SECRET, ENV.TRIGGER_SECRET]) {
    assert.ok(s.logs.every((l) => !l.includes(v)));
  }
  assert.ok(s.logs.every((l) => !l.includes('@samplebot help')), 'comment text logged');
});

test('end to end: the trigger starts a scheduled run', async () => {
  const s = setup();
  const { base } = await start(s);
  const res = await fetch(`${base}/trigger/run?key=${ENV.TRIGGER_SECRET}`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.deepEqual(s.starts, ['scheduled']);
});

test('startup fails fast on a wrong board id', async () => {
  const s = setup();
  await assert.rejects(main({ ...ENV, SYSTEM_BOARD_ID: 'fa4e0000000000000000dead' }, { trello: s.trello, starter: s.starter, listen: false }));
});

test('startup fails before any Trello call on a partial NORTHFLANK_* set, naming only the missing variables', async () => {
  const s = setup();
  const env = { ...ENV, NORTHFLANK_API_TOKEN: 'nf-token-sample-0123456789', NORTHFLANK_JOB_ID: 'job-sample' };
  await assert.rejects(main(env, { trello: s.trello, listen: false }), (e: Error) => {
    assert.equal(e.message, 'NORTHFLANK_* variables are incomplete: missing NORTHFLANK_PROJECT_ID');
    return true;
  });
  assert.equal(s.fake.requests.length, 0);
});

test('why through the real wiring: ATS and LinkedIn links are read with the guarded fetch only, no child process', async () => {
  const hits: string[] = [];
  const page = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Event Planner', hiringOrganization: { name: 'Sample Events' },
    description: `<p>${'Plan events and workshops for our venue. '.repeat(10)}</p>`,
  })}</script></head><body></body></html>`;
  const jobs = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise<void>((r) => jobs.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => jobs.close(() => r())));
  const port = (jobs.address() as AddressInfo).port;

  const s = setup();
  const lookups: string[] = [];
  const { say } = await start(s, {
    urlGuard: {
      lookup: async (host) => { lookups.push(host); return [{ address: '127.0.0.1', family: 4 }]; },
      allow: (ip) => ip === '127.0.0.1',
    },
  });

  const spawned: unknown[] = [];
  const onSpawn = (m: unknown) => spawned.push(m);
  subscribe('child_process', onSpawn);
  try {
    for (const path of ['/boards.greenhouse.io/acme/jobs/9001', '/linkedin.com/jobs/view/1234567']) {
      const link = `http://jobs.example:${port}${path}`;
      assert.match(jobKey(link), /^(greenhouse|linkedin):/);
      await say(`@samplebot why ${link}`);
      const reply = s.fake.commentsOn(JOB_CARD).at(-1)!;
      assert.match(reply, /Rejected by rule|No filter rejects it/, reply);
    }
  } finally {
    unsubscribe('child_process', onSpawn);
  }
  assert.deepEqual(spawned, []);
  assert.deepEqual(hits, ['/boards.greenhouse.io/acme/jobs/9001', '/linkedin.com/jobs/view/1234567']);
  assert.ok(lookups.every((h) => h === 'jobs.example'));
});

test('end to end: the trigger and @samplebot run at once → one run started', async () => {
  const s = setup();
  let running = false;
  const starter = {
    // The answer reflects the moment of the call, like a platform API that is slow to reply.
    isRunning: async () => { const r = running; await new Promise((ok) => setTimeout(ok, 100)); return r; },
    start: async (t: RunTrigger) => { s.starts.push(t); running = true; },
  };
  const { base, say } = await start(s, { starter });
  const [res] = await Promise.all([fetch(`${base}/trigger/run?key=${ENV.TRIGGER_SECRET}`, { method: 'POST' }), say('@samplebot run')]);
  assert.equal(s.starts.length, 1);
  const reply = s.fake.commentsOn(JOB_CARD).at(-1)!;
  if (res.status === 202) assert.match(reply, /A run is already in progress/);
  else assert.equal(res.status, 409);
});

test('serve logs the local starter when no NORTHFLANK_* is set', async () => {
  const s = setup();
  const svc = await main(ENV, { trello: s.trello, listen: false, out: (l) => s.logs.push(l) });
  closers.push(svc.close);
  assert.ok(s.logs.includes('starter: local'), s.logs.join('\n'));
});

test('serve logs the northflank starter when all NORTHFLANK_* are set, and no value', async () => {
  const s = setup();
  const nf = { NORTHFLANK_API_TOKEN: 'nf-token-sample-0123456789', NORTHFLANK_PROJECT_ID: 'project-sample', NORTHFLANK_JOB_ID: 'job-sample' };
  const svc = await main({ ...ENV, ...nf }, { trello: s.trello, listen: false, out: (l) => s.logs.push(l) });
  closers.push(svc.close);
  assert.ok(s.logs.includes('starter: northflank'), s.logs.join('\n'));
  for (const v of Object.values(nf)) assert.ok(s.logs.every((l) => !l.includes(v)));
});
