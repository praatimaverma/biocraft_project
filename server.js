
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const crypto = require('crypto');
const db = require('./db');
const { applyTallySnapshot } = require('./tallyImport');
const sb = require('./supabase');
const { recordCall, flushOutbox, backfillExistingCalls } = require('./calllog');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- Values sent to the Bolna agent as {{variables}} in its prompt ----
const ORDINAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// 2026-10-09 -> "9th October 2026" (spoken naturally by the agent, never as ISO)
function speakDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(iso || '');
  return `${ordinal(Number(m[3]))} ${ORDINAL_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function buildUserData(inv) {
  return {
    record_id: String(inv.id),
    customer_name: inv.customer_name,
    invoice_id: inv.invoice_number || `INV-${1000 + inv.id}`,
    amount_due: String(inv.amount_due),
    due_date: speakDate(inv.due_date),
    today_date: speakDate(getIndiaTime().date)
  };
}

// The Supabase row created the moment a call is requested
function callRequestedRow(inv, executionId, source) {
  return {
    call_id: String(executionId),
    invoice_id: inv.id,
    customer_name: inv.customer_name,
    phone_number: inv.phone_number,
    amount_due: inv.amount_due,
    due_date: inv.due_date,
    trigger_source: source,
    call_status: 'calling',
    called_at: new Date().toISOString()
  };
}

// Send a call request to Bolna and save its execution ID.
// Throws an Error with .status (HTTP code to return) and .details on failure.
async function requestBolnaCall(inv, source = 'auto') {
  if (!process.env.BOLNA_API_KEY || !process.env.BOLNA_AGENT_ID) {
    const err = new Error('Bolna API key or Agent ID is missing from .env');
    err.status = 500;
    throw err;
  }

  const body = {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: inv.phone_number,
    user_data: buildUserData(inv)
  };

  if (process.env.BOLNA_FROM_NUMBER) {
    body.from_phone_number = process.env.BOLNA_FROM_NUMBER;
  }

  const response = await fetch('https://api.bolna.ai/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('Bolna error:', data);
    const err = new Error('Bolna rejected the call');
    err.status = 502;
    err.details = data;
    throw err;
  }

  const executionId = data.execution_id || data.id;

  if (!executionId) {
    console.error('Bolna response missing execution ID:', data);
    const err = new Error('Bolna response did not contain an execution ID');
    err.status = 502;
    throw err;
  }

  db.prepare(`
    UPDATE customers_invoices
    SET last_call_id = ?, payment_status = 'calling', last_call_at = ?
    WHERE id = ?
  `).run(String(executionId), new Date().toISOString(), inv.id);

  console.log('Call ID saved:', String(executionId), 'Invoice:', inv.id);

  await recordCall(callRequestedRow(inv, executionId, source));

  io.emit('dashboard-update');

  return String(executionId);
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// India date helper
function getIndiaTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }
  }

  return {
    date: `${result.year}-${result.month}-${result.day}`,
    hour: Number(result.hour),
    minute: Number(result.minute),
    weekday: result.weekday
  };
}

// Tally sync: the agent on the Tally server pushes outstanding receivables here.
// Protected by TALLY_SYNC_TOKEN (sent as "Authorization: Bearer <token>").
app.post('/api/tally-sync', (req, res) => {
  const expected = process.env.TALLY_SYNC_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'TALLY_SYNC_TOKEN is not set in the app .env, so Tally sync is disabled' });
  }

  const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Wrong or missing token' });
  }

  const invoices = req.body && req.body.invoices;
  if (!Array.isArray(invoices)) {
    return res.status(400).json({ error: 'Body must be { invoices: [...] }' });
  }

  try {
    const summary = applyTallySnapshot(invoices, {
      complete: req.body.complete === true,
      force: req.body.force === true
    });
    console.log('Tally sync (push):', JSON.stringify(summary));
    io.emit('dashboard-update');
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('Tally sync failed:', err);
    res.status(500).json({ error: 'Could not save the Tally data: ' + err.message });
  }
});


// 1. List invoices
app.get('/api/invoices', async (req, res) => {
  if (!sb.isConfigured()) {
    return res.status(503).json({
      error: 'Supabase is not configured. Cannot load invoices.'
    });
  }

  try {
    // Supabase is the source of truth for invoice records.
    const remote = await sb.listInvoices();

    const find = db.prepare(`
      SELECT id
      FROM customers_invoices
      WHERE invoice_number = ?
      AND LOWER(TRIM(customer_name)) = LOWER(TRIM(?))
      LIMIT 1
    `);

    // Update only Tally fields.
    // Payment and call information must remain untouched.
    const update = db.prepare(`
      UPDATE customers_invoices
      SET
        customer_name = ?,
        phone_number = ?,
        amount_due = ?,
        due_date = ?,
        source = ?,
        tally_closed = ?,
        tally_synced_at = ?
      WHERE id = ?
    `);

    const insert = db.prepare(`
      INSERT INTO customers_invoices (
        customer_name,
        phone_number,
        amount_due,
        due_date,
        invoice_number,
        source,
        tally_closed,
        tally_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const mirror = db.transaction((rows) => {
      const visibleInvoices = [];

      for (const row of rows) {
        if (!row.invoice_number) {
          console.warn(
            'Invoice skipped: invoice_number missing',
            row.invoice_key || row.id
          );
          continue;
        }

        const invoiceNumber = String(row.invoice_number);
        const customerName = String(row.customer_name || '');

        const existing = find.get(invoiceNumber, customerName);

        const values = [
          customerName,
          row.phone_number || 'N/A',
          Number(row.amount_due || 0),
          row.due_date || '',
          row.source || 'tally',
          row.tally_closed ? 1 : 0,
          row.tally_synced_at || null
        ];

        let localId;

        if (existing) {
          update.run(...values, existing.id);
          localId = existing.id;
        } else {
          const result = insert.run(
            customerName,
            row.phone_number || 'N/A',
            Number(row.amount_due || 0),
            row.due_date || '',
            invoiceNumber,
            row.source || 'tally',
            row.tally_closed ? 1 : 0,
            row.tally_synced_at || null
          );

          localId = Number(result.lastInsertRowid);
        }

        // Return only records from the current Supabase response.
        visibleInvoices.push({
          id: localId,
          ...row,
          customer_name: customerName,
          phone_number: row.phone_number || 'N/A',
          amount_due: Number(row.amount_due || 0),
          due_date: row.due_date || ''
        });
      }

      return visibleInvoices;
    });

    const invoices = mirror(remote);

    console.log(
      `Dashboard invoices loaded from Supabase: ${invoices.length}`
    );

    return res.json(invoices);

  } catch (err) {
    console.error('Supabase invoice read failed:', err);

    return res.status(502).json({
      error: 'Could not load invoices from Supabase: ' + err.message
    });
  }
});


