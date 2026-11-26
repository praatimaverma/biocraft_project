// Invoice + follow-up storage on Supabase. REPLACES the SQLite working copy (db.js) in the cloud
// backend: Supabase tally_invoices is the one source of truth, so nothing depends on a local file.
'use strict';
const sb = require('./supabase');

const INV = 'tally_invoices';
const PAGE = 1000; // Supabase returns at most 1000 rows per request

// Same shape the dashboard always received from SQLite (SELECT * FROM customers_invoices).
function toDashboardRow(r) {
  return {
    id: r.id,
    customer_name: r.customer_name,
    phone_number: r.phone_number || 'N/A',
    amount_due: Number(r.amount_due || 0),
    due_date: r.due_date || '',
    payment_status: r.payment_status || 'pending',
    promised_pay_date: r.promised_pay_date || null,
    dispute_reason: r.dispute_reason || null,
    last_call_id: r.last_call_id || null,
    last_transcript: r.last_transcript || null,
    last_recording: r.last_recording || null,
    payment_state: r.payment_state || 'pending',
    payment_mode: r.payment_mode || null,
    last_call_at: r.last_call_at || null,
    invoice_number: r.invoice_number || `INV-${1000 + Number(r.id)}`,
    payment_date: r.payment_date || null,
    source: r.source || 'tally',
    tally_closed: r.tally_closed ? 1 : 0,
    tally_synced_at: r.tally_synced_at || null
  };
}

async function getAll(filterQuery) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await sb.request(`${INV}?${filterQuery}&order=id.asc&limit=${PAGE}&offset=${offset}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function listInvoices() {
  const rows = await getAll('select=*');
  return rows.map(toDashboardRow).sort((a, b) =>
    String(a.due_date).localeCompare(String(b.due_date)) || a.id - b.id);
}

async function getInvoice(id) {
  const res = await sb.request(`${INV}?id=eq.${Number(id)}&select=*&limit=1`);
  const rows = await res.json();
  return rows[0] ? toDashboardRow(rows[0]) : null;
}

async function patchInvoice(id, fields) {
  await sb.request(`${INV}?id=eq.${Number(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: { ...fields, updated_at: new Date().toISOString() }
  });
}

// Returns the updated invoice rows (empty array = no invoice has this call id).
async function patchInvoiceByCallId(callId, fields) {
  const res = await sb.request(`${INV}?last_call_id=eq.${encodeURIComponent(String(callId))}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: { ...fields, updated_at: new Date().toISOString() }
  });
  return (await res.json()).map(toDashboardRow);
}

// Invoices whose promised date has arrived and that are not already settled (status filtering is
// done by the caller so the rules stay identical to the original SQL).
async function listFollowupCandidates(today) {
  const rows = await getAll(`select=*&promised_pay_date=not.is.null&promised_pay_date=lte.${encodeURIComponent(today)}&payment_state=neq.done`);
  return rows.map(toDashboardRow).sort((a, b) =>
    String(a.promised_pay_date).localeCompare(String(b.promised_pay_date)) || a.id - b.id);
}

async function attemptedInvoiceIds(date, slot) {
  const res = await sb.request(`followup_attempts?attempt_date=eq.${encodeURIComponent(date)}&slot=eq.${encodeURIComponent(slot)}&select=invoice_id&limit=10000`);
  return new Set((await res.json()).map((r) => Number(r.invoice_id)));
}

// THE DUPLICATE-CALL LOCK. followup_attempts has UNIQUE(invoice_id, attempt_date, slot); the
// insert below is atomic in Postgres. Exactly one caller gets the row back, everyone else gets [].
async function reserveAttempt(invoiceId, date, slot) {
  const res = await sb.request('followup_attempts?on_conflict=invoice_id,attempt_date,slot', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: { invoice_id: Number(invoiceId), attempt_date: date, slot, status: 'starting' }
  });
  const rows = await res.json();
  return rows[0] || null;
}

async function updateAttempt(id, fields) {
  await sb.request(`followup_attempts?id=eq.${Number(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: fields });
}

async function recentSyncs(limit = 10) {
  const res = await sb.request(`tally_sync_log?select=started_at,finished_at,status,trigger,tally_company,invoices_received,invoices_written,invoices_closed,invoices_reopened,warnings,error&order=started_at.desc&limit=${Number(limit)}`);
  return res.json();
}

module.exports = {
  toDashboardRow, listInvoices, getInvoice, patchInvoice, patchInvoiceByCallId,
  listFollowupCandidates, attemptedInvoiceIds, reserveAttempt, updateAttempt, recentSyncs
};
