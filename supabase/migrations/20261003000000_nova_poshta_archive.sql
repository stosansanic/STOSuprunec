begin;
create table if not exists public.novaposhta (
  ttn text primary key check (ttn ~ '^[0-9]{14}$'),
  data jsonb not null default '{}'::jsonb,
  raw_document jsonb not null default '{}'::jsonb,
  raw_tracking jsonb not null default '{}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  direction text generated always as (data->>'direction') stored,
  state text generated always as (data->>'state') stored,
  document_date text generated always as (data->>'document_date') stored,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists novaposhta_date on public.novaposhta(document_date desc,ttn);
create index if not exists novaposhta_state on public.novaposhta(direction,state);
alter table public.novaposhta enable row level security;
revoke all on public.novaposhta from public,anon,authenticated;
grant select,insert,update on public.novaposhta to service_role;

-- Preserve useful older values when the provider returns incomplete fields.
create or replace function public.np_archive_merge(p_old jsonb,p_new jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare result jsonb:=coalesce(p_old,'{}'::jsonb); k text; v jsonb; begin
  for k,v in select * from jsonb_each(coalesce(p_new,'{}'::jsonb)) loop
    if result->k = v then continue; end if;
    if v='null'::jsonb or v='""'::jsonb or v='[]'::jsonb then continue; end if;
    if jsonb_typeof(v)='object' then
      result:=jsonb_set(result,array[k],public.np_archive_merge(case when jsonb_typeof(result->k)='object' then result->k else '{}'::jsonb end,v),true);
    else result:=jsonb_set(result,array[k],v,true); end if;
  end loop;
  return result;
end $$;
revoke all on function public.np_archive_merge(jsonb,jsonb) from public,anon,authenticated;

-- Return only changed keys, including nested fields.
create or replace function public.np_archive_diff(p_old jsonb,p_new jsonb) returns jsonb
language plpgsql immutable set search_path=public,pg_temp as $$
declare patch jsonb:='{}'; k text; v jsonb; child jsonb; begin
  for k,v in select * from jsonb_each(p_new) loop
    if p_old->k is not distinct from v then continue; end if;
    if jsonb_typeof(v)='object' and jsonb_typeof(p_old->k)='object' then
      child:=public.np_archive_diff(p_old->k,v);
      if child<>'{}'::jsonb then patch:=patch||jsonb_build_object(k,child); end if;
    else patch:=patch||jsonb_build_object(k,v); end if;
  end loop;
  return patch;
end $$;
revoke all on function public.np_archive_diff(jsonb,jsonb) from public,anon,authenticated;

create or replace function public.np_archive_save(p_ttn text,p_data jsonb,p_raw jsonb,p_source text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
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

end $$;
revoke all on function public.np_archive_save(text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.np_archive_save(text,jsonb,jsonb,text) to service_role;

create or replace function public.np_online_act(p_employee integer,p_act bigint,p_ttn text default null,p_remove boolean default false,p_note text default '',p_direction text default 'unknown') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare items jsonb; snapshot jsonb; begin
  -- A row lock makes simultaneous additions/removals preserve unrelated TTNs.
  select coalesce(novaposhta,'[]'::jsonb) into items from public.acts where act_id=p_act for update;
  if not found or not coalesce(public.np_online_can_act(p_employee,p_act,p_ttn is not null),false) then raise exception 'ACT_FORBIDDEN'; end if;
  if jsonb_typeof(items)<>'array' then raise exception 'INVALID_ACT_TTNS'; end if;
  if p_ttn is not null then
    if p_ttn!~'^[0-9]{14}$' or p_direction not in ('incoming','outgoing','unknown') then raise exception 'INVALID_TTN'; end if;
    if not p_remove then
      -- A manually added TTN is saved in the archive even before its first API refresh.
      -- Existing provider data is never replaced by the act's minimal entry.
      insert into public.novaposhta(ttn,data)
      values(p_ttn,jsonb_build_object('id',p_ttn,'ttn',p_ttn,'direction',p_direction,'state','unknown'))
      on conflict(ttn) do nothing;
      select data||jsonb_build_object('raw_document',raw_document,'raw_tracking',raw_tracking,'history',history,'checked_at',last_seen_at) into snapshot from public.novaposhta where ttn=p_ttn;
      if not found then raise exception 'TTN_NOT_SAVED'; end if;
    end if;
    if p_remove then
      select coalesce(jsonb_agg(e),'[]'::jsonb) into items from jsonb_array_elements(items) e where coalesce(e->>'ttn',e#>>'{}')<>p_ttn;
    elsif not exists(select 1 from jsonb_array_elements(items) e where coalesce(e->>'ttn',e#>>'{}')=p_ttn) then
      items:=items||jsonb_build_array(jsonb_build_object('ttn',p_ttn,'note',left(coalesce(p_note,''),2000),'direction',p_direction,'shipment',snapshot));
    else
      select jsonb_agg(case when coalesce(e->>'ttn',e#>>'{}')=p_ttn then
        (case when jsonb_typeof(e)='object' then e else jsonb_build_object('ttn',p_ttn) end)||jsonb_build_object('shipment',snapshot)
        else e end order by ord) into items from jsonb_array_elements(items) with ordinality x(e,ord);
    end if;
    update public.acts set novaposhta=items where act_id=p_act;
  end if;
  -- Writes return the same compact view as reads; full copies stay in the act.
  select coalesce(jsonb_agg(case when jsonb_typeof(e)='object' and e ? 'shipment' then
    jsonb_set(e,'{shipment}',(e->'shipment')-'raw_document'-'raw_tracking'-'history') else e end order by ord),'[]'::jsonb)
    into items from jsonb_array_elements(items) with ordinality x(e,ord);
  return jsonb_build_object('items',items,'editable',public.np_online_can_act(p_employee,p_act,true));
end $$;
revoke all on function public.np_online_act(integer,bigint,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.np_online_act(integer,bigint,text,boolean,text,text) to service_role;



-- Existing tables only: narrow date scans and find linked acts without a full scan.
create index if not exists novaposhta_direction_date on public.novaposhta(direction,document_date desc nulls last,ttn);
create or replace function public.np_archive_act_numbers(p_items jsonb) returns text[]
language sql immutable parallel safe set search_path=public,pg_temp as $$
  select coalesce(array_agg(coalesce(e->>'ttn',e#>>'{}')),'{}'::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_items)='array' then p_items else '[]'::jsonb end) e;
$$;
-- Index numbers only, not the large snapshots or history stored beside them.
create index if not exists acts_novaposhta_numbers on public.acts using gin(public.np_archive_act_numbers(novaposhta));

-- One database round trip for a provider page; order locks to avoid batch deadlocks.
create or replace function public.np_archive_save_batch(p_entries jsonb) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; processed integer:=0; begin
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'INVALID_PAYLOAD'; end if;
  if jsonb_array_length(p_entries)>100 then raise exception 'BATCH_TOO_LARGE'; end if;
  for item in select value from jsonb_array_elements(p_entries) order by value->>'ttn',value->>'source' loop
    perform public.np_archive_save(item->>'ttn',item->'data',item->'raw',item->>'source');
    processed:=processed+1;
  end loop;
  return processed;
end $$;
revoke all on function public.np_archive_save_batch(jsonb) from public,anon,authenticated;
grant execute on function public.np_archive_save_batch(jsonb) to service_role;

-- Read the act's own snapshot without locking it or sending history for every TTN.
create or replace function public.np_archive_act_read(p_employee integer,p_act bigint,p_ttn text default null,p_full boolean default false) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare items jsonb; item jsonb; snapshot jsonb; begin
  if not coalesce(public.np_online_can_act(p_employee,p_act,false),false) then raise exception 'ACT_FORBIDDEN'; end if;
  select coalesce(novaposhta,'[]'::jsonb) into items from public.acts where act_id=p_act;
  if jsonb_typeof(items)<>'array' then raise exception 'INVALID_ACT_TTNS'; end if;
  if p_ttn is not null then
    select e into item from jsonb_array_elements(items) e where coalesce(e->>'ttn',e#>>'{}')=p_ttn limit 1;
    if item is null then raise exception 'ACT_FORBIDDEN'; end if;
    snapshot:=item->'shipment';
    if snapshot is null then
      select data||jsonb_build_object('checked_at',last_seen_at)||case when p_full then jsonb_build_object('raw_document',raw_document,'raw_tracking',raw_tracking,'history',history) else '{}'::jsonb end
        into snapshot from public.novaposhta where ttn=p_ttn;
    end if;
    if snapshot is null then raise exception 'TTN_NOT_SAVED'; end if;
    return case when p_full then snapshot else snapshot-'raw_document'-'raw_tracking'-'history' end;
  end if;
  select coalesce(jsonb_agg(case when jsonb_typeof(e)='object' and e ? 'shipment' then
    jsonb_set(e,'{shipment}',(e->'shipment')-'raw_document'-'raw_tracking'-'history') else e end order by ord),'[]'::jsonb)
    into items from jsonb_array_elements(items) with ordinality x(e,ord);
  return jsonb_build_object('items',items,'editable',public.np_online_can_act(p_employee,p_act,true));
end $$;
revoke all on function public.np_archive_act_read(integer,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.np_archive_act_read(integer,bigint,text,boolean) to service_role;


-- Read one compact page and its permitted act numbers in one database request.
create or replace function public.np_archive_list(p_employee integer,p_page integer default 1,p_from text default null,p_to text default null,p_direction text default null,p_act bigint default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  with candidates as (
    select n.ttn,n.data,n.last_seen_at,n.document_date,nullif(n.data#>>'{provider_details,created}','') as document_created from public.novaposhta n
    where (p_from is null or n.document_date>=p_from) and (p_to is null or n.document_date<=p_to)
      and (p_direction is null or n.direction=p_direction)
      and (p_act is null or exists(select 1 from public.acts a where a.act_id=p_act
        and public.np_archive_act_numbers(a.novaposhta) @> array[n.ttn]
        and public.np_online_can_act(p_employee,a.act_id,false)))
    order by n.document_date desc nulls last,document_created desc nulls last,n.ttn desc
    limit 21 offset ((greatest(1,p_page)::bigint-1)*20)
  ), page_rows as (
    select * from candidates order by document_date desc nulls last,document_created desc nulls last,ttn desc limit 20
  ), linked as (
    select n.*,coalesce((select jsonb_agg(a.act_id order by a.act_id) from public.acts a
      where public.np_archive_act_numbers(a.novaposhta) @> array[n.ttn]
        and public.np_online_can_act(p_employee,a.act_id,false)),'[]'::jsonb) act_ids
    from page_rows n
  )
  select jsonb_build_object('shipments',coalesce((select jsonb_agg(
    jsonb_build_object('state','unknown','direction','unknown')||data||jsonb_build_object('id',ttn,'ttn',ttn,'checked_at',last_seen_at,'act_ids',act_ids)
    order by document_date desc nulls last,document_created desc nulls last,ttn desc) from linked),'[]'::jsonb),
    'has_more',(select count(*)>20 from candidates),'page',greatest(1,p_page),'checked_at',(select max(last_seen_at) from page_rows));
$$;
revoke all on function public.np_archive_list(integer,integer,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.np_archive_list(integer,integer,text,text,text,bigint) to service_role;

notify pgrst,'reload schema';
commit;
