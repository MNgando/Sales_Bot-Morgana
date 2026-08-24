/**
 * Istari platform source — READ-ONLY query over the Istari Digital REST API.
 *
 * OPTIONAL: disabled unless both ISTARI_API_URL and ISTARI_API_TOKEN are set.
 * A generic read-only GET wrapper against the platform API — adjust the tool
 * surface once the exact endpoints you want the bot to answer from are decided
 * (models, systems, artifacts, docs). Only GET is used.
 */

const fetch = require('node-fetch');
const { real } = require('./env');

const NAME = 'istari';

function baseUrl() {
  return real('ISTARI_API_URL') ? real('ISTARI_API_URL').replace(/\/$/, '') : null;
}

function isEnabled() {
  return !!(baseUrl() && real('ISTARI_API_TOKEN'));
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.ISTARI_API_TOKEN}`,
    Accept: 'application/json',
    'User-Agent': 'istari-knowledge-bot',
  };
}

const toolDef = {
  name: 'istari_query',
  description:
    'Query the Istari Digital platform (read-only) for models, systems, artifacts, ' +
    'and related engineering data. Provide a relative API path and optional query params.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative API path, e.g. "/v2/models" or "/v3/resources". Must be a GET endpoint.',
      },
      params: {
        type: 'object',
        description: 'Optional query parameters as a flat key/value object.',
      },
    },
    required: ['path'],
  },
};

async function execute(input = {}) {
  const path = String(input.path || '');
  if (!path.startsWith('/')) return { ok: false, error: 'path must start with "/"' };

  const url = new URL(`${baseUrl()}${path}`);
  if (input.params && typeof input.params === 'object') {
    for (const [k, v] of Object.entries(input.params)) url.searchParams.set(k, String(v));
  }

  const resp = await fetch(url, { headers: headers() });
  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `Istari HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }
  const data = await resp.json();
  // Cap payload size so a large list can't overflow the model context.
  const text = JSON.stringify(data);
  const MAX = 8000;
  if (text.length > MAX) {
    return { ok: true, truncated: true, preview: text.slice(0, MAX) };
  }
  return { ok: true, data };
}

module.exports = {
  name: NAME,
  isEnabled,
  tools: [{ ...toolDef, run: execute }],
};
