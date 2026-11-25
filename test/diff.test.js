import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '../src/diff.js';
import { applyCircuitBreaker, OUTCOME, RULES } from '../src/rules.js';
import { plan } from '../src/apply.js';
import { fieldMap as realFieldMap, extraManagedTags, supplierTags } from '../config/fieldMap.js';

// The real export has no ID column; most tests add one so EMAIL_CHANGE can be exercised.
const fieldMap = { ...realFieldMap, columns: { ...realFieldMap.columns, vaultId: 'id' } };
import { audiences, routeContact } from '../config/routing.js';
import { currentRecords, previousRecords, members } from './fixtures.js';

const run = (over = {}) => diff({
  currentRecords, previousRecords, members, fieldMap, routeContact, audiences, extraManagedTags, supplierTags, ...over,
});
const find = (changes, type, email, audience) =>
  changes.filter((c) => c.type === type && (!email || c.email === email) && (!audience || c.audience === audience));

test('every rule type has a fixture that triggers it', () => {
  const types = new Set(run().map((c) => c.type));
  for (const t of Object.keys(RULES)) assert.ok(types.has(t), `no fixture produced ${t}`);
});

test('field update only lists what changed', () => {
  const [c] = find(run(), 'FIELD_UPDATE', 'ann@brand.com', 'master');
  assert.deepEqual(c.proposed.fields, { lastName: 'Leigh' });
  assert.equal(c.outcome, OUTCOME.AUTO);
});

test('new supplier goes to master and rfp', () => {
  const got = find(run(), 'NEW_CONTACT', 'new@brand.com').map((c) => c.audience).sort();
  assert.deepEqual(got, ['master', 'rfp']);
});

test('unsubscribed and cleaned are reported, never written, and not auto-added elsewhere', () => {
  const ch = run();
  assert.equal(find(ch, 'MC_UNSUBSCRIBED', 'unsub@brand.com', 'master')[0].outcome, OUTCOME.CELIA);
  assert.equal(find(ch, 'MC_CLEANED', 'bounce@brand.com', 'master')[0].outcome, OUTCOME.CELIA);
  assert.equal(find(ch, 'NEW_CONTACT', 'unsub@brand.com').length, 0);
  assert.equal(find(ch, 'SUPPRESSED_ELSEWHERE', 'unsub@brand.com', 'rfp')[0].outcome, OUTCOME.APPROVAL);
  assert.equal(find(ch, 'SUPPRESSED_ELSEWHERE', 'bounce@brand.com', 'rfp').length, 1);
  for (const c of [...find(ch, 'MC_UNSUBSCRIBED'), ...find(ch, 'MC_CLEANED')]) {
    assert.deepEqual(plan(c, null, { master: 'L1', rfp: 'L2' }, fieldMap.mergeFields), []);
  }
});

test('email change is detected by vault id and needs approval', () => {
  const ch = run();
  const [c] = find(ch, 'EMAIL_CHANGE', 'carley@pernod.com', 'master');
  assert.equal(c.outcome, OUTCOME.APPROVAL);
  assert.deepEqual([c.proposed.from, c.proposed.to], ['carley@campari.com', 'carley@pernod.com']);
  // The old address must not also show up as MC_ONLY or removed
  assert.equal(ch.filter((x) => x.email === 'carley@campari.com').length, 0);
  // rfp never had the old address, so the new one is simply added there
  assert.equal(find(ch, 'NEW_CONTACT', 'carley@pernod.com', 'rfp').length, 1);
});

test('without a previous snapshot, the email change shows as new + MC_ONLY', () => {
  const ch = run({ previousRecords: null });
  assert.equal(find(ch, 'EMAIL_CHANGE').length, 0);
  assert.equal(find(ch, 'MC_ONLY', 'carley@campari.com', 'master').length, 1);
});

test('inactive and removed contacts need approval with untag/archive/leave', () => {
  const ch = run();
  const inactive = find(ch, 'VAULT_INACTIVE', 'quit@brand.com', 'master')[0];
  const removed = find(ch, 'VAULT_INACTIVE', 'gone@old.com', 'master')[0];
  for (const c of [inactive, removed]) {
    assert.equal(c.outcome, OUTCOME.APPROVAL);
    assert.deepEqual(c.options, ['untag', 'archive', 'leave']);
  }
  assert.match(removed.reason, /Removed from the vault/);
});

test('MC_ONLY only for members carrying a managed tag', () => {
  const ch = run();
  assert.equal(find(ch, 'MC_ONLY', 'stray@else.com').length, 1);
  assert.equal(ch.filter((c) => c.email === 'legacy@else.com').length, 0);
});

test('tags: add is auto, remove needs approval, unmanaged tags untouched', () => {
  const ch = run();
  assert.deepEqual(find(ch, 'TAG_ADD', 'tags@brand.com', 'master')[0].proposed.tags, ['Alterra']);
  const rm = find(ch, 'TAG_REMOVE', 'tags@brand.com', 'master')[0];
  assert.deepEqual(rm.proposed.tags, ['Swingers APL 26/27']);
  assert.equal(rm.outcome, OUTCOME.APPROVAL);
});

