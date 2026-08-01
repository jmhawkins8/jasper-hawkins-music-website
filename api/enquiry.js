// Website enquiry handler (weddings / parties / corporate / home).
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

// ── Abuse guards ──────────────────────────────────────────────────────────
// Deliberately tuned to never block a real couple. A genuine enquirer sends
// one form, once. Everything here only trips on volume or obvious bot markers.

// Per-IP rate limit, in-memory. Serverless instances are short-lived and not
// shared, so this won't stop a determined distributed flood — it stops the
// common case (one script hammering the form) at no cost to real visitors.
const RATE_LIMIT = 5;                 // submissions...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...per IP per 10 minutes
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // Keep the map from growing unbounded across a warm instance's lifetime.
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some(t => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return recent.length > RATE_LIMIT;
}

// Signals that a submission is automated rather than a person. Each one alone
// is weak, so we only reject on two or more — a real enquiry never hits two.
function spamScore(body, name, email, message) {
  let score = 0;
  const text = `${name} ${message}`;

  // Bots paste links; couples describing their wedding almost never do.
  const links = (text.match(/https?:\/\/|www\.|\[url|<a\s/gi) ?? []).length;
  if (links >= 1) score++;
  if (links >= 3) score++;

  // Classic spam vocabulary — deliberately narrow to avoid false positives.
  if (/\b(seo|backlink|crypto|casino|viagra|loan offer|bitcoin|forex|rank higher|web traffic)\b/i.test(text)) score++;

  // Cyrillic/CJK blocks in an English-language NZ enquiry form.
  if (/[Ѐ-ӿ一-鿿]/.test(text)) score++;

  // Submitted implausibly fast — the form stamps when it was opened. A real
  // person takes longer than 3 seconds to fill this in.
  const elapsed = Number(body.formTime);
  if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 3000) score++;

  // Malformed address, or the name field stuffed with a URL.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) score++;
  if (/https?:\/\//i.test(name)) score++;

  return score;
}

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

  // Too many submissions from one address in a short window — almost certainly
  // a script. Say so plainly, so a real person retrying knows to wait or email.
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) {
    console.warn('Rate limit hit:', ip);
    return res.status(429).json({
      ok: false,
      error: "That's a few enquiries in a short space of time — please wait a few minutes, or email hello@jasperhawkinsmusic.co.nz directly.",
    });
  }

  // Two or more bot signals: drop it silently (a 200 keeps bots from probing
  // for what tripped the filter). Logged so genuine misses can be reviewed.
  const score = spamScore(body, name, clean(body.email, 200), clean(body.message, 4000));
  if (score >= 2) {
    console.warn('Spam filtered:', { score, ip, name, email });
    return res.status(200).json({ ok: true });
  }

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const OWNER = process.env.OWNER_USER_ID;
  if (!SB || !KEY || !OWNER) {
    console.error('Missing Supabase env config');
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  const location = clean(body.eventLocation, 200);
  // Derive the dashboard gig type from the event type submitted by the page the
  // enquiry came from (weddings/parties/corporate preset it; home lets them choose).
  const eventType = clean(body.eventType, 40) || 'wedding';
  const GIG_MAP = { wedding: 'wedding', corporate: 'corporate', party: 'party', birthday: 'party', function: 'party', other: 'party' };
  const gigType  = GIG_MAP[eventType] || 'wedding';
  // Friendly label for the notification email only (not stored).
  const LABELS = { wedding: 'wedding', corporate: 'corporate', party: 'party', birthday: 'birthday', function: 'private function', other: 'event' };
  const evLabel = LABELS[eventType] || 'event';
  const record = {
    id: randomUUID(),                                // clients.id is NOT NULL with no default
    user_id: OWNER,
    stage: 'enquiry',
    gig_type: gigType,
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
  const haveEnv = {
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    NOTIFY_EMAIL:   !!process.env.NOTIFY_EMAIL,
    FROM_EMAIL:     !!process.env.FROM_EMAIL,
  };
  try {
    if (haveEnv.RESEND_API_KEY && haveEnv.NOTIFY_EMAIL && haveEnv.FROM_EMAIL) {
      const rows = [
        ['Name', name], ['Email', email], ['Phone', record.phone],
        ['Event type', evLabel], ['Event date', record.event_date || '—'], ['Location', location || '—'],
        ['Heard via', record.source || '—'], ['Message', record.enquiry_message || '—'],
      ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#888;vertical-align:top">${k}</td><td style="padding:4px 0">${String(v).replace(/</g, '&lt;')}</td></tr>`).join('');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL,
          to: process.env.NOTIFY_EMAIL,
          reply_to: email,
          subject: `New ${evLabel} enquiry — ${name}${record.event_date ? ' · ' + record.event_date : ''}`,
          html: `<h2 style="font-family:sans-serif">New ${evLabel} enquiry</h2><p style="font-family:sans-serif;color:#555">It's already in your dashboard Enquiry tab.</p><table style="font-family:sans-serif;font-size:14px">${rows}</table>`,
        }),
      });
      if (!r.ok) {
        const detail = await r.text();
        console.error('Resend send failed:', r.status, detail);
      }
    } else {
      console.error('Email skipped — missing env vars:', haveEnv);
    }
  } catch (err) {
    console.error('Resend email threw (enquiry still saved):', err);
  }

  return res.status(200).json({ ok: true });
}
