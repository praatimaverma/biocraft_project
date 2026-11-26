-- OPTIONAL, ADDITIVE, SAFE TO RE-RUN. Run only when you want automatic follow-up scheduling.
-- It creates 6 Supabase Cron jobs that call the Edge Function route POST /api/internal/run-followups.
-- It does NOT touch any table or row. The function itself stays in DRY-RUN unless you set
-- AUTO_FOLLOWUP_ENABLED=true and AUTO_FOLLOWUP_DRY_RUN=false as Edge Function secrets.
--
-- BEFORE running this file (Supabase Dashboard > SQL Editor), run these two lines ONCE with YOUR values
-- (they store the values in Supabase Vault; do not paste them anywhere else):
--   select vault.create_secret('PASTE-THE-SAME-VALUE-AS-CRON_SECRET', 'biocraft_cron_secret');
--   select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/api/internal/run-followups', 'biocraft_followup_url');
--
-- Schedule = the same windows as the old Firebase scheduler ("* 10-11,17-18 * * 1-5" Asia/Kolkata),
-- written in UTC because Supabase Cron runs in UTC (IST = UTC+5:30):
--   10:00-11:59 IST = 04:30-06:29 UTC     17:00-18:59 IST = 11:30-13:29 UTC     Monday-Friday.
-- followup.mjs re-checks the India weekday/time window itself, and the database UNIQUE lock stops duplicate calls.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  j record;
  cmd text := $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'biocraft_followup_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'biocraft_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$;
begin
  for j in select * from (values
    ('biocraft-followup-1', '30-59 4 * * 1-5'),
    ('biocraft-followup-2', '* 5 * * 1-5'),
    ('biocraft-followup-3', '0-29 6 * * 1-5'),
    ('biocraft-followup-4', '30-59 11 * * 1-5'),
    ('biocraft-followup-5', '* 12 * * 1-5'),
    ('biocraft-followup-6', '0-29 13 * * 1-5')
  ) as t(name, expr)
  loop
    perform cron.schedule(j.name, j.expr, cmd);   -- same name = update in place, so re-running never duplicates
  end loop;
end $$;

-- To stop the scheduler later (removes only these 6 jobs):
--   select cron.unschedule(jobname) from cron.job where jobname like 'biocraft-followup-%';
