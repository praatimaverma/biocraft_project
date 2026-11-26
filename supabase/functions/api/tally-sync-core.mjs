// Tally -> Supabase upload logic. NO npm packages needed (Node 18+).
// One copy lives in tally-agent/ (Windows agent) and one in functions/lib/ (POST /api/tally-sync).
// Keep both copies identical.
//
// Rules (see docs/CHANGE_REPORT.md):
//  * Only Tally-owned columns are ever written. Payment status, promised dates, call IDs,
//    transcripts, recordings, dispute reasons etc. are never in the payload, so a merge-upsert
//    cannot erase them.
//  * A phone number is only written when Tally actually has one.
//  * Every row of one run carries the same sync_batch_id. "Closing" of invoices that vanished
//    from Tally is done by the database function tally_close_missing() and ONLY after every
//    chunk was uploaded successfully and the export was complete.
import { randomUUID } from 'node:crypto';

const CHUNK = 500;
const DEFAULT_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

function clean(v) { return String(v == null ? '' : v).trim(); }
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

function istText(iso) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).format(new Date(iso));
}

// -> { rows, dropped }
function buildRows(invoices, { company = '', batchId, nowIso = new Date().toISOString() } = {}) {
  const rows = [];
  let dropped = 0;
  for (const r of invoices || []) {
    const customer = clean(r.customer_name);
    const invoiceNumber = clean(r.invoice_number);
    const amount = Math.round(Number(r.amount_due) * 100) / 100;
    const due = clean(r.due_date);
    if (!customer || !invoiceNumber || !Number.isFinite(amount) || amount < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      dropped++;
      continue;
    }
    const row = {
      invoice_key: `${customer.toLowerCase()}|${invoiceNumber.toLowerCase()}`,
      customer_name: customer,
      invoice_number: invoiceNumber,
      amount_due: amount,
      due_date: due,
      source: 'tally',
      tally_company: clean(company) || null,
      tally_synced_at: nowIso,
      tally_synced_at_ist: istText(nowIso),
      sync_batch_id: batchId,
      updated_at: nowIso
    };
    const phone = clean(r.phone_number);
    if (phone) row.phone_number = phone;
    rows.push(row);
  }
  // The same invoice twice in one export would make Postgres reject the upsert; keep the last.
  const byKey = new Map();
  for (const row of rows) byKey.set(row.invoice_key, row);
  const unique = [...byKey.values()];
  return { rows: unique, dropped, duplicates: rows.length - unique.length };
}

function isTransient(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }

async function rest(cfg, path, { method = 'GET', body, headers = {} } = {}, { backoff = DEFAULT_BACKOFF_MS, sleep = sleepReal, log = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
        method,
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : null;
      const err = new Error(`Supabase ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      if (!isTransient(res.status)) throw Object.assign(err, { permanent: true });
      lastErr = err;
    } catch (err) {
      if (err.permanent) throw err;
      lastErr = err; // network error / timeout / transient HTTP status
    }
    if (attempt < backoff.length) {
      log(`Temporary Supabase/network problem (${lastErr.message}). Retry ${attempt + 1}/${backoff.length} in ${backoff[attempt] / 1000}s.`);
      await sleep(backoff[attempt]);
    }
  }
  throw lastErr;
}

class PartialUploadError extends Error {
  constructor(message, written, total) { super(message); this.name = 'PartialUploadError'; this.written = written; this.total = total; }
}

// Uploads a full Tally snapshot. Returns a summary; throws PartialUploadError if any chunk failed.
async function uploadSnapshot(cfg, invoices, opts = {}) {
  const { company = '', complete = true, force = false, log = () => {}, backoff, sleep } = opts;
  const retry = { backoff, sleep, log };
  const batchId = opts.batchId || randomUUID();
  const { rows, dropped, duplicates } = buildRows(invoices, { company, batchId });
  const summary = {
    batchId, received: invoices.length, valid: rows.length, dropped, duplicates,
    written: 0, closed: 0, reopened: 0, closeSkippedReason: null
  };

  const withPhone = rows.filter((r) => r.phone_number);
  const noPhone = rows.filter((r) => !r.phone_number);
  for (const group of [withPhone, noPhone]) {
    for (let i = 0; i < group.length; i += CHUNK) {
      const part = group.slice(i, i + CHUNK);
      try {
        await rest(cfg, 'tally_invoices?on_conflict=invoice_key', {
          method: 'POST', body: part,
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
        }, retry);
      } catch (err) {
        throw new PartialUploadError(`Upload stopped after ${summary.written} of ${rows.length} invoices: ${err.message}`, summary.written, rows.length);
      }
      summary.written += part.length;
    }
  }

  const fullyUploaded = summary.written === rows.length;
  if (!fullyUploaded) throw new PartialUploadError('Not every invoice was uploaded', summary.written, rows.length);

  // Reopen/close only after a COMPLETE export was uploaded in full.
  const completeEnough = complete && rows.length > 0 && dropped === 0;
  const result = completeEnough
    ? await rest(cfg, 'rpc/tally_close_missing', {
        method: 'POST', body: { p_batch: batchId, p_company: clean(company) || null, p_force: !!force }
      }, retry)
    : await rest(cfg, 'rpc/tally_close_missing', {
        method: 'POST', body: { p_batch: batchId, p_company: clean(company) || null, p_force: false, p_reopen_only: true }
      }, retry);

  summary.closed = Number(result && result.closed) || 0;
  summary.reopened = Number(result && result.reopened) || 0;
  if (completeEnough) {
    summary.closeSkippedReason = (result && result.skipped_reason) || null;
  } else {
    summary.closeSkippedReason = !complete ? 'snapshot not marked complete'
      : !rows.length ? 'snapshot has no valid invoices'
      : `${dropped} Tally row(s) failed validation, so nothing was closed`;
  }
  return summary;
}

export { buildRows, uploadSnapshot, rest, PartialUploadError, istText, CHUNK };
