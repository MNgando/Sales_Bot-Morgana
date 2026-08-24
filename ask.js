#!/usr/bin/env node
/**
 * ask.js — Tier 2 test harness: ask the bot one question from the command line,
 * without standing up Slack.
 *
 * It runs the exact same brain as the live bot — `answerQuestion` from claude.js,
 * driving the real Claude tool-use loop against the real read-only sources
 * (whichever have credentials in .env). Use it to validate Claude + your source
 * wiring before dealing with Slack app setup.
 *
 * Everything it touches is READ-ONLY (same invariant the sources enforce).
 *
 * Usage:
 *   node ask.js "What are the open SIGNAL tickets for Hermeus?"
 *   node ask.js --verbose "..."   # developer trace: each tool call + raw result
 *   npm run ask -- "your question"
 *
 * Requires (in .env): CLAUDE_API_KEY, plus the creds for whichever sources you
 * want reachable (JIRA_*, GITHUB_TOKEN, SLACK_USER_TOKEN, ISTARI_API_*).
 */

require('dotenv').config();
const { answerQuestion, CLAUDE_MODEL } = require('./claude');
const sources = require('./sources');

async function main() {
  // --verbose / -v is a developer diagnostic: it traces tool calls + raw results
  // to stderr (via claude.js), and never changes the answer text. Strip it out of
  // the args before assembling the question.
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const question = args.filter((a) => a !== '--verbose' && a !== '-v').join(' ').trim();

  if (!question) {
    console.error('Usage: node ask.js [--verbose] "your question"');
    process.exit(2);
  }

  if (!process.env.CLAUDE_API_KEY || process.env.CLAUDE_API_KEY.startsWith('sk-ant-your')) {
    console.error('✖ CLAUDE_API_KEY is not set in .env — this harness calls the real Claude API.');
    process.exit(2);
  }

  const enabled = sources.enabledSources();
  console.log(`\n🧠 model:   ${CLAUDE_MODEL}`);
  console.log(`🔌 sources: ${enabled.length ? enabled.join(', ') : '(none — check your .env credentials)'}`);
  console.log(`❓ question: ${question}\n`);

  const started = Date.now();
  try {
    const { text, toolsUsed } = await answerQuestion(question, { debug: verbose });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log('─'.repeat(60));
    console.log(text);
    console.log('─'.repeat(60));
    console.log(`\n🛠️  tools used: ${toolsUsed.length ? toolsUsed.join(', ') : '(none — answered directly)'}`);
    console.log(`⏱️  ${secs}s\n`);
  } catch (err) {
    console.error(`\n✖ Failed: ${err.message}\n`);
    process.exit(1);
  }
}

main();
