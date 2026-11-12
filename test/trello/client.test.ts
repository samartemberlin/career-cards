import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrelloClient, TrelloError } from '../../src/trello/client.ts';
import type { FetchLike } from '../../src/trello/client.ts';

// --- fake clock / sleep --------------------------------------------------

function makeClock(startMs = 0) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => { now += ms; },
    sleeps,
  };
}

// --- fetch helpers -------------------------------------------------------

type FetchArgs = [url: URL, init?: RequestInit];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function statusResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

/** Build a fetchImpl that cycles through the given responses. Captures all calls. */
function makeFetch(responses: Response[]) {
  const calls: FetchArgs[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push([url, init]);
    const r = responses[i++];
    if (!r) throw new Error(`fetchImpl: no response for call ${i}`);
    return r;
  };
  return { fetchImpl, calls };
}

// --- auth tests ----------------------------------------------------------

test('sends auth in the header, never in the URL', async () => {
  const { fetchImpl, calls } = makeFetch([okJson({ id: 'u1', username: 'alice' })]);
  const clock = makeClock();
  const client = createTrelloClient({
    key: 'KEYSECRET123',
    token: 'TOKSECRET456',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await client.me();
  assert.equal(calls.length, 1);
  const [url, init] = calls[0]!;
  const urlStr = String(url);
  assert.ok(!urlStr.includes('KEYSECRET123'), 'key must not appear in URL');
  assert.ok(!urlStr.includes('TOKSECRET456'), 'token must not appear in URL');
  const authHeader = (init?.headers as Record<string, string>)?.['authorization'] ?? '';
  assert.equal(authHeader, 'OAuth oauth_consumer_key="KEYSECRET123", oauth_token="TOKSECRET456"');
});

// --- pacing tests --------------------------------------------------------

test('paces to maxPer10s', async () => {
  // 81 calls: the 81st must start ≥ 10,000 ms after the 1st
  const responses = Array.from({ length: 81 }, () => okJson({ id: 'u', username: 'u' }));
  const { fetchImpl } = makeFetch(responses);
  const clock = makeClock();

  // We track how much fake time has elapsed when each call starts.
  const startTimes: number[] = [];
  const origFetch = fetchImpl;
  const wrappedFetch: FetchLike = async (url, init) => {
    startTimes.push(clock.now());
    return origFetch(url, init);
  };
  const client2 = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl: wrappedFetch,
    sleep: clock.sleep,
    now: clock.now,
    maxPer10s: 80,
  });

  for (let i = 0; i < 81; i++) {
    await client2.me();
  }

  assert.ok(startTimes.length === 81, `expected 81 calls, got ${startTimes.length}`);
  const firstStart = startTimes[0]!;
  const lastStart = startTimes[80]!;
  assert.ok(
    lastStart - firstStart >= 10000,
    `81st call started at ${lastStart}, 1st at ${firstStart}; gap ${lastStart - firstStart} < 10000`,
  );
});

// --- retry tests ---------------------------------------------------------

