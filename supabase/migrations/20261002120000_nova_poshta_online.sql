-- Online Nova Poshta: only settings.novaposhta stores module configuration.
-- Safe on an existing installation or with only the application's base tables.
begin;
alter table public.settings add column if not exists novaposhta jsonb;
insert into public.settings(setting_id,data,novaposhta) values(10,false,'{}'::jsonb)
on conflict(setting_id) do nothing;
-- Preserve existing encrypted credentials and custom employee access before cleanup.
do $$ declare saved text; permissions jsonb; begin
  if to_regclass('np_private.credentials') is not null then
    execute 'select encrypted_key from np_private.credentials where connection_id=1' into saved;
    if saved is not null then
      update public.settings set novaposhta=jsonb_build_object('api_key_encrypted',saved)||coalesce(novaposhta,'{}'::jsonb) where setting_id=10;
    end if;
  end if;
  if to_regclass('public.np_access') is not null then
    execute 'select jsonb_object_agg(employee_id::text,allowed) from public.np_access' into permissions;
    if permissions is not null then
      update public.settings set novaposhta=coalesce(novaposhta,'{}'::jsonb)||jsonb_build_object('access',permissions) where setting_id=10;
    end if;
  end if;
end $$;
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
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
end $$;
revoke all on function public.np_online_settings(jsonb) from public,anon,authenticated;
grant execute on function public.np_online_settings(jsonb) to service_role;

-- Atomic, expiring login/request counters; no np_rate_limits or session table.
create or replace function public.np_online_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg jsonb; counters jsonb; entry jsonb; current_time_s bigint; attempts integer; expires bigint;
begin
  if p_limit<1 or p_seconds<1 or p_seconds>3600 or length(p_bucket)>200 then raise exception 'INVALID_RATE'; end if;
  current_time_s:=extract(epoch from now())::bigint;
  select coalesce(novaposhta,'{}'::jsonb) into cfg from public.settings where setting_id=10 for update;
  if not found then raise exception 'NP_SETTINGS_MISSING'; end if;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into counters
    from jsonb_each(coalesce(cfg->'_rate','{}'::jsonb)) where (value->>'expires')::bigint>current_time_s;
  entry:=counters->p_bucket;
  attempts:=coalesce((entry->>'attempts')::integer,0);
  expires:=coalesce((entry->>'expires')::bigint,current_time_s+p_seconds);
  if attempts>=p_limit then return false; end if;
  counters:=counters||jsonb_build_object(p_bucket,jsonb_build_object('attempts',attempts+1,'expires',expires));
  update public.settings set novaposhta=jsonb_set(cfg,'{_rate}',counters) where setting_id=10;
  return true;
end $$;
revoke all on function public.np_online_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.np_online_rate(text,integer,integer) to service_role;
alter table public.acts add column if not exists novaposhta jsonb;
-- Preserve multiple existing TTNs; do not replace unexpected existing data.
do $$ begin
  if exists(select 1 from public.acts where novaposhta is not null and jsonb_typeof(novaposhta)<>'array') then
    raise exception 'acts.novaposhta must be a JSON array; existing data was not modified';
  end if;
end $$;
-- Move old links before any legacy tables are removed. Re-running does not duplicate TTNs.
do $$ begin
  if to_regclass('public.np_act_links') is not null and to_regclass('public.np_shipments') is not null then
    execute $migration$
      update public.acts a set novaposhta=coalesce(a.novaposhta,'[]'::jsonb)||(
        select jsonb_agg(jsonb_build_object('ttn',s.ttn,'note',l.note,'purpose',l.purpose,'direction',s.direction))
        from public.np_act_links l join public.np_shipments s on s.id=l.shipment_id
        where l.act_id=a.act_id and not exists(select 1 from jsonb_array_elements(coalesce(a.novaposhta,'[]'::jsonb)) e where coalesce(e->>'ttn',e#>>'{}')=s.ttn)
      ) where exists(
        select 1 from public.np_act_links l join public.np_shipments s on s.id=l.shipment_id
        where l.act_id=a.act_id and not exists(select 1 from jsonb_array_elements(coalesce(a.novaposhta,'[]'::jsonb)) e where coalesce(e->>'ttn',e#>>'{}')=s.ttn)
      )
    $migration$;
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
