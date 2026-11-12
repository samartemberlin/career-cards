import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, RouterOutputSchema, matchStatic } from '../../src/bot/catalogue.ts';

test('catalogue has exactly the spec rows', () => {
  assert.deepEqual(CATALOGUE.map((s) => [s.id, s.verbs[0], s.stage, s.router]), [
    ['check_open', 'open', 'code', 'auto'],
    ['check_legit', 'legit', 'reader', 'auto'],
    ['apply_needs', 'needs', 'reader', 'auto'],
    ['explain_fit', 'fit', 'advisor', 'auto'],
    ['cv_tips', 'cv', 'advisor', 'auto'],
    ['job_deep_dive', 'deep', 'researcher+advisor', 'auto'],
    ['company_research', 'company', 'researcher', 'auto'],
    ['explain_filter', 'why', 'code', 'auto'],
    ['record_feedback', 'feedback', 'code', 'confirm'],
    ['show_last_run', 'last', 'code', 'auto'],
    ['start_run', 'run', 'code', 'confirm'],
  ]);
});

test('no verb is claimed twice, and none collides with a builtin', () => {
  const verbs = CATALOGUE.flatMap((s) => s.verbs);
  assert.equal(new Set(verbs).size, verbs.length);
  for (const b of ['help', 'yes', 'no', 'hilfe', 'ja', 'nein']) assert.ok(!verbs.includes(b), b);
});

const ok = (action: unknown, reply = '') => RouterOutputSchema.safeParse({ reply, action }).success;

test('router output: unknown action id rejected', () => {
  assert.equal(ok({ id: 'delete_board', args: {} }), false);
});

test('router output: extra key rejected', () => {
  assert.equal(RouterOutputSchema.safeParse({ reply: '', action: null, note: 'x' }).success, false);
  assert.equal(ok({ id: 'check_open', args: {}, extra: 1 }), false);
  assert.equal(ok({ id: 'check_open', args: { url: 'https://example.com' } }), false);
  assert.equal(ok({ id: 'company_research', args: { topic: 'news', more: true } }), false);
});

test('router output: company topic outside enum rejected', () => {
  assert.equal(ok({ id: 'company_research', args: { topic: 'stocks' } }), false);
  assert.equal(ok({ id: 'company_research', args: { topic: 'news' } }), true);
  const r = RouterOutputSchema.parse({ reply: '', action: { id: 'company_research', args: {} } });
  assert.deepEqual(r.action?.args, { topic: 'about' });
});

test('router output: null action with reply accepted', () => {
  assert.equal(ok(null, 'It scored 7 because of the German requirement.'), true);
  assert.equal(ok(null, 'x'.repeat(4001)), false);
});

test('router output: argument sets are closed', () => {
  assert.equal(ok({ id: 'explain_filter', args: { link: 'not a url' } }), false);
  assert.equal(ok({ id: 'explain_filter', args: { link: 'https://jobs.example.com/1' } }), true);
  assert.equal(ok({ id: 'explain_filter', args: { link: 'javascript:alert(1)' } }), false);
  assert.equal(ok({ id: 'record_feedback', args: { text: 'x'.repeat(2001) } }), false);
  assert.equal(ok({ id: 'record_feedback', args: { text: '' } }), false);
});

const action = (comment: string) => {
  const m = matchStatic(comment, 'bot');
  assert.equal(m.kind, 'action', JSON.stringify(m));
  return m as Extract<typeof m, { kind: 'action' }>;
};

test('matchStatic: "@bot company news" → company_research {topic:news}', () => {
  const m = action('@bot company news');
  assert.equal(m.spec.id, 'company_research');
  assert.deepEqual(m.args, { topic: 'news' });
  assert.deepEqual(action('@bot company').args, { topic: 'about' });
  assert.deepEqual(action('@bot firma Locations').args, { topic: 'locations' });
});

test('matchStatic: "@Bot OPEN" → check_open', () => {
  const m = action('@Bot OPEN');
  assert.equal(m.spec.id, 'check_open');
  assert.deepEqual(m.args, {});
  assert.equal(action('  @bot offen').spec.id, 'check_open');
});

test('matchStatic: "@bot company stocks" → bad_args listing the topics', () => {
  const m = matchStatic('@bot company stocks', 'bot');
  assert.equal(m.kind, 'bad_args');
  if (m.kind !== 'bad_args') return;
  assert.equal(m.spec.id, 'company_research');
  for (const t of ['about', 'openings', 'locations', 'news', 'reputation']) assert.match(m.message, new RegExp(t));
});

test('matchStatic: "@bot what is this?" → none', () => {
  assert.deepEqual(matchStatic('@bot what is this?', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('open', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('hey @bot open', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@botany open', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@bot constructor', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@bot toString', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@bot yes, but what about the salary?', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@bot fit why so low?', 'bot'), { kind: 'none' });
  assert.deepEqual(matchStatic('@bot open now please', 'bot'), { kind: 'none' });
});

test('matchStatic: "@bot yes" → builtin yes', () => {
  assert.deepEqual(matchStatic('@bot yes', 'bot'), { kind: 'builtin', name: 'yes' });
  assert.deepEqual(matchStatic('@BOT No', 'bot'), { kind: 'builtin', name: 'no' });
  assert.deepEqual(matchStatic('@bot ja', 'bot'), { kind: 'builtin', name: 'yes' });
  assert.deepEqual(matchStatic('@bot help', 'bot'), { kind: 'builtin', name: 'help' });
});

test('matchStatic: the bot name is matched literally', () => {
  assert.equal(matchStatic('@career.bot open', 'career.bot').kind, 'action');
  assert.deepEqual(matchStatic('@careerXbot open', 'career.bot'), { kind: 'none' });
});

test('matchStatic: arguments', () => {
  assert.deepEqual(action('@bot why https://jobs.example.com/42').args, { link: 'https://jobs.example.com/42' });
  assert.equal(matchStatic('@bot why the rejection?', 'bot').kind, 'bad_args');
  assert.deepEqual(action('@bot feedback  Too senior,\nskip these. ').args, { text: 'Too senior,\nskip these.' });
  assert.equal(matchStatic('@bot feedback', 'bot').kind, 'bad_args');
  assert.equal(matchStatic(`@bot feedback ${'x'.repeat(2001)}`, 'bot').kind, 'bad_args');
});

test('catalogue: every row has a non-empty about', () => {
  for (const s of CATALOGUE) assert.ok(s.about.trim().length > 0, s.id);
});
