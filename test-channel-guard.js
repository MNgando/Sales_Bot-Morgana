/**
 * Tests for the single-channel allow-list and mention stripping.
 * Run: node test-channel-guard.js
 */

const assert = require('node:assert/strict');
const channelGuard = require('./channel-guard');
const { stripBotMention } = require('./bot');

function main() {
  // ── channel guard ──────────────────────────────────────────────
  process.env.BOT_CHANNEL_ID = 'C0BH2CE7LBB';
  assert.equal(channelGuard.isAllowed('C0BH2CE7LBB'), true, 'allows the configured channel');
  assert.equal(channelGuard.isAllowed('C_OTHER'), false, 'rejects other channels');
  assert.equal(channelGuard.isAllowed(''), false, 'rejects empty');
  assert.equal(channelGuard.isAllowed(undefined), false, 'rejects undefined');
  console.log('✓ channel guard');

  // default when env unset
  delete process.env.BOT_CHANNEL_ID;
  assert.equal(channelGuard.allowedChannelId(), 'C0BH2CE7LBB', 'defaults to POC channel');
  assert.equal(channelGuard.isAllowed('C0BH2CE7LBB'), true, 'default channel allowed');
  console.log('✓ channel guard default');

  // ── mention stripping ──────────────────────────────────────────
  assert.equal(stripBotMention('<@U123> what is up', 'U123'), 'what is up', 'strips leading mention');
  assert.equal(stripBotMention('hey <@U123> there', 'U123'), 'hey there', 'strips inline mention');
  assert.equal(stripBotMention('<@U123>   <@U123> hi', 'U123'), 'hi', 'strips repeated mentions + collapses ws');
  assert.equal(stripBotMention('no mention here', 'U123'), 'no mention here', 'leaves plain text');
  assert.equal(stripBotMention('', 'U123'), '', 'handles empty');
  console.log('✓ mention stripping');

  console.log('\nAll channel-guard tests passed.');
}

main();
