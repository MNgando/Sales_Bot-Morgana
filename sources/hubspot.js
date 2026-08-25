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

// Operators we allow through to HubSpot's search filters (read-only conditions).
const FILTER_OPERATORS = new Set([
  'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'IN', 'NOT_IN',
  'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN',
]);

const toolDef = {
  name: 'hubspot_search',
  description:
    'Search Istari HubSpot CRM (read-only) for deals, companies, or contacts. ' +
    'IMPORTANT: `query` is a KEYWORD/NAME match (matches a deal/company/person name), ' +
    'NOT a filter — do NOT pass words like "deals" or "active" as query (returns nothing). ' +
    'To LIST ALL or filter by a field, OMIT query and use `filters`. ' +
    'Common deal properties: amount (number, USD), dealstage, pipeline, closedate, ' +
    'hs_is_closed ("true"/"false" — use "false" for OPEN/active deals). ' +
    'Examples: all open deals over $900k → object_type "deals", filters ' +
    '[{property:"hs_is_closed",operator:"EQ",value:"false"},{property:"amount",operator:"GTE",value:"900000"}]. ' +
    'A specific deal by name → query:"Hermeus".',
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
        description: 'Optional keyword/NAME match (e.g. "Hermeus"). Omit to list all / filter.',
      },
      filters: {
        type: 'array',
        description: 'Optional property conditions, AND-combined. Use to list/filter instead of query.',
        items: {
          type: 'object',
          properties: {
            property: { type: 'string', description: 'Property name, e.g. "amount", "dealstage", "hs_is_closed".' },
            operator: { type: 'string', description: 'One of EQ, NEQ, LT, LTE, GT, GTE, IN, NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN.' },
            value: { type: 'string', description: 'Value for single-value operators (omit for HAS_PROPERTY / NOT_HAS_PROPERTY).' },
            values: { type: 'array', items: { type: 'string' }, description: 'Values for IN / NOT_IN.' },
          },
          required: ['property', 'operator'],
        },
      },
      sort_by: { type: 'string', description: 'Property to sort by (e.g. "amount"). Default most recently modified.' },
      sort_dir: { type: 'string', enum: ['ASCENDING', 'DESCENDING'], description: 'Sort direction. Default DESCENDING.' },
      limit: { type: 'integer', description: 'Max results (default 20, max 100).' },
    },
  },
};

// Map the tool's filter objects to HubSpot's filter schema, dropping any with an
// unsupported operator so a bad input can't break the whole search.
function toHubspotFilters(filters) {
  const out = [];
  for (const f of filters || []) {
    if (!f || !f.property) continue;
    const operator = String(f.operator || '').toUpperCase();
    if (!FILTER_OPERATORS.has(operator)) continue;
    const filter = { propertyName: f.property, operator };
    if (operator === 'IN' || operator === 'NOT_IN') {
      filter.values = (f.values || []).map(String);
    } else if (operator !== 'HAS_PROPERTY' && operator !== 'NOT_HAS_PROPERTY') {
      if (f.value === undefined) continue; // value-taking operator with no value
      filter.value = String(f.value);
    }
    out.push(filter);
  }
  return out;
}

async function execute(input = {}) {
  const objectType = OBJECTS[input.object_type] ? input.object_type : 'deals';
  const query = String(input.query || '').trim();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const spec = OBJECTS[objectType];

  // Deal answers read better with stage labels — warm the (cached) map first.
  if (objectType === 'deals') await loadDealStageLabels();

  // Ensure any filtered/sorted property is also returned, so results show it.
  const properties = [...new Set([
    ...spec.properties,
    ...(input.filters || []).map((f) => f && f.property).filter(Boolean),
    input.sort_by,
  ].filter(Boolean))];

  const body = { limit, properties };
  if (query) body.query = query; // keyword/name match only when provided
  const filters = toHubspotFilters(input.filters);
  if (filters.length) body.filterGroups = [{ filters }];
  body.sorts = [{
    propertyName: input.sort_by || 'hs_lastmodifieddate',
    direction: input.sort_dir === 'ASCENDING' ? 'ASCENDING' : 'DESCENDING',
  }];

  const resp = await fetch(`${API}/crm/v3/objects/${objectType}/search`, {
    method: 'POST', // read-only search (see file header) — never a write
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `HubSpot HTTP ${resp.status}: ${text.slice(0, 300)}` };
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
