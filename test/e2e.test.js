// End to end with in-memory fakes: day 1 run -> Ryan approves in the portal API -> day 2 run applies it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDaily } from '../src/jobs/daily.js';
import { runWeekly } from '../src/jobs/weekly.js';
import { fakeAirtable, withServer } from './helpers.js';
import { subscriberHash } from '../src/mailchimp.js';
import { currentRecords, previousRecords, members } from './fixtures.js';

function fakeMailchimp(initial) {
  const lists = { L_MASTER: structuredClone(initial.master), L_RFP: structuredClone(initial.rfp) };
  const calls = [];
  const find = (l, email) => lists[l].find((m) => m.email === email.toLowerCase());
  return {
    lists, calls,
    async listMembers(l) { return structuredClone(lists[l]); },
    async upsertNew(l, email, mf) {
      calls.push(['upsertNew', l, email]);
      if (!find(l, email)) lists[l].push({ email, hash: subscriberHash(email), status: 'subscribed', firstName: mf.FNAME ?? '', lastName: mf.LNAME ?? '', company: mf.COMPANY ?? '', tags: [] });
    },
    async readdArchived(l, email) { calls.push(['readd', l, email]); find(l, email).status = 'subscribed'; },
    async updateFields(l, email, mf) {
      calls.push(['updateFields', l, email]);
      const m = find(l, email);
      if (mf.FNAME) m.firstName = mf.FNAME; if (mf.LNAME) m.lastName = mf.LNAME; if (mf.COMPANY) m.company = mf.COMPANY;
    },
    async setTags(l, email, { add = [], remove = [] }) {
      calls.push(['setTags', l, email, add, remove]);
      const m = find(l, email);
      m.tags = [...new Set([...m.tags.filter((x) => !remove.includes(x)), ...add])].sort();
    },
    async changeEmail(l, from, to) { calls.push(['changeEmail', l, from, to]); find(l, from).email = to; },
    async archive(l, email) { calls.push(['archive', l, email]); find(l, email).status = 'archived'; },
  };
}

function ctxFor({ dryRun, mc, at }) {
  const snaps = {
    s0: { generatedAt: '2026-11-23T12:15:00Z', columns: Object.keys(previousRecords[0]), records: previousRecords },
    s1: { generatedAt: '2026-11-24T12:15:00Z', columns: Object.keys(currentRecords[0]), records: currentRecords },
  };
  let latest = 's0';
  const mail = [];
  return {
    setLatest: (s) => { latest = s; }, mail,
    ctx: {
      dryRun, mc, at,
      listIds: { master: 'L_MASTER', rfp: 'L_RFP' },
      tables: { runs: 'Sync Runs', changes: 'Sync Changes', audit: 'Sync Audit' },
      alertTo: ['lee@ignitecs.co'], reportTo: ['celia@ignitecs.co', 'ryan@ignitecs.co', 'lee@ignitecs.co'], portalUrl: 'https://portal/x',
      snapshots: { latestSha: async () => latest, at: async (sha) => structuredClone(snaps[sha]) },
      mailer: { send: async (m) => { mail.push(m); } },
    },
  };
}

const byType = (at, type) => at.t['Sync Changes'].filter((r) => r.fields.Type === type);

test('dry run writes nothing to Mailchimp but fills the queue', async () => {
  const at = fakeAirtable();
  const mc = fakeMailchimp(members);
  const h = ctxFor({ dryRun: true, mc, at });

  h.setLatest('s0');
  await runDaily(h.ctx, { now: new Date('2026-11-23T13:00:00Z') });
  h.setLatest('s1');
  const r = await runDaily(h.ctx, { now: new Date('2026-11-24T13:00:00Z') });

  assert.equal(mc.calls.length, 0, 'dry run must not call Mailchimp writes');
  assert.ok(['Success', 'Held'].includes(r.status));
  // No ID column in the export: Carley's move shows as her new address added + the old one flagged as removed
  assert.ok(at.t['Sync Changes'].some((r) => r.fields.Type === 'VAULT_INACTIVE' && r.fields.Email === 'carley@campari.com'));
  assert.ok(at.t['Sync Changes'].every((x) => x.fields.Status !== 'Applied'));
});