test('operator with a supplier tag is blocked', () => {
  const [c] = find(run(), 'OPERATOR_ON_SUPPLIER', 'op@resto.com');
  assert.equal(c.outcome, OUTCOME.BLOCK);
  assert.equal(find(run(), 'NEW_CONTACT', 'op@resto.com').length, 0);
});

test('vault hygiene: duplicates blocked (case-insensitive), bad email and placeholders skipped', () => {
  const ch = run();
  assert.equal(find(ch, 'DUPLICATE_IN_VAULT', 'dup@brand.com').length, 1);
  assert.equal(ch.filter((c) => c.email === 'dup@brand.com' && c.type !== 'DUPLICATE_IN_VAULT').length, 0);
  assert.equal(find(ch, 'INVALID_EMAIL')[0].outcome, OUTCOME.SKIP);
  assert.equal(find(ch, 'PLACEHOLDER').length, 1);
});

test('archived contact is not silently re-added', () => {
  const [c] = find(run(), 'READD_ARCHIVED', 'arch@brand.com', 'master');
  assert.equal(c.outcome, OUTCOME.APPROVAL);
  assert.deepEqual(plan(c, 'leave', { master: 'L1' }, fieldMap.mergeFields), []);
});

test('same inputs => same change keys (no duplicate queue items)', () => {
  const a = run().map((c) => c.key).sort();
  const b = run().map((c) => c.key).sort();
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, 'keys must be unique within a run');
});

test('circuit breaker turns auto into approval when too much changes', () => {
  const ch = run();
  const small = { master: 5, rfp: 1 };
  const r = applyCircuitBreaker(ch, small, { maxAutoChanges: 50, maxAudienceShare: 0.1 });
  assert.equal(r.tripped, true);
  assert.equal(r.changes.filter((c) => c.outcome === OUTCOME.AUTO).length, 0);
  assert.ok(r.changes.filter((c) => c.held).every((c) => c.options.includes('apply')));

  const big = { master: 10_000, rfp: 10_000 };
  assert.equal(applyCircuitBreaker(ch, big, { maxAutoChanges: 50, maxAudienceShare: 0.1 }).tripped, false);
});

test('plan never sends status for existing members, only status_if_new', () => {
  const [c] = find(run(), 'NEW_CONTACT', 'new@brand.com', 'master');
  const steps = plan(c, null, { master: 'L1', rfp: 'L2' }, fieldMap.mergeFields);
  assert.equal(steps[0].op, 'upsertNew');
  assert.deepEqual(steps[0].args[2], { FNAME: 'Nia', LNAME: 'New', COMPANY: 'Brand Co' });
  assert.deepEqual(steps[1].args[2], { add: ['Swingers APL 26/27'] });
});

test('without an ID column, an email change is new contact + removed old address', () => {
  const ch = run({ fieldMap: realFieldMap });
  assert.equal(find(ch, 'EMAIL_CHANGE').length, 0);
  assert.equal(find(ch, 'NEW_CONTACT', 'carley@pernod.com', 'master').length, 1);
  assert.equal(find(ch, 'VAULT_INACTIVE', 'carley@campari.com', 'master').length, 1);
});

test('Client category is never synced, and is blocked if found on a supplier tag', () => {
  const ch = run();
  assert.equal(find(ch, 'EXCLUDED_CATEGORY', 'staff@alterramtnco.com').length, 1);
  assert.equal(find(ch, 'OPERATOR_ON_SUPPLIER', 'staff@alterramtnco.com', 'master').length, 1);
  assert.equal(ch.filter((c) => c.email === 'staff@alterramtnco.com' && ['NEW_CONTACT', 'MC_ONLY', 'TAG_ADD'].includes(c.type)).length, 0);
});

test('unmapped program chips are ignored, mapped ones still sync', () => {
  const ch = run();
  assert.equal(ch.filter((c) => c.email === 'palisades@brand.com' && c.type.startsWith('TAG')).length, 0);
  assert.deepEqual(find(ch, 'NEW_CONTACT', 'palisades@brand.com', 'rfp')[0].proposed.tags, ['Alterra']);
});

test('a one-program export only manages that program: other programs are never flagged missing', () => {
  // Alterra-only export: tags@brand (vault: Alterra) has a Swingers tag in Mailchimp -> must NOT be removed
  const ch = run({ scopeTags: ['Alterra'] });
  assert.equal(find(ch, 'TAG_REMOVE', 'tags@brand.com').length, 0);
  // gone@old.com only carries the Swingers tag -> out of scope, not flagged
  assert.equal(ch.filter((c) => c.email === 'gone@old.com').length, 0);
  // stray@else.com carries Alterra and is not in the export -> still flagged
  assert.equal(find(ch, 'MC_ONLY', 'stray@else.com').length, 1);
});
