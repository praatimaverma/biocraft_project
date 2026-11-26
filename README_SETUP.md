# Biocraft Scientific – Payment Follow-ups: setup guide

Requires **Node.js 18 or newer** (it uses Node's built-in `fetch`). Check with `node -v`.

## What's in this version
1. Branded for Biocraft Scientific.
2. **Payment status** is `Pending`, `Done` or `Unclear`, decided from what the customer says on the call.
3. **Payment mode** (UPI, Bank transfer, Cheque, Cash, Card, Other) filled from the conversation.
4. **Two follow-up calls on the promised payment day**: 10 AM and 5 PM India time. If the 10 AM call is not answered, the 5 PM call tries again.
5. Every call is saved to Supabase and shown in the **Call history** tab, with filters.
6. **Actual payment date** *(new, from the invoice-caller version)*: a **Payment date** column in the invoices table and an **Actual payment date** line in the Details panel. It is the day the customer says they *already paid*, and is separate from the **Promised date**.
7. **Stricter promised date** *(new, from the invoice-caller version)*: the promised date is only taken from the Bolna field `promised_payment_date`. It is never guessed from the transcript. (Before, if the agent read out the invoice due date, that date could be saved as the customer's "promise" and trigger calls on the wrong day.)
8. Date parsing also understands `14 October 2026` (day first), not just `2026-10-14` and `October 14, 2026`.
9. Older databases are upgraded automatically (see "Upgrading").

## How payment status is decided
| What the customer said (Bolna `payment_status`) | Payment status |
|---|---|
| paid / paid_on_call / payment_done | **Done** |
| promised_to_pay, callback_requested, disputed, refused | **Pending** |
| Call completed but the answer could not be understood, or wrong_number | **Unclear** |
| No answer / busy / failed | unchanged (no new information) |

The rules live in one function, `derivePaymentState` in `server.js`.
The detailed result (e.g. "Promised to pay") still shows in the **Last call result** column.

## Follow-up schedule
- Runs for invoices whose promised payment date is today (or earlier and still unresolved).
- Slot 1: 10:00-12:00 IST. Slot 2: 17:00-19:00 IST. One call per invoice per slot (a slot can start late if the server was down at 10:00).
- Skipped once the invoice is Done, disputed, refused or wrong number.
- Monday to Friday only. A promise falling on a weekend is called on Monday.
- A call stuck in "calling" for 90 minutes (no webhook arrived) is treated as lost and can be retried.
- Change the times in `FOLLOWUP_SLOTS` near the top of the scheduler section of `server.js`.

---

## Setup steps

### 1. Install
Unzip, open a terminal in the folder, then:
```
npm install
```
Windows: `copy .env.example .env`   Mac/Linux: `cp .env.example .env`
Then open `.env` and fill in your values (see steps 2-4). If you already have a `.env`, keep it and only add anything missing.

### 2. Supabase (5 minutes)
1. Supabase dashboard > **SQL Editor** > new query > paste `supabase_schema.sql` > **Run**.
   Safe to run even if you ran an earlier version: it only adds what is missing (including the new `payment_date` column).
2. **Project Settings > API**: copy the Project URL and the `service_role` key.
3. Add to `.env`:
   ```
   SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   ```
   Keep this key private. It is only used by the server.

If you forget to re-run the SQL, nothing breaks: calls are still saved, just without the payment date (the terminal shows one warning telling you to run the SQL).

### 3. Bolna agent (needed for payment status, payment mode and payment date)
**a) Prompt.** Paste the contents of `bolna_agent_prompt.txt` into your Bolna agent.
The server sends these variables with every call: `customer_name`, `invoice_id`, `amount_due`, `due_date`, `today_date` (plus `record_id`).
`invoice_id` comes from the **invoice_number** column (default `INV-1000 + id`, e.g. `INV-1001`); edit it in the database if your numbers differ.

**b) Extraction.** In your Bolna agent, set up post-call **extraction** with these five fields:

