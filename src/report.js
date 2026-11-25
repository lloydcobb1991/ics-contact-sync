// Builds the Monday report from Airtable rows. Pure: give it rows, get { subject, html, text }.
// Section order follows the spec: Waiting on you, For Celia, Blocked, Auto, Approved, Health.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * @param {Object} p
 * @param {Object[]} p.changes  Sync Changes rows (fields) touched in the last 7 days, plus all open ones
 * @param {Object[]} p.runs     Sync Runs rows (fields) from the last 7 days
 * @param {Date} p.now
 * @param {string} p.portalUrl
 * @param {boolean} p.dryRun
 * @param {boolean} [p.freshExport=true]  false = no new vault export this week; report runs on last week's
 */
export function buildReport({ changes, runs, now, portalUrl, dryRun, freshExport = true }) {
  const weekAgo = new Date(now - 7 * 864e5);
  const recent = (f) => f['Applied at'] && new Date(f['Applied at']) >= weekAgo;

  const pending = changes.filter((f) => f.Status === 'Pending');
  const oldest = pending.reduce((min, f) => Math.min(min, new Date(f.Created ?? now).getTime()), now.getTime());
  const oldestDays = pending.length ? Math.floor((now - oldest) / 864e5) : 0;

  const celia = changes.filter((f) => f['For Celia'] && ['Open', 'Pending'].includes(f.Status));
  const blocked = changes.filter((f) => f.Outcome === 'Block' && f.Status === 'Open');
  const auto = changes.filter((f) => f.Status === 'Applied' && f.Outcome === 'Auto' && recent(f));
  const approved = changes.filter((f) => f.Status === 'Applied' && f['Decided by'] && recent(f));
  const failed = changes.filter((f) => f.Status === 'Failed');

  const okRuns = runs.filter((r) => ['Success', 'Partial', 'Held'].includes(r.Status)).length;
  const held = runs.filter((r) => r.Status === 'Held').length;
  const ages = runs.map((r) => r['Snapshot age (h)']).filter((n) => Number.isFinite(n));

  const byType = (rows) => Object.entries(rows.reduce((acc, f) => ((acc[f.Type] = (acc[f.Type] ?? 0) + 1), acc), {}));
  const who = (f) => {
    const v = parse(f['Vault value']) ?? parse(f['Mailchimp value']) ?? {};
    const one = Array.isArray(v) ? v[0] ?? {} : v;
    return [one.firstName, one.lastName].filter(Boolean).join(' ') + (one.company ? ` (${one.company})` : '');
  };

  const sections = [];
  const text = [];
  const add = (title, rowsHtml, lines) => {
    sections.push(`<h2 style="font-size:16px;margin:24px 0 8px">${esc(title)}</h2>${rowsHtml}`);
    text.push(`\n== ${title} ==`, ...lines);
  };
  const table = (head, rows) => rows.length
    ? `<table cellpadding="6" style="border-collapse:collapse;font-size:13px">${'<tr>' + head.map((h) => `<th align="left" style="border-bottom:1px solid #ccc">${esc(h)}</th>`).join('') + '</tr>'}${rows.map((r) => '<tr>' + r.map((c) => `<td style="border-bottom:1px solid #eee">${esc(c)}</td>`).join('') + '</tr>').join('')}</table>`
    : '<p style="color:#666">None.</p>';

  add('Waiting on you',
    `<p><b>${pending.length}</b> change(s) waiting for Celia or Ryan${pending.length ? `; oldest is ${oldestDays} day(s) old` : ''}.${portalUrl ? ` <a href="${esc(portalUrl)}">Open the queue</a>` : ''}</p>${table(['Type', 'Count'], byType(pending))}`,
    [`${pending.length} waiting${pending.length ? `, oldest ${oldestDays}d` : ''}. ${portalUrl}`, ...byType(pending).map(([t, n]) => `  ${t}: ${n}`)]);

  add('For Celia: vault fixes',
    table(['Type', 'Email', 'Who', 'Why'], celia.map((f) => [f.Type, f.Email, who(f), f.Reason])),
    celia.map((f) => `  ${f.Type}  ${f.Email}  ${who(f)}  ${f.Reason ?? ''}`));

  add('Blocked',
    table(['Type', 'Email', 'Why'], blocked.map((f) => [f.Type, f.Email, f.Reason])),
    blocked.map((f) => `  ${f.Type}  ${f.Email}  ${f.Reason ?? ''}`));

  add('Applied automatically',
    `${table(['Type', 'Count'], byType(auto))}${auto.some((f) => f.Type === 'NEW_CONTACT') ? `<p>New contacts: ${esc(auto.filter((f) => f.Type === 'NEW_CONTACT').map((f) => f.Email).join(', '))}</p>` : ''}`,
    byType(auto).map(([t, n]) => `  ${t}: ${n}`));

  add('Applied after approval',
    table(['Type', 'Email', 'Option', 'Approved by'], approved.map((f) => [f.Type, f.Email, f['Chosen option'], f['Decided by']])),
    approved.map((f) => `  ${f.Type}  ${f.Email}  ${f['Chosen option'] ?? ''}  by ${f['Decided by']}`));

  const health = [
    `Vault export: ${freshExport ? 'fresh this week' : 'NOT UPLOADED this week. Figures are from the previous export'}`,
    `Runs succeeded: ${okRuns} of ${runs.length}`,
    `Snapshot age at run: ${ages.length ? `${Math.min(...ages)}–${Math.max(...ages)} h` : 'n/a'}`,
    `Failed writes still open: ${failed.length}`,
    `Circuit breaker tripped: ${held} time(s)`,
    `Mode: ${dryRun ? 'DRY RUN (nothing written to Mailchimp)' : 'live'}`,
  ];
  add('Health', `<ul>${health.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`, health.map((h) => `  ${h}`));

  const day = now.toISOString().slice(0, 10);
  const subject = `Contact Sync weekly: ${pending.length} waiting, ${celia.length} for Celia${freshExport ? '' : ' (no new export)'}${dryRun ? ' (dry run)' : ''}, ${day}`;
  const html = `<div style="font-family:'Avenir Next',Avenir,Helvetica,Arial,sans-serif;color:#222;max-width:720px">
<h1 style="font-size:20px">Contact Vault → Mailchimp: week ending ${esc(day)}</h1>${sections.join('\n')}</div>`;
  return { subject, html, text: text.join('\n').trim() };
}
