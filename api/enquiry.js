// Wedding-page enquiry handler.
// Flow: website form POSTs here -> we save the enquiry into the dashboard's
// Supabase `clients` table (stage = 'enquiry') FIRST, then send Jasper a
// notification email via Resend. The DB write is the source of truth: if the
// email ever fails, the enquiry is still safely in the Enquiry tab.
//
// Zero npm dependencies — uses the built-in fetch (Node 18+ on Vercel).
//
// Required Vercel environment variables (Project → Settings → Environment Variables):
//   SUPABASE_URL                e.g. https://papvbbglhglqilwrgtll.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service_role key (SECRET — server-side only, never in the browser)
//   OWNER_USER_ID               Jasper's Supabase auth user id (so enquiries attach to his account)
//   RESEND_API_KEY              from resend.com
//   NOTIFY_EMAIL                where the alert lands, e.g. jmhawkins8@gmail.com
//   FROM_EMAIL                  verified sender, e.g. "Enquiries <enquiries@jasperhawkinsmusic.co.nz>"

import { randomUUID } from 'crypto';

const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// NZ-local YYYY-MM-DD for the enquiry_date stamp.
function nzToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // Honeypot: real people never fill "company" (it's off-screen). Bots do.
  // Pretend success so the bot moves on, but save nothing.
  if (clean(body.company)) return res.status(200).json({ ok: true });

  const name  = clean(body.firstName, 120);
  const email = clean(body.email, 200);
  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Name and email are required.' });
  }

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const OWNER = process.env.OWNER_USER_ID;
  if (!SB || !KEY || !OWNER) {
    console.error('Missing Supabase env config');
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  const location = clean(body.eventLocation, 200);
  const record = {
    id: randomUUID(),                                // clients.id is NOT NULL with no default
    user_id: OWNER,
    stage: 'enquiry',
    gig_type: 'wedding',
    event_type: clean(body.eventType, 40) || 'wedding',
    name,
    email,
    phone: clean(body.phone, 60),
    source: clean(body.source, 60),
    event_date: clean(body.eventDate, 10) || null,   // YYYY-MM-DD from the date picker
    venue: location,
    event_location: location,
    enquiry_message: clean(body.message, 4000),
    enquiry_date: nzToday(),
  };

  // 1) Save the enquiry (source of truth).
  try {
    const r = await fetch(`${SB}/rest/v1/clients`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(record),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Supabase insert failed:', r.status, detail);
      return res.status(502).json({ ok: false, error: 'Could not save enquiry.' });
    }
  } catch (err) {
    console.error('Supabase insert threw:', err);
    return res.status(502).json({ ok: false, error: 'Could not save enquiry.' });
  }

  // 2) Notify Jasper by email (best-effort — enquiry is already saved).
  try {
    if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL && process.env.FROM_EMAIL) {
      const rows = [
        ['Name', name], ['Email', email], ['Phone', record.phone],
        ['Event date', record.event_date || '—'], ['Location', location || '—'],
        ['Heard via', record.source || '—'], ['Message', record.enquiry_message || '—'],
      ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#888;vertical-align:top">${k}</td><td style="padding:4px 0">${String(v).replace(/</g, '&lt;')}</td></tr>`).join('');
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL,
          to: process.env.NOTIFY_EMAIL,
          reply_to: email,
          subject: `New wedding enquiry — ${name}${record.event_date ? ' · ' + record.event_date : ''}`,
          html: `<h2 style="font-family:sans-serif">New wedding enquiry</h2><p style="font-family:sans-serif;color:#555">It's already in your dashboard Enquiry tab.</p><table style="font-family:sans-serif;font-size:14px">${rows}</table>`,
        }),
      });
    }
  } catch (err) {
    console.error('Resend email failed (enquiry still saved):', err);
  }

  return res.status(200).json({ ok: true });
}
