-- Atomic act freeze/thaw. Run in SQL Editor after the payroll ledger and
-- act_editor_scoped_traffic migrations. No business data is changed on install.
-- Frozen accruals leave employee history; payment evidence is kept separately.
begin;

do $$
declare dependency text;
begin
 foreach dependency in array array[
  'public.payroll_json_object(jsonb)',
  'public.assert_editor_act_lease(integer,text)',
  'public.payroll_act_entries(jsonb,text)',
  'public.assert_payroll_paid_preserved(jsonb,jsonb)',
  'public.payroll_payment_append_preserved(jsonb,jsonb,jsonb)'
 ] loop
  if to_regprocedure(dependency) is null then
   raise exception 'Спочатку встановіть міграції зарплати та блокування редактора. Відсутня залежність: %',dependency;
  end if;
 end loop;
end $$;

create schema if not exists sto_payroll_private;
revoke all on schema sto_payroll_private from public,anon;
grant usage on schema sto_payroll_private to authenticated,service_role;

create table if not exists sto_payroll_private.act_freeze_state (
 act_id integer primary key references public.acts(act_id) on delete restrict,
 revision text not null,
 stock_allocations jsonb not null check(jsonb_typeof(stock_allocations)='array'),
 archived_at timestamptz not null default clock_timestamp()
);
create table if not exists sto_payroll_private.act_freeze_payroll (
 act_id integer not null references sto_payroll_private.act_freeze_state(act_id) on delete restrict,
 employee_id bigint not null references public.slyusars(slyusar_id) on delete restrict,
 fragments jsonb not null check(jsonb_typeof(fragments)='array' and jsonb_array_length(fragments)>0),
 primary key(act_id,employee_id)
);
-- The FK also prevents deleting an employee while their paid history is archived.
create index if not exists act_freeze_payroll_employee_idx
 on sto_payroll_private.act_freeze_payroll(employee_id);
revoke all on sto_payroll_private.act_freeze_state,sto_payroll_private.act_freeze_payroll from public,anon;
grant select,insert,update,delete on sto_payroll_private.act_freeze_state,sto_payroll_private.act_freeze_payroll to authenticated,service_role;
alter table sto_payroll_private.act_freeze_state enable row level security;
alter table sto_payroll_private.act_freeze_state force row level security;
alter table sto_payroll_private.act_freeze_payroll enable row level security;
alter table sto_payroll_private.act_freeze_payroll force row level security;
drop policy if exists act_freeze_state_access on sto_payroll_private.act_freeze_state;
create policy act_freeze_state_access on sto_payroll_private.act_freeze_state
 for all to authenticated,service_role
 using(exists(select 1 from public.acts a where a.act_id=act_freeze_state.act_id))
 with check(exists(select 1 from public.acts a where a.act_id=act_freeze_state.act_id));
drop policy if exists act_freeze_payroll_access on sto_payroll_private.act_freeze_payroll;
create policy act_freeze_payroll_access on sto_payroll_private.act_freeze_payroll
 for all to authenticated,service_role
 using(exists(select 1 from public.acts a where a.act_id=act_freeze_payroll.act_id))
 with check(exists(select 1 from public.acts a where a.act_id=act_freeze_payroll.act_id));
-- Deliberately do not expose this schema in PostgREST or publish its payloads.
do $$ begin
 if exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
  and schemaname='sto_payroll_private' and tablename in ('act_freeze_state','act_freeze_payroll')) then
  raise exception 'Архів зарплати не повинен входити до supabase_realtime';
 end if;
end $$;

