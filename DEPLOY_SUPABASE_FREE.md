# Deploy BioCraft on Supabase Edge Functions (no Firebase Blaze)

Firebase keeps doing two things only: **Hosting** (the website) and **Authentication** (employee login). The backend (`/api/...`) now runs as ONE Supabase Edge Function called `api`.
Nothing here deletes or changes your Supabase data. Nothing is deployed automatically.

Words used below: **PROJECT ROOT** = the folder that contains `firebase.json` and the `supabase` folder. **REF** = your Supabase project reference (20 letters/digits).

> URLs are opened in the **browser**, never typed into PowerShell.

---
## Step 1 - Open PowerShell in the PROJECT ROOT
Unzip the project, then:
```powershell
cd C:\path\to\BioCraft_Supabase_Edge_Backend
node -v
```
You need Node 18 or newer. (Docker is NOT needed.)

## Step 2 - Log in to Supabase (opens your browser)  **<- first command**
Run in the PROJECT ROOT:
```powershell
npx supabase@latest login
```

## Step 3 - Find your REF
Browser: Supabase Dashboard > your project > **Project Settings > General > Reference ID**. In the steps below replace `REF` with it.

## Step 4 - Check whether the database migration `001` is already applied (read-only)
Browser: Dashboard > **SQL Editor > New query**, paste, Run:
```sql
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='tally_invoices'
      and column_name in ('last_call_at','tally_company','sync_batch_id','tally_synced_at_ist')) as invoice_columns_found,
  to_regclass('public.followup_attempts') is not null as has_followup_attempts,
  to_regclass('public.tally_sync_log')    is not null as has_sync_log,
  exists (select 1 from pg_proc where proname = 'tally_close_missing') as has_close_function;
```
* Result `4 / true / true / true` -> already applied, **skip to step 5**.
* Anything else -> open `supabase\migrations\001_firebase_backend.sql`, paste the whole file in a new SQL Editor query and Run. It only ADDS columns/tables/function (idempotent, no DROP/TRUNCATE/DELETE). Note: it also copies `call_logs.invoice_id` into a NEW column `legacy_invoice_id` (a one-time backfill of that new column only). Take a Dashboard backup first if you want extra safety.

## Step 5 - Create the secrets file (stays on your PC)
PROJECT ROOT:
```powershell
Copy-Item supabase\functions\api\.env.example supabase\functions\api\.env
notepad supabase\functions\api\.env
```
Fill in: `BOLNA_API_KEY`, `BOLNA_AGENT_ID` (and `BOLNA_FROM_NUMBER` if you use one), `FIREBASE_WEB_API_KEY` (the `apiKey` inside `firebaseConfig` in `public\index.html`; it is public). For `WEBHOOK_TOKEN` keep the token you already use in Bolna, or make a new one. `CRON_SECRET` is new. To generate a random value (prints it on your screen only):
```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```
Leave `AUTO_FOLLOWUP_ENABLED=false` and `AUTO_FOLLOWUP_DRY_RUN=true` (safe: no automatic calls).
Never send this file to anyone. Supabase adds `SUPABASE_URL` and the service-role key to the function itself.

## Step 6 - Upload the secrets
PROJECT ROOT:
```powershell
npx supabase@latest secrets set --env-file supabase\functions\api\.env --project-ref REF
```

## Step 7 - Deploy the function
PROJECT ROOT:
```powershell
npx supabase@latest functions deploy api --no-verify-jwt --use-api --project-ref REF
```
`--no-verify-jwt` is required (callers use Firebase/webhook tokens, not Supabase JWTs). Every route is checked inside the code.
Dashboard check: **Edge Functions > api** exists; its "Verify JWT" setting is OFF.

## Step 8 - Health check (browser)
Open: `https://REF.supabase.co/functions/v1/api/health`
Expected: `{"ok":true,"time":"2026-..."}`.
If you see `{"msg":"..."}` / 401 about JWT, redo step 7 with `--no-verify-jwt`.

## Step 9 - Point the website at the function and redeploy Hosting
PROJECT ROOT:
```powershell
.\scripts\set-api-url.ps1 -ProjectRef REF
firebase deploy --only hosting --project biocraft-af718
```
(If PowerShell blocks the script: `Set-ExecutionPolicy -Scope Process Bypass` once, then retry.)
This is the only website change: one line `const API_BASE = ...` and two places that prefix it. Look and layout are unchanged.

