# Direct Tally → Supabase sync

1. Run `supabase_schema.sql` in Supabase SQL Editor.
2. On the Tally Windows Server, copy `tally-agent` and its `tally-client.js`.
3. Copy `.env.example` to `.env` in that folder and fill:
   - `TALLY_URL=http://localhost:9000`
   - exact `TALLY_COMPANY` (optional if company is open in Tally)
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` (service-role secret; keep private)
4. Test Tally: `node agent.js --test` (sends nothing).
5. Send to Supabase: `node agent.js`. It logs `Sent directly to Supabase`.
6. Verify rows in Supabase Table Editor → `tally_invoices`.
7. Dashboard server uses its own Supabase URL/service key in `workbio/.env`; dashboard requests `/api/invoices`, which reads Supabase and mirrors rows into local SQLite for existing call functions.

Security: Do not share either `.env`, put the service key in browser code, or upload it in ZIPs. This direct architecture no longer needs APP_URL or TALLY_SYNC_TOKEN in the agent's `.env`.
