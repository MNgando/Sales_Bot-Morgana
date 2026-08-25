/**
 * Tests for the read-only sources + registry, with node-fetch stubbed so no
 * real network calls happen. Also asserts every source uses read-only (GET)
 * requests — a guard against accidentally introducing a write.
 * Run: node test-sources.js
 */

const assert = require('node:assert/strict');

// ── Stub node-fetch BEFORE requiring the sources ────────────────────────────
const nodeFetchPath = require.resolve('node-fetch');
const calls = [];
let nextResponse = { ok: true, status: 200, json: async () => ({}), text: async () => '' };
require.cache[nodeFetchPath] = {
  id: nodeFetchPath,
  filename: nodeFetchPath,
  loaded: true,
  exports: async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    return nextResponse;
  },
};

// ── Configure which sources are enabled (env read at require time) ──────────
process.env.JIRA_URL = 'https://test.atlassian.net';
process.env.JIRA_EMAIL = 'bot@test.com';
process.env.JIRA_API_TOKEN = 'token';
process.env.GITHUB_TOKEN = 'ghtoken';
process.env.GITHUB_ORG = 'test-org';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.HUBSPOT_TOKEN = 'hs-token';
process.env.HUBSPOT_PORTAL_ID = '99999';
delete process.env.SLACK_USER_TOKEN;
delete process.env.ISTARI_API_URL;
delete process.env.ISTARI_API_TOKEN;

const sources = require('./sources');
const jira = require('./sources/jira');
const github = require('./sources/github');
const hubspot = require('./sources/hubspot');
const confluence = require('./sources/confluence');

