// End-to-end tests of the Edge Function handler (supabase/functions/api/handler.mjs) running the REAL
// store/supabase/webhook/bolna/followup modules against a local fake of the Supabase REST API, and a
// stubbed Bolna endpoint. NOT covered: real Supabase, real Bolna, real Firebase, the Deno runtime itself.
// Run: node tests/test-edge-api.mjs
import assert from 'node:assert/strict';
import http from 'node:http';

const db = { invoices: [], calls: [], attempts: [], syncLog: [], tallyPosts: [], rpc: [], failAll: false };
const callId36 = '11111111-2222-3333-4444-555555555555';
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace('/rest/v1/', ''); const body = raw ? JSON.parse(raw) : null;
    const send = (code, obj, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.headers.apikey !== 'svc-key' || req.headers.authorization !== 'Bearer svc-key') return send(401, { message: 'bad key' });
    if (db.failAll) return send(db.failAll === true ? 500 : db.failAll, { message: 'db down' });
    const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    if (p === 'tally_invoices' && req.method === 'GET') {
      if (u.searchParams.get('id')) return send(200, db.invoices.filter((i) => String(i.id) === eq('id')));
      const off = Number(u.searchParams.get('offset') || 0); const lim = Number(u.searchParams.get('limit') || 1000);
      return send(200, db.invoices.slice(off, off + lim));
    }
    if (p === 'tally_invoices' && req.method === 'PATCH') {
      const rows = u.searchParams.get('id') ? db.invoices.filter((i) => String(i.id) === eq('id')) : db.invoices.filter((i) => i.last_call_id === eq('last_call_id'));
      rows.forEach((r) => Object.assign(r, body));
      return req.headers.prefer.includes('representation') ? send(200, rows) : send(204);
    }
    if (p === 'tally_invoices' && req.method === 'POST') { db.tallyPosts.push(body); return send(201); }
    if (p === 'rpc/tally_close_missing') { db.rpc.push(body); return send(200, { closed: 0, reopened: 0, skipped_reason: null }); }
    if (p === 'call_logs' && req.method === 'POST') { const i = db.calls.findIndex((c) => c.call_id === body.call_id); if (i >= 0) Object.assign(db.calls[i], body); else db.calls.push({ id: callId36, ...body }); return send(201); }
    if (p === 'call_logs' && req.method === 'GET') {
      if (u.searchParams.get('id')) return send(200, db.calls.filter((c) => c.id === eq('id')));
      return send(200, db.calls, { 'Content-Range': `0-${Math.max(db.calls.length - 1, 0)}/${db.calls.length}` });
    }
    if (p === 'tally_sync_log') return send(200, db.syncLog);
    send(404, { message: 'unhandled ' + req.method + ' ' + p });
  });
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

// Environment (fake values only)
Object.assign(process.env, { SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: 'svc-key', BOLNA_API_KEY: 'bolna-key', BOLNA_AGENT_ID: 'agent-1',
  WEBHOOK_TOKEN: 'wh-token', TALLY_SYNC_TOKEN: 'tally-token', CRON_SECRET: 'cron-secret' });
const bolna = { calls: [], mode: 'ok' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.bolna.ai/')) {
    bolna.calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (bolna.mode === 'reject') return new Response(JSON.stringify({ message: 'bad number' }), { status: 400 });
    if (bolna.mode === 'noid') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ execution_id: 'EXEC-NEW' }), { status: 200 });
  }
  return realFetch(url, init);
};

const { createHandler } = await import('../supabase/functions/api/handler.mjs');
const { runAutomaticFollowups } = await import('../supabase/functions/api/followup.mjs');
let verified = []; let authMode = 'ok';
const verifyIdToken = async (t) => { verified.push(t); if (authMode === 'bad') throw Object.assign(new Error('bad'), { status: 401 }); if (authMode === 'down') throw Object.assign(new Error('down'), { status: 503 }); return { uid: 'u1' }; };
let followupCalls = 0;
const handler = createHandler({ verifyIdToken, runFollowups: async () => { followupCalls++; return { ran: true, action: 'none' }; } });

const ORIGIN = 'https://biocraft-af718.web.app';
const B = 'https://abc.supabase.co/functions/v1/api';
const call = (method, path, { token = 'good', headers = {}, body, origin = ORIGIN, query = '' } = {}) => handler(new Request(B + path + query, {
  method, headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }));
