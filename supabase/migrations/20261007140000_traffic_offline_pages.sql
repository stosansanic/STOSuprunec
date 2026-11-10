begin;
-- Hashes are computed under the caller's table permissions/RLS. The hash is
-- a change detector, never an authorization token. Existing tables only.
create or replace function public.traffic_offline_page(
  p_resource text,p_after bigint default null,p_hash text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare id_field text; columns_sql text; condition_sql text; sort_sql text;
  payload jsonb; digest text; more boolean; next_id bigint;
begin
  case p_resource
    when 'acts' then id_field:='act_id'; columns_sql:='n.*';
    when 'clients' then id_field:='client_id'; columns_sql:='n.client_id,n.data';
    when 'cars' then id_field:='cars_id'; columns_sql:='n.cars_id,n.client_id,n.data,n.is_deleted';
    when 'works' then id_field:='work_id'; columns_sql:='n.work_id,n.data';
    when 'details' then id_field:='detail_id'; columns_sql:='n.detail_id,n.data';
    when 'slyusars' then id_field:='slyusar_id'; columns_sql:='n.slyusar_id,n.data';
    else raise exception 'Unsupported offline resource';
  end case;
  if p_resource='acts' then
    if p_after is not null then raise exception 'Act offline profile is the latest 200 open acts'; end if;
    condition_sql:='n.date_off is null and public.sto_read_object_v1(n.data::jsonb)->''Заморожений'' is distinct from ''true''::jsonb';
    sort_sql:=format('n.%I desc',id_field);
  else
    condition_sql:=format('($1 is null or n.%I>$1)',id_field);
    if p_resource='cars' then condition_sql:=condition_sql||' and n.is_deleted is not true'; end if;
    sort_sql:=format('n.%I asc',id_field);
  end if;
  execute format('with page as (select %s from public.%I n where %s order by %s limit %s),
    visible as (select * from page order by %I %s limit 200)
    select coalesce((select jsonb_agg(to_jsonb(v) order by v.%I %s) from visible v),''[]''::jsonb),
      (select count(*)>200 from page),(select max(%I) from visible)',
    columns_sql,p_resource,condition_sql,sort_sql,case when p_resource='acts' then 200 else 201 end,
    id_field,case when p_resource='acts' then 'desc' else 'asc' end,
    id_field,case when p_resource='acts' then 'desc' else 'asc' end,id_field)
    into payload,more,next_id using p_after;
  digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
  return jsonb_build_object('hash',digest,'items',case when digest=p_hash then null else payload end,
    'count',jsonb_array_length(payload),'has_more',more,'next_cursor',next_id);
end;
$$;
revoke all on function public.traffic_offline_page(text,bigint,text) from public;
grant execute on function public.traffic_offline_page(text,bigint,text) to anon,authenticated;
commit;
