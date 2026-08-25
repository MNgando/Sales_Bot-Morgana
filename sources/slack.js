/**
 * Slack source — READ-ONLY message search.
 *
 * Two modes, picked automatically:
 *   1. If SLACK_USER_TOKEN (xoxp-) is set → real workspace search via
 *      search.messages (bot tokens can't call it). Searches as that user.
 *   2. Otherwise → fall back to reading recent history of BOT_CHANNEL_ID via
 *      conversations.history (bot token) and filtering locally. No cross-channel
 *      search, recent messages only.
 *
 * Only read methods are used. Requires SLACK_BOT_TOKEN (always present when the
 * bot runs); the user token just widens what it can see.
 */

const fetch = require('node-fetch');
const { real } = require('./env');

const NAME = 'slack';
const API = 'https://slack.com/api';

function hasUserToken() {
  return !!real('SLACK_USER_TOKEN');
}

function isEnabled() {
  return !!real('SLACK_BOT_TOKEN');
}

async function slackGet(method, token, params) {
  const url = new URL(`${API}/${method}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await resp.json();
  if (!data.ok) return { ok: false, error: `Slack ${method} error: ${data.error || 'unknown'}` };
  return { ok: true, data };
}

async function searchWorkspace(query, limit) {
  const r = await slackGet('search.messages', process.env.SLACK_USER_TOKEN, {
    query,
    count: limit,
    sort: 'timestamp',
  });
  if (!r.ok) return r;
  const matches = (r.data.messages?.matches || []).slice(0, limit).map((m) => ({
    text: m.text || '',
    user: m.username || m.user || '',
    channel: m.channel?.name ? `#${m.channel.name}` : m.channel?.id || '',
    ts: m.ts,
    url: m.permalink || '',
  }));
  return { ok: true, mode: 'search', count: matches.length, matches };
}

async function searchChannelHistory(query, limit) {
  const channel = process.env.BOT_CHANNEL_ID || 'C0BH2CE7LBB';
  const r = await slackGet('conversations.history', process.env.SLACK_BOT_TOKEN, {
    channel,
    limit: 200,
  });
  if (!r.ok) return r;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r.data.messages || [])
    .filter((m) => m.text && terms.some((t) => m.text.toLowerCase().includes(t)))
    .slice(0, limit)
    .map((m) => ({ text: m.text, user: m.user || '', ts: m.ts }));
  return {
    ok: true,
    mode: 'channel-history',
    note: 'No SLACK_USER_TOKEN set — searched only recent history of the bot channel.',
    count: matches.length,
    matches,
  };
}

const toolDef = {
  name: 'slack_search',
  description:
    'Search Slack messages (read-only). Use to find prior discussions, decisions, ' +
    'or answers already given in Slack. With a user token this searches the whole ' +
    'workspace and supports Slack SEARCH OPERATORS you can combine into `query` — ' +
    'e.g. `in:#customer-hermeus`, `from:@jane`, `after:2026-06-01`, `before:2026-07-01`, ' +
    '`has:link` — so you can scope by channel, person, or date. Without a user token ' +
    'it falls back to recent history of the bot channel only.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text and/or operators (in:/from:/after:/before:/has:).' },
      limit: { type: 'integer', description: 'Max results (default 15, max 25).' },
    },
    required: ['query'],
  },
};

async function execute(input = {}) {
  const { query = '' } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 25);
  return hasUserToken()
    ? searchWorkspace(query, limit)
    : searchChannelHistory(query, limit);
}

module.exports = {
  name: NAME,
  isEnabled,
  tools: [{ ...toolDef, run: execute }],
};