const j = async (r) => JSON.parse(await r.text());
const wrap = (v) => ({ objective: null, confidence: 0.9, subjective: v });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const reset = () => { db.failAll = false; bolna.calls = []; bolna.mode = 'ok'; authMode = 'ok'; verified = [];
  db.calls = []; db.attempts = []; db.tallyPosts = []; db.rpc = [];
  db.invoices = [
    { id: 7, customer_name: 'Verma', phone_number: '+919811122233', amount_due: 500, due_date: '2026-10-01', payment_status: 'pending', payment_state: 'pending', last_call_id: 'EXEC-7', invoice_number: 'INV-7', source: 'tally', tally_closed: false },
    { id: 8, customer_name: 'Paid Co', phone_number: '+91', amount_due: 1, due_date: '2026-10-02', payment_status: 'Payment Done', payment_state: 'done', invoice_number: 'INV-8', source: 'tally' },
    { id: 9, customer_name: 'Later Co', phone_number: '+91', amount_due: 1, due_date: '2026-10-02', payment_status: 'promised_to_pay', promised_pay_date: '2999-01-01', payment_state: 'pending', invoice_number: 'INV-9', source: 'tally' } ];
  db.syncLog = [{ status: 'success', tally_company: 'X' }]; };

let pass = 0; const ok = async (n, f) => { reset(); try { await f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '-', e.stack.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; } };
const silence = (f) => async () => { const l = console.log, w = console.warn, e = console.error; console.log = console.warn = console.error = () => {}; try { await f(); } finally { console.log = l; console.warn = w; console.error = e; } };
const t = (n, f) => ok(n, silence(f));

// ---------- health, CORS, routing ----------
await t('health: 200 {ok:true,time} with no login; also under /api/api/health and bare /health', async () => {
  for (const p of ['/api/health', '/health']) { const r = await call('GET', p, { token: null }); assert.equal(r.status, 200); const b = await j(r); assert.equal(b.ok, true); assert.ok(!Number.isNaN(Date.parse(b.time))); }
  const r = await handler(new Request('https://abc.supabase.co/functions/v1/api/api/health')); assert.equal(r.status, 200); });
