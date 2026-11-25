# ics-contact-sync

A daily one-way sync from Celia's Contact Vault (which we only read) into the ICS Mailchimp audiences.
Safe changes apply automatically. Removals, archives and email rewrites wait for **Celia or Ryan** to
approve them in the portal. A report goes out every Monday.

Full design: the **Contact Vault → Mailchimp Sync: Build Spec** doc.

```
Vault (ICS Program Operations Suite → Contact Vault, read-only)
  └─ Monday ~8:30am  Lloyd: Export CSV ──► drag into the portal's Contact Sync tab
        │  checked (columns, size) ──► saved to GitHub snapshots/ in one commit
        └─► sync runs immediately ──► Monday report emailed when it finishes
              ├─ read Mailchimp (Master + RFP/APL)
              ├─ diff → rules → circuit breaker
              ├─ reconcile with the Airtable queue (Sync Changes)
              └─ apply auto + approved changes   (only when SYNC_MODE=live)
  Daily 6:00am  Railway: npm run daily   (applies yesterday's approvals; same export)
  Mon 11:00am   Railway: npm run weekly  (fallback: sends only if no report went out today)
  Portal "Contact Sync" tab ──► approve / reject (Celia + Ryan only)
```

## Layout

| Path | What it is |
| --- | --- |
| `config/fieldMap.js` | Vault columns → contact fields → Mailchimp merge tags; managed tags. **Fill in when the vault is shared.** |
| `config/routing.js` | Which audiences each contact belongs in. **Confirm with Celia.** |
| `config/settings.js` | Staleness, bad-export and circuit-breaker thresholds |
| `src/diff.js` | Vault vs Mailchimp → change records (pure) |
| `src/rules.js` | Change type → Auto / Approval / For Celia / Block / Skip; circuit breaker |
| `src/queue.js` | Reconciles detected changes with the Airtable queue (pure) |
| `src/apply.js` | The only code that writes to Mailchimp |
| `src/report.js` | Monday report builder (pure) |
| `src/jobs/daily.js`, `src/jobs/weekly.js` | Railway cron entry points |
| `src/server/router.js` | Express routes for the portal tab; mount on the portal's Railway backend |
| `portal/ContactSync.jsx` | React tab for the Internal Tools Portal |
| `src/csv.js`, `src/snapshot.js` | Read the vault CSV exports from GitHub, merge them, check them |
| `snapshot-task/PROMPT.md` | Later option: a Claude scheduled task that exports daily (needs a seat or Celia's account) |
| `test/` | `npm test`: diff, rules, queue, snapshot checks and report, against fixtures |

## Setup

1. **Airtable:** in the Mailchimp-module base, create the three tables (field lists below).
2. **GitHub:** create the private repo `ics-contact-sync-snapshots` (one commit with a README so `main` exists). Give Railway a
   fine-grained token for that repo only, with *Contents: read and write* (uploads are committed through it).
3. **Railway:** a new service from this repo. Set the variables from `.env.example` (leave `SYNC_MODE=dry-run`), then add two cron jobs:
   - `npm run daily`, schedule `0 13 * * *` (6:00 am AZ): applies approvals from the day before
   - `npm run weekly`, schedule `0 18 * * 1` (11:00 am AZ, Mondays): fallback only; skips if the upload already sent the report
4. **Portal:** mount `createContactSyncRouter({ ctx: loadContext(), getUserEmail })` at `/api/contact-sync` on the backend,
   wire `getUserEmail` to the portal's auth, and add `ContactSync.jsx` as a tab (`npm run check:portal` compile-checks it).
   Approvers = `APPROVER_EMAILS`; who may upload = `UPLOADER_EMAILS`.
5. **Vault export (weekly, about a minute):** Monday around 8:30 am, open the Contact Vault, pick **All programs** in the
   dropdown next to Export CSV (or export each program), and drag the file(s) into the portal's Contact Sync tab.
   Pick what each file covers (All programs / Alterra only / Swingers only), then **Save & sync**. The export is checked
   first (columns present, not suspiciously small); a bad file is refused and nothing changes. A good one is saved to
   GitHub, synced on the spot, and on Mondays the weekly report goes out when the sync finishes.
   The "covers" choice matters: a one-program export never flags other programs' contacts as missing.

### Vault export notes
- Columns used: Category, Company, Active clients, First, Last, Email, Status. A renamed column fails the run.
- `Category = Client` rows (the operator's own staff) are never synced.
- `Status` other than Active (e.g. Unknown) is held back.
- Program chips map to tags in `config/fieldMap.js` → `programTags` (Swingers → `Swingers APL 26/27`; update each season).
  Unmapped chips (e.g. "Alterra - Palisades") are left off and listed in the run log.
- No ID column, so a changed email shows as a new contact plus the old address flagged for approval.

### Airtable fields

**Sync Runs:** Run ID (text, primary) · Started, Finished (date-time) · Status (single select: Running, Success, Partial, Held, Skipped, Failed) ·
Mode (text) · Snapshot SHA, Previous SHA (text) · Snapshot age (h), Vault contacts, Auto applied, Queued, For Celia, Blocked, Skipped, Errors (number) ·
MC members, Log (long text)

**Sync Changes:** Change Key (text, primary) · Type, Outcome, Status (single select) · Email, Audience, Chosen option, Decided by,
First seen run, Last seen run (text) · Vault value, Mailchimp value, Proposed action, Reason, Note, Error (long text) · Options (multi-select) ·
For Celia, Held (checkbox) · Attempts (number) · Decided at, Applied at (date-time)

Status values: Queued, Pending, Open, Approved, Rejected, Applied, Superseded, Failed.

**Sync Audit:** At (date-time) · Actor, Change Key, Email (text) · Action (single select) · Detail (long text)

## Phases

1. Dry run: everything except Mailchimp writes. Check two Monday reports with Celia.
2. Approval queue live in the portal (still a dry run).
3. `SYNC_MODE=live`.
4. Retire the manual import CSVs, the bounce emails and the SharePoint contact-changes sheet.
