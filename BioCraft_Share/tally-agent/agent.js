
// BioCraft Tally Direct Supabase Sync Agent
// Runs ON THE TALLY SERVER.
// No laptop server or ngrok is required for invoice sync.
//
// Commands:
//   node agent.js
//   node agent.js --test
//   node agent.js --dump

const fs = require('fs');
const path = require('path');
const { fetchOutstanding } = require('./tally-client');

const DIR = __dirname;
const args = new Set(process.argv.slice(2));

const LOG = path.join(DIR, 'sync.log');
const PENDING = path.join(DIR, 'pending.json');

// --------------------------------------------------
// LOAD .ENV
// --------------------------------------------------

function loadEnv() {
  const file = path.join(DIR, '.env');

  if (!fs.existsSync(file)) {
    console.error('.env file not found');
    return;
  }

  const content = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
    );

    if (!match) continue;

    let value = match[2];

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
}

loadEnv();

// --------------------------------------------------
// LOGGING
// --------------------------------------------------

function log(message) {
  const line = `${new Date().toISOString()}  ${message}`;

  console.log(line);

  try {
    if (
      fs.existsSync(LOG) &&
      fs.statSync(LOG).size > 1024 * 1024
    ) {
      fs.renameSync(LOG, LOG + '.old');
    }

    fs.appendFileSync(LOG, line + '\n');
  } catch (_) {
    // Logging must not stop sync.
  }
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function getText(value) {
  if (value === null || value === undefined) return '';

  return String(value).trim();
}

function getInvoiceNumber(invoice) {
  const candidates = [
    invoice.invoice_number,
    invoice.voucher_number,
    invoice.bill_number,
    invoice.invoice_no,
    invoice.voucher_no,
    invoice.voucherNumber,
    invoice.billNo,
    invoice.number
  ];

  for (const candidate of candidates) {
    const value = getText(candidate);

    if (value) {
      return value;
    }
  }

  return '';
}

function getCustomerName(invoice) {
  return getText(
    invoice.customer_name ||
    invoice.customer ||
    invoice.party_name ||
    invoice.party ||
    invoice.ledger_name
  );
}

function getAmount(invoice) {
  const value = Number(invoice.amount_due);

  return Number.isFinite(value) ? value : NaN;
}

function getDueDate(invoice) {
  return getText(
    invoice.due_date ||
    invoice.bill_due_date ||
    invoice.dueDate
  );
}

// --------------------------------------------------
// BUILD SUPABASE ROWS
// --------------------------------------------------

function buildRows(invoices) {
  const rows = [];
  let skipped = 0;

  for (const invoice of invoices) {
    const customer = getCustomerName(invoice);
    const invoiceNumber = getInvoiceNumber(invoice);
    const amount = getAmount(invoice);
    const dueDate = getDueDate(invoice);

    if (
      !customer ||
      !invoiceNumber ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
    ) {
      skipped++;

      log(
        `SKIPPED invoice: customer="${customer}", ` +
        `invoice_number="${invoiceNumber}", due_date="${dueDate}"`
      );

      continue;
    }

    const now = new Date().toISOString();

    rows.push({
      invoice_key:
        `${customer.toLowerCase()}|${invoiceNumber.toLowerCase()}`,

      customer_name: customer,
      invoice_number: invoiceNumber,

      phone_number: getText(invoice.phone_number),

      amount_due: amount,
      due_date: dueDate,

      payment_status: 'pending',
      payment_state: 'pending',

      payment_mode: null,
      promised_pay_date: null,
      payment_date: null,
      dispute_reason: null,

      last_call_id: null,
      last_transcript: null,
      last_recording: null,

      source: 'tally',
      tally_closed: false,

      tally_synced_at: now,
      updated_at: now
    });
  }

  return {
    rows,
    skipped
  };
}

// --------------------------------------------------
// DIRECT SUPABASE UPLOAD
// --------------------------------------------------

async function pushDirectToSupabase(invoices) {
  const url = (
    process.env.SUPABASE_URL || ''
  )
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '');

  const key = (
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ''
  ).trim();

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env'
    );
  }

  const { rows, skipped } = buildRows(invoices);

  log(`Invoices received: ${invoices.length}`);
  log(`Valid invoices: ${rows.length}`);
  log(`Skipped invoices: ${skipped}`);

  if (!rows.length) {
    return {
      ok: true,
      received: invoices.length,
      written: 0,
      skipped
    };
  }

  const response = await fetch(
    `${url}/rest/v1/tally_invoices?on_conflict=invoice_key`,
    {
      method: 'POST',

      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',

        Prefer: 'resolution=merge-duplicates,return=minimal'
      },

      body: JSON.stringify(rows),

      signal: AbortSignal.timeout(60000)
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${responseText.slice(0, 1000)}`
    );
  }

  return {
    ok: true,
    received: invoices.length,
    written: rows.length,
    skipped
  };
}

// --------------------------------------------------
// MAIN
// --------------------------------------------------

async function main() {
  const options = {
    url: process.env.TALLY_URL || 'http://localhost:9000',

    company: process.env.TALLY_COMPANY || '',

    fromDate: process.env.TALLY_FROM_DATE || '',
    toDate: process.env.TALLY_TO_DATE || '',

    debitIsNegative:
      String(
        process.env.TALLY_DEBIT_IS_NEGATIVE || 'true'
      ).toLowerCase() !== 'false'
  };

  let result;

  // -----------------------------------------------
  // READ TALLY
  // -----------------------------------------------

  try {
    result = await fetchOutstanding(options);
  } catch (error) {
    log(`TALLY ERROR: ${error.message}`);

    if (
      !args.has('--test') &&
      fs.existsSync(PENDING)
    ) {
      log('Previous pending snapshot preserved.');
    }

    return 2;
  }

  const invoices = result.invoices || [];

  const withPhone = invoices.filter(
    invoice => invoice.phone_number
  ).length;

  log(
    `Tally: ${invoices.length} outstanding invoices ` +
    `(${withPhone} with phone). ` +
    `Bills seen ${result.stats.found}, ` +
    `credits skipped ${result.stats.skippedCredit}, ` +
    `incomplete skipped ${result.stats.skippedIncomplete}.`
  );

  for (const warning of result.warnings || []) {
    log(`WARNING: ${warning}`);
  }

  // -----------------------------------------------
  // DUMP XML
  // -----------------------------------------------

  if (args.has('--dump')) {
    fs.writeFileSync(
      path.join(DIR, 'dump-bills.xml'),
      result.raw.bills
    );

    fs.writeFileSync(
      path.join(DIR, 'dump-ledgers.xml'),
      result.raw.ledgers
    );

    log('Raw Tally XML saved.');
  }

  // -----------------------------------------------
  // TEST MODE
  // -----------------------------------------------

  if (args.has('--test')) {
    console.table(
      invoices.slice(0, 15).map(invoice => ({
        customer_name: getCustomerName(invoice),
        invoice_number: getInvoiceNumber(invoice),
        amount_due: invoice.amount_due,
        due_date: getDueDate(invoice),
        phone_number: invoice.phone_number
      }))
    );

    log('Test mode: nothing was sent to Supabase.');

    return invoices.length ? 0 : 3;
  }

  // -----------------------------------------------
  // SEND TO SUPABASE
  // -----------------------------------------------

  try {
    const response = await pushDirectToSupabase(invoices);

    if (fs.existsSync(PENDING)) {
      fs.unlinkSync(PENDING);
    }

    log(
      `SUPABASE SUCCESS: ${JSON.stringify(response)}`
    );

    log('Invoices sent directly to Supabase.');

    return 0;

  } catch (error) {
    const snapshot = {
      sent_at: new Date().toISOString(),
      company: options.company,
      invoices
    };

    fs.writeFileSync(
      PENDING,
      JSON.stringify(snapshot, null, 2)
    );

    log(
      `SUPABASE PUSH FAILED: ${error.message}. ` +
      'Snapshot saved to pending.json.'
    );

    return 4;
  }
}

// --------------------------------------------------
// START
// --------------------------------------------------

main().then(
  code => process.exit(code),

  error => {
    log(
      `UNEXPECTED ERROR: ${error.stack || error}`
    );

    process.exit(1);
  }
);