await t('CORS preflight: allowed origin -> 204 with allow-origin, authorization header, methods', async () => {
  const r = await call('OPTIONS', '/api/invoices', { token: null, headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(r.headers.get('access-control-allow-headers'), /authorization/i); assert.match(r.headers.get('access-control-allow-methods'), /POST/); assert.equal(verified.length, 0); });
await t('CORS: firebaseapp.com origin allowed; unknown origin gets NO allow-origin header', async () => {
  assert.equal((await call('GET', '/api/health', { token: null, origin: 'https://biocraft-af718.firebaseapp.com' })).headers.get('access-control-allow-origin'), 'https://biocraft-af718.firebaseapp.com');
  assert.equal((await call('OPTIONS', '/api/invoices', { token: null, origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', '/api/health', { token: null, origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null); });
await t('CORS header is also on 401 and error responses (browser can read them)', async () => {
  assert.equal((await call('GET', '/api/invoices', { token: null })).headers.get('access-control-allow-origin'), ORIGIN); });

// ---------- auth: nobody gets data without a valid Firebase token ----------
await t('NO token -> 401 on every protected route (invoices, details, call logs, stats, sync-status, trigger-call, unknown)', async () => {
  const routes = [['GET', '/api/invoices'], ['GET', '/api/invoices/7/details'], ['GET', '/api/call-logs'], ['GET', '/api/call-logs/stats'], ['GET', `/api/call-logs/${callId36}`],
    ['GET', '/api/sync-status'], ['POST', '/api/trigger-call', { invoiceId: 7 }], ['GET', '/api/does-not-exist']];
  for (const [m, p, b] of routes) { const r = await call(m, p, { token: null, body: b }); assert.equal(r.status, 401, m + ' ' + p); assert.equal((await j(r)).error, 'Sign in required'); }
  assert.equal(bolna.calls.length, 0); });
await t('INVALID token -> 401, no data leaked, no Bolna call', async () => {
  authMode = 'bad';
  for (const [m, p, b] of [['GET', '/api/invoices'], ['GET', '/api/call-logs'], ['GET', '/api/call-logs/stats'], ['POST', '/api/trigger-call', { invoiceId: 7 }]]) {
    const r = await call(m, p, { token: 'forged', body: b }); assert.equal(r.status, 401); assert.ok(!(await r.text()).includes('Verma')); }
  assert.equal(bolna.calls.length, 0); assert.equal(db.invoices[0].payment_status, 'pending'); });
await t('auth service unavailable -> 503 (fails closed)', async () => { authMode = 'down'; assert.equal((await call('GET', '/api/invoices')).status, 503); });
await t('non-Bearer Authorization header -> 401', async () => { assert.equal((await call('GET', '/api/invoices', { token: null, headers: { Authorization: 'Basic abc' } })).status, 401); });

// ---------- data routes with a valid token ----------
await t('GET /api/invoices -> dashboard row shape, passes the bearer token to the verifier', async () => {
  const r = await call('GET', '/api/invoices'); assert.equal(r.status, 200); const rows = await j(r); assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['amount_due', 'customer_name', 'due_date', 'dispute_reason', 'id', 'invoice_number', 'last_call_at', 'last_call_id', 'last_recording', 'last_transcript', 'payment_date', 'payment_mode', 'payment_state', 'payment_status', 'phone_number', 'promised_pay_date', 'source', 'tally_closed', 'tally_synced_at'].sort());
  assert.deepEqual(verified, ['good']); });
await t('GET /api/invoices paginates beyond 1000 rows (all 1,200 returned)', async () => {
  db.invoices = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, customer_name: 'C' + i, amount_due: 1, due_date: '2026-10-01' }));
  assert.equal((await j(await call('GET', '/api/invoices'))).length, 1200); });
await t('GET /api/invoices database error -> 502 with message', async () => { db.failAll = true; const r = await call('GET', '/api/invoices'); assert.equal(r.status, 502); assert.match((await j(r)).error, /Could not load invoices/); });
await t('GET /api/invoices/:id/details -> 200 / 400 / 404 / 502', async () => {
  const d = await j(await call('GET', '/api/invoices/7/details')); assert.equal(d.customer_name, 'Verma'); assert.equal(d.last_call_id, 'EXEC-7'); assert.equal('amount_due' in d, false);
  assert.equal((await call('GET', '/api/invoices/abc/details')).status, 400); assert.equal((await call('GET', '/api/invoices/0/details')).status, 400);
  assert.equal((await call('GET', '/api/invoices/999/details')).status, 404);
  db.failAll = true; assert.equal((await call('GET', '/api/invoices/7/details')).status, 502); });
await t('GET /api/call-logs, /stats, /:id, /sync-status work; bad id -> 400; unknown id -> 404; DB error -> 502', async () => {
  db.calls = [{ id: callId36, call_id: 'EXEC-7', outcome: 'promised_to_pay', called_at: new Date().toISOString() }, { id: 'x', call_id: 'E2', call_status: 'no-answer', called_at: '2020-01-01T00:00:00Z' }];
  const l = await j(await call('GET', '/api/call-logs', { query: '?limit=5' })); assert.equal(l.configured, true); assert.equal(l.total, 2); assert.equal(l.rows.length, 2);
  const s = await j(await call('GET', '/api/call-logs/stats')); assert.deepEqual(s, { configured: true, total: 2, today: 1, byOutcome: { promised_to_pay: 1, 'no-answer': 1 } });
  assert.equal((await j(await call('GET', '/api/call-logs/' + callId36))).call_id, 'EXEC-7');
  assert.equal((await call('GET', '/api/call-logs/not-a-uuid')).status, 400); assert.equal((await call('GET', '/api/call-logs/99999999-2222-3333-4444-555555555555')).status, 404);
  assert.equal((await j(await call('GET', '/api/sync-status'))).syncs[0].status, 'success');
  db.failAll = true; for (const p of ['/api/call-logs', '/api/call-logs/stats', '/api/call-logs/' + callId36, '/api/sync-status']) assert.equal((await call('GET', p)).status, 502, p); });
await t('call-logs report configured:false when Supabase env is missing (original behaviour)', async () => {
  const keep = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.deepEqual(await j(await call('GET', '/api/call-logs')), { configured: false, rows: [], total: 0 }); process.env.SUPABASE_SERVICE_ROLE_KEY = keep; });
await t('unknown authenticated route -> 404 JSON', async () => { const r = await call('GET', '/api/nope'); assert.equal(r.status, 404); assert.deepEqual(await j(r), { error: 'Not found' }); });

// ---------- manual Bolna call ----------
await t('POST /api/trigger-call: sends the exact Bolna request, saves call id, writes call log', async () => {
  const r = await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } }); assert.equal(r.status, 200); assert.deepEqual(await j(r), { success: true, callId: 'EXEC-NEW' });
  assert.equal(bolna.calls.length, 1); const c = bolna.calls[0];
  assert.equal(c.url, 'https://api.bolna.ai/call'); assert.equal(c.auth, 'Bearer bolna-key');
  assert.equal(c.body.agent_id, 'agent-1'); assert.equal(c.body.recipient_phone_number, '+919811122233'); assert.equal('from_phone_number' in c.body, false);
  assert.deepEqual(Object.keys(c.body.user_data).sort(), ['amount_due', 'customer_name', 'due_date', 'invoice_id', 'record_id', 'today_date']);
  assert.equal(c.body.user_data.invoice_id, 'INV-7'); assert.equal(c.body.user_data.due_date, '1st October 2026'); assert.equal(c.body.user_data.record_id, '7');
  assert.equal(db.invoices[0].last_call_id, 'EXEC-NEW'); assert.equal(db.invoices[0].payment_status, 'calling');
  assert.equal(db.calls.length, 1); assert.equal(db.calls[0].call_id, 'EXEC-NEW'); assert.equal(db.calls[0].trigger_source, 'manual'); assert.equal(db.calls[0].call_status, 'calling'); });
await t('trigger-call: BOLNA_FROM_NUMBER is forwarded when set', async () => { process.env.BOLNA_FROM_NUMBER = '+911234'; await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } }); delete process.env.BOLNA_FROM_NUMBER; assert.equal(bolna.calls[0].body.from_phone_number, '+911234'); });
await t('trigger-call: already paid -> 409, NO call; future promised date -> 409, NO call; unknown invoice -> 404', async () => {
  assert.equal((await call('POST', '/api/trigger-call', { body: { invoiceId: 8 } })).status, 409);
  const r = await call('POST', '/api/trigger-call', { body: { invoiceId: 9 } }); assert.equal(r.status, 409); assert.match((await j(r)).error, /2999-01-01/);
  assert.equal((await call('POST', '/api/trigger-call', { body: { invoiceId: 12345 } })).status, 404);
  assert.equal(bolna.calls.length, 0); });