## Step 10 - Tell Bolna the new webhook address (Bolna dashboard, browser)
In the agent's webhook field use:
`https://REF.supabase.co/functions/v1/api/bolna-webhook?token=YOUR_WEBHOOK_TOKEN`
(Firebase Hosting cannot forward to Supabase, so the old `biocraft-af718.web.app/api/bolna-webhook` URL will no longer work.)

## Step 11 - Tally agent
No change. It writes straight to Supabase with its own `tally-agent\.env`. Just confirm that file's `SUPABASE_URL` is the same project.

## Step 12 (optional) - Automatic follow-ups via Supabase Cron
1. Dashboard > **Integrations**: enable **Cron** and **Vault** (and `pg_net` under Database > Extensions).
2. SQL Editor, run these two lines ONCE with your values (REF and the same value as `CRON_SECRET`):
```sql
select vault.create_secret('PASTE-CRON_SECRET-VALUE', 'biocraft_cron_secret');
select vault.create_secret('https://REF.supabase.co/functions/v1/api/internal/run-followups', 'biocraft_followup_url');
```
3. Paste and run the file `supabase\optional\002_followup_cron.sql` (adds 6 cron jobs; no table is touched).
4. Leave dry-run on. After a working-hours window look at **Edge Functions > api > Logs** for `[DRY RUN]` lines. Only when happy, change `AUTO_FOLLOWUP_ENABLED=true` and `AUTO_FOLLOWUP_DRY_RUN=false` in your `.env`, repeat step 6 (no redeploy needed).
Windows (same as before, Mon-Fri India time): 10:00-11:59 and 17:00-18:59.

## Final checklist (tick each one)
- [ ] Health URL (step 8) shows `{"ok":true,...}`
- [ ] https://biocraft-af718.web.app opens, login works, wrong password is refused
- [ ] Invoices table loads (no "Supabase connection error"); count noted (do NOT "fix" 846 vs 997 yet)
- [ ] Open an invoice's Details, then the Call history tab and its stats
- [ ] Manual call on ONE test invoice you are happy to call: toast shows a Call ID; row appears in call history
- [ ] Bolna test call finishes: invoice status/transcript/recording update within ~30 s (webhook)
- [ ] Edge Functions > api > Logs show Bolna webhook calls answered 200 (a 401 there means the token in Bolna does not match `WEBHOOK_TOKEN`)
- [ ] Tally: run `tally-agent\run-sync-now.bat`, then check `tally_sync_log` / dashboard
- [ ] Scheduler: `[DRY RUN]` lines appear in Logs inside the windows, and no real calls happen

## Free-plan limits you must know (check supabase.com/pricing and the Edge Function limits page for current numbers)
* **Inactivity pause:** Free projects are paused after about 1 week without activity; a paused project means the whole dashboard fails until you click Restore. Employees using it daily normally prevents this; Tally sync and cron also count as activity but confirm in your Dashboard.
* **Edge Function invocations:** the Free plan includes a monthly quota (about 500,000 at the time of writing). The dashboard polls every 30 s per open tab (health + invoices + stats = ~3 calls per poll). Roughly 60k-85k invocations per tab per month at 8 h/day; several employees can approach the quota. Cron adds ~5,000 a month.
* **Per-request limits:** short CPU time per request and a wall-clock timeout (~150 s). A very large Tally push through `/api/tally-sync` (not used by the normal agent) with Supabase 5xx errors could hit it.
* **Cron:** pg_cron/pg_net are available on Free but jobs run in UTC (handled in the SQL file); cron needs the project to be active.
* **Database:** 500 MB, daily backups are NOT included on Free (only on paid plans) - export a backup yourself before big changes.
* **Security note:** the webhook token travels in the URL query string (as before, Bolna cannot send headers), so it can appear in Supabase function logs. Rotate it by repeating steps 5, 6 and 10 if logs are ever shared.
* **Employee access:** like the old backend, ANY valid Firebase user of this project is allowed in. In Firebase Console > Authentication > Settings > User actions, turn off self sign-up so only accounts you create can exist.
