// Express router for the portal's Contact Sync tab. Mount it on the existing Railway backend:
//
//   import { createContactSyncRouter } from 'ics-contact-sync/src/server/router.js';
//   import { loadContext } from 'ics-contact-sync/src/context.js';
//   const ctx = loadContext();
//   app.use('/api/contact-sync', createContactSyncRouter({ ctx, getUserEmail }));
//
// Approvers (APPROVER_EMAILS) decide queued changes. Uploaders (UPLOADER_EMAILS) drop the weekly vault export.
//
// getUserEmail(req) must return the signed-in user's verified email from the portal's existing auth.
// TODO(auth): wire this to however the portal identifies users today. Never trust an email from the request body.
import express from 'express';
import { mergeExports, validateSnapshot } from '../snapshot.js';
import { runDaily as defaultRunDaily } from '../jobs/daily.js';
import { runWeekly as defaultRunWeekly } from '../jobs/weekly.js';
import { fieldMap as defaultFieldMap } from '../../config/fieldMap.js';
import { settings } from '../../config/settings.js';

const VIEWS = {
  pending: `{Status} = 'Pending'`,
  open: `OR({Status} = 'Pending', {Status} = 'Open', {Status} = 'Approved', {Status} = 'Failed', {Status} = 'Queued')`,
  recent: `IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -14, 'days'))`,
};

const parse = (s) => { try { return JSON.parse(s); } catch { return s ?? null; } };

export function toApi(row) {
  const f = row.fields;
  return {
    id: row.id,
    created: row.createdTime,
    key: f['Change Key'],
    type: f.Type,
    outcome: f.Outcome,
    status: f.Status,
    email: f.Email,
    audience: f.Audience,
    reason: f.Reason,
    forCelia: Boolean(f['For Celia']),
    held: Boolean(f.Held),
    vault: parse(f['Vault value']),
    mailchimp: parse(f['Mailchimp value']),
    proposed: parse(f['Proposed action']),
    options: f.Options ?? [],
    chosenOption: f['Chosen option'] ?? null,
    decidedBy: f['Decided by'] ?? null,
    decidedAt: f['Decided at'] ?? null,
    note: f.Note ?? '',
    error: f.Error ?? '',
  };
}

