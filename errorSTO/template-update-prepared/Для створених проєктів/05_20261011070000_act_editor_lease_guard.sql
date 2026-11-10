-- Install after write_act_with_stock. No tables, triggers or background write changes.
-- Ownership deliberately follows existing acquire_act_lock user_name semantics.
create or replace function public.assert_editor_act_lease(p_act_id integer,p_lock_owner text)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare held public.act_locks%rowtype;
begin
 if nullif(btrim(p_lock_owner),'') is null then raise exception 'Немає власника блокування акту' using errcode='55P03'; end if;
 select * into held from public.act_locks where act_id=p_act_id for update;
 if not found or held.user_name is distinct from p_lock_owner or held.heartbeat_at <= clock_timestamp()-interval '90 seconds' then
   raise exception 'Блокування акту втрачено. Введені дані не записано; відкрийте акт повторно.' using errcode='55P03';
 end if;
end $$;

create or replace function public.guarded_write_act_with_stock(p_act_id integer,p_expected jsonb,p_next jsonb,p_lock_owner text,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 return public.write_act_with_stock(p_act_id,p_expected,p_next,p_avans);
end $$;

create or replace function public.guarded_write_act_json(p_act_id integer,p_expected jsonb,p_next jsonb,p_lock_owner text,p_allow_closed boolean default false,p_allow_frozen boolean default false,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare current_row public.acts%rowtype; current_data jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into current_row from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001'; end if;
 current_data:=current_row.data;
 if jsonb_typeof(current_data)='string' then current_data:=(current_data#>>'{}')::jsonb; end if;
 if current_data is distinct from p_expected then raise exception 'Акт змінився. Відкрийте його повторно.' using errcode='40001'; end if;
 if (not p_allow_closed and current_row.date_off is not null) or (not p_allow_frozen and current_data->'Заморожений'='true'::jsonb) then
   raise exception 'Акт закритий або заморожений' using errcode='55000';
 end if;
 if jsonb_typeof(p_next) is distinct from 'object' then raise exception 'Некоректні дані акту'; end if;
 update public.acts set data=p_next,avans=coalesce(p_avans,avans) where act_id=p_act_id;
 return jsonb_build_object('act_id',p_act_id,'data',p_next,'cars_id',current_row.cars_id);
end $$;
revoke all on function public.assert_editor_act_lease(integer,text) from public,anon;
revoke all on function public.guarded_write_act_with_stock(integer,jsonb,jsonb,text,numeric) from public,anon;
revoke all on function public.guarded_write_act_json(integer,jsonb,jsonb,text,boolean,boolean,numeric) from public,anon;
grant execute on function public.assert_editor_act_lease(integer,text) to authenticated,service_role;
grant execute on function public.guarded_write_act_with_stock(integer,jsonb,jsonb,text,numeric) to authenticated,service_role;
grant execute on function public.guarded_write_act_json(integer,jsonb,jsonb,text,boolean,boolean,numeric) to authenticated,service_role;
notify pgrst,'reload schema';
