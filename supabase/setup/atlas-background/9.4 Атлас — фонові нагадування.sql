-- SQL Editor, НЕ Edge Functions. Виконати весь файл один раз (можна повторно).
-- Чинна база СТО: потрібні atlas_reminders, atlas_reminder_logs, slyusars, settings,
-- execute_condition_query, trigger_reminder та встановлений Supabase Cron з базового 1.1.
-- Залежності атомарної доставки включено нижче. Історію не очищаємо.
-- Порядок: цей SQL -> check-reminders/index.ts із цієї папки -> оновлення сайту.
-- Для нового проєкту ці зміни також включено в повний файл 8.
begin;
create or replace function public.traffic_atlas_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare parsed jsonb;
begin
 if jsonb_typeof(p_value)='object' then return p_value;end if;
 if jsonb_typeof(p_value)='string' then
  begin parsed:=(p_value#>>'{}')::jsonb;
   if jsonb_typeof(parsed)='object' then return parsed;end if;
  exception when invalid_text_representation then return '{}'::jsonb;end;
 end if;
 return '{}'::jsonb;
end $$;
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


-- BEGIN ATLAS BACKGROUND 2026-10-23
-- Atlas: local Cron gate, private evaluation leases, compact SQL comparisons,
-- durable per-recipient app delivery. Install SQL before the matching Edge code.

create schema if not exists sto_atlas_private;
revoke all on schema sto_atlas_private from public,anon,authenticated;
create table if not exists sto_atlas_private.evaluations (
 reminder_id bigint primary key references public.atlas_reminders(reminder_id) on delete cascade,
 token text, generation integer, lease_until timestamptz
);
revoke all on sto_atlas_private.evaluations from public,anon,authenticated;
-- Preserve leases that were already running during installation.
insert into sto_atlas_private.evaluations
 select reminder_id,evaluation_token,evaluation_generation,evaluation_lease_until
 from public.atlas_reminders where evaluation_token is not null
 on conflict(reminder_id) do nothing;

create or replace function public.claim_reminder_evaluation(p_reminder_id bigint,p_expected_trigger integer)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;t text;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or coalesce(r.trigger_count,0)<>p_expected_trigger then return null;end if;
 if exists(select 1 from sto_atlas_private.evaluations where reminder_id=p_reminder_id and lease_until>clock_timestamp()) then return null;end if;
 t:=gen_random_uuid()::text;
 insert into sto_atlas_private.evaluations values(p_reminder_id,t,p_expected_trigger,clock_timestamp()+interval '90 seconds')
 on conflict(reminder_id) do update set token=excluded.token,generation=excluded.generation,lease_until=excluded.lease_until;
 return t;
end $$;
create or replace function public.finish_reminder_evaluation(p_reminder_id bigint,p_token text,p_success boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update sto_atlas_private.evaluations set lease_until=clock_timestamp()+case when p_success then interval '55 seconds' else interval '0 seconds' end
 where reminder_id=p_reminder_id and token=p_token;
 return found;
end $$;
revoke all on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_reminder_evaluation(bigint,integer),public.finish_reminder_evaluation(bigint,text,boolean) to service_role;

-- SQL results are compared in Postgres; unchanged results never cross HTTP.
-- Keep the existing SELECT validator, including its authorization and errors.
create or replace function public.traffic_reminder_condition(p_query text,p_previous_hash text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare result jsonb; fingerprint text;
begin
 result:=public.execute_condition_query(p_query);
 fingerprint:='pg-md5:'||md5(coalesce(result::text,'null'));
 if fingerprint=p_previous_hash then return jsonb_build_object('unchanged',true,'hash',fingerprint);end if;
 return jsonb_build_object('unchanged',false,'hash',fingerprint,'rows',result);
end $$;
revoke all on function public.traffic_reminder_condition(text,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_condition(text,text) to service_role;

-- Metadata patches cannot overwrite a rule edited while a condition was running.
create or replace function public.traffic_reminder_checkpoint(p_reminder_id bigint,p_token text,p_rule jsonb,p_patch jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if jsonb_typeof(p_patch)<>'object' then raise exception 'Invalid reminder patch';end if;
 update public.atlas_reminders r set meta=coalesce(r.meta,'{}'::jsonb)||p_patch
 where r.reminder_id=p_reminder_id and r.status not in ('paused','cancelled')
 and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=p_rule
 and exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=r.reminder_id and e.token=p_token and e.lease_until>clock_timestamp())
 and (coalesce(r.meta,'{}'::jsonb)||p_patch) is distinct from r.meta;
 return found;
end $$;
revoke all on function public.traffic_reminder_checkpoint(bigint,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.traffic_reminder_checkpoint(bigint,text,jsonb,jsonb) to service_role;

-- A stale worker must never advance a rule that was edited while it ran.
-- Schedule advancement and the result baseline commit in one transaction/RPC.
create or replace function public.traffic_reminder_complete(p_reminder_id bigint,p_token text,p_expected_trigger integer,p_rule jsonb,p_patch jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' then return false;end if;
 if not exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=p_reminder_id and e.token=p_token and e.lease_until>clock_timestamp()) then return false;end if;
 if jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel) is distinct from p_rule then return false;end if;
 if public.traffic_atlas_object(to_jsonb(r.schedule))->>'type' is distinct from 'realtime' then
  if coalesce(r.trigger_count,0)<>p_expected_trigger then return false;end if;
  perform public.trigger_reminder(p_reminder_id);
 end if;
 if p_patch<>'{}'::jsonb then perform public.traffic_reminder_checkpoint(p_reminder_id,p_token,p_rule,p_patch);end if;
 return true;
end $$;
create or replace function public.traffic_reminder_convert_rule(p_reminder_id bigint,p_token text,p_rule jsonb,p_query text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.atlas_reminders r set condition_query=p_query,schedule='{"type":"realtime"}',next_trigger_at=null,
  meta=coalesce(r.meta,'{}'::jsonb)||jsonb_build_object('condition_mode','server_realtime_sql','converted_from_json_realtime',true,'original_realtime_rule',r.condition_query)
 where r.reminder_id=p_reminder_id and r.status='active'
 and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=p_rule
 and exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=r.reminder_id and e.token=p_token and e.lease_until>clock_timestamp());
 return found;
end $$;
revoke all on function public.traffic_reminder_complete(bigint,text,integer,jsonb,jsonb),public.traffic_reminder_convert_rule(bigint,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_complete(bigint,text,integer,jsonb,jsonb),public.traffic_reminder_convert_rule(bigint,text,jsonb,text) to service_role;

create or replace function public.traffic_reminder_candidates(p_after bigint default null,p_at timestamptz default now())
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 with candidates as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.recipients,r.channel,r.priority,r.condition_query,
   r.schedule,r.trigger_count,r.created_by,coalesce(s.data->>'Name','—') creator_name,
   jsonb_strip_nulls(jsonb_build_object('condition_mode',r.meta->'condition_mode','last_result_hash',r.meta->'last_result_hash','last_delivery_generation',r.meta->'last_delivery_generation')) meta,r.next_trigger_at
  from public.atlas_reminders r left join public.slyusars s on s.slyusar_id=r.created_by
  left join sto_atlas_private.evaluations e on e.reminder_id=r.reminder_id
  where r.status='active' and (p_after is null or r.reminder_id>p_after)
   and (e.lease_until is null or e.lease_until<=p_at)
   and ((r.next_trigger_at is not null and r.next_trigger_at<=p_at) or
    (r.reminder_type='conditional' and r.condition_query is not null and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
     and (r.channel<>'app' or left(ltrim(r.condition_query),1)<>'{')))
  order by r.reminder_id limit 201
 ), page as(select * from candidates order by reminder_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(reminder_id) from page));
$$;
revoke all on function public.traffic_reminder_candidates(bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.traffic_reminder_candidates(bigint,timestamptz) to service_role;

-- Payload is sent only for actual occurrences, not on every background check.
alter table public.atlas_reminder_logs add column if not exists app_payload jsonb;
create index if not exists atlas_app_inbox_pending on public.atlas_reminder_logs(recipient_id,log_id)
 where channel='app' and delivery_phase in ('queued','claimed');
create or replace function public.traffic_reminder_queue_app(p_reminder_id bigint,p_token text,p_generation text,p_expected_trigger integer,p_rule jsonb,p_result_text text default null)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.atlas_reminders%rowtype;body jsonb;n integer;
begin
 select * into r from public.atlas_reminders where reminder_id=p_reminder_id for update;
 if not found or r.status<>'active' or r.channel not in ('app','both') then return 0;end if;
 if not exists(select 1 from sto_atlas_private.evaluations e where e.reminder_id=p_reminder_id and e.token=p_token and e.lease_until>clock_timestamp()) then raise exception 'Evaluation lease expired';end if;
 if jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel) is distinct from p_rule then raise exception 'Reminder rule changed';end if;
 if p_generation is null or p_generation !~ '^(scheduled:[0-9]+|event:[a-f0-9]{64})$' then raise exception 'Invalid app generation';end if;
 if p_generation like 'scheduled:%' and (p_generation<>'scheduled:'||p_expected_trigger::text or coalesce(r.trigger_count,0)<>p_expected_trigger) then raise exception 'Reminder occurrence changed';end if;
 if p_generation like 'event:%' and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type' is distinct from 'realtime' then raise exception 'Not a realtime reminder';end if;
 body:=jsonb_build_object('reminder_id',r.reminder_id,'title',r.title,'description',r.description,'priority',r.priority,
  'reminder_type',r.reminder_type,'created_by',r.created_by,'creator_name',coalesce((select data->>'Name' from public.slyusars where slyusar_id=r.created_by),'—'),
  'trigger_count',p_expected_trigger,'condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel,
  'meta',jsonb_build_object('condition_result_text',p_result_text));
 insert into public.atlas_reminder_logs(reminder_id,recipient_id,channel,message_text,delivery_status,delivery_key,delivery_generation,delivery_phase,app_payload)
 select r.reminder_id,s.slyusar_id,'app',r.title,'sent',md5(jsonb_build_array(p_generation,s.slyusar_id,'app')::text),p_generation,'queued',body
 from public.slyusars s where public.reminder_recipient_matches(r.recipients,r.created_by,s.slyusar_id)
 on conflict(reminder_id,delivery_key) where delivery_key is not null do nothing;
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function public.traffic_reminder_queue_app(bigint,text,text,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.traffic_reminder_queue_app(bigint,text,text,integer,jsonb,text) to service_role;

-- The caller's existing RLS still applies to both tables. Cursor pages are small.
create or replace function public.traffic_reminder_app_inbox(p_recipient_id bigint,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with pending as materialized (
  select l.log_id,l.delivery_generation,l.app_payload from public.atlas_reminder_logs l
  join public.atlas_reminders r on r.reminder_id=l.reminder_id
  where l.recipient_id=p_recipient_id and l.channel='app' and l.app_payload is not null
  and (p_after is null or l.log_id>p_after)
  and (l.delivery_phase='queued' or (l.delivery_phase='claimed' and l.delivery_lease_until<=now()))
  and r.status not in ('paused','cancelled') and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id)
  and jsonb_build_object('condition_query',r.condition_query,'schedule',r.schedule,'recipients',r.recipients,'channel',r.channel)=
      jsonb_build_object('condition_query',l.app_payload->'condition_query','schedule',l.app_payload->'schedule','recipients',l.app_payload->'recipients','channel',l.app_payload->'channel')
  order by l.log_id limit 21
 ), page as(select * from pending order by log_id limit 20)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by log_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>20 from pending),'next_cursor',(select max(log_id) from page),
  'retry_at',(select min(l.delivery_lease_until) from public.atlas_reminder_logs l
    join public.atlas_reminders r on r.reminder_id=l.reminder_id
    where l.recipient_id=p_recipient_id and l.channel='app' and l.app_payload is not null
    and l.delivery_phase='claimed' and l.delivery_lease_until>now() and r.status not in ('paused','cancelled')
    and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id)));
$$;
create or replace function public.traffic_reminder_watch_page(p_recipient_id bigint,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with matches as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.schedule,r.condition_query,r.recipients,r.channel,r.priority,r.status,
   r.created_by,r.next_trigger_at,r.trigger_count,'{}'::jsonb meta
  from public.atlas_reminders r where r.status='active' and (p_after is null or r.reminder_id>p_after)
  and r.reminder_type='conditional' and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
  and left(ltrim(r.condition_query),1)='{'
  and public.reminder_recipient_matches(r.recipients,r.created_by,p_recipient_id) order by r.reminder_id limit 101
 ), page as(select * from matches order by reminder_id limit 100)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>100 from matches),'next_cursor',(select max(reminder_id) from page));
