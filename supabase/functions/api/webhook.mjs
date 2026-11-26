// Bolna webhook processing. Ported from server.js "3. Bolna webhook" with the same rules; the
// only changes are: invoice lookup/update goes to Supabase instead of SQLite, and the webhook token
// is REQUIRED (an unset token no longer means "open to everyone").
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as store from './store.mjs';
import { recordCall } from './calllog.mjs';
import * as H from './helpers.mjs';
import { env } from './env.mjs';

function tokenOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns { code, body }.
async function handleBolnaWebhook(req) {
  const expected = env('WEBHOOK_TOKEN') || '';
  if (!expected) return { code: 503, body: 'Webhook is disabled: WEBHOOK_TOKEN is not configured' };
  if (!tokenOk(req.query && req.query.token, expected)) return { code: 401, body: 'Unauthorized' };

  const p = req.body || {};
  const data = p.data || p.execution || p;
  const callId = data.execution_id || data.id || p.execution_id || p.id;
  const status = String(data.status || data.execution_status || p.status || p.execution_status || '').toLowerCase();
  const extracted = H.parseExtracted(data.extracted_data || p.extracted_data);

  console.log('Bolna webhook received:', { callId: callId || null, status: status || null, hasExtractedData: Object.keys(extracted).length > 0 });

  if (!callId) { console.warn('Webhook ignored: execution ID missing'); return { code: 200, body: 'OK' }; }
  if (status !== 'completed' && !H.UNANSWERED.includes(status) && !H.FAILED.includes(status)) return { code: 200, body: 'OK' };

  let outcome = 'pending';
  let promised = null;
  let paymentDate = null;
  let dispute = null;
  let paymentState = null;
  let paymentMode = null;
  const hasExtraction = Object.keys(extracted).length > 0;

  if (status === 'completed') {
    const rawOutcome = H.getField(extracted, 'payment_status', 'call_outcome').toLowerCase().trim().replace(/[\s-]+/g, '_');
    const allowed = ['promised_to_pay', 'paid', 'paid_on_call', 'payment_done', 'disputed', 'refused', 'wrong_number', 'no_answer', 'callback_requested'];
    if (allowed.includes(rawOutcome)) {
      if (['paid', 'paid_on_call', 'payment_done'].includes(rawOutcome)) outcome = 'Payment Done';
      else if (rawOutcome === 'no_answer') outcome = 'pending';
      else outcome = rawOutcome;
    }
    promised = H.findPromisedDate(extracted);
    paymentDate = H.normalizeDate(H.getField(extracted, 'payment_date'));
    const transcript = data.transcript || data.transcript_text || p.transcript || p.transcript_text || '';
    dispute = H.getField(extracted, 'dispute_reason') || null;
    if (dispute && /^(no answer|none|null)$/i.test(dispute)) dispute = null;
    paymentState = hasExtraction ? H.derivePaymentState(status, rawOutcome) : null;
    paymentMode = H.normalizePaymentMode(H.getField(extracted, 'payment_mode')) || H.paymentModeFromTranscript(transcript);
  }

  try {
    const transcript = data.transcript || data.transcript_text || p.transcript || p.transcript_text || null;
    const recording = (data.telephony_data && data.telephony_data.recording_url) ||
      (p.telephony_data && p.telephony_data.recording_url) || data.recording_url || p.recording_url || null;

    const waitingForExtraction = status === 'completed' && !hasExtraction;
    if (waitingForExtraction) console.warn('Call completed but no extracted_data yet. Waiting for the next webhook.');

    // SQL used COALESCE(new, old): a null never overwrites, so null fields are simply left out.
    const fields = {};
    if (!waitingForExtraction) fields.payment_status = outcome;
    const optional = { payment_state: paymentState, payment_mode: paymentMode, promised_pay_date: promised,
      payment_date: paymentDate, dispute_reason: dispute, last_transcript: transcript, last_recording: recording };
    for (const [k, v] of Object.entries(optional)) if (v !== null && v !== undefined) fields[k] = v;

    // (store.patchInvoiceByCallId always stamps updated_at, so the invoice is found even if no field changed.)
    const rows = await store.patchInvoiceByCallId(callId, fields);
    console.log('Webhook database result:', { matchedInvoices: rows.length, payment_status: outcome, payment_state: paymentState,
      payment_mode: paymentMode, promised_pay_date: promised, payment_date: paymentDate });

    if (rows.length > 0) {
      const inv = rows[0];
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
    } else {
      console.warn('No invoice matched webhook call ID:', String(callId));
    }
    return { code: 200, body: 'OK' };
  } catch (err) {
    console.error('Webhook processing error:', err);
    return { code: 500, body: 'Webhook processing failed' }; // Bolna will retry on 5xx
  }
}

export { handleBolnaWebhook, tokenOk };
