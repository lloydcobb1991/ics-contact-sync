// Shared test helpers: in-memory Airtable and a throwaway Express server around the portal router.
import express from 'express';
import { createContactSyncRouter } from '../src/server/router.js';

export function fakeAirtable() {
  const t = { 'Sync Runs': [], 'Sync Changes': [], 'Sync Audit': [] };
  let n = 0;
  return {
    t,
    async list(table, params = {}) {
      let rows = t[table];
      if (table === 'Sync Runs' && params.maxRecords) {
        rows = rows.filter((r) => !['Failed', 'Running', 'Skipped'].includes(r.fields.Status))
          .sort((a, b) => b.fields.Started.localeCompare(a.fields.Started)).slice(0, 1);
      }
      return rows.map((r) => structuredClone(r));
    },
    async create(table, list) {
      return list.map((fields) => { const r = { id: `rec${++n}`, createdTime: new Date().toISOString(), fields: { ...fields } }; t[table].push(r); return structuredClone(r); });
    },
    async update(table, ups) {
      return ups.map(({ id, fields }) => { const r = t[table].find((x) => x.id === id); Object.assign(r.fields, fields); return structuredClone(r); });
    },
    async get(table, id) { return structuredClone(t[table].find((x) => x.id === id)); },
  };
}

export async function withServer(at, user, fn, extra = {}) {
  const app = express();
  app.use('/api/contact-sync', createContactSyncRouter({
    ctx: { at, tables: { runs: 'Sync Runs', changes: 'Sync Changes', audit: 'Sync Audit' }, ...extra.ctx },
    approvers: ['celia@ignitecs.co', 'ryan@ignitecs.co'],
    uploaders: ['lloyd@ignitecs.co'],
    getUserEmail: () => user.email,
    ...extra.opts,
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/contact-sync`;
  try { return await fn(base); } finally { server.close(); }
}