$$;
revoke all on function public.traffic_reminder_app_inbox(bigint,bigint),public.traffic_reminder_watch_page(bigint,bigint) from public,anon;
grant execute on function public.traffic_reminder_app_inbox(bigint,bigint),public.traffic_reminder_watch_page(bigint,bigint) to authenticated,service_role;

-- Keep the configured project's HTTP command (including any existing auth).
-- The private table is neither an exposed API table nor a Realtime publication.
create table if not exists sto_atlas_private.cron_transport(singleton boolean primary key default true check(singleton),command text not null);
revoke all on sto_atlas_private.cron_transport from public,anon,authenticated;
do $$ declare cmd text;definition text;url text;
begin
 if to_regclass('cron.job') is null then raise exception 'Enable Supabase Cron before installing Atlas background optimization';end if;
 select command into cmd from cron.job where jobname='atlas_check_reminders_every_minute';
 if cmd is not null and cmd not like '%traffic_dispatch_reminders%' then
  insert into sto_atlas_private.cron_transport values(true,cmd) on conflict(singleton) do update set command=excluded.command;
 end if;
 if not exists(select 1 from sto_atlas_private.cron_transport) then
  select nullif("Загальні",'') into url from public.settings where setting_id=18;
  if url is not null then url:=rtrim(url,'/')||'/functions/v1/check-reminders';end if;
  if url is null and to_regprocedure('public.sync_atlas_reminder_cron_now()') is not null then
   select pg_get_functiondef('public.sync_atlas_reminder_cron_now()'::regprocedure) into definition;
   url:=substring(definition from 'https://[a-z0-9]+\.supabase\.co/functions/v1/check-reminders');
  end if;
  if url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/check-reminders$' then
   cmd:=format('select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-atlas-cron'',''check-reminders''),body:='' {"source":"pg_cron"}''::jsonb,timeout_milliseconds:=5000);',url);
   insert into sto_atlas_private.cron_transport values(true,cmd);
  end if;
 end if;
