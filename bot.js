/**
 * Istari Sales Bot Morgana ("Morgana") — entry point.
 *
 * A read-only Slack Q&A bot. Answers in one channel via a Claude tool-use loop
 * over read-only sources (Jira/Confluence/GitHub/Slack), replying in-thread.
 *
 * Conversation model:
 *   - A top-level @-mention starts a conversation (the bot replies in a thread).
 *   - Any reply IN THAT THREAD is then treated as a follow-up and answered
 *     WITHOUT needing another @-mention — the bot carries the thread as context.
 *   - The bot only follows up in threads it is already part of; it never answers
 *     random channel chatter or threads it hasn't participated in.
 *
 * Slack plumbing (Bolt Socket Mode, single-channel gate, "Thinking…" ack +
 * in-place update, dedup replay guard, resilient startup) is modeled on the
 * internal signal-bot.
 *
 * Required environment (see .env.template):
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, CLAUDE_API_KEY,
 *   BOT_CHANNEL_ID, plus per-source creds (JIRA_*, GITHUB_TOKEN, ...).
 */

require('dotenv').config();
const { App } = require('@slack/bolt');
const channelGuard = require('./channel-guard');
const { isProcessed, markProcessed } = require('./dedup');
const { answerQuestion } = require('./claude');
const { buildBlocks } = require('./format');
const sources = require('./sources');

// Strip every <@BOT_USER_ID> tag from a message and collapse whitespace, so the
// mention doesn't pollute the question sent to Claude. Pure — unit-testable.
function stripBotMention(text, botUserId) {
  if (!text) return '';
  if (!botUserId) return text.replace(/\s+/g, ' ').trim();
  return text.split(`<@${botUserId}>`).join('').replace(/\s+/g, ' ').trim();
}

// One message is "ours" (Morgana's) if it was posted by the bot user or by any
// app/bot integration. Used both to skip our own events and to detect whether we
// are already participating in a thread.
function isBotMessage(m, botUserId) {
  return !!(m.bot_id || (botUserId && m.user === botUserId));
}

// How many of the most recent thread turns to feed Claude as context. Bounds the
// token cost on long threads while always keeping the RECENT turns (the ones that
// matter for a follow-up). ~30 turns is plenty for a Slack Q&A thread.
const MAX_HISTORY_TURNS = 30;

// Fetch a thread's messages (oldest→newest), paginating so we get the WHOLE thread
// — Slack returns pages oldest-first, so a single small page would miss the recent
// turns in a long thread, which is exactly the context we most need. Bounded to a
// few pages so a runaway thread can't stall the reply. [] on error (best-effort).
async function fetchThreadMessages(client, channel, threadTs) {
  if (!threadTs) return [];
  const all = [];
  let cursor;
  try {
    for (let page = 0; page < 5; page++) {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: 100, cursor });
      if (res.messages) all.push(...res.messages);
      cursor = res.response_metadata && res.response_metadata.next_cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn(`⚠️  Could not fetch thread: ${err.message}`);
  }
  return all;
}

// Turn raw thread messages into Claude turns, keeping only those posted BEFORE the
// triggering message (so the ack and the trigger itself are excluded). Bot messages
// map to `assistant`, everyone else to `user`. Keeps the most recent
// MAX_HISTORY_TURNS turns, and trims any leading assistant turns so the history
// starts with a user turn (the Messages API requires the first message to be user).
function buildHistory(messages, botUserId, beforeTs) {
  const cutoff = parseFloat(beforeTs);
  const turns = messages
    .filter((m) => parseFloat(m.ts) < cutoff)
    .map((m) => ({
      role: isBotMessage(m, botUserId) ? 'assistant' : 'user',
      content: stripBotMention(m.text || '', botUserId),
    }))
    .filter((m) => m.content)
    .slice(-MAX_HISTORY_TURNS);
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

// True if Morgana has already posted in this thread — the gate for answering a
// follow-up that doesn't @-mention the bot.
function botIsInThread(messages, botUserId) {
  return messages.some((m) => isBotMessage(m, botUserId));
}

/**
 * Shared answer flow: post a "Thinking…" ack, run the Claude tool-use loop, and
 * edit the ack in place with the answer (or an error). Used by both the mention
 * path and the thread-follow-up path.
 */
async function answerAndReply({ client, channel, threadTs, question, history, who }) {
  console.log(`\n📨 ${who}: "${question.slice(0, 80)}"  [context: ${history.length} prior turns]`);

  let thinking = null;
  try {
    thinking = await client.chat.postMessage({ channel, thread_ts: threadTs, text: '🤔 Thinking…' });
  } catch (err) {
    console.warn(`⚠️  Failed to post thinking ack: ${err.message} — continuing`);
  }
  const respond = (text, blocks) =>
    thinking?.ts
      ? client.chat.update({ channel, ts: thinking.ts, text, blocks })
      : client.chat.postMessage({ channel, thread_ts: threadTs, text, blocks });

  // Send the answer, degrading gracefully if Slack rejects the rich message.
  // A truncated answer (hit max_tokens) can end on a malformed mrkdwn link, and a
  // very long one can exceed a Slack limit — either surfaces as an API error
  // (e.g. msg_too_long). The blocks carry the full content; `text` is a short
  // fallback per Slack guidance. On ANY send error we retry once as plain,
  // hard-truncated text so the user still gets the answer, not a generic failure.
  async function sendAnswer(answer, toolsUsed) {
    const fallback = answer.length > 2900 ? answer.slice(0, 2900) + '…' : answer;
    try {
      await respond(fallback, buildBlocks(answer, toolsUsed));
    } catch (err) {
      console.error(`⚠️  Rich reply rejected (${err.message}) — retrying as plain text`);
      const plain = answer.length > 3500 ? answer.slice(0, 3500) + '\n\n…(trimmed to fit Slack)' : answer;
      await respond(plain, undefined);
    }
  }

  try {
    // BOT_DEBUG=true traces tool calls to the SERVER console only (stderr) — an
    // ops diagnostic that never touches the reply text shown to Slack users.
    const { text, toolsUsed } = await answerQuestion(question, {
      history,
      debug: process.env.BOT_DEBUG === 'true',
    });
    await sendAnswer(text, toolsUsed);
    console.log(`✅ Answered (${toolsUsed.length ? toolsUsed.join(', ') : 'no tools'})`);
  } catch (err) {
    console.error('Error answering:', err);
    await respond('Sorry — I ran into an error trying to answer that. Please try again, or let someone know if it keeps happening.');
  }
}

/**
 * app_mention path: an explicit @-mention. Starts a conversation (or continues
 * one when the mention is inside a thread).
 */
async function handleMention({ event, client, context }) {
  if (!channelGuard.isAllowed(event.channel)) return;
  if (isBotMessage(event, context.botUserId)) return;

  if (isProcessed(event.ts)) {
    console.log(`⏭️  Skipping already-processed mention ${event.ts}`);
    return;
  }
  markProcessed(event.ts);

  const botUserId = context.botUserId;
  const question = stripBotMention(event.text, botUserId);
  const threadTs = event.thread_ts || event.ts;

  if (!question) {
    try {
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: "Hi! Ask me a question and I'll look it up." });
    } catch { /* ignore */ }
    return;
  }

  const messages = await fetchThreadMessages(client, event.channel, event.thread_ts);
  const history = buildHistory(messages, botUserId, event.ts);
  await answerAndReply({ client, channel: event.channel, threadTs, question, history, who: `Mention from ${event.user}` });
}

