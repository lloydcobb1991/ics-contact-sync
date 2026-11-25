// Minimal SendGrid v3 mail send. Without an API key it logs instead of sending (handy for dry runs).

export function createMailer({ apiKey, from, fetchImpl = fetch }) {
  return {
    async send({ to, subject, html, text }) {
      if (!to?.length) return;
      if (!apiKey) {
        console.log(`[mail:not-sent] to=${to.join(',')} subject="${subject}"\n${text ?? ''}`);
        return;
      }
      const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: to.map((email) => ({ email })) }],
          from: { email: from, name: 'ICS Contact Sync' },
          subject,
          content: [
            ...(text ? [{ type: 'text/plain', value: text }] : []),
            { type: 'text/html', value: html },
          ],
        }),
      });
      if (!res.ok) throw new Error(`SendGrid -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}
