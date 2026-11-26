#!/usr/bin/env node
// One-time, SAFE migration of the old local database (invoices.db) into Supabase.
//   node migration/migrate-sqlite-to-supabase.js [path/to/invoices.db]            DRY RUN: only reports, changes nothing
//   node migration/migrate-sqlite-to-supabase.js [path/to/invoices.db] --apply    does the migration
//
// Safety rules:
//  * invoices.db is opened READ-ONLY and is never modified or deleted. With --apply a timestamped copy is also made.
//  * Nothing in Supabase is deleted. Invoices already in Supabase only receive BioCraft-owned fields
//    (payment status, promised date, call id, transcript ...) from SQLite, never Tally-owned ones.
//  * Each migrated row remembers its old id (tally_invoices.legacy_sqlite_id); call_logs.legacy_invoice_id
//    keeps the old call -> invoice link, so call history is re-pointed to the new ids and can be rolled back.
//  * Safe to run again: rows that already have a legacy_sqlite_id are skipped (never overwritten).
// Needs: supabase/migrations/001_firebase_backend.sql already run, and SUPABASE_URL / SUPABASE_SERVICE_KEY in the
// environment or in a .env file in the current folder.
'use strict';
const fs = require('fs');
const path = require('path');
const { rest } = require('../tally-agent/tally-sync-core');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbFile = path.resolve(args.find((a) => !a.startsWith('--')) || 'invoices.db');

