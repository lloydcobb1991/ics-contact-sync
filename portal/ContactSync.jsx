// Contact Sync tab for the ICS Internal Tools Portal (React/Vite).
// Drop into the portal's tools folder and add a route/tab. Talks to the router in src/server/router.js.
// Only Celia and Ryan get Approve/Reject buttons; the server enforces this too.
import { useEffect, useMemo, useState } from 'react';

const API = (import.meta.env.VITE_API_BASE ?? '') + '/api/contact-sync';

const TYPE_LABELS = {
  NEW_CONTACT: 'New contact',
  FIELD_UPDATE: 'Field update',
  TAG_ADD: 'Add tag',
  TAG_REMOVE: 'Remove tag',
  READD_ARCHIVED: 'Re-add archived',
  SUPPRESSED_ELSEWHERE: 'Unsubscribed elsewhere',
  EMAIL_CHANGE: 'Email change',
  VAULT_INACTIVE: 'Inactive in vault',
  MC_ONLY: 'Not in vault',
  MC_UNSUBSCRIBED: 'Unsubscribed',
  MC_CLEANED: 'Bounced',
  OPERATOR_ON_SUPPLIER: 'Operator on supplier list',
  DUPLICATE_IN_VAULT: 'Duplicate in vault',
  INVALID_EMAIL: 'Invalid email',
};

const OPTION_LABELS = {
  apply: 'Apply as proposed',
  add: 'Add anyway',
  're-add': 'Re-add to audience',
  'remove-tags': 'Remove the tag(s)',
  'update-email': 'Change the email on the existing record',
  'archive-old-add-new': 'Archive old, add new',
  untag: 'Remove vault tags only',
  archive: 'Archive in Mailchimp',
  leave: 'Leave as is',
};

const AUDIENCES = { master: 'ICS Conversations Master', rfp: 'RFP+APL General' };
const FIELDS = [['firstName', 'First'], ['lastName', 'Last'], ['company', 'Company'], ['status', 'Status'], ['tags', 'Tags']];

const s = {
  page: { fontFamily: "'Avenir Next', Avenir, system-ui, sans-serif", color: '#1d1d1f', maxWidth: 1040, margin: '0 auto', padding: 24 },
  tabs: { display: 'flex', gap: 8, margin: '16px 0' },
  tab: (on) => ({ padding: '6px 14px', borderRadius: 999, border: '1px solid #ccc', background: on ? '#1d1d1f' : '#fff', color: on ? '#fff' : '#1d1d1f', cursor: 'pointer' }),
  card: { border: '1px solid #e2e2e2', borderRadius: 10, padding: 16, marginBottom: 12, background: '#fff' },
  badge: (tone) => ({ display: 'inline-block', fontSize: 12, padding: '2px 8px', borderRadius: 6, marginRight: 6,
    background: { Approval: '#fff4d6', 'For Celia': '#e8f0ff', Block: '#ffe3e3', Auto: '#e6f6ea', Skip: '#eee' }[tone] ?? '#eee' }),
  grid: { display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: '4px 12px', fontSize: 13, margin: '12px 0' },
  diff: { background: '#fff8c5' },
  btn: (primary) => ({ padding: '6px 14px', borderRadius: 6, border: primary ? 'none' : '1px solid #ccc', background: primary ? '#1d1d1f' : '#fff', color: primary ? '#fff' : '#1d1d1f', cursor: 'pointer' }),
};

const show = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');

function Compare({ vault, mailchimp }) {
  const v = Array.isArray(vault) ? vault[0] ?? {} : vault ?? {};
  const m = mailchimp ?? {};
  return (
    <div style={s.grid}>
      <b /> <b>Vault</b> <b>Mailchimp</b>
      {FIELDS.map(([k, label]) => {
        const a = show(k === 'status' ? (v.active === undefined ? '' : v.active ? 'active' : 'inactive') : v[k]);
        const b = show(m[k]);
        const differs = a && b && a !== b;
        return [
          <span key={k + 'l'} style={{ color: '#666' }}>{label}</span>,
          <span key={k + 'v'} style={differs ? s.diff : null}>{a || '—'}</span>,
          <span key={k + 'm'} style={differs ? s.diff : null}>{b || '—'}</span>,
        ];
      })}
    </div>
  );
}

