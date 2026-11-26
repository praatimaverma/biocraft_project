// Starts a Bolna call. Ported from server.js requestBolnaCall(): same request, same errors; the
// only change is that the invoice is updated in Supabase instead of SQLite and nothing is emitted
// over Socket.IO (the dashboard polls).
'use strict';
const store = require('./store');
const { recordCall } = require('./calllog');
const { buildUserData } = require('./helpers');

function callRequestedRow(inv, executionId, source) {
  return {
    call_id: String(executionId),
    invoice_id: inv.id,
    customer_name: inv.customer_name,
    phone_number: inv.phone_number,
    amount_due: inv.amount_due,
    due_date: inv.due_date,
    trigger_source: source,
    call_status: 'calling',
    called_at: new Date().toISOString()
  };
}

async function requestBolnaCall(inv, source = 'auto') {
  if (!process.env.BOLNA_API_KEY || !process.env.BOLNA_AGENT_ID) {
    const err = new Error('Bolna API key or Agent ID is missing from the backend configuration');
    err.status = 500;
    throw err;
  }
  const body = {
    agent_id: process.env.BOLNA_AGENT_ID,
    recipient_phone_number: inv.phone_number,
    user_data: buildUserData(inv)
  };
  if (process.env.BOLNA_FROM_NUMBER) body.from_phone_number = process.env.BOLNA_FROM_NUMBER;

  const response = await fetch('https://api.bolna.ai/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Bolna error:', data);
    const err = new Error('Bolna rejected the call');
    err.status = 502;
    err.details = data;
    throw err;
  }
  const executionId = data.execution_id || data.id;
  if (!executionId) {
    console.error('Bolna response missing execution ID:', data);
    const err = new Error('Bolna response did not contain an execution ID');
    err.status = 502;
    throw err;
  }

  await store.patchInvoice(inv.id, {
    last_call_id: String(executionId), payment_status: 'calling', last_call_at: new Date().toISOString()
  });
  console.log('Call ID saved:', String(executionId), 'Invoice:', inv.id);
  await recordCall(callRequestedRow(inv, executionId, source));
  return String(executionId);
}

module.exports = { requestBolnaCall };