end $$;

create or replace function public.traffic_dispatch_reminders()
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare cmd text;
begin
 if not pg_try_advisory_xact_lock(710231,1) then return false;end if;
 if not exists(select 1 from public.atlas_reminders r left join sto_atlas_private.evaluations e using(reminder_id)
  where r.status='active' and (e.lease_until is null or e.lease_until<=now())
  and (r.next_trigger_at<=now() or (r.reminder_type='conditional' and r.condition_query is not null
   and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'
   and (r.channel<>'app' or left(ltrim(r.condition_query),1)<>'{')))) then return false;end if;
 select command into cmd from sto_atlas_private.cron_transport where singleton;
 if cmd is null then raise exception 'Atlas Cron transport is not configured: check Supabase URL in settings 18';end if;
 execute cmd;
 return true;
end $$;
revoke all on function public.traffic_dispatch_reminders() from public,anon,authenticated;
grant execute on function public.traffic_dispatch_reminders() to service_role;

create or replace function public.sync_atlas_reminder_cron_now()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare needs_job boolean;job bigint;cmd text;url text;
begin
 perform pg_advisory_xact_lock(710231,2);
 select exists(select 1 from public.atlas_reminders r where status='active' and
  (next_trigger_at is not null or (reminder_type='conditional' and condition_query is not null and public.traffic_atlas_object(to_jsonb(schedule))->>'type'='realtime'
   and (channel<>'app' or left(ltrim(condition_query),1)<>'{')))) into needs_job;
 select jobid,command into job,cmd from cron.job where jobname='atlas_check_reminders_every_minute';
 if needs_job then
  if not exists(select 1 from sto_atlas_private.cron_transport) then
   select nullif("Загальні",'') into url from public.settings where setting_id=18;
   if url ~ '^https://[a-z0-9]+\.supabase\.co/?$' then
    insert into sto_atlas_private.cron_transport values(true,format('select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''x-atlas-cron'',''check-reminders''),body:='' {"source":"pg_cron"}''::jsonb,timeout_milliseconds:=5000);',rtrim(url,'/')||'/functions/v1/check-reminders'));
   end if;
  end if;
  if job is null or cmd<>'select public.traffic_dispatch_reminders();' then
   perform cron.schedule('atlas_check_reminders_every_minute','* * * * *','select public.traffic_dispatch_reminders();');
  end if;
 elsif job is not null then perform cron.unschedule(job);end if;
end $$;
revoke all on function public.sync_atlas_reminder_cron_now() from public,anon;
grant execute on function public.sync_atlas_reminder_cron_now() to authenticated,service_role;
-- No cron bookkeeping for token/count/meta/updated_at-only updates.
drop trigger if exists trg_sync_atlas_reminder_cron on public.atlas_reminders;
drop trigger if exists trg_sync_atlas_reminder_cron_config on public.atlas_reminders;
create trigger trg_sync_atlas_reminder_cron after insert or delete on public.atlas_reminders for each statement execute function public.sync_atlas_reminder_cron_trigger();
create trigger trg_sync_atlas_reminder_cron_config after update of status,channel,next_trigger_at,schedule,condition_query on public.atlas_reminders for each statement execute function public.sync_atlas_reminder_cron_trigger();
select public.sync_atlas_reminder_cron_now();

-- Existing logs are also used by the planner. Add only when not already published.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='atlas_reminder_logs') then
  alter publication supabase_realtime add table public.atlas_reminder_logs;
 end if;
end $$;
notify pgrst,'reload schema';
-- END ATLAS BACKGROUND 2026-10-23
commit;
