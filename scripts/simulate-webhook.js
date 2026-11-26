// OPTIONAL TEST TOOL - see the dashboard react to a call without making a real call.
//
// It pretends Bolna just finished a call for one invoice, by sending the same kind
// of message Bolna sends to /api/bolna-webhook. The server then updates the invoice
// and Supabase exactly as it would after a real call.
//
//   node scripts/simulate-webhook.js <invoiceId> <scenario> --yes
//
// Scenarios:
//   paid      customer already paid (sets Payment status = Done, mode = Bank transfer, payment date = today)
//   promise   customer promises to pay in 3 days, by UPI
//   callback  customer asks for a call back (no date given)
//   noanswer  nobody picked up
//   dispute   customer disputes the invoice
//
// Run it from the project folder (the one that contains invoices.db) while
// `npm start` is running. It CHANGES that invoice, so use it on test invoices only.
// With a Supabase connection it also adds a row to Call history (call id starts with "demo-").

require('dotenv').config();
const db = require('../db');

const [invoiceArg, scenario, ...flags] = process.argv.slice(2);
const SCENARIOS = ['paid', 'promise', 'callback', 'noanswer', 'dispute'];

function usage(message) {
  if (message) console.error(message + '\n');
  console.error('Usage: node scripts/simulate-webhook.js <invoiceId> <' + SCENARIOS.join('|') + '> --yes');
  process.exit(1);
}

const invoiceId = Number(invoiceArg);
if (!Number.isInteger(invoiceId) || invoiceId <= 0) usage('Give a valid invoice id (see the first column of the invoices table).');
if (!SCENARIOS.includes(scenario)) usage('Unknown scenario "' + scenario + '".');

const invoice = db.prepare('SELECT * FROM customers_invoices WHERE id = ?').get(invoiceId);
if (!invoice) usage('No invoice with id ' + invoiceId + '.');

if (!flags.includes('--yes')) {
  console.error(
    'This will change invoice #' + invoice.id + ' (' + invoice.customer_name + ', ' + invoice.phone_number + ').\n' +
    'Use it on test invoices only. Add --yes to continue.'
  );
  process.exit(1);
}

// Wrap values the way Bolna really sends them (with confidence + reasoning),
// so a parsing bug here would show up in tests, not only on real calls.
function bolna(fields) {
  const group = {};
  for (const [k, v] of Object.entries(fields)) {
    group[k] = { objective: null, confidence: 0.9, subjective: v, validation: null, confidence_label: 'High', reasoning_objective: null, reasoning_subjective: 'simulated' };
  }
  return { 'Payment Follow-up': group };
}

function indiaDate(addDays = 0) {
  const d = new Date(Date.now() + addDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); // YYYY-MM-DD
}

const callId = 'demo-' + invoice.id + '-' + Date.now();

const PAYLOADS = {
  paid: {
    status: 'completed',
    transcript: 'assistant: Hello, this is an automated assistant from Biocraft Scientific. Has the payment been made?\nuser: Yes, I already paid it by NEFT.\nassistant: Thank you!',
    extracted_data: bolna({
      payment_status: 'paid',
      payment_mode: 'bank_transfer',
      payment_date: indiaDate(-1),
      promised_pay_date: '',
      dispute_reason: ''
    })
  },
  promise: {
    status: 'completed',
    transcript: 'assistant: Hello, this is an automated assistant from Biocraft Scientific. When can you pay?\nuser: I will pay through UPI in three days.\nassistant: Noted, thank you.',
    extracted_data: bolna({
      payment_status: 'promised_to_pay',
      promised_pay_date: indiaDate(3),
      payment_mode: 'upi',
      payment_date: '',
      dispute_reason: ''
    })
  },
  callback: {
    status: 'completed',
    transcript: 'assistant: Hello, this is an automated assistant from Biocraft Scientific. Can we talk about the payment?\nuser: I am busy, please call me later.',
    extracted_data: bolna({ payment_status: 'callback_requested', promised_pay_date: '', payment_date: '', payment_mode: '', dispute_reason: '' })
  },
  noanswer: {
    status: 'no-answer',
    extracted_data: {}
  },
  dispute: {
    status: 'completed',
    transcript: 'assistant: Hello, this is an automated assistant from Biocraft Scientific. Has the payment been made?\nuser: The amount on this invoice is wrong.',
    extracted_data: bolna({ payment_status: 'disputed', dispute_reason: 'Customer says the invoice amount is wrong', promised_pay_date: '', payment_date: '', payment_mode: '' })
  }
};

async function main() {
  // Register the fake call on the invoice, the same way a real call request does.
  db.prepare(
    "UPDATE customers_invoices SET last_call_id = ?, payment_status = 'calling', last_call_at = ? WHERE id = ?"
  ).run(callId, new Date().toISOString(), invoice.id);

  const port = process.env.PORT || 3000;
  const base = process.env.APP_URL || ('http://localhost:' + port);
  const token = process.env.WEBHOOK_TOKEN ? '?token=' + encodeURIComponent(process.env.WEBHOOK_TOKEN) : '';

  let response;
  try {
    response = await fetch(base + '/api/bolna-webhook' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: callId, ...PAYLOADS[scenario] })
    });
  } catch (err) {
    console.error('Could not reach the server at ' + base + '. Is "npm start" running?');
    process.exit(1);
  }

  if (!response.ok) {
    console.error('The server answered ' + response.status + ' ' + (await response.text()));
    process.exit(1);
  }

  const after = db.prepare(
    'SELECT payment_status, payment_state, payment_mode, promised_pay_date, payment_date FROM customers_invoices WHERE id = ?'
  ).get(invoice.id);

  console.log('Webhook accepted for invoice #' + invoice.id + ' (call id ' + callId + '). Invoice is now:');
  console.log(JSON.stringify({ ...after }, null, 2));
  console.log('\nOpen the dashboard: the row should have updated by itself.');
}

main();