function jsonResp(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

async function main() {
  // ── registry advertises the enabled tools, not the disabled ones ──────────
  const toolNames = sources.toolDefs().map((t) => t.name);
  for (const expected of ['jira_search', 'confluence_search', 'github_search_code', 'github_search_repos', 'github_get_readme', 'slack_search', 'hubspot_search']) {
    assert.ok(toolNames.includes(expected), `registry advertises ${expected}`);
  }
  assert.ok(!toolNames.includes('istari_query'), 'istari is disabled (no creds) → not advertised');
  assert.deepEqual(
    sources.enabledSources().sort(),
    ['confluence', 'github', 'hubspot', 'jira', 'slack'],
    'enabled sources reflect present creds',
  );
  // every advertised tool has a valid schema
  for (const t of sources.toolDefs()) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.input_schema.type, 'object', `${t.name} has object schema`);
  }
  console.log('✓ registry / tool defs');

  // ── jira_search parses issues and hits the read-only search endpoint ──────
  nextResponse = jsonResp({
    issues: [
      { key: 'CS-1', fields: { summary: 'Login bug', status: { name: 'Open' }, issuetype: { name: 'Bug' }, assignee: { displayName: 'Ana' }, updated: '2026-01-01' } },
    ],
  });
  const jr = await jira.tools[0].run({ query: 'login' });
  assert.equal(jr.ok, true);
  assert.equal(jr.issues[0].key, 'CS-1');
  assert.equal(jr.issues[0].url, 'https://test.atlassian.net/browse/CS-1');
  assert.ok(calls.at(-1).url.includes('/rest/api/3/search/jql'), 'uses the enhanced search endpoint');
  assert.ok(new URL(calls.at(-1).url).searchParams.get('jql').includes('text ~'), 'wraps free text into JQL text search');
  console.log('✓ jira_search');

  // raw JQL passes through untouched
  await jira.tools[0].run({ query: 'project = CS', is_jql: true });
  assert.equal(new URL(calls.at(-1).url).searchParams.get('jql'), 'project = CS', 'passes raw JQL through');
  console.log('✓ jira_search (raw JQL)');

  // ── github_search_code scopes to the org ──────────────────────────────────
  nextResponse = jsonResp({ items: [{ repository: { full_name: 'test-org/repo' }, path: 'src/a.js', html_url: 'https://gh/x' }] });
  const gr = await github.tools.find((t) => t.name === 'github_search_code').run({ query: 'foo' });
  assert.equal(gr.results[0].repo, 'test-org/repo');
  assert.ok(new URL(calls.at(-1).url).searchParams.get('q').includes('org:test-org'), 'scopes search to the org');
  console.log('✓ github_search_code');

  // ── github_search_repos: keyword → search API; no keyword → org repos list ──
  nextResponse = jsonResp({ items: [{ full_name: 'test-org/a', description: 'x', html_url: 'https://gh/a', updated_at: '2026-01-01' }] });
  await github.tools.find((t) => t.name === 'github_search_repos').run({ query: 'bot' });
  assert.ok(calls.at(-1).url.includes('/search/repositories'), 'keyword uses the search API');
  nextResponse = jsonResp([{ full_name: 'test-org/a', description: '', html_url: 'https://gh/a', updated_at: '2026-01-01' }]);
  const repoList = await github.tools.find((t) => t.name === 'github_search_repos').run({});
  assert.ok(calls.at(-1).url.includes('/orgs/test-org/repos'), 'no keyword lists the org repos');
  assert.equal(repoList.results[0].name, 'test-org/a', 'parses the repo list');
  console.log('✓ github_search_repos (search + list)');

  // ── confluence_search: space scoping + list-recent (no query) + raw CQL ────
  nextResponse = jsonResp({ results: [] });
  await confluence.tools[0].run({ space: 'ENG' }); // no query → list recent, scoped
  let cql = new URL(calls.at(-1).url).searchParams.get('cql');
  assert.ok(cql.includes('space = "ENG"'), 'scopes to the space');
  assert.ok(!cql.includes('text ~'), 'no text clause when query omitted');
  await confluence.tools[0].run({ cql: 'label = "runbook"' }); // raw CQL passthrough
  assert.equal(new URL(calls.at(-1).url).searchParams.get('cql'), 'label = "runbook"', 'raw cql overrides');
  console.log('✓ confluence_search (space + list + raw cql)');

  // ── hubspot_search hits the read-only search endpoint (POST /search),
  //    resolves the stage id to a label, and builds a record link ────────────
  // One stubbed body serves both fetches a deals search makes: the pipelines GET
  // reads `results[].stages` (→ stage label map); the search POST reads
  // `results[].id/properties`.
  nextResponse = jsonResp({
    total: 1,
    results: [{
      id: '55',
      properties: { dealname: 'Hermeus Pro License', dealstage: '152780062', amount: '900000' },
      stages: [{ id: '152780062', label: 'Contract Sent' }],
    }],
  });
  const hs = await hubspot.tools[0].run({ object_type: 'deals', query: 'Hermeus' });
  assert.equal(hs.ok, true);
  assert.equal(hs.results[0].id, '55');
  assert.ok(hs.results[0].summary.includes('Hermeus Pro License'), 'summarizes the deal');
  assert.ok(hs.results[0].summary.includes('Contract Sent'), 'maps the stage id to its label');
  assert.ok(!hs.results[0].summary.includes('152780062'), 'raw stage id is not shown once mapped');
  assert.equal(hs.results[0].url, 'https://app.hubspot.com/contacts/99999/record/0-3/55', 'builds record link from portal id');
  assert.equal(calls.at(-1).method, 'POST', 'search uses POST');
  assert.ok(calls.at(-1).url.endsWith('/crm/v3/objects/deals/search'), 'hits the deals search endpoint');
  assert.ok(calls.some((c) => c.url.endsWith('/crm/v3/pipelines/deals') && c.method === 'GET'), 'loads stage labels via a GET to the pipelines API');
  console.log('✓ hubspot_search (+ stage labels)');

  // ── hubspot_search list/filter path: NO keyword, structured filters ────────
  // "all open deals over $900k" — must send filterGroups and NOT a bogus query.
  nextResponse = jsonResp({ total: 0, results: [] });
  await hubspot.tools[0].run({
    object_type: 'deals',
    filters: [
      { property: 'hs_is_closed', operator: 'EQ', value: 'false' },
      { property: 'amount', operator: 'GTE', value: '900000' },
    ],
    sort_by: 'amount',
    sort_dir: 'DESCENDING',
  });
  const sent = JSON.parse(calls.at(-1).body);
  assert.equal(sent.query, undefined, 'no keyword query when filtering (would return nothing)');
  assert.equal(sent.filterGroups[0].filters.length, 2, 'passes both filters');
  assert.deepEqual(sent.filterGroups[0].filters[1], { propertyName: 'amount', operator: 'GTE', value: '900000' }, 'maps amount >= 900000');
  assert.deepEqual(sent.sorts[0], { propertyName: 'amount', direction: 'DESCENDING' }, 'sorts by amount desc');
  console.log('✓ hubspot_search (list + filters)');

  // ── registry.execute dispatches + handles unknown tools ───────────────────
  nextResponse = jsonResp({ issues: [] });
  const viaRegistry = await sources.execute('jira_search', { query: 'x' });
  assert.equal(viaRegistry.ok, true, 'registry dispatches to the right source');
  const unknown = await sources.execute('nope', {});
  assert.equal(unknown.ok, false, 'unknown tool → structured error, not a throw');
  console.log('✓ registry dispatch');

  // ── READ-ONLY invariant: no writes, anywhere ──────────────────────────────
  // PUT/PATCH/DELETE are never allowed. POST is allowed ONLY for read-only
  // search endpoints (URL path ends in `/search`, e.g. HubSpot CRM search) —
  // any other POST is treated as a write and fails the test.
  const hardWriteVerbs = new Set(['PUT', 'PATCH', 'DELETE']);
  for (const c of calls) {
    assert.ok(!hardWriteVerbs.has(c.method), `read-only invariant: ${c.method} used on ${c.url}`);
    if (c.method === 'POST') {
      const path = new URL(c.url).pathname.replace(/\/$/, '');
      assert.ok(path.endsWith('/search'), `read-only invariant: non-search POST on ${c.url}`);
    }
  }
  const posts = calls.filter((c) => c.method === 'POST').length;
  console.log(`✓ read-only invariant (${calls.length} calls: ${calls.length - posts} GET, ${posts} read-only search POST)`);

  console.log('\nAll source tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
