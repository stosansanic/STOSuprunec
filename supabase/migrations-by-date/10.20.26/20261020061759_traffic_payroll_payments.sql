-- Read-only payment ledger helpers and payroll report. Run in SQL Editor.
-- Existing tables and RLS are preserved. No historical data is rewritten.
begin;

create or replace function public.traffic_payroll_payment_number(p_value jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare raw_value text; result_value double precision;
begin
 if jsonb_typeof(p_value) not in ('number','string') or p_value is null then return null;end if;
 raw_value:=replace(regexp_replace(p_value#>>'{}',U&'[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]','','g'),',','.');
 if raw_value !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null;end if;
 result_value:=raw_value::double precision;
 if result_value::text in ('NaN','Infinity','-Infinity') then return null;end if;
 return result_value;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

create or replace function public.traffic_payroll_payment_round(p_value double precision)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if p_value is null or p_value::text in ('NaN','Infinity','-Infinity') then
  raise exception 'Некоректна сума зарплати' using errcode='22003';
 end if;
 return floor((p_value+2.220446049250313e-16::double precision)*100+0.5)/100;
end $$;

create or replace function public.traffic_payroll_payment_earned(p_target jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare result_value double precision:=0; amount double precision; field_name text; item jsonb;
begin
 if jsonb_typeof(p_target) is distinct from 'object' then raise exception 'Некоректне нарахування зарплати';end if;
 if p_target?'Зарплата' then
  result_value:=case when p_target->'Зарплата' in ('null'::jsonb,'""'::jsonb) then 0
   else public.traffic_payroll_payment_number(p_target->'Зарплата') end;
 elsif p_target?'ЗарплатаРоботи' or p_target?'ЗарплатаЗапчастин' then
  foreach field_name in array array['ЗарплатаРоботи','ЗарплатаЗапчастин'] loop
   if not(p_target?field_name) then continue;end if;
   amount:=case when p_target->field_name in ('null'::jsonb,'""'::jsonb) then 0
    else public.traffic_payroll_payment_number(p_target->field_name) end;
   if amount is null or amount<0 then raise exception 'Некоректна сума зарплати';end if;
   if field_name='ЗарплатаРоботи' and p_target?'СуммаРоботи'
    and coalesce(public.traffic_payroll_payment_number(p_target->'СуммаРоботи'),0)<=0 then amount:=0;end if;
   if field_name='ЗарплатаЗапчастин' and not(p_target?'СуммаРоботи') and p_target?'СуммаЗапчастин'
    and coalesce(public.traffic_payroll_payment_number(p_target->'СуммаЗапчастин'),0)<=0 then amount:=0;end if;
   result_value:=result_value+amount;
  end loop;
 elsif jsonb_typeof(p_target->'Записи')='array' then
  for item in select value from jsonb_array_elements(p_target->'Записи') loop
   result_value:=result_value+public.traffic_payroll_payment_earned(item);
  end loop;
 end if;
 if result_value is null or result_value<0 or result_value::text in ('NaN','Infinity','-Infinity') then
  raise exception 'Некоректна сума зарплати';
 end if;
 return result_value;
end $$;

create or replace function public.traffic_payroll_legacy_payment_date(p_target jsonb,p_header jsonb default null)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare marker jsonb;
begin
 marker:=p_target->'Розраховано';
 if coalesce(marker,'null'::jsonb) in ('null'::jsonb,'false'::jsonb,'""'::jsonb) then marker:=p_header->'Розраховано';end if;
 if coalesce(marker,'null'::jsonb) in ('null'::jsonb,'false'::jsonb,'""'::jsonb) then return '';end if;
 return coalesce(marker#>>'{}','');
end $$;

-- Returns the explicit ledger, or a virtual legacy payment without writing it.
-- Voids are immutable audit events and can address only the last active payment.
create or replace function public.traffic_payroll_payments(p_target jsonb,p_header jsonb default null)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare ledger jsonb; item jsonb; event_id text; event_ids text[]:='{}'; active_ids text[]:='{}';
 amount double precision; marker text; count_keys integer; active_count integer;
begin
 if not(p_target?'__payroll_payments') then
  marker:=public.traffic_payroll_legacy_payment_date(p_target,p_header);
  if marker='' then return '[]'::jsonb;end if;
  return jsonb_build_array(jsonb_build_object('id','legacy','amount',public.traffic_payroll_payment_earned(p_target),'date',marker));
 end if;
 ledger:=p_target->'__payroll_payments';
 if jsonb_typeof(ledger) is distinct from 'array' then raise exception 'Некоректна історія виплат';end if;
 for item in select value from jsonb_array_elements(ledger) loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Некоректний запис виплати';end if;
  select count(*) into count_keys from jsonb_object_keys(item);
  event_id:=item->>'id';
  if count_keys<>3 or jsonb_typeof(item->'id') is distinct from 'string' or nullif(btrim(event_id),'') is null
   or event_id=any(event_ids) or jsonb_typeof(item->'date') is distinct from 'string'
   or nullif(btrim(item->>'date'),'') is null then raise exception 'Некоректні або повторні дані виплати';end if;
  event_ids:=array_append(event_ids,event_id);
  if item?'amount' then
   amount:=public.traffic_payroll_payment_number(item->'amount');
   if jsonb_typeof(item->'amount') is distinct from 'number' or amount is null or amount<0 then raise exception 'Некоректна сума виплати';end if;
   active_ids:=array_append(active_ids,event_id);
  elsif item?'voids' then
   active_count:=coalesce(array_length(active_ids,1),0);
   if jsonb_typeof(item->'voids') is distinct from 'string' or active_count=0
    or active_ids[active_count] is distinct from item->>'voids' then
    raise exception 'Скасувати можна лише останню чинну виплату';
   end if;
   active_ids:=coalesce(active_ids[1:active_count-1],'{}'::text[]);
  else raise exception 'Невідомий запис виплати';
  end if;
 end loop;
 return ledger;
end $$;

create or replace function public.traffic_payroll_payment_day(p_value text)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare day_iso text; parsed date;
begin
 if p_value ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4}$' then
  day_iso:=substr(p_value,7,4)||'-'||substr(p_value,4,2)||'-'||substr(p_value,1,2);
 elsif p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then day_iso:=left(p_value,10);
 else return '';end if;
 parsed:=day_iso::date;
 if to_char(parsed,'YYYY-MM-DD')<>day_iso then return '';end if;
 return day_iso;
exception when invalid_datetime_format or datetime_field_overflow then return '';
end $$;

create or replace function public.traffic_payroll_payment_summary(
 p_target jsonb,p_header jsonb default null,p_from text default null,p_to text default null)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare ledger jsonb; item jsonb; earned double precision; paid double precision:=0; paid_period double precision:=0;
 payment_count integer:=0; period_count integer:=0; day_iso text; latest_day text:=''; latest_iso text:='';
 last_active_id text:=''; balance double precision;
 start_day text:=public.traffic_payroll_payment_day(p_from); end_day text:=public.traffic_payroll_payment_day(p_to);
begin
 earned:=public.traffic_payroll_payment_earned(p_target);
 ledger:=public.traffic_payroll_payments(p_target,p_header);
 for item in select e.value from jsonb_array_elements(ledger) e
  where e.value?'amount' and not exists(select 1 from jsonb_array_elements(ledger)v where v->>'voids'=e.value->>'id') loop
  paid:=paid+public.traffic_payroll_payment_number(item->'amount');
  payment_count:=payment_count+1;last_active_id:=item->>'id';
  day_iso:=public.traffic_payroll_payment_day(item->>'date');
  if day_iso<>'' and (start_day='' or day_iso>=start_day) and (end_day='' or day_iso<=end_day) then
   paid_period:=paid_period+public.traffic_payroll_payment_number(item->'amount');
   period_count:=period_count+1;
   if day_iso>=latest_iso then latest_iso:=day_iso;latest_day:=item->>'date';end if;
  end if;
 end loop;
 paid:=public.traffic_payroll_payment_round(paid);
 balance:=public.traffic_payroll_payment_round(earned-paid);
 return jsonb_build_object('earned',earned,'paidAmount',paid,
  'due',greatest(0,balance),'overpaid',greatest(0,-balance),
  'paidInPeriod',public.traffic_payroll_payment_round(paid_period),'hasPayment',payment_count>0,
  'hasPeriodPayment',period_count>0,'lastActiveId',last_active_id,'paidDate',latest_day,'paidIso',latest_iso);
end $$;
create or replace function public.traffic_payroll_validate(p_data jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare
 history jsonb:=coalesce(nullif(p_data->'Історія','null'::jsonb),'{}'::jsonb);
 missing_act boolean; invalid_records boolean; duplicate_act text; duplicate_record_act text;
 payroll_entry jsonb; work_entry jsonb;
begin
 if jsonb_typeof(history) is distinct from 'object' then raise exception 'Некоректна історія зарплат';end if;
 if exists(select 1 from jsonb_each(history) h where jsonb_typeof(h.value) is distinct from 'array') then
  raise exception 'Некоректна дата історії зарплат';
 end if;
 with entries as materialized (
  select x.value entry from jsonb_each(history) h cross join lateral jsonb_array_elements(h.value) x
 )
 select exists(select 1 from entries e where e.entry->>'Акт' is null),
  (select e.entry->>'Акт' from entries e group by e.entry->>'Акт' having count(*)>1 limit 1),
  exists(select 1 from entries e where e.entry?'Записи' and e.entry->'Записи'<>'null'::jsonb
   and jsonb_typeof(e.entry->'Записи') is distinct from 'array')
 into missing_act,duplicate_act,invalid_records;
 if missing_act then raise exception 'Нарахування без номера акта';end if;
 if duplicate_act is not null then raise exception 'Дублікати зарплати за актом %',duplicate_act;end if;
 if invalid_records then raise exception 'Некоректний список робіт';end if;
 select x.value->>'Акт' into duplicate_record_act
 from jsonb_each(history) h cross join lateral jsonb_array_elements(h.value) x
 cross join lateral jsonb_array_elements(coalesce(nullif(x.value->'Записи','null'::jsonb),'[]'::jsonb)) r
 where nullif(r.value->>'recordId','') is not null
 group by x.value->>'Акт',r.value->>'recordId' having count(*)>1 limit 1;
 if duplicate_record_act is not null then raise exception 'Повторні ідентифікатори робіт в акті %',duplicate_record_act;end if;
 for payroll_entry in select x.value from jsonb_each(history)h cross join lateral jsonb_array_elements(h.value)x loop
  if payroll_entry?'__payroll_payments' then perform public.traffic_payroll_payments(payroll_entry);end if;
  for work_entry in select value from jsonb_array_elements(coalesce(nullif(payroll_entry->'Записи','null'::jsonb),'[]'::jsonb)) loop
   if work_entry?'__payroll_payments' then perform public.traffic_payroll_payments(work_entry,payroll_entry);end if;
  end loop;
 end loop;
 return true;
end $$;

create or replace function public.traffic_payroll_report_optimized(
 p_filters jsonb,p_offset integer default 0,p_options boolean default true)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
 result jsonb;
 page_size integer:=greatest(1,least(200,case when coalesce(p_filters->>'page_size','')~'^[0-9]{1,3}$' then (p_filters->>'page_size')::integer else 50 end));
 selected_name text:=coalesce(p_filters->>'name','');
 mode text:=coalesce(p_filters->>'mode','open');
 from_day text:=public.traffic_payroll_iso(p_filters->>'from');
 to_day text:=public.traffic_payroll_iso(p_filters->>'to');
begin
 if mode not in ('open','close','paid') then raise exception 'Невідомий режим дат';end if;
 if to_day='' then raise exception 'Потрібна кінцева дата звіту';end if;
 -- Keep validation global: a duplicate outside the date window must still block payment.
 perform public.traffic_payroll_validate(public.payroll_json_object(to_jsonb(s.data)))
 from public.slyusars s
 where selected_name='' or public.payroll_json_object(to_jsonb(s.data))->>'Name'=selected_name;

 with employee_docs as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) doc from public.slyusars s
 ), employees as materialized (
  select * from employee_docs where selected_name='' or doc->>'Name'=selected_name
 ), history_days as materialized (
  select e.id,e.doc->>'Name' name,e.doc->'ПроцентРоботи' percent,
   h.key history_day,h.value bucket,public.traffic_payroll_iso(h.key) history_iso
  from employees e cross join lateral jsonb_each(coalesce(nullif(e.doc->'Історія','null'::jsonb),'{}'::jsonb)) h
 ), selected_days as materialized (
  -- Opening dates belong to history buckets. Filter them before expanding acts or works.
  select * from history_days where mode<>'open' or
   (history_iso<>'' and (from_day='' or history_iso>=from_day) and history_iso<=to_day)
 ), raw_entries as materialized (
  select d.id,d.name,d.percent,d.history_day,d.history_iso,x.value entry,x.ordinality entry_order,
   x.value->>'Акт' act,
   -- Cast the history value, never the indexed acts.act_id. Canonical text matching
   -- retains the old behavior for malformed, padded or out-of-range legacy IDs.
   case when x.value->>'Акт' ~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$' then
    case when (x.value->>'Акт')::numeric between -9223372036854775808 and 9223372036854775807
     then (x.value->>'Акт')::bigint end end act_number
  from selected_days d cross join lateral jsonb_array_elements(d.bucket) with ordinality x
 ), act_ids as materialized (
  select distinct act_number from raw_entries where act_number is not null
 ), act_docs as materialized (
  -- Parse each referenced act once, even if several employees worked on it.
  select a.act_id,a.date_off,parsed.doc->'Заморожений'='true'::jsonb frozen,
   parsed.doc->'__payroll_pending'='true'::jsonb pending
  from act_ids i join public.acts a on a.act_id=i.act_number
  -- Keep one evaluation of the parser, but materialize only two flags, not act JSON.
  cross join lateral (select public.payroll_json_object(to_jsonb(a.data)) doc offset 0) parsed
 ), entries as materialized (
  select r.*,a.act_id existing_act_id,a.date_off,
   a.frozen,a.pending,
   case when a.act_id is not null then coalesce(a.date_off::text,'') else coalesce(r.entry->>'ДатаЗакриття','') end close_day,
   case when a.act_id is not null then a.date_off is not null else coalesce(r.entry->>'ДатаЗакриття','')<>'' end closed
  from raw_entries r left join act_docs a on a.act_id=r.act_number
 ), scoped_entries as materialized (
  -- Closing dates cannot be inferred from opening dates. Filter their effective
  -- act/legacy date after the join, but still before expanding works.
  select * from entries where not coalesce(frozen,false) and
   (mode<>'close' or (public.traffic_payroll_iso(close_day)<>''
    and (from_day='' or public.traffic_payroll_iso(close_day)>=from_day)
    and public.traffic_payroll_iso(close_day)<=to_day))
 ), expanded as (
  select e.*,case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0 then 'work'
   when entry?'СуммаРоботи' then 'receiver' when entry?'СуммаЗапчастин' then 'parts' else 'unknown' end kind,
   r.value row_data,r.ordinality::integer-1 work_index
  from scoped_entries e cross join lateral jsonb_array_elements(
   case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0
    then entry->'Записи' else '[null]'::jsonb end) with ordinality r
 ), dated_rows as (
  select e.*,d.paid_day,d.payment_summary,
   case when kind='work' then coalesce(row_data->>'Робота','') when kind='receiver' then '-' else 'Запчастини' end work,
   case when mode='paid' then d.payment_summary->>'paidIso'
    when mode='close' then public.traffic_payroll_iso(close_day) else history_iso end filter_day
  from expanded e cross join lateral (
   select payment_summary,payment_summary->>'paidDate' paid_day from (
    select public.traffic_payroll_payment_summary(
     case when kind='work' then row_data else entry end,
     case when kind='work' then entry else null end,from_day,to_day) payment_summary offset 0
   ) calculated
  ) d
  where kind<>'unknown' and not(kind='work' and coalesce(row_data->'Кількість'='0'::jsonb,false)
   and not public.traffic_search_truthy(row_data->'Зарплата')
   and not coalesce((d.payment_summary->>'hasPayment')::boolean,false))
 ), value_rows as materialized (
  -- Store scalar report values only. Do not copy the complete act/work JSON into
  -- every expanded row of the materialized totals/sort pipeline.
  select id,name,percent,history_day,history_iso,entry_order,act,existing_act_id,date_off,closed,pending,
   kind,work_index,paid_day,work,
   (payment_summary->>'earned')::double precision earned,
   (payment_summary->>'paidAmount')::double precision paid_amount,
   (payment_summary->>'due')::double precision due,
   (payment_summary->>'overpaid')::double precision overpaid,
   (payment_summary->>'paidInPeriod')::double precision paid_period,
   (payment_summary->>'hasPayment')::boolean has_payment,
   coalesce(public.traffic_search_number(row_data->'Ціна'),0)*coalesce(public.traffic_search_number(row_data->'Кількість'),0) work_total,
   coalesce(public.traffic_search_number(row_data->'Зарплата'),0) work_salary,
   coalesce(public.traffic_search_number(entry->'СуммаРоботи'),0) work_sum,
   coalesce(public.traffic_search_number(entry->'СуммаЗапчастин'),0) parts_sum,
   coalesce(public.traffic_search_number(entry->'ЗарплатаРоботи'),0) receiver_work_salary,
   coalesce(public.traffic_search_number(entry->'ЗарплатаЗапчастин'),0) parts_salary
  from dated_rows where filter_day<>'' and (from_day='' or filter_day>=from_day) and filter_day<=to_day
 ), date_matches as materialized (
  select *,case when kind='work' then work_total when kind='receiver' then work_sum+parts_sum else parts_sum end revenue,
   earned salary
  from value_rows
 ), matches as materialized (
  select * from date_matches where
   (coalesce(p_filters->>'act','')='' or act=p_filters->>'act')
   and (coalesce(p_filters->>'work','')='' or strpos(lower(work),lower(p_filters->>'work'))>0)
   and (coalesce(p_filters->>'payment','all')='all'
    or (p_filters->>'payment'='paid' and has_payment and due=0)
    or (p_filters->>'payment'='unpaid' and due>0))
   and (coalesce(p_filters->>'status','all')='all' or (p_filters->>'status'='closed' and closed) or (p_filters->>'status'='open' and not closed))
   and (coalesce(p_filters->>'percentage','all')='all' or (kind='work' and salary<>0 and coalesce(public.traffic_search_number(percent),0)<>0 and
    case when p_filters->>'percentage'='higher' then (case when revenue>0 then salary/revenue*100 else 0 end)>public.traffic_search_number(percent)
     else (case when revenue>0 then salary/revenue*100 else 0 end)<public.traffic_search_number(percent) end))
 ), page as materialized (
  select *,coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) sort_act,
   case when mode='paid' then public.traffic_payroll_iso(paid_day) else history_iso end sort_day
  from matches order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index
  offset greatest(coalesce(p_offset,0),0) limit page_size
 ), page_entries as (
  -- Full act fragments remain available for the existing guarded payroll writes.
  select distinct p.id,p.name,p.percent,p.history_day,r.entry,p.entry_order
  from page p join raw_entries r on r.id=p.id and r.history_day=p.history_day and r.entry_order=p.entry_order
 ), histories as (
  select id,name,percent,history_day,jsonb_agg(entry order by entry_order) entries
  from page_entries group by id,name,percent,history_day
 ), rows as (
  select id,jsonb_build_object('slyusar_id',id,'data',jsonb_build_object('Name',name,'ПроцентРоботи',percent,'Історія',jsonb_object_agg(history_day,entries))) row
  from histories group by id,name,percent
 ), totals as (
  select count(*) total,coalesce(sum(revenue),0) revenue,coalesce(sum(salary),0) salary,
   coalesce(sum(paid_amount),0) paid_amount,coalesce(sum(due),0) due,
   coalesce(sum(overpaid),0) overpaid,coalesce(sum(paid_period),0) paid_period from matches
 )
 select jsonb_build_object(
  'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
  'keys',coalesce((select jsonb_agg(jsonb_build_array(id,history_day,act,case when kind='work' then work_index else null end)
   order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index) from page),'[]'::jsonb),
  'statuses',coalesce((select jsonb_agg(jsonb_build_object('actId',id,'dateOff',date_off,'isClosed',closed,'isFrozen',false,'payrollPending',pending))
   from (select distinct existing_act_id::text id,date_off,closed,pending from page where existing_act_id is not null)s),'[]'::jsonb),
  'page_size',page_size,'total',t.total,'revenue',t.revenue,'salary',t.salary,
  'paidAmount',t.paid_amount,'due',t.due,'overpaid',t.overpaid,'paidInPeriod',t.paid_period,
  'has_more',t.total>greatest(coalesce(p_offset,0),0)+page_size,
  'acts',case when coalesce(p_options,true) then coalesce((select jsonb_agg(act order by coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) desc)
   from(select distinct act from date_matches)a),'[]'::jsonb) else '[]'::jsonb end,
  'works',case when coalesce(p_options,true) then coalesce((select jsonb_agg(work order by work)
   from(select distinct work from date_matches order by work limit 150)w),'[]'::jsonb) else '[]'::jsonb end
 ) into result from totals t;
 return result;
end $$;

-- Both deployed API versions use the same optimized query. A separate core
-- also keeps reinstalling the previous v2 wrapper safe (no wrapper recursion).
create or replace function public.traffic_payroll_report(p_filters jsonb,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select public.traffic_payroll_report_optimized(p_filters,p_offset,true);
$$;
create or replace function public.traffic_payroll_report_v2(p_filters jsonb,p_offset integer default 0,p_options boolean default true)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select public.traffic_payroll_report_optimized(p_filters,p_offset,p_options);
$$;

revoke all on function public.traffic_payroll_validate(jsonb),public.traffic_payroll_report_optimized(jsonb,integer,boolean),
 public.traffic_payroll_report(jsonb,integer),public.traffic_payroll_report_v2(jsonb,integer,boolean) from public;
grant execute on function public.traffic_payroll_validate(jsonb),public.traffic_payroll_report_optimized(jsonb,integer,boolean),
 public.traffic_payroll_report(jsonb,integer),public.traffic_payroll_report_v2(jsonb,integer,boolean) to anon,authenticated;

revoke all on function public.traffic_payroll_payment_number(jsonb),public.traffic_payroll_payment_round(double precision),
 public.traffic_payroll_payment_earned(jsonb),public.traffic_payroll_legacy_payment_date(jsonb,jsonb),
 public.traffic_payroll_payments(jsonb,jsonb),public.traffic_payroll_payment_day(text),
 public.traffic_payroll_payment_summary(jsonb,jsonb,text,text) from public;
grant execute on function public.traffic_payroll_payment_number(jsonb),public.traffic_payroll_payment_round(double precision),
 public.traffic_payroll_payment_earned(jsonb),public.traffic_payroll_legacy_payment_date(jsonb,jsonb),
 public.traffic_payroll_payments(jsonb,jsonb),public.traffic_payroll_payment_day(text),
 public.traffic_payroll_payment_summary(jsonb,jsonb,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;


