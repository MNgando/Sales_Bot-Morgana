/**
 * Tests for the threaded-conversation logic: role/history building and the
 * "only follow up in a thread we're already in" gate.
 */

const assert = require('node:assert/strict');
const { isBotMessage, buildHistory, botIsInThread } = require('./bot');

const BOT = 'U_BOT';

function main() {
  // isBotMessage — by bot_id or by matching bot user id.
  assert.equal(isBotMessage({ bot_id: 'B1' }, BOT), true, 'bot_id ⇒ bot');
  assert.equal(isBotMessage({ user: BOT }, BOT), true, 'bot user id ⇒ bot');
  assert.equal(isBotMessage({ user: 'U_HUMAN' }, BOT), false, 'human ⇒ not bot');
  console.log('✓ isBotMessage');

  const thread = [
    { ts: '100.0', user: 'U_HUMAN', text: '<@U_BOT> what is the latest CS ticket?' },
    { ts: '101.0', user: BOT, bot_id: 'B1', text: 'The latest is CS-4609.' },
    { ts: '102.0', user: 'U_HUMAN', text: 'and who is it assigned to?' }, // the follow-up (trigger)
  ];

  // buildHistory keeps only messages before the trigger, maps roles, strips mention.
  const history = buildHistory(thread, BOT, '102.0');
  assert.deepEqual(
    history,
    [
      { role: 'user', content: 'what is the latest CS ticket?' },
      { role: 'assistant', content: 'The latest is CS-4609.' },
    ],
    'history excludes the trigger, maps roles, strips the mention',
  );
  console.log('✓ buildHistory');

  // botIsInThread — the follow-up gate.
  assert.equal(botIsInThread(thread, BOT), true, 'thread with a bot reply ⇒ we are in it');
  assert.equal(
    botIsInThread([{ ts: '1.0', user: 'U_HUMAN', text: 'humans only' }], BOT),
    false,
    'human-only thread ⇒ we are not in it',
  );
  console.log('✓ botIsInThread');

  console.log('\nAll conversation tests passed.');
}

main();
