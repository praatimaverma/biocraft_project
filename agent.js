#!/usr/bin/env node
// Biocraft Tally sync agent. Runs ON THE TALLY SERVER (Windows), no npm install needed.
//   node agent.js            read Tally, push directly to Supabase
//   node agent.js --test     only check that Tally answers and show what it found (sends nothing)
//   node agent.js --dump     also save the raw Tally XML next to this file (for troubleshooting)
//   node agent.js --force    allow the app to mark many invoices as paid in one run
const fs = require('fs');
const path = require('path');
const { fetchOutstanding } = require('./tally-client');

const DIR = __dirname;
const args = new Set(process.argv.slice(2));
const LOG = path.join(DIR, 'sync.log');
const PENDING = path.join(DIR, 'pending.json');

// ---- tiny .env reader (so the server needs no packages) ----
function loadEnv() {
  const file = path.join(DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
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

async function pushDirectToSupabase(invoices) {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in this agent .env');

  const rows = invoices.map((r) => {
    const customer = String(r.customer_name || '').trim();
    const invoiceNumber = String(r.invoice_number || '').trim();
    return {
      invoice_key: `${customer.toLowerCase()}|${invoiceNumber.toLowerCase()}`,
      customer_name: customer,
      invoice_number: invoiceNumber,
      phone_number: String(r.phone_number || ''),
      amount_due: Number(r.amount_due || 0),
      due_date: String(r.due_date || ''),
      source: 'tally',
      tally_closed: false,
      tally_synced_at: new Date().toISOString(),
    };
  }).filter((r) => r.customer_name && r.invoice_number && Number.isFinite(r.amount_due) && r.amount_due >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.due_date));

  if (!rows.length) return { ok: true, received: invoices.length, written: 0, skipped: invoices.length };

  // Only Tally-owned fields are sent. Payment/call fields are intentionally omitted
  // so merge-upserts cannot erase payment promises or call history.
  const response = await fetch(`${url}/rest/v1/tally_invoices?on_conflict=invoice_key`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
  return { ok: true, received: invoices.length, written: rows.length, skipped: invoices.length - rows.length };
}

async function main() {
  const opts = {
    url: process.env.TALLY_URL || 'http://localhost:9000',
    company: process.env.TALLY_COMPANY || '',
    fromDate: process.env.TALLY_FROM_DATE || '',
    toDate: process.env.TALLY_TO_DATE || '',
    debitIsNegative: String(process.env.TALLY_DEBIT_IS_NEGATIVE || 'true').toLowerCase() !== 'false'
  };

  let result;
  try {
    result = await fetchOutstanding(opts);
  } catch (err) {
    log(`TALLY ERROR: ${err.message}`);
    // Keep the earlier snapshot for the next successful Tally/Supabase run.
    if (!args.has('--test') && fs.existsSync(PENDING)) log('A prior pending snapshot is preserved for retry.');

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

  if (args.has('--test')) {
    console.table(result.invoices.slice(0, 15));
    log('Test mode: nothing was sent to the app.');
    return result.invoices.length ? 0 : 3;
  }

  try {
    const r = await pushDirectToSupabase(result.invoices);
    if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
    log(`Sent directly to Supabase: ${JSON.stringify(r)}`);
    return 0;
  } catch (err) {
    const snapshot = { sent_at: new Date().toISOString(), company: opts.company, invoices: result.invoices };
    fs.writeFileSync(PENDING, JSON.stringify(snapshot));
    log(`SUPABASE PUSH FAILED: ${err.message}. Snapshot saved to pending.json.`);
    return 4;
  }
}

main().then((code) => process.exit(code), (err) => { log(`UNEXPECTED ERROR: ${err.stack || err}`); process.exit(1); });