// Get details for one invoice
app.get('/api/invoices/:id/details', (req, res) => {
  const invoiceId = Number(req.params.id);

  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({
      error: 'Invalid invoice ID'
    });
  }

  const invoice = db.prepare(`
    SELECT
      id,
      customer_name,
      phone_number,
      payment_status,
      payment_state,
      payment_mode,
      promised_pay_date,
      payment_date,
      dispute_reason,
      last_call_id,
      last_transcript,
      last_recording
    FROM customers_invoices
    WHERE id = ?
  `).get(invoiceId);

  if (!invoice) {
    return res.status(404).json({
      error: 'Invoice not found'
    });
  }

  res.json(invoice);
});

// 2. Trigger a manual Bolna call
// This endpoint makes a real call.
app.post('/api/trigger-call', async (req, res) => {
  try {
    const invoiceId = Number(req.body?.invoiceId);

    const inv = db.prepare(
      'SELECT * FROM customers_invoices WHERE id = ?'
    ).get(invoiceId);

    if (!inv) {
      return res.status(404).json({
        error: 'Invoice not found'
      });
    }

    const currentStatus = String(
      inv.payment_status || 'pending'
    ).trim().toLowerCase();

    // Never call again after payment is completed.
    if ([
      'payment done',
      'paid',
      'paid_on_call',
      'payment_done'
    ].includes(currentStatus)) {
      return res.status(409).json({
        error: 'Payment is already marked done; no follow-up call will be placed.'
      });
    }

    // Do not call before a promised future payment date.
    const todayInIndia = getIndiaTime().date;

    if (
      currentStatus === 'promised_to_pay' &&
      inv.promised_pay_date &&
      inv.promised_pay_date > todayInIndia
    ) {
      return res.status(409).json({
        error: `Follow-up is scheduled for the promised payment date: ${inv.promised_pay_date}.`
      });
    }

    const executionId = await requestBolnaCall(inv, 'manual');

    res.json({
      success: true,
      callId: executionId
    });
  } catch (err) {
    console.error('Call error:', err);

    res.status(err.status || 500).json({
      error: err.status ? err.message : 'Server error',
      details: err.details
    });
  }
});