test('live: auto applies, approval waits for Ryan, next run applies it; Lee cannot approve', async () => {
  const at = fakeAirtable();
  // Big audiences so the circuit breaker stays quiet in this test
  const padded = { master: [...members.master], rfp: [...members.rfp] };
  for (let i = 0; i < 400; i++) {
    padded.master.push({ email: `pad${i}@x.com`, hash: 'h', status: 'subscribed', firstName: '', lastName: '', company: '', tags: [] });
    padded.rfp.push({ email: `pad${i}@x.com`, hash: 'h', status: 'subscribed', firstName: '', lastName: '', company: '', tags: [] });
  }
  const mc = fakeMailchimp(padded);
  const h = ctxFor({ dryRun: false, mc, at });

  h.setLatest('s0');
  await runDaily(h.ctx, { now: new Date('2026-11-23T13:00:00Z') });
  mc.calls.length = 0;
  h.setLatest('s1');
  const day1 = await runDaily(h.ctx, { now: new Date('2026-11-24T13:00:00Z') });
  assert.equal(day1.status, 'Success', day1.log.join('\n'));

  // Auto changes landed
  const nia = mc.lists.L_MASTER.find((m) => m.email === 'new@brand.com');
  assert.ok(nia && nia.tags.includes('Swingers APL 26/27'));
  assert.equal(mc.lists.L_MASTER.find((m) => m.email === 'ann@brand.com').lastName, 'Leigh');
  // Nothing destructive happened on its own
  assert.ok(!mc.calls.some(([op]) => op === 'archive' || op === 'changeEmail'));
  assert.equal(mc.lists.L_MASTER.find((m) => m.email === 'unsub@brand.com').status, 'unsubscribed');

  const pending = byType(at, 'VAULT_INACTIVE').find((r) => r.fields.Email === 'quit@brand.com');
  assert.equal(pending.fields.Status, 'Pending');

  // Lee tries to approve: refused
  await withServer(at, { email: 'lee@ignitecs.co' }, async (base) => {
    const me = await (await fetch(`${base}/me`)).json();
    assert.equal(me.canApprove, false);
    const res = await fetch(`${base}/changes/${pending.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', option: 'archive' }) });
    assert.equal(res.status, 403);
  });

  // Ryan approves "archive"; Ryan rejects the MC_ONLY stray
  await withServer(at, { email: 'Ryan@IgniteCS.co' }, async (base) => {
    const list = await (await fetch(`${base}/changes?view=pending`)).json();
    assert.ok(list.length > 0);
    const ok = await fetch(`${base}/changes/${pending.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve', option: 'archive', note: 'left Brand Co' }) });
    assert.equal(ok.status, 200);
    const stray = byType(at, 'MC_ONLY').find((r) => r.fields.Email === 'stray@else.com' && r.fields.Status === 'Pending');
    await fetch(`${base}/changes/${stray.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) });
    const again = await fetch(`${base}/changes/${pending.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'reject' }) });
    assert.equal(again.status, 409, 'cannot decide twice');
  });
  assert.equal(at.t['Sync Audit'].filter((a) => a.fields.Actor === 'ryan@ignitecs.co').length, 2);

  // Day 2: approved archive applies; rejected stray is left alone and not re-queued
  mc.calls.length = 0;
  const day2 = await runDaily(h.ctx, { now: new Date('2026-11-25T13:00:00Z') });
  assert.equal(day2.status, 'Success', day2.log.join('\n'));
  assert.deepEqual(mc.calls.filter(([op]) => op === 'archive'), [['archive', 'L_MASTER', 'quit@brand.com']]);
  assert.equal(at.t['Sync Changes'].find((r) => r.id === pending.id).fields.Status, 'Applied');
  assert.equal(mc.lists.L_MASTER.find((m) => m.email === 'stray@else.com').status, 'subscribed');
  assert.equal(byType(at, 'MC_ONLY').filter((r) => r.fields.Email === 'stray@else.com').length, 1, 'rejected item not re-created');
  // Auto changes from day 1 don't re-run
  assert.ok(!mc.calls.some(([op, , email]) => op === 'upsertNew' && email === 'new@brand.com'));

  // Monday report (sent once; a second call the same day is skipped)
  await runWeekly(h.ctx, { now: new Date('2026-11-30T15:30:00Z') });
  assert.deepEqual(await runWeekly(h.ctx, { now: new Date('2026-11-30T18:00:00Z') }), { skipped: 'Report already sent today' });
  assert.equal(h.mail.filter((m) => /weekly/.test(m.subject)).length, 1);
  const report = h.mail.at(-1);
  assert.deepEqual(report.to, ['celia@ignitecs.co', 'ryan@ignitecs.co', 'lee@ignitecs.co']);
  assert.match(report.text, /quit@brand\.com\s+archive\s+by ryan@ignitecs\.co/);
  assert.match(report.text, /MC_CLEANED\s+bounce@brand\.com/);
});

test('circuit breaker holds a run with too many auto changes', async () => {
  const at = fakeAirtable();
  const mc = fakeMailchimp(members); // small audiences: fixture changes exceed 10%
  const h = ctxFor({ dryRun: false, mc, at });
  h.setLatest('s1');
  const r = await runDaily(h.ctx, { now: new Date('2026-11-24T13:00:00Z') });
  assert.equal(r.status, 'Held');
  assert.equal(mc.calls.length, 0);
  assert.ok(at.t['Sync Changes'].some((x) => x.fields.Held && x.fields.Status === 'Pending'));
  assert.ok(h.mail.some((m) => /held/.test(m.subject)), 'Lee is alerted');
});

test('stale snapshot skips the run and leaves the queue alone', async () => {
  const at = fakeAirtable();
  const mc = fakeMailchimp(members);
  const h = ctxFor({ dryRun: false, mc, at });
  h.setLatest('s1');
  const r = await runDaily(h.ctx, { now: new Date('2026-12-04T13:00:00Z') }); // 10 days old (weekly export, 8-day limit)
  assert.equal(r.status, 'Skipped');
  assert.equal(at.t['Sync Changes'].length, 0);
  assert.equal(mc.calls.length, 0);
});
