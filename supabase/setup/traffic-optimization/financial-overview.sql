-- SQL Editor: виконати весь файл. НЕ Edge Functions.
-- Для чинної бази з установленими міграціями зарплати та журналом виплат.
-- Спочатку цей SQL, потім оновлення сайту. Для нових проєктів уже включено у файл 8.
-- Створює лише функції читання фінансового зведення. Не змінює акти, виплати чи склад.
-- Додаткові можливості: короткі версії даних (PostgREST 9.1), архів заморожених зарплат.
-- Без них запит працює без кеш-ревізії або повідомляє про недоступний архів.
begin;
-- BEGIN FINANCIAL OVERVIEW 2026-10-25
-- Financial overview: one read-only, RLS-preserving aggregate request.
-- No historical payments, payroll or stock are rewritten by installation.
-- Requires the payroll payment helpers (20261020061759). The freeze archive and
-- resource revisions are optional. A missing archive is reported, never hidden.
-- Cash movement is reconstructed from settlement markers; undated advances,
-- mutable legacy balances and unmatched expenses are explicitly disclosed.

do $$ begin
 if to_regprocedure('public.traffic_payroll_payments(jsonb,jsonb)') is null
  or to_regprocedure('public.traffic_payroll_payment_earned(jsonb)') is null then
  raise exception 'Спочатку встановіть міграції виплат зарплати (traffic_payroll_payments).';
 end if;
end $$;

create schema if not exists sto_finance_private;
revoke all on schema sto_finance_private from public,anon;
grant usage on schema sto_finance_private to authenticated;