| Field name | What to ask Bolna to extract |
|---|---|
| `payment_status` | One of: paid, promised_to_pay, disputed, callback_requested, no_answer. Use no_answer if unclear. |
| `promised_pay_date` | Date the customer promised to pay, as YYYY-MM-DD. If only a day is said, use the call date's month and year. Empty if none. |
| `payment_date` | Date the customer says payment was already made, as YYYY-MM-DD. Empty if not yet paid. |
| `payment_mode` | One of: bank_transfer, upi, cheque, cash, card. Empty if not mentioned. |
| `dispute_reason` | Short reason the customer gave for disputing. Empty if no dispute. |

The server also still understands the older names `call_outcome` and `promised_payment_date`, so either set works.
Bolna sends each field as `{ subjective, confidence, ... }`; the server reads only the answer (`subjective`), never the confidence score.

Because the promised date is never guessed, **`promised_pay_date` must be extracted** or the 10 AM / 5 PM follow-ups will not trigger for that invoice.
If `payment_mode` is not extracted, the app falls back to keywords in the **customer's** lines of the transcript (never the agent's script).

Set the agent's webhook to `https://YOUR-PUBLIC-URL/api/bolna-webhook?token=YOUR_WEBHOOK_TOKEN` (the token must match `WEBHOOK_TOKEN` in `.env`).
Bolna needs a public URL: a hosted server, or a tunnel such as ngrok while testing (`ngrok http 3000`).

### 4. Turn on automatic follow-ups (do this last)
In `.env`:
```
AUTO_FOLLOWUP_DRY_RUN=true     # first: logs who WOULD be called, makes no calls
```
Start with `npm start` and watch the terminal around 10:00 and 17:00 IST for `[DRY RUN] Eligible invoice found`.
When happy, change to:
```
AUTO_FOLLOWUP_DRY_RUN=false
AUTO_FOLLOWUP_ENABLED=true
```
and restart. The server must be running at those times (an always-on machine or host).

---

## Upgrading from an earlier version
**From the invoice-caller version:** copy your old `invoices.db` into this folder, then `npm start`. On first start the database is upgraded in place and nothing is deleted:
- new columns are added, old follow-up attempts are kept (as "morning" attempts),
- payment status (Pending / Done / Unclear) is worked out from each invoice's existing status,
- old payment-mode labels are tidied: `Not specified` becomes empty, `Bank Transfer` becomes `Bank transfer`,
- existing payment dates are kept.

**From the earlier Biocraft version:** same thing, keep your `invoices.db` and `.env`; only a `payment_date` column is added.

Delete `invoices.db` only if you want to start from empty sample data.

---

## See it working (follow in order)

### A. Start and look (2 minutes, no accounts needed)
1. `npm install`, then `npm start`.
2. Open http://localhost:3000. You should see the **Biocraft Scientific** dashboard with two sample invoices and the columns *Payment status, Payment mode, Last call result, Promised date, **Payment date***.
3. Terminal shows `Running on http://localhost:3000`. Without Supabase it also says call history will queue locally. That is expected.

### B. Watch an invoice update without making a real call (no Bolna credits, no ngrok)
Keep `npm start` running. In a **second** terminal, in the same folder (use only test invoices; the two sample ones are fine), and keep the dashboard open next to it. Do the steps in order:

**1. Customer says they already paid**
```
node scripts/simulate-webhook.js 1 paid --yes
```
The dashboard updates by itself:
- Invoice 1: **Payment status = Done**, **Payment mode = Bank transfer**, **Payment date = yesterday**.
- Click **Details**: **Actual payment date** is filled in and the transcript shows as a chat.
- Set the **Payment mode** filter to *Bank transfer*: invoice 1 is listed. Click **Clear filters**.
- Click **Start follow-up call** on invoice 1: you get "Payment is already marked done; no follow-up call will be placed." (No call is made.)

**2. Customer promises to pay in 3 days**
```
node scripts/simulate-webhook.js 2 promise --yes
```
- Invoice 2: **Pending**, **UPI**, **Promised date = 3 days from now**, **Payment date stays empty**.
- Click **Start follow-up call** on invoice 2: you get "Follow-up is scheduled for the promised payment date". (No call is made.)

