/**
 * GitHub source — READ-ONLY search and file reads over the org's repos.
 *
 * Auth: a Personal Access Token (`GITHUB_TOKEN`) — the same token that already
 * works over HTTPS for the org. Only GET / search endpoints are used; this
 * source cannot open issues, push, or modify anything.
 *
 * Searches are scoped to `GITHUB_ORG` so the bot answers about Istari code only.
 */

const fetch = require('node-fetch');
const { real } = require('./env');

const NAME = 'github';
const API = 'https://api.github.com';

function org() {
  return real('GITHUB_ORG') || 'istari-digital-internal';
}

function isEnabled() {
  return !!real('GITHUB_TOKEN');
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'istari-sales-bot-morgana',
  };
}

async function ghGet(path, params) {
  const url = new URL(`${API}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url, { headers: headers() });
  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `GitHub HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }
  return { ok: true, data: await resp.json() };
}

// ── Tool: search code ─────────────────────────────────────────────────────────
async function searchCode(input = {}) {
  const { query = '' } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);
  const q = `${query} org:${org()}`;
  const r = await ghGet('/search/code', { q, per_page: String(limit) });
  if (!r.ok) return r;
  const results = (r.data.items || []).map((i) => ({
    repo: i.repository?.full_name || '',
    path: i.path,
    url: i.html_url,
  }));
  return { ok: true, count: results.length, results };
}

// ── Tool: search repos (or list the org's repos when no keyword) ──────────────
async function searchRepos(input = {}) {
  const q = String(input.query || '').trim();
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 50);
  // With a keyword → code/repo search API (needs a term). Without one → the org
  // repos list endpoint, so "what repos does the org have?" works.
  const r = q
    ? await ghGet('/search/repositories', { q: `${q} org:${org()}`, per_page: String(limit), sort: 'updated', order: 'desc' })
    : await ghGet(`/orgs/${org()}/repos`, { per_page: String(limit), sort: 'updated', direction: 'desc' });
  if (!r.ok) return r;
  const items = q ? (r.data.items || []) : (Array.isArray(r.data) ? r.data : []);
  const results = items.map((i) => ({
    name: i.full_name,
    description: i.description || '',
    url: i.html_url,
    updated: i.updated_at,
  }));
  return { ok: true, count: results.length, results };
}

// ── Tool: read a repo's README ────────────────────────────────────────────────
async function getReadme(input = {}) {
  const repo = String(input.repo || '').trim();
  if (!repo) return { ok: false, error: 'repo is required (e.g. "istari-digital-internal/signal-bot")' };
  const full = repo.includes('/') ? repo : `${org()}/${repo}`;
  const r = await ghGet(`/repos/${full}/readme`);
  if (!r.ok) return r;
  const content = r.data.content ? Buffer.from(r.data.content, 'base64').toString('utf8') : '';
  // Cap the body so a huge README can't blow the model's context.
  const MAX = 8000;
  return {
    ok: true,
    repo: full,
    url: r.data.html_url,
    content: content.length > MAX ? content.slice(0, MAX) + '\n…(truncated)…' : content,
  };
}

const tools = [
  {
    name: 'github_search_code',
    description:
      'Search code across Istari GitHub repos (read-only). Use to find where ' +
      'something is implemented, config values, or usages of a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Code search terms (GitHub code-search syntax allowed).' },
        limit: { type: 'integer', description: 'Max results (default 10, max 25).' },
      },
      required: ['query'],
    },
    run: searchCode,
  },
  {
    name: 'github_search_repos',
    description:
      'Search or LIST Istari GitHub repositories (read-only). OMIT query to list ' +
      'the org\'s repos (most recently updated first); pass a keyword to search by ' +
      'name/description.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Repository search terms. Omit to list all org repos.' },
        limit: { type: 'integer', description: 'Max results (default 15, max 50).' },
      },
    },
    run: searchRepos,
  },
  {
    name: 'github_get_readme',
    description: "Read a repository's README (read-only). Good for a project overview.",
    input_schema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repo name or owner/name, e.g. "signal-bot" or "istari-digital-internal/signal-bot".',
        },
      },
      required: ['repo'],
    },
    run: getReadme,
  },
];

module.exports = { name: NAME, isEnabled, tools };