-- A filtered employee directory cannot prove that ALL accruals were removed.
-- Keep the caller's RLS; reject unsupported filtered policies instead of bypassing
-- them or silently freezing only the employees visible to this caller.
create or replace function sto_payroll_private.assert_full_employee_access()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
declare operation "char";
begin
 if not has_table_privilege(current_user,'public.slyusars','SELECT')
  or not has_column_privilege(current_user,'public.slyusars','data','UPDATE') then
  raise exception 'Для замороження потрібен доступ до зарплати всіх працівників' using errcode='42501';
 end if;
 if not row_security_active('public.slyusars'::regclass) then return;end if;
 foreach operation in array array['r'::"char",'w'::"char"] loop
  if not exists(select 1 from pg_policy p where p.polrelid='public.slyusars'::regclass
    and p.polcmd in ('*'::"char",operation) and p.polpermissive
    and coalesce(pg_get_expr(p.polqual,p.polrelid),'true') in ('true','(true)')
    and (operation='r' or coalesce(pg_get_expr(p.polwithcheck,p.polrelid),pg_get_expr(p.polqual,p.polrelid),'true') in ('true','(true)'))
    and exists(select 1 from unnest(p.polroles) r where case when r=0 then true else pg_has_role(current_user,r,'USAGE') end))
   or exists(select 1 from pg_policy p where p.polrelid='public.slyusars'::regclass
    and p.polcmd in ('*'::"char",operation) and not p.polpermissive
    and (coalesce(pg_get_expr(p.polqual,p.polrelid),'true') not in ('true','(true)')
     or (operation='w' and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),pg_get_expr(p.polqual,p.polrelid),'true') not in ('true','(true)')))
    and exists(select 1 from unnest(p.polroles) r where case when r=0 then true else pg_has_role(current_user,r,'USAGE') end)) then
   raise exception 'Політики доступу обмежують зарплату працівників. Замороження скасовано повністю; потрібен повний доступ до всіх працівників.' using errcode='42501';
  end if;
 end loop;
end $$;

-- Ignore unrelated legacy entries without an act number, as commit_act_payroll
-- does. Reject malformed buckets rather than accidentally discarding them.
create or replace function sto_payroll_private.act_fragments(p_history jsonb,p_act text)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare bucket record; result jsonb:='[]'::jsonb;
begin
 p_history:=coalesce(nullif(p_history,'null'::jsonb),'{}'::jsonb);
 if jsonb_typeof(p_history) is distinct from 'object' then raise exception 'Некоректна історія зарплати' using errcode='40001';end if;
 for bucket in select * from jsonb_each(p_history) order by key loop
  if jsonb_typeof(bucket.value) is distinct from 'array' then raise exception 'Некоректна дата історії зарплати: %',bucket.key using errcode='40001';end if;
  result:=result||coalesce((select jsonb_agg(jsonb_build_object('date',bucket.key,'value',value) order by ordinality)
   from jsonb_array_elements(bucket.value) with ordinality where value->>'Акт'=p_act),'[]'::jsonb);
 end loop;
 return result;
end $$;

create or replace function public.traffic_act_transition_state(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb;
begin
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,'total',doc->'Загальна сума',
  'frozen',coalesce(doc->'Заморожений'='true'::jsonb,false),'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision',
  'checksum',md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text),'freeze_payroll_version',1);
end $$;

