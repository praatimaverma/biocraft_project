#!/usr/bin/env node
// BioCraft Tally sync agent. Runs ON THE CLIENT'S TALLY WINDOWS SERVER. No npm install needed (Node 18+).
//   node agent.js              full sync: Tally -> Supabase
//   node agent.js --scheduled  same, used by the Windows scheduled tasks (adds window check to the log)
//   node agent.js --test       only check that Tally answers and show what it found (sends nothing)
//   node agent.js --dump       also save the raw Tally XML next to this file (for troubleshooting)
//   node agent.js --force      allow marking many missing invoices as paid in one run
//
// Exit codes: 0 ok | 1 unexpected | 2 Tally problem | 3 Tally returned nothing | 4 Supabase upload failed/partial
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchOutstanding } = require('./tally-client');
const { uploadSnapshot, rest, PartialUploadError } = require('./tally-sync-core');

const DIR = __dirname;
const args = new Set(process.argv.slice(2));
const LOG = path.join(DIR, 'sync.log');
const STATUS_FILE = path.join(DIR, 'last-sync.json');

function loadEnv() {
  const file = path.join(DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* logging must never stop the sync */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function istNow() {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())) p[x.type] = x.value;
  return { hour: Number(p.hour), minute: Number(p.minute) };
}

function supabaseCfg() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return { url, key };
}

function writeStatus(obj) {
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(obj, null, 2)); } catch (_) { /* ignore */ }
}

// Best-effort: a problem with the log table must never fail or hide the real sync result.
async function logStart(cfg, batchId, company, trigger) {
  try {
    await rest(cfg, 'tally_sync_log', {
      method: 'POST',
      body: { batch_id: batchId, trigger, status: 'running', tally_company: company || null, agent_host: os.hostname() },
      headers: { Prefer: 'return=minimal' }
    }, { backoff: [2000, 5000] });
  } catch (err) { log(`(sync log start not saved: ${err.message})`); }
}
async function logFinish(cfg, batchId, fields) {
  try {
    await rest(cfg, `tally_sync_log?batch_id=eq.${encodeURIComponent(batchId)}`, {
      method: 'PATCH', body: { finished_at: new Date().toISOString(), ...fields }, headers: { Prefer: 'return=minimal' }
    }, { backoff: [2000, 5000, 15000] });
  } catch (err) { log(`(sync log result not saved: ${err.message})`); }
}

// Tally can be busy for a moment (e.g. a user running a report). Retry only temporary problems.
async function fetchWithRetry(opts) {
  const waits = [20000, 60000, 120000];
  for (let i = 0; ; i++) {
    try { return await fetchOutstanding(opts); } catch (err) {
      const temporary = /Could not reach Tally|did not answer|Tally HTTP 5/.test(err.message);
      if (!temporary || i >= waits.length) throw err;
      log(`Tally not reachable (${err.message}). Retry ${i + 1}/${waits.length} in ${waits[i] / 1000}s.`);
      await sleep(waits[i]);
    }
  }
}