function ChangeCard({ c, canApprove, onDecide }) {
  const [option, setOption] = useState(c.options[0] ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision) => {
    setBusy(true);
    try { await onDecide(c.id, { decision, option, note }); } finally { setBusy(false); }
  };

  return (
    <div style={s.card}>
      <div>
        <span style={s.badge(c.outcome)}>{c.held ? 'Held (circuit breaker)' : c.outcome}</span>
        <b>{TYPE_LABELS[c.type] ?? c.type}</b> · {c.email} {c.audience && <span style={{ color: '#666' }}>· {AUDIENCES[c.audience] ?? c.audience}</span>}
      </div>
      <div style={{ fontSize: 13, color: '#444', marginTop: 4 }}>{c.reason}</div>
      <Compare vault={c.vault} mailchimp={c.mailchimp} />
      {c.status === 'Pending' && canApprove && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={option} onChange={(e) => setOption(e.target.value)} disabled={busy}>
            {c.options.map((o) => <option key={o} value={o}>{OPTION_LABELS[o] ?? o}</option>)}
          </select>
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 180 }} disabled={busy} />
          <button style={s.btn(true)} disabled={busy} onClick={() => decide('approve')}>Approve</button>
          <button style={s.btn(false)} disabled={busy} onClick={() => decide('reject')}>Reject</button>
        </div>
      )}
      {c.status !== 'Pending' && (
        <div style={{ fontSize: 12, color: '#666' }}>
          {c.status}{c.decidedBy ? ` by ${c.decidedBy}` : ''}{c.chosenOption ? ` · ${OPTION_LABELS[c.chosenOption] ?? c.chosenOption}` : ''}
          {c.status === 'Approved' && ' · applies on the next morning run'}
          {c.error && <div style={{ color: '#b00020' }}>{c.error}</div>}
        </div>
      )}
    </div>
  );
}


// ---- Weekly vault export: drag & drop ----
function guessScope(name, programs) {
  const n = name.toLowerCase();
  if (/\ball\b|all[ _-]?programs/.test(n)) return 'all';
  return programs.find((p) => n.includes(p.toLowerCase())) ?? '';
}

