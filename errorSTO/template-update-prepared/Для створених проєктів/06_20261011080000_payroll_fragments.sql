-- Atomic payroll fragments; no tables or schema changes. Existing caller RLS applies.
create or replace function public.payroll_json_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(p_value)='string' then p_value:=(p_value#>>'{}')::jsonb;end if;
 if jsonb_typeof(p_value) is distinct from 'object' then raise exception 'Некоректні дані зарплати' using errcode='40001';end if;
 return p_value;
end $$;

create or replace function public.payroll_act_entries(p_history jsonb,p_act text)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare bucket record; entry jsonb; result jsonb:='[]';
begin
 if p_history is null then return result;end if;
 if jsonb_typeof(p_history) is distinct from 'object' then raise exception 'Некоректна історія зарплати' using errcode='40001';end if;
 for bucket in select * from jsonb_each(p_history) loop
  if jsonb_typeof(bucket.value) is distinct from 'array' then raise exception 'Некоректна дата історії зарплати' using errcode='40001';end if;
  for entry in select value from jsonb_array_elements(bucket.value) loop
   if entry->>'Акт' is null then raise exception 'Нарахування без акта' using errcode='40001';end if;
   if entry->>'Акт'=p_act then result:=result||jsonb_build_array(jsonb_build_object('date',bucket.key,'value',entry));end if;
  end loop;
 end loop;
 return result;
end $$;

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
  if p_mode='payment' and (act_data->'Заморожений'='true'::jsonb or act_data->'__payroll_pending'='true'::jsonb) then
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
   if jsonb_typeof(expected) is distinct from 'object' or jsonb_typeof(paid) is distinct from 'object' or exists(select 1 from jsonb_object_keys(paid)k where k<>'Розраховано') or (paid?'Розраховано' and (jsonb_typeof(paid->'Розраховано')<>'string' or nullif(paid->>'Розраховано','') is null)) then raise exception 'Виплата може змінювати лише Розраховано';end if;
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
   next_target:=(expected-'Розраховано')||paid;
   if target=next_target then continue;end if;
   if target is distinct from expected then raise exception 'Виплату або нарахування змінено. Оновіть дані.' using errcode='40001';end if;
   if change->>'target'='act' then entry:=(entry-'Розраховано')||paid;
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
revoke all on function public.payroll_json_object(jsonb),public.payroll_act_entries(jsonb,text),public.write_payroll_fragments(bigint,text,jsonb) from public;
grant execute on function public.payroll_json_object(jsonb),public.payroll_act_entries(jsonb,text),public.write_payroll_fragments(bigint,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
