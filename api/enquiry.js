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
//   NOTIFY_EMAIL                where the alert lands, e.g. hello@jasperhawkinsmusic.co.nz
//   FROM_EMAIL                  verified sender, e.g. "Jasper Hawkins Music <hello@jasperhawkinsmusic.co.nz>"
//
// Optional — ActiveCampaign follow-up sequence (all three needed, else skipped):
//   AC_API_URL                  e.g. https://jasperhawkins.api-us1.com  (Settings → Developer)
//   AC_API_KEY                  the API key from that same screen (SECRET)
//   AC_TAG_NAME                 tag that starts the follow-up automation, e.g. "Automation for contact form"
//   AC_TAG_EVENT_TYPES          optional CSV of event types to tag; defaults to "wedding" only,
//                               because the follow-up copy is wedding-specific. Use "all" for every enquiry.

import { randomUUID } from 'crypto';

const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Everything an enquirer types lands in the notification email. Escape it —
// the email is untrusted input arriving in Jasper's inbox.
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

// ── ActiveCampaign ────────────────────────────────────────────────────────
// Adds the enquirer as a contact and applies the tag that starts Jasper's
// follow-up sequence. Entirely best-effort: the enquiry is already saved in
// Supabase before this runs, so any failure here is logged and swallowed —
// a wobbly third party must never cost Jasper a lead.

