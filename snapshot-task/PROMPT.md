> **Not in use yet.** The vault is exported weekly by hand (see README). This prompt is the upgrade path to a daily
> export: it needs a Claude seat in the ICS organization, or a scheduled task on Celia's account. It must write
> `snapshots/all.csv` with the same columns as the vault's Export CSV.

# Daily vault snapshot: scheduled task prompt

Paste the block below as the prompt of a Claude **scheduled task**, daily at 5:15 am Arizona time,
once Celia has shared the vault and the placeholders are filled in. The task only **reads** the vault.

Fill in before use:
- `{{VAULT_ARTIFACT}}`: the vault's artifact link or slug (from Celia's share)
- `{{COLLECTION}}`: the database collection that holds contacts (find it with the artifact tools on day one)
- `{{SNAPSHOT_REPO}}`: e.g. `ignitecs/ics-contact-sync-snapshots` (private)

---

You are taking the daily read-only snapshot of the ICS Contact Vault for the Mailchimp sync.

Rules:
- Never write to, edit, comment on, or republish the vault artifact. Read only.
- Do not change or interpret any record. Copy every field exactly as stored.
- If anything below fails, stop and do not commit. A missing snapshot is safe; a wrong one is not.

Steps:
1. Read every document in the `{{COLLECTION}}` collection of the artifact `{{VAULT_ARTIFACT}}`
   using the artifact database list tool, paging with the cursor until there are no more pages.
   Keep each document's `data` object, and add its document id as the field `id` if `data` has no `id`.
2. Build a CSV with exactly these columns, in this order, quoting any field that contains a comma, quote or newline:
   `Category,Company,Active clients,First,Last,Title,Email,Phone,Territory,Tier,Last verified,Days ago,Status,Notes`
   (Active clients = the contact's programs joined with "; ").
3. Sanity check: records must be a non-empty array. If it is empty, stop without committing.
4. Clone `{{SNAPSHOT_REPO}}`, write the CSV to `snapshots/all.csv` (remove any other CSV in `snapshots/`),
   then commit with the message
   `snapshot <YYYY-MM-DD>: <N> records` and push to `main`.
5. Reply with one line: the record count and the commit SHA.
