// End-to-end: mock Tally (HTTP) -> real agent.js -> fake Supabase. Run: node tests/test-agent.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { create } = require('./fake-supabase');

const AGENT = path.join(__dirname, '..', 'tally-agent');
const run = (env, extra = []) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['agent.js', ...extra], { cwd: AGENT, env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
let pass = 0; const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };

(async () => {
  const fake = create(); const sbPort = await fake.listen();
  const tally = spawn(process.execPath, [path.join(__dirname, 'mock-tally.js'), '9311'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const env = { TALLY_URL: 'http://localhost:9311', SUPABASE_URL: `http://localhost:${sbPort}`, SUPABASE_SERVICE_KEY: 'test-key', TALLY_COMPANY: 'Test Co' };
  for (const f of ['sync.log', 'last-sync.json']) { try { fs.unlinkSync(path.join(AGENT, f)); } catch (_) {} }

  let r = await run(env, ['--test']);
  ok('--test reads Tally, sends nothing', () => { assert.equal(r.code, 0); assert.equal(fake.st.invoices.size, 0); assert.match(r.out, /3 outstanding invoices/); });

  r = await run(env, ['--scheduled']);
  ok('first sync: exit 0, 3 invoices (credit/advance row skipped)', () => { assert.equal(r.code, 0, r.out); assert.equal(fake.st.invoices.size, 3); });
  ok('sync log row = success with counts', () => { const l = fake.st.syncLog[0]; assert.equal(l.status, 'success'); assert.equal(l.invoices_written, 3); assert.equal(l.trigger, 'scheduled'); });
  ok('phone numbers saved', () => { assert.equal(fake.st.invoices.get('sharma labs & co|bc/24-25/101').phone_number, '+919876543210'); });
  ok('amount parsed (Indian format)', () => { assert.equal(fake.st.invoices.get('verma diagnostics|bc/24-25/117').amount_due, 120450.5); });

  // Simulate BioCraft/Bolna having updated one invoice, then sync again.
  const v = fake.st.invoices.get('verma diagnostics|bc/24-25/117');
  Object.assign(v, { payment_status: 'promised_to_pay', promised_pay_date: '2026-12-01', last_call_id: 'EXEC-1', last_transcript: 'hello', last_recording: 'http://rec', dispute_reason: null, payment_mode: 'UPI' });
  const before = JSON.stringify({ ...v, tally_synced_at: 0, tally_synced_at_ist: 0, sync_batch_id: 0, updated_at: 0 });
  r = await run(env);
  ok('repeat sync creates NO duplicates', () => { assert.equal(r.code, 0); assert.equal(fake.st.invoices.size, 3); });
  ok('repeat sync keeps call/payment fields intact', () => { const after = JSON.stringify({ ...fake.st.invoices.get('verma diagnostics|bc/24-25/117'), tally_synced_at: 0, tally_synced_at_ist: 0, sync_batch_id: 0, updated_at: 0 }); assert.equal(after, before); });
  ok('rows from one run share one batch id', () => { const ids = new Set([...fake.st.invoices.values()].map((x) => x.sync_batch_id)); assert.equal(ids.size, 1); });

  // Temporary outage: 1st and 2nd POST fail with 503, then succeed (core retries; agent uses real waits, so test the core separately for speed)
  // Customer pays in Tally: Gupta disappears from the export.
  tally.kill(); const tally2 = spawn(process.execPath, [path.join(__dirname, 'mock-tally.js'), '9311'], { stdio: 'ignore', env: { ...process.env, MOCK_DROP: '1' } });
  await new Promise((r) => setTimeout(r, 600));
  r = await run(env);
  ok('invoice missing from complete export is closed (audited), not deleted', () => {
    const g = fake.st.invoices.get('gupta research pvt ltd|bc/24-25/130');
    assert.ok(g, 'row must still exist'); assert.equal(g.tally_closed, true); assert.equal(g.payment_state, 'done'); assert.equal(g.payment_status, 'paid');
    assert.deepEqual(fake.st.audit, ['gupta research pvt ltd|bc/24-25/130']);
    assert.equal(fake.st.syncLog.at(-1).invoices_closed, 1);
  });
  tally2.kill();

  // Tally down: failure is logged, Supabase untouched, non-zero exit
  const sizeBefore = JSON.stringify([...fake.st.invoices.values()]);
  r = await run({ ...env, TALLY_URL: 'http://localhost:9' }, []);
  // (this run waits for Tally retries; skip waiting by killing long runs is not needed: retries only for 'Could not reach')
  ok('Tally unreachable -> exit 2, data untouched, failure logged', () => { assert.equal(r.code, 2); assert.equal(JSON.stringify([...fake.st.invoices.values()]), sizeBefore); assert.equal(fake.st.syncLog.at(-1).status, 'failed'); });

  fake.close(); console.log(`\n${pass} passed`);
})();
