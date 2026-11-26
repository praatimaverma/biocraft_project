-- Restores call_logs.invoice_id to the ORIGINAL (old SQLite) invoice ids. Safe to run more than once.
update public.call_logs set invoice_id = legacy_invoice_id where legacy_invoice_id is not null;
