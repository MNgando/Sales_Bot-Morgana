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
    'project status, and who is working on what. A plain `query` matches issue text. ' +
    'To LIST or FILTER (by project, status, assignee, date, …), pass raw JQL with ' +
    'is_jql=true, e.g. `project = CS AND status != Done ORDER BY created DESC`. ' +
    'OMIT query to list the most recently updated issues.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text matched against issue text, OR a raw JQL expression when ' +
          'is_jql=true. Omit to list recently-updated issues.',
      },
      is_jql: {
        type: 'boolean',
        description: 'Set true if `query` is already valid JQL. Default false.',
      },
      limit: { type: 'integer', description: 'Max results (default 15, max 50).' },
    },
  },
};

// Escape a bare string for safe use inside a JQL `text ~ "..."` clause. When the
// text is empty, list recently-updated issues — bounded to the last 30 days
// because Jira Cloud rejects an unbounded `ORDER BY` with no search restriction.
function jqlText(query) {
  const text = String(query || '').trim();
  if (!text) return 'updated >= -30d ORDER BY updated DESC';
  return `text ~ "${text.replace(/["\\]/g, '\\$&')}" ORDER BY updated DESC`;
}

async function execute(input = {}) {
  const { query = '', is_jql = false } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 50);
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
