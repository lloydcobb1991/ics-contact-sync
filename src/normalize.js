// Turns vault records and Mailchimp members into one comparable shape.

/**
 * @typedef {Object} Contact
 * @property {string|null} vaultId
 * @property {string} email        lowercase, trimmed ('' when missing)
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} company
 * @property {string} category    vault Category column (Spirits, Distributor, Client, ...)
 * @property {'supplier'|'operator'|'client'|'staff'|'unknown'} type
 * @property {boolean} excluded    category is never synced
 * @property {string} status       lowercase vault status
 * @property {string[]} programs   raw "Active clients" chips
 * @property {string[]} unmappedPrograms  chips with no Mailchimp tag mapping
 * @property {boolean} active
 * @property {boolean} placeholder
 * @property {boolean} validEmail
 * @property {string[]} tags       Mailchimp tag names derived from programs
 * @property {Object} raw
 */

/**
 * @typedef {Object} Member
 * @property {string} email
 * @property {string} hash         Mailchimp subscriber hash (MD5 of lowercase email)
 * @property {'subscribed'|'unsubscribed'|'cleaned'|'pending'|'transactional'|'archived'} status
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} company
 * @property {string[]} tags
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normEmail = (v) => String(v ?? '').trim().toLowerCase();
const clean = (v) => String(v ?? '').trim();

function toList(v, sep = /[;,|]/) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v).split(sep).map(clean).filter(Boolean);
}

function normType(v) {
  const t = clean(v).toLowerCase();
  if (t.startsWith('supplier') || t === 'brand' || t === 'distributor') return 'supplier';
  if (t.startsWith('operator') || t === 'client') return 'operator';
  if (t === 'staff' || t === 'internal') return 'staff';
  return 'unknown';
}

/** @returns {Contact} */
export function normalizeVaultRecord(raw, fieldMap) {
  const c = fieldMap.columns;
  const get = (key) => (c[key] ? raw[c[key]] : undefined);
  const email = normEmail(get('email'));
  const firstName = clean(get('firstName'));
  const lastName = clean(get('lastName'));
  const company = clean(get('company'));
  const statusVal = clean(get('status')).toLowerCase();

  const nameBlob = `${firstName} ${lastName}`.trim();
  const placeholder =
    !email || fieldMap.placeholderPatterns.some((re) => re.test(nameBlob) || re.test(email));

  const programs = toList(get('programs'), /;/);
  const tags = programs.filter((p) => fieldMap.programTags[p]).map((p) => fieldMap.programTags[p]);
  const unmappedPrograms = programs.filter((p) => !fieldMap.programTags[p]);

  const category = clean(get('category'));
  const type = c.category
    ? (fieldMap.categoryTypes?.[category] ?? 'supplier')
    : normType(get('type'));

  return {
    vaultId: c.vaultId && raw[c.vaultId] != null && raw[c.vaultId] !== '' ? String(raw[c.vaultId]) : null,
    email,
    firstName,
    lastName,
    company,
    category,
    type,
    excluded: (fieldMap.excludeCategories ?? []).includes(category),
    active: fieldMap.activeStatuses.includes(statusVal),
    status: statusVal,
    placeholder,
    validEmail: EMAIL_RE.test(email),
    tags: [...new Set(tags)].sort(),
    programs,
    unmappedPrograms,
    raw,
  };
}

/** @returns {Member} */
export function normalizeMember(m, mergeFields) {
  const mf = m.merge_fields ?? {};
  return {
    email: normEmail(m.email_address),
    hash: m.id,
    status: m.status,
    firstName: clean(mf[mergeFields.firstName]),
    lastName: clean(mf[mergeFields.lastName]),
    company: clean(mf[mergeFields.company]),
    tags: (m.tags ?? []).map((t) => t.name).sort(),
  };
}
