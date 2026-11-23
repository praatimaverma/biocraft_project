// Saves every call to Supabase (one new row per call) and keeps a local
// retry queue so nothing is lost if Supabase is briefly unreachable.
const db = require('./db');
const sb = require('./supabase');

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

// Never throws: a Supabase problem must not break calling or the webhook.
async function recordCall(row) {
  try {
    if (!row || !row.call_id) return false;
    const payload = clean({ ...row, updated_at: new Date().toISOString() });

    if (sb.isConfigured()) {
      try {
        await sb.upsertCall(payload);
        return true;
      } catch (err) {
        console.error('Supabase save failed, queued for retry:', err.message);
        queue(payload, err.message);
        return false;
      }
    }

    queue(payload, 'Supabase not configured');
    return false;
  } catch (err) {
    console.error('recordCall error:', err);
    return false;
  }
}

function queue(payload, reason) {
  db.prepare('INSERT INTO supabase_outbox (payload, last_error) VALUES (?, ?)')
    .run(JSON.stringify(payload), String(reason).slice(0, 300));
}

let flushing = false;

async function flushOutbox() {
  if (flushing || !sb.isConfigured()) return 0;
  flushing = true;
  let sent = 0;

  try {
    const rows = db.prepare(
      'SELECT id, payload FROM supabase_outbox ORDER BY id LIMIT 50'
    ).all();

    for (const item of rows) {
      try {
        await sb.upsertCall(JSON.parse(item.payload));
        db.prepare('DELETE FROM supabase_outbox WHERE id = ?').run(item.id);
        sent++;
      } catch (err) {
        db.prepare(
          'UPDATE supabase_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?'
        ).run(String(err.message).slice(0, 300), item.id);
        break; // keep order; try again on the next tick
      }
    }
  } finally {
    flushing = false;
  }

  if (sent) console.log(`Supabase: ${sent} queued call record(s) delivered.`);
  return sent;
}

// One-time-safe import of calls that already exist in the local database
// (invoices with a last_call_id) so earlier calls also appear in history.
async function backfillExistingCalls() {
  if (!sb.isConfigured()) return;

  try {
    const invoices = db.prepare(
      "SELECT * FROM customers_invoices WHERE last_call_id IS NOT NULL AND last_call_id != ''"
    ).all();

    const rows = invoices.map((inv) => {
      const status = String(inv.payment_status || '').toLowerCase();
      const inFlight = status === 'calling';
      return clean({
        call_id: String(inv.last_call_id),
        invoice_id: inv.id,
        customer_name: inv.customer_name,
        phone_number: inv.phone_number,
        amount_due: inv.amount_due,
        due_date: inv.due_date,
        trigger_source: 'imported',
        call_status: inFlight ? 'calling' : 'completed',
        outcome: inFlight ? null : inv.payment_status,
        payment_state: inv.payment_state,
        payment_mode: inv.payment_mode,
        promised_pay_date: inv.promised_pay_date,
        payment_date: inv.payment_date,
        dispute_reason: inv.dispute_reason,
        transcript: inv.last_transcript,
        recording_url: inv.last_recording
      });
    });

    await sb.insertMissing(rows);
    if (rows.length) console.log(`Supabase: checked ${rows.length} existing call(s) for import.`);
  } catch (err) {
    console.error('Supabase backfill failed:', err.message);
  }
}

module.exports = { recordCall, flushOutbox, backfillExistingCalls };
