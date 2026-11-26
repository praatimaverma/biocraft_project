# Install the Tally sync on the client's Windows Server

The agent runs **on the computer where TallyPrime runs**. It needs only Node.js – no `npm install`.

## One-time preparation (in TallyPrime)
1. Open the company in TallyPrime.
2. Enable the XML server: **F1 (Help) → Settings → Connectivity → Client/Server configuration** → set *TallyPrime acts as* **Both** (or Server), *Port* **9000**, *Enable ODBC/XML* **Yes**. Restart Tally if asked.
3. Test in a browser on that server: open `http://localhost:9000` – you should read "TallyPrime Server is Running".

## Install
1. Install **Node.js 22 LTS** (https://nodejs.org) on the server.
2. Copy the whole **`tally-agent`** folder to e.g. `C:\BioCraftTally\tally-agent` on the server.
3. In that folder copy `.env.example` → `.env` and fill:
   * `TALLY_COMPANY` – the **exact** company name from Tally (recommended)
   * `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (service_role secret)
   * leave the rest unless told otherwise
4. Double-click **`run-test-tally.bat`** – it connects to Tally and lists invoices. It sends nothing. If the amounts look backwards
   (money owed shows as positive), set `TALLY_DEBIT_IS_NEGATIVE=false`.
5. Double-click **`run-sync-now.bat`** – first real sync. It must finish with exit code 0. Then check Supabase → Table Editor → `tally_invoices`.
6. Double-click **`install-schedule.bat`** (accept the administrator prompt). This creates two Windows scheduled tasks:

| Task | Time (India) |
|------|--------------|
| `BiocraftTallySync-Morning-0800IST` | 08:00 daily |
| `BiocraftTallySync-Evening-1500IST` | 15:00 daily |

The installer converts the IST time to the server's own clock if the server is not set to India time, runs as SYSTEM (works with nobody logged in, survives
restarts), locks the `.env` file so only Administrators/SYSTEM can read it, and removes the older 09:00/21:00 tasks if they exist.
A run that is missed because the server was off starts as soon as Windows is available again. A failed run is retried by Windows up to 3 times (every 10 min) and
the agent also retries temporary Tally/network errors by itself. Windows stops any run after 55 minutes so a run cannot overlap the next window.

## Daily use
* **Check last sync:** double-click `run-check-last-sync.bat` – shows the last syncs (from Supabase) and warns if the last success is older than 20 hours.
* **Run a sync now:** `run-sync-now.bat`.
* **Logs:** `sync.log` in the agent folder; `last-sync.json` holds the latest result. Supabase table `tally_sync_log` has the full history.
* **Test a scheduled task manually:** `schtasks /Run /TN "BiocraftTallySync-Morning-0800IST"`.
* **Remove the tasks:** run `uninstall-schedule.ps1` as Administrator.

## What a sync does (safety rules)
* Reads the full Bills Receivable list of the company (Tally returns all bills in one answer – there are no pages to miss).
* Uploads in batches of 500, retrying temporary failures. **If any batch fails, the run is logged as `partial`/`failed` – never as success – and nothing is closed.**
* Updates only Tally fields (name, invoice no., amount, due date, phone). It never touches call results, promised/payment dates, status set by calls, disputes, transcripts or recordings.
  A blank phone in Tally never erases a phone number already stored.
* Invoices no longer outstanding in a **complete, fully uploaded** export are marked paid/closed (not deleted) and listed in `tally_close_audit`.
  If one export would close more than max(5, half of all open invoices), nothing is closed (looks like a bad export). Use `node agent.js --force` only if that is really correct.
  An empty Tally answer is treated as a failure.
* An invoice that comes back in Tally after being closed is reopened automatically.
