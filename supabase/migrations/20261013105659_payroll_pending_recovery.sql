-- SQL Editor, not Edge Functions. Requires payroll_fragments, traffic_payroll_employees
-- and act_editor_lease_guard. No new tables and no automatic data repair.
begin;

do $$
begin
 if to_regprocedure('public.payroll_act_entries(jsonb,text)') is null
  or to_regprocedure('public.write_payroll_fragments(bigint,text,jsonb)') is null
  or to_regprocedure('public.assert_editor_act_lease(integer,text)') is null
  or to_regprocedure('public.traffic_payroll_employees(bigint[],integer,bigint,text)') is null then
  raise exception 'Спочатку встановіть payroll_fragments, act_editor_lease_guard і traffic_payroll_employees з пакета оптимізації.';
 end if;
end $$;

create or replace function public.payroll_pending_acts(p_before integer default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare rows_json jsonb; more boolean; cursor_id integer;
begin
 with page as (
  select a.act_id,a.date_on,a.date_off,a.pruimalnyk
  from public.acts a
  where (p_before is null or a.act_id<p_before)
   and public.payroll_json_object(to_jsonb(a.data))->'__payroll_pending'='true'::jsonb
   and public.payroll_json_object(to_jsonb(a.data))->'Заморожений' is distinct from 'true'::jsonb
  order by a.act_id desc limit 51
 ), visible as (select * from page order by act_id desc limit 50)
 select coalesce((select jsonb_agg(to_jsonb(v) order by act_id desc) from visible v),'[]'::jsonb),
  (select count(*)>50 from page),(select min(act_id) from visible)
 into rows_json,more,cursor_id;
 return jsonb_build_object('rows',rows_json,'hasMore',more,'nextAfter',case when more then cursor_id else null end);
end $$;

create or replace function public.payroll_recovery_context(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; context_value jsonb;
begin
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if doc->'Заморожений'='true'::jsonb then raise exception 'Заморожений акт не відновлюється автоматично' using errcode='55000';end if;
 context_value:=jsonb_build_object('date_on',a.date_on,'date_off',a.date_off,'pruimalnyk',a.pruimalnyk,'client_id',a.client_id,'cars_id',a.cars_id);
 return context_value||jsonb_build_object('act_id',a.act_id,'data',doc,'revision',doc->>'__act_revision',
  'checksum',md5(doc::text),'context_checksum',md5(context_value::text));
end $$;

-- Paid entries may keep updated display labels, but their financial content and
-- payment markers cannot disappear or be rewritten during recovery.
create or replace function public.assert_payroll_paid_preserved(p_expected jsonb,p_desired jsonb)
returns void language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare previous jsonb; next_value jsonb; item jsonb; matched jsonb; matches integer;
begin
 if p_expected=p_desired then return;end if;
 previous:=p_expected#>'{0,value}';next_value:=p_desired#>'{0,value}';
 if previous is null then return;end if;
 if (coalesce(previous->'Розраховано','null'::jsonb) not in ('null'::jsonb,'false'::jsonb,'""'::jsonb)
  or exists(select 1 from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb)) r
   where coalesce(r->'Розраховано','null'::jsonb) not in ('null'::jsonb,'false'::jsonb,'""'::jsonb)))
  and p_expected#>>'{0,date}' is distinct from p_desired#>>'{0,date}' then
  raise exception 'Дата оплаченої зарплати змінюється. Відновлення зупинено.' using errcode='55000';
 end if;
 if coalesce(previous->'Розраховано','null'::jsonb) not in ('null'::jsonb,'false'::jsonb,'""'::jsonb)
  and (next_value is null or (previous-array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input']) is distinct from
   (next_value-array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input'])) then
  raise exception 'Відновлення змінює оплачене нарахування. Потрібна перевірка; виплати збережено.' using errcode='55000';
 end if;
 for item in select value from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb)) loop
  if coalesce(item->'Розраховано','null'::jsonb) in ('null'::jsonb,'false'::jsonb,'""'::jsonb) then continue;end if;
  select count(*) into matches from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb)) r
   where case when nullif(item->>'recordId','') is not null then r->>'recordId'=item->>'recordId' else r=item end;
  if matches<>1 then raise exception 'Оплачена робота видаляється або змінює виконавця. Відновлення зупинено.' using errcode='55000';end if;
  select value into matched from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))
   where case when nullif(item->>'recordId','') is not null then value->>'recordId'=item->>'recordId' else value=item end;
  if matched is distinct from item then raise exception 'Сума або дані оплаченої роботи змінилися. Відновлення зупинено.' using errcode='55000';end if;
 end loop;
