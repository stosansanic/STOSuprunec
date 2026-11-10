-- SQL Editor, not Edge Functions. Safe to reapply; preserves source-table RLS.
-- Compact columns are maintained in the same transaction as the business row.
begin;

create or replace function public.traffic_realtime_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
  if jsonb_typeof(p_value)='string' then
    begin p_value:=(p_value#>>'{}')::jsonb; exception when invalid_text_representation then return '{}'::jsonb; end;
  end if;
  return case when jsonb_typeof(p_value)='object' then p_value else '{}'::jsonb end;
end $$;
revoke all on function public.traffic_realtime_object(jsonb) from public;
grant execute on function public.traffic_realtime_object(jsonb) to anon,authenticated,service_role;

alter table public.acts add column if not exists traffic_state jsonb;
alter table public.post_arxiv add column if not exists traffic_previous jsonb;

create or replace function public.traffic_realtime_act_state(p_row jsonb, p_previous jsonb default null)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
  with doc as (select public.traffic_realtime_object(p_row->'data') d),
  prior as (select public.traffic_realtime_object(p_previous->'data') d)
  select jsonb_build_object(
    'frozen',coalesce(doc.d->'Заморожений'='true'::jsonb,false),
    'revision',md5((p_row-'traffic_state')::text),
    'act_revision',doc.d->>'__act_revision',
    'staff_revision',md5(jsonb_build_array(doc.d->'Роботи',doc.d->'Деталі',p_row->'pruimalnyk',doc.d->'__payroll_pending')::text),
    'summary',coalesce((select jsonb_object_agg(key,value) from jsonb_each(doc.d)
      where key=any(array['Номер авто','Держ. номер','Автомобіль','Авто','Марка',
        'Загальна сума','total','amount','Знижка','За деталі','За роботу','Дзвінок',
        'Примітки','Рекомендації','Причина звернення','Заморожений','Пробіг','__act_revision'])),'{}'::jsonb),
    'previous',case when p_previous is null then null else jsonb_build_object(
      'date_on',p_previous->'date_on','date_off',p_previous->'date_off',
      'slusarsOn',p_previous->'slusarsOn',
      'pruimalnyk',p_previous->'pruimalnyk','cars_id',p_previous->'cars_id','client_id',p_previous->'client_id',
      'frozen',coalesce(prior.d->'Заморожений'='true'::jsonb,false)) end
  ) from doc,prior;
$$;
revoke all on function public.traffic_realtime_act_state(jsonb,jsonb) from public;
grant execute on function public.traffic_realtime_act_state(jsonb,jsonb) to anon,authenticated,service_role;

create or replace function public.traffic_realtime_maintain_act_state()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if tg_op='INSERT' then new.traffic_state:=public.traffic_realtime_act_state(to_jsonb(new));
  elsif (to_jsonb(new)-'traffic_state') is not distinct from (to_jsonb(old)-'traffic_state') and old.traffic_state is not null then
    new.traffic_state:=old.traffic_state;
  else new.traffic_state:=public.traffic_realtime_act_state(to_jsonb(new),to_jsonb(old)); end if;
  return new;
end $$;
revoke all on function public.traffic_realtime_maintain_act_state() from public,anon,authenticated;
drop trigger if exists zz_traffic_realtime_act_state on public.acts;
create trigger zz_traffic_realtime_act_state before insert or update on public.acts
for each row execute function public.traffic_realtime_maintain_act_state();
-- No mass UPDATE/backfill: the next real change populates this column before
-- Realtime publishes the row. Installing the migration does not emit every act.

create or replace function public.traffic_realtime_maintain_booking_previous()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if tg_op='INSERT' then new.traffic_previous:=null;
  elsif (to_jsonb(new)-'traffic_previous') is not distinct from (to_jsonb(old)-'traffic_previous') then
    new.traffic_previous:=old.traffic_previous;
  else new.traffic_previous:=jsonb_build_object(
    'data_on',to_jsonb(old)->'data_on','data_off',to_jsonb(old)->'data_off',
    'name_post',to_jsonb(old)->'name_post','slyusar_id',to_jsonb(old)->'slyusar_id'); end if;
  return new;
end $$;
revoke all on function public.traffic_realtime_maintain_booking_previous() from public,anon,authenticated;
drop trigger if exists zz_traffic_realtime_booking_previous on public.post_arxiv;
create trigger zz_traffic_realtime_booking_previous before insert or update on public.post_arxiv
for each row execute function public.traffic_realtime_maintain_booking_previous();

create index if not exists atlas_reminder_latest_callback_idx
on public.atlas_reminder_logs(reminder_id,sent_at desc,log_id desc) where delivery_status='callback';
create or replace function public.traffic_reminder_latest_callbacks(p_reminder_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
  if coalesce(cardinality(p_reminder_ids),0)>500 then raise exception 'Too many reminder IDs' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from (
    select distinct on (reminder_id) reminder_id,message_text,sent_at,log_id
    from public.atlas_reminder_logs where reminder_id=any(p_reminder_ids) and delivery_status='callback'
    order by reminder_id,sent_at desc,log_id desc
  ) r),'[]'::jsonb);
