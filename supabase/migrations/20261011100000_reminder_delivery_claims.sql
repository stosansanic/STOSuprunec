-- Additive leases on existing logs; no new tables. Install before callers.
alter table public.atlas_reminder_logs
 add column if not exists delivery_key text, add column if not exists delivery_generation text,
 add column if not exists delivery_token text, add column if not exists delivery_lease_until timestamptz,
 add column if not exists delivery_phase text;
create unique index if not exists atlas_reminder_delivery_identity on public.atlas_reminder_logs(reminder_id,delivery_key) where delivery_key is not null;
create index if not exists atlas_reminder_delivery_generation on public.atlas_reminder_logs(reminder_id,delivery_generation) where delivery_generation is not null;
-- Small server-only evaluation lease: one SQL evaluation fans out through the
-- independent recipient/channel claims below. It does not claim browser toasts.
alter table public.atlas_reminders add column if not exists evaluation_token text,
 add column if not exists evaluation_generation integer,
 add column if not exists evaluation_lease_until timestamptz;
create or replace function public.claim_reminder_evaluation(p_reminder_id bigint,p_expected_trigger integer)
returns text language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;t text;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or r.channel='app' or coalesce(r.trigger_count,0)<>p_expected_trigger then return null;end if;
 if r.evaluation_lease_until>clock_timestamp() then return null;end if;
 t:=gen_random_uuid()::text;
 update public.atlas_reminders set evaluation_token=t,evaluation_generation=p_expected_trigger,evaluation_lease_until=clock_timestamp()+interval '90 seconds' where reminder_id=p_reminder_id;
 return t;
end $$;
create or replace function public.finish_reminder_evaluation(p_reminder_id bigint,p_token text,p_success boolean)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 update public.atlas_reminders set evaluation_lease_until=clock_timestamp()+case when p_success then interval '55 seconds' else interval '0 seconds' end
 where reminder_id=p_reminder_id and evaluation_token=p_token;
 return found;
end $$;
revoke all on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) to service_role;
create or replace function public.reminder_recipient_matches(p_recipients jsonb,p_creator bigint,p_recipient bigint)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v jsonb:=p_recipients;s text;
begin
 s:=v#>>'{}';
 if s in ('all','"all"') then return exists(select 1 from public.slyusars where slyusar_id=p_recipient);end if;
 if s in ('mechanics','"mechanics"') then return exists(select 1 from public.slyusars where slyusar_id=p_recipient and data->>'Посада'='Слюсар');end if;
 if jsonb_typeof(v)='string' and btrim(s) like '[%' then
  begin v:=s::jsonb;exception when others then v:=null;end;
 end if;
 if jsonb_typeof(v)='array' then return v @> jsonb_build_array(p_recipient);end if;
 return p_creator=p_recipient;
end $$;
create or replace function public.claim_reminder_delivery(p_reminder_id bigint,p_generation text,p_expected_trigger integer,p_rule jsonb,p_recipient_id bigint,p_channel text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;d public.atlas_reminder_logs%rowtype;k text;t text;is_known boolean;
begin
 if p_channel not in ('app','telegram') or p_recipient_id is null or p_expected_trigger is null or p_expected_trigger<0 or p_generation is null or length(p_generation)>100
 or p_generation !~ '^(scheduled:[0-9]+|event:[a-f0-9]{64}|result:[a-f0-9]+)$' then raise exception 'Invalid reminder delivery identity';end if;
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status in ('paused','cancelled') then return null;end if;
 if jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel) is distinct from p_rule then return null;end if;
 if r.channel not in (p_channel,'both') or not public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id) then return null;end if;
 k:=md5(jsonb_build_array(p_generation,p_recipient_id,p_channel)::text);
 select * into d from public.atlas_reminder_logs where reminder_id=p_reminder_id and delivery_key=k for update;
 select exists(select 1 from public.atlas_reminder_logs where reminder_id=p_reminder_id and delivery_generation=p_generation) into is_known;
 -- Already started snapshots can finish recipient/channel fan-out after advancement.
 if p_generation like 'scheduled:%' then
  if p_generation <> 'scheduled:'||p_expected_trigger::text or (coalesce(r.trigger_count,0)<>p_expected_trigger and not is_known) then return null;end if;
 elsif coalesce(r.schedule->>'type','')<>'realtime' then return null;end if;
 if r.status<>'active' and not is_known then return null;end if;
 if d.log_id is not null then
  if d.delivery_phase='claimed' and d.delivery_lease_until>clock_timestamp() then return null;end if;
  if d.delivery_phase='sending' then
   if d.delivery_lease_until<=clock_timestamp() then update public.atlas_reminder_logs set delivery_phase='unknown',delivery_status='failed',error_message='Delivery outcome unknown; reconcile before retry' where log_id=d.log_id;end if;
   return null;
  end if;
  if d.delivery_phase in ('delivered','failed','unknown') then return null;end if;
 end if;
 t:=gen_random_uuid()::text;
 if d.log_id is null then
  insert into public.atlas_reminder_logs(reminder_id,recipient_id,channel,message_text,delivery_status,delivery_key,delivery_generation,delivery_token,delivery_phase,delivery_lease_until)
  values(p_reminder_id,p_recipient_id,p_channel,r.title,'sent',k,p_generation,t,'claimed',clock_timestamp()+interval '90 seconds');
 else update public.atlas_reminder_logs set delivery_token=t,delivery_phase='claimed',delivery_lease_until=clock_timestamp()+interval '90 seconds' where log_id=d.log_id;end if;
 return jsonb_build_object('token',t);
