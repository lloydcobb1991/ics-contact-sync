// Reconciles today's detected changes with the queue already in Airtable.
// Pure function: decides what to create, touch, supersede and apply. Airtable I/O lives in airtable.js.
import { OUTCOME } from './rules.js';

export const STATUS = {
  QUEUED: 'Queued',       // auto change waiting for this run's apply
  PENDING: 'Pending',     // waiting for Celia or Ryan
  OPEN: 'Open',           // informational (For Celia / Block / Skip)
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  APPLIED: 'Applied',
  SUPERSEDED: 'Superseded',
  FAILED: 'Failed',
};

const OPEN = new Set([STATUS.QUEUED, STATUS.PENDING, STATUS.OPEN, STATUS.APPROVED, STATUS.FAILED]);
export const MAX_ATTEMPTS = 3;

export function initialStatus(change) {
  if (change.outcome === OUTCOME.AUTO) return STATUS.QUEUED;
  if (change.outcome === OUTCOME.APPROVAL) return STATUS.PENDING;
  return STATUS.OPEN;
}

/**
 * @param {Object[]} detected  changes from diff() (after the circuit breaker)
 * @param {{id: string, key: string, status: string, outcome: string, attempts?: number, decidedBy?: string}[]} existing
 *        every record not yet closed, plus Rejected and Applied records (for suppression and reappearance)
 */
export function reconcile(detected, existing) {
  const openByKey = new Map();
  const rejected = new Set();
  const applied = new Set();
  for (const r of existing) {
    if (OPEN.has(r.status)) openByKey.set(r.key, r);
    else if (r.status === STATUS.REJECTED) rejected.add(r.key);
    else if (r.status === STATUS.APPLIED) applied.add(r.key);
  }

  const create = [];
  const touch = [];
  const apply = [];
  const detectedKeys = new Set();

  for (const change of detected) {
    if (change.type === 'PLACEHOLDER' || change.type === 'EXCLUDED_CATEGORY') continue; // counted, never stored
    detectedKeys.add(change.key);

    const rec = openByKey.get(change.key);
    if (rec) {
      touch.push(rec);
      if (shouldApply(rec)) apply.push({ change, record: rec, option: rec.chosenOption ?? null });
      continue;
    }
    if (rejected.has(change.key)) continue; // stays rejected until the values change

    if (applied.has(change.key)) {
      // Applied before, detected again: Mailchimp didn't take it, or a config is wrong. Never loop.
      create.push({
        change: { ...change, outcome: OUTCOME.BLOCK, reason: `Reappeared after being applied; check config. ${change.reason}` },
        status: STATUS.OPEN,
      });
      continue;
    }

    const status = initialStatus(change);
    create.push({ change, status });
    if (status === STATUS.QUEUED) apply.push({ change, record: null, option: null });
  }

  // Anything still open but no longer detected has resolved itself (or the approved action is now stale).
  const supersede = [...openByKey.values()].filter((r) => !detectedKeys.has(r.key));

  return { create, touch, supersede, apply };
}

function shouldApply(rec) {
  if (rec.status === STATUS.QUEUED) return true;
  if (rec.status === STATUS.APPROVED) return rec.chosenOption !== 'leave';
  if (rec.status === STATUS.FAILED) {
    const retryable = rec.outcome === OUTCOME.AUTO || Boolean(rec.decidedBy);
    return retryable && (rec.attempts ?? 0) < MAX_ATTEMPTS && rec.chosenOption !== 'leave';
  }
  return false;
}
