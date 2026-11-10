-- Compact dashboard per-act totals. Existing v1 stays compatible with older frontends.
create or replace function public.traffic_dashboard_data_v2(p_data jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare d jsonb:=public.sto_read_object_v1(p_data); result jsonb; rows jsonb; row_value jsonb;
  field text; amount double precision; quantity double precision; subtotal double precision; totals jsonb:='{}'; count_works integer:=0;
begin
 foreach field in array array['Роботи','Деталі'] loop
  rows:=case when jsonb_typeof(d->field)='array' then d->field else '[]'::jsonb end;
  if field='Роботи' then count_works:=jsonb_array_length(rows); end if;
  subtotal:=0;
  for row_value in select value from jsonb_array_elements(rows) loop
   if jsonb_typeof(row_value)<>'object' then return public.traffic_dashboard_data(p_data); end if;
   amount:=public.traffic_search_number(case when public.traffic_search_truthy(row_value->'Ціна') then row_value->'Ціна' else '0'::jsonb end);
   quantity:=public.traffic_search_number(case when public.traffic_search_truthy(row_value->'Кількість') then row_value->'Кількість' else '1'::jsonb end);
   if amount is null or quantity is null or amount::text in ('Infinity','-Infinity','NaN') or quantity::text in ('Infinity','-Infinity','NaN') then
    return public.traffic_dashboard_data(p_data);
   end if;
   subtotal:=subtotal+amount*quantity;
  end loop;
  totals:=totals||jsonb_build_object(case field when 'Роботи' then 'works' else 'details' end,subtotal);
 end loop;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result from jsonb_each(d)
 where key in ('ПІБ','Клієнт','Марка','Модель','Приймальник','Прибуток за роботу','Прибуток за деталі');
 return result||jsonb_build_object('__dashboard_totals',totals||jsonb_build_object('worksCount',count_works));
 exception when numeric_value_out_of_range then return public.traffic_dashboard_data(p_data);
end $$;
create or replace function public.traffic_dashboard_page_v2(p_from timestamptz,p_to timestamptz,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
   select a.act_id,a.date_on,a.date_off,a.client_id,a.cars_id,
     public.traffic_dashboard_data_v2(a.data::jsonb) data,
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
revoke all on function public.traffic_dashboard_data_v2(jsonb),public.traffic_dashboard_page_v2(timestamptz,timestamptz,bigint) from public;
grant execute on function public.traffic_dashboard_data_v2(jsonb),public.traffic_dashboard_page_v2(timestamptz,timestamptz,bigint) to anon,authenticated;
