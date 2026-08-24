/**
 * Jira source — READ-ONLY search over Jira Cloud issues.
 *
 * Auth: Basic (email + API token), same credential pattern as the internal
 * signal-bot. Only GET endpoints are used — this source can never create,
 * edit, transition, or comment on an issue.
 */

const fetch = require('node-fetch');

const { real } = require('./env');

const NAME = 'jira';

function isEnabled() {
  return !!(real('JIRA_URL') && real('JIRA_EMAIL') && real('JIRA_API_TOKEN'));
}

function authHeaders() {
  const creds = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString('base64');
  return { Authorization: `Basic ${creds}`, Accept: 'application/json' };
}

const toolDef = {
  name: 'jira_search',
  description:
    'Search Istari Jira Cloud issues (read-only). Use for tickets, bugs, features, ' +
    'project status, and who is working on what. Accepts either a natural-language ' +
    'query or a raw JQL string.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language search (matched against issue text) OR a raw JQL ' +
          'expression, e.g. `project = CS AND status = "In Progress"`.',
      },
      is_jql: {
        type: 'boolean',
        description: 'Set true if `query` is already valid JQL. Default false.',
      },
      limit: { type: 'integer', description: 'Max results (default 10, max 25).' },
    },
    required: ['query'],
  },
};

// Escape a bare string for safe use inside a JQL `text ~ "..."` clause.
function jqlText(query) {
  const escaped = String(query).replace(/["\\]/g, '\\$&');
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

async function execute(input = {}) {
  const { query = '', is_jql = false } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);
  const jql = is_jql ? String(query) : jqlText(query);

  const url = new URL(`${process.env.JIRA_URL}/rest/api/3/search/jql`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('maxResults', String(limit));
  url.searchParams.set('fields', 'summary,status,assignee,issuetype,updated');

  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `Jira HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }
  const data = await resp.json();
  const base = process.env.JIRA_URL.replace(/\/$/, '');
  const issues = (data.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || '',
    status: i.fields?.status?.name || '',
    type: i.fields?.issuetype?.name || '',
    assignee: i.fields?.assignee?.displayName || 'Unassigned',
    updated: i.fields?.updated || '',
    url: `${base}/browse/${i.key}`,
  }));
  return { ok: true, count: issues.length, issues };
}

module.exports = {
  name: NAME,
  isEnabled,
  tools: [{ ...toolDef, run: execute }],
};
