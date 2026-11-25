// Daily sync. Railway cron: 0 13 * * *  (6:00 am Arizona, which has no DST)
//
//   1. load + validate the vault snapshot      4. reconcile with the Airtable queue
//   2. read both Mailchimp audiences           5. apply auto + approved changes (live mode only)
//   3. diff + rules + circuit breaker          6. record the run, alert Lee on trouble
import { pathToFileURL } from 'node:url';
import { diff, unmappedPrograms } from '../diff.js';
import { applyCircuitBreaker, OUTCOME } from '../rules.js';
import { reconcile, STATUS } from '../queue.js';
import { plan, execute, pool } from '../apply.js';
import { validateSnapshot } from '../snapshot.js';
import { changeToFields, rowToRecord } from '../airtable.js';
import { fieldMap, extraManagedTags, supplierTags } from '../../config/fieldMap.js';
import { audiences, routeContact } from '../../config/routing.js';
import { settings } from '../../config/settings.js';

const OPEN_OR_SUPPRESSING = ['Queued', 'Pending', 'Open', 'Approved', 'Failed', 'Rejected'];

export async function runDaily(ctx, { now = new Date() } = {}) {
  const { at, mc, snapshots, tables, listIds, dryRun } = ctx;
  const runId = now.toISOString().slice(0, 16) + 'Z';
  const log = [];
  const counts = { auto: 0, queued: 0, forCelia: 0, blocked: 0, skipped: 0, applied: 0, failed: 0, superseded: 0 };
  const [runRow] = await at.create(tables.runs, [{ 'Run ID': runId, Started: now.toISOString(), Status: 'Running', Mode: dryRun ? 'dry-run' : 'live' }]);
  const finish = (fields) => at.update(tables.runs, [{ id: runRow.id, fields: { Finished: new Date().toISOString(), Log: log.join('\n'), ...fields } }]);

  try {
    // ---- 1. Snapshot ----
    const lastRuns = await at.list(tables.runs, {
      filterByFormula: `AND({Status} != 'Failed', {Status} != 'Running', {Status} != 'Skipped')`,
      'sort[0][field]': 'Started', 'sort[0][direction]': 'desc', maxRecords: '1',
    });
    const last = lastRuns[0]?.fields ?? {};
    const sha = await snapshots.latestSha();
    const prevSha = sha === last['Snapshot SHA'] ? last['Previous SHA'] : last['Snapshot SHA'];
    const snap = await snapshots.at(sha);
    const prevSnap = prevSha ? await snapshots.at(prevSha) : null;

    const v = validateSnapshot(snap, prevSnap, { fieldMap, ...settings, now });
    log.push(...v.errors, ...v.warnings);
    if (!v.ok) throw new Error(`Snapshot rejected: ${v.errors.join(' | ')}`);
    if (v.stale) {
      // Leave the queue untouched: a stale diff would supersede real items.
      await finish({ Status: 'Skipped', 'Snapshot SHA': sha, 'Snapshot age (h)': Math.round(v.ageHours ?? -1) });
      await alert(ctx, `Contact sync skipped: stale vault snapshot`, log);
      return { status: 'Skipped', log };
    }

    // ---- 2. Mailchimp ----
    const members = {};
    const sizes = {};
    for (const aud of Object.keys(audiences)) {
      members[aud] = await mc.listMembers(listIds[aud], fieldMap.mergeFields);
      sizes[aud] = members[aud].filter((m) => m.status !== 'archived').length;
    }

    // ---- 3. Diff + rules ----
    const raw = diff({
      currentRecords: snap.records,
      previousRecords: prevSnap?.records ?? null,
      members, fieldMap, routeContact, audiences, extraManagedTags, supplierTags,
      scopeTags: snap.scopeTags ?? null,
    });
    log.push(`Exports: ${(snap.files ?? []).join(', ')}; scope: ${snap.scopeTags ? snap.scopeTags.join(', ') : 'all programs'}`);
    const unmapped = unmappedPrograms(snap.records, fieldMap);
    if (unmapped.length) log.push(`Programs with no Mailchimp tag mapping (not synced): ${unmapped.join(', ')}`);
    const breaker = applyCircuitBreaker(raw, sizes, settings.circuitBreaker);
    if (breaker.tripped) log.push(`Circuit breaker tripped: ${breaker.reasons.join('; ')}`);
    const changes = breaker.changes;
    for (const c of changes) {
      if (c.outcome === OUTCOME.AUTO) counts.auto++;
      else if (c.outcome === OUTCOME.APPROVAL) counts.queued++;
      else if (c.outcome === OUTCOME.BLOCK) counts.blocked++;
      else if (c.outcome === OUTCOME.SKIP) counts.skipped++;
      if (c.forCelia) counts.forCelia++;
    }

    // ---- 4. Reconcile with Airtable ----
    const statusFilter = OPEN_OR_SUPPRESSING.map((s) => `{Status} = '${s}'`).join(', ');
    const existingRows = await at.list(tables.changes, {
      filterByFormula: `OR(${statusFilter}, AND({Status} = 'Applied', IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -30, 'days'))))`,
    });
    const existing = existingRows.map(rowToRecord);
    const r = reconcile(changes, existing);

    const created = await at.create(tables.changes, r.create.map(({ change, status }) => changeToFields(change, status, runId)));
    const idByKey = new Map(created.map((row) => [row.fields['Change Key'], row.id]));
    if (r.touch.length) await at.update(tables.changes, r.touch.map((rec) => ({ id: rec.id, fields: { 'Last seen run': runId } })));
    if (r.supersede.length) {
      await at.update(tables.changes, r.supersede.map((rec) => ({ id: rec.id, fields: { Status: STATUS.SUPERSEDED } })));
      await audit(ctx, r.supersede.map((rec) => ({ action: 'superseded', key: rec.key, email: rec.email, detail: { previousStatus: rec.status } })));
      counts.superseded = r.supersede.length;
    }

    // ---- 5. Apply ----
    const results = await pool(r.apply, settings.mailchimp.concurrency, async ({ change, record, option }) => {
      const steps = plan(change, option, listIds, fieldMap.mergeFields);
      return { steps, out: await execute(mc, steps, { dryRun }) };
    });

    const updates = [];
    const auditRows = [];
    r.apply.forEach((item, i) => {
      const id = item.record?.id ?? idByKey.get(item.change.key);
      const res = results[i];
      if (res.ok && res.value.out.dryRun) return; // dry run: leave status as is
      if (res.ok) {
        counts.applied++;
        updates.push({ id, fields: { Status: STATUS.APPLIED, 'Applied at': new Date().toISOString(), Error: '' } });
        auditRows.push({ action: item.record?.decidedBy ? 'applied' : 'auto-applied', key: item.change.key, email: item.change.email, detail: res.value.steps });
      } else {
        counts.failed++;
        updates.push({ id, fields: { Status: STATUS.FAILED, Attempts: (item.record?.attempts ?? 0) + 1, Error: String(res.error.message).slice(0, 1000) } });
        auditRows.push({ action: 'failed', key: item.change.key, email: item.change.email, detail: { error: res.error.message } });
      }
    });
    if (updates.length) await at.update(tables.changes, updates);
    if (auditRows.length) await audit(ctx, auditRows);
    if (dryRun) log.push(`Dry run: ${r.apply.length} change(s) would have been applied.`);
    if (breaker.tripped) await audit(ctx, [{ action: 'run-held', key: '', email: '', detail: breaker.reasons }]);

    // ---- 6. Record the run ----
    const status = breaker.tripped ? 'Held' : counts.failed ? 'Partial' : 'Success';
    await finish({
      Status: status,
      'Snapshot SHA': sha,
      'Previous SHA': prevSha ?? '',
      'Snapshot age (h)': Math.round(v.ageHours),
      'Vault contacts': snap.records.length,
      'MC members': JSON.stringify(sizes),
      'Auto applied': counts.applied,
      Queued: counts.queued,
      'For Celia': counts.forCelia,
      Blocked: counts.blocked,
      Skipped: counts.skipped,
      Errors: counts.failed,
    });
    if (status !== 'Success') await alert(ctx, `Contact sync run ${status.toLowerCase()}`, log);
    return { status, counts, log };
  } catch (err) {
    log.push(`FAILED: ${err.message}`);
    await finish({ Status: 'Failed' }).catch(() => {});
    await alert(ctx, 'Contact sync run failed', log).catch(() => {});
    throw err;
  }
}

async function audit(ctx, rows) {
  await ctx.at.create(ctx.tables.audit, rows.map((r) => ({
    At: new Date().toISOString(),
    Actor: r.actor ?? 'system',
    Action: r.action,
    'Change Key': r.key,
    Email: r.email,
    Detail: JSON.stringify(r.detail ?? null),
  })));
}

async function alert(ctx, subject, log) {
  const text = log.join('\n') || '(no details)';
  await ctx.mailer.send({ to: ctx.alertTo, subject, text, html: `<pre>${escapeHtml(text)}</pre>` });
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);

// CLI entry: `npm run daily`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadContext } = await import('../context.js');
  runDaily(loadContext())
    .then((r) => { console.log(JSON.stringify(r, null, 2)); })
    .catch((err) => { console.error(err); process.exit(1); });
}
