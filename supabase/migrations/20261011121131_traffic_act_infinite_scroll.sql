-- Requires traffic_act_search and its read helpers. Keeps the old RPC for older clients.
begin;
create or replace function public.traffic_act_search_page_v2(
 p_from timestamptz default null,p_to timestamptz default null,p_mode text default null,
 p_filters jsonb default '[]',p_offset integer default 0,p_sort text default 'id',p_limit integer default 50
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
begin
 if p_limit is null or p_limit not in (5,50) then raise exception 'Invalid page size';end if;
 if p_offset<0 or p_offset is null or p_sort not in ('id','open','created','closed') or p_sort is null then raise exception 'Invalid search page';end if;
 if jsonb_typeof(p_filters)<>'array' or jsonb_array_length(p_filters)>50 then raise exception 'Invalid search filters';end if;
 if p_mode is not null and p_mode not in ('open','closed','frozen') then raise exception 'Invalid search mode';end if;
 return (with candidates as materialized (
  select a.act_id,a.date_on,a.date_off,to_jsonb(a) a,cl.client_id,cl.data::jsonb client_data,c.cars_id,c.data::jsonb car_data
  from public.acts a left join public.clients cl on cl.client_id=a.client_id left join public.cars c on c.cars_id=a.cars_id
  where case p_mode when 'open' then a.date_off is null when 'closed' then a.date_off is not null when 'frozen' then true
    else p_from is not null and p_to is not null and a.date_on>=p_from and a.date_on<=p_to end
   and case when p_mode='frozen' then public.sto_read_object_v1(a.data::jsonb)->'Заморожений'='true'::jsonb
     when p_mode in ('open','closed') then coalesce(public.sto_read_object_v1(a.data::jsonb)->'Заморожений'<>'true'::jsonb,true) else true end
 ), matched as materialized (
  select * from candidates where public.traffic_act_search_match(a,client_data,car_data,p_filters)
 ), page as (
  select * from matched order by
    case when p_sort='open' then (date_off is null)::integer end desc nulls last,
    case when p_sort='closed' then (date_off is not null)::integer end desc nulls last,
    case when p_sort='closed' then coalesce(date_off,date_on,'epoch'::timestamptz) when p_sort='created' then coalesce(date_on,'epoch'::timestamptz) end desc nulls last,
    act_id desc offset p_offset limit p_limit
 ) select jsonb_build_object(
 'items',coalesce((select jsonb_agg(
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.a) where key=any(array[
     'act_id','date_on','date_off','cars_id','client_id','pruimalnyk','slusarsOn','sms','avans','rosraxovano',
     'contrAgent_act','contrAgent_act_data','contrAgent_raxunok','contrAgent_raxunok_data','total','amount']))
   || jsonb_build_object('__sto_projection','act-search-v1','data',
     case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'data'))='object' then public.sto_act_list_data_v1(p.a->'data')-'Роботи'-'Деталі' else p.a->'data' end)
   || case when p.a ? 'info' then jsonb_build_object('info',case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'info'))='object' then public.sto_act_list_data_v1(p.a->'info')-'Роботи'-'Деталі' else p.a->'info' end) else '{}'::jsonb end
   || case when p.a ? 'details' then jsonb_build_object('details',case when jsonb_typeof(public.sto_act_list_data_v1(p.a->'details'))='object' then public.sto_act_list_data_v1(p.a->'details')-'Роботи'-'Деталі' else p.a->'details' end) else '{}'::jsonb end
 order by
    case when p_sort='open' then (p.date_off is null)::integer end desc nulls last,
    case when p_sort='closed' then (p.date_off is not null)::integer end desc nulls last,
    case when p_sort='closed' then coalesce(p.date_off,p.date_on,'epoch'::timestamptz) when p_sort='created' then coalesce(p.date_on,'epoch'::timestamptz) end desc nulls last,
    p.act_id desc
 ) from page p),'[]'::jsonb),
 'clients',coalesce((select jsonb_agg(distinct jsonb_build_object('client_id',client_id,'data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(client_data)) where key=any(array['ПІБ','Телефон'])))) from page where client_id is not null),'[]'::jsonb),
 'cars',coalesce((select jsonb_agg(distinct jsonb_build_object('cars_id',cars_id,'data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(car_data)) where key=any(array['Номер авто','Держ. номер','plate','number','Авто','Автомобіль','auto','car','name','Марка','brand','make','Модель','model'])))) from page where cars_id is not null),'[]'::jsonb),
 'total',(select count(*) from candidates),'matched',(select count(*) from matched),
 'has_more',p_offset+p_limit<(select count(*) from matched),
 'next_offset',case when p_offset+p_limit<(select count(*) from matched) then p_offset+p_limit else null end
 ));
end;
$$;
revoke all on function public.traffic_act_search_page_v2(timestamptz,timestamptz,text,jsonb,integer,text,integer) from public;
grant execute on function public.traffic_act_search_page_v2(timestamptz,timestamptz,text,jsonb,integer,text,integer) to anon,authenticated;


notify pgrst, 'reload schema';
commit;
