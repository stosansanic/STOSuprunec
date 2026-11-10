-- Isolated module. Does not rewrite acts, stock, settings or existing login RPCs.
begin;
create schema if not exists np_private;
revoke all on schema np_private from public, anon, authenticated;

create table public.np_connections (
  id integer primary key default 1 check (id = 1),
  name text not null default 'Нова пошта', phone text not null default '',
  enabled boolean not null default true, last_sync timestamptz,
  last_error text, incoming_capability text not null default 'manual',
  import_page integer not null default 1, import_from date,
  lock_token uuid, lock_until timestamptz, last_started timestamptz,
  updated_at timestamptz not null default now()
);
create table np_private.credentials (
  connection_id integer primary key references public.np_connections(id),
  encrypted_key text not null
);
create table public.np_access (
  employee_id integer primary key references public.slyusars(slyusar_id),
  allowed boolean not null, updated_at timestamptz not null default now()
);
create table public.np_sessions (
  token_hash text primary key, auth_uid uuid not null references auth.users(id) on delete cascade,
  employee_id integer not null references public.slyusars(slyusar_id),
  expires_at timestamptz not null default now() + interval '7 days'
);
create table public.np_rate_limits (
  bucket text primary key, started_at timestamptz not null default now(), attempts integer not null default 0
);
create table public.np_shipments (
  id uuid primary key default gen_random_uuid(), connection_id integer not null default 1 references public.np_connections(id),
  ttn text not null unique check(ttn ~ '^[0-9]{14}$'),
  direction text not null default 'unknown' check(direction in ('incoming','outgoing','unknown')),
  state text not null default 'unknown' check(state in ('created','transit','arrived','received','attention','cancelled','unknown')),
  description text not null default '', provider_description text not null default '',
  origin text not null default '', destination text not null default '', warehouse text not null default '',
  raw_code text not null default '', raw_status text not null default '',
  estimated_date date, document_date date, sent_date date, arrived_date date, received_date date,
  responsible_id integer references public.slyusars(slyusar_id),
  checked_at timestamptz, sync_error text, version integer not null default 1,
  terminal_confirmed boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  link_count integer not null default 0 check(link_count>=0),
  priority integer generated always as (case when direction='incoming' and state='arrived' then 0 else 1 end) stored
);
create index np_shipments_state_date on public.np_shipments(direction,state,estimated_date);
create index np_shipments_checked on public.np_shipments(checked_at nulls first);
create table public.np_act_links (
  shipment_id uuid not null references public.np_shipments(id),
  act_id bigint not null references public.acts(act_id),
  purpose text not null default 'Деталі до нас', note text not null default '', version integer not null default 1,
  updated_by integer references public.slyusars(slyusar_id), updated_at timestamptz not null default now(),
  primary key (shipment_id,act_id)
);
create index np_act_links_act on public.np_act_links(act_id);
create table public.np_events (
  id bigint generated always as identity primary key, shipment_id uuid not null references public.np_shipments(id),
  state text not null, raw_status text not null, notify boolean not null default false, observed_at timestamptz not null default now()
);
create index np_events_shipment on public.np_events(shipment_id,id desc);
create table public.np_reads (
  employee_id integer primary key references public.slyusars(slyusar_id), last_event_id bigint not null default 0
);
create table public.np_audit (
  id bigint generated always as identity primary key, employee_id integer,
  action text not null, target text, created_at timestamptz not null default now()
);
create table public.np_sync_runs (
  id uuid primary key, started_at timestamptz not null default now(), finished_at timestamptz,
  updated_count integer not null default 0, outcome text not null default 'running'
);
-- Realtime publishes only a revision counter. All actual data goes through server authorization.
create table public.np_revision (id integer primary key check(id=1), version bigint not null default 0);
insert into public.np_revision(id) values(1);

