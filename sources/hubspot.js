/**
 * HubSpot source — READ-ONLY search over CRM objects (deals, companies, contacts).
 *
 * Auth: a HubSpot Private App access token (Bearer), `HUBSPOT_TOKEN`. Give the
 * private app only READ scopes (crm.objects.deals.read, crm.objects.companies.read,
 * crm.objects.contacts.read) — this source never writes.
 *
 * Note on method: HubSpot's real search is `POST /crm/v3/objects/{type}/search`.
 * That POST is read-only (it returns matches; it creates nothing). It is the ONE
 * sanctioned non-GET in this codebase — the read-only invariant test permits POST
 * only to URLs ending in `/search`, and still forbids PUT/PATCH/DELETE and any
 * other POST. So the "no writes" guarantee holds.
 *
 * Optional: set `HUBSPOT_PORTAL_ID` (your hub id) to get clickable record links.
 */

const fetch = require('node-fetch');

const { real } = require('./env');

const NAME = 'hubspot';
const API = 'https://api.hubapi.com';

// object type → { objectTypeId (for record URLs), properties to fetch, label fields }
const OBJECTS = {
  deals: {
    typeId: '0-3',
    properties: ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline'],
  },
  companies: {
    typeId: '0-2',
    properties: ['name', 'domain', 'industry', 'lifecyclestage'],
  },
  contacts: {
    typeId: '0-1',
    properties: ['firstname', 'lastname', 'email', 'company', 'jobtitle'],
  },
};

function isEnabled() {
  return !!real('HUBSPOT_TOKEN');
}

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function recordUrl(objectType, id) {
  const portal = real('HUBSPOT_PORTAL_ID');
  if (!portal) return undefined;
  return `https://app.hubspot.com/contacts/${portal}/record/${OBJECTS[objectType].typeId}/${id}`;
}

// Deal stages come back as internal ids (e.g. "closedwon" or a numeric id like
// "152780062" for custom pipelines). We translate them to human labels via the
// read-only Pipelines API, fetched once and cached for the process. Failure is
// non-fatal — we fall back to the raw id.
let dealStageLabels = null; // Map<stageId, label> once loaded

async function loadDealStageLabels() {
  if (dealStageLabels) return dealStageLabels;
  try {
    const resp = await fetch(`${API}/crm/v3/pipelines/deals`, { headers: authHeaders() });
    if (!resp.ok) return null; // leave uncached so a transient failure can retry
    const data = await resp.json();
    const map = new Map();
    for (const pipeline of data.results || []) {
      for (const stage of pipeline.stages || []) {
        if (stage.id != null && stage.label) map.set(String(stage.id), stage.label);
      }
    }
    dealStageLabels = map;
    return map;
  } catch {
    return null;
  }
}

function stageLabel(stageId) {
  if (!stageId) return '';
  return dealStageLabels?.get(String(stageId)) || String(stageId);
}

// Build a compact, human-readable label from an object's returned properties.
function summarize(objectType, props) {
  if (objectType === 'deals') {
    const bits = [props.dealname || '(unnamed deal)'];
    if (props.dealstage) bits.push(`stage: ${stageLabel(props.dealstage)}`);
    if (props.amount) bits.push(`amount: ${props.amount}`);
    if (props.closedate) bits.push(`close: ${props.closedate.slice(0, 10)}`);
    return bits.join(' · ');
  }
  if (objectType === 'companies') {
    const bits = [props.name || props.domain || '(unnamed company)'];
    if (props.industry) bits.push(`industry: ${props.industry}`);
    if (props.lifecyclestage) bits.push(`stage: ${props.lifecyclestage}`);
    return bits.join(' · ');
  }
  // contacts
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ') || props.email || '(unnamed contact)';
  const bits = [name];
  if (props.jobtitle) bits.push(props.jobtitle);
  if (props.company) bits.push(props.company);
  if (props.email) bits.push(props.email);
  return bits.join(' · ');
}

const toolDef = {
  name: 'hubspot_search',
  description:
    'Search Istari HubSpot CRM (read-only) for deals, companies, or contacts. Use ' +
    'for sales pipeline, deal stage/amount/close date, customer/company info, and ' +
    'contact details. Matches the keyword against the object\'s searchable fields.',
  input_schema: {
    type: 'object',
    properties: {
      object_type: {
        type: 'string',
        enum: ['deals', 'companies', 'contacts'],
        description: 'Which CRM object to search. Default "deals".',
      },
      query: {
        type: 'string',
        description: 'Keyword to search for, e.g. a deal name, company, or person.',
      },
      limit: { type: 'integer', description: 'Max results (default 10, max 25).' },
    },
    required: ['query'],
  },
};

async function execute(input = {}) {
  const objectType = OBJECTS[input.object_type] ? input.object_type : 'deals';
  const query = String(input.query || '').trim();
  if (!query) return { ok: false, error: 'query is required' };
  const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 25);
  const spec = OBJECTS[objectType];

  // Deal answers read better with stage labels — warm the (cached) map first.
  if (objectType === 'deals') await loadDealStageLabels();

  const resp = await fetch(`${API}/crm/v3/objects/${objectType}/search`, {
    method: 'POST', // read-only search (see file header) — never a write
    headers: authHeaders(),
    body: JSON.stringify({ query, limit, properties: spec.properties }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    return { ok: false, error: `HubSpot HTTP ${resp.status}: ${body.slice(0, 300)}` };
  }

  const data = await resp.json();
  const results = (data.results || []).map((r) => ({
    id: r.id,
    summary: summarize(objectType, r.properties || {}),
    url: recordUrl(objectType, r.id),
  }));
  return { ok: true, object_type: objectType, count: results.length, total: data.total, results };
}

module.exports = {
  name: NAME,
  isEnabled,
  tools: [{ ...toolDef, run: execute }],
};
