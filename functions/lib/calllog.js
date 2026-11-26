// Saves every call to Supabase call_logs. Same contract as the original calllog.js (never throws),
// but without the local SQLite retry queue: Cloud Functions have no durable disk. Instead the write
// is retried a few times, and if Supabase is still unreachable the full payload is written to the
// Cloud Logging error log so it can be replayed by hand.
'use strict';
const sb = require('./supabase');

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recordCall(row) {
  try {
    if (!row || !row.call_id) return false;
    const payload = clean({ ...row, updated_at: new Date().toISOString() });
    if (!sb.isConfigured()) { console.error('CALL_LOG_NOT_SAVED (Supabase not configured):', JSON.stringify(payload)); return false; }
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try { await sb.upsertCall(payload); return true; } catch (err) { lastErr = err; await sleep(500 * (i + 1)); }
    }
    console.error('CALL_LOG_NOT_SAVED (after 3 tries):', lastErr && lastErr.message, JSON.stringify(payload));
    return false;
  } catch (err) {
    console.error('recordCall error:', err);
    return false;
  }
}

module.exports = { recordCall };
