-- Paid accrual corrections keep a payment ledger. Run in SQL Editor after
-- traffic_payroll_payments. No automatic data repair or new tables.
begin;

do $$ begin
 if to_regprocedure('public.traffic_payroll_payment_summary(jsonb,jsonb,text,text)') is null
  or to_regprocedure('public.write_payroll_fragments(bigint,text,jsonb)') is null then
  raise exception 'Спочатку встановіть traffic_payroll_payments і payroll_fragments.';
 end if;
end $$;

create or replace function public.payroll_accrual_ledger_preserved(
 p_previous jsonb,p_next jsonb,p_header jsonb default null)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare previous_ledger jsonb; next_ledger jsonb; old_earned double precision; new_earned double precision;
begin
 if jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object' then return false;end if;
 if p_previous?'__payroll_payments' then
  previous_ledger:=public.traffic_payroll_payments(p_previous,p_header);
  if not(p_next?'__payroll_payments') then return false;end if;
  next_ledger:=public.traffic_payroll_payments(p_next,p_header);
  return previous_ledger=next_ledger;
 end if;
 if public.traffic_payroll_legacy_payment_date(p_previous,p_header)='' then
  return not(p_next?'__payroll_payments');
 end if;
 old_earned:=public.traffic_payroll_payment_earned(p_previous);
 new_earned:=public.traffic_payroll_payment_earned(p_next);
 if not(p_next?'__payroll_payments') then return old_earned=new_earned;end if;
 next_ledger:=public.traffic_payroll_payments(p_next,p_header);
 previous_ledger:=public.traffic_payroll_payments(p_previous,p_header);
 return old_earned<>new_earned and next_ledger=previous_ledger;
exception when others then return false;
end $$;

create or replace function public.payroll_paid_work_adjustment_preserved(
 p_previous jsonb,p_next jsonb,p_header jsonb default null)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare price double precision; quantity double precision; wage double precision; total double precision;
 field_name text; old_amount double precision; next_amount double precision; changed boolean:=false;
begin
 if p_previous=p_next then return true;end if;
 if jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object'
  or coalesce(jsonb_typeof(p_previous->'recordId'),'null') not in ('number','string')
  or nullif(btrim(p_previous->>'recordId'),'') is null
  or jsonb_typeof(p_previous->'Робота') is distinct from 'string' or nullif(btrim(p_previous->>'Робота'),'') is null
  or (p_previous-array['Ціна','Кількість','Зарплата','Сума','__payroll_payments']) is distinct from
   (p_next-array['Ціна','Кількість','Зарплата','Сума','__payroll_payments'])
  or (p_previous?'Сума') is distinct from (p_next?'Сума') then return false;end if;
 foreach field_name in array array['Ціна','Кількість','Зарплата'] loop
  old_amount:=public.traffic_payroll_payment_number(p_previous->field_name);
  next_amount:=public.traffic_payroll_payment_number(p_next->field_name);
  if old_amount is null or next_amount is null then return false;end if;
  if old_amount<>next_amount then
   changed:=true;
   if jsonb_typeof(p_next->field_name) is distinct from 'number' then return false;end if;
  end if;
 end loop;
 if not changed then return false;end if;
 price:=public.traffic_payroll_payment_number(p_next->'Ціна');
 quantity:=public.traffic_payroll_payment_number(p_next->'Кількість');
 wage:=public.traffic_payroll_payment_number(p_next->'Зарплата');
 if price is null or price<0 or quantity is null or wage is null or wage<0 then return false;end if;
 if quantity<0 and quantity<>public.traffic_payroll_payment_number(p_previous->'Кількість') then return false;end if;
 total:=price*quantity;
 if total::text in ('NaN','Infinity','-Infinity') then return false;end if;
 if p_previous?'Сума' and (jsonb_typeof(p_next->'Сума') is distinct from 'number'
  or public.traffic_payroll_payment_number(p_next->'Сума') is null
  or public.traffic_payroll_payment_number(p_next->'Сума')<>total) then return false;end if;
 return public.payroll_accrual_ledger_preserved(p_previous,p_next,p_header);
exception when others then return false;
end $$;