function UploadPanel({ programs, onDone }) {
  const [files, setFiles] = useState([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const addFiles = async (list) => {
    setResult(null); setError(null);
    const csvs = [...list].filter((f) => /\.csv$/i.test(f.name));
    if (!csvs.length) { setError({ error: 'Drop the .csv file from the vault\'s Export CSV button.' }); return; }
    const read = await Promise.all(csvs.map(async (f) => ({ name: f.name, text: await f.text(), scope: guessScope(f.name, programs) })));
    setFiles((cur) => [...cur.filter((c) => !read.some((r) => r.name === c.name)), ...read]);
  };
  const setScope = (name, scope) => setFiles((cur) => cur.map((f) => (f.name === name ? { ...f, scope } : f)));
  const remove = (name) => setFiles((cur) => cur.filter((f) => f.name !== name));

  const submit = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${API}/upload`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: files.map(({ scope, text }) => ({ scope, text })) }),
      });
      const data = await res.json();
      if (!res.ok) setError(data);
      else { setResult(data); setFiles([]); onDone(); }
    } catch (e) { setError({ error: e.message }); }
    finally { setBusy(false); }
  };

  const ready = files.length > 0 && files.every((f) => f.scope);
  return (
    <section style={{ ...s.card, marginTop: 8 }} aria-labelledby="upload-title">
      <h2 id="upload-title" style={{ fontSize: 15, margin: '0 0 4px', letterSpacing: '0.14em', textTransform: 'uppercase' }}>Weekly vault export</h2>
      <p style={{ fontSize: 13, color: '#555', margin: '0 0 12px' }}>
        In the Contact Vault, choose All programs and click Export CSV, then drop the file here. It is checked, saved and synced right away; on Mondays the weekly report goes out when the sync finishes.
      </p>
      <label
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
        style={{ display: 'block', border: `2px dashed ${over ? '#1d1d1f' : '#bbb'}`, borderRadius: 10, padding: 28, textAlign: 'center', cursor: 'pointer', background: over ? '#f4f1ec' : '#fafafa', fontSize: 14 }}
      >
        Drag the CSV here, or <u>choose a file</u>
        <input type="file" accept=".csv,text/csv" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </label>

      {files.map((f) => (
        <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <label style={{ color: '#555' }}>
            Covers{' '}
            <select value={f.scope} onChange={(e) => setScope(f.name, e.target.value)} disabled={busy}>
              <option value="">Choose…</option>
              <option value="all">All programs</option>
              {programs.map((p) => <option key={p} value={p}>{p} only</option>)}
            </select>
          </label>
          <button type="button" style={s.btn(false)} onClick={() => remove(f.name)} disabled={busy} aria-label={`Remove ${f.name}`}>Remove</button>
        </div>
      ))}

      {files.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button type="button" style={s.btn(true)} disabled={!ready || busy} onClick={submit}>{busy ? 'Saving and syncing…' : 'Save & sync'}</button>
          {!ready && <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>Pick what each file covers.</span>}
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 12, color: '#b00020', fontSize: 13 }}>
          {error.error}
          {error.details && <ul style={{ margin: '4px 0 0 18px' }}>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      {result && (
        <div role="status" style={{ marginTop: 12, fontSize: 13, background: '#e6f6ea', borderRadius: 8, padding: 12 }}>
          <b>Saved {result.saved.contacts} contacts</b> ({result.saved.files}). Sync: {result.run.status}
          {result.run.counts && <> · {result.run.counts.applied} applied · {result.run.counts.queued} waiting for approval · {result.run.counts.forCelia} for Celia</>}
          {result.report && <div>{result.report.skipped ? `Weekly report: ${result.report.skipped}.` : 'Weekly report sent.'}</div>}
          {result.saved.warnings?.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{result.saved.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {result.run.log?.length > 0 && <details style={{ marginTop: 6 }}><summary>Run log</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{result.run.log.join('\n')}</pre></details>}
        </div>
      )}
    </section>
  );
}

export default function ContactSync() {
  const [view, setView] = useState('pending');
  const [me, setMe] = useState({ canApprove: false, canUpload: false, programs: [] });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [meRes, rowsRes] = await Promise.all([fetch(`${API}/me`, { credentials: 'include' }), fetch(`${API}/changes?view=${view}`, { credentials: 'include' })]);
      setMe(await meRes.json());
      setRows(await rowsRes.json());
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [view]);

  const onDecide = async (id, body) => {
    const res = await fetch(`${API}/changes/${id}/decision`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? 'Something went wrong'); return; }
    setRows((rs) => (view === 'pending' ? rs.filter((r) => r.id !== id) : rs.map((r) => (r.id === id ? data : r))));
  };

  const grouped = useMemo(() => {
    const g = {};
    for (const r of rows) (g[r.type] ??= []).push(r);
    return Object.entries(g);
  }, [rows]);

  return (
    <div style={s.page}>
      <h1 style={{ fontSize: 22, margin: 0 }}>Contact Sync</h1>
      <p style={{ color: '#555', marginTop: 4 }}>
        Celia's Contact Vault → Mailchimp. {me.canApprove ? 'You can approve or reject changes.' : 'View only. Celia and Ryan approve changes.'}
      </p>
      {me.canUpload && <UploadPanel programs={me.programs ?? []} onDone={load} />}
      <div style={s.tabs}>
        {[['pending', 'Waiting for approval'], ['open', 'All open'], ['recent', 'Last 14 days']].map(([k, label]) => (
          <button key={k} style={s.tab(view === k)} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {error && <div style={{ color: '#b00020', marginBottom: 12 }}>{error}</div>}
      {rows.length === 0 && <p style={{ color: '#666' }}>Nothing here.</p>}
      {grouped.map(([type, list]) => (
        <section key={type}>
          <h2 style={{ fontSize: 15, margin: '20px 0 8px' }}>{TYPE_LABELS[type] ?? type} ({list.length})</h2>
          {list.map((c) => <ChangeCard key={c.id} c={c} canApprove={me.canApprove} onDecide={onDecide} />)}
        </section>
      ))}
    </div>
  );
}
