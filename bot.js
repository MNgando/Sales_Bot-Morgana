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

// Fetch up to 20 messages of a thread once. Returns [] on error (context is
// best-effort — a fetch failure must never sink the answer).
async function fetchThreadMessages(client, channel, threadTs) {
  if (!threadTs) return [];
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
    return res.messages || [];
  } catch (err) {
    console.warn(`⚠️  Could not fetch thread: ${err.message}`);
    return [];
  }
}

// Turn raw thread messages into Claude turns, keeping only those posted BEFORE
// the triggering message (so the ack and the trigger itself are excluded). Bot
// messages map to `assistant`, everyone else to `user`.
function buildHistory(messages, botUserId, beforeTs) {
  const cutoff = parseFloat(beforeTs);
  return messages
    .filter((m) => parseFloat(m.ts) < cutoff)
    .map((m) => ({
      role: isBotMessage(m, botUserId) ? 'assistant' : 'user',
      content: stripBotMention(m.text || '', botUserId),
    }))
    .filter((m) => m.content);
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
  console.log(`\n📨 ${who}: "${question.slice(0, 80)}"`);

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

  try {
    // BOT_DEBUG=true traces tool calls to the SERVER console only (stderr) — an
    // ops diagnostic that never touches the reply text shown to Slack users.
    const { text, toolsUsed } = await answerQuestion(question, {
      history,
      debug: process.env.BOT_DEBUG === 'true',
    });
    await respond(text, buildBlocks(text, toolsUsed));
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