await t('trigger-call: Bolna rejects -> 502 with details, invoice NOT marked calling', async () => { bolna.mode = 'reject';
  const r = await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } }); assert.equal(r.status, 502); assert.deepEqual((await j(r)).details, { message: 'bad number' }); assert.equal(db.invoices[0].payment_status, 'pending'); assert.equal(db.calls.length, 0); });
await t('trigger-call: Bolna reply without execution id -> 502; missing Bolna key -> 500 and no outbound request', async () => {
  bolna.mode = 'noid'; assert.equal((await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } })).status, 502);
  bolna.calls = []; const k = process.env.BOLNA_API_KEY; delete process.env.BOLNA_API_KEY; assert.equal((await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } })).status, 500); process.env.BOLNA_API_KEY = k; assert.equal(bolna.calls.length, 0); });
await t('trigger-call: database error -> error status, no Bolna call; invalid JSON body -> 400', async () => {
  db.failAll = true; assert.ok((await call('POST', '/api/trigger-call', { body: { invoiceId: 7 } })).status >= 500); assert.equal(bolna.calls.length, 0); db.failAll = false;
  assert.equal((await call('POST', '/api/trigger-call', { body: '{bad json' })).status, 400); });

// ---------- Bolna webhook ----------
await t('webhook: missing / wrong token -> 401 and database untouched', async () => {
  const body = { id: 'EXEC-7', status: 'completed', extracted_data: { payment_status: wrap('paid') } };
  assert.equal((await call('POST', '/api/bolna-webhook', { token: null, body })).status, 401);
  assert.equal((await call('POST', '/api/bolna-webhook', { token: null, body, query: '?token=wrong' })).status, 401);
  assert.equal(db.invoices[0].payment_status, 'pending'); assert.equal(db.calls.length, 0); });
await t('webhook: WEBHOOK_TOKEN not configured -> 503 (never open)', async () => { const k = process.env.WEBHOOK_TOKEN; delete process.env.WEBHOOK_TOKEN;
  assert.equal((await call('POST', '/api/bolna-webhook', { token: null, body: {}, query: '?token=' })).status, 503); process.env.WEBHOOK_TOKEN = k; });