// Find a field inside nested objects
function findKey(obj, wantedKey) {
  if (!obj || typeof obj !== 'object') return null;

  if (
    Object.prototype.hasOwnProperty.call(obj, wantedKey)
  ) {
    return obj[wantedKey];
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findKey(value, wantedKey);

      if (found !== null && found !== undefined) {
        return found;
      }
    }
  }

  return null;
}

// Read the actual extracted value.
// Bolna wraps each field like:
//   { objective: null, confidence: 0.9, subjective: "promised_to_pay", reasoning_subjective: "..." }
// Only the answer keys are read, in this order. Never loop over the other keys:
// that is how the confidence score (0.9) used to be mistaken for the answer.
const ANSWER_KEYS = ['subjective', 'objective', 'value', 'answer'];

function getObjective(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (!value || typeof value !== 'object') return '';

  for (const key of ANSWER_KEYS) {
    if (value[key] != null) {
      const result = getObjective(value[key]);
      if (result) return result;
    }
  }

  return '';
}

// First non-empty value among several possible field names
// (the Bolna extraction names have changed over time).
function getField(extracted, ...names) {
  for (const name of names) {
    const result = getObjective(findKey(extracted, name));
    if (result) return result;
  }
  return '';
}

// extracted_data can arrive as an object or as a JSON string
function parseExtracted(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch (e) { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

// Convert ISO or written English dates to YYYY-MM-DD.
// Accepts: 2026-10-14, 14 October 2026 (also 14th October, 2026), October 14, 2026
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');

function toIsoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDate(value) {
  if (!value) return null;

  const text = String(value);

  let match = text.match(
    /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/
  );

  if (match) {
    return toIsoDay(match[1], match[2], match[3]);
  }

  // 14 October 2026
  match = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})[,]?\\s+(20\\d{2})\\b`, 'i')
  );

  if (match) {
    return toIsoDay(match[3], MONTHS[match[2].toLowerCase()], match[1]);
  }

  // October 14, 2026
  match = text.match(
    new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(20\\d{2})\\b`, 'i')
  );

  if (match) {
    return toIsoDay(match[3], MONTHS[match[1].toLowerCase()], match[2]);
  }

  // 24th October / October 24 (no year): use the current year in India,
  // or next year if that date is more than 60 days in the past.
  match = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b`, 'i')
  ) || null;
  let day, month;
  if (match) {
    day = match[1]; month = MONTHS[match[2].toLowerCase()];
  } else {
    const alt = text.match(
      new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')
    );
    if (alt) { month = MONTHS[alt[1].toLowerCase()]; day = alt[2]; }
  }

  if (day && month) {
    const today = getIndiaTime().date;
    let year = Number(today.slice(0, 4));
    const candidate = new Date(`${toIsoDay(year, month, day)}T00:00:00Z`);
    const diffDays = (candidate - new Date(`${today}T00:00:00Z`)) / 86400000;
    if (diffDays < -60) year += 1;
    return toIsoDay(year, month, day);
  }

  return null;
}

// Only use the dedicated promised-date extraction.
// Never guess a promised date from a transcript, a reasoning field or the
// invoice due date: a wrong guess would trigger follow-up calls on the wrong day.
function findPromisedDate(data) {
  if (!data || typeof data !== 'object') return null;

  return normalizeDate(
    getField(data, 'promised_pay_date', 'promised_payment_date')
  );
}

// ---- Payment state & payment mode (decided from the conversation) ----
const PAID_OUTCOMES = ['paid', 'paid_on_call', 'payment_done'];
const PENDING_OUTCOMES = ['promised_to_pay', 'callback_requested', 'disputed', 'refused'];

// pending | done | unclear. Returns null when the call gave no new information
// (unanswered / failed), so the previous state is kept.
// Change the rules here if you want different behaviour.
function derivePaymentState(callStatus, rawOutcome) {
  if (callStatus !== 'completed') return null;
  if (PAID_OUTCOMES.includes(rawOutcome)) return 'done';
  if (PENDING_OUTCOMES.includes(rawOutcome)) return 'pending';
  if (rawOutcome === 'no_answer') return null;
  return 'unclear';   // wrong number, or the answer could not be understood
}

const MODE_PATTERNS = [
  ['UPI', /\b(upi|gpay|g pay|google ?pay|phone ?pe|paytm|bhim)\b/i],
  ['Bank transfer', /\b(neft|rtgs|imps|net ?banking|bank transfer|online transfer|wire transfer)\b/i],
  ['Cheque', /\b(cheque|check)\b/i],
  ['Cash', /\bcash\b/i],
  ['Card', /\b(card|credit card|debit card)\b/i]
];

function normalizePaymentMode(value) {
  const text = String(value || '').trim().replace(/[_-]+/g, ' ');
  if (!text || /^(none|null|n\/a|na|unknown|not (stated|mentioned|specified|provided)|no answer)$/i.test(text)) {
    return null;
  }
  for (const [label, pattern] of MODE_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  if (/\bbank\b/i.test(text)) return 'Bank transfer';
  return 'Other';
}

// Fallback when the Bolna agent did not extract payment_mode:
// look only at what the CUSTOMER said (never the agent's script).
function paymentModeFromTranscript(transcript) {
  if (!transcript) return null;
  const customerText = String(transcript)
    .split(/\n+/)
    .filter((line) => /^\s*(user|customer|human)\s*:/i.test(line))
    .join(' ');
  for (const [label, pattern] of MODE_PATTERNS) {
    if (pattern.test(customerText)) return label;
  }
  return null;
}

const FAILED = [
  'failed',
  'error',
  'canceled',
  'cancelled',
  'stopped',
  'balance-low'
];

const UNANSWERED = [
  'no-answer',
  'no_answer',
  'busy'
];

// 3. Bolna webhook
app.post('/api/bolna-webhook', async (req, res) => {
  if (
    process.env.WEBHOOK_TOKEN &&
    req.query.token !== process.env.WEBHOOK_TOKEN
  ) {
    return res.status(401).send('Unauthorized');
  }

  const p = req.body || {};
  const data = p.data || p.execution || p;

  const callId =
    data.execution_id ||
    data.id ||
    p.execution_id ||
    p.id;

  const status = String(
    data.status ||
    data.execution_status ||
    p.status ||
    p.execution_status ||
    ''
  ).toLowerCase();

  const extracted = parseExtracted(
    data.extracted_data ||
    p.extracted_data
  );

  console.log('Bolna webhook received:', {
    callId: callId || null,
    status: status || null,
    hasExtractedData: Object.keys(extracted).length > 0
  });

  if (!callId) {
    console.warn('Webhook ignored: execution ID missing');
    return res.status(200).send('OK');
  }

  if (
    status !== 'completed' &&
    !UNANSWERED.includes(status) &&
    !FAILED.includes(status)
  ) {
    return res.status(200).send('OK');
  }

  // Default status for unanswered, failed, or unclear calls.
  let outcome = 'pending';

  let promised = null;
  let paymentDate = null;
  let dispute = null;
  let paymentState = null;
  let paymentMode = null;

  const hasExtraction = Object.keys(extracted).length > 0;

  if (status === 'completed') {
    // The outcome field may be called payment_status or call_outcome in Bolna.
    const rawOutcome = getField(extracted, 'payment_status', 'call_outcome')
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, '_');

    const allowed = [
      'promised_to_pay',
      'paid',
      'paid_on_call',
      'payment_done',
      'disputed',
      'refused',
      'wrong_number',
      'no_answer',
      'callback_requested'
    ];

    if (allowed.includes(rawOutcome)) {
      if ([
        'paid',
        'paid_on_call',
        'payment_done'
      ].includes(rawOutcome)) {
        outcome = 'Payment Done';
      } else if (rawOutcome === 'no_answer') {
        outcome = 'pending';
      } else {
        outcome = rawOutcome;
      }
    }

    // Future promised date and actual payment date are separate fields.
    // Neither is ever guessed from the transcript.
    promised = findPromisedDate(extracted);

    paymentDate = normalizeDate(getField(extracted, 'payment_date'));

    const transcript =
      data.transcript ||
      data.transcript_text ||
      p.transcript ||
      p.transcript_text ||
      '';

    dispute = getField(extracted, 'dispute_reason') || null;

    if (
      dispute &&
      /^(no answer|none|null)$/i.test(dispute)
    ) {
      dispute = null;
    }

    // A "completed" event with no extraction yet gives no information:
    // keep the old state and wait for the event that carries the extraction.
    paymentState = hasExtraction ? derivePaymentState(status, rawOutcome) : null;

    paymentMode =
      normalizePaymentMode(getField(extracted, 'payment_mode')) ||
      paymentModeFromTranscript(transcript);
  }

  try {
    const transcript =
      data.transcript ||
      data.transcript_text ||
      p.transcript ||
      p.transcript_text ||
      null;

    const recording =
      data.telephony_data?.recording_url ||
      p.telephony_data?.recording_url ||
      data.recording_url ||
      p.recording_url ||
      null;

    // Completed but extraction not delivered yet: save the transcript/recording only.
    const waitingForExtraction = status === 'completed' && !hasExtraction;
    if (waitingForExtraction) {
      console.warn('Call completed but no extracted_data yet. Waiting for the next webhook.');
    }

    const result = db.prepare(`
      UPDATE customers_invoices
      SET payment_status = CASE WHEN ? = 1 THEN payment_status ELSE ? END,
          payment_state = COALESCE(?, payment_state),
          payment_mode = COALESCE(?, payment_mode),
          promised_pay_date = COALESCE(?, promised_pay_date),
          payment_date = COALESCE(?, payment_date),
          dispute_reason = COALESCE(?, dispute_reason),
          last_transcript = COALESCE(?, last_transcript),
          last_recording = COALESCE(?, last_recording)
      WHERE last_call_id = ?
    `).run(
      waitingForExtraction ? 1 : 0,
      outcome,
      paymentState,
      paymentMode,
      promised,
      paymentDate,
      dispute,
      transcript,
      recording,
      String(callId)
    );

    console.log('Webhook database result:', {
      matchedInvoices: result.changes,
      payment_status: outcome,
      payment_state: paymentState,
      payment_mode: paymentMode,
      promised_pay_date: promised,
      payment_date: paymentDate
    });

    if (result.changes > 0) {
      const inv = db.prepare(
        'SELECT * FROM customers_invoices WHERE last_call_id = ?'
      ).get(String(callId));

      if (inv) {
        await recordCall({
          call_id: String(callId),
          invoice_id: inv.id,
          customer_name: inv.customer_name,
          phone_number: inv.phone_number,
          amount_due: inv.amount_due,
          due_date: inv.due_date,
          call_status: status,
          outcome: (status === 'completed' && !hasExtraction) ? null : outcome,
          payment_state: inv.payment_state,
          payment_mode: paymentMode,
          promised_pay_date: promised,
          payment_date: paymentDate,
          dispute_reason: dispute,
          transcript,
          recording_url: recording,
          completed_at: new Date().toISOString()
        });
      }

      io.emit('dashboard-update');
    } else {
      console.warn(
        'No invoice matched webhook call ID:',
        String(callId)
      );
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook processing error:', err);

    res.status(500).send('Webhook processing failed');
  }
});

// 3b. Call history (stored in Supabase)
app.get('/api/call-logs/stats', async (req, res) => {
  if (!sb.isConfigured()) {
    return res.json({ configured: false, total: 0, today: 0, byOutcome: {} });
  }

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
  if (!sb.isConfigured()) {
    return res.json({ configured: false, rows: [], total: 0 });
  }

  try {
    const result = await sb.listCalls(req.query);
    res.json({ configured: true, ...result });
  } catch (err) {
    console.error('Call history error:', err.message);
    res.status(502).json({ error: 'Could not load call history from Supabase' });
  }
});

app.get('/api/call-logs/:id', async (req, res) => {
  const id = String(req.params.id);

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid call log ID' });
  }

  try {
    const row = await sb.getCall(id);
    if (!row) return res.status(404).json({ error: 'Call not found' });
    res.json(row);
  } catch (err) {
    console.error('Call detail error:', err.message);
    res.status(502).json({ error: 'Could not load this call from Supabase' });
  }
});

// 4. Automatic promised-date follow-up scheduler
const AUTO_FOLLOWUP_ENABLED =
  process.env.AUTO_FOLLOWUP_ENABLED === 'true';

const AUTO_FOLLOWUP_DRY_RUN =
  process.env.AUTO_FOLLOWUP_DRY_RUN === 'true';

// Two calls on the committed payment day (India time).
// If the 10 AM call is not picked up, the 5 PM call gets a second chance.
// Each slot can still start up to 2 hours late (e.g. if the server was down at 10:00).
const FOLLOWUP_SLOTS = [
  { name: 'morning', startHour: 10, endHour: 12 },
  { name: 'evening', startHour: 17, endHour: 19 }
];

// A call still marked 'calling' after this long is treated as lost (no webhook arrived)
const STUCK_CALL_MINUTES = 90;

let schedulerRunning = false;

async function runAutomaticFollowups() {
  if (
    (!AUTO_FOLLOWUP_ENABLED && !AUTO_FOLLOWUP_DRY_RUN) ||
    schedulerRunning
  ) {
    return;
  }

  const now = getIndiaTime();

  // Only Monday-Friday
  if (now.weekday === 'Sat' || now.weekday === 'Sun') {
    if (AUTO_FOLLOWUP_DRY_RUN) {
      console.log('[DRY RUN] Skipping: weekend in India.');
    }

    return;
  }

  // Only during one of the configured slots (10 AM or 5 PM)
  const slot = FOLLOWUP_SLOTS.find(
    (s) => now.hour >= s.startHour && now.hour < s.endHour
  );

  if (!slot) {
    if (AUTO_FOLLOWUP_DRY_RUN) {
      console.log(
        `[DRY RUN] Outside calling windows. India time: ${now.hour}:${String(now.minute).padStart(2, '0')}`
      );
    }

    return;
  }

  schedulerRunning = true;

  try {
    const stuckCutoff = new Date(
      Date.now() - STUCK_CALL_MINUTES * 60 * 1000
    ).toISOString();

    // Find invoices whose promised date has arrived.
    // Never follow up on completed payments.
    const invoices = db.prepare(`
      SELECT ci.*
      FROM customers_invoices AS ci
      LEFT JOIN followup_attempts AS fa
        ON fa.invoice_id = ci.id
        AND fa.attempt_date = ?
        AND fa.slot = ?
      WHERE ci.promised_pay_date IS NOT NULL
        AND ci.promised_pay_date <= ?
        AND fa.id IS NULL
        AND COALESCE(ci.payment_state, 'pending') != 'done'
        AND LOWER(COALESCE(ci.payment_status, 'pending'))
          NOT IN (
            'paid',
            'paid_on_call',
            'payment done',
            'disputed',
            'refused',
            'wrong_number',
            'human_review',
            'needs_human_review'
          )
        AND (
          LOWER(COALESCE(ci.payment_status, 'pending')) != 'calling'
          OR ci.last_call_at IS NULL
          OR ci.last_call_at < ?
        )
      ORDER BY ci.promised_pay_date ASC, ci.id ASC
    `).all(now.date, slot.name, now.date, stuckCutoff);

    // Process at most one invoice per scheduler tick.
    const inv = invoices[0];

    if (!inv) {
      if (AUTO_FOLLOWUP_DRY_RUN) {
        console.log(
          `[DRY RUN] No eligible invoice found for ${now.date} (${slot.name} slot).`
        );
      }

      return;
    }

    // Dry-run mode never sends a call.
    if (AUTO_FOLLOWUP_DRY_RUN) {
      console.log('[DRY RUN] Eligible invoice found. NO CALL SENT.', {
        invoiceId: inv.id,
        customerName: inv.customer_name,
        promisedPayDate: inv.promised_pay_date,
        paymentStatus: inv.payment_status,
        slot: slot.name,
        dateChecked: now.date
      });

      return;
    }

    // Reserve today's attempt before requesting the real call.
    const attempt = db.prepare(`
      INSERT INTO followup_attempts
        (invoice_id, attempt_date, slot, status)
      VALUES (?, ?, ?, 'starting')
      ON CONFLICT(invoice_id, attempt_date, slot) DO NOTHING
    `).run(inv.id, now.date, slot.name);

    if (attempt.changes === 0) {
      return;
    }

    try {
      const executionId = await requestBolnaCall(inv);

      db.prepare(`
        UPDATE followup_attempts
        SET status = 'requested', execution_id = ?
        WHERE id = ?
      `).run(executionId, attempt.lastInsertRowid);

      console.log('Automatic follow-up requested:', {
        invoiceId: inv.id,
        executionId,
        date: now.date,
        slot: slot.name
      });
    } catch (err) {
      db.prepare(`
        UPDATE followup_attempts
        SET status = 'failed', error_message = ?
        WHERE id = ?
      `).run(
        String(err.message || 'Call request failed').slice(0, 500),
        attempt.lastInsertRowid
      );

      console.error('Automatic follow-up failed:', {
        invoiceId: inv.id,
        error: err.message
      });
    }
  } catch (err) {
    console.error('Scheduler error:', err);
  } finally {
    schedulerRunning = false;
  }
}

// Check once every minute.
// Dry-run mode only checks and logs; it does not call Bolna.
// Optional PULL mode: this app reads Tally itself (needs a VPN/Tailscale route to it).
// Enable with TALLY_PULL_ENABLED=true and TALLY_URL in .env. Times are India time.
const TALLY_PULL_ENABLED = process.env.TALLY_PULL_ENABLED === 'true';
const TALLY_SYNC_TIMES = (process.env.TALLY_SYNC_TIMES || '09:00,21:00')
  .split(',').map((t) => t.trim()).filter((t) => /^\d{2}:\d{2}$/.test(t));
const tallyPullDone = new Set();
let tallyPullRunning = false;

async function maybeRunTallyPull() {
  if (!TALLY_PULL_ENABLED || tallyPullRunning) return;
  const now = getIndiaTime();
  const hhmm = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
  // Run at the scheduled minute, or up to 2 hours late if the app was off at that moment.
  const due = TALLY_SYNC_TIMES.find((t) => {
    const key = `${now.date} ${t}`;
    if (tallyPullDone.has(key)) return false;
    const [h, m] = t.split(':').map(Number);
    const minutesLate = now.hour * 60 + now.minute - (h * 60 + m);
    return minutesLate >= 0 && minutesLate < 120;
  });
  if (!due) return;

  tallyPullDone.add(`${now.date} ${due}`);
  tallyPullRunning = true;
  try {
    const { runTallySync } = require('./scripts/sync-tally');
    console.log(`Tally pull sync starting (${due} slot, India time ${hhmm})`);
    await runTallySync();
    io.emit('dashboard-update');
  } catch (err) {
    console.error('Tally pull sync failed:', err.message);
    // allow one retry on the next minute tick within the 2-hour window after a failure
    tallyPullDone.delete(`${now.date} ${due}`);
  } finally {
    tallyPullRunning = false;
  }
}
setInterval(maybeRunTallyPull, 60 * 1000);
maybeRunTallyPull();

setInterval(runAutomaticFollowups, 60 * 1000);

// Also check when the server starts.
runAutomaticFollowups();

const PORT = process.env.PORT || 3000;

// Deliver any queued Supabase writes every minute.
setInterval(flushOutbox, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);

  if (sb.isConfigured()) {
    console.log('Supabase: connected for call history.');
    flushOutbox().then(backfillExistingCalls);
  } else {
    console.log('Supabase: SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env - call history will queue locally until set.');
  }

  if (AUTO_FOLLOWUP_DRY_RUN) {
    console.log(
      '[DRY RUN] Enabled. Automatic scheduler will NOT send calls.'
    );
  } else if (!AUTO_FOLLOWUP_ENABLED) {
    console.log('Automatic follow-ups are disabled.');
  }
});
