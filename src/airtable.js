// Airtable REST client for the three sync tables: Sync Runs, Sync Changes, Sync Audit.
// Field names here must match the tables described in the spec's Data model section.

export function createAirtable({ token, baseId, tables, fetchImpl = fetch }) {
  const api = (table) => `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function req(method, url, body) {
    const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Airtable ${method} ${url} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async function list(table, params = {}) {
    const out = [];
    let offset;
    do {
      const q = new URLSearchParams({ pageSize: '100', ...params, ...(offset ? { offset } : {}) });
      const page = await req('GET', `${api(table)}?${q}`);
      out.push(...page.records);
      offset = page.offset;
    } while (offset);
    return out;
  }

  // Airtable writes max 10 records per request.
  async function batch(method, table, records) {
    const out = [];
    for (let i = 0; i < records.length; i += 10) {
      const res = await req(method, api(table), { records: records.slice(i, i + 10), typecast: true });
      out.push(...res.records);
    }
    return out;
  }

  return {
    list,
    create: (table, fieldsList) => batch('POST', table, fieldsList.map((fields) => ({ fields }))),
    update: (table, updates) => batch('PATCH', table, updates), // [{id, fields}]
    get: (table, id) => req('GET', `${api(table)}/${id}`),
    tables,
  };
}

// ---- Mapping between change objects and Sync Changes rows ----

export function changeToFields(change, status, runId) {
  return {
    'Change Key': change.key,
    Type: change.type,
    Outcome: change.outcome,
    Status: status,
    Email: change.email,
    Audience: change.audience ?? '',
    'Vault value': JSON.stringify(change.vault, null, 2),
    'Mailchimp value': JSON.stringify(change.mailchimp, null, 2),
    'Proposed action': JSON.stringify(change.proposed),
    Options: change.options,
    Reason: change.reason,
    'For Celia': change.forCelia,
    Held: change.held,
    'First seen run': runId,
    'Last seen run': runId,
    Attempts: 0,
  };
}

export function rowToRecord(row) {
  const f = row.fields;
  return {
    id: row.id,
    key: f['Change Key'],
    status: f.Status,
    outcome: f.Outcome,
    type: f.Type,
    email: f.Email,
    audience: f.Audience,
    chosenOption: f['Chosen option'] ?? null,
    decidedBy: f['Decided by'] ?? null,
    attempts: f.Attempts ?? 0,
  };
}