end $$;

create or replace function public.commit_act_payroll(
 p_act_id integer,p_checksum text,p_context_checksum text,p_revision text,
 p_next_revision text,p_employees jsonb,p_lock_owner text default null,p_stock jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; held public.act_locks%rowtype; doc jsonb; context_value jsonb;
 item jsonb; employee public.slyusars%rowtype; employee_data jsonb; settings jsonb;
 actual jsonb; expected jsonb; desired jsonb; receipt jsonb; changed integer:=0;
 stock_row public.sclad%rowtype; stock_item jsonb;
begin
 if p_act_id is null or p_act_id<=0 or nullif(p_checksum,'') is null or nullif(p_context_checksum,'') is null
  or nullif(p_next_revision,'') is null or p_next_revision is not distinct from p_revision
  or jsonb_typeof(p_employees) is distinct from 'array' or jsonb_array_length(p_employees)>2000
  or jsonb_typeof(p_stock) is distinct from 'array' or jsonb_array_length(p_stock)>2000 then
  raise exception 'Некоректний пакет відновлення зарплати';
 end if;
 if exists(select 1 from jsonb_array_elements(p_employees)e where coalesce(e->>'id','')!~'^[1-9][0-9]*$')
  or exists(select 1 from jsonb_array_elements(p_employees)e group by e->>'id' having count(*)>1) then
  raise exception 'Некоректні ідентифікатори працівників';
 end if;
 if exists(select 1 from jsonb_array_elements(p_stock)e where coalesce(e->>'id','')!~'^[1-9][0-9]*$' or jsonb_typeof(e->'expected') is distinct from 'object')
  or exists(select 1 from jsonb_array_elements(p_stock)e group by e->>'id' having count(*)>1) then
  raise exception 'Некоректний знімок складу';
 end if;
 -- Match the editor's lock order: lease, act, employee IDs.
 if nullif(p_lock_owner,'') is not null then
  perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 else
  select * into held from public.act_locks where act_id=p_act_id for update;
  if found and held.heartbeat_at>clock_timestamp()-interval '90 seconds' then
   raise exception 'Акт відкритий у редакторі. Закрийте його та повторіть відновлення.' using errcode='55P03';
  end if;
 end if;
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 context_value:=jsonb_build_object('date_on',a.date_on,'date_off',a.date_off,'pruimalnyk',a.pruimalnyk,'client_id',a.client_id,'cars_id',a.cars_id);
 if md5(context_value::text) is distinct from p_context_checksum then raise exception 'Дати або відповідальні акта змінилися. Повторіть відновлення.' using errcode='40001';end if;
 if doc->'Заморожений'='true'::jsonb or (nullif(p_lock_owner,'') is not null and a.date_off is not null) then
  raise exception 'Стан акта не дозволяє цей запис зарплати' using errcode='55000';
 end if;
 -- A repeated request with the same unique revision is harmless.
 if doc->>'__act_revision'=p_next_revision and doc->'__payroll_pending'='false'::jsonb then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',p_next_revision,'checksum',md5(doc::text),'cars_id',a.cars_id);
 end if;
 if md5(doc::text) is distinct from p_checksum or doc->>'__act_revision' is distinct from p_revision
  or doc->'__payroll_pending' is distinct from 'true'::jsonb then
  raise exception 'Акт змінився під час розрахунку. Нарахування не записано; повторіть операцію.' using errcode='40001';
 end if;
 if p_employees='[]'::jsonb and (coalesce(doc->'Роботи','[]'::jsonb)<>'[]'::jsonb or coalesce(doc->'Деталі','[]'::jsonb)<>'[]'::jsonb) then
  raise exception 'Не знайдено працівників для нарахування';
 end if;
 if exists(select 1 from jsonb_array_elements(coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb)) d
  where nullif(d->>'Деталь','') is not null and nullif(d->>'sclad_id','') is not null
   and not exists(select 1 from jsonb_array_elements(p_stock)s where s->>'id'=d->>'sclad_id')) then
  raise exception 'Не всі складські дані підтверджені. Повторіть розрахунок.' using errcode='40001';
 end if;
 -- The act row is already locked. Lock only the stock IDs used in this act,
 -- before employees, and compare the exact inputs used by the salary formulas.
 for stock_item in select value from jsonb_array_elements(p_stock) order by (value->>'id')::bigint loop
  if not exists(select 1 from jsonb_array_elements(coalesce(nullif(doc->'Деталі','null'::jsonb),'[]'::jsonb)) d
   where nullif(d->>'Деталь','') is not null and d->>'sclad_id'=stock_item->>'id') then raise exception 'Зайві складські дані у пакеті';end if;
  select * into stock_row from public.sclad where sclad_id=(stock_item->>'id')::bigint for update;
  if not found or jsonb_build_object('price',stock_row.price,'scladNomer',stock_row."scladNomer",'xto_zamovuv',stock_row.xto_zamovuv)
   is distinct from stock_item->'expected' then
   raise exception 'Ціна, склад або власник деталі змінилися. Повторіть розрахунок зарплати.' using errcode='40001';
  end if;
 end loop;
 -- Reject incomplete directory pagination or a changed employee set. This uses
 -- identifiers only and never sends unrelated payroll history to the client.
 if exists(select 1 from public.slyusars s where not exists(select 1 from jsonb_array_elements(p_employees)e where (e->>'id')::bigint=s.slyusar_id)) then
  raise exception 'Перелік працівників змінився або завантажений не повністю. Повторіть відновлення.' using errcode='40001';
 end if;
 for item in select value from jsonb_array_elements(p_employees) order by (value->>'id')::bigint loop
  expected:=item->'expected';desired:=item->'desired';
  if jsonb_typeof(expected) is distinct from 'array' or jsonb_typeof(desired) is distinct from 'array'
   or jsonb_array_length(expected)>1 or jsonb_array_length(desired)>1
   or jsonb_typeof(item->'settings') is distinct from 'object' then raise exception 'Некоректний фрагмент зарплати';end if;
  if exists(select 1 from jsonb_array_elements(expected||desired)e where e#>>'{value,Акт}' is distinct from p_act_id::text) then
   raise exception 'Пакет містить зарплату іншого акта';
  end if;
  select * into employee from public.slyusars where slyusar_id=(item->>'id')::bigint for update;
  if not found then raise exception 'Працівник відсутній або недоступний' using errcode='40001';end if;
  employee_data:=public.payroll_json_object(to_jsonb(employee.data));
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into settings from jsonb_each(employee_data)
   where key in ('Name','Доступ','Склад','ПроцентРоботи','ПроцентЗапчастин');
  if settings is distinct from item->'settings' then raise exception 'Налаштування працівника змінилися. Повторіть розрахунок.' using errcode='40001';end if;
  -- Use the same projection as the reader. An unrelated legacy entry without
  -- an act number must not block an unchanged employee's baseline check.
  select coalesce(jsonb_agg(jsonb_build_object('date',bucket.key,'value',entry.value) order by bucket.key,entry.ordinality),'[]'::jsonb) into actual
   from jsonb_each(coalesce(nullif(employee_data->'Історія','null'::jsonb),'{}'::jsonb)) bucket
   cross join lateral jsonb_array_elements(bucket.value) with ordinality entry(value,ordinality)
   where entry.value->>'Акт'=p_act_id::text;
  if actual is distinct from expected then raise exception 'Зарплату змінено паралельно. Повторіть розрахунок.' using errcode='40001';end if;
  perform public.assert_payroll_paid_preserved(expected,desired);
  if expected is distinct from desired then
   receipt:=public.write_payroll_fragments((item->>'id')::bigint,'accrual',jsonb_build_array(jsonb_build_object('act_id',p_act_id,'expected',expected,'desired',desired)));
   if receipt->>'status' not in ('updated','unchanged') then raise exception 'Немає підтвердження зарплати';end if;
   changed:=changed+1;
  end if;
 end loop;
 doc:=doc||jsonb_build_object('__payroll_pending',false,'__act_revision',p_next_revision);
 update public.acts set data=doc where act_id=p_act_id;
 if not found or doc is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then
  raise exception 'Немає підтвердження завершення зарплати' using errcode='40001';
 end if;
 return jsonb_build_object('act_id',p_act_id,'status','updated','revision',p_next_revision,'checksum',md5(doc::text),'cars_id',a.cars_id,'employees_changed',changed);
end $$;

revoke all on function public.payroll_pending_acts(integer),public.payroll_recovery_context(integer),
 public.assert_payroll_paid_preserved(jsonb,jsonb),public.commit_act_payroll(integer,text,text,text,text,jsonb,text,jsonb) from public,anon;
grant execute on function public.payroll_pending_acts(integer),public.payroll_recovery_context(integer),
 public.assert_payroll_paid_preserved(jsonb,jsonb),public.commit_act_payroll(integer,text,text,text,text,jsonb,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