create or replace function public.payroll_paid_header_adjustment_preserved(p_previous jsonb,p_next jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare numeric_keys text[]:=array['СуммаРоботи','СуммаЗапчастин','МаржаДляЗарплати','ЗарплатаРоботи',
 'ЗарплатаЗапчастин','ЗарплатаЗапчастистів','Зарплата','Знижка','__payroll_percent','__payroll_percent_work','__payroll_percent_parts'];
 allowed_keys text[]; field_name text; amount double precision; old_rows jsonb; next_rows jsonb; position integer;
 total double precision:=0; price double precision; quantity double precision;
 mechanic boolean;
begin
 if p_previous=p_next then return true;end if;
 if jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object' then return false;end if;
 if (p_previous-array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input'])=
  (p_next-array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input']) then return true;end if;
 old_rows:=coalesce(nullif(p_previous->'Записи','null'::jsonb),'[]'::jsonb);
 next_rows:=coalesce(nullif(p_next->'Записи','null'::jsonb),'[]'::jsonb);
 if jsonb_typeof(old_rows) is distinct from 'array' or jsonb_typeof(next_rows) is distinct from 'array'
  or jsonb_array_length(old_rows)<>jsonb_array_length(next_rows) then return false;end if;
 mechanic:=jsonb_typeof(p_previous->'Записи')='array';
 if mechanic then
  numeric_keys:=array['СуммаРоботи'];
 else
  if p_next?'Записи' then return false;end if;
  if (p_previous?'Зарплата') is distinct from (p_next?'Зарплата')
   or (p_previous?'СуммаРоботи') is distinct from (p_next?'СуммаРоботи')
   or (p_previous?'СуммаЗапчастин') is distinct from (p_next?'СуммаЗапчастин')
   or (not(p_previous?'СуммаРоботи') and p_previous?'СуммаЗапчастин'
    and (p_previous?'ЗарплатаРоботи') is distinct from (p_next?'ЗарплатаРоботи')) then return false;end if;
 end if;
 allowed_keys:=numeric_keys||array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input','__payroll_payments','Записи'];
 if (p_previous-allowed_keys) is distinct from (p_next-allowed_keys) then return false;end if;
 foreach field_name in array numeric_keys loop
  if not(p_next?field_name) then continue;end if;
  amount:=public.traffic_payroll_payment_number(p_next->field_name);
  if amount is null then return false;end if;
  if field_name like 'Зарплата%' and amount<0 then return false;end if;
  if (field_name like '__payroll_percent%' or field_name='Знижка') and (amount<0 or amount>100) then return false;end if;
 end loop;
 if mechanic then
  -- Whole mechanic-header legacy payments belong to the original child works.
  -- Store a correction's payment baseline on the affected child, not twice.
  if (p_previous?'__payroll_payments') is distinct from (p_next?'__payroll_payments')
   or p_previous->'__payroll_payments' is distinct from p_next->'__payroll_payments' then return false;end if;
  for position in 0..jsonb_array_length(old_rows)-1 loop
   if not public.payroll_paid_work_adjustment_preserved(old_rows->position,next_rows->position,p_previous) then return false;end if;
   price:=public.traffic_payroll_payment_number(next_rows->position->'Ціна');
   quantity:=public.traffic_payroll_payment_number(next_rows->position->'Кількість');
   if price is null or price<0 or quantity is null then return false;end if;
   total:=total+price*quantity;
  end loop;
  return coalesce(public.traffic_payroll_payment_number(p_next->'СуммаРоботи')=
   greatest(0,public.traffic_payroll_payment_round(total)),false);
 end if;
 return public.payroll_accrual_ledger_preserved(p_previous,p_next);
exception when others then return false;
end $$;

create or replace function public.assert_payroll_paid_preserved(p_expected jsonb,p_desired jsonb)
returns void language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare previous jsonb; next_value jsonb; item jsonb; matched jsonb; matches integer;
 old_protected boolean; row_protected boolean;
begin
 if p_expected=p_desired then return;end if;
 previous:=p_expected#>'{0,value}';next_value:=p_desired#>'{0,value}';
 if public.traffic_payroll_legacy_payment_date(next_value)<>'' and
  public.traffic_payroll_legacy_payment_date(previous)='' then
  raise exception 'Збереження акта не може позначати зарплату виплаченою' using errcode='55000';
 end if;
 for item in select value from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))
  where public.traffic_payroll_legacy_payment_date(value)<>'' loop
  select count(*) into matches from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb))r
   where case when nullif(btrim(item->>'recordId'),'') is not null then btrim(r->>'recordId')=btrim(item->>'recordId')
    else r=item end
    and public.traffic_payroll_legacy_payment_date(r)<>'';
  if matches<>1 then raise exception 'Збереження акта не може створювати позначку виплати роботи' using errcode='55000';end if;
 end loop;
 -- An accrual must never introduce payments in a new employee/act or work.
 if previous is null then
  if next_value?'__payroll_payments' or exists(
   select 1 from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))r where r?'__payroll_payments') then
   raise exception 'Нове нарахування не може містити попередні виплати' using errcode='55000';
  end if;
  return;
 end if;
 old_protected:=previous?'__payroll_payments' or public.traffic_payroll_legacy_payment_date(previous)<>'';
 if (old_protected or exists(select 1 from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb))r
  where r?'__payroll_payments' or public.traffic_payroll_legacy_payment_date(r,previous)<>''))
  and p_expected#>>'{0,date}' is distinct from p_desired#>>'{0,date}' then
  raise exception 'Дата оплаченої зарплати змінюється. Відновлення зупинено.' using errcode='55000';
 end if;
 if old_protected and not public.payroll_paid_header_adjustment_preserved(previous,next_value) then
  raise exception 'Зміна зарплати не зберігає попередні виплати або склад робіт' using errcode='55000';
 end if;
 if not old_protected and next_value?'__payroll_payments' then
  raise exception 'Нарахування не може створювати виплату' using errcode='55000';
 end if;
 for item in select value from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb)) loop
  row_protected:=item?'__payroll_payments' or public.traffic_payroll_legacy_payment_date(item,previous)<>'';
  if not row_protected then continue;end if;
  select count(*) into matches from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))r
   where case when nullif(item->>'recordId','') is not null then r->>'recordId'=item->>'recordId' else r=item end;
  if matches<>1 then raise exception 'Оплачена робота видаляється або змінює виконавця' using errcode='55000';end if;
  select value into matched from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))
   where case when nullif(item->>'recordId','') is not null then value->>'recordId'=item->>'recordId' else value=item end;
  if not public.payroll_paid_work_adjustment_preserved(item,matched,previous) then
   raise exception 'Оплачена робота не зберігає історію виплат або виконавця' using errcode='55000';
  end if;
 end loop;
 for item in select value from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))
  where value?'__payroll_payments' loop
  select count(*) into matches from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb))r
   where nullif(item->>'recordId','') is not null and r->>'recordId'=item->>'recordId';
  if matches<>1 then raise exception 'Нова робота не може створювати історію виплат' using errcode='55000';end if;
  select value into matched from jsonb_array_elements(previous->'Записи') where value->>'recordId'=item->>'recordId';
  if not public.payroll_accrual_ledger_preserved(matched,item,previous) then
   raise exception 'Нарахування не може змінювати історію виплат' using errcode='55000';
  end if;
 end loop;
