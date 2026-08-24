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
    'runbooks, design docs, onboarding, and internal knowledge-base articles.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language text to search for in pages.' },
      limit: { type: 'integer', description: 'Max results (default 10, max 25).' },
    },
    required: ['query'],
  },
};

async function execute(input = {}) {
  const { query = '' } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);

  // CQL: match text on page-type content, most recently modified first.
  const escaped = String(query).replace(/["\\]/g, '\\$&');
  const cql = `type = page AND text ~ "${escaped}" ORDER BY lastmodified DESC`;

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
