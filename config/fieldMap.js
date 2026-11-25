// Maps the Contact Vault's CSV export (ICS Program Operations Suite → Contact Vault → Export CSV)
// to the sync's contact shape, and contact fields to Mailchimp merge tags.
//
// Export columns (Nov 2026): Category, Company, Active clients, First, Last, Title, Email, Phone,
// Territory, Tier, Last verified, Days ago, Status, Notes

export const fieldMap = {
  columns: {
    vaultId: null,            // the export has no record ID, so email changes show as new + old
    email: 'Email',
    firstName: 'First',
    lastName: 'Last',
    company: 'Company',
    category: 'Category',     // Spirits, Beer, RTD, Non-Alc, Distributor, Client, ...
    status: 'Status',         // Active | Unknown | ...
    programs: 'Active clients', // "Swingers; Alterra"
  },

  // Columns that must exist in every export, or the run fails before diffing.
  required: ['email', 'status', 'programs', 'category'],

  // Vault status values that count as active. "Unknown" (e.g. no company confirmed) is held back.
  activeStatuses: ['active'],

  // Category -> contact type. Anything not listed is a supplier.
  categoryTypes: { Client: 'client', Operator: 'operator' },

  // Categories never synced. "Client" rows are the operator's own staff: the vault notes say
  // never add them to a Mailchimp supplier list.
  excludeCategories: ['Client'],

  // A record matching any of these is a seat placeholder, not a contact.
  placeholderPatterns: [/need name/i, /placeholder/i, /^tbd$/i],

  // Vault program ("Active clients" chip) -> Mailchimp tag. Only programs listed here are synced;
  // any other chip (e.g. "Alterra - Palisades") is left off and listed in the run log.
  // Update the Swingers tag when the season changes.
  programTags: {
    Alterra: 'Alterra',
    Swingers: 'Swingers APL 26/27',
  },

  // Contact field -> Mailchimp merge tag. Check these against each audience's merge fields.
  mergeFields: {
    firstName: 'FNAME',
    lastName: 'LNAME',
    company: 'COMPANY',       // TODO(mailchimp): confirm the merge tag (may be MMERGE3 or similar)
  },
};

// Extra tags the sync may remove even if no program maps to them today (e.g. a retired season tag).
export const extraManagedTags = [];

// Tags that mean "supplier program". An operator carrying one of these is blocked.
export const supplierTags = ['Alterra', 'Swingers APL 26/27'];
