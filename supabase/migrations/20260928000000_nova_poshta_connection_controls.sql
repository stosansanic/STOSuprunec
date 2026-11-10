-- Apply after 20260927000000_nova_poshta.sql.
-- settings.novaposhta holds the connection configuration; settings."Загальні" is untouched.
begin;
alter table public.np_connections add column if not exists needs_reconnect boolean not null default false;
alter table public.settings add column if not exists novaposhta jsonb;
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='settings' and column_name='novaposhta' and udt_name='jsonb') then
    raise exception 'settings.novaposhta must have type jsonb';
  end if;
end $$;
comment on column public.settings.novaposhta is 'Nova Poshta connection configuration, setting_id=10. api_key_encrypted is AES-GCM ciphertext; never store a plaintext key.';

create or replace function public.np_guard_settings_key() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    if tg_op='INSERT' then
      if new.novaposhta is not null then raise exception 'NP_SETTINGS_SERVER_ONLY'; end if;
    elsif tg_op='UPDATE' then
      if new.novaposhta is distinct from old.novaposhta
        or (old.novaposhta is not null and new.setting_id<>old.setting_id) then raise exception 'NP_SETTINGS_SERVER_ONLY'; end if;
    elsif old.novaposhta is not null then raise exception 'NP_SETTINGS_SERVER_ONLY';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists np_settings_key_guard on public.settings;
create trigger np_settings_key_guard before insert or update or delete on public.settings
for each row execute function public.np_guard_settings_key();
revoke all on function public.np_guard_settings_key() from public,anon,authenticated;

-- Mirror current connection metadata atomically, preserving the encrypted key.
-- Internal sync leases and worker sessions are never included in settings.
create or replace function public.np_sync_connection_settings() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare config jsonb; begin
  config:=jsonb_build_object('schema_version',1,'name',new.name,'phone',new.phone,
    'enabled',new.enabled,'needs_reconnect',new.needs_reconnect,'refresh_minutes',30,
    'last_sync',new.last_sync,'last_error',new.last_error,'incoming_capability',new.incoming_capability);
  insert into public.settings(setting_id,data,novaposhta) values(10,false,config)
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta
    where settings.novaposhta is distinct from (coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta);
  return null;
end $$;
drop trigger if exists np_connection_settings on public.np_connections;
create trigger np_connection_settings after insert or update of name,phone,enabled,needs_reconnect,last_sync,last_error,incoming_capability on public.np_connections
for each row execute function public.np_sync_connection_settings();
revoke all on function public.np_sync_connection_settings() from public,anon,authenticated;

create or replace function public.np_secret(p_value text default null) returns text language plpgsql security definer set search_path=public,np_private,pg_temp as $$
declare result text; begin
  if p_value is not null then
    insert into public.settings(setting_id,data,novaposhta) values(10,false,jsonb_build_object('schema_version',1,'api_key_encrypted',p_value))
    on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
    delete from np_private.credentials where connection_id=1;
  end if;
  select novaposhta->>'api_key_encrypted' into result from public.settings where setting_id=10;
  if result is null then select encrypted_key into result from np_private.credentials where connection_id=1; end if;
  return result;
end $$;
revoke all on function public.np_secret(text) from public,anon,authenticated;
grant execute on function public.np_secret(text) to service_role;

-- Populate metadata and migrate any existing encrypted credential.
update public.np_connections set name=name where id=1;
do $$ declare encrypted text; begin
  select encrypted_key into encrypted from np_private.credentials where connection_id=1;
  if encrypted is not null then perform public.np_secret(encrypted); end if;
end $$;

create or replace function public.np_change_connection(
  p_employee integer, p_action text, p_name text default null,
  p_phone text default null, p_encrypted text default null
) returns void language plpgsql security definer set search_path=public,np_private,pg_temp as $$
declare c public.np_connections; begin
  if not exists(select 1 from public.slyusars where slyusar_id=p_employee and data->>'Доступ'='Адміністратор') then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_action not in ('connect','disconnect','forget_key','save_settings','resume') then raise exception 'INVALID_ACTION'; end if;
  if p_action='connect' and (coalesce(length(p_encrypted),0)<30 or coalesce(p_phone,'') !~ '^380[0-9]{9}$') then
    raise exception 'INVALID_CONNECTION';
  end if;
  perform pg_advisory_xact_lock(20260928,1);
  select * into c from public.np_connections where id=1 for update;
  if c.lock_until>now() then raise exception 'SYNC_BUSY'; end if;
  if p_action in ('save_settings','resume') and public.np_secret() is null then raise exception 'NP_KEY_MISSING'; end if;
  if p_action='connect' then
    insert into public.np_connections(id,name,phone,enabled,needs_reconnect)
    values(1,coalesce(nullif(left(trim(p_name),100),''),'Нова пошта'),p_phone,true,false)
    on conflict(id) do update set name=excluded.name,phone=excluded.phone,enabled=true,
      needs_reconnect=false,last_error=null,lock_token=null,lock_until=null,
      import_page=1,import_from=null,last_started=null,last_sync=null,updated_at=now();
    perform public.np_secret(p_encrypted);
  elsif p_action='save_settings' then
    if coalesce(p_phone,'') !~ '^380[0-9]{9}$' then raise exception 'INVALID_CONNECTION'; end if;
    update public.np_connections set name=coalesce(nullif(left(trim(p_name),100),''),'Нова пошта'),phone=p_phone,updated_at=now() where id=1;
  elsif p_action='resume' then
    update public.np_connections set enabled=true,needs_reconnect=false,last_error=null,updated_at=now() where id=1;
  else
    update public.np_connections set enabled=false,lock_token=null,lock_until=null,updated_at=now() where id=1;
    if p_action='forget_key' then
      update public.settings set novaposhta=novaposhta-'api_key_encrypted' where setting_id=10;
      delete from np_private.credentials where connection_id=1;
      update public.np_connections set needs_reconnect=true,last_error='API-ключ видалено. Для оновлень підключіть Нову пошту повторно.' where id=1;
    end if;
  end if;
  insert into public.np_audit(employee_id,action,target) values(p_employee,p_action,'connection:1');
end $$;
revoke all on function public.np_change_connection(integer,text,text,text,text) from public,anon,authenticated;
grant execute on function public.np_change_connection(integer,text,text,text,text) to service_role;
commit;
