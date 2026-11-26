# Rollback

Nothing is ever deleted by this upgrade, so every step can be undone.

## A. Undo the cloud switch (go back to the old setup)
1. Disable cloud calling first: set `AUTO_FOLLOWUP_ENABLED=false` and `AUTO_FOLLOWUP_DRY_RUN=false` in `functions/.env`, `firebase deploy --only functions`
   (or delete the schedule: Firebase Console → Functions → `followupScheduler` → delete).
2. Restore the previous hosting version: Firebase Console → Hosting → *Release history* → on the previous release choose **Rollback**,
   or redeploy your backed-up original folder with `firebase deploy --only hosting`.
3. Point the Bolna webhook back to your old URL.
4. Start the old server again (`node server.js` with your original `.env` and `invoices.db`). It rebuilds its working copy from Supabase.
   Run only ONE of (old local server | cloud backend) with automatic calls on.

## B. Undo the data migration
`invoices.db` was never modified (a `invoices.db.backup-<time>` copy also exists), so the old app still has all its data.
To also restore the old call → invoice links in Supabase, run `migration/rollback-call-links.sql` in the Supabase SQL Editor
(it copies `call_logs.legacy_invoice_id` back into `invoice_id`). Rows added to `tally_invoices` by the migration can stay (harmless) or be listed with
`select * from tally_invoices where legacy_sqlite_id is not null;`.

## C. Undo the Tally schedule
On the server run `uninstall-schedule.ps1` (Administrator). To use your old agent again, run the original `install-schedule.bat`.
Closed invoices can be reviewed in `tally_close_audit`; to reopen one: `update tally_invoices set tally_closed=false, payment_state='pending', payment_status='pending' where id = ...;`
