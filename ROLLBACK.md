# Rollback (Supabase data is never touched by this migration)

The old Firebase backend code is still in `functions/` and unchanged. Only 3 files were modified; byte-exact originals are in `original_backup/`.

## Back to the previous website + Firebase Functions setup
(Requires Firebase **Blaze**, which is why it is not recommended.)
PROJECT ROOT:
```powershell
Copy-Item original_backup\firebase.json firebase.json -Force
Copy-Item original_backup\public\index.html public\index.html -Force
Copy-Item original_backup\.gitignore .gitignore -Force
firebase deploy --only hosting --project biocraft-af718
```
Then follow `docs\DEPLOY_FIREBASE_BACKEND.md` (upgrade to Blaze, set secrets, `firebase deploy --only functions`) and point Bolna back to `https://biocraft-af718.web.app/api/bolna-webhook?token=...`.

## Keep the website but stop only the new backend
* Stop the scheduler (only if you ran step 12), in the Supabase SQL Editor:
  `select cron.unschedule(jobname) from cron.job where jobname like 'biocraft-followup-%';`
* Dashboard > Edge Functions > api > delete (or leave it; with no secrets set it refuses to work). Cleanup of Vault secrets: `delete from vault.secrets where name in ('biocraft_cron_secret','biocraft_followup_url');`

## Database
Nothing to restore: no table, column or row was created, changed or removed by the Edge Function. Migration `001` (if you ran it in step 4) only added objects; `supabase\migrations\..` / `migration\rollback-call-links.sql` from the original project describe how to undo it if ever needed. Do not run anything destructive without a backup.
