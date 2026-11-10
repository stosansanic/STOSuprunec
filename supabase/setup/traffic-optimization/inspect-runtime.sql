-- READ ONLY. SQL Editor diagnostics for requirements 17/18.
-- Does not read business rows, reminder contents, credentials or cron commands.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='act_locks'
order by ordinal_position;

select p.proname, pg_get_function_identity_arguments(p.oid) arguments,
       pg_get_functiondef(p.oid) definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('acquire_act_lock','release_act_lock');

-- Run this last query only if pg_cron is installed. Deliberately excludes command.
select jobid, jobname, schedule, active,
       command like '%check-reminders%' as checks_reminders
from cron.job
order by jobid;
