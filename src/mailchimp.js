// Mailchimp Marketing API v3. Reads audiences and performs the handful of writes the sync is allowed to make.
import { createHash } from 'node:crypto';
import { normalizeMember, normEmail } from './normalize.js';

export const subscriberHash = (email) => createHash('md5').update(normEmail(email)).digest('hex');

export function createMailchimp({ apiKey, retries = 2, pageSize = 1000, fetchImpl = fetch }) {
  const dc = apiKey?.split('-')[1];
  if (!dc) throw new Error('MAILCHIMP_API_KEY must end in -<datacenter>, e.g. -us21');
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const auth = 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64');

  async function call(method, path, body) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetchImpl(base + path, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.status === 204 ? null : res.json();
      const text = await res.text();
      lastErr = new Error(`Mailchimp ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      lastErr.status = res.status;
      // Retry only on rate limits and server errors.
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw lastErr;
  }

  return {
    /** Every member of an audience, archived included. Throws on any page failure (a partial list is worse than none). */
    async listMembers(listId, mergeFields) {
      const out = [];
      for (const status of ['subscribed', 'unsubscribed', 'cleaned', 'pending', 'transactional', 'archived']) {
        let offset = 0;
        for (;;) {
          const q = new URLSearchParams({
            count: String(pageSize), offset: String(offset), status,
            fields: 'members.id,members.email_address,members.status,members.merge_fields,members.tags,total_items',
          });
          const page = await call('GET', `/lists/${listId}/members?${q}`);
          out.push(...page.members.map((m) => normalizeMember(m, mergeFields)));
          offset += page.members.length;
          if (page.members.length === 0 || offset >= page.total_items) break;
        }
      }
      return out;
    },

    /** Add a new contact. Never sends `status` for an existing member, so unsubscribed/cleaned stay that way. */
    upsertNew(listId, email, mergeFields) {
      return call('PUT', `/lists/${listId}/members/${subscriberHash(email)}`, {
        email_address: email, status_if_new: 'subscribed', merge_fields: mergeFields,
      });
    },

    /** Approved only: bring an archived contact back. */
    readdArchived(listId, email, mergeFields) {
      return call('PUT', `/lists/${listId}/members/${subscriberHash(email)}`, {
        email_address: email, status: 'subscribed', status_if_new: 'subscribed', merge_fields: mergeFields,
      });
    },

    updateFields(listId, email, mergeFields) {
      return call('PATCH', `/lists/${listId}/members/${subscriberHash(email)}`, { merge_fields: mergeFields });
    },

    setTags(listId, email, { add = [], remove = [] }) {
      const tags = [...add.map((name) => ({ name, status: 'active' })), ...remove.map((name) => ({ name, status: 'inactive' }))];
      if (!tags.length) return null;
      return call('POST', `/lists/${listId}/members/${subscriberHash(email)}/tags`, { tags });
    },

    changeEmail(listId, fromEmail, toEmail, mergeFields) {
      return call('PATCH', `/lists/${listId}/members/${subscriberHash(fromEmail)}`, {
        email_address: toEmail, ...(mergeFields ? { merge_fields: mergeFields } : {}),
      });
    },

    /** Archive (not permanent delete). */
    archive(listId, email) {
      return call('DELETE', `/lists/${listId}/members/${subscriberHash(email)}`);
    },
  };
}