do $$ declare t text; begin
  foreach t in array array['np_connections','np_access','np_sessions','np_rate_limits','np_shipments','np_act_links','np_events','np_reads','np_audit','np_sync_runs','np_revision'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
grant select on public.np_revision to authenticated;
create policy np_revision_read on public.np_revision for select to authenticated using (true);
grant usage,select on sequence public.np_events_id_seq, public.np_audit_id_seq to service_role;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.np_revision;
  end if;
end $$;

create function public.np_touch() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin update public.np_revision set version=version+1 where id=1; return null; end $$;
create trigger np_shipments_touch after insert or update or delete on public.np_shipments for each statement execute function public.np_touch();
create trigger np_links_touch after insert or update or delete on public.np_act_links for each statement execute function public.np_touch();
create trigger np_connections_touch after insert or update on public.np_connections for each statement execute function public.np_touch();
create trigger np_reads_touch after insert or update on public.np_reads for each statement execute function public.np_touch();
create trigger np_access_touch after insert or update or delete on public.np_access for each statement execute function public.np_touch();

create function public.np_count_links() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then update public.np_shipments set link_count=link_count+1 where id=new.shipment_id;
  else update public.np_shipments set link_count=link_count-1 where id=old.shipment_id; end if;
  return null;
end $$;
create trigger np_link_count after insert or delete on public.np_act_links for each row execute function public.np_count_links();

create function public.np_secret(p_value text default null) returns text language plpgsql security definer set search_path=public,np_private,pg_temp as $$
declare result text; begin
  if p_value is not null then
    insert into np_private.credentials values(1,p_value) on conflict(connection_id) do update set encrypted_key=excluded.encrypted_key;
  end if;
  select encrypted_key into result from np_private.credentials where connection_id=1;
  return result;
end $$;

create function public.np_rate(p_bucket text,p_limit integer,p_seconds integer) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer; begin
  insert into public.np_rate_limits(bucket,attempts) values(p_bucket,1)
  on conflict(bucket) do update set
    attempts=case when np_rate_limits.started_at < now()-make_interval(secs=>p_seconds) then 1 else np_rate_limits.attempts+1 end,
    started_at=case when np_rate_limits.started_at < now()-make_interval(secs=>p_seconds) then now() else np_rate_limits.started_at end
  returning attempts into n;
  return n<=p_limit;
end $$;

create function public.np_claim_sync() returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare token uuid := gen_random_uuid(); begin
  update public.np_connections set lock_token=token,lock_until=now()+interval '3 minutes',last_started=now()
  where id=1 and enabled and (lock_until is null or lock_until<now()) and (last_started is null or last_started<now()-interval '60 seconds');
  if not found then return null; end if;
  insert into public.np_sync_runs(id) values(token);
  delete from public.np_sessions where expires_at<now();
  delete from public.np_rate_limits where started_at<now()-interval '1 day';
  delete from public.np_sync_runs where started_at<now()-interval '90 days';
  return token;
end $$;

create function public.np_apply_tracking(p_token uuid,p_id uuid,p_patch jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare old_row public.np_shipments; begin
  perform 1 from public.np_connections where id=1 and lock_token=p_token and lock_until>now() and enabled for update;
  if not found then raise exception 'SYNC_EXPIRED'; end if;
  select * into old_row from public.np_shipments where id=p_id for update;
  if not found then return; end if;
  update public.np_shipments set
    state=p_patch->>'state',raw_code=p_patch->>'raw_code',raw_status=p_patch->>'raw_status',
    origin=coalesce(p_patch->>'origin',origin),destination=coalesce(p_patch->>'destination',destination),
    warehouse=coalesce(p_patch->>'warehouse',warehouse),provider_description=coalesce(p_patch->>'provider_description',provider_description),
    estimated_date=coalesce((p_patch->>'estimated_date')::date,estimated_date),sent_date=coalesce((p_patch->>'sent_date')::date,sent_date),
    document_date=coalesce((p_patch->>'document_date')::date,document_date),
    arrived_date=coalesce((p_patch->>'arrived_date')::date,arrived_date),received_date=coalesce((p_patch->>'received_date')::date,received_date),
    terminal_confirmed=(old_row.state=p_patch->>'state' and p_patch->>'state' in ('received','cancelled') and old_row.checked_at is not null),
    checked_at=now(),sync_error=null,updated_at=now(),version=version+1 where id=p_id;
  if old_row.raw_code is distinct from p_patch->>'raw_code' or old_row.raw_status is distinct from p_patch->>'raw_status' then
    insert into public.np_events(shipment_id,state,raw_status,notify) values(p_id,p_patch->>'state',p_patch->>'raw_status',old_row.state<>'arrived' and p_patch->>'state'='arrived');
  end if;
end $$;

create function public.np_can_act(p_employee integer,p_act bigint,p_write boolean default false) returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
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

create function public.np_link(p_employee integer,p_shipment uuid,p_act bigint,p_version integer,p_remove boolean,p_note text,p_purpose text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare old_version integer; begin
  perform 1 from public.acts where act_id=p_act for update;
  if not public.np_can_act(p_employee,p_act,true) then raise exception 'ACT_FORBIDDEN'; end if;
  perform 1 from public.np_shipments where id=p_shipment for update;
  if not found then raise exception 'SHIPMENT_MISSING'; end if;
  select version into old_version from public.np_act_links where shipment_id=p_shipment and act_id=p_act for update;
  if coalesce(old_version,0)<>p_version then raise exception 'CONFLICT'; end if;
  if p_remove then delete from public.np_act_links where shipment_id=p_shipment and act_id=p_act;
  else
    insert into public.np_act_links(shipment_id,act_id,note,purpose,updated_by) values(p_shipment,p_act,left(p_note,2000),left(p_purpose,120),p_employee)
    on conflict(shipment_id,act_id) do update set note=excluded.note,purpose=excluded.purpose,updated_by=p_employee,updated_at=now(),version=np_act_links.version+1;
  end if;
  insert into public.np_audit(employee_id,action,target) values(p_employee,case when p_remove then 'unlink' else 'link' end,p_shipment::text||':'||p_act::text);
end $$;

create function public.np_search_acts(p_employee integer,p_query text) returns table(act_id bigint,label text,editable boolean) language sql stable security definer set search_path=public,pg_temp as $$
 select a.act_id::bigint,concat('#',a.act_id,' · ',c.data->>'Авто',' ',c.data->>'Номер авто'),public.np_can_act(p_employee,a.act_id,true)
 from public.acts a left join public.cars c on c.cars_id=a.cars_id
 where public.np_can_act(p_employee,a.act_id,false)
 and (a.act_id::text ilike '%'||p_query||'%' or concat(c.data->>'Авто',' ',c.data->>'Номер авто') ilike '%'||p_query||'%')
 order by a.act_id desc limit 30
$$;

create function public.np_act_labels(p_employee integer,p_ids bigint[]) returns table(act_id bigint,label text) language sql stable security definer set search_path=public,pg_temp as $$
 select a.act_id::bigint,concat('#',a.act_id,' · ',c.data->>'Авто',' ',c.data->>'Номер авто')
 from public.acts a left join public.cars c on c.cars_id=a.cars_id
 where a.act_id=any(p_ids) and public.np_can_act(p_employee,a.act_id,false)
$$;

create function public.np_mark_read(p_employee integer,p_event bigint) returns void language sql security definer set search_path=public,pg_temp as $$
 insert into public.np_reads(employee_id,last_event_id) values(p_employee,least(p_event,coalesce((select max(id) from public.np_events),0)))
 on conflict(employee_id) do update set last_event_id=greatest(np_reads.last_event_id,excluded.last_event_id)
$$;

-- Explicit service-only grants for every new RPC (including trigger helper).
do $$ declare f record; begin
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='public' and p.proname in ('np_touch','np_count_links','np_secret','np_rate','np_claim_sync','np_apply_tracking','np_can_act','np_link','np_search_acts','np_act_labels','np_mark_read') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
commit;