create or replace function public.guarded_set_act_frozen(p_act_id integer,p_frozen boolean,p_checksum text,p_revision text,p_lock_owner text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; converted_act public.acts%rowtype; doc jsonb;
 employee public.slyusars%rowtype; converted_employee public.slyusars%rowtype; employee_id_value bigint;
 employee_data jsonb; history jsonb; fragments jsonb; archived record; bucket record; item jsonb; remaining jsonb;
 state sto_payroll_private.act_freeze_state%rowtype; has_archive boolean;
 allocation jsonb; allocations jsonb; stock_row public.sclad%rowtype; stock_ids jsonb:='[]'::jsonb; next_off numeric;
 frozen boolean; changed boolean; repaired boolean:=false; employees_changed integer:=0; retry boolean;
begin
 if p_act_id is null or p_act_id<=0 or p_frozen is null or nullif(p_revision,'') is null or nullif(p_checksum,'') is null then
  raise exception 'Некоректний запит зміни стану акта';
 end if;
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if a.date_off is not null then raise exception 'Закритий акт не можна заморожувати або розморожувати' using errcode='55000';end if;
 frozen:=coalesce(doc->'Заморожений'='true'::jsonb,false);
 changed:=frozen is distinct from p_frozen;
 retry:=not changed and doc->>'__act_revision'=p_revision;
 if not coalesce(retry,false) and md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text) is distinct from p_checksum then
  raise exception 'Акт змінився. Повторіть операцію.' using errcode='40001';
 end if;
 select * into state from sto_payroll_private.act_freeze_state where act_id=p_act_id for update;
 has_archive:=found;
 if has_archive and not frozen then raise exception 'Архів зарплати не відповідає стану акта. Операцію скасовано.' using errcode='40001';end if;
 -- A repeated freeze on an old frozen act can archive surviving payroll without
 -- returning its parts a second time. Ordinary repeated requests are no-ops.
 repaired:=p_frozen and frozen and not has_archive;
 if changed or repaired then
  perform sto_payroll_private.assert_full_employee_access();
  if jsonb_typeof(coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb)) is distinct from 'array' then
   raise exception 'Некоректний перелік деталей акта' using errcode='40001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',sid,'qty',qty) order by sid),'[]'::jsonb) into allocations from (
   select (d->>'sclad_id')::bigint sid,sum((d->>'Кількість')::numeric) qty
   from jsonb_array_elements(coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb)) d
   where d->>'sclad_id' ~ '^[1-9][0-9]*$' and coalesce(nullif(d->>'Кількість','')::numeric,0)>0
   group by (d->>'sclad_id')::bigint
  ) q;
  if not p_frozen and has_archive and allocations is distinct from state.stock_allocations then
   raise exception 'Деталі замороженого акта змінилися. Розмороження скасовано, щоб не змінити залишки складу неправильно.' using errcode='40001';
  end if;
  -- Same lock order as commit_act_payroll: lease, act, stock IDs, employee IDs.
  if changed then
   for allocation in select value from jsonb_array_elements(allocations) order by (value->>'id')::bigint loop
    select * into stock_row from public.sclad where sclad_id=(allocation->>'id')::bigint for update;
    if not found then raise exception 'Складська позиція % недоступна',allocation->>'id' using errcode='40001';end if;
    next_off:=coalesce(stock_row.kilkist_off,0)+case when p_frozen then -(allocation->>'qty')::numeric else (allocation->>'qty')::numeric end;
    if next_off<0 then
     raise exception 'Позиція складу №%: списана кількість менша за кількість в акті. Замороження скасовано без зміни залишків.',allocation->>'id' using errcode='40001';
    end if;
    update public.sclad set kilkist_off=next_off where sclad_id=stock_row.sclad_id;
    if not found or (select s.kilkist_off from public.sclad s where s.sclad_id=stock_row.sclad_id) is distinct from next_off then
     raise exception 'Немає підтвердження зміни складської позиції %',allocation->>'id' using errcode='40001';
    end if;
    stock_ids:=stock_ids||jsonb_build_array(stock_row.sclad_id);
   end loop;
  end if;
  if p_frozen then
   if has_archive then raise exception 'Зарплату цього акта вже архівовано' using errcode='40001';end if;
   insert into sto_payroll_private.act_freeze_state(act_id,revision,stock_allocations) values(p_act_id,p_revision,allocations);
   -- Scan on the server only; lock and update only employees having this act.
   for employee_id_value in select s.slyusar_id from public.slyusars s
    where sto_payroll_private.act_fragments(public.payroll_json_object(to_jsonb(s.data))->'Історія',p_act_id::text)<>'[]'::jsonb
    order by s.slyusar_id loop
    select * into employee from public.slyusars where slyusar_id=employee_id_value for update;
    if not found then raise exception 'Працівник №% недоступний. Замороження скасовано.',employee_id_value using errcode='40001';end if;
    employee_data:=public.payroll_json_object(to_jsonb(employee.data));
    history:=coalesce(nullif(employee_data->'Історія','null'::jsonb),'{}'::jsonb);
    fragments:=sto_payroll_private.act_fragments(history,p_act_id::text);
    if fragments='[]'::jsonb then continue;end if;
    insert into sto_payroll_private.act_freeze_payroll(act_id,employee_id,fragments) values(p_act_id,employee_id_value,fragments);
    for bucket in select * from jsonb_each(history) loop
     select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into remaining
      from jsonb_array_elements(bucket.value) with ordinality where value->>'Акт' is distinct from p_act_id::text;
     if remaining is distinct from bucket.value then
      history:=case when remaining='[]'::jsonb then history-bucket.key else jsonb_set(history,array[bucket.key],remaining) end;
     end if;
    end loop;
    employee_data:=jsonb_set(employee_data,array['Історія'],history)||jsonb_build_object('__payroll_revision',gen_random_uuid()::text);
    converted_employee:=jsonb_populate_record(null::public.slyusars,jsonb_build_object('data',employee_data));
    update public.slyusars set data=converted_employee.data where slyusar_id=employee_id_value;
    if not found or (select public.payroll_json_object(to_jsonb(s.data)) from public.slyusars s where s.slyusar_id=employee_id_value) is distinct from employee_data then
     raise exception 'Немає підтвердження архівації зарплати працівника №%',employee_id_value using errcode='40001';
    end if;
    employees_changed:=employees_changed+1;
   end loop;
   if exists(select 1 from public.slyusars s where sto_payroll_private.act_fragments(public.payroll_json_object(to_jsonb(s.data))->'Історія',p_act_id::text)<>'[]'::jsonb) then
    raise exception 'Зарплата акта змінилася під час замороження. Усі зміни скасовано.' using errcode='40001';
   end if;
  elsif has_archive then
   if exists(select 1 from public.slyusars s where sto_payroll_private.act_fragments(public.payroll_json_object(to_jsonb(s.data))->'Історія',p_act_id::text)<>'[]'::jsonb) then
    raise exception 'Під час замороження з’явилися інші нарахування цього акта. Розмороження скасовано; виплати збережено.' using errcode='40001';
   end if;
   for archived in select ar.employee_id,ar.fragments from sto_payroll_private.act_freeze_payroll ar where ar.act_id=p_act_id order by ar.employee_id for update loop
    select * into employee from public.slyusars where slyusar_id=archived.employee_id for update;
    if not found then raise exception 'Працівник №% недоступний. Виплати залишено в архіві.',archived.employee_id using errcode='40001';end if;
    employee_data:=public.payroll_json_object(to_jsonb(employee.data));
    history:=coalesce(nullif(employee_data->'Історія','null'::jsonb),'{}'::jsonb);
    if sto_payroll_private.act_fragments(history,p_act_id::text)<>'[]'::jsonb then
     raise exception 'Нарахування працівника №% змінилося. Виплати залишено в архіві.',archived.employee_id using errcode='40001';
    end if;
    for item in select value from jsonb_array_elements(archived.fragments) loop
     if jsonb_typeof(item->'value') is distinct from 'object' or item#>>'{value,Акт}' is distinct from p_act_id::text or nullif(item->>'date','') is null then
      raise exception 'Архів зарплати пошкоджено. Операцію скасовано.' using errcode='40001';
     end if;
     history:=jsonb_set(history,array[item->>'date'],coalesce(history->(item->>'date'),'[]'::jsonb)||jsonb_build_array(item->'value'));
    end loop;
    employee_data:=jsonb_set(employee_data,array['Історія'],history)||jsonb_build_object('__payroll_revision',gen_random_uuid()::text);
    converted_employee:=jsonb_populate_record(null::public.slyusars,jsonb_build_object('data',employee_data));
    update public.slyusars set data=converted_employee.data where slyusar_id=archived.employee_id;
    if not found or (select public.payroll_json_object(to_jsonb(s.data)) from public.slyusars s where s.slyusar_id=archived.employee_id) is distinct from employee_data then
     raise exception 'Немає підтвердження відновлення зарплати працівника №%',archived.employee_id using errcode='40001';
    end if;
    employees_changed:=employees_changed+1;
   end loop;
   delete from sto_payroll_private.act_freeze_payroll where act_id=p_act_id;
   delete from sto_payroll_private.act_freeze_state where act_id=p_act_id;
   if not found then raise exception 'Немає підтвердження завершення відновлення зарплати' using errcode='40001';end if;
  end if;
  -- Legacy frozen acts have no archive: keep any surviving paid live entries.
  -- Save/close performs normal reconciliation with their existing payment data.
  doc:=doc||jsonb_build_object('Заморожений',p_frozen,'__payroll_pending',true,'__act_revision',p_revision);
  converted_act:=jsonb_populate_record(null::public.acts,jsonb_build_object('data',doc));
  update public.acts set data=converted_act.data where act_id=p_act_id;
  if not found or doc is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then
   raise exception 'Акт змінений сервером під час зміни стану' using errcode='40001';
  end if;
 elsif coalesce(retry,false) then
  -- A lost first response must still invalidate the stock rows already changed.
  if p_frozen and has_archive then
   select coalesce(jsonb_agg(value->'id' order by (value->>'id')::bigint),'[]'::jsonb) into stock_ids
    from jsonb_array_elements(state.stock_allocations);
  else
   select coalesce(jsonb_agg(to_jsonb(sid) order by sid),'[]'::jsonb) into stock_ids from (
    select distinct (d->>'sclad_id')::bigint sid
    from jsonb_array_elements(coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb)) d
    where d->>'sclad_id' ~ '^[1-9][0-9]*$' and coalesce(nullif(d->>'Кількість','')::numeric,0)>0
   ) q;
  end if;
 end if;
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,
  'frozen',p_frozen,'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision',
  'status',case when changed or repaired then 'updated' else 'unchanged' end,'stock_ids',stock_ids,'freeze_payroll_version',1,'employees_changed',employees_changed);
