import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, STATUS } from '../src/queue.js';
import { makeChange } from '../src/rules.js';
import { validateSnapshot } from '../src/snapshot.js';
import { buildReport } from '../src/report.js';
import { fieldMap } from '../config/fieldMap.js';
import { settings } from '../config/settings.js';

const auto = makeChange('NEW_CONTACT', { audience: 'master', email: 'a@x.com', proposed: { tags: ['T'] } });
const appr = makeChange('VAULT_INACTIVE', { audience: 'master', email: 'b@x.com', proposed: { managedTags: ['T'] } });
const info = makeChange('MC_CLEANED', { audience: 'master', email: 'c@x.com' });
const ph = makeChange('PLACEHOLDER', { email: '' });

test('first sighting: create with the right status; auto is applied, approval is not', () => {
  const r = reconcile([auto, appr, info, ph], []);
  assert.deepEqual(r.create.map((x) => x.status), [STATUS.QUEUED, STATUS.PENDING, STATUS.OPEN]);
  assert.equal(r.apply.length, 1);
  assert.equal(r.apply[0].change.key, auto.key);
});

test('already pending: touched, not duplicated, not applied', () => {
  const r = reconcile([appr], [{ id: 'rec1', key: appr.key, status: STATUS.PENDING, outcome: 'Approval' }]);
  assert.equal(r.create.length, 0);
  assert.equal(r.touch.length, 1);
  assert.equal(r.apply.length, 0);
});

test('approved and still detected: applied with the chosen option', () => {
  const r = reconcile([appr], [{ id: 'rec1', key: appr.key, status: STATUS.APPROVED, outcome: 'Approval', chosenOption: 'untag', decidedBy: 'ryan@ignitecs.co' }]);
  assert.equal(r.apply.length, 1);
  assert.equal(r.apply[0].option, 'untag');
});

test('approved but no longer detected: superseded, not applied (the re-check)', () => {
  const r = reconcile([], [{ id: 'rec1', key: appr.key, status: STATUS.APPROVED, outcome: 'Approval', chosenOption: 'archive' }]);
  assert.equal(r.apply.length, 0);
  assert.equal(r.supersede.length, 1);
});

test('rejected stays rejected', () => {
  const r = reconcile([appr], [{ id: 'rec1', key: appr.key, status: STATUS.REJECTED }]);
  assert.equal(r.create.length + r.apply.length + r.touch.length, 0);
});

test('applied then detected again: flagged once, never auto-reapplied', () => {
  const r = reconcile([auto], [{ id: 'rec1', key: auto.key, status: STATUS.APPLIED }]);
  assert.equal(r.apply.length, 0);
  assert.equal(r.create[0].status, STATUS.OPEN);
  assert.equal(r.create[0].change.outcome, 'Block');
});

test('failed auto change retries until the attempt limit', () => {
  const rec = (attempts) => [{ id: 'r', key: auto.key, status: STATUS.FAILED, outcome: 'Auto', attempts }];
  assert.equal(reconcile([auto], rec(1)).apply.length, 1);
  assert.equal(reconcile([auto], rec(3)).apply.length, 0);
});

// ---- snapshot checks ----
const snap = (n, hoursOld, cols = ['Category', 'Active clients', 'Email', 'Status']) => ({
  generatedAt: new Date(Date.parse('2026-11-24T13:00:00Z') - hoursOld * 36e5).toISOString(),
  columns: cols,
  records: Array.from({ length: n }, (_, i) => ({ Email: `p${i}@x.com`, Status: 'Active' })),
});
const now = new Date('2026-11-24T13:00:00Z');

test('snapshot: fresh and complete passes', () => {
  const r = validateSnapshot(snap(100, 1), snap(100, 25), { fieldMap, ...settings, now });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
});

test('snapshot: renamed required column fails the run', () => {
  const r = validateSnapshot(snap(100, 1, ['Category', 'Active clients', 'E-mail', 'Status']), null, { fieldMap, ...settings, now });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"Email"/);
});

test('snapshot: under half the previous size fails the run', () => {
  assert.equal(validateSnapshot(snap(40, 1), snap(100, 25), { fieldMap, ...settings, now }).ok, false);
});

test('snapshot: older than 8 days is stale (skip, do not fail)', () => {
  assert.equal(validateSnapshot(snap(100, 6 * 24), null, { fieldMap, ...settings, now }).stale, false);
  const r = validateSnapshot(snap(100, 9 * 24), null, { fieldMap, ...settings, now });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
});

// ---- report ----
test('report puts waiting items first and labels dry runs', () => {
  const r = buildReport({
    now,
    dryRun: true,
    portalUrl: 'https://portal/x',
    runs: [{ Status: 'Success', 'Snapshot age (h)': 1 }, { Status: 'Held', 'Snapshot age (h)': 2 }],
    changes: [
      { Status: 'Pending', Type: 'VAULT_INACTIVE', Outcome: 'Approval', Email: 'b@x.com' },
      { Status: 'Open', Type: 'MC_CLEANED', Outcome: 'For Celia', 'For Celia': true, Email: 'c@x.com', Reason: 'Bounced', 'Vault value': '{"firstName":"Bo","company":"Brand"}' },
      { Status: 'Applied', Type: 'NEW_CONTACT', Outcome: 'Auto', Email: 'a@x.com', 'Applied at': '2026-11-23T13:00:00Z' },
    ],
  });
  assert.match(r.subject, /1 waiting, 1 for Celia \(dry run\)/);
  assert.ok(r.text.indexOf('Waiting on you') < r.text.indexOf('For Celia'));
  assert.match(r.text, /c@x\.com\s+Bo \(Brand\)/);
  assert.match(r.text, /Runs succeeded: 2 of 2/);
  assert.match(r.html, /DRY RUN/);
});
