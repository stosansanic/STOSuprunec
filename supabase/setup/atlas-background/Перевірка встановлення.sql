-- Read-only diagnostics. Does not dispatch or send any reminder; no secret output.
select
 to_regprocedure('public.traffic_dispatch_reminders()') is not null as cron_gate_installed,
 to_regprocedure('public.traffic_reminder_complete(bigint,text,integer,jsonb,jsonb)') is not null as atomic_completion_installed,
 to_regprocedure('public.traffic_reminder_app_inbox(bigint,bigint)') is not null as app_inbox_installed,
 to_regprocedure('public.traffic_reminder_condition(text,text)') is not null as compact_conditions_installed;

select jobname,schedule,active,
 command='select public.traffic_dispatch_reminders();' as uses_local_gate
from cron.job where jobname='atlas_check_reminders_every_minute';
-- No row is normal when there are no active server-scheduled reminders.

select exists(select 1 from sto_atlas_private.cron_transport) as project_transport_configured;

select channel,delivery_phase,count(*) as items
from public.atlas_reminder_logs
where sent_at>=now()-interval '1 day' and delivery_key is not null
group by channel,delivery_phase order by channel,delivery_phase;