if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const cfg = {
  url: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
  key: (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
};
const retry = { backoff: [2000, 5000, 15000], log: (m) => console.log('  ' + m) };

function openDb(file) {
  try {
    const D = require('better-sqlite3');
    const d = new D(file, { readonly: true, fileMustExist: true });
    return { all: (sql) => d.prepare(sql).all(), close: () => d.close() };
  } catch (e) {
    const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+
    const d = new DatabaseSync(file, { readOnly: true });
    return { all: (sql) => d.prepare(sql).all(), close: () => d.close() };
  }
}
const clean = (v) => String(v == null ? '' : v).trim();
const keyOf = (name, num) => `${clean(name).toLowerCase()}|${clean(num).toLowerCase()}`;
const isPending = (v) => !v || String(v).toLowerCase() === 'pending';

async function getAll(table, query) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const rows = await rest(cfg, `${table}?${query}&limit=1000&offset=${off}`, {}, retry);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

(async () => {
  if (!fs.existsSync(dbFile)) { console.error(`Cannot find ${dbFile}. Pass the path to invoices.db as the first argument.`); process.exit(1); }
  if (!cfg.url || !cfg.key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (environment or .env).'); process.exit(1); }
  console.log(APPLY ? '*** APPLY MODE ***' : 'DRY RUN (nothing will be changed). Add --apply to migrate.');
  console.log('Source:', dbFile);

  const sdb = openDb(dbFile);
  const invoices = sdb.all('SELECT * FROM customers_invoices ORDER BY id');
  let attempts = [];
  try { attempts = sdb.all('SELECT * FROM followup_attempts ORDER BY id'); } catch (_) { /* table may not exist */ }
  sdb.close();
  console.log(`SQLite: ${invoices.length} invoices, ${attempts.length} follow-up attempts`);

  if (APPLY) {
    const backup = `${dbFile}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(dbFile, backup);
    console.log('Backup copy written:', backup);
  }

  const remote = await getAll('tally_invoices', 'select=*&order=id.asc');
  const byKey = new Map(remote.map((r) => [r.invoice_key, r]));
  const legacyTaken = new Set(remote.filter((r) => r.legacy_sqlite_id != null).map((r) => Number(r.legacy_sqlite_id)));
  console.log(`Supabase tally_invoices BEFORE: ${remote.length} rows`);

  const toInsert = []; const toPatch = []; const skipped = [];
  for (const s of invoices) {
    const key = keyOf(s.customer_name, s.invoice_number || `INV-${1000 + s.id}`);
    const ex = byKey.get(key);
    if (legacyTaken.has(Number(s.id)) || (ex && ex.legacy_sqlite_id != null)) { skipped.push(s.id); continue; }
    const now = new Date().toISOString();
    if (!ex) {
      toInsert.push({
        invoice_key: key, customer_name: clean(s.customer_name), invoice_number: clean(s.invoice_number) || `INV-${1000 + s.id}`,
        phone_number: clean(s.phone_number) && clean(s.phone_number) !== 'N/A' ? clean(s.phone_number) : null,
        amount_due: Number(s.amount_due || 0), due_date: clean(s.due_date) || null,
        payment_status: s.payment_status || 'pending', payment_state: s.payment_state || 'pending',
        payment_mode: s.payment_mode || null, promised_pay_date: s.promised_pay_date || null, payment_date: s.payment_date || null,
        dispute_reason: s.dispute_reason || null, last_call_id: s.last_call_id || null, last_transcript: s.last_transcript || null,
        last_recording: s.last_recording || null, last_call_at: s.last_call_at || null,
        source: s.source || 'manual', tally_closed: !!s.tally_closed, tally_synced_at: s.tally_synced_at || null,
        legacy_sqlite_id: s.id, updated_at: now
      });
    } else {
      // BioCraft-owned fields only. SQLite wins, except that a "pending" in SQLite never hides a real status already in Supabase.
      const body = { legacy_sqlite_id: s.id, updated_at: now };
      for (const f of ['payment_mode', 'promised_pay_date', 'payment_date', 'dispute_reason', 'last_call_id', 'last_transcript', 'last_recording', 'last_call_at']) {
        if (s[f] != null && s[f] !== '') body[f] = s[f];
      }
      for (const f of ['payment_status', 'payment_state']) {
        if (s[f] != null && s[f] !== '' && (!isPending(s[f]) || isPending(ex[f]))) body[f] = s[f];
      }
      toPatch.push({ id: ex.id, body });
    }
  }
  console.log(`Plan: insert ${toInsert.length} new invoices, update ${toPatch.length} existing (owned fields only), skip ${skipped.length} already migrated`);

  const callLogs = await getAll('call_logs', 'select=id,invoice_id,legacy_invoice_id&order=called_at.asc');
  console.log(`Supabase call_logs: ${callLogs.length} rows`);
  console.log(`Plan: ${attempts.length} follow-up attempts to copy (duplicates ignored)`);

  if (!APPLY) { console.log('\nDry run finished. Nothing was changed.'); return; }

  for (let i = 0; i < toInsert.length; i += 200) {
    await rest(cfg, 'tally_invoices?on_conflict=invoice_key', { method: 'POST', body: toInsert.slice(i, i + 200), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }, retry);
  }
  for (const p of toPatch) await rest(cfg, `tally_invoices?id=eq.${p.id}`, { method: 'PATCH', body: p.body, headers: { Prefer: 'return=minimal' } }, retry);

  // legacy id -> new id
  const after = await getAll('tally_invoices', 'select=id,legacy_sqlite_id&order=id.asc');
  const map = new Map(after.filter((r) => r.legacy_sqlite_id != null).map((r) => [Number(r.legacy_sqlite_id), Number(r.id)]));

  // Re-point call history (idempotent: always driven by the immutable legacy_invoice_id)
  const legacyIds = [...new Set(callLogs.map((c) => c.legacy_invoice_id).filter((v) => v != null).map(Number))];
  let repointed = 0; const orphan = [];
  for (const lid of legacyIds) {
    const nid = map.get(lid);
    if (nid == null) { orphan.push(lid); continue; }
    await rest(cfg, `call_logs?legacy_invoice_id=eq.${lid}`, { method: 'PATCH', body: { invoice_id: nid }, headers: { Prefer: 'return=minimal' } }, retry);
    repointed++;
  }

  const rows = attempts.map((a) => ({ invoice_id: map.get(Number(a.invoice_id)), attempt_date: a.attempt_date, slot: a.slot || 'morning',
    status: a.status || 'starting', execution_id: a.execution_id || null, error_message: a.error_message || null, created_at: a.created_at ? new Date(a.created_at.replace(' ', 'T') + (a.created_at.includes('Z') ? '' : 'Z')).toISOString() : undefined }))
    .filter((r) => r.invoice_id != null);
  for (let i = 0; i < rows.length; i += 200) {
    await rest(cfg, 'followup_attempts?on_conflict=invoice_id,attempt_date,slot', { method: 'POST', body: rows.slice(i, i + 200).map((r) => JSON.parse(JSON.stringify(r))), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }, retry);
  }

  // ---- verification ----
  const totalAfter = (await getAll('tally_invoices', 'select=id')).length;
  const migrated = after.filter((r) => r.legacy_sqlite_id != null).length;
  console.log('\nVERIFICATION');
  console.log(`  SQLite invoices ............ ${invoices.length}`);
  console.log(`  Supabase invoices BEFORE ... ${remote.length}`);
  console.log(`  Supabase invoices AFTER .... ${totalAfter}   (expected ${remote.length + toInsert.length})`);
  console.log(`  Linked to an old SQLite id . ${migrated}   (expected ${invoices.length})`);
  console.log(`  Call-history groups re-pointed: ${repointed}${orphan.length ? `, WITHOUT a matching invoice: legacy ids ${orphan.join(', ')}` : ''}`);
  const okAll = totalAfter === remote.length + toInsert.length && migrated === invoices.length && orphan.length === 0;
  console.log(okAll ? '  RESULT: OK - counts match.' : '  RESULT: CHECK THE LINES ABOVE - something does not match. Nothing was deleted; see docs/ROLLBACK.md.');
  process.exit(okAll ? 0 : 2);
})().catch((e) => { console.error('Migration stopped:', e.message, '\nNothing was deleted. It is safe to run again.'); process.exit(1); });
