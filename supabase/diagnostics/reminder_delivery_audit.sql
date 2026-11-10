-- READ ONLY. Run after installing reminder_delivery_claims, in the SQL editor.
-- This reports installed jobs; migration files alone do not prove cron is active.
-- No command text, HTTP bodies, credentials, recipients or message contents returned.
select jobid,jobname,schedule,active,database,
       command ilike '%check-reminders%' as invokes_checker
from cron.job
where jobname ilike '%remind%' or command ilike '%check-reminders%';

select j.jobname,d.status,count(*) as runs,min(d.start_time) as first_run,max(d.end_time) as last_end,
       round(avg(extract(epoch from d.end_time-d.start_time))::numeric,3) as average_seconds
from cron.job_run_details d join cron.job j using(jobid)
where d.start_time>now()-interval '24 hours'
  and (j.jobname ilike '%remind%' or j.command ilike '%check-reminders%')
group by j.jobname,d.status;

select status,channel,reminder_type,schedule->>'type' as schedule_type,count(*) as rules,
       count(*) filter(where next_trigger_at<=now()) as due
from public.atlas_reminders group by status,channel,reminder_type,schedule->>'type';

select channel,delivery_phase,count(*) as deliveries,
 count(*) filter(where delivery_phase='claimed' and delivery_lease_until<now()) as recoverable_before_send,
 count(*) filter(where delivery_phase='sending' and delivery_lease_until<now()) as expired_uncertain_send
from public.atlas_reminder_logs where sent_at>now()-interval '7 days'
group by channel,delivery_phase;

-- Also compare check-reminders Edge logs for EMPTY and ACTIVE runs separately.
-- Browser invocation: visible UI/manual run + optional 60s timer; browser tabs use
-- Web Locks and a 45s successful-check marker, backed by the server evaluation lease.
-- Existing cleanup keeps 30 days of logs and 60 days of completed reminders.
-- The delete guard only protects a live lease or the current scheduled generation.
-- For unknown outcomes, reconcile with the provider first. The service-role-only
-- allow_reminder_delivery_retry RPC requires the original log token and explicit
-- confirmation of nondelivery. It does not send, alter dates or restart a schedule.
-- Never reset a delivered result, and never automatically reset an unknown timeout.
