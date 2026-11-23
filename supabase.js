
const { randomUUID } = require('crypto');

// ======================================================
// SUPABASE CONFIGURATION
// ======================================================

const TABLE = 'call_logs';
const INVOICE_TABLE = 'tally_invoices';

function config() {
  let url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  url = url.replace(/\/rest\/v1$/, '');

  const key = (
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();

  return { url, key };
}

function isConfigured() {
  const { url, key } = config();
  return Boolean(url && key);
}

async function request(path, { method = 'GET', headers = {}, body } = {}) {
  const { url, key } = config();

  if (!url || !key) {
    throw new Error('Supabase is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
    }

    return res;
  } finally {
    clearTimeout(timer);
  }
}


// ======================================================
// CALL LOGS - EXISTING FUNCTIONALITY
// ======================================================

const OPTIONAL_COLUMNS = ['payment_date'];
let warnedMissingColumn = false;

function dropOptionalColumns(body) {
  const strip = (row) => {
    const copy = { ...row };

    for (const col of OPTIONAL_COLUMNS) {
      delete copy[col];
    }

    return copy;
  };

  return Array.isArray(body) ? body.map(strip) : strip(body);
}

function hasOptionalColumns(body) {
  const rows = Array.isArray(body) ? body : [body];

  return rows.some((row) =>
    OPTIONAL_COLUMNS.some((col) => row && col in row)
  );
}

function isMissingColumnError(err) {
  const msg = String((err && err.message) || '');

  return /PGRST204|schema cache|does not exist/i.test(msg) &&
    OPTIONAL_COLUMNS.some((col) => msg.includes(col));
}

async function writeRows(headers, body) {
  const path = `${TABLE}?on_conflict=call_id`;

  try {
    await request(path, {
      method: 'POST',
      headers,
      body
    });
  } catch (err) {
    if (!hasOptionalColumns(body) || !isMissingColumnError(err)) {
      throw err;
    }

    if (!warnedMissingColumn) {
      warnedMissingColumn = true;

      console.warn(
        'Supabase: call_logs is missing a newer column (payment_date). ' +
        'Saving without it. Re-run supabase_schema.sql in the Supabase SQL Editor to fix.'
      );
    }

    await request(path, {
      method: 'POST',
      headers,
      body: dropOptionalColumns(body)
    });
  }
}


// Insert a call, or update it if the same call_id already exists.
async function upsertCall(row) {
  await writeRows(
    { Prefer: 'resolution=merge-duplicates,return=minimal' },
    row
  );
}


// Make all rows have identical keys for bulk insertion.
function sameKeys(rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];

  return rows.map((r) =>
    Object.fromEntries(
      keys.map((k) => [k, r[k] === undefined ? null : r[k]])
    )
  );
}


// Insert many rows, skipping any call_id that already exists.
async function insertMissing(rows) {
  if (!Array.isArray(rows) || !rows.length) return;

  rows = sameKeys(rows);

  await writeRows(
    { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    rows
  );
}


const LIST_COLUMNS = [
  'id',
  'call_id',
  'invoice_id',
  'customer_name',
  'phone_number',
  'amount_due',
  'due_date',
  'trigger_source',
  'call_status',
  'outcome',
  'payment_state',
  'payment_mode',
  'promised_pay_date',
  'payment_date',
  'dispute_reason',
  'recording_url',
  'called_at',
  'completed_at'
].join(',');


// Remove characters that have special meaning inside a PostgREST filter.
function safeText(value) {
  return String(value || '')
    .replace(/[,()*%"\\]/g, ' ')
    .trim()
    .slice(0, 100);
}


// Start of a calendar day in India time, as an ISO string.
function istDay(dateText, addDays = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText || '')) {
    return null;
  }

  const d = new Date(`${dateText}T00:00:00+05:30`);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  d.setUTCDate(d.getUTCDate() + addDays);

  return d.toISOString();
}


async function listCalls(f = {}) {
  const params = new URLSearchParams();

  params.set('select', LIST_COLUMNS);

  const q = safeText(f.q);

  if (q) {
    const cols = [
      'customer_name',
      'phone_number',
      'call_id',
      'dispute_reason',
      'transcript'
    ];

    params.set(
      'or',
      `(${cols.map((c) => `${c}.ilike.*${q}*`).join(',')})`
    );
  }

  if (f.outcome) {
    params.set('outcome', `eq.${f.outcome}`);
  }

  if (f.call_status) {
    params.set('call_status', `eq.${f.call_status}`);
  }

  if (f.payment_state) {
    params.set('payment_state', `eq.${f.payment_state}`);
  }

  if (f.payment_mode) {
    params.set('payment_mode', `eq.${f.payment_mode}`);
  }

  if (f.source) {
    params.set('trigger_source', `eq.${f.source}`);
  }

  if (f.invoice_id) {
    params.set('invoice_id', `eq.${Number(f.invoice_id)}`);
  }

  const from = istDay(f.from);
  const to = istDay(f.to, 1);

  if (from) {
    params.append('called_at', `gte.${from}`);
  }

  if (to) {
    params.append('called_at', `lt.${to}`);
  }

  params.set(
    'order',
    f.sort === 'oldest' ? 'called_at.asc' : 'called_at.desc'
  );

  const limit = Math.min(Math.max(Number(f.limit) || 25, 1), 100);
  const offset = Math.max(Number(f.offset) || 0, 0);

  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const res = await request(`${TABLE}?${params}`, {
    headers: { Prefer: 'count=exact' }
  });

  const rows = await res.json();
  const range = res.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);

  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length
  };
}


