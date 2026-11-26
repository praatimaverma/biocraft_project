# Change report

## 1. Files modified (4 – everything else in your ZIP is byte-for-byte unchanged)
| File | Change | Why |
|---|---|---|
| `public/index.html` (served by Hosting) and `index.html` (root copy) | Removed the `socket.io.js` script tag; replaced the Socket.IO connection with a 30-second poll that drives the same "Live / Reconnecting…" indicator; refresh after a manual call request. No UI, CSS or login change. | Firebase Functions cannot keep Socket.IO connections open. |
| `firebase.json` | Added the `/api/**` → function `api` rewrite and the `functions` block. | The old file only hosted static files, so `/api/*` calls on the live site could not reach any backend. (`FIREBASE_AUTH_DEPLOYMENT.txt` described Cloud Run rewrites, but they were not actually in `firebase.json`.) |
| `.gitignore` | Added ignore lines for new secret/log files. | Safety. |

## 2. Files added
* `functions/` – Firebase backend: `index.js`, `package.json`, `.env.example`, `lib/app.js` (all endpoints), `lib/store.js` (Supabase invoice access), `lib/webhook.js`, `lib/followup.js`, `lib/bolna.js`, `lib/calllog.js`, `lib/helpers.js` (Bolna parsing code copied verbatim from `server.js`), `lib/supabase.js` (copy of root file + `request` exported), `lib/tally-sync-core.js`.
* `tally-agent/` – the Windows agent: `agent.js`, `tally-client.js` (unchanged copy), `tally-sync-core.js`, `check-last-sync.js`, `install-schedule.ps1/.bat`, `uninstall-schedule.ps1`, `run-sync-now.bat`, `run-check-last-sync.bat`, `run-test-tally.bat`, `.env.example`.
* `supabase/migrations/001_firebase_backend.sql`, `migration/migrate-sqlite-to-supabase.js`, `migration/rollback-call-links.sql`.
* `tests/`, `docs/`, `START_HERE.md`.

Old root files (`server.js`, `db.js`, `calllog.js`, `tallyImport.js`, `agent.js`, `Dockerfile`, …) are kept untouched as the original/backup implementation. The cloud backend does not use them.

## 3. Existing features preserved
Login (Firebase Auth, unchanged), invoice list/details, manual **Call** button with its checks (already-paid, future promised date), Bolna request format, webhook parsing rules (copied verbatim), payment state/mode/promised-date/payment-date/dispute/transcript/recording handling,
call history + stats endpoints, `/api/tally-sync` push endpoint, follow-up rules (Mon–Fri; 10:00–12:00 and 17:00–19:00 IST; one attempt per invoice per slot; skips done/disputed/refused/wrong number/human review; stuck-call retry after 90 min; one invoice per tick; dry-run).

## 4. Behaviour changes you should know about (all required by the move to serverless or by your security rules)
1. **No SQLite in the cloud.** Invoice IDs on the dashboard are now Supabase `tally_invoices.id`. The migration maps old IDs and re-points `call_logs.invoice_id` (old value kept in `legacy_invoice_id`).
2. **Dashboard updates by 30-second polling** instead of Socket.IO push.
3. **Follow-up scheduler** is a Cloud Scheduler job (every minute inside the two windows, Mon–Fri IST) instead of an in-process timer. The duplicate-call lock is the database `UNIQUE(invoice_id, attempt_date, slot)` insert.
4. **Bolna webhook token is now mandatory** (before: if `WEBHOOK_TOKEN` was unset the endpoint was open). Update the Bolna webhook URL to include `?token=`.
5. **Revoked/disabled employees are rejected immediately** (token is checked for revocation).
6. **Failed call-log writes** are retried 3× and then written to the Cloud Logging error log (the SQLite retry queue cannot exist on serverless).
7. CORS is limited to your two Firebase domains (override with `CORS_ORIGINS`).

## 5. How Tally sync works
Agent → Tally (XML on port 9000, "Bills Receivable" + ledger phones) → validate → upload to `tally_invoices` in chunks of 500 with one `sync_batch_id` (upsert on `invoice_key`) → only if everything uploaded and the export was complete, database function `tally_close_missing` reopens returned invoices and closes vanished ones (audited, guarded) → result written to `tally_sync_log`. Details and safety rules: `docs/CLIENT_SERVER_INSTALL.md`.
Schedules: two independent Windows tasks, 08:00 and 15:00 IST. (Tally sync ≠ follow-up calls; the follow-up windows 10:00–12:00 / 17:00–19:00 are separate and unchanged.)

## 6. Findings in your original ZIP (fixed or flagged)
* `supabase.js` reads/writes columns `tally_synced_at_ist`, `sync_batch_id` and calls `rpc/cleanup_old_tally_invoices`, none of which existed in `supabase_schema.sql` (a fresh database would break invoice listing). The migration adds the columns. I did **not** create the cleanup function (its name implies deleting; nothing calls it).
* `scripts/sync-tally.js` requires `../tally-agent/tally-client`, but the `tally-agent` folder was missing from the ZIP (flattened into the root). `tally-agent/` now exists.
* The old agent only upserted; it never closed invoices paid in Tally, and sent `tally_closed:false` every run. Replaced by the audited rule above.
* Old install script used 09:00/21:00; replaced with 08:00/15:00 IST.
* `supabase.js listInvoices` asked for 10,000 rows, but Supabase returns at most 1,000 per request; the cloud store pages through all rows.
* Invoice key stays `customer|invoice` (as in your data). Using the Tally company in the key would have created duplicates of all existing invoices; the company name is stored in `tally_company` instead. Two different Tally companies containing the same customer+invoice number would collide – use one company per Supabase project.

## 7. Manual steps still required
Switch Firebase to Blaze; run the SQL; run the migration (if you have `invoices.db`); set 4 secrets; fill `functions/.env`; deploy; update the Bolna webhook URL; install the agent on the client server; verify with `docs/TESTING.md`; switch dry-run off only when satisfied. `package-lock.json` for `functions/` is not included (could not run `npm install` offline) – `npm install` creates it.
