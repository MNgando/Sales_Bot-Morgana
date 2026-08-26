/**
 * Tests for the Markdown -> Slack mrkdwn converter and block builder.
 * Run: node test-format.js
 */

const assert = require('node:assert/strict');
const { mdToMrkdwn, buildBlocks, chunk } = require('./format');

function main() {
  // ── bold ──────────────────────────────────────────────────────────────────
  assert.equal(mdToMrkdwn('**Deal** closed'), '*Deal* closed', 'bold ** -> *');
  assert.equal(mdToMrkdwn('__Deal__'), '*Deal*', 'bold __ -> *');

  // ── links: [text](url) -> <url|text> ──────────────────────────────────────
  assert.equal(
    mdToMrkdwn('see [HubSpot](https://app.hubspot.com/x/1)'),
    'see <https://app.hubspot.com/x/1|HubSpot>',
    'link -> slack link',
  );

  // ── headings -> bold line, no double-asterisks even if already bold ───────
  assert.equal(mdToMrkdwn('## Top Deals'), '*Top Deals*', 'heading -> bold');
  assert.equal(mdToMrkdwn('## **Top**'), '*Top*', 'bold heading not double-wrapped');

  // ── bullets -> • , indentation preserved ──────────────────────────────────
  assert.equal(mdToMrkdwn('- one\n- two'), '• one\n• two', 'dashes -> bullets');
  assert.equal(mdToMrkdwn('- top\n  - sub'), '• top\n  • sub', 'nested bullet keeps indent');

  // ── horizontal rules and table separator rows are dropped ─────────────────
  assert.equal(mdToMrkdwn('a\n---\nb'), 'a\nb', 'hr dropped');
  assert.equal(mdToMrkdwn('| A | B |\n|---|---|\n| 1 | 2 |'), 'A  |  B\n1  |  2', 'table separator dropped, rows kept readable');

  console.log('✓ mdToMrkdwn');

  // ── buildBlocks converts + chunks + adds a Sources context line ───────────
  const blocks = buildBlocks('## Deals\n- **Acme** — [link](https://x.com/a)', ['hubspot_search']);
  const section = blocks.find((b) => b.type === 'section');
  assert.ok(section.text.text.includes('*Deals*'), 'heading converted in blocks');
  assert.ok(section.text.text.includes('• *Acme*'), 'bullet + bold converted');
  assert.ok(section.text.text.includes('<https://x.com/a|link>'), 'link converted');
  const ctx = blocks.find((b) => b.type === 'context');
  assert.ok(ctx && ctx.elements[0].text.includes('HubSpot'), 'sources line present');
  console.log('✓ buildBlocks (convert + sources)');

  // chunk keeps every block within Slack's 3000-char section limit
  const big = 'x'.repeat(10000);
  assert.ok(chunk(big).every((c) => c.length <= 2900), 'chunks stay under 2900');
  console.log('✓ chunk size cap');

  console.log('\nAll format tests passed.');
}

main();
