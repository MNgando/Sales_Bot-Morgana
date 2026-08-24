/**
 * Hard restriction: the bot only answers in the one designated channel,
 * regardless of which channels/DMs it may technically be invited to.
 *
 * Defense-in-depth on top of not inviting the bot elsewhere — Slack app
 * installs are workspace-wide by default. Extracted (vs. an inline check) so
 * the rule is unit-tested.
 */

const DEFAULT_CHANNEL_ID = 'C0BH2CE7LBB';

function allowedChannelId() {
  // Resolved at call time so a config change is a restart, not a code edit.
  return process.env.BOT_CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function isAllowed(channelId) {
  return !!channelId && channelId === allowedChannelId();
}

module.exports = { isAllowed, allowedChannelId, DEFAULT_CHANNEL_ID };
