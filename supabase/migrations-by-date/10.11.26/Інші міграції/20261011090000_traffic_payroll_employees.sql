-- Read-only employee fields and histories for at most 200 explicitly selected acts.
-- Uses the strict JSON parser from 20261011080000_traffic_payroll_json.sql.
create or replace function public.traffic_payroll_employees(p_act_ids bigint[],p_offset integer default 0,p_employee_id bigint default null,p_name text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare employee record; parsed jsonb; result jsonb:='[]'; history jsonb; selected_history jsonb; bucket record; selected_entries jsonb; projection jsonb;
begin
 if coalesce(array_length(p_act_ids,1),0) not between 1 and 200 or exists(select 1 from unnest(p_act_ids)i where i is null or i<=0) then raise exception 'Expected 1–200 act IDs';end if;
 for employee in select slyusar_id,data from public.slyusars s
  where (p_employee_id is null or s.slyusar_id=p_employee_id)
   and (p_name is null or public.payroll_json_object(to_jsonb(s.data))->>'Name'=p_name)
  order by slyusar_id offset greatest(coalesce(p_offset,0),0) limit 200 loop
  parsed:=public.payroll_json_object(to_jsonb(employee.data));history:=coalesce(nullif(parsed->'Історія','null'::jsonb),'{}'::jsonb);selected_history:='{}';
  if jsonb_typeof(history) is distinct from 'object' then raise exception 'Некоректна історія зарплати';end if;
  for bucket in select * from jsonb_each(history) loop
   if jsonb_typeof(bucket.value) is distinct from 'array' then raise exception 'Некоректна дата історії зарплати';end if;
   select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into selected_entries
    from jsonb_array_elements(bucket.value) with ordinality
    where value->>'Акт'=any(array(select i::text from unnest(p_act_ids)i));
   if selected_entries<>'[]'::jsonb then selected_history:=selected_history||jsonb_build_object(bucket.key,selected_entries);end if;
  end loop;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into projection from jsonb_each(parsed)
   where key in ('Name','Доступ','Склад','ПроцентРоботи','ПроцентЗапчастин');
  projection:=projection||jsonb_build_object('Історія',selected_history);
  result:=result||jsonb_build_array(jsonb_build_object('slyusar_id',employee.slyusar_id,'data',projection));
 end loop;
 return result;
end $$;
revoke all on function public.traffic_payroll_employees(bigint[],integer,bigint,text) from public;
grant execute on function public.traffic_payroll_employees(bigint[],integer,bigint,text) to anon,authenticated;
notify pgrst,'reload schema';
