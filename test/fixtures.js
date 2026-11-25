// Fake vault + Mailchimp data covering every change type. Column names match config/fieldMap.js.
import { subscriberHash } from '../src/mailchimp.js';

// Rows shaped like the vault's Export CSV. `id` only exists in the tests that exercise EMAIL_CHANGE.
const CATEGORY = { Supplier: 'Spirits', Operator: 'Operator', Client: 'Client' };
export const v = (id, email, first, last, company, type, status, programs) => ({
  id, Category: CATEGORY[type] ?? type, Company: company, 'Active clients': programs, First: first, Last: last,
  Title: '', Email: email, Phone: '', Territory: '', Tier: '', 'Last verified': '', 'Days ago': '', Status: status, Notes: '',
});

export const m = (email, status, first, last, company, tags = []) => ({
  email: email.toLowerCase(), hash: subscriberHash(email), status, firstName: first, lastName: last, company, tags: [...tags].sort(),
});

const SW = 'Swingers APL 26/27'; // Mailchimp tag
const SWV = 'Swingers';          // vault chip

export const previousRecords = [
  v('r1', 'ann@brand.com', 'Ann', 'Lee', 'Brand Co', 'Supplier', 'Active', SWV),
  v('r7', 'carley@campari.com', 'Carley', 'Dunavant', 'Campari', 'Supplier', 'Active', 'Alterra'),
  v('r8', 'gone@old.com', 'Gone', 'Person', 'Old Co', 'Supplier', 'Active', SWV),
];

export const currentRecords = [
  v('r1', 'ann@brand.com', 'Ann', 'Leigh', 'Brand Co', 'Supplier', 'Active', SWV),                 // FIELD_UPDATE (last name)
  v('r2', 'new@brand.com', 'Nia', 'New', 'Brand Co', 'Supplier', 'Active', SWV),                    // NEW_CONTACT x2 (master + rfp)
  v('r3', 'unsub@brand.com', 'Una', 'Sub', 'Brand Co', 'Supplier', 'Active', SWV),                  // MC_UNSUBSCRIBED
  v('r4', 'bounce@brand.com', 'Bo', 'Unce', 'Brand Co', 'Supplier', 'Active', SWV),                 // MC_CLEANED
  v('r5', 'quit@brand.com', 'Quinn', 'It', 'Brand Co', 'Supplier', 'Inactive', SWV),                // VAULT_INACTIVE
  v('r6', 'op@resto.com', 'Otto', 'Perator', 'Resto', 'Operator', 'Active', 'Alterra'),            // OPERATOR_ON_SUPPLIER
  v('r7', 'carley@pernod.com', 'Carley', 'Dunavant', 'Pernod', 'Supplier', 'Active', 'Alterra'),   // EMAIL_CHANGE
  v('r9', 'dup@brand.com', 'Dee', 'One', 'Brand Co', 'Supplier', 'Active', SWV),                    // DUPLICATE_IN_VAULT
  v('r10', 'DUP@brand.com', 'Dee', 'Two', 'Brand Co', 'Supplier', 'Active', SWV),
  v('r11', 'not-an-email', 'Bad', 'Addr', 'Brand Co', 'Supplier', 'Active', SWV),                   // INVALID_EMAIL
  v('r12', '', 'Need Name', '', 'Infinium Spirits', 'Supplier', 'Inactive', SWV),                   // PLACEHOLDER
  v('r13', 'tags@brand.com', 'Tess', 'Tag', 'Brand Co', 'Supplier', 'Active', 'Alterra'),          // TAG_ADD + TAG_REMOVE
  v('r14', 'arch@brand.com', 'Archie', 'Ved', 'Brand Co', 'Supplier', 'Active', SWV),               // READD_ARCHIVED
  v('r15', 'staff@alterramtnco.com', 'Gar', 'Rett', 'Alterra Mountain Co', 'Client', 'Active', 'Alterra'), // EXCLUDED_CATEGORY (+ blocked: on a supplier tag)
  v('r16', 'palisades@brand.com', 'Pal', 'Isades', 'Brand Co', 'Supplier', 'Active', 'Alterra - Palisades; Alterra'), // unmapped chip ignored
];

export const members = {
  master: [
    m('ann@brand.com', 'subscribed', 'Ann', 'Lee', 'Brand Co', [SW]),
    m('unsub@brand.com', 'unsubscribed', 'Una', 'Sub', 'Brand Co', [SW]),
    m('bounce@brand.com', 'cleaned', 'Bo', 'Unce', 'Brand Co', [SW]),
    m('quit@brand.com', 'subscribed', 'Quinn', 'It', 'Brand Co', [SW]),
    m('carley@campari.com', 'subscribed', 'Carley', 'Dunavant', 'Campari', ['Alterra']),
    m('tags@brand.com', 'subscribed', 'Tess', 'Tag', 'Brand Co', [SW, 'Newsletter']),
    m('arch@brand.com', 'archived', 'Archie', 'Ved', 'Brand Co', [SW]),
    m('gone@old.com', 'subscribed', 'Gone', 'Person', 'Old Co', [SW]),                            // VAULT_INACTIVE (removed)
    m('stray@else.com', 'subscribed', 'Stray', 'Contact', 'Else', ['Alterra']),                   // MC_ONLY
    m('legacy@else.com', 'subscribed', 'Leg', 'Acy', 'Else', ['2019 Import']),                    // ignored: no managed tag
    m('op@resto.com', 'subscribed', 'Otto', 'Perator', 'Resto', []),
    m('staff@alterramtnco.com', 'subscribed', 'Gar', 'Rett', 'Alterra Mountain Co', ['Alterra']),
    m('palisades@brand.com', 'subscribed', 'Pal', 'Isades', 'Brand Co', ['Alterra']),
  ],
  rfp: [
    m('ann@brand.com', 'subscribed', 'Ann', 'Lee', 'Brand Co', [SW]),
  ],
};
