// Compares the vault snapshot to Mailchimp and produces change records.
// Pure function: no network, no clock. Everything it needs is passed in.
import { normalizeVaultRecord } from './normalize.js';
import { makeChange } from './rules.js';

const LIVE = new Set(['subscribed', 'pending', 'transactional']);

/**
 * @param {Object} p
 * @param {Object[]} p.currentRecords     raw vault records (today's snapshot)
 * @param {Object[]|null} p.previousRecords raw vault records from the last processed snapshot (null on first run)
 * @param {Record<string, import('./normalize.js').Member[]>} p.members  per audience key, including archived
 * @param {Object} p.fieldMap
 * @param {(c: import('./normalize.js').Contact) => string[]} p.routeContact
 * @param {Record<string, {supplierOnly: boolean}>} p.audiences
 * @param {string[]} p.extraManagedTags
 * @param {string[]} p.supplierTags
 * @param {string[]|null} [p.scopeTags]  Mailchimp tags this export covers; null = every program
 */
export function diff(p) {
  const changes = [];
  const current = p.currentRecords.map((r) => normalizeVaultRecord(r, p.fieldMap));
  const previous = (p.previousRecords ?? []).map((r) => normalizeVaultRecord(r, p.fieldMap));

  // Tags the sync may touch. A one-program export only manages that program's tag(s), so contacts
  // from other programs are never flagged as missing. No scope = the export covers every program.
  const allTags = [...Object.values(p.fieldMap.programTags), ...p.extraManagedTags];
  const managed = new Set(p.scopeTags ?? allTags);
  const supplierTags = new Set(p.supplierTags);

  // ---- 1. Vault hygiene: placeholders, malformed emails, duplicates ----
  const usable = [];
  const excluded = [];
  const seen = new Map();
  for (const c of current) {
    if (c.excluded && c.email) {
      changes.push(makeChange('EXCLUDED_CATEGORY', { email: c.email, vault: view(c), reason: `Category "${c.category}" is never synced` }));
      excluded.push(c);
      continue;
    }
    if (c.placeholder) {
      changes.push(makeChange('PLACEHOLDER', { email: c.email, vault: view(c), reason: 'Seat placeholder or no email' }));
      continue;
    }
    if (!c.validEmail) {
      changes.push(makeChange('INVALID_EMAIL', { email: c.email, vault: view(c), reason: 'Email is malformed' }));
      continue;
    }
    seen.set(c.email, (seen.get(c.email) ?? 0) + 1);
    usable.push(c);
  }
  const dupes = new Set([...seen].filter(([, n]) => n > 1).map(([e]) => e));
  for (const email of dupes) {
    const rows = usable.filter((c) => c.email === email).map(view);
    changes.push(makeChange('DUPLICATE_IN_VAULT', { email, vault: rows, reason: `${rows.length} vault records share this email` }));
  }
  const contacts = usable.filter((c) => !dupes.has(c.email));
  const vaultEmails = new Set(current.map((c) => c.email).filter(Boolean));

  // ---- 2. Email changes (same vault ID, different email) ----
  const prevById = new Map(previous.filter((c) => c.vaultId).map((c) => [c.vaultId, c]));
  const prevEmails = new Set(previous.filter((c) => c.active && c.email).map((c) => c.email));
  const movedFrom = new Map(); // newEmail -> oldEmail
  for (const c of contacts) {
    const before = c.vaultId ? prevById.get(c.vaultId) : null;
    if (before && before.email && before.email !== c.email && !vaultEmails.has(before.email)) {
      movedFrom.set(c.email, before.email);
    }
  }
  const oldEmails = new Set(movedFrom.values());

  // Anyone unsubscribed or cleaned in ANY audience is never auto-added to another one.
  const suppressed = new Map();
  for (const [aud, list] of Object.entries(p.members)) {
    for (const mem of list) if (mem.status === 'unsubscribed' || mem.status === 'cleaned') suppressed.set(mem.email, `${mem.status} in ${aud}`);
  }

  // ---- 3. Per-audience comparison ----
  for (const [aud, list] of Object.entries(p.members)) {
    const byEmail = new Map(list.map((m) => [m.email, m]));
    const supplierOnly = Boolean(p.audiences[aud]?.supplierOnly);

    // Excluded rows (e.g. the operator's own staff) already sitting on a supplier list or tag
    for (const c of excluded) {
      const m = byEmail.get(c.email);
      if (!m || !LIVE.has(m.status)) continue;
      const badTags = m.tags.filter((t) => supplierTags.has(t));
      if (supplierOnly || badTags.length) {
        changes.push(makeChange('OPERATOR_ON_SUPPLIER', {
          audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
          proposed: { tags: badTags },
          reason: `Vault category "${c.category}" must not be on a supplier list${badTags.length ? ` (has ${badTags.join(', ')})` : ''}`,
        }));
      }
    }

    for (const c of contacts) {
      const routed = p.routeContact(c).includes(aud);
      const m = byEmail.get(c.email);

      // Inactive in the vault but still live here
      if (!c.active) {
        if (routed && m && LIVE.has(m.status)) {
          changes.push(makeChange('VAULT_INACTIVE', {
            audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
            proposed: { managedTags: m.tags.filter((t) => managed.has(t)) },
            reason: `Vault status is "${c.status || 'blank'}", not Active`,
          }));
        }
        continue;
      }

      // Operator conflict: an operator routed to a supplier-only audience, or carrying a supplier tag
      if (c.type === 'operator') {
        const badTags = c.tags.filter((t) => supplierTags.has(t));
        if ((routed && supplierOnly) || (routed && badTags.length)) {
          changes.push(makeChange('OPERATOR_ON_SUPPLIER', {
            audience: aud, email: c.email, vault: view(c), mailchimp: m ? mview(m) : null,
            proposed: { tags: badTags },
            reason: supplierOnly ? 'Operator routed to a supplier-only audience' : `Operator with supplier tag(s): ${badTags.join(', ')}`,
          }));
          continue;
        }
      }

      if (!routed) continue;

      // Email change: the old address is still in this audience
      const oldEmail = movedFrom.get(c.email);
      const oldMember = oldEmail ? byEmail.get(oldEmail) : null;
      if (oldMember && LIVE.has(oldMember.status)) {
        if (!m) {
          changes.push(makeChange('EMAIL_CHANGE', {
            audience: aud, email: c.email, vault: view(c), mailchimp: mview(oldMember),
            proposed: { from: oldEmail, to: c.email, fields: fieldsOf(c), tags: c.tags },
            reason: `Vault record ${c.vaultId} changed email`,
          }));
          continue;
        }
        // New address is already here too: the old one is left over.
        changes.push(makeChange('VAULT_INACTIVE', {
          audience: aud, email: oldEmail, vault: view(c), mailchimp: mview(oldMember),
          proposed: { managedTags: oldMember.tags.filter((t) => managed.has(t)) },
          reason: `Old address after vault record ${c.vaultId} moved to ${c.email}`,
        }));
      }

      if (!m && suppressed.has(c.email)) {
        changes.push(makeChange('SUPPRESSED_ELSEWHERE', {
          audience: aud, email: c.email, vault: view(c),
          proposed: { fields: fieldsOf(c), tags: c.tags },
          reason: `Unsubscribed or bounced in another audience (${suppressed.get(c.email)})`,
        }));
        continue;
      }
      if (!m) {
        changes.push(makeChange('NEW_CONTACT', {
          audience: aud, email: c.email, vault: view(c),
          proposed: { fields: fieldsOf(c), tags: c.tags },
          reason: 'In the vault, not in this audience',
        }));
        continue;
      }
      if (m.status === 'archived') {
        changes.push(makeChange('READD_ARCHIVED', {
          audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
          proposed: { fields: fieldsOf(c), tags: c.tags },
          reason: 'Active in the vault but archived in Mailchimp',
        }));
        continue;
      }
      if (m.status === 'unsubscribed') {
        changes.push(makeChange('MC_UNSUBSCRIBED', { audience: aud, email: c.email, vault: view(c), mailchimp: mview(m), reason: 'Unsubscribed in Mailchimp; never resubscribed' }));
        continue;
      }
      if (m.status === 'cleaned') {
        changes.push(makeChange('MC_CLEANED', { audience: aud, email: c.email, vault: view(c), mailchimp: mview(m), reason: 'Bounced (cleaned) in Mailchimp' }));
        continue;
      }

      // Live member: fields and tags
      const fieldDiff = {};
      for (const f of ['firstName', 'lastName', 'company']) {
        if (c[f] && c[f] !== m[f]) fieldDiff[f] = c[f]; // never blank out Mailchimp data
      }
      if (Object.keys(fieldDiff).length) {
        changes.push(makeChange('FIELD_UPDATE', {
          audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
          proposed: { fields: fieldDiff }, reason: `Changed: ${Object.keys(fieldDiff).join(', ')}`,
        }));
      }
      const add = c.tags.filter((t) => !m.tags.includes(t));
      if (add.length) {
        changes.push(makeChange('TAG_ADD', {
          audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
          proposed: { tags: add }, reason: `Add tag(s): ${add.join(', ')}`,
        }));
      }
      const remove = m.tags.filter((t) => managed.has(t) && !c.tags.includes(t));
      if (remove.length) {
        changes.push(makeChange('TAG_REMOVE', {
          audience: aud, email: c.email, vault: view(c), mailchimp: mview(m),
          proposed: { tags: remove }, reason: `Vault no longer gives: ${remove.join(', ')}`,
        }));
      }
    }

    // Mailchimp side: live members carrying a managed tag
    for (const m of list) {
      if (!LIVE.has(m.status)) continue;
      const mTags = m.tags.filter((t) => managed.has(t));
      if (!mTags.length || vaultEmails.has(m.email) || oldEmails.has(m.email)) continue;

      if (prevEmails.has(m.email)) {
        changes.push(makeChange('VAULT_INACTIVE', {
          audience: aud, email: m.email, mailchimp: mview(m),
          proposed: { managedTags: mTags }, reason: 'Removed from the vault since the last snapshot',
        }));
      } else {
        changes.push(makeChange('MC_ONLY', {
          audience: aud, email: m.email, mailchimp: mview(m),
          proposed: { managedTags: mTags }, reason: 'Has a vault program tag but is not in the vault',
        }));
      }
    }
  }

  return changes;
}

const fieldsOf = (c) => ({ firstName: c.firstName, lastName: c.lastName, company: c.company });
const view = (c) => ({ vaultId: c.vaultId, email: c.email, ...fieldsOf(c), category: c.category, type: c.type, status: c.status, active: c.active, tags: c.tags });
const mview = (m) => ({ email: m.email, status: m.status, firstName: m.firstName, lastName: m.lastName, company: m.company, tags: m.tags });

/** Program chips in the export that have no Mailchimp tag mapping, with counts. For the run log. */
export function unmappedPrograms(records, fieldMap) {
  const counts = new Map();
  for (const r of records) {
    for (const prog of normalizeVaultRecord(r, fieldMap).unmappedPrograms) counts.set(prog, (counts.get(prog) ?? 0) + 1);
  }
  return [...counts].map(([prog, n]) => `${prog} (${n})`);
}