**3. Other outcomes**
```
node scripts/simulate-webhook.js 2 callback --yes    # "Callback requested", promised date kept
node scripts/simulate-webhook.js 2 noanswer --yes    # back to Pending, nothing else changes
node scripts/simulate-webhook.js 2 dispute --yes     # "Disputed", reason shown in Details
```

**4. Call history** (only if Supabase is connected): the **Call history** tab has one `demo-...` row per command above. Use the filters, and **View call** to open the transcript.

### C. Check the automatic scheduler safely
Set `AUTO_FOLLOWUP_DRY_RUN=true` in `.env`, restart, and leave it running through 10:00-12:00 or 17:00-19:00 IST on a weekday. Terminal prints `[DRY RUN] Eligible invoice found. NO CALL SENT.` for invoices whose promised date has arrived, and never for Done / disputed / refused invoices.

### D. One real call (needs steps 2-3 done)
1. Put YOUR phone number in a test invoice (E.164, e.g. `+919876543210`). The seed rows are in `db.js`; they are only inserted into an empty database, so to change an existing one use a SQLite tool or delete `invoices.db` first.
2. Make sure ngrok is running and Bolna's webhook points to it.
3. Click **Start follow-up call**, answer, say you already paid on a date by NEFT.
4. Within a minute of hanging up the row should show Done, Bank transfer and the payment date, and a row appears in Call history and in Supabase > Table Editor > `call_logs`.

---

## If something looks wrong
- **"Connect Supabase to see call history" banner:** `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` missing, or the server was not restarted.
- **Terminal warns "call_logs is missing a newer column (payment_date)":** run `supabase_schema.sql` again in the Supabase SQL Editor.
- **Payment mode always empty:** add `payment_mode` extraction in Bolna (step 3).
- **Payment date always empty:** add `payment_date` extraction in Bolna (step 3).
- **Promised date empty after a call where the customer promised:** add `promised_payment_date` extraction in Bolna (step 3).
- **Everything stays Pending:** the webhook is not reaching the server (check the public URL and token).
- **`simulate-webhook.js` says it cannot reach the server:** start `npm start` first, in the same folder.
- If Supabase is down, calls and webhooks still work. Records queue locally and are delivered automatically.

## Files
| File | Purpose |
|---|---|
| `server.js` | API, Bolna webhook, follow-up scheduler |
| `db.js` | Local SQLite database and automatic upgrades |
| `bolna_agent_prompt.txt` | The prompt to paste into your Bolna agent |
| `supabase.js`, `calllog.js`, `supabase_schema.sql` | Call history in Supabase (with local retry queue) |
| `public/index.html` | The dashboard |
| `tally-agent/` | Tally sync agent for the client's Tally server (copy this folder there) |
| `tallyImport.js`, `scripts/sync-tally.js`, `scripts/mock-tally.js` | Tally import logic, pull-mode sync, fake Tally for testing |
| `scripts/simulate-webhook.js` | Optional: simulate a finished call for testing |
| `.env.example` | Settings template (copy to `.env`) |

## TallyPrime CSV import (first/manual connectivity test)
This project currently stores invoice rows in local `invoices.db`; its Supabase integration is for call history (`call_logs`), not invoice synchronization. Use this CSV importer to verify a Tally export reaches the dashboard before automating it.

1. On the client's cloud Windows Server, open TallyPrime and load the correct company.
2. Open **Display > Statements of Accounts > Outstanding > Receivables** (menu names can vary by configuration). Set the period/company and export using **Alt+E / Export**, choose **Excel/CSV**, and save a CSV. Include party/customer, voucher/invoice number, outstanding amount, due date, and phone/mobile if available. Do not include unrelated ledger data.
3. Copy the CSV securely to your local BioCraft project folder (for a one-file test, use Remote Desktop shared clipboard/drive or an approved secure transfer; don't expose Tally's ODBC port publicly).
4. From the project folder run:
   `node scripts/import-tally-csv.js "C:\\path\\to\\tally-export.csv"`
5. Refresh `http://localhost:3000`. The importer updates matching `invoice_number` records and adds new ones. It skips rows missing customer, invoice number, amount, or a parseable date. It does not delete invoices absent from the export.

### Automation
Automatic twice-a-day sync is now built in. See **TALLY_SYNC_SETUP.md** (step by step).