end $$;
revoke all on function public.traffic_reminder_latest_callbacks(bigint[]) from public;
grant execute on function public.traffic_reminder_latest_callbacks(bigint[]) to authenticated,service_role;

-- BEGIN REALTIME NP RATE
-- Server-only counters must not UPDATE the settings row watched by every client.
lock table public.settings in share row exclusive mode;
create schema if not exists sto_realtime_private;
revoke all on schema sto_realtime_private from public,anon,authenticated;
create table if not exists sto_realtime_private.np_rate_buckets(
  bucket text primary key, attempts integer not null check(attempts>=0), expires_at timestamptz not null
);
alter table sto_realtime_private.np_rate_buckets enable row level security;
revoke all on sto_realtime_private.np_rate_buckets from public,anon,authenticated;
create index if not exists np_rate_bucket_expiry_idx on sto_realtime_private.np_rate_buckets(expires_at);
-- Preserve live limits on migration/reapply. Expired entries need not be imported.
insert into sto_realtime_private.np_rate_buckets(bucket,attempts,expires_at)
select e.key,(e.value->>'attempts')::integer,to_timestamp((e.value->>'expires')::double precision)
from public.settings s cross join lateral jsonb_each(
  case when jsonb_typeof(to_jsonb(s)#>'{novaposhta,_rate}')='object'
    then to_jsonb(s)#>'{novaposhta,_rate}' else '{}'::jsonb end) e
where s.setting_id=10 and e.value->>'attempts' ~ '^[0-9]{1,9}$'
  and e.value->>'expires' ~ '^[0-9]{1,12}$'
  and to_timestamp((e.value->>'expires')::double precision)>now()
on conflict(bucket) do update set attempts=greatest(np_rate_buckets.attempts,excluded.attempts),
  expires_at=greatest(np_rate_buckets.expires_at,excluded.expires_at);

create or replace function public.np_online_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare admitted boolean:=false; t timestamptz:=clock_timestamp();
begin
  if p_limit is null or p_limit<1 or p_seconds is null or p_seconds<1 or p_seconds>3600
    or p_bucket is null or length(p_bucket)=0 or length(p_bucket)>200 then raise exception 'INVALID_RATE'; end if;
  if not exists(select 1 from public.settings where setting_id=10) then raise exception 'NP_SETTINGS_MISSING'; end if;
  -- Expiry is indexed; only expired buckets are removed. Live requests contend
  -- on their own bucket instead of locking the single shared settings record.
  delete from sto_realtime_private.np_rate_buckets where expires_at<=t;
  insert into sto_realtime_private.np_rate_buckets as b(bucket,attempts,expires_at)
  values(p_bucket,1,t+make_interval(secs=>p_seconds))
  on conflict(bucket) do update set attempts=b.attempts+1 where b.attempts<p_limit
  returning true into admitted;
  return coalesce(admitted,false);
end $$;
revoke all on function public.np_online_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.np_online_rate(text,integer,integer) to service_role;
-- Repeated saves of an identical NP configuration must not publish settings.
create or replace function public.np_online_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID_CONFIG'; end if;
  insert into public.settings(setting_id,data,novaposhta) values(10,false,p_patch)
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta
  where settings.novaposhta is distinct from coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
end $$;
revoke all on function public.np_online_settings(jsonb) from public,anon,authenticated;
grant execute on function public.np_online_settings(jsonb) to service_role;
do $$ begin
  if exists(select 1 from pg_attribute where attrelid='public.settings'::regclass and attname='novaposhta' and not attisdropped) then
    execute 'update public.settings set novaposhta=novaposhta-''_rate'' where novaposhta ? ''_rate''';
  end if;
end $$;
-- END REALTIME NP RATE

-- A small capability handshake prevents projected subscribers from selecting
-- missing columns on projects which have not installed this migration yet.
create or replace function public.traffic_realtime_capabilities()
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('version',1);
$$;
revoke all on function public.traffic_realtime_capabilities() from public;
grant execute on function public.traffic_realtime_capabilities() to anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