end $$;

revoke all on function sto_payroll_private.assert_full_employee_access(),sto_payroll_private.act_fragments(jsonb,text) from public,anon;
grant execute on function sto_payroll_private.assert_full_employee_access(),sto_payroll_private.act_fragments(jsonb,text) to authenticated,service_role;
revoke all on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) from public,anon;
grant execute on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) to authenticated,service_role;

-- The full current payroll writer follows. Only its frozen-state check changes:
-- ordinary accrual writes must not recreate archived entries while frozen.

create or replace function public.write_payroll_fragments(p_employee_id bigint,p_mode text,p_changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare employee public.slyusars%rowtype; converted public.slyusars%rowtype;
 current_data jsonb; original_data jsonb; history jsonb; act_data jsonb; act_id_value bigint;
 change jsonb; actual jsonb; expected jsonb; desired jsonb; entry jsonb; bucket jsonb; records jsonb;
 old_date text; new_date text; act_key text; record_key text; entry_index integer; record_index integer; match_count integer;
 target jsonb; next_target jsonb; paid jsonb; revision text;
begin
 if p_mode not in ('accrual','payment') or p_mode is null or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>2000 then raise exception 'Некоректний запит зарплати';end if;
 if exists(select 1 from jsonb_array_elements(p_changes)x where coalesce(x->>'act_id','')!~'^[1-9][0-9]*$') then raise exception 'Некоректний номер акта';end if;
 -- Deterministic locks: all affected acts in ascending order, then one employee.
 -- Payment checks and employee mutation share this transaction.
 for act_id_value in select distinct (value->>'act_id')::bigint from jsonb_array_elements(p_changes) order by 1 loop
  select public.payroll_json_object(to_jsonb(a.data)) into act_data from public.acts a where a.act_id=act_id_value for update;
  if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
  if act_data->'Заморожений'='true'::jsonb or (p_mode='payment' and act_data->'__payroll_pending'='true'::jsonb) then
   raise exception 'Акт заморожений або розрахунок зарплати ще не завершений' using errcode='55000';
  end if;
 end loop;
 select * into employee from public.slyusars where slyusar_id=p_employee_id for update;
 if not found then raise exception 'Працівник відсутній або недоступний' using errcode='40001';end if;
 current_data:=public.payroll_json_object(to_jsonb(employee.data));original_data:=current_data;
 history:=coalesce(nullif(current_data->'Історія','null'::jsonb),'{}'::jsonb);
 for change in select value from jsonb_array_elements(p_changes) loop
  act_key:=change->>'act_id';actual:=public.payroll_act_entries(history,act_key);
  if jsonb_array_length(actual)>1 then raise exception 'Дублікати зарплати за актом %',act_key using errcode='40001';end if;
  if p_mode='accrual' then
   expected:=change->'expected';desired:=change->'desired';
   if jsonb_typeof(expected) is distinct from 'array' or jsonb_typeof(desired) is distinct from 'array' or jsonb_array_length(expected)>1 or jsonb_array_length(desired)>1 then raise exception 'Некоректний фрагмент нарахування';end if;
   if jsonb_array_length(desired)=1 then
    entry:=desired#>'{0,value}';new_date:=desired#>>'{0,date}';
    if jsonb_typeof(entry) is distinct from 'object' or entry->>'Акт' is distinct from act_key or nullif(new_date,'') is null then raise exception 'Некоректний акт нарахування';end if;
    records:=coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb);
    if jsonb_typeof(records) is distinct from 'array' then raise exception 'Некоректні записи робіт';end if;
    if exists(select 1 from jsonb_array_elements(records)r where nullif(r->>'recordId','') is not null group by r->>'recordId' having count(*)>1) then raise exception 'Повторні ідентифікатори робіт' using errcode='40001';end if;
   end if;
   if actual=desired then continue;end if;
   if actual is distinct from expected then raise exception 'Зарплату змінено. Оновіть дані.' using errcode='40001';end if;
   -- Direct accrual calls receive the same ledger protection as commit_act_payroll.
   perform public.assert_payroll_paid_preserved(actual,desired);
   old_date:=actual#>>'{0,date}';new_date:=desired#>>'{0,date}';
   if old_date is not null and old_date=new_date then
    select coalesce(jsonb_agg(case when value->>'Акт'=act_key then desired#>'{0,value}' else value end order by ordinality),'[]'::jsonb) into bucket from jsonb_array_elements(history->old_date) with ordinality;
    history:=jsonb_set(history,array[old_date],bucket);
   else
    if old_date is not null then
     select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into bucket from jsonb_array_elements(history->old_date) with ordinality where value->>'Акт' is distinct from act_key;
     history:=case when bucket='[]'::jsonb then history-old_date else jsonb_set(history,array[old_date],bucket) end;
    end if;
    if new_date is not null then history:=jsonb_set(history,array[new_date],coalesce(history->new_date,'[]'::jsonb)||jsonb_build_array(desired#>'{0,value}'));end if;
   end if;
  else
   if jsonb_array_length(actual)<>1 or actual#>>'{0,date}' is distinct from change->>'date' then raise exception 'Нарахування змінилось або відсутнє' using errcode='40001';end if;
   old_date:=actual#>>'{0,date}';entry:=actual#>'{0,value}';expected:=change->'expected';paid:=change->'desired';
   if jsonb_typeof(expected) is distinct from 'object' or jsonb_typeof(paid) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(paid)k where k not in ('Розраховано','__payroll_payments')) then
    raise exception 'Виплата може змінювати лише журнал виплат і позначку розрахунку';
   end if;
   if change->>'target'='act' then target:=entry-'Записи';
   elsif change->>'target'='record' then
    records:=entry->'Записи';record_key:=change->>'record_id';
    if jsonb_typeof(records) is distinct from 'array' then raise exception 'Роботи відсутні' using errcode='40001';end if;
    if record_key is not null then
     select count(*),min(ordinality::int-1) into match_count,record_index from jsonb_array_elements(records) with ordinality where value->>'recordId'=record_key;
     if match_count<>1 then raise exception 'Робота відсутня або має дублікат ID' using errcode='40001';end if;
    else
     if coalesce(change->>'index','')!~'^[0-9]+$' then raise exception 'Немає ідентифікатора роботи';end if;
     record_index:=(change->>'index')::integer;
     -- Legacy rows without IDs can only be addressed if their immutable content is unique.
     select count(*) into match_count from jsonb_array_elements(records)r where r-'Розраховано'=expected-'Розраховано';
     if match_count<>1 then raise exception 'Неоднозначна стара робота без ID' using errcode='40001';end if;
    end if;
    target:=records->record_index;
   else raise exception 'Невідома ціль виплати';end if;
   next_target:=(expected-array['Розраховано','__payroll_payments'])||paid;
   if target=next_target then continue;end if;
   if target is distinct from expected then raise exception 'Виплату або нарахування змінено. Оновіть дані.' using errcode='40001';end if;
   if change->>'target'='act' and (
    exists(select 1 from jsonb_array_elements(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))r
     where r?'__payroll_payments')
    or ((target?'__payroll_payments' or paid?'__payroll_payments')
     and jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0)) then
    raise exception 'Роботи з історією виплат розраховуються окремо' using errcode='55000';
   end if;
   if target?'__payroll_payments' or paid?'__payroll_payments' then
    if not public.payroll_payment_append_preserved(target,next_target,
     case when change->>'target'='record' then entry else null end) then
     raise exception 'Виплата має зберегти історію та дорівнювати залишку; скасувати можна лише останню виплату' using errcode='55000';
    end if;
   elsif paid?'Розраховано' and (jsonb_typeof(paid->'Розраховано')<>'string' or nullif(paid->>'Розраховано','') is null) then
    raise exception 'Некоректна дата виплати';
   end if;
   if change->>'target'='act' then entry:=(entry-array['Розраховано','__payroll_payments'])||paid;
   else entry:=jsonb_set(entry,array['Записи',record_index::text],next_target);end if;
   select ordinality::integer-1 into entry_index from jsonb_array_elements(history->old_date) with ordinality where value->>'Акт'=act_key;
   history:=jsonb_set(history,array[old_date,entry_index::text],entry);
  end if;
 end loop;
 current_data:=jsonb_set(current_data,array['Історія'],history);
 if current_data=original_data then return jsonb_build_object('slyusar_id',p_employee_id,'status','unchanged','revision',current_data->>'__payroll_revision');end if;
 revision:=gen_random_uuid()::text;current_data:=current_data||jsonb_build_object('__payroll_revision',revision);
 converted:=jsonb_populate_record(null::public.slyusars,jsonb_build_object('data',current_data));
 update public.slyusars set data=converted.data where slyusar_id=p_employee_id;
 if not found then raise exception 'Запис зарплати заборонений' using errcode='40001';end if;
 return jsonb_build_object('slyusar_id',p_employee_id,'status','updated','revision',revision,'changed',jsonb_array_length(p_changes));
end $$;

notify pgrst,'reload schema';
commit;