async function main() {
  const trigger = args.has('--scheduled') ? 'scheduled' : 'manual';
  const started = Date.now();
  const deadline = started + (Number(process.env.AGENT_MAX_MINUTES) || 50) * 60 * 1000;
  const now = istNow();
  if (args.has('--scheduled')) {
    const inWindow = (now.hour === 8) || (now.hour === 15);
    log(`Scheduled run started (India time ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}).` +
        (inWindow ? '' : ' NOTE: this is outside the usual 08:00-09:00 / 15:00-16:00 window (a missed run is being made up).'));
  }

  const opts = {
    url: process.env.TALLY_URL || 'http://localhost:9000',
    company: process.env.TALLY_COMPANY || '',
    fromDate: process.env.TALLY_FROM_DATE || '',
    toDate: process.env.TALLY_TO_DATE || '',
    debitIsNegative: String(process.env.TALLY_DEBIT_IS_NEGATIVE || 'true').toLowerCase() !== 'false'
  };
  const cfg = supabaseCfg();
  const batchId = require('crypto').randomUUID();
  const testOnly = args.has('--test');
  if (!testOnly) {
    if (!cfg.url || !cfg.key) { log('CONFIG ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in this folder\'s .env'); return 4; }
    await logStart(cfg, batchId, opts.company, trigger);
  }

  let result;
  try {
    result = await fetchWithRetry(opts);
  } catch (err) {
    log(`TALLY ERROR: ${err.message}`);
    if (!testOnly) {
      await logFinish(cfg, batchId, { status: 'failed', error: `Tally: ${err.message}`.slice(0, 500) });
      writeStatus({ at: new Date().toISOString(), status: 'failed', error: err.message });
    }
    return 2;
  }

  if (args.has('--dump')) {
    fs.writeFileSync(path.join(DIR, 'dump-bills.xml'), result.raw.bills);
    fs.writeFileSync(path.join(DIR, 'dump-ledgers.xml'), result.raw.ledgers);
    log('Raw Tally XML saved: dump-bills.xml, dump-ledgers.xml');
  }

  const withPhone = result.invoices.filter((i) => i.phone_number).length;
  log(`Tally: ${result.invoices.length} outstanding invoices (${withPhone} with phone). ` +
      `Bills seen ${result.stats.found}, credits skipped ${result.stats.skippedCredit}, incomplete skipped ${result.stats.skippedIncomplete}.`);
  for (const w of result.warnings) log(`WARNING: ${w}`);

  if (testOnly) {
    console.table(result.invoices.slice(0, 15));
    log('Test mode: nothing was sent to Supabase.');
    return result.invoices.length ? 0 : 3;
  }

  if (!result.invoices.length) {
    // An empty export is never treated as "everything was paid".
    const msg = 'Tally returned no outstanding invoices; nothing was changed in Supabase.';
    log(`FAILED: ${msg}`);
    await logFinish(cfg, batchId, { status: 'failed', invoices_received: 0, error: msg, warnings: result.warnings.join(' | ').slice(0, 500) });
    writeStatus({ at: new Date().toISOString(), status: 'failed', error: msg });
    return 3;
  }

  try {
    const s = await uploadSnapshot(cfg, result.invoices, {
      batchId, company: opts.company, complete: true, force: args.has('--force'), log
    });
    if (Date.now() > deadline) log('WARNING: this run took longer than AGENT_MAX_MINUTES.');
    const status = s.closeSkippedReason && /validation|not complete|no valid|looks wrong/.test(s.closeSkippedReason) ? 'warning' : 'success';
    log(`${status.toUpperCase()}: uploaded ${s.written}/${s.valid} invoices (received ${s.received}, dropped ${s.dropped}); ` +
        `closed ${s.closed}, reopened ${s.reopened}.` + (s.closeSkippedReason ? ` Close step skipped: ${s.closeSkippedReason}` : ''));
    await logFinish(cfg, batchId, {
      status, invoices_received: s.received, invoices_written: s.written,
      invoices_closed: s.closed, invoices_reopened: s.reopened,
      warnings: [...result.warnings, s.closeSkippedReason].filter(Boolean).join(' | ').slice(0, 500) || null
    });
    writeStatus({ at: new Date().toISOString(), status, ...s });
    return 0;
  } catch (err) {
    const partial = err instanceof PartialUploadError;
    log(`${partial ? 'PARTIAL UPLOAD - NOT A SUCCESS' : 'SUPABASE UPLOAD FAILED'}: ${err.message}`);
    await logFinish(cfg, batchId, {
      status: partial ? 'partial' : 'failed', invoices_received: result.invoices.length,
      invoices_written: partial ? err.written : 0, error: err.message.slice(0, 500)
    });
    writeStatus({ at: new Date().toISOString(), status: partial ? 'partial' : 'failed', error: err.message });
    return 4;
  }
}

main().then((code) => process.exit(code), (err) => { log(`UNEXPECTED ERROR: ${err.stack || err}`); process.exit(1); });
