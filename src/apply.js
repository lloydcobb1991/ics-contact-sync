// Turns an auto or approved change into Mailchimp calls. The only module that writes to Mailchimp.

/** Normalized fields -> Mailchimp merge_fields, dropping blanks so nothing gets erased. */
export function toMergeFields(fields, mergeFieldMap) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v && mergeFieldMap[k]) out[mergeFieldMap[k]] = v;
  }
  return out;
}

/**
 * Plan the calls for one change without making them. Used for dry runs and for the audit log.
 * @returns {{op: string, args: any[]}[]}
 */
export function plan(change, option, listIds, mergeFieldMap) {
  const list = listIds[change.audience];
  if (!list) throw new Error(`No Mailchimp list ID for audience "${change.audience}"`);
  const p = change.proposed ?? {};
  const mf = toMergeFields(p.fields, mergeFieldMap);
  const opt = option ?? (change.held ? 'apply' : null);

  switch (change.type) {
    case 'NEW_CONTACT':
      return [
        { op: 'upsertNew', args: [list, change.email, mf] },
        ...(p.tags?.length ? [{ op: 'setTags', args: [list, change.email, { add: p.tags }] }] : []),
      ];
    case 'SUPPRESSED_ELSEWHERE':
      if (opt !== 'add') return [];
      return [
        { op: 'upsertNew', args: [list, change.email, mf] },
        ...(p.tags?.length ? [{ op: 'setTags', args: [list, change.email, { add: p.tags }] }] : []),
      ];
    case 'READD_ARCHIVED':
      if (opt !== 're-add') return [];
      return [
        { op: 'readdArchived', args: [list, change.email, mf] },
        ...(p.tags?.length ? [{ op: 'setTags', args: [list, change.email, { add: p.tags }] }] : []),
      ];
    case 'FIELD_UPDATE':
      return [{ op: 'updateFields', args: [list, change.email, mf] }];
    case 'TAG_ADD':
      return [{ op: 'setTags', args: [list, change.email, { add: p.tags }] }];
    case 'TAG_REMOVE':
      return opt === 'remove-tags' ? [{ op: 'setTags', args: [list, change.email, { remove: p.tags }] }] : [];
    case 'EMAIL_CHANGE':
      if (opt === 'update-email') return [{ op: 'changeEmail', args: [list, p.from, p.to, mf] }];
      if (opt === 'archive-old-add-new') {
        return [
          { op: 'archive', args: [list, p.from] },
          { op: 'upsertNew', args: [list, p.to, mf] },
          ...(p.tags?.length ? [{ op: 'setTags', args: [list, p.to, { add: p.tags }] }] : []),
        ];
      }
      return [];
    case 'VAULT_INACTIVE':
    case 'MC_ONLY':
      if (opt === 'untag') return [{ op: 'setTags', args: [list, change.email, { remove: p.managedTags }] }];
      if (opt === 'archive') return [{ op: 'archive', args: [list, change.email] }];
      return [];
    default:
      // For Celia / Block / Skip types never write.
      return [];
  }
}

/** Execute a plan. In dry-run mode returns the plan without calling Mailchimp. */
export async function execute(mc, steps, { dryRun }) {
  if (dryRun) return { dryRun: true, steps };
  const results = [];
  for (const s of steps) {
    await mc[s.op](...s.args);
    results.push(s.op);
  }
  return { dryRun: false, steps, results };
}

/** Run tasks with a concurrency limit, collecting per-task success or error. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { ok: true, value: await fn(items[idx]) }; }
      catch (err) { out[idx] = { ok: false, error: err }; }
    }
  });
  await Promise.all(workers);
  return out;
}
