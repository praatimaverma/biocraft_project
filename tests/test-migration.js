// Run: node tests/test-migration.js   (uses Node's built-in sqlite + a generic fake PostgREST)
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const T = { tally_invoices: [], call_logs: [], followup_attempts: [] }; let nid = 1000;
const conflict = { tally_invoices: ['invoice_key'], followup_attempts: ['invoice_id', 'attempt_date', 'slot'] };
const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const u = new URL(req.url, 'http://x'); const t = u.pathname.replace('/rest/v1/', ''); const body = b ? JSON.parse(b) : null;
  const filt = (r) => [...u.searchParams].every(([k, v]) => !v.startsWith('eq.') || String(r[k]) === v.slice(3));
  const out = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(o === undefined ? '' : JSON.stringify(o)); };
  if (req.method === 'GET') { const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 1000); return out(200, T[t].filter(filt).slice(off, off + lim)); }
  if (req.method === 'PATCH') { T[t].filter(filt).forEach((r) => Object.assign(r, body)); return out(204); }
  if (req.method === 'POST') { for (const r of body) { const keys = conflict[t]; const ex = T[t].find((x) => keys.every((k) => x[k] === r[k])); if (!ex) T[t].push({ id: nid++, ...r }); } return out(201); }
}); });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')); const file = path.join(dir, 'invoices.db');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE customers_invoices (id INTEGER PRIMARY KEY, customer_name TEXT, phone_number TEXT, amount_due REAL, due_date TEXT, payment_status TEXT, promised_pay_date TEXT, dispute_reason TEXT, last_call_id TEXT, last_transcript TEXT, last_recording TEXT, payment_state TEXT, payment_mode TEXT, last_call_at TEXT, invoice_number TEXT, payment_date TEXT, source TEXT, tally_closed INTEGER, tally_synced_at TEXT);
   CREATE TABLE followup_attempts (id INTEGER PRIMARY KEY, invoice_id INTEGER, attempt_date TEXT, slot TEXT, status TEXT, execution_id TEXT, error_message TEXT, created_at TEXT);
   INSERT INTO customers_invoices VALUES (1,'Sharma Labs','+919876543210',100,'2026-10-05','promised_to_pay','2026-12-01',NULL,'EXEC-1','hello','http://rec/1','pending','UPI',NULL,'BC/101',NULL,'tally',0,NULL),
     (2,'Verma Diag','+919811122233',200,'2026-10-12','pending',NULL,NULL,NULL,NULL,NULL,'pending',NULL,NULL,'BC/117',NULL,'tally',0,NULL),
     (3,'Local Only','N/A',300,'2026-11-01','Payment Done',NULL,NULL,'EXEC-3','t3','http://rec/3','done','Cash',NULL,'INV-1003','2026-11-20',NULL,0,NULL);
   INSERT INTO followup_attempts VALUES (1,1,'2026-11-20','morning','requested','EXEC-1',NULL,'2026-11-20 10:01:00');`);
  d.close();
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); const h0 = hash();

  // Supabase already has Tally rows 1 and 2 under DIFFERENT ids (101,102); call history points at the old SQLite ids.
  T.tally_invoices.push({ id: 101, invoice_key: 'sharma labs|bc/101', customer_name: 'Sharma Labs', invoice_number: 'BC/101', amount_due: 111, payment_status: 'pending', payment_state: 'pending', legacy_sqlite_id: null },
                        { id: 102, invoice_key: 'verma diag|bc/117', customer_name: 'Verma Diag', invoice_number: 'BC/117', amount_due: 222, payment_status: 'pending', payment_state: 'pending', legacy_sqlite_id: null });
  T.call_logs.push({ id: 'a', call_id: 'EXEC-1', invoice_id: 1, legacy_invoice_id: 1 }, { id: 'b', call_id: 'EXEC-3', invoice_id: 3, legacy_invoice_id: 3 });

  await new Promise((r) => server.listen(0, r)); const env = { ...process.env, SUPABASE_URL: `http://localhost:${server.address().port}`, SUPABASE_SERVICE_KEY: 'k' };
  const run = (...a) => new Promise((res) => { const p = spawn(process.execPath, ['--no-warnings', 'migration/migrate-sqlite-to-supabase.js', file, ...a], { env, cwd: path.join(__dirname, '..') }); let o = ''; p.stdout.on('data', (c) => (o += c)); p.stderr.on('data', (c) => (o += c)); p.on('close', (code) => res({ status: code, stdout: o, stderr: '' })); });
  let pass = 0; const ok = (n, f) => { try { f(); pass++; console.log('PASS', n); } catch (e) { console.log('FAIL', n, '-', e.message); process.exitCode = 1; } };

  let r = await run();
  ok('dry run changes nothing', () => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(T.tally_invoices.length, 2); assert.equal(T.tally_invoices[0].legacy_sqlite_id, null); assert.equal(T.followup_attempts.length, 0); });
  r = await run('--apply');
  ok('apply: exit 0 and counts verified', () => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /RESULT: OK/); });
  ok('no duplicates: 2 existing + 1 new = 3 invoices', () => assert.equal(T.tally_invoices.length, 3));
  ok('existing Tally fields NOT overwritten by stale SQLite (amount stays 111)', () => assert.equal(T.tally_invoices[0].amount_due, 111));
  ok('BioCraft-owned fields copied onto existing row', () => { const x = T.tally_invoices[0]; assert.equal(x.payment_status, 'promised_to_pay'); assert.equal(x.promised_pay_date, '2026-12-01'); assert.equal(x.last_call_id, 'EXEC-1'); assert.equal(x.last_transcript, 'hello'); assert.equal(x.legacy_sqlite_id, 1); });
  ok('new invoice carries status/transcript/recording', () => { const x = T.tally_invoices.find((i) => i.legacy_sqlite_id === 3); assert.equal(x.payment_status, 'Payment Done'); assert.equal(x.last_recording, 'http://rec/3'); assert.equal(x.phone_number, null); assert.equal(x.source, 'manual'); });
  ok('call history re-pointed to NEW ids; old id kept for rollback', () => { const a = T.call_logs.find((c) => c.id === 'a'), b = T.call_logs.find((c) => c.id === 'b'); assert.equal(a.invoice_id, 101); assert.equal(a.legacy_invoice_id, 1); assert.equal(b.invoice_id, T.tally_invoices.find((i) => i.legacy_sqlite_id === 3).id); });
  ok('follow-up attempts copied with mapped invoice id', () => { assert.equal(T.followup_attempts.length, 1); assert.equal(T.followup_attempts[0].invoice_id, 101); });
  // Simulate live use afterwards, then re-run: must not overwrite newer data.
  T.tally_invoices[0].payment_status = 'Payment Done';
  r = await run('--apply');
  ok('re-run is idempotent: no new rows, newer data not overwritten', () => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(T.tally_invoices.length, 3); assert.equal(T.tally_invoices[0].payment_status, 'Payment Done'); assert.equal(T.followup_attempts.length, 1); });
  ok('original invoices.db is byte-for-byte unchanged and a backup copy exists', () => { assert.equal(hash(), h0); assert.ok(fs.readdirSync(dir).some((f) => f.includes('.backup-'))); });
  console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
})();
