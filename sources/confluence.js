/**
 * Confluence source — READ-ONLY search over Confluence Cloud pages.
 *
 * Auth: the same Atlassian credential as Jira (email + API token). Confluence
 * lives under `<site>/wiki` by default. Only the GET search endpoint is used.
 */

const fetch = require('node-fetch');

const { real } = require('./env');

const NAME = 'confluence';

function baseUrl() {
  // Confluence is under /wiki on the same Atlassian site unless overridden.
  if (real('CONFLUENCE_URL')) return real('CONFLUENCE_URL').replace(/\/$/, '');
  if (real('JIRA_URL')) return `${real('JIRA_URL').replace(/\/$/, '')}/wiki`;
  return null;
}

function isEnabled() {
  return !!(baseUrl() && real('JIRA_EMAIL') && real('JIRA_API_TOKEN'));
}

function authHeaders() {
  const creds = Buffer.from(
    `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
  ).toString('base64');
  return { Authorization: `Basic ${creds}`, Accept: 'application/json' };
}

const toolDef = {
  name: 'confluence_search',
  description:
    'Search Istari Confluence Cloud pages (read-only). Use for documentation, ' +
    'runbooks, design docs, onboarding, and internal knowledge-base articles. ' +
    '`query` is a free-text match; OMIT it to list the most recent pages. Use ' +
    '`space` (a space key like "ENG") to scope to one space. For advanced needs, ' +
    'pass a raw CQL string as `cql` (e.g. `label = "runbook" AND lastmodified > now("-30d")`).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text to match in pages. Omit to list recent pages (optionally scoped by space).' },
      space: { type: 'string', description: 'Optional space key to scope the search, e.g. "ENG".' },
      cql: { type: 'string', description: 'Optional raw CQL expression. Overrides query/space when set.' },
      limit: { type: 'integer', description: 'Max results (default 15, max 50).' },
    },
  },
};

// Build a CQL string from the simple inputs (text + space), always page-type,
// most-recently-modified first. A raw `cql` input overrides this entirely.
function buildCql({ query, space }) {
  const clauses = ['type = page'];
  const text = String(query || '').trim();
  if (text) clauses.push(`text ~ "${text.replace(/["\\]/g, '\\$&')}"`);
  const spaceKey = String(space || '').trim();
  if (spaceKey) clauses.push(`space = "${spaceKey.replace(/["\\]/g, '\\$&')}"`);
  return `${clauses.join(' AND ')} ORDER BY lastmodified DESC`;
}

async function execute(input = {}) {
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 50);
  const cql = String(input.cql || '').trim() || buildCql(input);

  const url = new URL(`${baseUrl()}/rest/api/search`);
  url.searchParams.set('cql', cql);
  url.searchParams.set('limit', String(limit));

  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `Confluence HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }
  const data = await resp.json();
  const site = baseUrl();
  const pages = (data.results || []).map((r) => {
    const content = r.content || {};
    const webui = r._links?.webui || content._links?.webui || '';
    return {
      title: content.title || r.title || '',
      type: content.type || 'page',
      space: r.resultGlobalContainer?.title || content.space?.name || '',
      excerpt: (r.excerpt || '').replace(/<[^>]+>/g, '').trim(),
      url: webui ? `${site}${webui}` : '',
    };
  });
  return { ok: true, count: pages.length, pages };
}

module.exports = {
  name: NAME,
  isEnabled,
  tools: [{ ...toolDef, run: execute }],
};
