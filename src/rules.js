// What happens to each kind of difference. This table is the "Change types and rules" section of the spec.
import { createHash } from 'node:crypto';

export const OUTCOME = { AUTO: 'Auto', APPROVAL: 'Approval', CELIA: 'For Celia', BLOCK: 'Block', SKIP: 'Skip' };

/**
 * outcome:     what the run does with it
 * forCelia:    also listed in the report's "For Celia" section
 * options:     choices an approver picks from (first = default)
 */
export const RULES = {
  NEW_CONTACT:          { outcome: OUTCOME.AUTO,     forCelia: false, options: [] },
  FIELD_UPDATE:         { outcome: OUTCOME.AUTO,     forCelia: false, options: [] },
  TAG_ADD:              { outcome: OUTCOME.AUTO,     forCelia: false, options: [] },
  SUPPRESSED_ELSEWHERE: { outcome: OUTCOME.APPROVAL, forCelia: true,  options: ['add', 'leave'] },
  READD_ARCHIVED:      { outcome: OUTCOME.APPROVAL, forCelia: false, options: ['re-add', 'leave'] },
  TAG_REMOVE:           { outcome: OUTCOME.APPROVAL, forCelia: false, options: ['remove-tags', 'leave'] },
  EMAIL_CHANGE:         { outcome: OUTCOME.APPROVAL, forCelia: false, options: ['update-email', 'archive-old-add-new', 'leave'] },
  VAULT_INACTIVE:       { outcome: OUTCOME.APPROVAL, forCelia: false, options: ['untag', 'archive', 'leave'] },
  MC_ONLY:              { outcome: OUTCOME.APPROVAL, forCelia: true,  options: ['untag', 'archive', 'leave'] },
  MC_UNSUBSCRIBED:      { outcome: OUTCOME.CELIA,    forCelia: true,  options: [] },
  MC_CLEANED:           { outcome: OUTCOME.CELIA,    forCelia: true,  options: [] },
  OPERATOR_ON_SUPPLIER: { outcome: OUTCOME.BLOCK,    forCelia: true,  options: [] },
  DUPLICATE_IN_VAULT:   { outcome: OUTCOME.BLOCK,    forCelia: true,  options: [] },
  INVALID_EMAIL:        { outcome: OUTCOME.SKIP,     forCelia: true,  options: [] },
  PLACEHOLDER:          { outcome: OUTCOME.SKIP,     forCelia: false, options: [] },
  EXCLUDED_CATEGORY:    { outcome: OUTCOME.SKIP,     forCelia: false, options: [] },
};

/** Stable key: same type + audience + email + proposed values => same key, so nothing is queued twice. */
export function changeKey({ type, audience, email, proposed }) {
  const body = JSON.stringify([type, audience ?? '', email ?? '', sortDeep(proposed ?? null)]);
  return createHash('sha1').update(body).digest('hex').slice(0, 16);
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

/** Build a change record with its rule applied. */
export function makeChange(type, { audience = null, email = '', vault = null, mailchimp = null, proposed = null, reason = '' }) {
  const rule = RULES[type];
  if (!rule) throw new Error(`Unknown change type ${type}`);
  const change = {
    type,
    outcome: rule.outcome,
    forCelia: rule.forCelia,
    options: rule.options,
    audience,
    email,
    vault,
    mailchimp,
    proposed,
    reason,
    held: false,
  };
  change.key = changeKey(change);
  return change;
}

/**
 * Circuit breaker. If a run would auto-apply too much, every auto change becomes an approval.
 * @param {ReturnType<typeof makeChange>[]} changes
 * @param {Record<string, number>} audienceSizes  member count per audience key
 */
export function applyCircuitBreaker(changes, audienceSizes, { maxAutoChanges, maxAudienceShare }) {
  const auto = changes.filter((c) => c.outcome === OUTCOME.AUTO);
  const perAudience = {};
  for (const c of auto) perAudience[c.audience] = (perAudience[c.audience] ?? 0) + 1;

  const reasons = [];
  if (auto.length > maxAutoChanges) reasons.push(`${auto.length} auto changes > limit ${maxAutoChanges}`);
  for (const [aud, n] of Object.entries(perAudience)) {
    const size = audienceSizes[aud] ?? 0;
    if (size > 0 && n / size > maxAudienceShare) {
      reasons.push(`${n} auto changes in ${aud} = ${((n / size) * 100).toFixed(1)}% of ${size}`);
    }
  }
  if (reasons.length === 0) return { tripped: false, reasons, changes };

  const held = changes.map((c) =>
    c.outcome === OUTCOME.AUTO
      ? { ...c, outcome: OUTCOME.APPROVAL, options: ['apply', 'leave'], held: true, reason: `Held by circuit breaker. ${c.reason}`.trim() }
      : c,
  );
  return { tripped: true, reasons, changes: held };
}
