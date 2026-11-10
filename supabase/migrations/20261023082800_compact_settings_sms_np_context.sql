-- Edge request context only. No table, trigger, policy, or client-role grant changes.
begin;
-- Auth.getUser remains in the Edge handler on every request. Only service_role
-- may call this function with that verified Supabase identity.
create or replace function public.traffic_np_request_context(
 p_uid uuid,p_email text,p_mode text,p_employee bigint default null,p_name text default '',p_password text default '')
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog as $$
declare cfg jsonb; employee jsonb; verified record; employee_id bigint:=p_employee; role_name text; allowed boolean;
begin
 if p_uid is null or p_mode is null or p_mode not in ('discover','authenticate','session') then raise exception 'INVALID_CONTEXT';end if;
 if not exists(select 1 from public.whitelist where email=lower(coalesce(p_email,''))) then
  return jsonb_build_object('error','FORBIDDEN');end if;
 -- Denials are returned, so admitted password attempts retain their rate counter.
 if p_mode='authenticate' then
  if not public.np_online_rate('login:'||p_uid::text,5,300) then return jsonb_build_object('error','RATE_LIMIT');end if;
  select * into verified from public.verify_slyusar_password(p_name,p_password) limit 1;
  if not found or verified.is_valid is distinct from true then return jsonb_build_object('error','CREDENTIALS');end if;
  employee_id:=verified.slyusar_id;
 elsif p_mode='session' then
  if not public.np_online_rate('requests:'||p_uid::text,180,60) then return jsonb_build_object('error','RATE_LIMIT');end if;
 end if;
 select coalesce(novaposhta,'{}'::jsonb)-'_rate' into cfg from public.settings where setting_id=10;
 cfg:=coalesce(cfg,'{}'::jsonb);
 if p_mode='discover' then return jsonb_build_object('visible',coalesce(cfg#>array['access',coalesce(employee_id::text,'')]='true'::jsonb,false));end if;
 employee:=public.traffic_np_employee(employee_id);
 role_name:=coalesce(employee->>'role','');
 allowed:=case when cfg#>array['access',employee_id::text] is not null and cfg#>array['access',employee_id::text]<>'null'::jsonb
  then public.traffic_search_truthy(cfg#>array['access',employee_id::text]) else role_name in ('Адміністратор','Приймальник','Запчастист','Складовщик') end;
 if employee is null or (role_name<>'Адміністратор' and not coalesce(allowed,false)) then return jsonb_build_object('error','EMPLOYEE_FORBIDDEN');end if;
 return jsonb_build_object('actor',jsonb_build_object('id',employee_id,'name',coalesce(employee->>'name',''),'role',role_name),'config',cfg);
end $$;
revoke all on function public.traffic_np_request_context(uuid,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.traffic_np_request_context(uuid,text,text,bigint,text,text) to service_role;
notify pgrst,'reload schema';
commit;
