# Testing – what was verified and what was NOT

I could not use your real Tally, Supabase, Firebase or Bolna accounts, and the build environment had no internet
(so `express`, `firebase-functions` and the Firebase emulator could not be installed). Everything below says exactly what was and was not proven.

## Automated tests included (`tests/`)
Run them on any PC with Node 22 (no installs needed): 
```
node tests/test-core.js        node tests/test-agent.js        node tests/test-functions.js        node --no-warnings tests/test-migration.js
```
(`test-agent.js` waits about 3 minutes in its last case because it tests the agent's retry waits for an unreachable Tally.)
They use a mock Tally server (`tests/mock-tally.js`), an in-memory imitation of Supabase and a real SQLite file. Results when I ran them: **core 7/7, agent 10/10, functions 16/16, migration 10/10 passed.**

## Checklist from your request

| Item | Status | Evidence / what to do |
|---|---|---|
| A. Firebase backend starts | **NOT TESTED** | Code passes `node --check` and its logic modules run in tests. Needs `npm install` + `firebase emulators:start` or a real deploy. Check `/api/health` after deploying. |
| B. Hosting loads dashboard | **NOT TESTED** | `public/index.html` JS syntax-checked only. Open the site after `firebase deploy --only hosting`. |
| C. Login works | **NOT TESTED** | Login code is unchanged. Try after deploy. |
| D. Unauthorized users blocked | **NOT TESTED (code reviewed)** | `lib/app.js` rejects every `/api` route except `/health`, the token-protected webhook and `/tally-sync`. Verify: open `/api/invoices` without logging in → must say "Sign in required". |
| E. Agent connects to the right Tally company | **NOT TESTED against real Tally** | Verified against the mock Tally; real company needs `run-test-tally.bat` on the client server. |
| F. Agent retrieves complete dataset | **PARTLY** | Parsing/merging verified with the mock (including credit rows skipped, Indian number format, phones). Tally has no paging. Compare the count with Tally's Outstanding Receivables report. |
| G. 08:00 / 15:00 jobs configured | **NOT TESTED** | PowerShell/Task Scheduler not available here. After install: `Get-ScheduledTask BiocraftTallySync-*` must show next run times. |
| H. Supabase receives records | **PASS against fake Supabase; NOT TESTED against real Supabase** | |
| I. Repeat sync = no duplicates | **PASS (fake)** | 3 syncs, 1200-row/3-chunk run twice; key `customer|invoice`, upsert on that key. |
| J. Sync keeps payment/call data | **PASS (fake)** | Sync never sends those columns; test compares row before/after. |
| K/L. Dashboard reads Supabase; updates after sync | **NOT TESTED** | `/api/invoices` reads `tally_invoices` directly; polling every 30 s. Verify by running a sync and watching the dashboard. |
| M. Bolna outbound call can be triggered | **NOT TESTED** (never placed a real call) | Request body is identical to the old code. Test with one invoice you own. |
| N. Webhook updates right invoice | **PASS (fake store)** | paid / promised / no-extraction / unknown-id / wrong token cases. Real Bolna payload not tested. |
| O. Transcript & recording saved | **PASS (fake store)** | |
| P. Follow-up schedule preserved, no duplicate calls | **PASS for the rules (fake store)**; **database lock NOT TESTED on real Postgres** | Windows/slots/weekday/skip rules/stuck retry/dry-run checked; 10 simultaneous instances → exactly 1 call. The real lock is the `UNIQUE(invoice_id, attempt_date, slot)` constraint in the SQL migration. |
| Q. No secrets in frontend | **PASS** | Scanned. (The Firebase web `apiKey` in `index.html` is a public client identifier, it was already there.) |
| R. No localhost in production code | **PASS** | Scanned `public/`, `index.html`, `functions/`, `firebase.json`. |
| SQL migration | **NOT TESTED** | No Postgres available. Run it in the Supabase SQL Editor; it is additive. The close/reopen SQL logic was mirrored and tested in JS only. |
| SQLite → Supabase migration | **PASS (fake Supabase + real SQLite file)** | Dry-run, apply, re-run, hash of `invoices.db` unchanged. |

## Smoke test after deployment (15 minutes)
1. `https://biocraft-af718.web.app/api/health` → `{"ok":true}`.  2. `/api/invoices` without login → "Sign in required".
3. Log in → invoice list shows. 4. Run `run-sync-now.bat` on the client server → refresh dashboard → new/updated invoice appears (within 30 s).
5. `run-check-last-sync.bat` → shows SUCCESS. 6. In Supabase set a test invoice's `last_call_id` to `TEST-1` then run `node simulate-webhook.js`-style POST (or use Bolna's test)
   to `/api/bolna-webhook?token=...` → invoice status changes. 7. Look at `followupScheduler` logs for `[DRY RUN]` lines.
8. Make ONE manual call to your own phone with the dashboard's Call button.
