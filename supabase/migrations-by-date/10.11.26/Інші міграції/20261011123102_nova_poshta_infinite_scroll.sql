-- Requires the existing Nova Poshta archive. No new tables.
begin;
create or replace function public.np_archive_list_v2(
 p_employee integer,p_offset integer default 0,p_limit integer default 50,
 p_from text default null,p_to text default null,p_direction text default null,p_act bigint default null,
 p_query text default '',p_state text default null
) returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
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
$$;
revoke all on function public.np_archive_list_v2(integer,integer,integer,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.np_archive_list_v2(integer,integer,integer,text,text,text,bigint,text,text) to service_role;
notify pgrst,'reload schema';
commit;
