/**
 * Slack Block Kit rendering for the bot's answer.
 *
 * Simplified from the internal signal-bot's ticket-format.buildSlackBlocks —
 * Morgana posts a plain answer plus a compact "Sources" context line noting
 * which read-only tools were consulted.
 *
 * Claude replies in standard Markdown, but Slack uses its own "mrkdwn" — so
 * `## heading`, `**bold**`, `[text](url)`, and tables render as literal junk in
 * Slack. `mdToMrkdwn` translates them to what Slack actually renders.
 */

// Convert common Markdown to Slack mrkdwn so answers read cleanly in Slack.
function mdToMrkdwn(md) {
  let s = String(md || '').replace(/\r\n/g, '\n');

  // Links [text](url) -> <url|text>  (do this first, before touching asterisks)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');

  // Bold **text** / __text__ -> *text* (Slack bold is a single asterisk)
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '*$1*');
  s = s.replace(/__([^\n_]+)__/g, '*$1*');

  const out = [];
  for (let line of s.split('\n')) {
    // Horizontal rules (---, ***, ___) -> drop (Slack shows them literally)
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue;
    // Markdown table separator row (|---|:--:|) -> drop
    if (line.includes('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) continue;
    // Headings (#..######) -> bold line (Slack has no headings)
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) { out.push(`*${h[1].trim().replace(/^\*+|\*+$/g, '')}*`); continue; }
    // Bullets (-, *, +) -> • , preserving indentation
    line = line.replace(/^(\s*)[-*+]\s+/, (_m, indent) => `${indent}• `);
    // Remaining table rows: | a | b | c | -> a  |  b  |  c
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  |  ');
    }
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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
  hubspot_search: 'HubSpot',
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

// Slack allows at most 50 blocks per message. Cap sections well under that
// (leaving room for the context block) so a very long answer can't overflow.
const MAX_SECTIONS = 45;

function buildBlocks(answer, toolsUsed = []) {
  const pieces = chunk(mdToMrkdwn(answer));
  const trimmed = pieces.length > MAX_SECTIONS;
  const kept = trimmed ? pieces.slice(0, MAX_SECTIONS) : pieces;
  const blocks = kept.map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  }));
  if (trimmed) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '…(answer trimmed to fit Slack)' }] });
  }

  const labels = sourceLabels(toolsUsed);
  if (labels.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📚 Sources: ${labels.join(', ')}` }],
    });
  }
  return blocks;
}

module.exports = { buildBlocks, sourceLabels, chunk, mdToMrkdwn };
