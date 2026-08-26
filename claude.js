/**
 * Claude caller + tool-use loop.
 *
 * The low-level `callClaude` (raw Anthropic Messages REST, retry/backoff + token
 * logging) is ported from the internal signal-bot's `requestClaudeText`. On top
 * of it, `answerQuestion` runs an agentic loop: Claude decides which read-only
 * source tool to call, we execute it (via sources/index.js), feed the result
 * back, and repeat until Claude produces a final text answer.
 *
 * Everything the loop touches (the Claude caller and the sources registry) is
 * injectable so the loop can be unit-tested without network access.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const realSources = require('./sources');

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
// 2048 (~6k chars, still well within Slack's message limits) gives multi-part
// answers room to finish instead of being cut off mid-sentence — a truncated
// answer can end on a malformed mrkdwn link that Slack then rejects.
const CLAUDE_MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS || 2048);
// 0 by default: this is a factual lookup/verification bot, so we want the SAME
// question to pick the same filters and produce the same answer, not vary run to
// run (the API default is 1.0). Configurable if some creativity is ever wanted.
const CLAUDE_TEMPERATURE = Number(process.env.CLAUDE_TEMPERATURE ?? 0);

const CLAUDE_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const CLAUDE_MAX_ATTEMPTS = 3;
const CLAUDE_RETRY_BASE_MS = Number(process.env.CLAUDE_RETRY_BASE_MS || 500);

// How many tool-call rounds before we stop and force a final answer. Guards
// against a loop where Claude keeps calling tools without concluding.
const MAX_TOOL_ROUNDS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are Morgana, the Istari Sales Bot — a READ-ONLY assistant running in a Slack channel.

You answer questions by calling the read-only tools provided (Jira, Confluence, GitHub, Slack, Istari). Rules:
- You are READ-ONLY. You have no ability to create, edit, delete, transition, comment, or send anything. If asked to take such an action, explain that you're read-only and suggest the person do it directly in the relevant tool.
- Ground answers in tool results. Prefer calling a tool over guessing. If the tools return nothing useful, say you couldn't find it rather than speculating.
- If a request is too vague to answer deterministically from the data, ask ONE short clarifying question instead of guessing. This applies when a key term isn't defined by the data (e.g. "at-risk", "best", "important", or "top" with no metric — there is no "at-risk" field), or when the scope or time range is unclear in a way that would materially change the answer (which pipeline/team? open or closed? which time range?). Offer the most likely interpretations as quick options so the person can reply in a few words — they answer right in the thread. Do NOT over-ask: when a reasonable default exists (YTD = Jan 1 to today; "deals" = open deals; whole workspace), proceed with it and STATE the assumption rather than asking. One clarifying question at most; never a back-and-forth interrogation.
- Choose only the tools relevant to the question instead of calling everything.
- Be concise — this is a Slack channel, not a report. Lead with the direct answer, then supporting detail.
- Format for easy reading in Slack: short paragraphs and bullet lists ("- item"); a bold label at the start of a bullet when it helps (e.g. "- **Stage:** ...") — but do NOT use tables (they don't render in Slack) — use bullets instead. Keep headings to a short bold line, not many "#" levels.
- When you reference a specific ticket, page, repo, deal, or message, include its link if the tool returned one, as a Markdown link [label](url). When you list several records, link EVERY item's name — not just some.
- For counts and totals, rely on the tool's reported \`total\`, not just the rows shown. If a result set is truncated (fewer rows returned than \`total\`, or a \`truncated\` flag is set), say the numbers are over a partial set and offer to narrow the filter rather than presenting an incomplete sum as final.
- When a question depends on a date range, state the exact range you used (e.g. "close date 2026-01-01 to today") so the answer is verifiable.`;

// Today's date, injected into the system prompt so the model can resolve relative
// dates correctly. The Anthropic API does NOT tell the model the current date, so
// without this it guesses the year — e.g. reading "YTD as of today" as starting
// 2025-01-01. Computed per call so a long-running process stays correct across
// midnight. Local time (en-CA gives YYYY-MM-DD).
function todayISO() {
  return new Date().toLocaleDateString('en-CA');
}

function systemPrompt() {
  const today = todayISO();
  const year = today.slice(0, 4);
  return (
    `Today's date is ${today}. Resolve every relative date against it: ` +
    `"YTD" / "this year" / "so far" = ${year}-01-01 through ${today}; ` +
    `"as of today" = through ${today}; "last N days", "this quarter", and "recent" ` +
    `are relative to ${today}. Never assume a different year.\n\n${SYSTEM_PROMPT}`
  );
}

/**
 * One raw Anthropic Messages API call. Returns the full parsed response object
 * (content blocks + stop_reason), retrying transient failures with backoff.
 * Throws on a non-retryable status or after the last attempt.
 */
