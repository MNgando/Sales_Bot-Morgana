/**
 * Source registry.
 *
 * Aggregates every read-only source into the two things the Claude tool-use loop
 * needs: the list of tool definitions to advertise, and a dispatcher to run a
 * tool by name. Only sources whose credentials are present (isEnabled) are wired
 * in — a source with missing config is simply not offered to Claude, so the bot
 * degrades gracefully instead of erroring.
 *
 * Adding a source = drop a module in this folder exporting
 * `{ name, isEnabled(), tools: [{ name, description, input_schema, run }] }`
 * and add it to ALL_SOURCES below.
 */

const jira = require('./jira');
const confluence = require('./confluence');
const github = require('./github');
const slack = require('./slack');
const hubspot = require('./hubspot');
const istari = require('./istari');

const ALL_SOURCES = [jira, confluence, github, slack, hubspot, istari];

// Build the enabled tool map once per process. Env is read at require time; the
// bot restarts on config change (same contract as the rest of the config).
function buildRegistry() {
  const toolDefs = [];
  const runners = new Map(); // toolName -> run(input)
  const enabledSources = [];

  for (const source of ALL_SOURCES) {
    if (!source.isEnabled()) continue;
    enabledSources.push(source.name);
    for (const tool of source.tools) {
      toolDefs.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      });
      runners.set(tool.name, tool.run);
    }
  }

  return { toolDefs, runners, enabledSources };
}

const registry = buildRegistry();

function toolDefs() {
  return registry.toolDefs;
}

function enabledSources() {
  return registry.enabledSources;
}

// Execute a tool by name. Never throws — a failing source returns a structured
// error the model can read and recover from, rather than killing the loop.
async function execute(name, input) {
  const run = registry.runners.get(name);
  if (!run) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await run(input || {});
  } catch (err) {
    return { ok: false, error: `${name} failed: ${err.message}` };
  }
}

module.exports = { toolDefs, execute, enabledSources, buildRegistry, ALL_SOURCES };
