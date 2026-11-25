// Portal upload: validate -> one commit -> sync now -> Monday report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeAirtable, withServer } from './helpers.js';
import { createSnapshotSource } from '../src/snapshot.js';
import { fieldMap } from '../config/fieldMap.js';

const HEAD = 'Category,Company,Active clients,First,Last,Title,Email,Phone,Territory,Tier,Last verified,Days ago,Status,Notes';
const csv = (n) => HEAD + '\n' + Array.from({ length: n }, (_, i) => `Spirits,Co${i},Alterra,F${i},L${i},,p${i}@co${i}.com,,,,,,Active,`).join('\n') + '\n';

function harness({ previousCount = 0, now }) {
  const at = fakeAirtable();
  const calls = { writes: [], daily: 0, weekly: 0 };
  const snapshots = {
    latestSha: async () => { if (!previousCount) throw new Error('none'); return 'prev'; },
    at: async () => ({ records: Array.from({ length: previousCount }, () => ({})), scopeTags: null }),
    writeExports: async (files, msg) => { calls.writes.push({ files, msg }); return 'newsha'; },
  };
  const opts = {
    clock: () => now,
    runDaily: async () => { calls.daily++; return { status: 'Success', counts: { applied: 3, queued: 1, forCelia: 0 }, log: [] }; },
    runWeekly: async () => { calls.weekly++; return { subject: 'weekly' }; },
  };
  return { at, calls, extra: { ctx: { snapshots }, opts } };
}

const post = (base, body) => fetch(`${base}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MONDAY_830 = new Date('2026-11-30T15:30:00Z'); // 8:30 am Arizona, Monday
const WEDNESDAY = new Date('2026-12-02T16:00:00Z');

test('Monday upload: saved in one commit, synced, weekly report sent', async () => {
  const h = harness({ now: MONDAY_830 });
  await withServer(h.at, { email: 'Lloyd@IgniteCS.co' }, async (base) => {
    const me = await (await fetch(`${base}/me`)).json();
    assert.equal(me.canUpload, true);
    assert.deepEqual(me.programs, ['Alterra', 'Swingers']);
    const res = await post(base, { files: [{ scope: 'all', text: csv(5) }] });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.saved.contacts, 5);
    assert.equal(body.saved.files, 'all.csv');
    assert.equal(body.run.status, 'Success');
  }, h.extra);
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].files[0].name, 'all.csv');
  assert.equal(h.calls.daily, 1);
  assert.equal(h.calls.weekly, 1);
  assert.ok(h.at.t['Sync Audit'].some((a) => a.fields.Action === 'export-uploaded' && a.fields.Actor === 'lloyd@ignitecs.co'));
});

test('mid-week upload syncs but does not send the report', async () => {
  const h = harness({ now: WEDNESDAY });
  await withServer(h.at, { email: 'lloyd@ignitecs.co' }, async (base) => {
    const res = await post(base, { files: [{ scope: 'Alterra', text: csv(3) }, { scope: 'Swingers', text: csv(2) }] });
    assert.equal(res.status, 200);
  }, h.extra);
  assert.deepEqual(h.calls.writes[0].files.map((f) => f.name), ['alterra.csv', 'swingers.csv']);
  assert.equal(h.calls.weekly, 0);
});

test('bad uploads are refused and nothing is saved or synced', async () => {
  const h = harness({ previousCount: 100, now: MONDAY_830 });
  await withServer(h.at, { email: 'lloyd@ignitecs.co' }, async (base) => {
    const cases = [
      [{ files: [] }, /at least one/],
      [{ files: [{ scope: '', text: csv(5) }] }, /Pick what each file covers/],
      [{ files: [{ scope: 'all', text: csv(5) }, { scope: 'Alterra', text: csv(5) }] }, /on its own/],
      [{ files: [{ scope: 'Alterra', text: csv(5) }, { scope: 'Alterra', text: csv(5) }] }, /same program/],
      [{ files: [{ scope: 'all', text: HEAD.replace('Active clients', 'Clients') + '\nSpirits,A,Alterra,F,L,,a@a.com,,,,,,Active,\n' }] }, /not saved/],
      [{ files: [{ scope: 'all', text: csv(20) }] }, /not saved/], // 20 vs 100 last time = bad export
    ];
    for (const [body, msg] of cases) {
      const res = await post(base, body);
      const data = await res.json();
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(data.error, msg);
    }
  }, h.extra);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.daily, 0);
});

test('only uploaders can upload; approvers cannot by default', async () => {
  const h = harness({ now: MONDAY_830 });
  await withServer(h.at, { email: 'celia@ignitecs.co' }, async (base) => {
    assert.equal((await post(base, { files: [{ scope: 'all', text: csv(5) }] })).status, 403);
  }, h.extra);
  assert.equal(h.calls.writes.length, 0);
});

test('a sync already running blocks a second upload', async () => {
  const h = harness({ now: MONDAY_830 });
  h.at.t['Sync Runs'].push({ id: 'r1', fields: { Status: 'Running', Started: MONDAY_830.toISOString() } });
  await withServer(h.at, { email: 'lloyd@ignitecs.co' }, async (base) => {
    assert.equal((await post(base, { files: [{ scope: 'all', text: csv(5) }] })).status, 409);
  }, h.extra);
});

test('writeExports makes one commit that adds the new files and deletes other CSVs', async () => {
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    const ok = (b) => ({ ok: true, json: async () => b, text: async () => b });
    if (opts.method) sent.push({ method: opts.method, url, body: JSON.parse(opts.body) });
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: 'head1' } });
    if (url.endsWith('/git/commits/head1')) return ok({ tree: { sha: 'tree1' } });
    if (url.includes('/contents/snapshots?ref=head1')) return ok([{ type: 'file', name: 'alterra.csv' }, { type: 'file', name: 'swingers.csv' }, { type: 'file', name: 'README.md' }]);
    if (url.endsWith('/git/blobs')) return ok({ sha: 'blob1' });
    if (url.endsWith('/git/trees')) return ok({ sha: 'tree2' });
    if (url.endsWith('/git/commits')) return ok({ sha: 'commit2' });
    if (url.endsWith('/git/refs/heads/main')) return ok({});
    return { ok: false, status: 404 };
  };
  const src = createSnapshotSource({ token: 't', repo: 'o/r', fieldMap, fetchImpl });
  assert.equal(await src.writeExports([{ name: 'all.csv', text: 'x' }], 'msg'), 'commit2');
  const tree = sent.find((x) => x.url.endsWith('/git/trees')).body.tree;
  assert.deepEqual(tree.map((t) => [t.path, t.sha]), [['snapshots/all.csv', 'blob1'], ['snapshots/alterra.csv', null], ['snapshots/swingers.csv', null]]);
  assert.deepEqual(sent.filter((x) => x.method === 'POST' && x.url.endsWith('/git/blobs')).length, 1);
  assert.equal(sent.at(-1).method, 'PATCH');
});
