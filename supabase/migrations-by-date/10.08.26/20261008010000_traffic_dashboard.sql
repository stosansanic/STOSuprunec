begin;
create or replace function public.traffic_dashboard_data(p_data jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 with source as (select public.sto_read_object_v1(p_data) d)
 select coalesce((select jsonb_object_agg(key,value) from jsonb_each(d)
   where key in ('ПІБ','Клієнт','Марка','Модель','Приймальник','Прибуток за роботу','Прибуток за деталі')),'{}'::jsonb)
   || jsonb_build_object('Роботи',coalesce((select jsonb_agg(
      case when jsonb_typeof(w)='object' then (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
        from jsonb_each(w) where key in ('Ціна','Кількість')) else w end order by ord)
      from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]' end) with ordinality a(w,ord)),'[]'::jsonb),
     'Деталі',coalesce((select jsonb_agg(
      case when jsonb_typeof(w)='object' then (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
        from jsonb_each(w) where key in ('Ціна','Кількість')) else w end order by ord)
      from jsonb_array_elements(case when jsonb_typeof(d->'Деталі')='array' then d->'Деталі' else '[]' end) with ordinality a(w,ord)),'[]'::jsonb))
 from source;
$$;
create or replace function public.traffic_dashboard_page(p_from timestamptz,p_to timestamptz,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
   select a.act_id,a.date_on,a.date_off,a.client_id,a.cars_id,
     public.traffic_dashboard_data(a.data::jsonb) data,
     jsonb_build_object('ПІБ',public.sto_read_object_v1(cl.data::jsonb)->'ПІБ',
       'Клієнт',public.sto_read_object_v1(cl.data::jsonb)->'Клієнт') __client_data,
     jsonb_build_object('Авто',public.sto_read_object_v1(c.data::jsonb)->'Авто',
       'Марка',public.sto_read_object_v1(c.data::jsonb)->'Марка',
       'Модель',public.sto_read_object_v1(c.data::jsonb)->'Модель') __car_data
   from public.acts a left join public.clients cl on cl.client_id=a.client_id
   left join public.cars c on c.cars_id=a.cars_id and c.is_deleted is not true
   where ((a.date_on>=p_from and a.date_on<p_to) or (a.date_off>=p_from and a.date_off<p_to))
     and (p_before is null or a.act_id<p_before)
   order by a.act_id desc limit 101
 ), visible as (select * from page order by act_id desc limit 100)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by act_id desc) from visible v),'[]'::jsonb),
   'has_more',(select count(*)>100 from page),'next_cursor',(select min(act_id) from visible));
$$;
revoke all on function public.traffic_dashboard_data(jsonb) from public;
revoke all on function public.traffic_dashboard_page(timestamptz,timestamptz,bigint) from public;
grant execute on function public.traffic_dashboard_data(jsonb) to anon,authenticated;
grant execute on function public.traffic_dashboard_page(timestamptz,timestamptz,bigint) to anon,authenticated;
commit;
