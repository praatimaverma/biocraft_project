// Express app with every endpoint of the original server.js (same paths, same responses).
// Differences: no Socket.IO (the dashboard polls), no SQLite (Supabase is the source of truth).
'use strict';
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const store = require('./store');
const sb = require('./supabase');
const { requestBolnaCall } = require('./bolna');
const { handleBolnaWebhook } = require('./webhook');
const { uploadSnapshot } = require('./tally-sync-core');
const { getIndiaTime } = require('./helpers');

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://biocraft-af718.web.app,https://biocraft-af718.firebaseapp.com').split(',').map((s) => s.trim());

function createApp({ verifyIdToken, bolnaCall = requestBolnaCall } = {}) {
  const app = express();
  app.use(cors({ origin: ALLOWED_ORIGINS }));
  app.use(express.json({ limit: '5mb' }));

  // Public, secret-free liveness check (also used by the dashboard's "Live" indicator).
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Machine-to-machine endpoints have their own tokens and are registered BEFORE the login check.
  app.post('/api/bolna-webhook', async (req, res) => {
    const out = await handleBolnaWebhook(req);
    res.status(out.code).send(out.body);
  });

  // Optional push endpoint (kept from the original). The Windows agent normally writes to
  // Supabase directly; this accepts the same snapshot from any client that holds TALLY_SYNC_TOKEN.
  app.post('/api/tally-sync', async (req, res) => {
    const expected = process.env.TALLY_SYNC_TOKEN || '';
    if (!expected) return res.status(503).json({ error: 'TALLY_SYNC_TOKEN is not set, so Tally sync is disabled' });
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(given); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong or missing token' });
    const invoices = req.body && req.body.invoices;
    if (!Array.isArray(invoices)) return res.status(400).json({ error: 'Body must be { invoices: [...] }' });
    try {
      const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
      const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
      const summary = await uploadSnapshot({ url, key }, invoices, {
        company: String(req.body.company || ''), complete: req.body.complete === true, force: req.body.force === true
      });
      console.log('Tally sync (push):', JSON.stringify(summary));
      res.json({ ok: true, ...summary });
    } catch (err) {
      console.error('Tally sync failed:', err);
      res.status(500).json({ error: 'Could not save the Tally data: ' + err.message });
    }
  });

  // Everything else under /api needs a valid Firebase ID token (same rule as before; the token is
  // now also checked for revocation, so a disabled employee loses access immediately).
  app.use('/api', async (req, res, next) => {
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Sign in required' });
    try {
      req.firebaseUser = await verifyIdToken(match[1]);
      return next();
    } catch (error) {
      return res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });
    }
  });

  // 1. List invoices (read straight from Supabase)
  app.get('/api/invoices', async (req, res) => {
    try {
      return res.json(await store.listInvoices());
    } catch (err) {
      console.error('Supabase invoice read failed:', err.message);
      return res.status(502).json({ error: 'Could not load invoices from Supabase: ' + err.message });
    }
  });

  app.get('/api/invoices/:id/details', async (req, res) => {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) return res.status(400).json({ error: 'Invalid invoice ID' });
    try {
      const inv = await store.getInvoice(invoiceId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const { id, customer_name, phone_number, payment_status, payment_state, payment_mode, promised_pay_date,
        payment_date, dispute_reason, last_call_id, last_transcript, last_recording } = inv;
      res.json({ id, customer_name, phone_number, payment_status, payment_state, payment_mode, promised_pay_date,
        payment_date, dispute_reason, last_call_id, last_transcript, last_recording });
    } catch (err) {
      res.status(502).json({ error: 'Could not load this invoice from Supabase: ' + err.message });
    }
  });

  // 2. Trigger a manual Bolna call (this endpoint makes a real call)
  app.post('/api/trigger-call', async (req, res) => {
    try {
      const invoiceId = Number(req.body && req.body.invoiceId);
      const inv = await store.getInvoice(invoiceId);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });

      const currentStatus = String(inv.payment_status || 'pending').trim().toLowerCase();
      if (['payment done', 'paid', 'paid_on_call', 'payment_done'].includes(currentStatus)) {
        return res.status(409).json({ error: 'Payment is already marked done; no follow-up call will be placed.' });
      }
      const todayInIndia = getIndiaTime().date;
      if (currentStatus === 'promised_to_pay' && inv.promised_pay_date && inv.promised_pay_date > todayInIndia) {
        return res.status(409).json({ error: `Follow-up is scheduled for the promised payment date: ${inv.promised_pay_date}.` });
      }
      const executionId = await bolnaCall(inv, 'manual');
      res.json({ success: true, callId: executionId });
    } catch (err) {
      console.error('Call error:', err);
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error', details: err.details });
    }
  });

  // 3b. Call history (Supabase)
  app.get('/api/call-logs/stats', async (req, res) => {
    if (!sb.isConfigured()) return res.json({ configured: false, total: 0, today: 0, byOutcome: {} });
    try {
      const rows = await sb.stats();
      const today = getIndiaTime().date;
      const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
      const byOutcome = {};
      let todayCount = 0;
      for (const r of rows) {
        const key = r.outcome || r.call_status || 'unknown';
        byOutcome[key] = (byOutcome[key] || 0) + 1;
        if (r.called_at && dayFmt.format(new Date(r.called_at)) === today) todayCount++;
      }
      res.json({ configured: true, total: rows.length, today: todayCount, byOutcome });
    } catch (err) {
      console.error('Call stats error:', err.message);
      res.status(502).json({ error: 'Could not load call stats from Supabase' });
    }
  });

  app.get('/api/call-logs', async (req, res) => {
    if (!sb.isConfigured()) return res.json({ configured: false, rows: [], total: 0 });
    try {
      res.json({ configured: true, ...(await sb.listCalls(req.query)) });
    } catch (err) {
      console.error('Call history error:', err.message);
      res.status(502).json({ error: 'Could not load call history from Supabase' });
    }
  });

  app.get('/api/call-logs/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Invalid call log ID' });
    try {
      const row = await sb.getCall(id);
      if (!row) return res.status(404).json({ error: 'Call not found' });
      res.json(row);
    } catch (err) {
      console.error('Call detail error:', err.message);
      res.status(502).json({ error: 'Could not load this call from Supabase' });
    }
  });

  // NEW: when did Tally last sync? (read-only; no UI uses it yet)
  app.get('/api/sync-status', async (req, res) => {
    try { res.json({ syncs: await store.recentSyncs(10) }); }
    catch (err) { res.status(502).json({ error: 'Could not read sync log: ' + err.message }); }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

module.exports = { createApp };
