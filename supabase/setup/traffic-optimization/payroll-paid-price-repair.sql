-- SQL Editor, not Edge Functions.
-- Requires payroll_pending_recovery. This changes validation only: it does not
-- rewrite salary history, mark payments, or repair any act automatically.
begin;

do $$
begin
 if to_regprocedure('public.assert_payroll_paid_preserved(jsonb,jsonb)') is null then
  raise exception 'Спочатку встановіть payroll_pending_recovery з пакета оптимізації.';
 end if;
end $$;

-- Strict, finite number conversion for the narrow client-price correction.
-- Blank/missing values must not silently become zero.
create or replace function public.payroll_price_correction_number(p_value jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare raw_value text; result_value double precision;
begin
 if jsonb_typeof(p_value) not in ('number','string') or p_value is null then return null;end if;
 raw_value:=replace(regexp_replace(p_value#>>'{}','[[:space:]]','','g'),',','.');
 if raw_value !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null;end if;
 result_value:=raw_value::double precision;
 if result_value::text in ('NaN','Infinity','-Infinity') then return null;end if;
 return result_value;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

-- A customer's sale price can be corrected without changing the mechanic's
-- acknowledged wage. Every other stored field, including payment dates and
-- unknown metadata, must remain exactly the same. Legacy rows without an ID
-- cannot use this exception.
create or replace function public.payroll_paid_work_price_preserved(p_previous jsonb,p_next jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare previous_price double precision; next_price double precision; quantity double precision; wage double precision;
 calculated_sum double precision; next_sum double precision;
begin
 if p_previous=p_next then return true;end if;
 if jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object'
  or coalesce(jsonb_typeof(p_previous->'recordId'),'null') not in ('number','string')
  or nullif(btrim(p_previous->>'recordId'),'') is null
  or jsonb_typeof(p_previous->'Робота') is distinct from 'string'
  or nullif(btrim(p_previous->>'Робота'),'') is null
  or (p_previous-array['Ціна','Сума']) is distinct from (p_next-array['Ціна','Сума'])
  or (p_previous?'Сума') is distinct from (p_next?'Сума')
  or jsonb_typeof(p_next->'Ціна') is distinct from 'number' then return false;end if;
 previous_price:=public.payroll_price_correction_number(p_previous->'Ціна');
 next_price:=public.payroll_price_correction_number(p_next->'Ціна');
 quantity:=public.payroll_price_correction_number(p_previous->'Кількість');
 wage:=public.payroll_price_correction_number(p_previous->'Зарплата');
 if previous_price is null or next_price is null or quantity is null or wage is null or wage<0
  or previous_price<0 or next_price<0 or previous_price=next_price then return false;end if;
 calculated_sum:=next_price*quantity;
 if calculated_sum::text in ('NaN','Infinity','-Infinity') then return false;end if;
 if p_previous?'Сума' then
  next_sum:=public.payroll_price_correction_number(p_next->'Сума');
  if jsonb_typeof(p_next->'Сума') is distinct from 'number'
   or next_sum is null or next_sum<>calculated_sum then return false;end if;
 end if;
 return true;
exception when numeric_value_out_of_range then return false;
end $$;

-- The paid mechanic header may change only its customer-price total together
-- with a proven price edit. The row set, order, wages and payment marks stay
-- unchanged. Receiver/parts salary bases are not covered by this exception.
create or replace function public.payroll_paid_mechanic_prices_preserved(p_previous jsonb,p_next jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare previous_rows jsonb; next_rows jsonb; previous_row jsonb; next_row jsonb; position integer;
 price double precision; quantity double precision; total double precision:=0;
 expected_total double precision; next_total double precision; changed boolean:=false;
begin
 if jsonb_typeof(p_previous) is distinct from 'object' or jsonb_typeof(p_next) is distinct from 'object'
  or jsonb_typeof(p_previous->'Записи') is distinct from 'array'
  or jsonb_typeof(p_next->'Записи') is distinct from 'array'
  or p_previous?|array['ЗарплатаРоботи','ЗарплатаЗапчастин','ЗарплатаЗапчастистів','Зарплата','Знижка','МаржаДляЗарплати','СуммаЗапчастин',
    '__payroll_percent','__payroll_percent_work','__payroll_percent_parts']
  or (p_previous-array['Записи','СуммаРоботи','Клієнт','Автомобіль','ДатаЗакриття','__payroll_input']) is distinct from
   (p_next-array['Записи','СуммаРоботи','Клієнт','Автомобіль','ДатаЗакриття','__payroll_input']) then return false;end if;
 previous_rows:=p_previous->'Записи';next_rows:=p_next->'Записи';
 if jsonb_array_length(previous_rows)=0 or jsonb_array_length(previous_rows)<>jsonb_array_length(next_rows) then return false;end if;
 for position in 0..jsonb_array_length(previous_rows)-1 loop
  previous_row:=previous_rows->position;next_row:=next_rows->position;
  if not public.payroll_paid_work_price_preserved(previous_row,next_row) then return false;end if;
  if previous_row is distinct from next_row then changed:=true;end if;
  price:=public.payroll_price_correction_number(next_row->'Ціна');
  quantity:=public.payroll_price_correction_number(next_row->'Кількість');
  if price is null or price<0 or quantity is null then return false;end if;
  total:=total+price*quantity;
 end loop;
 if not changed or total::text in ('NaN','Infinity','-Infinity') then return false;end if;
 -- Same positive/zero result as Math.max(0, Math.round((sum+EPSILON)*100)/100).
 expected_total:=greatest(0,floor((total+2.220446049250313e-16::double precision)*100+0.5)/100);
 next_total:=public.payroll_price_correction_number(p_next->'СуммаРоботи');
 return jsonb_typeof(p_next->'СуммаРоботи')='number' and next_total is not null and next_total=expected_total;
exception when numeric_value_out_of_range then return false;
end $$;

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
   (next_value-array['Клієнт','Автомобіль','ДатаЗакриття','__payroll_input']))
  and not public.payroll_paid_mechanic_prices_preserved(previous,next_value) then
  raise exception 'Відновлення змінює оплачене нарахування. Потрібна перевірка; виплати збережено.' using errcode='55000';
 end if;
 for item in select value from jsonb_array_elements(coalesce(nullif(previous->'Записи','null'::jsonb),'[]'::jsonb)) loop
  if coalesce(item->'Розраховано','null'::jsonb) in ('null'::jsonb,'false'::jsonb,'""'::jsonb) then continue;end if;
  select count(*) into matches from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb)) r
   where case when nullif(item->>'recordId','') is not null then r->>'recordId'=item->>'recordId' else r=item end;
  if matches<>1 then raise exception 'Оплачена робота видаляється або змінює виконавця. Відновлення зупинено.' using errcode='55000';end if;
  select value into matched from jsonb_array_elements(coalesce(nullif(next_value->'Записи','null'::jsonb),'[]'::jsonb))
   where case when nullif(item->>'recordId','') is not null then value->>'recordId'=item->>'recordId' else value=item end;
  if not public.payroll_paid_work_price_preserved(item,matched) then
   raise exception 'Сума або дані оплаченої роботи змінилися. Відновлення зупинено.' using errcode='55000';
  end if;
 end loop;
end $$;

revoke all on function public.payroll_price_correction_number(jsonb),
 public.payroll_paid_work_price_preserved(jsonb,jsonb),public.payroll_paid_mechanic_prices_preserved(jsonb,jsonb),
 public.assert_payroll_paid_preserved(jsonb,jsonb) from public,anon;
grant execute on function public.payroll_price_correction_number(jsonb),
 public.payroll_paid_work_price_preserved(jsonb,jsonb),public.payroll_paid_mechanic_prices_preserved(jsonb,jsonb),
 public.assert_payroll_paid_preserved(jsonb,jsonb) to authenticated;

-- Installation self-check uses synthetic JSON only. If a guard regresses, the
-- transaction rolls back; no production act or employee is read or updated.
do $$
declare original_fragment jsonb; corrected_fragment jsonb; invalid_fragment jsonb;
 invalid_row jsonb; correction jsonb; rejected boolean;
begin
 original_fragment:='[{"date":"2026-08-14","value":{"Акт":"1274","СуммаРоботи":1,"Записи":[{"recordId":"row_new_1792221176241_vkc469iqi","Ціна":1,"Робота":"Полоскання блоку циліндрів","Записано":"17.10.2026","Зарплата":25,"Кількість":1,"Розраховано":"17.10.2026"}]}}]'::jsonb;
 corrected_fragment:=jsonb_set(jsonb_set(original_fragment,'{0,value,Записи,0,Ціна}','50'::jsonb),
  '{0,value,СуммаРоботи}','50'::jsonb);
 perform public.assert_payroll_paid_preserved(original_fragment,corrected_fragment);
 perform public.assert_payroll_paid_preserved(corrected_fragment,corrected_fragment);
 perform public.assert_payroll_paid_preserved(
  jsonb_set(original_fragment,'{0,value,Розраховано}','"17.10.2026"'::jsonb),
  jsonb_set(corrected_fragment,'{0,value,Розраховано}','"17.10.2026"'::jsonb));
 for correction in select value from jsonb_array_elements(
  '[{"Зарплата":26},{"Кількість":2},{"Розраховано":false},{"Розраховано":"18.10.2026"}]'::jsonb) loop
  invalid_row:=(corrected_fragment#>'{0,value,Записи,0}')||correction;
  invalid_fragment:=jsonb_set(corrected_fragment,'{0,value,Записи,0}',invalid_row);
  rejected:=false;
  begin
   perform public.assert_payroll_paid_preserved(original_fragment,invalid_fragment);
  exception when sqlstate '55000' then rejected:=true;
  end;
  if not rejected then raise exception 'Перевірка захисту оплаченої зарплати не пройшла; встановлення скасовано.';end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