export function createContactSyncRouter({
  ctx, getUserEmail,
  approvers = ctx.approvers, uploaders = ctx.uploaders ?? [],
  runDaily = defaultRunDaily, runWeekly = defaultRunWeekly,
  fieldMap = defaultFieldMap, clock = () => new Date(),
}) {
  const { at, tables } = ctx;
  const router = express.Router();
  router.use(express.json({ limit: '5mb' }));
  const allowed = new Set(approvers.map((e) => e.toLowerCase()));
  const canUpload = new Set(uploaders.map((e) => e.toLowerCase()));
  const userOf = async (req) => String((await getUserEmail(req)) ?? '').toLowerCase();
  const programs = Object.keys(fieldMap.programTags);

  router.get('/me', async (req, res) => {
    const email = await userOf(req);
    res.json({ email, canApprove: allowed.has(email), canUpload: canUpload.has(email), programs });
  });

  // ---- Weekly vault export: validate, save (one commit), sync now, and on Mondays send the report ----
  router.post('/upload', async (req, res, next) => {
    try {
      const email = await userOf(req);
      if (!canUpload.has(email)) return res.status(403).json({ error: 'You are not set up to upload vault exports.' });

      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (!files.length) return res.status(400).json({ error: 'Drop at least one CSV export.' });
      const scopes = files.map((f) => f.scope);
      if (scopes.some((sc) => sc !== 'all' && !programs.includes(sc))) return res.status(400).json({ error: `Pick what each file covers: All programs or ${programs.join(' / ')}.` });
      if (new Set(scopes).size !== scopes.length) return res.status(400).json({ error: 'Two files are marked as covering the same program.' });
      if (scopes.includes('all') && scopes.length > 1) return res.status(400).json({ error: 'An "All programs" export already covers everything. Upload it on its own.' });

      const named = files.map((f) => ({ name: f.scope === 'all' ? 'all.csv' : `${f.scope.toLowerCase()}.csv`, text: String(f.text ?? '') }));
      let snap;
      try { snap = mergeExports(named, fieldMap); } catch (e) { return res.status(400).json({ error: e.message }); }

      let previous = null;
      try { previous = await ctx.snapshots.at(await ctx.snapshots.latestSha()); } catch { /* first upload */ }
      const now = clock();
      const v = validateSnapshot({ ...snap, generatedAt: now.toISOString() }, previous, { fieldMap, ...settings, now });
      if (!v.ok) return res.status(400).json({ error: 'This export was not saved.', details: v.errors });

      const running = await at.list(tables.runs, { filterByFormula: `AND({Status} = 'Running', IS_AFTER({Started}, DATEADD(NOW(), -30, 'minutes')))` });
      if (running.length) return res.status(409).json({ error: 'A sync is already running. Try again in a few minutes.' });

      const label = named.map((f) => f.name).join(', ');
      const commit = await ctx.snapshots.writeExports(named, `Vault export uploaded by ${email}: ${label} (${snap.records.length} contacts)`);
      await at.create(tables.audit, [{ At: now.toISOString(), Actor: email, Action: 'export-uploaded', 'Change Key': '', Email: '', Detail: JSON.stringify({ files: label, contacts: snap.records.length, commit }) }]);

      const run = await runDaily(ctx, { now });
      const isMonday = new Date(now.getTime() - 7 * 36e5).getUTCDay() === 1; // Arizona time
      const report = isMonday ? await runWeekly(ctx, { now }) : null;

      res.json({
        saved: { files: label, contacts: snap.records.length, commit, scope: snap.scopeTags ?? 'all programs', warnings: v.warnings },
        run: { status: run.status, counts: run.counts ?? null, log: run.log ?? [] },
        report,
      });
    } catch (err) { next(err); }
  });

  router.get('/changes', async (req, res, next) => {
    try {
      const formula = VIEWS[req.query.view] ?? VIEWS.open;
      const rows = await at.list(tables.changes, { filterByFormula: formula, 'sort[0][field]': 'Type' });
      res.json(rows.map(toApi));
    } catch (err) { next(err); }
  });

  router.post('/changes/:id/decision', async (req, res, next) => {
    try {
      const email = await userOf(req);
      if (!allowed.has(email)) return res.status(403).json({ error: 'Only Celia and Ryan can approve or reject changes.' });

      const { decision, option, note = '' } = req.body ?? {};
      if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });

      const row = await at.get(tables.changes, req.params.id);
      const current = toApi(row);
      if (current.status !== 'Pending') return res.status(409).json({ error: `This change is ${current.status}, not Pending. Refresh the queue.` });

      let status = 'Rejected';
      let chosen = null;
      if (decision === 'approve') {
        chosen = option ?? current.options[0];
        if (!current.options.includes(chosen)) return res.status(400).json({ error: `Option must be one of: ${current.options.join(', ')}` });
        // "leave" is a decision to do nothing: store it as Rejected so it stays suppressed.
        status = chosen === 'leave' ? 'Rejected' : 'Approved';
      }

      const decidedAt = new Date().toISOString();
      const [updated] = await at.update(tables.changes, [{
        id: current.id,
        fields: { Status: status, 'Chosen option': chosen ?? '', 'Decided by': email, 'Decided at': decidedAt, Note: String(note).slice(0, 2000) },
      }]);
      await at.create(tables.audit, [{
        At: decidedAt, Actor: email, Action: status === 'Approved' ? 'approved' : 'rejected',
        'Change Key': current.key, Email: current.email, Detail: JSON.stringify({ option: chosen, note }),
      }]);
      res.json(toApi(updated));
    } catch (err) { next(err); }
  });

  return router;
}
