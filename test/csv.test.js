import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';
import { mergeExports, validateSnapshot } from '../src/snapshot.js';
import { fieldMap } from '../config/fieldMap.js';
import { settings } from '../config/settings.js';

const HEAD = 'Category,Company,Active clients,First,Last,Title,Email,Phone,Territory,Tier,Last verified,Days ago,Status,Notes';

test('parses quotes, escaped quotes, commas and newlines inside a field, CRLF and BOM', () => {
  const text = '﻿' + HEAD + '\r\n' +
    'Spirits,Acme,Alterra; Swingers,Al,Ace,"Director, Sales",al@acme.com,,,,2026-11-01,5,Active,"Line one\n\nLine ""two"" | done"\r\n';
  const { columns, records } = parseCsv(text);
  assert.equal(columns[0], 'Category');
  assert.equal(records.length, 1);
  assert.equal(records[0].Title, 'Director, Sales');
  assert.equal(records[0].Notes, 'Line one\n\nLine "two" | done');
  assert.equal(records[0]['Active clients'], 'Alterra; Swingers');
});

test('merging per-program exports unions chips by email and sets scope', () => {
  const a = HEAD + '\nSpirits,Acme,Alterra,Al,Ace,,AL@acme.com,,,,,,Active,\nSpirits,Beta,Alterra,Bo,Bee,,bo@beta.com,,,,,,Active,\n';
  const s = HEAD + '\nSpirits,Acme,Swingers,Al,Ace,,al@acme.com,,,,,,Active,\n';
  const snap = mergeExports([{ name: 'alterra.csv', text: a }, { name: 'Swingers.csv', text: s }], fieldMap);
  assert.equal(snap.records.length, 2);
  assert.equal(snap.records.find((r) => r.Email.toLowerCase() === 'al@acme.com')['Active clients'], 'Alterra; Swingers');
  assert.deepEqual(snap.scopeTags.sort(), ['Alterra', 'Swingers APL 26/27']);
});

test('all.csv means every program', () => {
  const snap = mergeExports([{ name: 'all.csv', text: HEAD + '\nSpirits,Acme,Alterra,Al,Ace,,al@acme.com,,,,,,Active,\n' }], fieldMap);
  assert.equal(snap.scopeTags, null);
});

test('an unrecognised file name is refused rather than guessed', () => {
  assert.throws(() => mergeExports([{ name: 'Contact Vault (3).csv', text: HEAD + '\n' }], fieldMap), /Don't know which program/);
});

test('a renamed column fails validation', () => {
  const snap = mergeExports([{ name: 'alterra.csv', text: HEAD.replace('Active clients', 'Clients') + '\nSpirits,Acme,Alterra,Al,Ace,,al@acme.com,,,,,,Active,\n' }], fieldMap);
  const r = validateSnapshot({ ...snap, generatedAt: new Date().toISOString() }, null, { fieldMap, ...settings });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /Active clients/);
});

test('GitHub source lists the snapshots folder at a commit and merges every CSV in it', async () => {
  const { createSnapshotSource } = await import('../src/snapshot.js');
  const files = { 'alterra.csv': HEAD + '\nSpirits,Acme,Alterra,Al,Ace,,al@acme.com,,,,,,Active,\n' };
  const fetchImpl = async (url, opts) => {
    const ok = (body) => ({ ok: true, json: async () => body, text: async () => body });
    if (url.includes('/commits?path=')) return ok([{ sha: 'abc' }]);
    if (url.endsWith('/commits/abc')) return ok({ commit: { committer: { date: '2026-11-30T15:00:00Z' } } });
    if (url.includes('/contents/snapshots?ref=abc')) return ok([{ type: 'file', name: 'alterra.csv' }, { type: 'file', name: 'README.md' }]);
    if (url.includes('/contents/snapshots/alterra.csv?ref=abc')) {
      assert.match(opts.headers.Accept, /raw/);
      return ok(files['alterra.csv']);
    }
    return { ok: false, status: 404 };
  };
  const src = createSnapshotSource({ token: 't', repo: 'ignitecs/ics-contact-sync-snapshots', fieldMap, fetchImpl });
  const snap = await src.at(await src.latestSha());
  assert.equal(snap.generatedAt, '2026-11-30T15:00:00Z');
  assert.deepEqual(snap.files, ['alterra.csv']);
  assert.equal(snap.records.length, 1);
});
