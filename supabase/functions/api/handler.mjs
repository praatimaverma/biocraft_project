// HTTP layer for the Supabase Edge Function. Replaces functions/lib/app.js (Express) one-to-one:
// same paths, same status codes, same JSON bodies. Business logic is untouched (store/bolna/webhook/followup).
// Differences: Web-standard Request/Response instead of Express; CORS done by hand; one NEW route,
// POST /api/internal/run-followups, so Supabase Cron can trigger what Cloud Scheduler used to trigger.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as store from './store.mjs';
import * as sb from './supabase.mjs';
import { requestBolnaCall } from './bolna.mjs';
import { handleBolnaWebhook } from './webhook.mjs';
import { uploadSnapshot } from './tally-sync-core.mjs';
import { runAutomaticFollowups } from './followup.mjs';
import { getIndiaTime } from './helpers.mjs';
import { env } from './env.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const allowedOrigins = () => (env('CORS_ORIGINS') ||
  'https://biocraft-af718.web.app,https://biocraft-af718.firebaseapp.com').split(',').map((s) => s.trim()).filter(Boolean);

function tokenEquals(given, expected) {
  const a = Buffer.from(String(given || '')); const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// "/api/invoices" (function called "api"), "/functions/v1/api/api/invoices" or bare "/invoices" all map to "/invoices".
function routePath(pathname) {
  let p = pathname.replace(/\/functions\/v1/, '');
  for (let i = 0; i < 2 && (p === '/api' || p.startsWith('/api/')); i++) p = p.slice(4);
  return (p || '/').replace(/\/+$/, '') || '/';
}

export function createHandler({ verifyIdToken, bolnaCall = requestBolnaCall, runFollowups = runAutomaticFollowups } = {}) {
  return async function handle(req) {
    const origin = req.headers.get('origin');
    const cors = {};
    if (origin && allowedOrigins().includes(origin)) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }

    const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    const text = (code, body) => new Response(body, { status: code, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

    if (req.method === 'OPTIONS') {
      const h = { ...cors, 'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE', 'Access-Control-Max-Age': '600' };
      const asked = req.headers.get('access-control-request-headers');
      h['Access-Control-Allow-Headers'] = asked || 'authorization, content-type';
      h['Vary'] = (h['Vary'] ? h['Vary'] + ', ' : '') + 'Access-Control-Request-Headers';
      return new Response(null, { status: 204, headers: h });
    }

    const url = new URL(req.url);
    const path = routePath(url.pathname);
    const method = req.method;
    const query = Object.fromEntries(url.searchParams.entries());

    // Body parsing like express.json({ limit: '5mb' }): only for JSON content types; bad JSON -> 400.
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const raw = await req.text();
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: 'Request body too large' });
      if (raw && /json/i.test(req.headers.get('content-type') || '')) {
        try { body = JSON.parse(raw); } catch (_) { return json(400, { error: 'Invalid JSON body' }); }
      }
    }

    // ---- public, secret-free ----
    if (method === 'GET' && path === '/health') return json(200, { ok: true, time: new Date().toISOString() });

    // ---- machine endpoints with their own tokens (registered BEFORE the login check, as before) ----
    if (method === 'POST' && path === '/bolna-webhook') {
      const out = await handleBolnaWebhook({ query, body });
      return text(out.code, out.body);
    }

    if (method === 'POST' && path === '/tally-sync') {
      const expected = env('TALLY_SYNC_TOKEN') || '';
      if (!expected) return json(503, { error: 'TALLY_SYNC_TOKEN is not set, so Tally sync is disabled' });
      const given = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!tokenEquals(given, expected)) return json(401, { error: 'Wrong or missing token' });
      const invoices = body && body.invoices;
      if (!Array.isArray(invoices)) return json(400, { error: 'Body must be { invoices: [...] }' });
      try {
        const sUrl = (env('SUPABASE_URL') || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
        const sKey = (env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
        const summary = await uploadSnapshot({ url: sUrl, key: sKey }, invoices, {
          company: String(body.company || ''), complete: body.complete === true, force: body.force === true
        });
        console.log('Tally sync (push):', JSON.stringify(summary));
        return json(200, { ok: true, ...summary });
      } catch (err) {
        console.error('Tally sync failed:', err);
        return json(500, { error: 'Could not save the Tally data: ' + err.message });
      }
    }

    // NEW (replaces Cloud Scheduler): Supabase Cron -> this route. Needs CRON_SECRET. The business rules
    // (India weekday/time windows, dry-run, DB duplicate lock) all still live in followup.mjs.
    if (method === 'POST' && path === '/internal/run-followups') {
      const expected = env('CRON_SECRET') || '';
      if (!expected) return json(503, { error: 'CRON_SECRET is not set, so the scheduler endpoint is disabled' });
      if (!tokenEquals(req.headers.get('x-cron-secret'), expected)) return json(401, { error: 'Wrong or missing token' });
      try { return json(200, await runFollowups()); }
      catch (err) { console.error('followup run failed:', err); return json(500, { error: 'Follow-up run failed' }); }
    }

    // ---- everything else needs a valid Firebase ID token ----
    const match = String(req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return json(401, { error: 'Sign in required' });
    try {
      await verifyIdToken(match[1]);
    } catch (error) {
      if (error && error.status === 503) { console.error('Auth check unavailable:', error.message); return json(503, { error: 'Sign-in check is temporarily unavailable. Please try again.' }); }
      return json(401, { error: 'Your session is invalid or expired. Please sign in again.' });
    }

    if (method === 'GET' && path === '/invoices') {
      try { return json(200, await store.listInvoices()); }
      catch (err) { console.error('Supabase invoice read failed:', err.message); return json(502, { error: 'Could not load invoices from Supabase: ' + err.message }); }
    }

    let m = path.match(/^\/invoices\/([^/]+)\/details$/);
    if (method === 'GET' && m) {
      const invoiceId = Number(decodeURIComponent(m[1]));
      if (!Number.isInteger(invoiceId) || invoiceId <= 0) return json(400, { error: 'Invalid invoice ID' });
      try {
        const inv = await store.getInvoice(invoiceId);
        if (!inv) return json(404, { error: 'Invoice not found' });
        const { id, customer_name, phone_number, payment_status, payment_state, payment_mode, promised_pay_date,
          payment_date, dispute_reason, last_call_id, last_transcript, last_recording } = inv;
        return json(200, { id, customer_name, phone_number, payment_status, payment_state, payment_mode, promised_pay_date,
          payment_date, dispute_reason, last_call_id, last_transcript, last_recording });
      } catch (err) { return json(502, { error: 'Could not load this invoice from Supabase: ' + err.message }); }
    }

    if (method === 'POST' && path === '/trigger-call') {
      try {
        const invoiceId = Number(body && body.invoiceId);
        const inv = await store.getInvoice(invoiceId);
        if (!inv) return json(404, { error: 'Invoice not found' });
        const currentStatus = String(inv.payment_status || 'pending').trim().toLowerCase();
        if (['payment done', 'paid', 'paid_on_call', 'payment_done'].includes(currentStatus)) {
          return json(409, { error: 'Payment is already marked done; no follow-up call will be placed.' });
        }
        const todayInIndia = getIndiaTime().date;
        if (currentStatus === 'promised_to_pay' && inv.promised_pay_date && inv.promised_pay_date > todayInIndia) {
          return json(409, { error: `Follow-up is scheduled for the promised payment date: ${inv.promised_pay_date}.` });
        }
        const executionId = await bolnaCall(inv, 'manual');
        return json(200, { success: true, callId: executionId });
      } catch (err) {
        console.error('Call error:', err);
        return json(err.status || 500, { error: err.status ? err.message : 'Server error', details: err.details });
      }
    }

    if (method === 'GET' && path === '/call-logs/stats') {
      if (!sb.isConfigured()) return json(200, { configured: false, total: 0, today: 0, byOutcome: {} });
      try {
        const rows = await sb.stats();
        const today = getIndiaTime().date;
        const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
        const byOutcome = {}; let todayCount = 0;
        for (const r of rows) {
          const key = r.outcome || r.call_status || 'unknown';
          byOutcome[key] = (byOutcome[key] || 0) + 1;
          if (r.called_at && dayFmt.format(new Date(r.called_at)) === today) todayCount++;
        }
        return json(200, { configured: true, total: rows.length, today: todayCount, byOutcome });
      } catch (err) { console.error('Call stats error:', err.message); return json(502, { error: 'Could not load call stats from Supabase' }); }
    }

    if (method === 'GET' && path === '/call-logs') {
      if (!sb.isConfigured()) return json(200, { configured: false, rows: [], total: 0 });
      try { return json(200, { configured: true, ...(await sb.listCalls(query)) }); }
      catch (err) { console.error('Call history error:', err.message); return json(502, { error: 'Could not load call history from Supabase' }); }
    }

    m = path.match(/^\/call-logs\/([^/]+)$/);
    if (method === 'GET' && m) {
      const id = decodeURIComponent(m[1]);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'Invalid call log ID' });
      try {
        const row = await sb.getCall(id);
        if (!row) return json(404, { error: 'Call not found' });
        return json(200, row);
      } catch (err) { console.error('Call detail error:', err.message); return json(502, { error: 'Could not load this call from Supabase' }); }
    }

    if (method === 'GET' && path === '/sync-status') {
      try { return json(200, { syncs: await store.recentSyncs(10) }); }
      catch (err) { return json(502, { error: 'Could not read sync log: ' + err.message }); }
    }

    return json(404, { error: 'Not found' });
  };
}
