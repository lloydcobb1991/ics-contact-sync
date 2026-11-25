// Which audiences each vault contact belongs in.
//
// Proposed default from the spec (TODO: confirm with Celia):
//   - everyone active        -> ICS Conversations Master
//   - suppliers with a tag   -> also RFP+APL General
//   - operators never go to RFP+APL General

export const audiences = {
  master: { label: 'ICS Conversations Master', envVar: 'MAILCHIMP_LIST_MASTER', supplierOnly: false },
  rfp: { label: 'RFP+APL General', envVar: 'MAILCHIMP_LIST_RFP', supplierOnly: true },
};

/** @param {import('../src/normalize.js').Contact} contact @returns {string[]} audience keys */
export function routeContact(contact) {
  const keys = ['master'];
  if (contact.type === 'supplier' && contact.tags.length > 0) keys.push('rfp');
  return keys;
}