end $$;

create or replace function public.payroll_payment_append_preserved(
 p_previous jsonb,p_next jsonb,p_header jsonb default null)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare old_ledger jsonb; next_ledger jsonb; event jsonb; prefix jsonb; old_summary jsonb; amount double precision;
begin
 if (p_previous-'__payroll_payments') is distinct from (p_next-'__payroll_payments')
  or not(p_next?'__payroll_payments') then return false;end if;
 old_ledger:=public.traffic_payroll_payments(p_previous,p_header);
 next_ledger:=public.traffic_payroll_payments(p_next,p_header);
 if jsonb_array_length(next_ledger)<>jsonb_array_length(old_ledger)+1 then return false;end if;
 event:=next_ledger->(jsonb_array_length(next_ledger)-1);
 select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into prefix
  from jsonb_array_elements(next_ledger) with ordinality where ordinality<=jsonb_array_length(old_ledger);
 if prefix is distinct from old_ledger or event->>'id'='legacy'
  or public.traffic_payroll_payment_day(event->>'date')='' then return false;end if;
 old_summary:=public.traffic_payroll_payment_summary(p_previous,p_header);
 if event?'amount' then
  amount:=public.traffic_payroll_payment_number(event->'amount');
  return amount>0 and amount=(old_summary->>'due')::double precision;
 end if;
 return nullif(old_summary->>'lastActiveId','') is not null and event->>'voids'=old_summary->>'lastActiveId';
exception when others then return false;
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

revoke all on function public.payroll_accrual_ledger_preserved(jsonb,jsonb,jsonb),
 public.payroll_paid_work_adjustment_preserved(jsonb,jsonb,jsonb),
 public.payroll_paid_header_adjustment_preserved(jsonb,jsonb),
 public.payroll_payment_append_preserved(jsonb,jsonb,jsonb) from public;
grant execute on function public.payroll_accrual_ledger_preserved(jsonb,jsonb,jsonb),
 public.payroll_paid_work_adjustment_preserved(jsonb,jsonb,jsonb),
 public.payroll_paid_header_adjustment_preserved(jsonb,jsonb),
 public.payroll_payment_append_preserved(jsonb,jsonb,jsonb),
 public.assert_payroll_paid_preserved(jsonb,jsonb),
 public.write_payroll_fragments(bigint,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;