test('retries 429 for POST then succeeds', async () => {
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch([
    statusResponse(429, 'rate limit'),
    statusResponse(429, 'rate limit'),
    okJson({ id: 'c1', name: 'Job', desc: '', idList: 'l1', idBoard: 'b1', closed: false, pos: 0, shortUrl: 'https://trello.com/c/sample001' }),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  const card = await client.createCard({ idList: 'l1', name: 'Job', desc: '', pos: 'bottom' });
  assert.equal(card.id, 'c1');
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [2000, 4000]);
});

test('gives up after 4 retries', async () => {
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch([
    statusResponse(429, 'rate limit'),
    statusResponse(429, 'rate limit'),
    statusResponse(429, 'rate limit'),
    statusResponse(429, 'rate limit'),
    statusResponse(429, 'rate limit'),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    () => client.me(),
    (err: unknown) => {
      assert.ok(err instanceof TrelloError);
      assert.equal(err.status, 429);
      return true;
    },
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(clock.sleeps, [2000, 4000, 8000, 16000]);
});

test('createCard is not retried on 502', async () => {
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch([
    statusResponse(502, 'bad gateway'),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    () => client.createCard({ idList: 'l1', name: 'Job', desc: '', pos: 'bottom' }),
    (err: unknown) => {
      assert.ok(err instanceof TrelloError);
      assert.equal(err.status, 502);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'POST must not be retried on 502');
  assert.equal(clock.sleeps.length, 0);
});

test('GET is retried on 503 and on a network error', async () => {
  const clock = makeClock();
  // First call: network error; second: 503; third: success
  const networkError = new Error('connection refused');
  let callCount = 0;
  const fetchImpl: FetchLike = async (_url, _init) => {
    callCount++;
    if (callCount === 1) throw networkError;
    if (callCount === 2) return statusResponse(503, 'unavailable');
    return okJson({ id: 'u1', username: 'alice' });
  };
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  const member = await client.me();
  assert.equal(member.id, 'u1');
  assert.equal(callCount, 3);
  assert.deepEqual(clock.sleeps, [2000, 4000]);
});

// --- error message leakage -----------------------------------------------

test('error message never contains key or token', async () => {
  const clock = makeClock();
  // Body echoes both in the query string
  const body = 'key=KEYSECRET123&token=TOKSECRET456 error from server';
  const { fetchImpl } = makeFetch([statusResponse(401, body)]);
  const client = createTrelloClient({
    key: 'KEYSECRET123', token: 'TOKSECRET456',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    () => client.me(),
    (err: unknown) => {
      assert.ok(err instanceof TrelloError);
      assert.ok(!err.message.includes('KEYSECRET123'), 'message must not contain key');
      assert.ok(!err.message.includes('TOKSECRET456'), 'message must not contain token');
      return true;
    },
  );
});

// --- allCards paging tests -----------------------------------------------

function makeCard(id: string): object {
  return { id, name: `Job ${id}`, desc: '', idList: 'l1', idBoard: 'b1', closed: false, pos: 0, shortUrl: `https://trello.com/c/sample${id.slice(-3)}` };
}

/** Make N sequential fake card ids (lexicographically smallest = oldest) */
function makeCards(n: number, startAt = 1): object[] {
  return Array.from({ length: n }, (_, i) => makeCard(String(startAt + i).padStart(24, '0')));
}

test('allCards pages with before = oldest id of the page', async () => {
  const page1 = makeCards(1000, 2000);  // ids 000...002000 to 000...002999
  const page2 = makeCards(1000, 1000);  // ids 000...001000 to 000...001999
  const page3 = makeCards(3, 1);        // ids 000...000001 to 000...000003
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch([
    okJson(page1),
    okJson(page2),
    okJson(page3),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  const cards = await client.allCards('b1');
  assert.equal(cards.length, 2003);

  // First request: no before; filter is in the path, not the query
  const url1 = new URL(String(calls[0]![0]));
  assert.ok(!url1.searchParams.has('before'), 'first request must not have before');
  assert.ok(url1.pathname.endsWith('/all'), 'allCards must request the /all filter path');
  assert.equal(url1.searchParams.get('limit'), '1000');

  // Second request: before = smallest id of page1
  const url2 = new URL(String(calls[1]![0]));
  const page1Ids = (page1 as { id: string }[]).map((c) => c.id).sort();
  assert.equal(url2.searchParams.get('before'), page1Ids[0]);

  // Third request: before = smallest id of page2
  const url3 = new URL(String(calls[2]![0]));
  const page2Ids = (page2 as { id: string }[]).map((c) => c.id).sort();
  assert.equal(url3.searchParams.get('before'), page2Ids[0]);
});

test('allCards with exactly 1,000 cards makes one extra empty request and stops', async () => {
  const page1 = makeCards(1000, 1);
  const clock = makeClock();
  const { fetchImpl, calls } = makeFetch([
    okJson(page1),
    okJson([]),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  const cards = await client.allCards('b1');
  assert.equal(cards.length, 1000);
  assert.equal(calls.length, 2, 'must make one extra empty request');
});

test('allCards throws when before does not move', async () => {
  // All pages return the same ids — smallest never changes
  const page = makeCards(1000, 1);
  const clock = makeClock();
  const { fetchImpl } = makeFetch([
    okJson(page),
    okJson(page),
    okJson(page),
    okJson(page),
    okJson(page),
  ]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    () => client.allCards('b1'),
    /before.*did not move|did not advance|stuck/i,
  );
});

// --- timeout signal per attempt ------------------------------------------

test('each retry attempt gets a fresh AbortSignal', async () => {
  const signals: AbortSignal[] = [];

  // A fetchImpl that captures the signal from each attempt and fails twice, then succeeds.
  let callCount = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    if (init?.signal) signals.push(init.signal as AbortSignal);
    callCount++;
    if (callCount < 3) return statusResponse(503, 'unavailable');
    return okJson({ id: 'u1', username: 'alice' });
  };

  const clock = makeClock();
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await client.me();

  assert.equal(signals.length, 3, 'three attempts, three signals');
  // All signals must be distinct objects — a shared signal would be the same reference.
  assert.notEqual(signals[0], signals[1], 'attempt 1 and 2 must have distinct signals');
  assert.notEqual(signals[1], signals[2], 'attempt 2 and 3 must have distinct signals');
  assert.notEqual(signals[0], signals[2], 'attempt 1 and 3 must have distinct signals');
});

test('a timed-out attempt is retried like a network error (GET)', async () => {
  let callCount = 0;
  // First call throws an AbortError (timeout); second succeeds.
  const fetchImpl: FetchLike = async (_url, _init) => {
    callCount++;
    if (callCount === 1) {
      const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      throw err;
    }
    return okJson({ id: 'u1', username: 'alice' });
  };

  const clock = makeClock();
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  const member = await client.me();
  assert.equal(member.id, 'u1', 'GET should succeed after a timeout retry');
  assert.equal(callCount, 2);
});

// --- no card edits -------------------------------------------------------

test('the client has no method that edits a card: cards are only created, archived, commented on or given attachments', () => {
  const client = createTrelloClient({ key: 'k', token: 't', fetchImpl: async () => okJson({}) });
  assert.deepEqual(Object.keys(client).sort(), [
    'addCheckItem', 'allCards', 'attachText', 'board', 'boardMembers', 'card', 'cards', 'checklist', 'comment',
    'createBoard', 'createCard', 'createChecklist', 'createLabel', 'createList', 'labels', 'list', 'lists', 'me',
    'myOrganizations', 'organizationMembers', 'setCardClosed', 'setListClosed',
  ].sort(), 'a new client method: if it edits a card, it must not exist');
});

test('createCard sends only the NewCard fields: an extra key such as idCardSource never reaches Trello', async () => {
  const card = { id: 'c1', name: 'Job', desc: 'd', idList: 'l1', idBoard: 'b1', closed: false, pos: 1, shortUrl: 'https://trello.com/c/sample001' };
  const { fetchImpl, calls } = makeFetch([okJson(card)]);
  const client = createTrelloClient({ key: 'k', token: 't', fetchImpl, sleep: async () => {} });
  const full = {
    idList: 'l1', name: 'Job', desc: 'd', pos: 'bottom' as const, idLabels: ['x'], start: '2026-11-01', due: '2026-12-01T12:00:00.000Z',
  };
  await client.createCard({ ...full, idCardSource: 'existing', keepFromSource: 'all', closed: true } as typeof full);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]![1]!.body as string), full);
  assert.ok(!calls[0]![0].search.includes('idCardSource'), 'not in the query either');
});

// --- schema validation tests ---------------------------------------------

test('drops unknown fields and rejects a malformed card', async () => {
  const clock = makeClock();
  // A valid card with an extra unknown field
  const validCard = {
    id: 'c1', name: 'Job', desc: '', idList: 'l1', idBoard: 'b1',
    closed: false, pos: 0, shortUrl: 'https://trello.com/c/sample001',
    unknownField: 'should be dropped',
  };
  // A malformed card: missing id
  const malformedCard = {
    name: 'No id', desc: '', idList: 'l1', idBoard: 'b1',
    closed: false, pos: 0, shortUrl: 'https://trello.com/c/sample002',
  };
  const { fetchImpl } = makeFetch([okJson([validCard, malformedCard])]);
  const client = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
  await assert.rejects(
    () => client.cards('b1', { filter: 'all' }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Zod error should name the path of the missing field (e.g. "[1]" and "id")
      assert.ok(
        err.message.includes('[1]') || err.message.includes('"id"') || err.message.toLowerCase().includes('id'),
        `expected error to name the path, got: ${err.message}`,
      );
      return true;
    },
  );
  // A single valid card should work, with unknown fields stripped
  const { fetchImpl: fetchImpl2 } = makeFetch([okJson([validCard])]);
  const client2 = createTrelloClient({
    key: 'k', token: 't',
    fetchImpl: fetchImpl2,
    sleep: clock.sleep,
    now: clock.now,
  });
  const cards = await client2.cards('b1', { filter: 'all' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.id, 'c1');
  assert.ok(!('unknownField' in cards[0]!), 'unknown fields must be stripped');
});
