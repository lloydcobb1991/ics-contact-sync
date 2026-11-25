// Monday report.
//   - Normally sent right after Lloyd's Monday upload finishes syncing (see src/server/router.js).
//   - Fallback Railway cron: 0 18 * * 1  (11:00 am Arizona, Mondays). Sends only if no report went out today,
//     using last week's data and saying so.
import { pathToFileURL } from 'node:url';
import { buildReport } from '../report.js';

const azDate = (d) => new Date(d.getTime() - 7 * 36e5).toISOString().slice(0, 10); // Arizona = UTC-7, no DST

export async function runWeekly(ctx, { now = new Date(), onlyIfNotSentToday = true } = {}) {
  const { at, tables } = ctx;

  if (onlyIfNotSentToday) {
    const recent = await at.list(tables.audit, { filterByFormula: `AND({Action} = 'report-sent', IS_AFTER({At}, DATEADD(NOW(), -2, 'days')))` });
    if (recent.some((r) => azDate(new Date(r.fields.At)) === azDate(now))) return { skipped: 'Report already sent today' };
  }

  const week = `IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -7, 'days'))`;
  const open = `OR({Status} = 'Pending', {Status} = 'Open', {Status} = 'Failed', {Status} = 'Approved', {Status} = 'Queued')`;
  const changes = (await at.list(tables.changes, { filterByFormula: `OR(${open}, ${week})` }))
    .map((r) => ({ ...r.fields, Created: r.createdTime }));
  const runs = (await at.list(tables.runs, { filterByFormula: `IS_AFTER({Started}, DATEADD(NOW(), -7, 'days'))` }))
    .map((r) => r.fields);

  // Fresh = the newest run this week used an export uploaded in the last 3 days.
  const newest = [...runs].sort((a, b) => String(b.Started).localeCompare(String(a.Started)))[0];
  const freshExport = Boolean(newest && Number.isFinite(newest['Snapshot age (h)']) && newest['Snapshot age (h)'] <= 72);

  const report = buildReport({ changes, runs, now, portalUrl: ctx.portalUrl, dryRun: ctx.dryRun, freshExport });
  await ctx.mailer.send({ to: ctx.reportTo, ...report });
  await at.create(tables.audit, [{ At: now.toISOString(), Actor: 'system', Action: 'report-sent', 'Change Key': '', Email: '', Detail: JSON.stringify({ subject: report.subject, freshExport }) }]);
  return { subject: report.subject, freshExport };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadContext } = await import('../context.js');
  runWeekly(loadContext())
    .then((r) => console.log(r))
    .catch((err) => { console.error(err); process.exit(1); });
}
