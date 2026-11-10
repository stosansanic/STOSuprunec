begin;
-- A chart reads financial operands only; visit pages additionally receive display fields.
-- Keep original JSON operands so browser fallback/rounding rules do not change.
create or replace function public.traffic_service_history_data(p_data jsonb,p_summary boolean)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 with source as (select public.sto_read_object_v1(p_data) d)
 select coalesce((select jsonb_object_agg(key,value) from jsonb_each(d)
   where key=any(case when p_summary then array['Пробіг','За роботу','За деталі']
     else array['Пробіг','За роботу','За деталі','Заморожений','Рекомендації','Причина звернення','__workshop_v1'] end)), '{}'::jsonb)
   || jsonb_build_object('Роботи',coalesce((select jsonb_agg(
     (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(w) where key=any(
       case when p_summary then array['Кількість','Ціна'] else array['Робота','Кількість','Ціна'] end))
     order by ord) from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]' end)
       with ordinality a(w,ord) where jsonb_typeof(w)='object'),'[]'::jsonb),
   'Деталі',coalesce((select jsonb_agg(
     (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(w) where key=any(
       case when p_summary then array['Кількість','Ціна'] else array['Деталь','Кількість','Ціна'] end))
     order by ord) from jsonb_array_elements(case when jsonb_typeof(d->'Деталі')='array' then d->'Деталі' else '[]' end)
       with ordinality a(w,ord) where jsonb_typeof(w)='object'),'[]'::jsonb))
 from source;
$$;
create or replace function public.traffic_service_history(
  p_car bigint, p_before jsonb default null, p_summary boolean default false
) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
   select act_id,date_on,date_off,client_id,cars_id,
     public.traffic_service_history_data(data::jsonb,p_summary) data
   from public.acts
   where cars_id=p_car and (p_before is null
     or (p_before->>'date_on' is null and date_on is not null)
     or (date_on is null and p_before->>'date_on' is null and act_id<(p_before->>'act_id')::bigint)
     or date_on<(p_before->>'date_on')::timestamptz
     or (date_on=(p_before->>'date_on')::timestamptz and act_id<(p_before->>'act_id')::bigint))
   order by date_on desc nulls first,act_id desc limit case when p_summary then 201 else 51 end
 ), visible as (select * from page order by date_on desc nulls first,act_id desc limit case when p_summary then 200 else 50 end)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by v.date_on desc nulls first,v.act_id desc) from visible v),'[]'::jsonb),
   'has_more',(select count(*)>case when p_summary then 200 else 50 end from page),
   'next_cursor',(select jsonb_build_object('date_on',date_on,'act_id',act_id) from visible order by date_on asc nulls last,act_id asc limit 1));
$$;
revoke all on function public.traffic_service_history_data(jsonb,boolean) from public;
revoke all on function public.traffic_service_history(bigint,jsonb,boolean) from public;
grant execute on function public.traffic_service_history_data(jsonb,boolean) to anon,authenticated;
grant execute on function public.traffic_service_history(bigint,jsonb,boolean) to anon,authenticated;
commit;
