// Reads environment variables and builds the clients every job needs.
import { createMailchimp } from './mailchimp.js';
import { createAirtable } from './airtable.js';
import { createSnapshotSource } from './snapshot.js';
import { createMailer } from './sendgrid.js';
import { settings } from '../config/settings.js';
import { audiences } from '../config/routing.js';
import { fieldMap } from '../config/fieldMap.js';

const list = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function loadContext() {
  const listIds = Object.fromEntries(Object.entries(audiences).map(([k, a]) => [k, need(a.envVar)]));
  const tables = {
    runs: process.env.AIRTABLE_TABLE_RUNS || 'Sync Runs',
    changes: process.env.AIRTABLE_TABLE_CHANGES || 'Sync Changes',
    audit: process.env.AIRTABLE_TABLE_AUDIT || 'Sync Audit',
  };
  return {
    dryRun: (process.env.SYNC_MODE || 'dry-run') !== 'live',
    listIds,
    tables,
    approvers: list(process.env.APPROVER_EMAILS),
    uploaders: list(process.env.UPLOADER_EMAILS),
    reportTo: list(process.env.REPORT_RECIPIENTS),
    alertTo: list(process.env.ALERT_RECIPIENTS),
    portalUrl: process.env.PORTAL_URL || '',
    mc: createMailchimp({ apiKey: need('MAILCHIMP_API_KEY'), ...settings.mailchimp }),
    at: createAirtable({ token: need('AIRTABLE_TOKEN'), baseId: need('AIRTABLE_BASE_ID'), tables }),
    snapshots: createSnapshotSource({
      token: need('GITHUB_TOKEN'),
      repo: need('SNAPSHOT_REPO'),
      dir: process.env.SNAPSHOT_DIR || 'snapshots',
      branch: process.env.SNAPSHOT_BRANCH || 'main',
      fieldMap,
    }),
    mailer: createMailer({ apiKey: process.env.SENDGRID_API_KEY, from: process.env.REPORT_FROM || 'sync@ignitecs.co' }),
  };
}
