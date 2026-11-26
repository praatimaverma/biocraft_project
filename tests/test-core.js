// Run: node tests/test-core.js
const assert = require('assert');
const { uploadSnapshot, PartialUploadError } = require('../tally-agent/tally-sync-core');
const { create } = require('./fake-supabase');
let pass = 0; const ok = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };
const inv = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ customer_name: `Cust ${i}`, invoice_number: `INV/${i}`, amount_due: 100 + i, due_date: '2026-12-01', phone_number: '', ...extra }));
const fast = { backoff: [1, 1, 1], sleep: async () => {} };

(async () => {
  const fake = create(); const port = await fake.listen();
  const cfg = { url: `http://localhost:${port}`, key: 'test-key' };

  await ok('temporary 503s are retried and the run still succeeds', async () => {
    fake.st.failPosts = new Set([1, 2]); fake.st.post = 0;
    const s = await uploadSnapshot(cfg, inv(10), { ...fast });
    assert.equal(s.written, 10); assert.equal(fake.st.invoices.size, 10);
  });

  await ok('1200 invoices -> 3 chunks, all stored, no duplicates on repeat', async () => {
    await uploadSnapshot(cfg, inv(1200), { ...fast }); await uploadSnapshot(cfg, inv(1200), { ...fast });
    assert.equal(fake.st.invoices.size, 1200);
  });

  await ok('PARTIAL upload throws, is NOT success, and closes nothing', async () => {
    const f2 = create(); const p2 = await f2.listen(); const c2 = { url: `http://localhost:${p2}`, key: 'test-key' };
    await uploadSnapshot(c2, inv(1200), { ...fast });                  // 1200 open invoices
    f2.st.rpcCalls.length = 0; f2.st.post = 0; f2.st.failPosts = new Set([2, 3, 4, 5, 6, 7, 8, 9]);  // chunk 2 keeps failing
    await assert.rejects(() => uploadSnapshot(c2, inv(1100), { ...fast }), PartialUploadError);
    assert.equal(f2.st.rpcCalls.length, 0, 'close step must not run after a partial upload');
    assert.equal([...f2.st.invoices.values()].filter((r) => r.tally_closed).length, 0);
    f2.close();
  });

  await ok('bulk-close guard: dropping >50% of open invoices closes nothing unless forced', async () => {
    const f3 = create(); const p3 = await f3.listen(); const c3 = { url: `http://localhost:${p3}`, key: 'test-key' };
    await uploadSnapshot(c3, inv(20), { ...fast });
    const s = await uploadSnapshot(c3, inv(2), { ...fast });
    assert.equal(s.closed, 0); assert.match(s.closeSkippedReason, /looks wrong/);
    const s2 = await uploadSnapshot(c3, inv(2), { ...fast, force: true });
    assert.equal(s2.closed, 18); f3.close();
  });

  await ok('incomplete / invalid rows -> no closing, reason reported', async () => {
    const f4 = create(); const p4 = await f4.listen(); const c4 = { url: `http://localhost:${p4}`, key: 'test-key' };
    await uploadSnapshot(c4, inv(10), { ...fast });
    const bad = inv(3).concat([{ customer_name: '', invoice_number: 'X', amount_due: 5, due_date: '2026-01-01' }]);
    const s = await uploadSnapshot(c4, bad, { ...fast });
    assert.equal(s.dropped, 1); assert.equal(s.closed, 0); assert.match(s.closeSkippedReason, /failed validation/);
    f4.close();
  });

  await ok('empty phone from Tally never erases an existing phone number', async () => {
    const f5 = create(); const p5 = await f5.listen(); const c5 = { url: `http://localhost:${p5}`, key: 'test-key' };
    await uploadSnapshot(c5, inv(1, { phone_number: '+919876543210' }), { ...fast });
    await uploadSnapshot(c5, inv(1, { phone_number: '' }), { ...fast });
    assert.equal([...f5.st.invoices.values()][0].phone_number, '+919876543210'); f5.close();
  });

  await ok('permanent error (bad key) fails fast without retries', async () => {
    let slept = 0;
    await assert.rejects(() => uploadSnapshot({ url: cfg.url, key: 'WRONG' }, inv(2), { backoff: [1, 1, 1], sleep: async () => { slept++; } }), PartialUploadError);
    assert.equal(slept, 0);
  });

  fake.close(); console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
})();