await t('webhook: valid token + promised_to_pay -> invoice, transcript, recording, call log saved (no Firebase login needed)', async () => {
  const r = await call('POST', '/api/bolna-webhook', { token: null, query: '?token=wh-token', body: { id: 'EXEC-7', status: 'completed', transcript: 'agent: hi\nuser: I will pay by gpay', telephony_data: { recording_url: 'https://rec/7.mp3' },
    extracted_data: { payment_status: wrap('promised_to_pay'), promised_pay_date: wrap('14th October 2026'), dispute_reason: wrap('none') } } });
  assert.equal(r.status, 200); assert.equal(await r.text(), 'OK'); assert.equal(verified.length, 0);
  const i = db.invoices[0]; assert.equal(i.payment_status, 'promised_to_pay'); assert.equal(i.promised_pay_date, '2026-10-14'); assert.equal(i.payment_state, 'pending'); assert.equal(i.payment_mode, 'UPI');
  assert.equal(i.last_recording, 'https://rec/7.mp3'); assert.equal(i.dispute_reason, undefined);
  assert.equal(db.calls.length, 1); assert.equal(db.calls[0].outcome, 'promised_to_pay'); assert.equal(db.calls[0].invoice_id, 7); });
await t('webhook: paid -> "Payment Done"/done; completed without extraction keeps status; unknown id & in-progress ignored with 200', async () => {
  await call('POST', '/api/bolna-webhook', { token: null, query: '?token=wh-token', body: { id: 'EXEC-7', status: 'completed', extracted_data: { payment_status: wrap('paid'), payment_date: wrap('2026-11-20'), payment_mode: wrap('NEFT') } } });
  assert.equal(db.invoices[0].payment_status, 'Payment Done'); assert.equal(db.invoices[0].payment_state, 'done'); assert.equal(db.invoices[0].payment_mode, 'Bank transfer');
  reset(); await call('POST', '/api/bolna-webhook', { token: null, query: '?token=wh-token', body: { id: 'EXEC-7', status: 'completed', transcript: 'x' } }); assert.equal(db.invoices[0].payment_status, 'pending'); assert.equal(db.invoices[0].last_transcript, 'x');
  for (const b of [{ id: 'NOPE', status: 'completed', extracted_data: { payment_status: wrap('paid') } }, { id: 'EXEC-7', status: 'in-progress' }, {}]) assert.equal((await call('POST', '/api/bolna-webhook', { token: null, query: '?token=wh-token', body: b })).status, 200); });
await t('webhook: database error -> 500 so Bolna retries', async () => { db.failAll = true;
  assert.equal((await call('POST', '/api/bolna-webhook', { token: null, query: '?token=wh-token', body: { id: 'EXEC-7', status: 'completed', extracted_data: { payment_status: wrap('paid') } } })).status, 500); });

// ---------- Tally sync push endpoint ----------
await t('tally-sync: no/wrong token -> 401, TALLY_SYNC_TOKEN unset -> 503, bad body -> 400; nothing written', async () => {
  const body = { invoices: [{ customer_name: 'A', invoice_number: '1', amount_due: 5, due_date: '2026-10-01' }] };
  assert.equal((await call('POST', '/api/tally-sync', { token: null, body })).status, 401); assert.equal((await call('POST', '/api/tally-sync', { token: 'wrong', body })).status, 401);
  assert.equal((await call('POST', '/api/tally-sync', { token: 'tally-token', body: { nope: 1 } })).status, 400);
  const k = process.env.TALLY_SYNC_TOKEN; delete process.env.TALLY_SYNC_TOKEN; assert.equal((await call('POST', '/api/tally-sync', { token: 'x', body })).status, 503); process.env.TALLY_SYNC_TOKEN = k;
  assert.equal(db.tallyPosts.length, 0); });
await t('tally-sync: valid token upserts only Tally-owned columns, then calls tally_close_missing; Firebase token NOT accepted here', async () => {
  const body = { company: 'Acme', complete: true, invoices: [{ customer_name: 'A', invoice_number: '1', amount_due: 5, due_date: '2026-10-01', phone_number: '+91', payment_status: 'SHOULD-BE-IGNORED' }] };
  const r = await call('POST', '/api/tally-sync', { token: 'tally-token', body }); assert.equal(r.status, 200); const s = await j(r); assert.equal(s.ok, true); assert.equal(s.written, 1);
  assert.equal(db.tallyPosts.length, 1); assert.equal('payment_status' in db.tallyPosts[0][0], false); assert.equal(db.tallyPosts[0][0].invoice_key, 'a|1'); assert.equal(db.rpc.length, 1);
  assert.equal(verified.length, 0); });