async function getCall(id) {
  const res = await request(
    `${TABLE}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
  );

  const rows = await res.json();

  return rows[0] || null;
}


async function stats() {
  const res = await request(
    `${TABLE}?select=outcome,call_status,called_at&limit=10000`
  );

  return res.json();
}


// ======================================================
// TALLY INVOICES - SUPABASE INTEGRATION
// ======================================================


// Convert timestamp into Indian Standard Time.
function formatIndianTime(timestamp) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(timestamp));
}


// ======================================================
// UPSERT TALLY INVOICES
//
// Each sync gets a unique sync_batch_id.
// This function uploads invoices but does NOT delete old ones.
// ======================================================

async function upsertInvoices(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return {
      written: 0,
      syncBatchId: null
    };
  }

  // Generate a unique ID for this synchronization.
  const syncBatchId = randomUUID();

  // One timestamp for this synchronization batch.
  const syncedAt = new Date().toISOString();

  const payload = rows.map((r) => ({
    invoice_key: String(
      r.invoice_key ||
      `${String(r.customer_name || '').trim().toLowerCase()}|${String(r.invoice_number || '').trim().toLowerCase()}`
    ),

    customer_name: String(r.customer_name || ''),
    invoice_number: String(r.invoice_number || ''),
    phone_number: String(r.phone_number || ''),
    amount_due: Number(r.amount_due || 0),
    due_date: String(r.due_date || ''),

    payment_status: r.payment_status || 'pending',
    payment_state: r.payment_state || 'pending',
    payment_mode: r.payment_mode || null,
    promised_pay_date: r.promised_pay_date || null,
    payment_date: r.payment_date || null,
    dispute_reason: r.dispute_reason || null,

    last_call_id: r.last_call_id || null,
    last_transcript: r.last_transcript || null,
    last_recording: r.last_recording || null,

    source: r.source || 'tally',
    tally_closed: Boolean(r.tally_closed),

    // UTC timestamp.
    tally_synced_at: syncedAt,

    // Indian Standard Time display value.
    tally_synced_at_ist: formatIndianTime(syncedAt),

    // Batch identifier for this synchronization.
    sync_batch_id: syncBatchId,

    updated_at: syncedAt
  }));

  // Upload the complete batch.
  // If this request fails, the function throws an error.
  // The caller must NOT run cleanup after a failed upload.
  await request(`${INVOICE_TABLE}?on_conflict=invoice_key`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: sameKeys(payload)
  });

  return {
    written: payload.length,
    syncBatchId
  };
}


// ======================================================
// CLEANUP OLD TALLY INVOICES
//
// Call ONLY after confirming that the complete Tally
// snapshot was successfully uploaded.
//
// This function affects tally_invoices only.
// It never modifies call_logs.
// ======================================================

async function cleanupOldTallyInvoices(syncBatchId) {
  if (
    typeof syncBatchId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(syncBatchId)
  ) {
    throw new Error(
      'Invalid or missing Tally sync batch ID. Cleanup cancelled.'
    );
  }

  const res = await request('rpc/cleanup_old_tally_invoices', {
    method: 'POST',
    body: {
      p_sync_batch_id: syncBatchId
    }
  });

  const deleted = await res.json();

  return {
    success: true,
    deleted: Number(deleted) || 0,
    syncBatchId
  };
}


// ======================================================
// FETCH INVOICES FROM SUPABASE
// ======================================================

async function listInvoices() {
  const params = new URLSearchParams({
    select: [
      'id',
      'invoice_key',
      'customer_name',
      'invoice_number',
      'phone_number',
      'amount_due',
      'due_date',
      'payment_status',
      'payment_state',
      'payment_mode',
      'promised_pay_date',
      'payment_date',
      'dispute_reason',
      'last_call_id',
      'last_transcript',
      'last_recording',
      'source',
      'tally_closed',
      'tally_synced_at',
      'tally_synced_at_ist',
      'sync_batch_id'
    ].join(','),

    order: 'due_date.asc',
    limit: '10000'
  });

  const res = await request(`${INVOICE_TABLE}?${params}`);

  return res.json();
}


// ======================================================
// EXPORT FUNCTIONS
// ======================================================

module.exports = {
  isConfigured,

  // Call logs
  upsertCall,
  insertMissing,
  listCalls,
  getCall,
  stats,

  // Tally invoices
  upsertInvoices,
  cleanupOldTallyInvoices,
  listInvoices
};
