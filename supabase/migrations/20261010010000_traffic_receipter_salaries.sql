-- Compact salary operands only for acts already selected by the profit report.
create or replace function public.traffic_receipter_salaries(p_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if coalesce(cardinality(p_ids),0)>200 then raise exception 'At most 200 act IDs'; end if;
 if coalesce(cardinality(p_ids),0)=0 then return '[]'::jsonb; end if;
 with staff as (select slyusar_id,public.sto_read_object_v1(to_jsonb(data)) d from public.slyusars),
 entries as (
 select s.slyusar_id,day.key,entry.ordinality,entry.value r
 from staff s cross join lateral jsonb_each(case when jsonb_typeof(s.d->'Історія')='object' then s.d->'Історія' else '{}'::jsonb end) day
 cross join lateral jsonb_array_elements(case when jsonb_typeof(day.value)='array' then day.value else '[]'::jsonb end) with ordinality entry
 where s.d->>'Доступ'='Приймальник'
 )
 select coalesce(jsonb_agg(jsonb_build_object('Акт',r->'Акт','ЗарплатаЗапчастин',r->'ЗарплатаЗапчастин',
 'ЗарплатаРоботи',r->'ЗарплатаРоботи','ЗарплатаЗапчастистів',r->'ЗарплатаЗапчастистів') order by slyusar_id,key,ordinality),'[]'::jsonb)
 into result from entries where
 case when length(coalesce(r->>'Акт',''))<40 and r->>'Акт' ~ '^\s*[+]?[0-9]+(\.0+)?\s*$'
 then (r->>'Акт')::numeric=any(p_ids::numeric[]) else true end;
 -- Unusual legacy ID strings remain for exact JavaScript Number matching by caller.
 return result;
end $$;
grant execute on function public.traffic_receipter_salaries(bigint[]) to anon,authenticated;
