#!/usr/bin/env node
// Shows the most recent Tally syncs recorded in Supabase.  node check-last-sync.js
// Exit code 0 = last successful sync is recent (under 20 hours), 1 = problem.
const fs = require('fs');
const path = require('path');
const { rest } = require('./tally-sync-core');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const ist = (iso) => iso ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso)) + ' IST' : '-';
const cfg = {
  url: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
  key: (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
};

(async () => {
  try {
    const rows = await rest(cfg, 'tally_sync_log?select=started_at,finished_at,status,trigger,invoices_received,invoices_written,invoices_closed,invoices_reopened,error&order=started_at.desc&limit=6', {}, { backoff: [2000] });
    console.log('Most recent syncs (newest first):');
    for (const r of rows) {
      console.log(` ${ist(r.started_at)}  ${String(r.status).toUpperCase().padEnd(8)} ${String(r.trigger || '').padEnd(9)} ` +
        `received ${r.invoices_received ?? '-'}, written ${r.invoices_written ?? '-'}, closed ${r.invoices_closed ?? '-'}` + (r.error ? `  ERROR: ${r.error}` : ''));
    }
    const ok = rows.find((r) => r.status === 'success' || r.status === 'warning');
    if (!ok) { console.log('\nNo successful sync recorded yet.'); process.exit(1); }
    const hours = (Date.now() - new Date(ok.finished_at || ok.started_at)) / 3600000;
    console.log(`\nLast successful sync: ${ist(ok.finished_at || ok.started_at)} (${hours.toFixed(1)} hours ago)`);
    if (hours > 20) { console.log('WARNING: older than 20 hours. A scheduled run was probably missed.'); process.exit(1); }
  } catch (err) {
    console.error('Could not read Supabase: ' + err.message);
    try { console.log('Local record of the last run on this computer:\n' + fs.readFileSync(path.join(__dirname, 'last-sync.json'), 'utf8')); } catch (_) { /* none */ }
    process.exit(1);
  }
})();
