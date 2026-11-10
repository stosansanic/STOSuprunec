begin;
-- Use the existing archive and act column. One TTN may belong to several acts.
alter table public.novaposhta add column if not exists act_ids bigint[] not null default '{}'::bigint[];
create index if not exists novaposhta_created_order on public.novaposhta(document_date desc nulls last,(nullif(data#>>'{provider_details,created}','')) desc nulls last,ttn desc);
create index if not exists novaposhta_act_ids on public.novaposhta using gin(act_ids);

-- Move old act objects to the archive before reducing acts.novaposhta to TTN strings.
lock table public.acts, public.novaposhta in share row exclusive mode;
do $$
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
end $$;

-- TTN links are metadata: closed/frozen acts retain their financial editing locks.
create or replace function public.np_online_can_link_act(p_employee integer,p_act bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare role_name text; begin
  if not coalesce(public.np_online_can_act(p_employee,p_act,false),false) then return false; end if;
  select data->>'Доступ' into role_name from public.slyusars where slyusar_id=p_employee;
  if role_name='Запчастист' then
    return coalesce((select "Запчастист" from public.settings where setting_id=22),false);
  elsif role_name='Складовщик' then
    return coalesce((select "Складовщик" from public.settings where setting_id=19),false);
  end if;
  return true;
end $$;
revoke all on function public.np_online_can_link_act(integer,bigint) from public,anon,authenticated;
grant execute on function public.np_online_can_link_act(integer,bigint) to service_role;

create or replace function public.np_archive_act_read(p_employee integer,p_act bigint,p_ttn text default null,p_full boolean default false) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end $$;

create or replace function public.np_online_act(p_employee integer,p_act bigint,p_ttn text default null,p_remove boolean default false,p_note text default '',p_direction text default 'unknown') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
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
end $$;

create or replace function public.np_archive_list(p_employee integer,p_page integer default 1,p_from text default null,p_to text default null,p_direction text default null,p_act bigint default null) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
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
$$;
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


revoke all on function public.np_archive_act_read(integer,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.np_archive_act_read(integer,bigint,text,boolean) to service_role;
revoke all on function public.np_online_act(integer,bigint,text,boolean,text,text) from public,anon,authenticated;
grant execute on function public.np_online_act(integer,bigint,text,boolean,text,text) to service_role;
revoke all on function public.np_archive_list(integer,integer,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.np_archive_list(integer,integer,text,text,text,bigint) to service_role;
notify pgrst,'reload schema';
commit;
