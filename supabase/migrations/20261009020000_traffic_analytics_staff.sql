-- Read-only analytic salary operands. Original values/types/order and date keys retained.
create or replace function public.traffic_analytics_staff_data(p_data jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare result jsonb; history jsonb := '{}'::jsonb; day record; entry jsonb; entries jsonb; records jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' then return '{}'::jsonb; end if;
 result := jsonb_build_object('Name',p_data->'Name','Доступ',p_data->'Доступ');
 if jsonb_typeof(p_data->'Історія') is distinct from 'object' then
   return result || jsonb_build_object('Історія',p_data->'Історія');
 end if;
 for day in select * from jsonb_each(p_data->'Історія') loop
   if jsonb_typeof(day.value) <> 'array' then history := history || jsonb_build_object(day.key,day.value); continue; end if;
   entries := '[]'::jsonb;
   for entry in select value from jsonb_array_elements(day.value) loop
     if jsonb_typeof(entry) <> 'object' then entries := entries || jsonb_build_array(entry); continue; end if;
     records := entry->'Записи';
     if jsonb_typeof(records) = 'array' then
       select coalesce(jsonb_agg(case when jsonb_typeof(value)='object' then
         jsonb_build_object('Зарплата',value->'Зарплата') else value end order by ordinality),'[]'::jsonb)
         into records from jsonb_array_elements(records) with ordinality;
     end if;
     entries := entries || jsonb_build_array(jsonb_build_object('СуммаРоботи',entry->'СуммаРоботи','Записи',records));
   end loop;
   history := history || jsonb_build_object(day.key,entries);
 end loop;
 return result || jsonb_build_object('Історія',history);
end $$;
create or replace function public.traffic_analytics_staff(p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (select s.slyusar_id,s.data from public.slyusars s
   where p_after is null or s.slyusar_id>p_after order by s.slyusar_id limit 201),
 page as (select slyusar_id,public.traffic_analytics_staff_data(to_jsonb(data)) data
   from candidates order by slyusar_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by slyusar_id) from page p),'[]'::jsonb),
 'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(slyusar_id) from page))
$$;
grant execute on function public.traffic_analytics_staff(bigint) to anon,authenticated;
