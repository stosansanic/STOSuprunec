-- SQL Editor. Requires the base STO schema and payroll_json_object.
begin;

create or replace function public.traffic_workshop_projection(p_data jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('__workshop_v1',d->'__workshop_v1','Рекомендації',d->'Рекомендації',
  'Заморожений',d->'Заморожений','__act_revision',d->'__act_revision',
  'Роботи',coalesce((select jsonb_agg(jsonb_build_object('Слюсар',w->'Слюсар'))
    from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]'::jsonb end) w),'[]'::jsonb))
 from (select public.payroll_json_object(p_data) d) s;
$$;

create or replace function public.traffic_workshop_act(p_act_id integer)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('act_id',a.act_id,'cars_id',a.cars_id,'date_off',a.date_off,
  'pruimalnyk',a.pruimalnyk,'data',public.traffic_workshop_projection(to_jsonb(a.data)))
 from public.acts a where a.act_id=p_act_id;
$$;

create or replace function public.traffic_workshop_entry_write(
 p_act_id integer,p_collection text,p_expected jsonb,p_next jsonb,p_employee_id bigint)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; section jsonb; rows jsonb; current_entry jsonb;
 employee jsonb; employee_name text; employee_role text; position integer; saved jsonb; rev text;
begin
 if auth.uid() is null then raise exception 'Потрібен вхід до програми' using errcode='42501';end if;
 select public.payroll_json_object(to_jsonb(s.data)) into employee from public.slyusars s where s.slyusar_id=p_employee_id;
 employee_name:=employee->>'Name'; employee_role:=employee->>'Доступ';
 if nullif(employee_name,'') is null then raise exception 'Працівника не знайдено' using errcode='42501';end if;
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if not (coalesce(employee_role='Адміністратор',false)
  or coalesce(employee_role='Приймальник' and a.pruimalnyk=employee_name,false)
  or coalesce(employee_role='Слюсар' and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(doc->'Роботи')='array' then doc->'Роботи' else '[]'::jsonb end) w where w->>'Слюсар'=employee_name),false)) then
  raise exception 'Працівник більше не має права редагувати цей акт' using errcode='42501';
 end if;
 if p_collection is null or p_collection not in ('defects','recommendations') then raise exception 'Невідомий розділ картки';end if;
 if p_collection='defects' and (a.date_off is not null or doc->>'Заморожений'='true') then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 if jsonb_typeof(p_next) is distinct from 'object' or nullif(p_next->>'id','') is null
   or nullif(p_next->>'updatedAt','') is null or p_next->>'author' is distinct from employee_name then raise exception 'Некоректний автор або запис картки';end if;
 if exists(select 1 from jsonb_each(p_next) e where jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}')>12000) then raise exception 'Некоректні поля картки';end if;
 if p_collection='recommendations' and (nullif(btrim(p_next->>'text'),'') is null or coalesce(p_next->>'state','') not in ('proposed','approved','completed','declined')) then raise exception 'Вкажіть рекомендацію та стан';end if;
 if p_collection='defects' and (nullif(btrim(p_next->>'component'),'') is null or coalesce(p_next->>'state','') not in ('inspect','good','repair','replace')) then raise exception 'Вкажіть вузол і стан';end if;
 section:=doc->'__workshop_v1';
 if section is null or section='null'::jsonb then section:='{"version":1,"defects":[],"recommendations":[]}'::jsonb;end if;
 if section->>'version' is distinct from '1' or jsonb_typeof(section->'defects') is distinct from 'array' or jsonb_typeof(section->'recommendations') is distinct from 'array' then raise exception 'Невідомий формат картки';end if;
 if exists(select 1 from jsonb_array_elements(section->'defects') e group by e->>'id' having count(*)>1 or e->>'id' is null)
   or exists(select 1 from jsonb_array_elements(section->'recommendations') e group by e->>'id' having count(*)>1 or e->>'id' is null) then raise exception 'Пошкоджені записи картки';end if;
 rows:=section->p_collection;
 select e.value,(e.ordinality-1)::integer into current_entry,position from jsonb_array_elements(rows) with ordinality e where e.value->>'id'=p_next->>'id';
 -- Identical retries neither duplicate the entry nor emit another update.
 if current_entry is distinct from p_next and current_entry is distinct from nullif(p_expected,'null'::jsonb) then raise exception 'Цей запис уже змінив інший працівник. Ваш текст залишено у формі.' using errcode='40001';end if;
 if current_entry is null and p_collection='recommendations' and nullif(p_next->>'sourceDefectId','') is not null and exists(select 1 from jsonb_array_elements(rows) e where e->>'sourceDefectId'=p_next->>'sourceDefectId') then raise exception 'Рекомендацію для цього дефекту вже створено' using errcode='40001';end if;
 if current_entry is distinct from p_next then
  rows:=case when position is null then rows||jsonb_build_array(p_next) else jsonb_set(rows,array[position::text],p_next,false) end;
  section:=jsonb_set(section,array[p_collection],rows,false);
  rev:=gen_random_uuid()::text;
  saved:=doc||jsonb_build_object('__workshop_v1',section,'__act_revision',rev);
  update public.acts set data=saved where act_id=p_act_id;
 else rev:=coalesce(doc->>'__act_revision','');end if;
 return jsonb_build_object('act_id',p_act_id,'entry',p_next,'revision',rev,'cars_id',a.cars_id,'date_off',a.date_off,'pruimalnyk',a.pruimalnyk,'frozen',coalesce(doc->>'Заморожений'='true',false));
end $$;

create or replace function public.traffic_workshop_recommendations(p_car_id integer,p_exclude_act integer,p_before bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (
  select a.act_id,a.cars_id,a.date_off,a.pruimalnyk,public.payroll_json_object(to_jsonb(a.data)) d
  from public.acts a where a.cars_id=p_car_id and a.act_id<>p_exclude_act and (p_before is null or a.act_id<p_before)
 ), matching as (
  select *,coalesce((select jsonb_agg(r order by ord) from jsonb_array_elements(case when jsonb_typeof(d#>'{__workshop_v1,recommendations}')='array' then d#>'{__workshop_v1,recommendations}' else '[]'::jsonb end) with ordinality e(r,ord) where r->>'state' in ('proposed','approved')),'[]'::jsonb) recommendations
  from candidates
 ), page as (
  select * from matching where recommendations<>'[]'::jsonb or (coalesce(d->>'Рекомендації','') not in ('','—') and coalesce(d#>'{__workshop_v1,recommendations}','[]'::jsonb)='[]'::jsonb) order by act_id desc limit 31
 ), visible as (select * from page order by act_id desc limit 30)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('act_id',act_id,'cars_id',cars_id,'date_off',date_off,'pruimalnyk',pruimalnyk,
  'data',jsonb_build_object('Рекомендації',d->'Рекомендації','Заморожений',d->'Заморожений','__workshop_v1',jsonb_build_object('version',1,'defects','[]'::jsonb,'recommendations',recommendations))) order by act_id desc) from visible),'[]'::jsonb),
  'has_more',(select count(*)>30 from page),'next_cursor',(select min(act_id) from visible));
$$;
revoke all on function public.traffic_workshop_projection(jsonb),public.traffic_workshop_act(integer),public.traffic_workshop_recommendations(integer,integer,bigint),public.traffic_workshop_entry_write(integer,text,jsonb,jsonb,bigint) from public,anon;
grant execute on function public.traffic_workshop_projection(jsonb),public.traffic_workshop_act(integer),public.traffic_workshop_recommendations(integer,integer,bigint),public.traffic_workshop_entry_write(integer,text,jsonb,jsonb,bigint) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