end $$;
create or replace function public.start_reminder_delivery(p_reminder_id bigint,p_token text)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform 1 from public.atlas_reminders where reminder_id=p_reminder_id and status not in ('paused','cancelled') for update;
 if not found then return false;end if;
 update public.atlas_reminder_logs set delivery_phase='sending',delivery_lease_until=clock_timestamp()+interval '90 seconds' where reminder_id=p_reminder_id and delivery_token=p_token and delivery_phase='claimed' and delivery_lease_until>clock_timestamp();
 return found;
end $$;
create or replace function public.finish_reminder_delivery(p_reminder_id bigint,p_token text,p_outcome text,p_message text default null)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare generation text;delivery_id bigint;
begin
 if p_outcome not in ('delivered','failed','unknown') then raise exception 'Invalid delivery outcome';end if;
 perform 1 from public.atlas_reminders where reminder_id=p_reminder_id for update;
 update public.atlas_reminder_logs set delivery_phase=p_outcome,delivery_status=case when p_outcome='delivered' then 'delivered' else 'failed' end,
 message_text=coalesce(p_message,message_text),
 delivered_at=case when p_outcome='delivered' then clock_timestamp() else null end,
 error_message=case when p_outcome='unknown' then 'Delivery outcome unknown; reconcile before retry' when p_outcome='failed' then 'Provider explicitly rejected delivery' else null end
 where reminder_id=p_reminder_id and delivery_token=p_token and delivery_phase in ('sending','unknown')
 returning delivery_generation,log_id into generation,delivery_id;
 if not found then return false;end if;
 if p_outcome='delivered' and generation like 'event:%' and not exists(
   select 1 from public.atlas_reminder_logs where reminder_id=p_reminder_id and delivery_generation=generation and delivery_phase='delivered' and log_id<>delivery_id
 ) then update public.atlas_reminders set trigger_count=coalesce(trigger_count,0)+1,last_triggered_at=clock_timestamp() where reminder_id=p_reminder_id;end if;
 return true;
end $$;
create or replace function public.trigger_reminder_generation(p_reminder_id bigint,p_expected_trigger integer)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or coalesce(r.trigger_count,0)<>p_expected_trigger then return false;end if;
 perform public.trigger_reminder(p_reminder_id);
 return true;
end $$;
-- Operator-only reconciliation. It does not send or rewind a reminder schedule.
-- Replaying requires an explicit targeted delivery of this original occurrence;
-- ordinary polling never resets an ambiguous or confirmed delivered result.
create or replace function public.allow_reminder_delivery_retry(p_log_id bigint,p_expected_token text,p_confirm_not_delivered boolean)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if p_confirm_not_delivered is distinct from true then raise exception 'Confirm provider did not deliver before retry';end if;
 update public.atlas_reminder_logs set delivery_phase='retryable',delivery_token=null,delivery_lease_until=null
 where log_id=p_log_id and delivery_token=p_expected_token and delivery_phase in ('failed','unknown');
 return found;
end $$;
revoke all on function public.allow_reminder_delivery_retry(bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.allow_reminder_delivery_retry(bigint,text,boolean) to service_role;
revoke all on function public.reminder_recipient_matches(jsonb,bigint,bigint),public.claim_reminder_delivery(bigint,text,integer,jsonb,bigint,text),public.start_reminder_delivery(bigint,text),public.finish_reminder_delivery(bigint,text,text,text),public.trigger_reminder_generation(bigint,integer) from public,anon;
grant execute on function public.reminder_recipient_matches(jsonb,bigint,bigint),public.claim_reminder_delivery(bigint,text,integer,jsonb,bigint,text),public.start_reminder_delivery(bigint,text),public.finish_reminder_delivery(bigint,text,text,text),public.trigger_reminder_generation(bigint,integer) to authenticated,service_role;
-- Preserve live leases / the current scheduled occurrence, not an unlimited log history.
-- Older completed generations and realtime events retain the existing 30-day cleanup.
-- Parent deletion still cascades because its row is invisible during the FK cascade.
create or replace function public.preserve_reminder_delivery_identity()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if old.delivery_key is not null and exists(select 1 from public.atlas_reminders r where r.reminder_id=old.reminder_id
   and (old.delivery_lease_until>clock_timestamp() or (r.status='active' and old.delivery_generation='scheduled:'||coalesce(r.trigger_count,0)::text))) then return null;end if;
 return old;
end $$;
drop trigger if exists preserve_reminder_delivery_identity on public.atlas_reminder_logs;
create trigger preserve_reminder_delivery_identity before delete on public.atlas_reminder_logs for each row execute function public.preserve_reminder_delivery_identity();
notify pgrst,'reload schema';

