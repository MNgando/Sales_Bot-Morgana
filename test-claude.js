/**
 * Tests for the Claude tool-use loop, with the Claude caller and sources both
 * stubbed — no network, no API key needed. Verifies the loop executes tools,
 * feeds results back, terminates on a text stop, respects the round cap, and
 * works when no tools are enabled.
 * Run: node test-claude.js
 */

const assert = require('node:assert/strict');
const { answerQuestion } = require('./claude');

// A fake sources registry: one tool, canned result, records calls.
function fakeSources(toolNames = ['jira_search']) {
  const executed = [];
  return {
    toolDefs: () => toolNames.map((n) => ({ name: n, description: n, input_schema: { type: 'object', properties: {} } })),
    execute: async (name, input) => {
      executed.push({ name, input });
      return { ok: true, echoed: input };
    },
    executed,
  };
}

// A caller that returns a tool_use turn then a text turn.
function scriptedCaller(script) {
  let i = 0;
  const bodies = [];
  const caller = async (body) => {
    bodies.push(body);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step(body);
  };
  caller.bodies = bodies;
  caller.count = () => i;
  return caller;
}

const toolUseTurn = (name, input) => () => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${name}`, name, input }],
});
const textTurn = (text) => () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

async function main() {
  // ── 1. tool_use → tool_result → final text ────────────────────────────────
  {
    const src = fakeSources(['jira_search']);
    const caller = scriptedCaller([
      toolUseTurn('jira_search', { query: 'login bug' }),
      textTurn('There is one open login bug: CS-1.'),
    ]);
    const { text, toolsUsed } = await answerQuestion('any login bugs?', { sources: src, caller });

    assert.equal(text, 'There is one open login bug: CS-1.', 'returns the final text');
    assert.deepEqual(toolsUsed, ['jira_search'], 'records the tool it used');
    assert.equal(src.executed.length, 1, 'executed the tool once');
    assert.deepEqual(src.executed[0].input, { query: 'login bug' }, 'passed the tool input through');
    // caller round 2 must echo the assistant turn + a tool_result user turn
    const secondBody = caller.bodies[1];
    const roles = secondBody.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user'], 'conversation grew: q, assistant tool_use, tool_result');
    assert.equal(secondBody.messages[2].content[0].type, 'tool_result', 'feeds a tool_result back');
    assert.equal(secondBody.messages[2].content[0].tool_use_id, 'tu_jira_search', 'tool_result references the tool_use id');
    console.log('✓ tool_use → tool_result → final text');
  }

  // ── 2. round cap: caller never stops calling tools → forced final answer ───
  {
    const src = fakeSources(['jira_search']);
    // Always ask for a tool WHEN tools are offered; when the loop drops tools
    // for the forced final call, return text.
    const caller = scriptedCaller([
      (body) => (body.tools ? toolUseTurn('jira_search', { query: 'x' })() : textTurn('Best-effort answer.')()),
    ]);
    const { text } = await answerQuestion('loop forever?', { sources: src, caller });

    assert.equal(text, 'Best-effort answer.', 'forced final call (no tools) concludes');
    assert.equal(caller.count(), 6, 'stopped after 5 tool rounds + 1 forced final call');
    const finalBody = caller.bodies.at(-1);
    assert.equal(finalBody.tools, undefined, 'final call omits tools to force a conclusion');
    console.log('✓ round cap → forced final answer');
  }

  // ── 3. no tools enabled → single call, immediate answer ───────────────────
  {
    const src = fakeSources([]); // no tools
    const caller = scriptedCaller([textTurn('Answer from my own knowledge.')]);
    const { text, toolsUsed } = await answerQuestion('hello', { sources: src, caller });

    assert.equal(text, 'Answer from my own knowledge.');
    assert.deepEqual(toolsUsed, [], 'no tools used');
    assert.equal(caller.count(), 1, 'one call when there are no tools');
    assert.equal(caller.bodies[0].tools, undefined, 'no tools field when none enabled');
    console.log('✓ no tools enabled → direct answer');
  }

  console.log('\nAll Claude tool-loop tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