// NOTE: a 5xx from Supabase makes tally-sync-core retry with 2/5/15/30/60 s back-off (~112 s, covered with an injected sleep in test-core.js),
// so this test uses a permanent 400 error, which fails fast.
await t('tally-sync: database error -> 500', async () => { db.failAll = 400; const r = await call('POST', '/api/tally-sync', { token: 'tally-token', body: { invoices: [{ customer_name: 'A', invoice_number: '1', amount_due: 5, due_date: '2026-10-01' }] } }); assert.equal(r.status, 500); });

// ---------- scheduler route ----------
await t('internal/run-followups: wrong/missing secret -> 401, unset -> 503, correct -> runs; Firebase token is not a substitute', async () => {
  assert.equal((await call('POST', '/api/internal/run-followups', { token: 'good' })).status, 401);
  assert.equal((await call('POST', '/api/internal/run-followups', { token: null, headers: { 'x-cron-secret': 'wrong' } })).status, 401); assert.equal(followupCalls, 0);
  assert.equal((await call('POST', '/api/internal/run-followups', { token: null, headers: { 'x-cron-secret': 'cron-secret' } })).status, 200); assert.equal(followupCalls, 1);
  const k = process.env.CRON_SECRET; delete process.env.CRON_SECRET; assert.equal((await call('POST', '/api/internal/run-followups', { token: null, headers: { 'x-cron-secret': '' } })).status, 503); process.env.CRON_SECRET = k; });
await t('internal/run-followups with the REAL scheduler and defaults (no env flags) -> {ran:false, reason:"disabled"}; no Bolna call', async () => {
  const h = createHandler({ verifyIdToken }); delete process.env.AUTO_FOLLOWUP_ENABLED; delete process.env.AUTO_FOLLOWUP_DRY_RUN;
  const r = await h(new Request(B + '/api/internal/run-followups', { method: 'POST', headers: { 'x-cron-secret': 'cron-secret' } })); assert.deepEqual(await j(r), { ran: false, reason: 'disabled' }); assert.equal(bolna.calls.length, 0); });

// ---------- scheduler rules: dry-run and duplicate-call lock (ESM port of the existing tests) ----------
const fakeStore = (() => { const s = { invoices: [], attempts: [] };
  s.listFollowupCandidates = async (d) => s.invoices.filter((i) => i.promised_pay_date && i.promised_pay_date <= d && i.payment_state !== 'done').map((i) => ({ ...i })).sort((a, b) => a.id - b.id);
  s.attemptedInvoiceIds = async (date, slot) => new Set(s.attempts.filter((a) => a.attempt_date === date && a.slot === slot).map((a) => a.invoice_id));
  s.reserveAttempt = async (invoice_id, attempt_date, slot) => { await new Promise((r) => setImmediate(r)); if (s.attempts.some((a) => a.invoice_id === invoice_id && a.attempt_date === attempt_date && a.slot === slot)) return null; const row = { id: s.attempts.length + 1, invoice_id, attempt_date, slot, status: 'starting' }; s.attempts.push(row); return { ...row }; };
  s.updateAttempt = async (id, f) => Object.assign(s.attempts.find((a) => a.id === id), f); return s; })();
const monday10 = { date: '2026-11-23', hour: 10, minute: 5, weekday: 'Mon' };
const mk = (clock, calls) => ({ store: fakeStore, getIndiaTime: () => clock, requestBolnaCall: async (inv) => { calls.push(inv.id); return 'EXEC-' + calls.length; }, log: () => {} });
const seed = () => { fakeStore.attempts = []; fakeStore.invoices = [
  { id: 1, customer_name: 'A', payment_status: 'promised_to_pay', payment_state: 'pending', promised_pay_date: '2026-11-23' },
  { id: 2, customer_name: 'B', payment_status: 'disputed', payment_state: 'pending', promised_pay_date: '2026-11-20' },
  { id: 3, customer_name: 'C', payment_status: 'promised_to_pay', payment_state: 'done', promised_pay_date: '2026-11-20' },
  { id: 4, customer_name: 'D', payment_status: 'promised_to_pay', payment_state: 'pending', promised_pay_date: '2026-12-30' },
  { id: 5, customer_name: 'E', payment_status: 'calling', payment_state: 'pending', promised_pay_date: '2026-11-20', last_call_at: new Date().toISOString() }]; };
