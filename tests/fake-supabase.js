// Minimal in-memory imitation of the Supabase REST endpoints the agent uses. FOR TESTS ONLY.
// The close/reopen logic below mirrors supabase/migrations/001_firebase_backend.sql
// (the real SQL itself is NOT executed by these tests).
const http = require('http');
function create() {
  const st = { invoices: new Map(), syncLog: [], audit: [], nextId: 1, post: 0, failPosts: new Set(), failAlways: false, rpcCalls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname.replace('/rest/v1/', '');
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.headers.apikey !== 'test-key') return send(401, { message: 'bad key' });
      const json = body ? JSON.parse(body) : null;
      if (p === 'tally_invoices' && req.method === 'POST') {
        st.post++;
        if (st.failAlways || st.failPosts.has(st.post)) return send(503, { message: 'unavailable' });
        for (const r of json) {
          const ex = st.invoices.get(r.invoice_key);
          if (ex) Object.assign(ex, r);
          else st.invoices.set(r.invoice_key, { id: st.nextId++, payment_status: 'pending', payment_state: 'pending', tally_closed: false, phone_number: null, ...r });
        }
        return send(201);
      }
      if (p === 'rpc/tally_close_missing') {
        st.rpcCalls.push(json);
        const { p_batch, p_force, p_reopen_only } = json;
        const all = [...st.invoices.values()];
        if (!all.some((r) => r.sync_batch_id === p_batch)) return send(200, { closed: 0, reopened: 0, skipped_reason: 'batch has no invoices' });
        let reopened = 0;
        for (const r of all) if (r.sync_batch_id === p_batch && r.tally_closed) { r.tally_closed = false; r.payment_state = 'pending'; r.payment_status = 'pending'; reopened++; }
        if (p_reopen_only) return send(200, { closed: 0, reopened, skipped_reason: 'snapshot not complete; reopen only' });
        const open = all.filter((r) => r.source === 'tally' && !r.tally_closed && r.payment_state !== 'done');
        const gone = open.filter((r) => r.sync_batch_id !== p_batch);
        if (!p_force && gone.length > Math.max(5, Math.floor(open.length * 0.5))) return send(200, { closed: 0, reopened, skipped_reason: `would mark ${gone.length} of ${open.length} open invoices as paid; looks wrong` });
        for (const r of gone) { st.audit.push(r.invoice_key); r.payment_state = 'done'; r.tally_closed = true; if (!['paid', 'paid_on_call', 'payment done', 'payment_done'].includes(String(r.payment_status).toLowerCase())) r.payment_status = 'paid'; }
        return send(200, { closed: gone.length, reopened, skipped_reason: null });
      }
      if (p === 'tally_sync_log' && req.method === 'POST') { st.syncLog.push({ ...json }); return send(201); }
      if (p === 'tally_sync_log' && req.method === 'PATCH') { const id = u.searchParams.get('batch_id').replace('eq.', ''); Object.assign(st.syncLog.find((l) => l.batch_id === id) || {}, json); return send(204); }
      if (p.startsWith('tally_sync_log') && req.method === 'GET') return send(200, [...st.syncLog].reverse());
      send(404, { message: 'not found ' + p });
    });
  });
  return { st, server, listen: () => new Promise((r) => server.listen(0, () => r(server.address().port))), close: () => server.close() };
}
module.exports = { create };
