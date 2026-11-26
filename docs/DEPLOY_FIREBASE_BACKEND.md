# Deploying the BioCraft backend on Firebase (beginner steps)

You need: a Windows/Mac PC with this project folder, Node.js 22 LTS (https://nodejs.org), your Firebase
login, your Supabase project, and your Bolna API key + agent ID. You do **not** need `gcloud`.

> **Billing:** Cloud Functions, Secret Manager and Cloud Scheduler need the Firebase **Blaze (pay-as-you-go)**
> plan. For this workload the monthly cost is normally very small, but the plan must be switched on:
> Firebase Console → bottom-left "Upgrade" → Blaze.

## Step 0 – Keep a backup
Copy your whole current project folder (including `invoices.db`) to a safe place. Never delete `invoices.db`.

## Step 1 – Update Supabase (5 min)
1. Supabase Dashboard → **SQL Editor** → New query.
2. Open `supabase/migrations/001_firebase_backend.sql`, paste everything, press **Run**. It only *adds* things and is safe to run twice.
3. You should see "Success. No rows returned".

## Step 2 – Move the old local data into Supabase (only if you have been using the old app with `invoices.db`)
Do this **before** switching on the cloud backend, and **stop the old local server first** (close the terminal that runs `node server.js`) so no new calls are made while you migrate.
```
cd path\to\BioCraft
npm install            (once; installs better-sqlite3 for reading invoices.db)
set SUPABASE_URL=https://YOUR-PROJECT.supabase.co
set SUPABASE_SERVICE_KEY=YOUR_SERVICE_ROLE_KEY
node migration/migrate-sqlite-to-supabase.js invoices.db            <- DRY RUN, changes nothing, read the plan
node migration/migrate-sqlite-to-supabase.js invoices.db --apply    <- real migration
```
(Mac/Linux: use `export` instead of `set`.) The last lines must say **`RESULT: OK - counts match.`**
`invoices.db` is only read, never changed; the script also makes a `invoices.db.backup-<time>` copy.

## Step 3 – Install the Firebase tool and log in
```
npm install -g firebase-tools
firebase login
cd path\to\BioCraft
firebase use biocraft-af718
```

## Step 4 – Store the secrets (never put them in files)
Run each line; paste the value when asked (it is not shown):
```
firebase functions:secrets:set SUPABASE_SERVICE_KEY     (Supabase → Settings → API → service_role secret)
firebase functions:secrets:set BOLNA_API_KEY            (your Bolna API key)
firebase functions:secrets:set WEBHOOK_TOKEN            (invent a long random string; you will paste it into Bolna in Step 7)
firebase functions:secrets:set TALLY_SYNC_TOKEN         (any long random string; only used by the optional /api/tally-sync endpoint)
```

## Step 5 – Non-secret settings
Copy `functions/.env.example` to `functions/.env` and fill in `SUPABASE_URL` and `BOLNA_AGENT_ID` (and `BOLNA_FROM_NUMBER` if you used one).
Leave `AUTO_FOLLOWUP_ENABLED=false` and `AUTO_FOLLOWUP_DRY_RUN=true` for now (safe mode: **no automatic calls**).

## Step 6 – Deploy
```
cd functions
npm install
cd ..
firebase deploy --only functions
firebase deploy --only hosting
```
The first functions deploy asks to enable some Google APIs – answer **Y**. It can take 5–10 minutes.
Afterwards: functions `api` and `followupScheduler` exist in region `asia-south1`, and
`https://biocraft-af718.web.app/api/**` is routed to `api`.

Check it: open `https://biocraft-af718.web.app/api/health` → you should see `{"ok":true,...}`.
Then open `https://biocraft-af718.web.app`, sign in, and confirm the invoices appear.
Also check that an un-logged-in request is refused: `https://biocraft-af718.web.app/api/invoices` must show `Sign in required`.

## Step 7 – Point Bolna at the new webhook
In your Bolna agent's webhook setting use:
```
https://biocraft-af718.web.app/api/bolna-webhook?token=YOUR_WEBHOOK_TOKEN
```
(`YOUR_WEBHOOK_TOKEN` = the value from Step 4.) The webhook now **refuses** requests when the token is missing/wrong.
Do not change the Bolna agent prompt.

## Step 8 – Follow-up calls: dry run first, then live
* Dry run (default): in Firebase Console → Functions → `followupScheduler` → **Logs**, during 10:00–12:00 and 17:00–19:00 IST on weekdays you will see lines starting `[DRY RUN]`. No call is made.
  Or: `firebase functions:log --only followupScheduler`
* Only when you are happy: edit `functions/.env` → `AUTO_FOLLOWUP_ENABLED=true` and `AUTO_FOLLOWUP_DRY_RUN=false`, then `firebase deploy --only functions`.
* **Important:** never run the old local `node server.js` with automatic follow-ups enabled at the same time – it has its own (separate) record of attempts and could call the same customer twice. The cloud backend replaces it.

## Step 9 – Tally on the client server
Follow `docs/CLIENT_SERVER_INSTALL.md`.

## How and when does the dashboard update?
Tally → Supabase happens only at the scheduled syncs (8:00 AM and 3:00 PM IST) or when someone runs `run-sync-now.bat`.
After a sync finishes, the dashboard shows the new data within **30 seconds** (it checks every 30 s while the tab is open), or immediately when
you press the Refresh button. Bolna call results appear the same way (within 30 s of the webhook). It is not instant push – Firebase Functions cannot keep Socket.IO connections open.

## Updating later
Edit the code → `firebase deploy --only functions` (or `--only hosting` for the dashboard).
