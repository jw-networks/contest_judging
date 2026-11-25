/**
 * Email: plain, readable messages (HTML + text) sent through Resend.
 * Nothing is sent unless the Worker has RESEND_API_KEY and EMAIL_FROM.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Build a message.
 *   kicker   small line above the title (event or contest name)
 *   title    big heading
 *   big      optional large text (an entry number)
 *   lines    paragraphs (strings)
 *   button   { label, url }
 *   after    paragraphs after the button
 *   block    optional HTML block (already escaped) and its text form: { html, text }
 */
export function message({ kicker = '', title, big = '', lines = [], button = null, after = [], block = null, footer = 'Sent by Spotlight contest judging.' }) {
  const p = t => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#1b1f24">${esc(t)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-top:4px solid #18b4c9">
<tr><td style="padding:28px 28px 8px">
${kicker ? `<div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0f8a9b;margin-bottom:6px">${esc(kicker)}</div>` : ''}
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;color:#111">${esc(title)}</h1>
${big ? `<div style="font-size:56px;font-weight:900;line-height:1;color:#0f8a9b;margin:0 0 16px">${esc(big)}</div>` : ''}
${lines.map(p).join('')}
${block ? block.html : ''}
${button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#18b4c9;color:#04141a;font-weight:700;text-decoration:none;padding:13px 22px;font-size:16px">${esc(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:#5b6470;word-break:break-all">Or copy this link: ${esc(button.url)}</p>` : ''}
${after.map(p).join('')}
</td></tr>
<tr><td style="padding:14px 28px 24px;font-size:12px;color:#7a838d;border-top:1px solid #e6e9ec">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [kicker, title, big, '', ...lines, block ? block.text : '', button ? `${button.label}: ${button.url}` : '', '', ...after, '', footer]
    .filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  return { html, text };
}

/** Send through Resend. Returns { ok, id?, error? }; never throws. */
export async function sendViaResend(env, fetchImpl, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'Email is not set up on this server' };
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text, ...(replyTo || env.EMAIL_REPLY_TO ? { reply_to: replyTo || env.EMAIL_REPLY_TO } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body.message || body.name || 'error'}` };
    return { ok: true, id: body.id };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}

export const validEmail = v => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()) && String(v).length <= 200;
