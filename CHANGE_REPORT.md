# Change report

Principle: new Supabase backend added NEXT TO the old code; business logic ported verbatim; only transport, auth verification and scheduling trigger replaced.

## Modified (3 files; originals in `original_backup/`)
| File | Change | Why |
|---|---|---|
| `firebase.json` | Removed the `/api/**` rewrite to Cloud Function `api` and the `functions` block. `hosting.public` and `ignore` kept as they were (the original had no extra headers/cache/404 rules). | Hosting can't route to Supabase, and a Functions rewrite/config needs Blaze. Website is still served from `public/`. |
| `public/index.html` | +2 lines (comment and `const API_BASE = 'https://YOUR-PROJECT-REF.supabase.co/functions/v1';`), `fetch(url,...)` -> `fetch(API_BASE + url,...)` in `getJson`, and `fetch('/api/trigger-call'` -> `fetch(API_BASE + '/api/trigger-call'`. No CSS/HTML/label/layout change; Firebase sign-in code untouched; the ID token is sent exactly as before. | Send API calls to the Supabase function. `scripts/set-api-url.ps1` fills in the ref. |
| `.gitignore` | +2 lines (`supabase/functions/api/.env`, `supabase/.temp/`). | Keep your real secrets file out of git. |

## Added
| File | Purpose |
|---|---|
| `supabase/functions/api/index.ts` | Edge Function entry (`Deno.serve`). |
| `supabase/functions/api/handler.mjs` | Replaces Express `functions/lib/app.js`: every route, status code and JSON body kept (see table below), CORS, body parsing. |
| `supabase/functions/api/auth.mjs` | Firebase ID-token verification: RS256 signature against Google's keys, iss/aud/exp/iat/auth_time/sub checks, plus disabled/revoked check via Google Identity Toolkit (equivalent of `verifyIdToken(token, true)`). |
| `supabase/functions/api/{helpers,store,supabase,calllog,bolna,webhook,followup,tally-sync-core}.mjs` | Line-for-line ports of `functions/lib/*.js` (helpers and tally-sync-core are verbatim). Only changes: ESM imports, `env()` instead of `process.env`. In `supabase.mjs` the unused `upsertInvoices`, `cleanupOldTallyInvoices`, `listInvoices`, which no route calls (the cleanup RPC isn't in the migration), were not carried over. |
| `supabase/functions/api/env.mjs` | Reads Deno env (or process env under tests). |
| `supabase/functions/api/.env.example` | Placeholders only. |
| `supabase/config.toml` | `verify_jwt = false` for `api`. |
| `supabase/optional/002_followup_cron.sql` | OPTIONAL Supabase Cron schedule (6 jobs, UTC) -> POST `/api/internal/run-followups`. Touches no table. NOT run automatically. |
| `scripts/set-api-url.ps1` | Writes the project ref into `public/index.html`. |
| `tests/test-edge-api.mjs`, `tests/test-edge-auth.mjs` | New tests (see TEST_REPORT.md). |
| `DEPLOY_SUPABASE_FREE.md`, `CHANGE_REPORT.md`, `TEST_REPORT.md`, `ROLLBACK.md`, `original_backup/` | Deliverables. |

## Removed
Nothing. `functions/` (Firebase code), the legacy Node/SQLite files, `docs/` and `tally-agent/` are untouched. `docs/DEPLOY_FIREBASE_BACKEND.md`, `docs/ROLLBACK.md`, `docs/CHANGE_REPORT.md` describe the OLD Firebase setup; use the root-level files instead.

## Route map (all present)
| Route | Auth | Source |
|---|---|---|
| GET `/api/health` | none | app.js |
| POST `/api/bolna-webhook?token=` | `WEBHOOK_TOKEN` (required, 503 if unset) | app.js/webhook.js |
| POST `/api/tally-sync` | `Authorization: Bearer TALLY_SYNC_TOKEN` | app.js |
| GET `/api/invoices`, GET `/api/invoices/:id/details`, POST `/api/trigger-call` | Firebase ID token | app.js |
| GET `/api/call-logs`, `/api/call-logs/stats`, `/api/call-logs/:id`, GET `/api/sync-status` | Firebase ID token | app.js |
| POST `/api/internal/run-followups` | header `x-cron-secret` = `CRON_SECRET` | **NEW**, replaces Cloud Scheduler `followupScheduler` |

## Unavoidable adaptations
1. Firebase Hosting cannot proxy to Supabase -> frontend calls the function URL directly; Bolna's webhook URL must be changed (deploy step 10).
2. Scheduler: Cloud Scheduler -> Supabase Cron + the new internal route. Schedule windows, India weekday/time check, dry-run and the DB unique lock are unchanged.
3. Firebase Admin SDK -> hand-written verification with WebCrypto (no extra dependency). Revocation/disabled check needs the (public) Web API key as `FIREBASE_WEB_API_KEY`. If Google can't be reached the API fails closed with 503.
4. Response bodies for the webhook ("OK") are `text/plain` (Supabase turns `text/html` into plain text anyway).

## Not changed (as required)
Bolna request/prompt, webhook parsing, Tally agent and company logic, invoice matching, reconciliation SQL, follow-up eligibility, duplicate-call lock, dashboard UI, Firebase login. No SQL was changed; `001` is the unchanged original.

## Observations (NOT acted on)
* 997 vs 846: not investigated, nothing changed. Candidate places to look afterwards: `tally_closed`/`payment_state` rows and dashboard filtering in `public/index.html` (~line 581), duplicate `invoice_key`s.
* `GET /api/call-logs/stats` requests `limit=10000`, but Supabase REST returns at most 1000 rows by default, so its total can cap at 1000 (pre-existing behaviour, unchanged).
* Tally push endpoint with Supabase 5xx errors retries up to ~112 s (pre-existing).
