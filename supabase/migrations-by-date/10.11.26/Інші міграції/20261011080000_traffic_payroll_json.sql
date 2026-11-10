-- Pure strict JSON parser shared by payroll read and write contracts. No mutations.
create or replace function public.payroll_json_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p_value)='string' then p_value:=(p_value#>>'{}')::jsonb;end if;
 if jsonb_typeof(p_value) is distinct from 'object' then raise exception 'Некоректні дані зарплати' using errcode='40001';end if;
 return p_value;
end $$;


revoke all on function public.payroll_json_object(jsonb) from public;
grant execute on function public.payroll_json_object(jsonb) to anon,authenticated;