async function callClaude(body) {
  const payload = JSON.stringify(body);
  let lastErr;

  for (let attempt = 1; attempt <= CLAUDE_MAX_ATTEMPTS; attempt++) {
    let resp, data;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: payload,
      });
      data = await resp.json();
    } catch (netErr) {
      lastErr = new Error(`Claude API request failed: ${netErr.message}`);
      if (attempt === CLAUDE_MAX_ATTEMPTS) throw lastErr;
      console.warn(`⏳ Claude request error (attempt ${attempt}/${CLAUDE_MAX_ATTEMPTS}): ${netErr.message} — retrying`);
      await sleep(CLAUDE_RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (resp.ok) {
      if (data.usage) {
        console.log(`💬 Claude tokens: in=${data.usage.input_tokens} out=${data.usage.output_tokens}`);
      }
      return data;
    }

    lastErr = new Error(`Claude API ${resp.status}: ${JSON.stringify(data)}`);
    const retryable = CLAUDE_RETRYABLE_STATUS.has(resp.status) || data?.error?.type === 'overloaded_error';
    if (!retryable || attempt === CLAUDE_MAX_ATTEMPTS) throw lastErr;
    console.warn(`⏳ Claude API ${resp.status} (attempt ${attempt}/${CLAUDE_MAX_ATTEMPTS}) — retrying`);
    await sleep(CLAUDE_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  throw lastErr; // safety; loop either returns or throws above
}

// Compact a value to a single trimmed line for developer trace output.
function truncate(value, max = 800) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > max ? oneLine.slice(0, max) + `… (${oneLine.length} chars)` : oneLine;
}

// Merge consecutive same-role string turns into one. Thread history can contain
// several human messages in a row (or several bot messages), which would violate
// the Messages API's alternating-role requirement once the current question is
// appended. Coalescing keeps the sequence valid without dropping content.
function coalesceTurns(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
      last.content += '\n' + m.content;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

// Concatenate the text blocks of a Claude response.
function extractText(data) {
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
}

/**
 * Answer a question via the tool-use loop.
 *
 * @param {string} question - the user's question (bot mention already stripped)
 * @param {object} [opts]
 * @param {Array<{role,content}>} [opts.history] - prior in-thread turns for context
 * @param {object} [opts.sources] - source registry (defaults to ./sources); injectable for tests
 * @param {function} [opts.caller] - callClaude override; injectable for tests
 * @param {boolean} [opts.debug] - DEVELOPER-ONLY: trace each tool call + raw result
 *   to stderr. Never affects the returned `text`, so it can never leak to Slack.
 * @returns {Promise<{text: string, toolsUsed: string[]}>}
 */
async function answerQuestion(question, opts = {}) {
  const sources = opts.sources || realSources;
  const caller = opts.caller || callClaude;
  const toolDefs = sources.toolDefs();
  const toolsUsed = [];

  // Developer-only trace. Goes to stderr (console.error) so it stays in the
  // operator's terminal/logs and is structurally separate from the answer text
  // returned to the caller — it is impossible for this to reach a Slack user.
  const trace = opts.debug
    ? (label, payload) => console.error(`🔎 ${label}${payload !== undefined ? ' ' + truncate(payload) : ''}`)
    : () => {};

  const messages = coalesceTurns([...(opts.history || []), { role: 'user', content: question }]);

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      temperature: CLAUDE_TEMPERATURE,
      system: systemPrompt(),
      messages,
    };
    if (toolDefs.length) body.tools = toolDefs;

    const data = await caller(body);

    if (data.stop_reason !== 'tool_use') {
      return { text: extractText(data) || "I wasn't able to find an answer to that.", toolsUsed };
    }

    // Record Claude's turn (must be echoed back verbatim before tool_results).
    messages.push({ role: 'assistant', content: data.content });

    // Execute every tool_use block in this turn, in order.
    const toolResults = [];
    for (const block of data.content) {
      if (block.type !== 'tool_use') continue;
      if (!toolsUsed.includes(block.name)) toolsUsed.push(block.name);
      trace(`round ${round} → ${block.name} input:`, block.input);
      const result = await sources.execute(block.name, block.input);
      trace(`round ${round} ← ${block.name} result:`, result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Hit the round cap — make one final call WITHOUT tools to force a conclusion
  // from what we've already gathered.
  const finalData = await caller({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    temperature: CLAUDE_TEMPERATURE,
    system: systemPrompt(),
    messages,
  });
  return { text: extractText(finalData) || "I gathered some information but couldn't conclude.", toolsUsed };
}

module.exports = { answerQuestion, callClaude, extractText, SYSTEM_PROMPT, CLAUDE_MODEL };
