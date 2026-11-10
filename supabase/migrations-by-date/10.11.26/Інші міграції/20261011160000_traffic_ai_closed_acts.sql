-- Explicit full-history tools receive only their own fields, with an explicit end marker.
create or replace function public.traffic_ai_closed_act_page(p_mode text,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_mode not in ('maintenance','retention') or p_mode is null then raise exception 'Unknown closed-act projection';end if;
 with source as (
  select act_id,cars_id,client_id,date_on,date_off,case when jsonb_typeof(data::jsonb)='object' then data::jsonb else '{}'::jsonb end body
  from public.acts where date_off is not null
  order by date_on desc,act_id desc offset greatest(coalesce(p_offset,0),0) limit 201
 ), page as(select * from source order by date_on desc,act_id desc limit 200), projected as (
  select act_id,cars_id,client_id,date_on,date_off,
   jsonb_strip_nulls(jsonb_build_object('ПІБ',body->'ПІБ','Телефон',body->'Телефон','Марка',body->'Марка','Модель',body->'Модель','Авто',body->'Авто'))
   || case when p_mode='retention' then jsonb_build_object('Загальна сума',body->'Загальна сума')
   else jsonb_build_object('Держ. номер',body->'Держ. номер','Пробіг',body->'Пробіг','Роботи',
    case when jsonb_typeof(body->'Роботи')='array' then
     coalesce((select jsonb_agg(case when jsonb_typeof(w)='object' then jsonb_build_object('Робота',w->'Робота') else w end order by ord)
      from jsonb_array_elements(body->'Роботи') with ordinality a(w,ord)),'[]'::jsonb)
    else body->'Роботи' end) end data from page
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(projected) order by date_on desc,act_id desc) from projected),'[]'::jsonb),
  'has_more',(select count(*)>200 from source)) into result;
 return result;
end $$;
revoke all on function public.traffic_ai_closed_act_page(text,integer) from public;
grant execute on function public.traffic_ai_closed_act_page(text,integer) to anon,authenticated;
