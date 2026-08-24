/**
 * Slack Block Kit rendering for the bot's answer.
 *
 * Simplified from the internal signal-bot's ticket-format.buildSlackBlocks —
 * Morgana posts a plain answer plus a compact "Sources" context line noting
 * which read-only tools were consulted.
 */

// Slack section text blocks have a 3000-char limit; split a long answer across
// several section blocks so nothing gets dropped.
function chunk(text, size = 2900) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.6) cut = size; // no nearby newline — hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out.length ? out : [' '];
}

// Map internal tool names to friendly source labels for the context line.
const TOOL_LABELS = {
  jira_search: 'Jira',
  confluence_search: 'Confluence',
  github_search_code: 'GitHub',
  github_search_repos: 'GitHub',
  github_get_readme: 'GitHub',
  slack_search: 'Slack',
  istari_query: 'Istari',
};

function sourceLabels(toolsUsed = []) {
  const labels = [];
  for (const t of toolsUsed) {
    const label = TOOL_LABELS[t] || t;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function buildBlocks(answer, toolsUsed = []) {
  const blocks = chunk(answer).map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  }));

  const labels = sourceLabels(toolsUsed);
  if (labels.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📚 Sources: ${labels.join(', ')}` }],
    });
  }
  return blocks;
}

module.exports = { buildBlocks, sourceLabels, chunk };
