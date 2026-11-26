# Test report (what was ACTUALLY run, here, offline, Node 22.23)

No Firebase, Supabase, Bolna, Tally or Deno runtime was available. Everything below used local stubs/fakes. **This does not prove production success.**

## Passed (run from the project root)
| Command | Result |
|---|---|
| `node tests/test-edge-api.mjs` | **36 passed, 0 failed** |
| `node tests/test-edge-auth.mjs` | **20 passed, 0 failed** |
| `node tests/test-core.js` (existing) | 7 passed |
| `node tests/test-functions.js` (existing, old Firebase code) | 16 passed |
| `node tests/test-agent.js` (existing, ~200 s because of real retry back-off) | 10 passed |
| `node tests/test-migration.js` (existing, legacy SQLite migration) | 10 passed |
| `node --check` on all 11 `supabase/functions/api/*.mjs`, both new test files | all OK |
| Frontend: all inline `<script>` of `public/index.html` extracted and `node --check` | OK (1 block) |
| Secret scan of everything that ships (JWT-looking strings, private keys, service-role/Bolna key assignments, `.env`, `*.db`, `*.pem`) | nothing found; only `*.env.example` placeholders |
| SQL scan of `001` and `002` for DROP/TRUNCATE/DELETE/RENAME | none (only the comments saying so) |

## What the new tests cover (real store/supabase/webhook/bolna/followup code against a local fake Supabase REST server and a stubbed Bolna URL)
* Health 200 `{ok,time}`; works on `/api/health`, `/api/api/health`, `/health`.
* CORS: OPTIONS preflight 204 with allow-origin/headers/methods for `web.app` and `firebaseapp.com`; unknown origin gets no allow-origin; CORS headers also on 401s.
* Auth: no token / bad scheme / forged token -> 401 on invoices, details, call logs, stats, call detail, sync-status, trigger-call, unknown paths, with no data returned and no Bolna call; auth backend down -> 503 (fail closed).
* Firebase verifier with real RSA signatures: valid; tampered payload; wrong key; wrong aud; wrong iss; expired; future iat; no sub; `alg:none`; HS256 confusion; unknown kid; garbage; disabled user; revoked token; wrong user; Google unreachable (503); missing API key (503); 30 s cache.
* Invoices list (shape, 1,200-row pagination), details 200/400/404, call logs/stats/detail incl. `configured:false`, database errors -> 502.
* Manual call: exact Bolna URL/headers/body, call id saved, call_logs row, 409 for paid and future-promised, 404, Bolna rejection (502, invoice not marked calling), missing execution id, missing Bolna key (500, no outbound request), invalid JSON (400).
* Webhook: wrong/missing token 401 with DB untouched; token unset 503; valid promised_to_pay/paid/no-extraction/unknown id/in-progress; DB error 500.
* Tally sync endpoint: 401/503/400; valid push writes only Tally-owned columns then calls `tally_close_missing`; DB error 500.
* Scheduler route: secret checks; real scheduler with no flags does nothing. Scheduler rules: disabled by default; **dry-run sends no call and reserves nothing**; once per slot; 10 concurrent runs -> exactly 1 call; weekend and out-of-window hours; stuck "calling" retry; Bolna failure not retried.

## NOT run / cannot be verified here
* Deploying to Deno: `supabase functions deploy`, Deno's module loader (`.mjs` imports, `node:` imports, `Deno.serve`) and `supabase/functions/api/index.ts` were **not executed or type-checked** (no Deno/network). Highest-risk item; the deploy step will show it immediately.
* Live Firebase (real ID tokens, Google JWKS, `accounts:lookup` response format for `disabled`/`validSince`).
* Live Supabase (real PostgREST, RLS, the real SQL migration was **not executed** - the repo tests only mimic `tally_close_missing`), pg_cron/pg_net/Vault.
* Live Bolna (real call, real webhook payloads), live Tally, real browser login/CORS from `biocraft-af718.web.app`, Firebase Hosting deploy.
* No linter/formatter/TypeScript type-check exists in the project or offline; only syntax checks.
* 846 vs 997 invoice discrepancy: not investigated.