await t('scheduler: disabled by default; DRY RUN finds invoice but sends NO call and reserves NO attempt', async () => {
  seed(); delete process.env.AUTO_FOLLOWUP_ENABLED; delete process.env.AUTO_FOLLOWUP_DRY_RUN; const calls = [];
  assert.equal((await runAutomaticFollowups(mk(monday10, calls))).reason, 'disabled');
  process.env.AUTO_FOLLOWUP_DRY_RUN = 'true'; process.env.AUTO_FOLLOWUP_ENABLED = 'true';
  const r = await runAutomaticFollowups(mk(monday10, calls)); assert.equal(r.action, 'dry-run'); assert.equal(r.invoiceId, 1); assert.equal(calls.length, 0); assert.equal(fakeStore.attempts.length, 0);
  process.env.AUTO_FOLLOWUP_ENABLED = 'false'; assert.equal((await runAutomaticFollowups(mk(monday10, calls))).action, 'dry-run'); assert.equal(calls.length, 0); });
await t('scheduler: real mode calls only the eligible invoice, once per slot; evening is a new slot', async () => {
  process.env.AUTO_FOLLOWUP_DRY_RUN = 'false'; process.env.AUTO_FOLLOWUP_ENABLED = 'true'; seed(); let calls = [];
  assert.equal((await runAutomaticFollowups(mk(monday10, calls))).action, 'called'); assert.deepEqual(calls, [1]);
  assert.equal((await runAutomaticFollowups(mk(monday10, calls))).action, 'none'); assert.deepEqual(calls, [1]);
  assert.equal((await runAutomaticFollowups(mk({ ...monday10, hour: 17, minute: 0 }, calls))).action, 'called'); assert.deepEqual(calls, [1, 1]); });
await t('scheduler: 10 CONCURRENT runs -> exactly ONE call (duplicate-call lock)', async () => {
  process.env.AUTO_FOLLOWUP_DRY_RUN = 'false'; process.env.AUTO_FOLLOWUP_ENABLED = 'true'; seed(); const calls = [];
  const res = await Promise.all(Array.from({ length: 10 }, () => runAutomaticFollowups(mk(monday10, calls)))); assert.equal(calls.length, 1); assert.equal(res.filter((x) => x.action === 'lost-race').length, 9); });
await t('scheduler: weekend and out-of-window hours (9, 12, 16, 19) -> no call; 10:00-11:59 and 17:00-18:59 are inside', async () => {
  process.env.AUTO_FOLLOWUP_DRY_RUN = 'false'; process.env.AUTO_FOLLOWUP_ENABLED = 'true'; seed(); const calls = [];
  for (const c of [{ ...monday10, weekday: 'Sat' }, { ...monday10, weekday: 'Sun' }, { ...monday10, hour: 9 }, { ...monday10, hour: 12 }, { ...monday10, hour: 16 }, { ...monday10, hour: 19 }]) await runAutomaticFollowups(mk(c, calls));
  assert.equal(calls.length, 0);
  for (const h of [10, 11, 17, 18]) { seed(); const k = []; assert.equal((await runAutomaticFollowups(mk({ ...monday10, hour: h }, k))).action, 'called', 'hour ' + h); } });
await t('scheduler: Bolna failure recorded and not retried in the same slot; stuck "calling" >90 min is eligible again', async () => {
  process.env.AUTO_FOLLOWUP_DRY_RUN = 'false'; process.env.AUTO_FOLLOWUP_ENABLED = 'true'; seed();
  const r = await runAutomaticFollowups({ ...mk(monday10, []), requestBolnaCall: async () => { throw new Error('Bolna rejected the call'); } }); assert.equal(r.action, 'failed'); assert.equal(fakeStore.attempts[0].status, 'failed');
  const calls = []; assert.equal((await runAutomaticFollowups(mk(monday10, calls))).action, 'none');
  seed(); fakeStore.invoices[4].last_call_at = new Date(Date.now() - 100 * 60000).toISOString(); fakeStore.invoices[0].payment_state = 'done'; await runAutomaticFollowups(mk(monday10, calls)); assert.deepEqual(calls, [5]); });

console.log(`\n${pass} passed`); globalThis.fetch = realFetch; server.close(); process.exit(process.exitCode || 0);
