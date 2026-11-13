import test from 'node:test';
import assert from 'node:assert/strict';
import { afterTrigger, commandText, mayStartWithKeyword } from '../../src/bot/command.ts';

const T = { botUsername: 'samplebot', keyword: '/bot' };

test('afterTrigger: a leading keyword, any case, after blank lines', () => {
  assert.equal(afterTrigger('/bot fit', T), ' fit');
  assert.equal(afterTrigger('/BOT fit', T), ' fit');
  assert.equal(afterTrigger('  \n/bot fit', T), ' fit');
  assert.equal(afterTrigger('/bot', T), '');
  assert.equal(afterTrigger('/bot\nfeedback', T), '\nfeedback');
});

test('afterTrigger: a leading @<botUsername> still counts', () => {
  assert.equal(afterTrigger('@samplebot fit', T), ' fit');
  assert.equal(afterTrigger('@SampleBot', T), '');
});

test('afterTrigger: only a whole first token counts', () => {
  for (const text of ['/botfit', 'please ask /bot fit', '/bot, fit', 'bot fit', '@samplebot2 fit', 'x@samplebot.de fit', 'hey @samplebot fit', '']) {
    assert.equal(afterTrigger(text, T), null, JSON.stringify(text));
  }
});

test('afterTrigger: a custom keyword replaces /bot and is matched literally', () => {
  const jobs = { ...T, keyword: '/jobs' };
  assert.equal(afterTrigger('/jobs fit', jobs), ' fit');
  assert.equal(afterTrigger('/bot fit', jobs), null);
  assert.equal(afterTrigger('@samplebot fit', jobs), ' fit');
  assert.equal(afterTrigger('/my-bot fit', { ...T, keyword: '/my-bot' }), ' fit');
  assert.equal(afterTrigger('/myxbot fit', { ...T, keyword: '/my-bot' }), null);
});

test('commandText: the request without the leading keyword and without any mention of the bot', () => {
  assert.equal(commandText('@samplebot am I a fit? cc @SampleBot and @samplebot_2', T), 'am I a fit? cc and @samplebot_2');
  assert.equal(commandText('/bot am I a fit? cc @SampleBot', T), 'am I a fit? cc');
  assert.equal(commandText('/Bot  why\tnot /bot here?', T), 'why not /bot here?');
  assert.equal(commandText('/botany question', T), '/botany question');
});

test('mayStartWithKeyword: whether the first token could be any valid keyword', () => {
  for (const text of ['/bot fit', '  /jobs', '/Bot-2 x']) assert.equal(mayStartWithKeyword(text), true, text);
  for (const text of ['', '   ', 'open', 'ok then', 'bot fit', '- item', '1. first', '/bot, fit', '@samplebot fit', `/${'a'.repeat(20)}`]) {
    assert.equal(mayStartWithKeyword(text), false, JSON.stringify(text));
  }
});