create or replace function sto_finance_private.object_value(v jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if jsonb_typeof(v)='string' then v:=(v#>>'{}')::jsonb;end if;
 return case when jsonb_typeof(v)='object' then v else '{}'::jsonb end;
exception when invalid_text_representation then return '{}'::jsonb;
end $$;

create or replace function sto_finance_private.money(v jsonb)
returns numeric language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare raw text; n numeric;
begin
 if jsonb_typeof(v) not in ('number','string') or v is null then return null;end if;
 raw:=replace(regexp_replace(v#>>'{}',U&'[[:space:]\00A0\202F]','','g'),',','.');
 if raw !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null;end if;
 n:=raw::numeric;
 if abs(n)>1000000000000000 then return null;end if;
 return n;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

create or replace function sto_finance_private.day(v text)
returns date language plpgsql stable security invoker set search_path=pg_catalog as $$
declare d date; s text;
begin
 if v is null or btrim(v)='' then return null;end if;
 if v ~ '^\d{2}\.\d{2}\.\d{4}$' then s:=substr(v,7,4)||'-'||substr(v,4,2)||'-'||substr(v,1,2);
 elsif v ~ '^\d{4}-\d{2}-\d{2}([T ].*)?$' then
  if v ~ '[T ].*(Z|[+-]\d{2}:?\d{2})$' then return (v::timestamptz at time zone 'Europe/Kyiv')::date;end if;
  s:=left(v,10);
 else return null;end if;
 d:=s::date;
 if to_char(d,'YYYY-MM-DD')<>s then return null;end if;
 return d;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;

-- Payment corrections are applied at their own date. This retains a payment
-- in earlier periods when it is voided later. It is a corrected settlement
-- movement, not evidence of a physical refund; the DTO always explains this.
create or replace function sto_finance_private.payments(
 target jsonb,header jsonb,f date,t date,pf date,pt date)
returns table(earned numeric,paid_to numeric,paid_period numeric,paid_previous numeric,
 legacy boolean,invalid boolean,undated integer,corrections integer)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare ledger jsonb; e jsonb; amount numeric; d date;
begin
 earned:=public.traffic_payroll_payment_earned(target)::numeric;
 ledger:=public.traffic_payroll_payments(target,header);
 paid_to:=0;paid_period:=0;paid_previous:=0;invalid:=false;undated:=0;corrections:=0;
 legacy:=not(target?'__payroll_payments') and jsonb_array_length(ledger)>0;
 for e in select value from jsonb_array_elements(ledger) loop
  d:=sto_finance_private.day(e->>'date');
  if d is null then undated:=undated+1;continue;end if;
  if e?'amount' then amount:=sto_finance_private.money(e->'amount');
  else
   select -sto_finance_private.money(value->'amount') into amount from jsonb_array_elements(ledger)
    where value->>'id'=e->>'voids';
   if d<=t then corrections:=corrections+1;end if;
  end if;
  if amount is null then raise exception 'Invalid payment amount';end if;
  if d<=t then paid_to:=paid_to+amount;end if;
  if d between f and t then paid_period:=paid_period+amount;end if;
  if d between pf and pt then paid_previous:=paid_previous+amount;end if;
 end loop;
 earned:=round(earned,2);paid_to:=round(paid_to,2);
 paid_period:=round(paid_period,2);paid_previous:=round(paid_previous,2);
 return next;
exception when others then
 -- Financial mutations remain strict. A read-only overview reports corrupt
 -- legacy records as incomplete without hiding the rest of the workshop.
 earned:=0;paid_to:=0;paid_period:=0;paid_previous:=0;legacy:=false;
 invalid:=true;undated:=0;corrections:=0;return next;
end $$;

-- Private schema is not exposed by PostgREST. Never publish archive payloads.
create or replace function sto_finance_private.archived_payroll()
returns table(employee_id bigint,act_id bigint,history_day text,entry jsonb)
language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if to_regclass('sto_payroll_private.act_freeze_payroll') is null then return;end if;
 if not has_schema_privilege(current_user,'sto_payroll_private','USAGE')
  or not has_table_privilege(current_user,'sto_payroll_private.act_freeze_payroll','SELECT') then return;end if;
 return query execute $q$
  select a.employee_id,a.act_id::bigint,f.value->>'date',f.value->'value'
  from sto_payroll_private.act_freeze_payroll a
  cross join lateral jsonb_array_elements(a.fragments) f
 $q$;
end $$;

create or replace function public.traffic_financial_overview(
 p_from date,p_to date,p_known_revision text default null)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog,public set timezone='Europe/Kyiv' as $$
declare
 previous_from date; previous_to date; today date:=(statement_timestamp() at time zone 'Europe/Kyiv')::date;
 revision text; resource_version text; result jsonb; archive_available boolean:=false;
begin
 if p_from is null or p_to is null or p_from>p_to or p_from<date '1900-01-01' or p_to>date '2199-12-31' then
  raise exception 'Оберіть коректний період «Від» і «До».' using errcode='22023';
 end if;
 previous_to:=p_from-1;previous_from:=p_from-(p_to-p_from+1);
 if to_regprocedure('public.traffic_resource_revision(text[])') is not null then
  execute 'select public.traffic_resource_revision($1)' into resource_version
   using array['acts','slyusars','sclad','vutratu'];
 end if;
 -- Without installed resource markers, a fresh token prevents false cache hits.
 revision:=md5(jsonb_build_array('financial-v1',p_from,p_to,today,current_user,
  current_setting('request.jwt.claims',true),coalesce(resource_version,statement_timestamp()::text))::text);
 if p_known_revision is not null and resource_version is not null and p_known_revision=revision then
  return jsonb_build_object('formatVersion',1,'not_modified',true,'revision',revision);
 end if;
 if to_regclass('sto_payroll_private.act_freeze_payroll') is not null then
  archive_available:=has_schema_privilege(current_user,'sto_payroll_private','USAGE')
   and has_table_privilege(current_user,'sto_payroll_private.act_freeze_payroll','SELECT');
 end if;

 with periods as (
  select 'current' label,p_from f,p_to t union all select 'previous',previous_from,previous_to
 ), act_documents as materialized (
  -- Balances need older unpaid acts; this is one pass, shared by period totals,
  -- payroll joins and debts. Full documents never leave this function.
  select a.act_id::bigint id,sto_finance_private.object_value(to_jsonb(a.data)) doc,
   sto_finance_private.day(a.date_on::text) opened,sto_finance_private.day(a.date_off::text) closed,
   sto_finance_private.day(a.rosraxovano::text) settled,
   nullif(a.date_on::text,'') opened_value,nullif(a.date_off::text,'') closed_value,nullif(a.rosraxovano::text,'') settled_value,
   coalesce(sto_finance_private.money(to_jsonb(a.avans)),0) advance,
   coalesce(nullif(btrim(a."tupOplatu"::text),''),'Не визначено') method
  from public.acts a
 ), acts as materialized (
  select *,doc->'Заморожений'='true'::jsonb frozen,
   greatest(0,least(100,coalesce(sto_finance_private.money(doc->'Знижка'),0))) discount,
   coalesce(sto_finance_private.money(doc->'За роботу'),
    (select sum(coalesce(sto_finance_private.money(w->'Ціна'),0)*coalesce(sto_finance_private.money(w->'Кількість'),1))
     from jsonb_array_elements(case when jsonb_typeof(doc->'Роботи')='array' then doc->'Роботи' else '[]'::jsonb end) w),0) work_raw,
   coalesce(sto_finance_private.money(doc->'За деталі'),
    (select sum(coalesce(sto_finance_private.money(d->'Ціна'),0)*coalesce(sto_finance_private.money(d->'Кількість'),1))
     from jsonb_array_elements(case when jsonb_typeof(doc->'Деталі')='array' then doc->'Деталі' else '[]'::jsonb end) d),0) parts_raw
  from act_documents
 ), priced_acts as materialized (
  select *,round(work_raw*(1-discount/100),2) work_sale,
   round(parts_raw*(1-discount/100),2) parts_sale
  from acts
 ), staff as materialized (
  select s.slyusar_id::bigint id,sto_finance_private.object_value(to_jsonb(s.data)) doc from public.slyusars s
 ), stock_docs as materialized (
  select s.sclad_id::bigint id,to_jsonb(s) row_data,
   sto_finance_private.object_value(to_jsonb(s)->'data') doc from public.sclad s
 ), stock_values as (
  select id,
   coalesce(sto_finance_private.money(row_data->'price'),sto_finance_private.money(doc->'price')) raw_price,
   coalesce(sto_finance_private.money(row_data->'kilkist_on'),sto_finance_private.money(doc->'kilkist_on'),0) qty,
   coalesce(sto_finance_private.money(row_data->'kilkist_off'),sto_finance_private.money(doc->'kilkist_off'),0) used,
   sto_finance_private.day(coalesce(row_data->>'time_on',doc->>'time_on')) received,
   sto_finance_private.day(coalesce(row_data->>'rosraxovano',doc->>'rosraxovano')) settled,
   nullif(coalesce(row_data->>'rosraxovano',doc->>'rosraxovano'),'') is not null has_settlement,
   sto_finance_private.day(coalesce(row_data->>'povernennya',doc->>'povernennya')) returned_day,
   nullif(coalesce(row_data->>'povernennya',doc->>'povernennya'),'') is not null returned,
   coalesce(nullif(coalesce(row_data->>'sposob_oplaty',doc->>'sposob_oplaty'),''),'Не визначено') method
  from stock_docs
 ), stock as materialized (
  select *,case when raw_price>=0 then raw_price end price from stock_values
 ), parts as materialized (
  select a.id,d.ordinality part_index,coalesce(sto_finance_private.money(d.value->'Кількість'),1) qty,
   coalesce(sto_finance_private.money(d.value->'purchasePrice'),sto_finance_private.money(d.value->'buyPrice'),
    sto_finance_private.money(d.value->'Закупівельна ціна'),sto_finance_private.money(d.value->'Вхідна ціна')) saved_price,
   s.price current_price
  from priced_acts a
  cross join lateral jsonb_array_elements(case when jsonb_typeof(a.doc->'Деталі')='array' then a.doc->'Деталі' else '[]'::jsonb end) with ordinality d
  left join stock s on s.id=case when d.value->>'sclad_id' ~ '^[1-9][0-9]{0,14}$' then (d.value->>'sclad_id')::bigint end
  where a.closed between previous_from and p_to and not coalesce(a.frozen,false)
 ), costs as materialized (
  select id,sum(qty*coalesce(case when saved_price>=0 then saved_price end,current_price,0)) amount,
   count(*) filter(where (saved_price is null or saved_price<0) and current_price is null) missing,
   count(*) filter(where (saved_price is null or saved_price<0) and current_price is not null) mutable,
   count(*) number_parts
  from parts group by id
 ), live_entries as (
  select s.id employee_id,h.key history_day,e.value entry,false archived
  from staff s
  cross join lateral jsonb_each(case when jsonb_typeof(s.doc->'Історія')='object' then s.doc->'Історія' else '{}'::jsonb end) h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.value)='array' then h.value else '[]'::jsonb end) e
 ), all_entries as materialized (
  select * from live_entries
  union all select a.employee_id,a.history_day,a.entry,true from sto_finance_private.archived_payroll() a join staff s on s.id=a.employee_id
 ), expanded_payroll as materialized (
  select e.employee_id,e.history_day,e.entry,e.archived,
   case when e.entry->>'Акт' ~ '^[1-9][0-9]{0,14}$' then (e.entry->>'Акт')::bigint end act_id,
   w.value target,case when jsonb_typeof(e.entry->'Записи')='array' and jsonb_array_length(e.entry->'Записи')>0 then e.entry else null end header,
   case when jsonb_typeof(e.entry->'Записи')='array' and jsonb_array_length(e.entry->'Записи')>0 then 'work'
    when e.entry?'СуммаРоботи' then 'receiver' else 'parts' end kind,
   case when jsonb_typeof(e.entry->'Записи')='array' and jsonb_array_length(e.entry->'Записи')>0
    then 'work:'||coalesce(nullif(w.value->>'recordId',''),'legacy:'||w.ordinality::text) else 'header' end item_key
  from all_entries e
  cross join lateral jsonb_array_elements(case when jsonb_typeof(e.entry->'Записи')='array' and jsonb_array_length(e.entry->'Записи')>0
   then e.entry->'Записи' else jsonb_build_array(e.entry) end) with ordinality w
  where e.entry?'СуммаРоботи' or e.entry?'СуммаЗапчастин' or e.entry?'Зарплата' or e.entry?'ЗарплатаРоботи' or e.entry?'ЗарплатаЗапчастин' or e.entry?'Записи'
 ), payroll_ranked as materialized (
  select *,row_number() over(partition by employee_id,coalesce(act_id::text,history_day||':'||entry::text),item_key
   order by archived,history_day desc,target::text) duplicate_rank
  from expanded_payroll
 ), payroll as materialized (
  select r.employee_id,r.act_id,r.kind,r.archived,r.history_day,m.*,
   a.closed,coalesce(a.opened,sto_finance_private.day(r.history_day)) opened,
   coalesce(a.frozen,false) frozen,a.id is null missing_act,
   case when r.kind='work' then m.earned when r.kind='receiver'
    then least(m.earned,case when coalesce(sto_finance_private.money(r.target->'СуммаРоботи'),0)>0
      then coalesce(sto_finance_private.money(r.target->'ЗарплатаРоботи'),0) else 0 end) else 0 end work_earned
  from payroll_ranked r
  cross join lateral sto_finance_private.payments(r.target,r.header,p_from,p_to,previous_from,previous_to) m
  left join priced_acts a on a.id=r.act_id
  where r.duplicate_rank=1
 ), payroll_period as (
  select p.label,
   coalesce(sum(y.earned) filter(where y.closed between p.f and p.t and not y.archived and not y.frozen),0) accrued,
   coalesce(sum(y.work_earned) filter(where y.closed between p.f and p.t and not y.archived and not y.frozen),0) work,
   coalesce(sum(y.earned-y.work_earned) filter(where y.closed between p.f and p.t and not y.archived and not y.frozen),0) parts,
   coalesce(sum(case when p.label='current' then y.paid_period else y.paid_previous end),0) paid
  from periods p left join payroll y on true group by p.label
 ), expected_work_payroll as (
  select a.id,
   coalesce(sum(sto_finance_private.money(w->'Зарплата')) filter(where nullif(btrim(w->>'Слюсар'),'') is not null or nullif(w->>'slyusar_id','') is not null),0) assigned,
   count(*) filter(where coalesce(sto_finance_private.money(w->'Зарплата'),0)>0 and nullif(btrim(w->>'Слюсар'),'') is null and nullif(w->>'slyusar_id','') is null) drafts
  from priced_acts a
  cross join lateral jsonb_array_elements(case when jsonb_typeof(a.doc->'Роботи')='array' then a.doc->'Роботи' else '[]'::jsonb end) w
  where a.closed between previous_from and p_to and not coalesce(a.frozen,false) group by a.id
 ), employees as materialized (
  select s.id,coalesce(nullif(s.doc->>'Name',''),'Працівник') name,coalesce(s.doc->>'Доступ','') role,
   round(coalesce(sum(y.earned) filter(where y.closed between p_from and p_to and not y.archived and not y.frozen),0),2) accrued,
   round(coalesce(sum(y.paid_period),0),2) paid,
   round(coalesce(sum(greatest(y.earned-y.paid_to,0)) filter(where not y.archived and not y.frozen and y.opened<=p_to),0),2) due,
   round(coalesce(sum(greatest(y.paid_to-y.earned,0)) filter(where not y.archived and not y.frozen and y.opened<=p_to),0),2) overpaid
  from staff s left join payroll y on y.employee_id=s.id group by s.id,s.doc->>'Name',s.doc->>'Доступ'
 ), expense_docs as materialized (
  select v.vutratu_id::bigint id,to_jsonb(v) d from public.vutratu v
 ), expense_values as (
  select id,coalesce(sto_finance_private.money(d->'suma'),0) raw_amount,
   sto_finance_private.day(d->>'dataOnn') incurred,sto_finance_private.day(d->>'dataOff') settled,
   coalesce(nullif(d->>'kategoria',''),'Інше') category,
   coalesce(nullif(d->>'sposob_oplaty',''),'Не визначено') method,
   coalesce(d->>'act','') not in ('','0') linked,
   nullif(d->>'dataOff','') is not null has_settlement
  from expense_docs
 ), expenses as materialized (
  select *,abs(raw_amount) amount,
   not linked and lower(category) !~ '(зарплат|детал|аванс|кредит|обладнан)' included,
   not linked and lower(category) !~ '(зарплат|детал|аванс)' cash_included
  from expense_values where raw_amount<0
 ), expense_period as (
  select p.label,
   coalesce(sum(e.amount) filter(where e.included and e.incurred between p.f and p.t),0) accrued,
   coalesce(sum(e.amount) filter(where e.cash_included and e.settled between p.f and p.t),0) paid,
   coalesce(sum(e.amount) filter(where not e.included and e.incurred between p.f and p.t),0) excluded,
   coalesce(sum(e.amount) filter(where not e.cash_included and e.settled between p.f and p.t),0) excluded_paid
  from periods p left join expenses e on true group by p.label
 ), expense_categories as (
  select category,included,cash_included,round(coalesce(sum(amount) filter(where incurred between p_from and p_to),0),2) accrued,
   round(coalesce(sum(amount) filter(where settled between p_from and p_to),0),2) paid
  from expenses where incurred between p_from and p_to or settled between p_from and p_to group by category,included,cash_included
 ), act_period as (
  select p.label,
   coalesce(sum(a.work_sale) filter(where a.closed between p.f and p.t and not coalesce(a.frozen,false)),0) work_sale,
   coalesce(sum(a.parts_sale) filter(where a.closed between p.f and p.t and not coalesce(a.frozen,false)),0) parts_sale,
   coalesce(sum(coalesce(c.amount,0)) filter(where a.closed between p.f and p.t and not coalesce(a.frozen,false)),0) cost,
   count(a.id) filter(where a.closed between p.f and p.t and not coalesce(a.frozen,false)) acts_count,
   coalesce(sum(greatest(0,a.work_sale+a.parts_sale-greatest(a.advance,0))) filter(where a.settled between p.f and p.t),0) receipts
  from periods p left join priced_acts a on true left join costs c on c.id=a.id group by p.label
 ), supplier_period as (
  select p.label,coalesce(sum(s.qty*coalesce(s.price,0)) filter(where s.settled between p.f and p.t),0) paid
  from periods p left join stock s on true group by p.label
 ), totals as (
  select a.label,jsonb_build_object(
   'turnover',round(a.work_sale+a.parts_sale,2),'workRevenue',round(a.work_sale,2),'partsRevenue',round(a.parts_sale,2),
   'partsCost',round(a.cost,2),'workPayroll',round(y.work,2),'partsPayroll',round(y.parts,2),'payrollAccrued',round(y.accrued,2),
   'grossEarnings',round(a.work_sale+a.parts_sale-a.cost,2),'operatingExpenses',round(e.accrued,2),
   'profit',round(a.work_sale+a.parts_sale-a.cost-y.accrued-e.accrued,2),
   'settledReceipts',round(a.receipts,2),'payrollPaid',round(y.paid,2),'suppliersPaid',round(s.paid,2),'expensesPaid',round(e.paid,2),
   'totalPaid',round(y.paid+s.paid+e.paid,2),'netKnownMovement',round(a.receipts-y.paid-s.paid-e.paid,2),
   'closedActs',a.acts_count,'avgCheck',case when a.acts_count>0 then round((a.work_sale+a.parts_sale)/a.acts_count,2) else 0 end,
   'excludedExpenses',round(e.excluded,2),'excludedExpensesPaid',round(e.excluded_paid,2)) value
  from act_period a join payroll_period y using(label) join expense_period e using(label) join supplier_period s using(label)
 ), balances as (
  select
   round(coalesce((select sum(greatest(0,work_sale+parts_sale-greatest(advance,0))) from priced_acts
    where closed<=p_to and not coalesce(frozen,false) and (settled is null or settled>p_to)),0),2) receivables,
   round(coalesce((select sum(qty*coalesce(price,0)) from stock where received<=p_to and (settled is null or settled>p_to)
    and not(returned and (returned_day is null or returned_day<=p_to))),0),2) suppliers,
   round(coalesce((select sum(due) from employees),0),2) payroll,
   round(coalesce((select sum(amount) from expenses where cash_included and incurred<=p_to and (settled is null or settled>p_to)),0),2) expenses,
   round(coalesce((select sum(greatest(advance,0)) from priced_acts where opened<=p_to),0),2) advances
 ), channels as (
  select method,sum(incoming) incoming,sum(outgoing) outgoing from (
   select method,sum(greatest(0,work_sale+parts_sale-greatest(advance,0))) incoming,0::numeric outgoing
    from priced_acts where settled between p_from and p_to group by method
   union all select method,0,sum(qty*coalesce(price,0)) from stock where settled between p_from and p_to group by method
   union all select method,0,sum(amount) from expenses where cash_included and settled between p_from and p_to group by method
   union all select 'Не визначено',0,coalesce(sum(paid_period),0) from payroll
  ) c group by method
 ), warning_rows as (
  select 'cash_reconstructed' code,'Рух грошей відновлено з позначок розрахунку. Аванси без дати, вилучення та повернення можуть бути не враховані; залишок після введення початкової суми є розрахунковим.' message,1::bigint n,0::numeric amount,'info' severity
  union all select 'historical_state','Борги відновлено станом на дату «До» з поточних сум документів. Пізніші редагування, скасовані старі оплати та зміни статусів можуть впливати на минулі періоди.',1,0,'info'
  union all select 'inventory_current','Залишок складу показує поточний стан. Історична вартість залишків на дату «До» не зберігається.',1,0,'info'
  union all select 'missing_parts_cost','Частина деталей не має закупівельної ціни. Прибуток попередній і може бути завищеним.',
   coalesce((select sum(missing) from costs),0)::bigint,0,'warning'
  union all select 'mutable_parts_cost','Для частини деталей використано поточну ціну закупівлі зі складу. Редагування складської ціни впливає на цей звіт.',
   coalesce((select sum(mutable) from costs),0)::bigint,0,'info'
  union all select 'missing_parts_rows','Є закриті акти з продажем деталей, але без рядків деталей. Собівартість цих актів не підтверджена.',
   (select count(*) from priced_acts a where a.closed between previous_from and p_to and not coalesce(a.frozen,false) and a.parts_sale<>0 and not exists(select 1 from costs c where c.id=a.id)),0,'warning'
  union all select 'excluded_expenses','Ручні зарплати, деталі, аванси та витрати з прив’язкою до акта показано окремо. Без зв’язку з первинною операцією їх не додано повторно до прибутку та виплат.',
   (select count(*) from expenses where not cash_included and (incurred between previous_from and p_to or settled between previous_from and p_to)),
   coalesce((select sum(amount) from expenses where not cash_included and incurred between p_from and p_to),0),'warning'
  union all select 'non_operating_expenses','Оплату обладнання та кредитів включено в рух грошей. До операційного прибутку ці суми не включено: для них потрібне окреме визначення амортизації, тіла кредиту й відсотків.',
   (select count(*) from expenses where cash_included and not included and (incurred between previous_from and p_to or settled between previous_from and p_to)),
   coalesce((select sum(amount) from expenses where cash_included and not included and incurred between p_from and p_to),0),'info'
  union all select 'undated_advances','Аванси не мають окремих дат надходження. Вони відняті від остаточної оплати акта, але не віднесені до грошових надходжень періоду.',
   (select count(*) from priced_acts where advance>0 and opened<=p_to),(select advances from balances),'warning'
  union all select 'legacy_payments','Частина виплат зарплати зберігається старою позначкою дати; сума відновлена з поточного нарахування.',
   (select count(*) from payroll where legacy and (paid_period<>0 or paid_previous<>0 or paid_to<>0)),0,'info'
  union all select 'invalid_payroll','Є некоректні нарахування або історії виплат. Вони не включені в суми; перевірте зарплату перед використанням прибутку.',
   (select count(*) from payroll where invalid)
    +(select count(*) from staff where doc?'Історія' and doc->'Історія'<>'null'::jsonb and jsonb_typeof(doc->'Історія')<>'object')
    +(select count(*) from staff s cross join lateral jsonb_each(case when jsonb_typeof(s.doc->'Історія')='object' then s.doc->'Історія' else '{}'::jsonb end) h where jsonb_typeof(h.value)<>'array')
    +(select count(*) from all_entries where jsonb_typeof(entry)<>'object'),0,'warning'
  union all select 'payroll_coverage','Суми зарплат у роботах актів не збігаються з нарахуваннями працівникам. Прибуток попередній; перевірте синхронізацію зарплати.',
   (select count(*) from expected_work_payroll e where abs(e.assigned-coalesce((select sum(y.earned) from payroll y where y.act_id=e.id and y.kind='work' and not y.archived and not y.frozen),0))>0.01),0,'warning'
  union all select 'unassigned_salary','У закритих актах є зарплата без виконавця. Вона не входить до нарахувань працівникам; прибуток потребує перевірки.',
   coalesce((select sum(drafts) from expected_work_payroll),0)::bigint,0,'warning'
  union all select 'undated_payroll','Є виплати зарплати без коректної дати. Їх неможливо віднести до вибраного періоду.',
   coalesce((select sum(undated) from payroll),0)::bigint,0,'warning'
  union all select 'payroll_corrections','Скасування виплати враховане як зворотний рух на дату скасування. Це коригування розрахунку, а не підтвердження повернення готівки.',
   coalesce((select sum(corrections) from payroll),0)::bigint,0,'info'
  union all select 'duplicate_payroll','Повторні рядки нарахувань враховано один раз за працівником, актом та ідентифікатором роботи. Перевірте зарплатну історію.',
   (select count(*) from payroll_ranked where duplicate_rank>1),0,'warning'
  union all select 'payroll_pending','Є акти з незавершеною синхронізацією зарплати. Прибуток попередній.',
   (select count(*) from priced_acts where closed between previous_from and p_to and not coalesce(frozen,false) and doc->'__payroll_pending'='true'::jsonb),0,'warning'
  union all select 'archive_unavailable','Архів виплат заморожених актів недоступний. Виплати таких актів можуть бути відсутні у звіті.',
   case when not archive_available then (select count(*) from priced_acts where coalesce(frozen,false)) else 0 end,0,'warning'
  union all select 'returned_paid_stock','Є оплачені закупівлі, позначені поверненими. Платіж враховано; повернення грошей не віднімається без окремого підтвердження.',
   (select count(*) from stock where returned and settled between previous_from and p_to),0,'warning'
  union all select 'missing_stock_price','Є складські позиції без коректної закупівельної ціни. Залишок складу та зобов’язання можуть бути неповними.',
   (select count(*) from stock where price is null or price<0),0,'warning'
  union all select 'undated_settlement','Є позначки оплати без коректної дати. Віднесення до періоду потребує перевірки.',
   (select count(*) from stock where has_settlement and settled is null)+(select count(*) from expenses where has_settlement and settled is null)
    +(select count(*) from priced_acts where settled_value is not null and settled is null),0,'warning'
  union all select 'invalid_act_values','Є акти з некоректними сумами або датами. Вони можуть бути неповністю представлені у звіті.',
   (select count(*) from priced_acts where (opened_value is not null and opened is null) or (closed_value is not null and closed is null)
    or (closed between previous_from and p_to and (doc='{}'::jsonb
     or doc?'За роботу' and sto_finance_private.money(doc->'За роботу') is null
     or doc?'За деталі' and sto_finance_private.money(doc->'За деталі') is null
     or doc?'Знижка' and (sto_finance_private.money(doc->'Знижка') is null or sto_finance_private.money(doc->'Знижка') not between 0 and 100)))),0,'warning'
  union all select 'employee_limit','У таблиці показано перших 200 працівників. Загальні підсумки включають усіх працівників.',
   greatest((select count(*) from employees where accrued<>0 or paid<>0 or due<>0 or overpaid<>0)-200,0),0,'warning'
 )
 select jsonb_build_object(
  'formatVersion',1,'complete',true,'from',p_from,'to',p_to,'previousFrom',previous_from,'previousTo',previous_to,
  'generatedAt',statement_timestamp(),'revision',revision,
  'current',(select value from totals where label='current'),'previous',(select value from totals where label='previous'),
  'employees',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'role',role,'accrued',accrued,'paidInPeriod',paid,'due',due,'overpaid',overpaid) order by name,id)
   from (select * from employees where accrued<>0 or paid<>0 or due<>0 or overpaid<>0 order by name,id limit 200) e),'[]'::jsonb),
  'employeeCount',(select count(*) from employees where accrued<>0 or paid<>0 or due<>0 or overpaid<>0),
  'expenseCategories',coalesce((select jsonb_agg(jsonb_build_object('category',category,'accrued',accrued,'paid',paid,'included',included,'cashIncluded',cash_included) order by accrued desc,category)
   from expense_categories),'[]'::jsonb),
  'paymentChannels',coalesce((select jsonb_agg(jsonb_build_object('method',method,'incoming',round(incoming,2),'outgoing',round(outgoing,2)) order by method)
   from channels where incoming<>0 or outgoing<>0),'[]'::jsonb),
  'balances',(select jsonb_build_object('asOf',p_to,'basis','reconstructed_current_records','receivables',receivables,'suppliers',suppliers,'payroll',payroll,'expenses',expenses,
   'totalLiabilities',suppliers+payroll+expenses,'undatedAdvances',advances,'cashBalance',null,'freeCash',null) from balances),
  'inventory',jsonb_build_object('value',round(coalesce((select sum(greatest(qty-used,0)*coalesce(price,0)) from stock where not returned),0),2),
   'count',(select count(*) from stock where not returned and qty-used>0),'asOf','current','measuredAt',statement_timestamp()),
  'quality',jsonb_build_object('estimates',true,'warnings',coalesce((select jsonb_agg(jsonb_build_object('code',code,'message',message,'count',n,'amount',round(amount,2),'severity',severity) order by case severity when 'warning' then 0 else 1 end,code)
   from warning_rows where n>0),'[]'::jsonb))
 ) into result;
 return result;
end $$;

revoke all on function sto_finance_private.object_value(jsonb),sto_finance_private.money(jsonb),sto_finance_private.day(text),
 sto_finance_private.payments(jsonb,jsonb,date,date,date,date),sto_finance_private.archived_payroll() from public,anon;
grant execute on function sto_finance_private.object_value(jsonb),sto_finance_private.money(jsonb),sto_finance_private.day(text),
 sto_finance_private.payments(jsonb,jsonb,date,date,date,date),sto_finance_private.archived_payroll() to authenticated;
revoke all on function public.traffic_financial_overview(date,date,text) from public,anon;
grant execute on function public.traffic_financial_overview(date,date,text) to authenticated;
notify pgrst,'reload schema';
-- END FINANCIAL OVERVIEW 2026-10-25
commit;
