// Tests webhook + follow-up scheduler + duplicate-call lock using an in-memory fake of lib/store.js.
// (Express wiring and the Firebase emulator are NOT covered here: express/firebase packages cannot be installed offline.)
// Run: node tests/test-functions.js
const assert = require('assert');
const path = require('path');
const F = path.join(__dirname, '..', 'functions', 'lib');

// ---- in-memory fake store + fake call log, injected through require.cache ----
const db = { invoices: [], attempts: [], calls: [] };
const fakeStore = {
  async patchInvoiceByCallId(callId, f) { const rows = db.invoices.filter((i) => i.last_call_id === callId); rows.forEach((r) => Object.assign(r, f)); return rows.map((r) => ({ ...r })); },
  async patchInvoice(id, f) { Object.assign(db.invoices.find((i) => i.id === id), f); },
  async listFollowupCandidates(today) { return db.invoices.filter((i) => i.promised_pay_date && i.promised_pay_date <= today && i.payment_state !== 'done').map((i) => ({ ...i })).sort((a, b) => a.id - b.id); },
  async attemptedInvoiceIds(date, slot) { return new Set(db.attempts.filter((a) => a.attempt_date === date && a.slot === slot).map((a) => a.invoice_id)); },
  async reserveAttempt(invoice_id, attempt_date, slot) {   // mimics UNIQUE(invoice_id, attempt_date, slot) + ON CONFLICT DO NOTHING (atomic)
    await new Promise((r) => setImmediate(r));
    if (db.attempts.some((a) => a.invoice_id === invoice_id && a.attempt_date === attempt_date && a.slot === slot)) return null;
    const row = { id: db.attempts.length + 1, invoice_id, attempt_date, slot, status: 'starting' }; db.attempts.push(row); return { ...row };
  },
  async updateAttempt(id, f) { Object.assign(db.attempts.find((a) => a.id === id), f); }
};
require.cache[require.resolve(F + '/store.js')] = { id: 'store', filename: F + '/store.js', loaded: true, exports: fakeStore };
require.cache[require.resolve(F + '/calllog.js')] = { id: 'calllog', filename: F + '/calllog.js', loaded: true, exports: { async recordCall(r) { db.calls.push(r); return true; } } };

const { handleBolnaWebhook } = require(F + '/webhook.js');
const { runAutomaticFollowups } = require(F + '/followup.js');

let pass = 0; const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.stack.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; } };
const reset = () => { db.invoices = [{ id: 7, customer_name: 'Verma', phone_number: '+919811122233', amount_due: 500, due_date: '2026-10-01', payment_status: 'calling', payment_state: 'pending', last_call_id: 'EXEC-7', promised_pay_date: null }]; db.attempts = []; db.calls = []; };
const wrap = (v) => ({ objective: null, confidence: 0.9, subjective: v });

