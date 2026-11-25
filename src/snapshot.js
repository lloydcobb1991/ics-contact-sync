// Loads Contact Vault exports from the private GitHub snapshot repo and checks them before anything is diffed.
//
// How exports get there: once a week, Lloyd opens ICS Program Operations Suite → Contact Vault,
// clicks Export CSV, and uploads the file to the repo's snapshots/ folder (replacing last week's).
//
// File name = scope:
//   snapshots/all.csv       the export with every program selected
//   snapshots/alterra.csv   a one-program export; only that program's tag is managed
//   snapshots/swingers.csv  ...one file per program is fine; they are merged by email
import { parseCsv } from './csv.js';
import { normEmail } from './normalize.js';

export function createSnapshotSource({ token, repo, dir = 'snapshots', branch = 'main', fieldMap, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const gh = async (url, accept) => {
    const res = await fetchImpl(url, { headers: accept ? { ...headers, Accept: accept } : headers });
    if (!res.ok) throw new Error(`GitHub ${url} -> ${res.status}`);
    return accept?.includes('raw') ? res.text() : res.json();
  };
  const send = async (method, url, body) => {
    const res = await fetchImpl(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}`);
    return res.json();
  };
  const api = `https://api.github.com/repos/${repo}`;

  return {
    /**
     * Replace the export set in ONE commit: write the given files and delete every other CSV in the folder,
     * so an upload never mixes with last week's files. Needs a token with Contents: read and write.
     * @param {{name: string, text: string}[]} files
     */
    async writeExports(files, message) {
      const ref = await gh(`${api}/git/ref/heads/${branch}`);
      const head = ref.object.sha;
      const headCommit = await gh(`${api}/git/commits/${head}`);
      let existing = [];
      try { existing = await gh(`${api}/contents/${dir}?ref=${head}`); } catch { /* folder not created yet */ }
      const keep = new Set(files.map((f) => f.name));
      const tree = [];
      for (const f of files) {
        const blob = await send('POST', `${api}/git/blobs`, { content: f.text, encoding: 'utf-8' });
        tree.push({ path: `${dir}/${f.name}`, mode: '100644', type: 'blob', sha: blob.sha });
      }
      for (const old of existing.filter((x) => x.type === 'file' && /\.csv$/i.test(x.name) && !keep.has(x.name))) {
        tree.push({ path: `${dir}/${old.name}`, mode: '100644', type: 'blob', sha: null }); // delete
      }
      const newTree = await send('POST', `${api}/git/trees`, { base_tree: headCommit.tree.sha, tree });
      const commit = await send('POST', `${api}/git/commits`, { message, tree: newTree.sha, parents: [head] });
      await send('PATCH', `${api}/git/refs/heads/${branch}`, { sha: commit.sha });
      return commit.sha;
    },

    /** Latest commit SHA touching the snapshots folder. */
    async latestSha() {
      const [c] = await gh(`${api}/commits?path=${encodeURIComponent(dir)}&per_page=1`);
      if (!c) throw new Error(`No commits found under ${dir}/`);
      return c.sha;
    },
    /** All exports in the folder at a commit, merged into one snapshot. */
    async at(sha) {
      const commit = await gh(`${api}/commits/${sha}`);
      const listing = await gh(`${api}/contents/${dir}?ref=${sha}`);
      const files = [];
      for (const f of listing.filter((x) => x.type === 'file' && /\.csv$/i.test(x.name))) {
        files.push({ name: f.name, text: await gh(`${api}/contents/${dir}/${encodeURIComponent(f.name)}?ref=${sha}`, 'application/vnd.github.raw+json') });
      }
      return { ...mergeExports(files, fieldMap), generatedAt: commit.commit.committer.date };
    },
  };
}

/**
 * Merge one or more vault CSV exports into a single snapshot.
 * Pure: give it [{name, text}], get { columns, records, scopeTags, files, warnings }.
 * scopeTags = null when any file is all.csv (every program), else the tags of the programs present.
 */
export function mergeExports(files, fieldMap) {
  const warnings = [];
  if (!files.length) throw new Error('No CSV exports found in the snapshots folder');

  const programByFile = Object.fromEntries(Object.keys(fieldMap.programTags).map((p) => [p.toLowerCase(), p]));
  let everything = false;
  const scopePrograms = new Set();
  let columns = null;
  const byEmail = new Map();
  const noEmail = [];
  const emailCol = fieldMap.columns.email;
  const progCol = fieldMap.columns.programs;

  for (const f of files) {
    const stem = f.name.replace(/\.csv$/i, '').toLowerCase();
    if (stem === 'all') everything = true;
    else if (programByFile[stem]) scopePrograms.add(programByFile[stem]);
    else throw new Error(`Don't know which program "${f.name}" covers. Name it all.csv or one of: ${Object.keys(fieldMap.programTags).map((p) => p.toLowerCase() + '.csv').join(', ')}`);

    const parsed = parseCsv(f.text);
    if (columns && parsed.columns.join('|') !== columns.join('|')) warnings.push(`${f.name} has different columns from the other exports`);
    columns ??= parsed.columns;

    for (const r of parsed.records) {
      const key = normEmail(r[emailCol]);
      if (!key) { noEmail.push(r); continue; }
      const prev = byEmail.get(key);
      if (!prev) { byEmail.set(key, { ...r }); continue; }
      // Same person in two exports: union their program chips, keep the first file's other fields.
      const chips = new Set([...splitChips(prev[progCol]), ...splitChips(r[progCol])]);
      prev[progCol] = [...chips].join('; ');
      for (const col of [fieldMap.columns.firstName, fieldMap.columns.lastName, fieldMap.columns.company]) {
        if (col && r[col] && prev[col] && r[col].trim() !== prev[col].trim()) {
          warnings.push(`${key}: "${col}" differs between exports ("${prev[col]}" vs "${r[col]}"); kept the first`);
        }
      }
    }
  }

  const scopeTags = everything ? null : [...scopePrograms].map((p) => fieldMap.programTags[p]);
  return { columns: columns ?? [], records: [...byEmail.values(), ...noEmail], scopeTags, files: files.map((f) => f.name), warnings };
}

const splitChips = (v) => String(v ?? '').split(';').map((s) => s.trim()).filter(Boolean);

/**
 * Safety checks from the spec. Returns { ok, stale, ageHours, errors, warnings }.
 * `stale` means: skip the run, leave the queue alone. `ok: false` means: fail the run.
 */
export function validateSnapshot(snap, previous, { fieldMap, maxSnapshotAgeHours, minRecordRatio, now = new Date() }) {
  const errors = [];
  const warnings = [...(snap?.warnings ?? [])];

  if (!snap || !Array.isArray(snap.records)) {
    return { ok: false, stale: false, errors: ['Snapshot has no records array'], warnings };
  }

  const columns = new Set(snap.columns ?? Object.keys(snap.records[0] ?? {}));
  for (const field of fieldMap.required) {
    const col = fieldMap.columns[field];
    if (!columns.has(col)) errors.push(`Required vault column "${col}" (for ${field}) is missing. Was it renamed?`);
  }

  // Only compare sizes when both snapshots cover the same programs.
  const sameScope = JSON.stringify(previous?.scopeTags ?? null) === JSON.stringify(snap.scopeTags ?? null);
  const prevCount = previous?.records?.length ?? 0;
  if (sameScope && prevCount > 0 && snap.records.length < prevCount * minRecordRatio) {
    errors.push(`Export has ${snap.records.length} records vs ${prevCount} last time (< ${minRecordRatio * 100}%). Treating as a bad export.`);
  }

  const ageHours = (now - new Date(snap.generatedAt)) / 36e5;
  const stale = !Number.isFinite(ageHours) || ageHours > maxSnapshotAgeHours;
  if (stale) warnings.push(`Vault export is ${Number.isFinite(ageHours) ? Math.round(ageHours / 24) + ' days' : 'of unknown age'} old (limit ${Math.round(maxSnapshotAgeHours / 24)} days). Upload a fresh export.`);

  return { ok: errors.length === 0, stale, ageHours, errors, warnings };
}
