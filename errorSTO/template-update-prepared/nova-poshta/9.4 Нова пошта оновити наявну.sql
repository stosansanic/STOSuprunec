-- NP UPDATE v2: SQL Editor only. Existing tables; paste the entire file.
begin;
-- Preserve useful older values when the provider returns incomplete fields.
create or replace function public.np_archive_merge(p_old jsonb,p_new jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $np_body$
declare result jsonb:=coalesce(p_old,'{}'::jsonb); k text; v jsonb; begin
  for k,v in select * from jsonb_each(coalesce(p_new,'{}'::jsonb)) loop
    if result->k = v then continue; end if;
    if v='null'::jsonb or v='""'::jsonb or v='[]'::jsonb then continue; end if;
    if jsonb_typeof(v)='object' then
      result:=jsonb_set(result,array[k],public.np_archive_merge(case when jsonb_typeof(result->k)='object' then result->k else '{}'::jsonb end,v),true);
    else result:=jsonb_set(result,array[k],v,true); end if;
  end loop;
  return result;
end $np_body$;

revoke all on function public.np_archive_merge(jsonb,jsonb) from public,anon,authenticated;

-- Return only changed keys, including nested fields.
create or replace function public.np_archive_diff(p_old jsonb,p_new jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $np_body$
declare patch jsonb:='{}'; k text; v jsonb; child jsonb; begin
  for k,v in select * from jsonb_each(p_new) loop
    if p_old->k is not distinct from v then continue; end if;
    if jsonb_typeof(v)='object' and jsonb_typeof(p_old->k)='object' then
      child:=public.np_archive_diff(p_old->k,v);
      if child<>'{}'::jsonb then patch:=patch||jsonb_build_object(k,child); end if;
    else patch:=patch||jsonb_build_object(k,v); end if;
  end loop;
  return patch;
end $np_body$;

revoke all on function public.np_archive_diff(jsonb,jsonb) from public,anon,authenticated;

-- Existing tables only: narrow date scans and find linked acts without a full scan.
create index if not exists novaposhta_direction_date on public.novaposhta(direction,document_date desc nulls last,ttn);

create or replace function public.np_archive_act_numbers(p_items jsonb) returns text[]
language sql immutable parallel safe set search_path=public,pg_temp as $np_body$
  select coalesce(array_agg(coalesce(e->>'ttn',e#>>'{}')),'{}'::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) e;
$np_body$;

-- Index numbers only, not the large snapshots or history stored beside them.
create index if not exists acts_novaposhta_numbers on public.acts using gin(public.np_archive_act_numbers(novaposhta));

-- One database round trip for a provider page; order locks to avoid batch deadlocks.
create or replace function public.np_archive_save_batch(p_entries jsonb) returns integer
language plpgsql security definer set search_path=public,pg_temp as $np_body$
declare item jsonb; processed integer:=0; begin
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'INVALID_PAYLOAD'; end if;
  if jsonb_array_length(p_entries)>100 then raise exception 'BATCH_TOO_LARGE'; end if;
  for item in select value from jsonb_array_elements(p_entries) order by value->>'ttn',value->>'source' loop
    perform public.np_archive_save(item->>'ttn',item->'data',item->'raw',item->>'source');
    processed:=processed+1;
  end loop;
  return processed;
end $np_body$;

revoke all on function public.np_archive_save_batch(jsonb) from public,anon,authenticated;

grant execute on function public.np_archive_save_batch(jsonb) to service_role;

notify pgrst,'reload schema';


-- Use the existing archive and act column. One TTN may belong to several acts.
alter table public.novaposhta add column if not exists act_ids bigint[] not null default '{}'::bigint[];
create index if not exists novaposhta_created_order on public.novaposhta(document_date desc nulls last,(nullif(data#>>'{provider_details,created}','')) desc nulls last,ttn desc);
create index if not exists novaposhta_act_ids on public.novaposhta using gin(act_ids);

-- Move old act objects to the archive before reducing acts.novaposhta to TTN strings.
lock table public.acts, public.novaposhta in share row exclusive mode;
do $np_body$
declare a record; e jsonb; number text; snapshot jsonb; numbers jsonb; begin
  for a in select act_id,novaposhta from public.acts where novaposhta is not null loop
    if jsonb_typeof(a.novaposhta)<>'array' then raise exception 'INVALID_ACT_TTNS'; end if;
    numbers:='[]'::jsonb;
    for e in select value from jsonb_array_elements(a.novaposhta) loop
      number:=case when jsonb_typeof(e)='string' then e#>>'{}' else e->>'ttn' end;
      if number is null or number!~'^[0-9]{14}$' then raise exception 'INVALID_ACT_TTN'; end if;
      snapshot:=case when jsonb_typeof(e->'shipment')='object' then e->'shipment' else '{}'::jsonb end;
      insert into public.novaposhta(ttn,data,raw_document,raw_tracking,history)
      values(number,(snapshot-'raw_document'-'raw_tracking'-'history')||jsonb_build_object('id',number,'ttn',number),
        coalesce(snapshot->'raw_document','{}'::jsonb),coalesce(snapshot->'raw_tracking','{}'::jsonb),coalesce(snapshot->'history','[]'::jsonb))
      on conflict(ttn) do nothing;
      if jsonb_typeof(e)='object' then
        -- Preserve all previously stored notes/snapshots in the archive's history.
        update public.novaposhta set history=history||jsonb_build_array(jsonb_build_object('observed_at',now(),'source','act_migration','act_id',a.act_id,'payload',e)) where ttn=number;
      end if;
      update public.novaposhta set act_ids=array_append(act_ids,a.act_id) where ttn=number and not (act_ids @> array[a.act_id]);
      if not (numbers @> jsonb_build_array(number)) then numbers:=numbers||jsonb_build_array(number); end if;
    end loop;
    if numbers is distinct from a.novaposhta then update public.acts set novaposhta=numbers where act_id=a.act_id; end if;
  end loop;
end $np_body$;

-- TTN links are metadata: closed/frozen acts retain their financial editing locks.
create or replace function public.np_online_can_link_act(p_employee integer,p_act bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $np_body$
declare role_name text; begin
  if not coalesce(public.np_online_can_act(p_employee,p_act,false),false) then return false; end if;
  select data->>'Доступ' into role_name from public.slyusars where slyusar_id=p_employee;
  if role_name='Запчастист' then
    return coalesce((select "Запчастист" from public.settings where setting_id=22),false);
  elsif role_name='Складовщик' then
    return coalesce((select "Складовщик" from public.settings where setting_id=19),false);
  end if;
  return true;
end $np_body$;
revoke all on function public.np_online_can_link_act(integer,bigint) from public,anon,authenticated;
grant execute on function public.np_online_can_link_act(integer,bigint) to service_role;

create or replace function public.np_archive_act_read(p_employee integer,p_act bigint,p_ttn text default null,p_full boolean default false) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $np_body$
declare numbers jsonb; items jsonb; snapshot jsonb; begin
  if not coalesce(public.np_online_can_act(p_employee,p_act,false),false) then raise exception 'ACT_FORBIDDEN'; end if;
  select coalesce(novaposhta,'[]'::jsonb) into numbers from public.acts where act_id=p_act;
  if p_ttn is not null then
    if not (numbers @> jsonb_build_array(p_ttn)) then raise exception 'ACT_FORBIDDEN'; end if;
    select jsonb_build_object('state','unknown','direction','unknown')||data||jsonb_build_object('checked_at',last_seen_at)
      ||case when p_full then jsonb_build_object('raw_document',raw_document,'raw_tracking',raw_tracking,'history',history) else '{}'::jsonb end
      into snapshot from public.novaposhta where ttn=p_ttn;
    if snapshot is null then raise exception 'TTN_NOT_SAVED'; end if;
    return snapshot;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('ttn',x.ttn,'shipment',jsonb_build_object('state','unknown','direction','unknown')||coalesce(n.data,'{}'::jsonb)||jsonb_build_object('id',x.ttn,'ttn',x.ttn,'checked_at',n.last_seen_at)) order by x.ord),'[]'::jsonb)
    into items from jsonb_array_elements_text(numbers) with ordinality x(ttn,ord) left join public.novaposhta n on n.ttn=x.ttn;
  return jsonb_build_object('items',items,'editable',public.np_online_can_link_act(p_employee,p_act));
end $np_body$;

create or replace function public.np_online_act(p_employee integer,p_act bigint,p_ttn text default null,p_remove boolean default false,p_note text default '',p_direction text default 'unknown') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $np_body$
declare items jsonb; updated_items jsonb; begin
  if p_ttn is null then return public.np_archive_act_read(p_employee,p_act); end if;
  if p_ttn!~'^[0-9]{14}$' or p_direction is null or p_direction not in ('incoming','outgoing','unknown') then raise exception 'INVALID_TTN'; end if;
  if not coalesce(public.np_online_can_link_act(p_employee,p_act),false) then raise exception 'ACT_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_ttn,0));
  select coalesce(novaposhta,'[]'::jsonb) into items from public.acts where act_id=p_act for update;
  if not found or not coalesce(public.np_online_can_link_act(p_employee,p_act),false) then raise exception 'ACT_FORBIDDEN'; end if;
  if p_remove then
    select coalesce(jsonb_agg(e order by ord),'[]'::jsonb) into updated_items from jsonb_array_elements(items) with ordinality x(e,ord) where e<>to_jsonb(p_ttn);
    update public.novaposhta set act_ids=array_remove(act_ids,p_act) where ttn=p_ttn and act_ids @> array[p_act];
  else
    insert into public.novaposhta(ttn,data,act_ids)
    values(p_ttn,jsonb_build_object('id',p_ttn,'ttn',p_ttn,'direction',p_direction,'state','unknown'),array[p_act])
    on conflict(ttn) do update set act_ids=array_append(novaposhta.act_ids,p_act) where not (novaposhta.act_ids @> array[p_act]);
    updated_items:=case when items @> jsonb_build_array(p_ttn) then items else items||jsonb_build_array(p_ttn) end;
  end if;
  if items is distinct from updated_items then update public.acts set novaposhta=updated_items where act_id=p_act; end if;
  return public.np_archive_act_read(p_employee,p_act);
end $np_body$;

create or replace function public.np_archive_list(p_employee integer,p_page integer default 1,p_from text default null,p_to text default null,p_direction text default null,p_act bigint default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $np_body$
  with candidates as (
    select n.ttn,n.data,n.act_ids,n.last_seen_at,n.document_date,nullif(n.data#>>'{provider_details,created}','') as document_created from public.novaposhta n
    where (p_from is null or n.document_date>=p_from) and (p_to is null or n.document_date<=p_to)
      and (p_direction is null or n.direction=p_direction)
      and (p_act is null or (n.act_ids @> array[p_act] and public.np_online_can_act(p_employee,p_act,false)))
    order by n.document_date desc nulls last,document_created desc nulls last,n.ttn desc limit 21 offset ((greatest(1,p_page)::bigint-1)*20)
  ), page_rows as (select * from candidates order by document_date desc nulls last,document_created desc nulls last,ttn desc limit 20)
  select jsonb_build_object('shipments',coalesce((select jsonb_agg(
    jsonb_build_object('state','unknown','direction','unknown')||data||jsonb_build_object('id',ttn,'ttn',ttn,'checked_at',last_seen_at,
      'act_ids',coalesce((select jsonb_agg(id order by id) from unnest(act_ids) id where public.np_online_can_act(p_employee,id,false)),'[]'::jsonb))
    order by document_date desc nulls last,document_created desc nulls last,ttn desc) from page_rows),'[]'::jsonb),
    'has_more',(select count(*)>20 from candidates),'page',greatest(1,p_page),'checked_at',(select max(last_seen_at) from page_rows));
$np_body$;
create or replace function public.np_archive_save(p_ttn text,p_data jsonb,p_raw jsonb,p_source text) returns void
language plpgsql security definer set search_path=public,pg_temp as $np_body$
declare previous public.novaposhta%rowtype; event jsonb;
  data_patch jsonb; raw_patch jsonb; raw_before jsonb; raw_after jsonb; begin
  if p_ttn is null or p_ttn!~'^[0-9]{14}$' or p_source is null or p_source not in ('document','tracking') then raise exception 'INVALID_TTN'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or jsonb_typeof(p_raw) is distinct from 'object' then raise exception 'INVALID_PAYLOAD'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_ttn,0));
  select * into previous from public.novaposhta where ttn=p_ttn;
  if not found then
    insert into public.novaposhta(ttn,data,raw_document,raw_tracking,history)
    values(p_ttn,public.np_archive_merge('{}',p_data)||jsonb_build_object('id',p_ttn,'ttn',p_ttn),
      case when p_source='document' then p_raw else '{}'::jsonb end,
      case when p_source='tracking' then p_raw else '{}'::jsonb end,
      jsonb_build_array(jsonb_build_object('observed_at',now(),'source',p_source,'payload',p_raw)));
  else
    raw_before:=case when p_source='document' then previous.raw_document else previous.raw_tracking end;
    -- Identical source data must not roll back fields updated by the other source.
    if raw_before=p_raw then
      -- New contact display fields can be derived from already known provider data.
      -- Do not overwrite status/cost from another source when its raw data is unchanged.
      p_data:=public.np_archive_merge('{}',jsonb_build_object(
        'sender_contact',p_data#>'{provider_details,sender_contact}',
        'sender_company',p_data#>'{provider_details,sender_company}',
        'recipient_contact',p_data#>'{provider_details,recipient_contact}',
        'recipient_company',p_data#>'{provider_details,recipient_company}'));
      if p_data='{}'::jsonb then return; end if;
      p_data:=jsonb_build_object('provider_details',p_data);
    end if;
    raw_after:=public.np_archive_merge(raw_before,p_raw);
    raw_patch:=public.np_archive_diff(raw_before,raw_after);
    data_patch:=public.np_archive_diff(previous.data,public.np_archive_merge(previous.data,p_data));
    if raw_patch='{}'::jsonb and data_patch='{}'::jsonb then return; end if;
    event:=jsonb_build_array(jsonb_build_object('observed_at',now(),'source',p_source,'changes',raw_patch,'data_changes',data_patch));
    -- One row update; include only JSON columns that actually changed.
    execute 'update public.novaposhta set history=history||$1,last_seen_at=now(),updated_at=now()'
      ||case when data_patch<>'{}'::jsonb then ',data=public.np_archive_merge(data,$2)' else '' end
      ||case when raw_patch<>'{}'::jsonb then
        case when p_source='document' then ',raw_document=public.np_archive_merge(raw_document,$3)'
        else ',raw_tracking=public.np_archive_merge(raw_tracking,$3)' end else '' end
      ||' where ttn=$4'
      using event,data_patch,raw_patch,p_ttn;
  end if;

end $np_body$;
revoke all on function public.np_archive_save(text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.np_archive_save(text,jsonb,jsonb,text) to service_role;


revoke all on function public.np_archive_act_read(integer,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.np_archive_act_read(integer,bigint,text,boolean) to service_role;
revoke all on function public.np_online_act(integer,bigint,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.np_online_act(integer,bigint,text,boolean,text,text) to service_role;
revoke all on function public.np_archive_list(integer,integer,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.np_archive_list(integer,integer,text,text,text,bigint) to service_role;
notify pgrst,'reload schema';

-- Compact suggestions from existing tables. No provider calls or date restriction.

create or replace function public.np_archive_link_options(
  p_employee integer,p_kind text default 'all',p_query text default '',p_page integer default 1
) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $np_body$
declare result jsonb; options jsonb; more boolean; query text:=coalesce(p_query,''); begin
  if p_kind is null or p_kind not in ('all','ttn','act') or length(query)>120
    or (p_kind<>'act' and query!~'^[0-9]{0,16}$')
    or p_page is null or p_page<1 or p_page>1000000 then raise exception 'INVALID_OPTIONS_QUERY'; end if;
  result:=jsonb_build_object('ttns','[]'::jsonb,'acts','[]'::jsonb,'ttns_has_more',false,'acts_has_more',false,'page',p_page);
  if p_kind in ('all','ttn') then
    with candidates as (
      select n.ttn,coalesce(n.direction,'unknown') as direction,
        left(coalesce(nullif(n.data->>'provider_description',''),n.data->>'description',''),180) as description,
        n.document_date,nullif(n.data#>>'{provider_details,created}','') as document_created
      from public.novaposhta n where query='' or n.ttn like '%'||query||'%'
      order by n.document_date desc nulls last,document_created desc nulls last,n.ttn desc
      limit 21 offset ((p_page::bigint-1)*20)
    ), page_rows as (
      select * from candidates order by document_date desc nulls last,document_created desc nulls last,ttn desc limit 20
    )
    select coalesce((select jsonb_agg(jsonb_build_object('ttn',ttn,'direction',direction,'description',description)
        order by document_date desc nulls last,document_created desc nulls last,ttn desc) from page_rows),'[]'::jsonb),
      (select count(*)>20 from candidates) into options,more;
    result:=result||jsonb_build_object('ttns',options,'ttns_has_more',more);
  end if;
  if p_kind in ('all','act') then
    with candidates as (
      select a.act_id,concat_ws(' · ','№'||a.act_id,details.client_name,details.car_name,details.plate,
        case when coalesce((a.data->>'Заморожений')::boolean,false) or coalesce((to_jsonb(a)->>'frozen')::boolean,false) then 'Заморожений'
          when a.date_off is not null then 'Закритий' end) as label
      from public.acts a
      left join public.cars car on car.cars_id=a.cars_id
      left join public.clients client on client.client_id=coalesce(a.client_id,car.client_id)
      cross join lateral (
        select coalesce(nullif(client.data->>'ПІБ',''),nullif(a.data->>'ПІБ','')) as client_name,
          coalesce(nullif(car.data->>'Авто',''),nullif(car.data->>'Автомобіль',''),
            nullif(concat_ws(' ',car.data->>'Марка',car.data->>'Модель'),''),
            nullif(a.data->>'Автомобіль',''),nullif(a.data->>'Авто',''),
            nullif(concat_ws(' ',a.data->>'Марка',a.data->>'Модель'),'')) as car_name,
          coalesce(nullif(car.data->>'Номер авто',''),nullif(car.data->>'Держ. номер',''),
            nullif(a.data->>'Номер авто',''),nullif(a.data->>'Держ. номер','')) as plate
      ) details
      where (query='' or strpos(lower(concat_ws(' ',a.act_id,details.client_name,details.car_name,details.plate)),lower(query))>0)
        and public.np_online_can_link_act(p_employee,a.act_id)
      order by a.act_id desc limit 21 offset ((p_page::bigint-1)*20)
    ), page_rows as (select * from candidates order by act_id desc limit 20)
    select coalesce((select jsonb_agg(jsonb_build_object('act_id',act_id,'label',label) order by act_id desc) from page_rows),'[]'::jsonb),
      (select count(*)>20 from candidates) into options,more;
    result:=result||jsonb_build_object('acts',options,'acts_has_more',more);
  end if;
  return result;
end $np_body$;
revoke all on function public.np_archive_link_options(integer,text,text,integer) from public,anon,authenticated;
grant execute on function public.np_archive_link_options(integer,text,text,integer) to service_role;
notify pgrst,'reload schema';

-- Narrow accounting read contract. No tables, writes, or privilege escalation.
create or replace function public.traffic_json_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = public
as $np_body$
begin
  if jsonb_typeof(p_value) = 'string' then
    p_value := (p_value #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(p_value) = 'object' then return p_value; end if;
  return '{}'::jsonb;
exception when invalid_text_representation then
  return '{}'::jsonb;
end;
$np_body$;

-- Edge authorization also supports legacy string-encoded employee JSON without
-- transferring the employee's payroll history. Service-role callers only.
create or replace function public.traffic_np_employee(p_id bigint)
returns jsonb language sql stable security invoker set search_path = public
as $np_body$
  select jsonb_build_object('slyusar_id', s.slyusar_id,
    'name', public.traffic_json_object(s.data::jsonb)->>'Name',
    'role', public.traffic_json_object(s.data::jsonb)->>'Доступ')
  from public.slyusars s where s.slyusar_id = p_id;
$np_body$;

revoke all on function public.traffic_np_employee(bigint) from public, anon, authenticated;

grant execute on function public.traffic_np_employee(bigint) to service_role;
-- Requires the existing Nova Poshta archive. No new tables.

create or replace function public.np_archive_list_v2(
 p_employee integer,p_offset integer default 0,p_limit integer default 50,
 p_from text default null,p_to text default null,p_direction text default null,p_act bigint default null,
 p_query text default '',p_state text default null
) returns jsonb language sql stable security invoker set search_path=public,pg_temp as $np_body$
 with candidates as (
  select n.ttn,n.data,n.act_ids,n.last_seen_at,n.document_date,
    nullif(n.data#>>'{provider_details,created}','') as document_created
  from public.novaposhta n
  where (p_from is null or n.document_date>=p_from) and (p_to is null or n.document_date<=p_to)
    and (p_direction is null or n.direction=p_direction)
    and (p_act is null or (n.act_ids @> array[p_act] and public.np_online_can_act(p_employee,p_act,false)))
    and (nullif(p_state,'') is null or coalesce(n.data->>'state','unknown')=p_state)
    and (coalesce(trim(p_query),'')='' or strpos(lower(concat_ws(' ',n.ttn,n.data->>'provider_description',n.data->>'origin',n.data->>'destination',
      (select string_agg('#'||id::text,' ') from unnest(n.act_ids) id where public.np_online_can_act(p_employee,id,false)))),lower(trim(p_query)))>0)
  order by n.document_date desc nulls last,document_created desc nulls last,n.ttn desc
  limit (least(50,greatest(1,p_limit))+1) offset greatest(0,p_offset)
 ), visible as (
  select * from candidates order by document_date desc nulls last,document_created desc nulls last,ttn desc
  limit least(50,greatest(1,p_limit))
 ) select jsonb_build_object(
  'shipments',coalesce((select jsonb_agg(
    jsonb_build_object('state','unknown','direction','unknown')||data||jsonb_build_object('id',ttn,'ttn',ttn,'checked_at',last_seen_at,
      'act_ids',coalesce((select jsonb_agg(id order by id) from unnest(act_ids) id where public.np_online_can_act(p_employee,id,false)),'[]'::jsonb))
    order by document_date desc nulls last,document_created desc nulls last,ttn desc) from visible),'[]'::jsonb),
  'has_more',(select count(*)>least(50,greatest(1,p_limit)) from candidates),
  'checked_at',(select max(last_seen_at) from visible));
$np_body$;
revoke all on function public.np_archive_list_v2(integer,integer,integer,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.np_archive_list_v2(integer,integer,integer,text,text,text,bigint,text,text) to service_role;
notify pgrst,'reload schema';

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
language plpgsql security definer set search_path=pg_catalog as $np_body$
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
end $np_body$;
revoke all on function public.np_online_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.np_online_rate(text,integer,integer) to service_role;
-- Repeated saves of an identical NP configuration must not publish settings.
create or replace function public.np_online_settings(p_patch jsonb) returns void
language plpgsql security definer set search_path=pg_catalog as $np_body$
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID_CONFIG'; end if;
  insert into public.settings(setting_id,data,novaposhta) values(10,false,p_patch)
  on conflict(setting_id) do update set novaposhta=coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta
  where settings.novaposhta is distinct from coalesce(settings.novaposhta,'{}'::jsonb)||excluded.novaposhta;
end $np_body$;
revoke all on function public.np_online_settings(jsonb) from public,anon,authenticated;
grant execute on function public.np_online_settings(jsonb) to service_role;
do $np_body$ begin
  if exists(select 1 from pg_attribute where attrelid='public.settings'::regclass and attname='novaposhta' and not attisdropped) then
    execute 'update public.settings set novaposhta=novaposhta-''_rate'' where novaposhta ? ''_rate''';
  end if;
end $np_body$;
-- END REALTIME NP RATE
commit;