/**
 * message path: a plain message (no @-mention). We answer it ONLY when it is a
 * reply in a thread Morgana already participates in — that's how follow-ups work
 * without re-tagging. Everything else (top-level chatter, threads we're not in,
 * our own posts, edits, mentions handled by app_mention) is ignored.
 */
async function handleMessage({ event, client, context }) {
  // Debug aid: with BOT_DEBUG=true, log EVERY delivered message event before any
  // gate, so "Slack didn't deliver it" is distinguishable from "delivered but
  // filtered out" (wrong channel, no thread, not our thread, etc.). Off by default.
  if (process.env.BOT_DEBUG === 'true') {
    const hasMention = context.botUserId && (event.text || '').includes(`<@${context.botUserId}>`);
    console.log(`👂 msg event: ch=${event.channel} subtype=${event.subtype || '-'} thread_ts=${event.thread_ts || '-'} ts=${event.ts} user=${event.user || '-'} mention=${!!hasMention}`);
  }

  if (!channelGuard.isAllowed(event.channel)) return;
  // Ignore our own posts, other bots, and non-plain messages (edits, joins,
  // file_share subtypes, etc.). A follow-up question is a plain threaded message.
  if (event.subtype) return;
  if (isBotMessage(event, context.botUserId)) return;

  // Only threaded replies qualify (thread_ts present and not the root itself).
  if (!event.thread_ts || event.thread_ts === event.ts) return;

  // Mentions are handled by the app_mention listener — skip here to avoid a
  // double reply (an @-mention fires BOTH app_mention and message events).
  const botUserId = context.botUserId;
  if (botUserId && (event.text || '').includes(`<@${botUserId}>`)) return;

  if (isProcessed(event.ts)) return;

  const messages = await fetchThreadMessages(client, event.channel, event.thread_ts);
  if (!botIsInThread(messages, botUserId)) return; // not our conversation — stay quiet

  markProcessed(event.ts);

  const question = stripBotMention(event.text, botUserId);
  if (!question) return;

  const history = buildHistory(messages, botUserId, event.ts);
  await answerAndReply({ client, channel: event.channel, threadTs: event.thread_ts, question, history, who: `Follow-up from ${event.user}` });
}

function registerHandlers(app) {
  app.event('app_mention', async (args) => {
    try {
      await handleMention(args);
    } catch (err) {
      console.error('Unhandled error in app_mention handler:', err);
    }
  });

  app.message(async (args) => {
    try {
      await handleMessage(args);
    } catch (err) {
      console.error('Unhandled error in message handler:', err);
    }
  });
}

if (require.main === module) {
  (async () => {
    const app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
    });

    registerHandlers(app);

    app.error(async (err) => {
      console.error('Bolt error:', err);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      setTimeout(() => process.exit(1), 1000).unref();
    });

    const shutdown = async (sig) => {
      console.log(`\n${sig} received — shutting down.`);
      try { await app.stop(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await app.start();
    console.log('⚡ Sales Bot Morgana is running (Socket Mode)');
    console.log(`📡 Listening on channel: ${channelGuard.allowedChannelId()}`);
    const enabled = sources.enabledSources();
    console.log(`🔌 Enabled sources: ${enabled.length ? enabled.join(', ') : 'NONE (Claude will answer from its own knowledge only)'}`);
  })();
}

module.exports = {
  stripBotMention,
  isBotMessage,
  buildHistory,
  botIsInThread,
  handleMention,
  handleMessage,
  registerHandlers,
};
