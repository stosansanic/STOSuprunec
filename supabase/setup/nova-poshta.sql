-- Online Nova Poshta: only settings.novaposhta stores module configuration.
-- Safe on an existing installation or with only the application's base tables.
begin;
alter table public.settings add column if not exists novaposhta jsonb;
insert into public.settings(setting_id,data,novaposhta) values(10,false,'{}'::jsonb)
on conflict(setting_id) do nothing;
update public.settings set novaposhta=coalesce(novaposhta,'{}'::jsonb)||'{"schema_version":2}'::jsonb where setting_id=10;

create or replace function public.np_guard_settings_key() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    if tg_op='INSERT' then
      if new.novaposhta is not null then raise exception 'NP_SETTINGS_SERVER_ONLY'; end if;
    elsif tg_op='UPDATE' then
      if new.novaposhta is distinct from old.novaposhta or (old.novaposhta is not null and new.setting_id<>old.setting_id) then raise exception 'NP_SETTINGS_SERVER_ONLY'; end if;
    elsif old.novaposhta is not null then raise exception 'NP_SETTINGS_SERVER_ONLY'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists np_settings_key_guard on public.settings;
create trigger np_settings_key_guard before insert or update or delete on public.settings for each row execute function public.np_guard_settings_key();
revoke all on function public.np_guard_settings_key() from public,anon,authenticated;

create or replace function public.np_online_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID_CONFIG'; end if;
  insert into public.settings(setting_id,data,novaposhta) values(10,false,p_patch)
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta
  where settings.novaposhta is distinct from coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
end $$;
revoke all on function public.np_online_settings(jsonb) from public,anon,authenticated;
grant execute on function public.np_online_settings(jsonb) to service_role;

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
alter table public.acts add column if not exists novaposhta jsonb;
-- Preserve multiple existing TTNs; do not replace unexpected existing data.
do $$ begin
  if exists(select 1 from public.acts where novaposhta is not null and jsonb_typeof(novaposhta)<>'array') then
    raise exception 'acts.novaposhta must be a JSON array; existing data was not modified';
  end if;
end $$;
create or replace function public.np_online_can_act(p_employee integer,p_act bigint,p_write boolean default false) returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a public.acts; s jsonb; r text; allowed boolean; begin
  select data into s from public.slyusars where slyusar_id=p_employee;
  r:=s->>'Доступ';
  select * into a from public.acts where act_id=p_act;
  if not found then return false; end if;
  if p_write and (a.date_off is not null or coalesce((a.data->>'Заморожений')::boolean,false)) then return false; end if;
  if r='Адміністратор' then return true; end if;
  if r='Приймальник' then return a.pruimalnyk=s->>'Name'; end if;
  if r='Запчастист' then
    select coalesce((select "Запчастист" from public.settings where setting_id=12),false) and coalesce((select "Запчастист" from public.settings where setting_id=13),false) into allowed;
    if p_write then return allowed and coalesce((select "Запчастист" from public.settings where setting_id=22),false); end if;
    return allowed;
  end if;
  if r='Складовщик' then
    select coalesce((select "Складовщик" from public.settings where setting_id=9),false) and coalesce((select "Складовщик" from public.settings where setting_id=10),false) into allowed;
    if p_write then return allowed and coalesce((select "Складовщик" from public.settings where setting_id=19),false); end if;
    return allowed;
  end if;
  if r='Слюсар' then return exists(select 1 from jsonb_array_elements(coalesce(a.data->'Роботи','[]')) w where w->>'Слюсар'=s->>'Name'); end if;
  return false;
end $$;


revoke all on function public.np_online_can_act(integer,bigint,boolean) from public,anon,authenticated;
grant execute on function public.np_online_can_act(integer,bigint,boolean) to service_role;

create or replace function public.np_online_act(p_employee integer,p_act bigint,p_ttn text default null,p_remove boolean default false,p_note text default '',p_direction text default 'unknown') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare items jsonb; begin
  -- A row lock makes simultaneous additions/removals preserve unrelated TTNs.
  select coalesce(novaposhta,'[]'::jsonb) into items from public.acts where act_id=p_act for update;
  if not found or not coalesce(public.np_online_can_act(p_employee,p_act,p_ttn is not null),false) then raise exception 'ACT_FORBIDDEN'; end if;
  if jsonb_typeof(items)<>'array' then raise exception 'INVALID_ACT_TTNS'; end if;
  if p_ttn is not null then
    if p_ttn!~'^[0-9]{14}$' or p_direction not in ('incoming','outgoing','unknown') then raise exception 'INVALID_TTN'; end if;
    if p_remove then
      select coalesce(jsonb_agg(e),'[]'::jsonb) into items from jsonb_array_elements(items) e where coalesce(e->>'ttn',e#>>'{}')<>p_ttn;
    elsif not exists(select 1 from jsonb_array_elements(items) e where coalesce(e->>'ttn',e#>>'{}')=p_ttn) then
      items:=items||jsonb_build_array(jsonb_build_object('ttn',p_ttn,'note',left(coalesce(p_note,''),2000),'direction',p_direction));
    end if;
    update public.acts set novaposhta=items where act_id=p_act;
  end if;
  return jsonb_build_object('items',items,'editable',public.np_online_can_act(p_employee,p_act,true));
end $$;
revoke all on function public.np_online_act(integer,bigint,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.np_online_act(integer,bigint,text,boolean,text,text) to service_role;

-- Existing act saves may update other columns; TTNs use the authorized server RPC.
create or replace function public.np_online_guard_act() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    if tg_op='INSERT' then
      if new.novaposhta is not null and new.novaposhta<>'[]'::jsonb then raise exception 'NP_ACT_SERVER_ONLY'; end if;
    elsif new.novaposhta is distinct from old.novaposhta then raise exception 'NP_ACT_SERVER_ONLY';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists np_online_act_guard on public.acts;
create trigger np_online_act_guard before insert or update on public.acts for each row execute function public.np_online_guard_act();
revoke all on function public.np_online_guard_act() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