(async () => {
  process.env.WEBHOOK_TOKEN = 'secret-token';

  await ok('webhook: missing/wrong token -> 401', async () => { reset();
    assert.equal((await handleBolnaWebhook({ query: {}, body: {} })).code, 401);
    assert.equal((await handleBolnaWebhook({ query: { token: 'nope' }, body: {} })).code, 401); });
  await ok('webhook: token not configured -> 503 (never open)', async () => { const t = process.env.WEBHOOK_TOKEN; delete process.env.WEBHOOK_TOKEN;
    assert.equal((await handleBolnaWebhook({ query: { token: 'x' }, body: {} })).code, 503); process.env.WEBHOOK_TOKEN = t; });
  await ok('webhook: promised_to_pay updates the right invoice + saves transcript & recording', async () => { reset();
    const r = await handleBolnaWebhook({ query: { token: 'secret-token' }, body: { id: 'EXEC-7', status: 'completed', transcript: 'agent: hi\nuser: I will pay by gpay', telephony_data: { recording_url: 'https://rec/7.mp3' },
      extracted_data: { payment_status: wrap('promised_to_pay'), promised_pay_date: wrap('14th October 2026'), dispute_reason: wrap('none') } } });
    assert.equal(r.code, 200); const i = db.invoices[0];
    assert.equal(i.payment_status, 'promised_to_pay'); assert.equal(i.promised_pay_date, '2026-10-14'); assert.equal(i.payment_state, 'pending');
    assert.equal(i.payment_mode, 'UPI'); assert.equal(i.last_recording, 'https://rec/7.mp3'); assert.match(i.last_transcript, /gpay/); assert.equal(i.dispute_reason, undefined);
    assert.equal(db.calls.length, 1); assert.equal(db.calls[0].invoice_id, 7); assert.equal(db.calls[0].outcome, 'promised_to_pay'); });
  await ok('webhook: paid -> Payment Done / state done / payment_date', async () => { reset();
    await handleBolnaWebhook({ query: { token: 'secret-token' }, body: { id: 'EXEC-7', status: 'completed', extracted_data: { payment_status: wrap('paid'), payment_date: wrap('2026-11-20'), payment_mode: wrap('NEFT') } } });
    const i = db.invoices[0]; assert.equal(i.payment_status, 'Payment Done'); assert.equal(i.payment_state, 'done'); assert.equal(i.payment_date, '2026-11-20'); assert.equal(i.payment_mode, 'Bank transfer'); });
  await ok('webhook: completed WITHOUT extraction keeps old status, saves transcript only', async () => { reset();
    await handleBolnaWebhook({ query: { token: 'secret-token' }, body: { id: 'EXEC-7', status: 'completed', transcript: 'x' } });
    const i = db.invoices[0]; assert.equal(i.payment_status, 'calling'); assert.equal(i.last_transcript, 'x'); assert.equal(db.calls[0].outcome, undefined); });
  await ok('webhook: unknown call id is ignored safely (200)', async () => { reset();
    const r = await handleBolnaWebhook({ query: { token: 'secret-token' }, body: { id: 'NOPE', status: 'completed', extracted_data: { payment_status: wrap('paid') } } });
    assert.equal(r.code, 200); assert.equal(db.invoices[0].payment_status, 'calling'); assert.equal(db.calls.length, 0); });
  await ok('webhook: in-progress status ignored', async () => { reset();
    await handleBolnaWebhook({ query: { token: 'secret-token' }, body: { id: 'EXEC-7', status: 'in-progress' } }); assert.equal(db.invoices[0].payment_status, 'calling'); });

  // ---- follow-up scheduler ----
  const monday10am = { date: '2026-11-23', hour: 10, minute: 5, weekday: 'Mon' };
  const mk = (clock, calls) => ({ getIndiaTime: () => clock, requestBolnaCall: async (inv) => { calls.push(inv.id); return 'EXEC-NEW-' + calls.length; }, log: () => {} });
  const seed = () => { reset(); db.invoices = [
    { id: 1, customer_name: 'A', phone_number: '+91', amount_due: 1, due_date: '2026-10-01', payment_status: 'promised_to_pay', payment_state: 'pending', promised_pay_date: '2026-11-23' },
    { id: 2, customer_name: 'B', phone_number: '+91', amount_due: 1, due_date: '2026-10-01', payment_status: 'disputed', payment_state: 'pending', promised_pay_date: '2026-11-20' },
    { id: 3, customer_name: 'C', phone_number: '+91', amount_due: 1, due_date: '2026-10-01', payment_status: 'promised_to_pay', payment_state: 'done', promised_pay_date: '2026-11-20' },
    { id: 4, customer_name: 'D', phone_number: '+91', amount_due: 1, due_date: '2026-10-01', payment_status: 'promised_to_pay', payment_state: 'pending', promised_pay_date: '2026-12-30' },
    { id: 5, customer_name: 'E', phone_number: '+91', amount_due: 1, due_date: '2026-10-01', payment_status: 'calling', payment_state: 'pending', promised_pay_date: '2026-11-20', last_call_at: new Date().toISOString() } ]; };

  await ok('scheduler: disabled by default -> does nothing', async () => { seed(); delete process.env.AUTO_FOLLOWUP_ENABLED; delete process.env.AUTO_FOLLOWUP_DRY_RUN; const calls = [];
    assert.equal((await runAutomaticFollowups(mk(monday10am, calls))).reason, 'disabled'); assert.equal(calls.length, 0); });
  await ok('scheduler DRY RUN: finds the invoice but sends NO call and reserves nothing', async () => { seed(); process.env.AUTO_FOLLOWUP_DRY_RUN = 'true'; process.env.AUTO_FOLLOWUP_ENABLED = 'true'; const calls = [];
    const r = await runAutomaticFollowups(mk(monday10am, calls)); assert.equal(r.action, 'dry-run'); assert.equal(r.invoiceId, 1); assert.equal(calls.length, 0); assert.equal(db.attempts.length, 0); });

  process.env.AUTO_FOLLOWUP_DRY_RUN = 'false'; process.env.AUTO_FOLLOWUP_ENABLED = 'true';
  await ok('scheduler: skips disputed / done / future-promise / freshly-calling invoices; calls only #1', async () => { seed(); const calls = [];
    const r = await runAutomaticFollowups(mk(monday10am, calls)); assert.equal(r.action, 'called'); assert.deepEqual(calls, [1]); assert.equal(db.attempts[0].status, 'requested'); assert.equal(db.attempts[0].slot, 'morning'); });
  await ok('scheduler: same slot again -> no second call for invoice 1', async () => { const calls = [];
    const r = await runAutomaticFollowups(mk(monday10am, calls)); assert.equal(r.action, 'none'); assert.equal(calls.length, 0); });
  await ok('scheduler: evening slot is a new attempt (5 PM) and calls invoice 1 again', async () => { const calls = [];
    const r = await runAutomaticFollowups(mk({ ...monday10am, hour: 17, minute: 0 }, calls)); assert.equal(r.action, 'called'); assert.deepEqual(calls, [1]); assert.equal(db.attempts.at(-1).slot, 'evening'); });
  await ok('scheduler: 10 CONCURRENT instances -> exactly ONE call for the invoice+slot', async () => { seed(); const calls = [];
    const results = await Promise.all(Array.from({ length: 10 }, () => runAutomaticFollowups(mk(monday10am, calls))));
    assert.equal(calls.length, 1, 'calls placed: ' + calls.length); assert.equal(results.filter((x) => x.action === 'called').length, 1); assert.equal(results.filter((x) => x.action === 'lost-race').length, 9); });
  await ok('scheduler: weekend and outside windows (9 AM, 12 noon, 4 PM, 7 PM) -> nothing', async () => { seed(); const calls = [];
    for (const c of [{ ...monday10am, weekday: 'Sat' }, { ...monday10am, weekday: 'Sun' }, { ...monday10am, hour: 9 }, { ...monday10am, hour: 12 }, { ...monday10am, hour: 16 }, { ...monday10am, hour: 19 }]) await runAutomaticFollowups(mk(c, calls));
    assert.equal(calls.length, 0); });
  await ok('scheduler: stuck "calling" (>90 min) invoice becomes eligible again', async () => { seed(); db.invoices[4].last_call_at = new Date(Date.now() - 100 * 60000).toISOString(); db.invoices[0].payment_state = 'done'; const calls = [];
    await runAutomaticFollowups(mk(monday10am, calls)); assert.deepEqual(calls, [5]); });
  await ok('scheduler: Bolna failure is recorded and NOT retried in the same slot', async () => { seed(); const calls = [];
    const failing = { getIndiaTime: () => monday10am, log: () => {}, requestBolnaCall: async () => { throw new Error('Bolna rejected the call'); } };
    const r = await runAutomaticFollowups(failing); assert.equal(r.action, 'failed'); assert.equal(db.attempts[0].status, 'failed');
    assert.equal((await runAutomaticFollowups(mk(monday10am, calls))).action, 'none'); assert.equal(calls.length, 0); });

  console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
})();