// No third party gets to hold the visitor's browser open indefinitely.
async function withTimeout(run, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function acFetch(url, opts, ms = 3000) {
  return withTimeout(signal => fetch(url, { ...opts, signal }), ms);
}

async function addToActiveCampaign({ name, email, phone, eventType }) {
  const base = (process.env.AC_API_URL || '').replace(/\/+$/, '');
  const key = process.env.AC_API_KEY;
  const tagName = process.env.AC_TAG_NAME;
  if (!base || !key || !tagName) return { skipped: 'not configured' };

  // The follow-up copy asks about wedding music, so by default only wedding
  // enquiries get tagged. AC_TAG_EVENT_TYPES=all opts everyone in.
  const allowed = (process.env.AC_TAG_EVENT_TYPES || 'wedding').toLowerCase();
  if (allowed !== 'all' && !allowed.split(',').map(s => s.trim()).includes(eventType)) {
    return { skipped: `event type ${eventType} not tagged` };
  }

  const headers = { 'Api-Token': key, 'Content-Type': 'application/json' };

  // 1) Create or update the contact. contact/sync is idempotent, so a repeat
  //    enquirer updates rather than duplicating.
  const [firstName, ...rest] = name.split(/\s+/);
  const syncRes = await acFetch(`${base}/api/3/contact/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contact: { email, firstName, lastName: rest.join(' '), phone },
    }),
  });
  if (!syncRes.ok) throw new Error(`contact/sync ${syncRes.status}: ${(await syncRes.text()).slice(0, 200)}`);
  const contactId = (await syncRes.json())?.contact?.id;
  if (!contactId) throw new Error('contact/sync returned no id');

  // 2) Resolve the tag name to its id. Jasper supplies the name he sees in
  //    AC; search is a partial match, so confirm the exact name back.
  const tagRes = await acFetch(`${base}/api/3/tags?search=${encodeURIComponent(tagName)}`, { headers });
  if (!tagRes.ok) throw new Error(`tags lookup ${tagRes.status}`);
  const tags = (await tagRes.json())?.tags ?? [];
  // Exact match only. Falling back to the first search hit would silently fire
  // the wrong automation at a real couple if the tag were ever renamed.
  const tag = tags.find(t => t.tag?.toLowerCase() === tagName.toLowerCase());
  if (!tag?.id) throw new Error(`no tag exactly matching "${tagName}"`);

  // 3) Apply it — this is what trips the automation.
  const applyRes = await acFetch(`${base}/api/3/contactTags`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contactTag: { contact: contactId, tag: tag.id } }),
  });
  if (!applyRes.ok) throw new Error(`contactTags ${applyRes.status}: ${(await applyRes.text()).slice(0, 200)}`);

  return { contactId, tag: tag.tag };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }
  // JSON.parse('[]') and 'null' would otherwise sail through every body.x read.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) body = {};

  const name  = clean(body.firstName, 120).replace(/\s+/g, ' ');
  const email = clean(body.email, 200);
  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Name and email are required.' });
  }
  // Checked here rather than scored as spam: a couple who typos their own
  // address would otherwise get a cheerful "sent" and never hear back.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'That email address looks incomplete — please check it.' });
  }

  // Honeypot: off-screen, so a person never types in it. Password managers and
  // browser autofill DO sometimes fill a field called "company", which would
  // silently bin a real enquiry — so log it rather than vanishing.
  if (clean(body.company)) {
    console.warn('Honeypot tripped:', { name, email });
    return res.status(200).json({ ok: true });
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

  // Suspected spam is FLAGGED, never discarded. A corporate enquirer pasting a
  // few links, or a couple whose name is in Chinese characters, can both trip
  // two signals — and losing one of those costs far more than the nuisance of
  // an obvious spam row. Only a pile-up of signals is dropped outright.
  const score = spamScore(body, name, email, clean(body.message, 4000));
  const suspect = score >= 2;
  if (score >= 4) {
    console.warn('Spam rejected:', { score, ip });
    return res.status(200).json({ ok: true });   // tell bots nothing
  }
  if (suspect) console.warn('Enquiry flagged as possible spam:', { score, ip });

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
  const GIG_MAP = { wedding: 'wedding', corporate: 'corporate', party: 'party', birthday: 'party', function: 'party', other: 'party' };
  // Friendly label for the notification email only.
  const LABELS = { wedding: 'wedding', corporate: 'corporate', party: 'party', birthday: 'birthday', function: 'private function', other: 'event' };
  // Allowlist the key: a raw lookup would return Object for "constructor" and
  // functions for "toString", which then leak into the email subject.
  const rawType = clean(body.eventType, 40).toLowerCase();
  const eventType = Object.hasOwn(GIG_MAP, rawType) ? rawType : 'wedding';
  const gigType = GIG_MAP[eventType];
  const evLabel = LABELS[eventType];

  // The public availability calendar casts this column to `date`. One junk
  // value makes that cast throw for EVERY request, and the website then treats
  // every date as free — including dates already booked. So it is validated
  // hard, and written as '' (the column is NOT NULL) rather than null.
  const rawDate = clean(body.eventDate, 10);
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && !Number.isNaN(Date.parse(rawDate + 'T00:00:00Z'))
    ? rawDate : '';

  // Anyone can enquire about any date, including one already taken — Jasper
  // would rather have the conversation, since couples often move their date.
  // But he wants to know at a glance, so look up what's already on that day.
  // Best-effort: a failure here must never stop the enquiry being saved.
  let clash = '';        // written into the dashboard record
  let clashTag = '';      // prefixes the email subject
  if (eventDate) {
    try {
      const r = await withTimeout(signal => fetch(
        `${SB}/rest/v1/clients?event_date=eq.${encodeURIComponent(eventDate)}&select=name,stage`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal },
      ), 5000);
      if (r.ok) {
        // Runs before the insert, so this counts who was already there.
        const rows = await r.json();
        const booked = rows.filter(c => c.stage !== 'enquiry' && c.stage !== 'cancelled');
        const others = rows.filter(c => c.stage === 'enquiry');
        const parts = [];
        if (booked.length) {
          parts.push(`DATE ALREADY BOOKED — ${booked.map(c => c.name).join(', ')}`);
        }
        if (others.length) {
          // Phrased so it can be repeated to the couple more or less verbatim:
          // "the date's still free, but someone else is looking at it too."
          const who = others.map(c => c.name).join(', ');
          parts.push(others.length === 1
            ? `1 other person is enquiring about this date (${who}) — still unbooked`
            : `${others.length} other people are enquiring about this date (${who}) — still unbooked`);
        }
        if (parts.length) clash = `⚠ ${parts.join('\n⚠ ')}`;
        clashTag = booked.length ? '[DATE TAKEN] ' : others.length ? '[DATE IN DEMAND] ' : '';
      }
    } catch (err) {
      console.error('Date clash lookup failed (enquiry unaffected):', String(err).slice(0, 200));
    }
  }

  const message = clean(body.message, 4000);
  const record = {
    id: randomUUID(),                                // clients.id is NOT NULL with no default
    user_id: OWNER,
    stage: 'enquiry',
    gig_type: gigType,
    event_type: eventType,                           // keeps birthday/function/other, which gig_type flattens
    name,
    email,
    phone: clean(body.phone, 60),
    source: clean(body.source, 60),
    event_date: eventDate,
    venue: location,
    event_location: location,
    enquiry_message: [
      clash,
      suspect ? `[possible spam — score ${score}]` : '',
      message,
    ].filter(Boolean).join('\n'),
    enquiry_date: nzToday(),
  };

  // 1) Save the enquiry (source of truth). If this fails we do NOT bail out —
  // the email below becomes the only copy of the lead, so it's worth far more
  // than a tidy early return. The visitor still gets an honest error at the end.
  let saved = true;
  try {
    const r = await withTimeout(
      signal => fetch(`${SB}/rest/v1/clients`, {
        method: 'POST',
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(record),
        signal,
      }), 8000);
    if (!r.ok) {
      console.error('Supabase insert failed:', r.status, (await r.text()).slice(0, 300));
      saved = false;
    }
  } catch (err) {
    console.error('Supabase insert threw:', String(err).slice(0, 300));
    saved = false;
  }

  // 2) Notify Jasper by email. If the save failed this email IS the lead, so
  // it says so loudly in the subject.
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
      ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#888;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
      const flag = !saved ? '⚠ NOT SAVED — ' : (clashTag || (suspect ? '[possible spam] ' : ''));
      const note = !saved
        ? 'This enquiry could NOT be saved to your dashboard — this email is the only copy. Add it manually.'
        : "It's already in your dashboard Enquiry tab.";
      // Front and centre, so the date situation is obvious before replying.
      // Red when the date is gone, amber when it's merely contested.
      const hard = clash.includes('ALREADY BOOKED');
      const clashBlock = clash
        ? `<p style="font-family:sans-serif;font-size:14px;line-height:1.6;padding:10px 14px;border-radius:8px;white-space:pre-line;background:${hard ? '#fdecea' : '#fff4e5'};border:1px solid ${hard ? '#e0a8a2' : '#f0c48a'};color:${hard ? '#8a1f14' : '#8a4b00'}">${esc(clash)}</p>`
        : '';
      const r = await withTimeout(signal => fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL,
          to: process.env.NOTIFY_EMAIL,
          reply_to: email,
          subject: `${flag}New ${evLabel} enquiry — ${name}${record.event_date ? ' · ' + record.event_date : ''}`,
          html: `<h2 style="font-family:sans-serif">New ${esc(evLabel)} enquiry</h2>${clashBlock}<p style="font-family:sans-serif;color:${saved ? '#555' : '#b00'}">${note}</p><table style="font-family:sans-serif;font-size:14px">${rows}</table>`,
        }),
        signal,
      }), 8000);
      if (!r.ok) {
        console.error('Resend send failed:', r.status, (await r.text()).slice(0, 300));
      }
    } else {
      console.error('Email skipped — missing env vars:', haveEnv);
    }
  } catch (err) {
    console.error('Resend email threw:', String(err).slice(0, 300));
  }

  // The visitor needs to know it didn't land, so they can try again or ring.
  if (!saved) {
    return res.status(502).json({
      ok: false,
      error: "Something went wrong saving your enquiry — please try again, or email hello@jasperhawkinsmusic.co.nz directly.",
    });
  }

  // 3) Start the ActiveCampaign follow-up sequence (best-effort). Capped
  // overall so three slow calls can't stack up behind the visitor.
  try {
    const acResult = await Promise.race([
      addToActiveCampaign({ name, email, phone: record.phone, eventType }),
      new Promise((_, rj) => setTimeout(() => rj(new Error('AC budget exceeded')), 6000)),
    ]);
    if (acResult.skipped) console.log('ActiveCampaign skipped:', acResult.skipped);
    else console.log('ActiveCampaign tagged:', acResult.tag);
  } catch (err) {
    console.error('ActiveCampaign failed (enquiry still saved + emailed):', String(err).slice(0, 300));
  }

  return res.status(200).json({ ok: true });
}
