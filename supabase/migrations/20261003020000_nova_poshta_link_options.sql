-- Compact suggestions from existing tables. No provider calls or date restriction.
begin;
create or replace function public.np_archive_link_options(
  p_employee integer,p_kind text default 'all',p_query text default '',p_page integer default 1
) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
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
end $$;
revoke all on function public.np_archive_link_options(integer,text,text,integer) from public,anon,authenticated;
grant execute on function public.np_archive_link_options(integer,text,text,integer) to service_role;
notify pgrst,'reload schema';
commit;
