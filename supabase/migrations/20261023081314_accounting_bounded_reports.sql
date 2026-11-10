-- Bounded accounting report payloads. Existing financial formulas, tables and RLS remain authoritative.
-- Requires payroll payments/ledger and accounting payment scope migrations from 2026-10-20/21.
begin;

-- Canonical text equality matches the old numeric_id::text join, including
-- rejection of padded, signed-plus, decimal and out-of-bigint legacy values.
create or replace function public.traffic_accounting_canonical_id(p_value text)
returns bigint language plpgsql immutable security invoker set search_path=pg_catalog as $$
begin
 if p_value !~ '^(0|[1-9][0-9]{0,18}|-[1-9][0-9]{0,18})$' then return null;end if;
 if p_value::numeric not between -9223372036854775808 and 9223372036854775807 then return null;end if;
 return p_value::bigint;
end $$;

-- Validate complete affected histories under the same act -> employee lock order.
-- The existing writer remains authoritative for exact target CAS and ledger rules.
create or replace function public.write_payroll_report_payment_batch(p_employees jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; change jsonb; actual jsonb; employee_id bigint; act_number bigint; body jsonb; receipts jsonb; fragments jsonb;
 part jsonb; source_entry jsonb; current_target jsonb; replacement jsonb; record_key text; record_index integer; match_count integer;
begin
 if jsonb_typeof(p_employees) is distinct from 'array' or jsonb_array_length(p_employees)<1
  or jsonb_array_length(p_employees)>50 then raise exception 'Некоректний пакет зарплати';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e where coalesce(e->>'id','')!~'^[1-9][0-9]*$'
  or jsonb_typeof(e->'changes') is distinct from 'array' or jsonb_array_length(e->'changes')<1
  or jsonb_array_length(e->'changes')>2000) then raise exception 'Некоректний працівник';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e group by e->>'id' having count(*)>1) then raise exception 'Повторний працівник';end if;
 if exists(select 1 from jsonb_array_elements(p_employees) e cross join lateral jsonb_array_elements(e->'changes') c
  where coalesce(c->>'act_id','')!~'^[1-9][0-9]*$' or coalesce(c->>'entry_revision','')!~'^[a-f0-9]{32}$') then raise exception 'Некоректна версія нарахування';end if;
 for act_number in select distinct (c->>'act_id')::bigint from jsonb_array_elements(p_employees) e
  cross join lateral jsonb_array_elements(e->'changes') c order by 1 loop
  perform 1 from public.acts where act_id=act_number for update;
  if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_employees) order by (value->>'id')::bigint loop
  employee_id:=(item->>'id')::bigint;
  select public.payroll_json_object(to_jsonb(s.data)) into body from public.slyusars s where slyusar_id=employee_id for update;
  if not found then raise exception 'Працівник відсутній або недоступний' using errcode='40001';end if;
  perform public.traffic_payroll_validate(body);
  -- A new receipt must not mark stale, already loaded sibling works as current.
  -- Check the entire act entry before any target changes, while its employee is locked.
  for change in select distinct jsonb_build_object('act',value->>'act_id','revision',value->>'entry_revision','day',value->>'date')
   from jsonb_array_elements(item->'changes') loop
   actual:=public.payroll_act_entries(body->'Історія',change->>'act');
   if jsonb_array_length(actual)<>1 or actual#>>'{0,date}' is distinct from change->>'day' then
    raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';
   end if;
   source_entry:=actual#>'{0,value}';
   if md5(source_entry::text) is distinct from change->>'revision' then
    -- Preserve an exact retry after a lost response: reverting only these same
    -- desired target states must reconstruct the originally acknowledged entry.
    for part in select value from jsonb_array_elements(item->'changes') where value->>'act_id'=change->>'act' loop
     replacement:=((part->'expected')-array['Розраховано','__payroll_payments'])||(part->'desired');
     if part->>'target'='act' then current_target:=source_entry-'Записи';
     elsif part->>'target'='record' then
      record_key:=part->>'record_id';
      if record_key is not null then
       select count(*),min(ordinality::integer-1) into match_count,record_index
        from jsonb_array_elements(source_entry->'Записи') with ordinality where value->>'recordId'=record_key;
       if match_count<>1 then raise exception 'Роботу змінено' using errcode='40001';end if;
      else
       if coalesce(part->>'index','')!~'^[0-9]+$' then raise exception 'Немає індексу роботи';end if;
       record_index:=(part->>'index')::integer;
      end if;
      current_target:=source_entry#>array['Записи',record_index::text];
     else raise exception 'Невідома ціль виплати';end if;
     if current_target is not distinct from part->'expected' then continue;end if;
     if current_target is distinct from replacement then raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';end if;
     if part->>'target'='act' then source_entry:=(part->'expected')||(case when source_entry?'Записи' then jsonb_build_object('Записи',source_entry->'Записи') else '{}'::jsonb end);
     else source_entry:=jsonb_set(source_entry,array['Записи',record_index::text],part->'expected');end if;
    end loop;
    if md5(source_entry::text) is distinct from change->>'revision' then
     raise exception 'Нарахування змінено. Оновіть зарплату перед виплатою.' using errcode='40001';
    end if;
   end if;
  end loop;
 end loop;
 receipts:=public.write_payroll_payment_batch(p_employees);
 with requested as (
  select distinct (e->>'id')::bigint id,c->>'act_id' act from jsonb_array_elements(p_employees) e
   cross join lateral jsonb_array_elements(e->'changes') c
 ), employees as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) body from public.slyusars s
   where s.slyusar_id in (select id from requested)
 ), entries as (
  select r.id,r.act,x.value fragment from requested r join employees e on e.id=r.id
   cross join lateral jsonb_array_elements(public.payroll_act_entries(e.body->'Історія',r.act)) x
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'act',act,'date',fragment->>'date',
  'revision',md5((fragment->'value')::text)) order by id,act),'[]'::jsonb) into fragments from entries;
 return jsonb_build_object('receipts',receipts,'fragments',fragments);
end $$;

create or replace function public.traffic_shop_report_v3(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if nullif(p_filter->>'from','') is null or nullif(p_filter->>'to','') is null then raise exception 'Встановіть період звіту';end if;
 if p_offset<0 or p_limit<1 or p_limit>200 then raise exception 'Invalid report page'; end if;
 with shops as materialized (
  select shop_id,public.sto_read_object_v1(to_jsonb(data)) body from public.shops
 ), history_days as materialized (
  select s.shop_id,s.body->>'Name' shop,h.key date_open,h.value bucket
  from shops s cross join lateral jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) h
  where public.traffic_search_truthy(s.body->'Name') and
   (coalesce(p_filter->>'dateMode','open')<>'open' or
    (public.traffic_shop_date(h.key)<>'' and public.traffic_shop_date(h.key)>=p_filter->>'from'
     and public.traffic_shop_date(h.key)<=p_filter->>'to'))
 ), history as materialized (
  select h.shop_id,h.shop,h.date_open,e.entry,e.ord entry_ord
  from history_days h cross join lateral jsonb_array_elements(case when jsonb_typeof(h.bucket)='array' then h.bucket else '[]'::jsonb end) with ordinality e(entry,ord)
 ), raw as (
  select h.shop_id,h.shop,h.date_open,h.entry_ord,h.entry-'Деталі' entry,d.detail,d.detail_ord,a.act_id,a.date_off,
   public.sto_read_object_v1(to_jsonb(a.data)) act_body,
   n.sclad_id stock_id,to_jsonb(n) stock_row,public.sto_read_object_v1(to_jsonb(n)->'data') stock_body
  from history h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.entry->'Деталі')='array' then h.entry->'Деталі' else '[]'::jsonb end) with ordinality d(detail,detail_ord)
  left join public.acts a on a.act_id=public.traffic_accounting_canonical_id(h.entry->>'Акт')
  left join public.sclad n on n.sclad_id=public.traffic_accounting_canonical_id(d.detail->>'sclad_id')
 ), values_normalized as (
  select *,coalesce(public.traffic_search_number(detail->'Кількість'),0) quantity,
   coalesce(public.traffic_search_number(detail->'Ціна'),0) price,
   case when stock_id is not null then coalesce(public.traffic_search_number(
    case when stock_body ? 'price' then stock_body->'price'
     when jsonb_typeof(stock_row->'data')='string' and stock_body<>'{}'::jsonb then '0'::jsonb
     else stock_row->'price' end),0) end purchase_price,
   public.traffic_search_number(coalesce(stock_body->'scladNomer',stock_row->'scladNomer')) warehouse,
   greatest(coalesce(public.traffic_search_number(act_body->'Знижка'),0),0) discount,
   case when act_id is not null then coalesce(date_off::text,'') else coalesce(entry->>'ДатаЗакриття','') end date_close,
   public.traffic_search_truthy(case when detail ? 'Розраховано' then detail->'Розраховано' else entry->'Розрахунок' end) is_paid,
   coalesce(case when detail ? 'Розраховано' then detail->>'Розраховано' else entry->>'Розрахунок' end,'') payment_date,
   coalesce(detail->>'Найменування','') item,coalesce(detail->>'Каталог','') catalog
  from raw
 ), calculated as (
  select *,quantity*price total,
   case when purchase_price is not null then price*(case when discount>0 then 1-discount/100 else 1 end)*quantity-purchase_price*quantity end margin,
   case coalesce(p_filter->>'dateMode','open') when 'close' then date_close when 'paid' then payment_date else date_open end target_date
  from values_normalized
 ), matches as materialized (
  select *,public.traffic_shop_date(target_date) sort_date from calculated
  where (coalesce(p_filter->>'dateMode','open')='open' or target_date<>'')
   and (coalesce(p_filter->>'from','')='' and coalesce(p_filter->>'to','')='' or
    public.traffic_shop_date(target_date)<>'' and
    (coalesce(p_filter->>'from','')='' or public.traffic_shop_date(target_date)>=p_filter->>'from') and
    (coalesce(p_filter->>'to','')='' or public.traffic_shop_date(target_date)<=p_filter->>'to'))
   and (coalesce(p_filter->>'item','')='' or strpos(lower(item),lower(p_filter->>'item'))>0)
   and (coalesce(p_filter->>'catalog','')='' or strpos(lower(catalog),lower(p_filter->>'catalog'))>0 or
    regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(catalog,NFKC)),'[^[:alnum:]]','','g'),regexp_replace(lower(normalize(p_filter->>'catalog',NFKC)),'[^[:alnum:]]','','g'))>0)
   and (coalesce(p_filter->>'status','all')='all' or (p_filter->>'status'='closed')=(date_close<>''))
   and (coalesce(p_filter->>'payment','all')='all' or (p_filter->>'payment'='paid')=is_paid)
 ), filtered as materialized (
  select * from matches where p_filter->>'warehouse' is null or warehouse=public.traffic_search_number(p_filter->'warehouse')
 ), page as materialized (
  select * from filtered order by sort_date desc,shop_id,date_open,entry_ord,detail_ord offset p_offset limit p_limit

 )
 select jsonb_build_object(
  'items',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
   'rowId',concat(shop_id,':',date_open,':',entry_ord,':',detail_ord),'shopId',shop_id,
   'entryOrdinal',entry_ord,'detailOrdinal',detail_ord,'recordId',detail->>'recordId',
   'paymentFingerprint',encode(sha256(convert_to((detail-'Розраховано')::text,'UTF8')),'hex'),
   'dateOpen',date_open,'dateClose',date_close,'act',entry->>'Акт','automobile',coalesce(entry->>'Автомобіль',''),
   'shop',shop,'item',item,'catalog',catalog,'quantity',quantity,'price',price,'purchasePrice',purchase_price,
   'total',total,'margin',margin,'discountPercent',discount,'isPaid',is_paid,'paymentDate',payment_date,
   'sclad_id',stock_id,'scladNomer',warehouse,'isClosed',date_close<>'',
   'zapchastystName',(select public.sto_read_object_v1(to_jsonb(s.data))->>'Name' from public.slyusars s
    where s.slyusar_id=public.traffic_accounting_canonical_id(coalesce(stock_body->>'xto_zamovuv',stock_row->>'xto_zamovuv')))
  )) order by sort_date desc,shop_id,date_open,entry_ord,detail_ord) from page),'[]'::jsonb),
  'shops','[]'::jsonb,
  'totalCount',(select count(*) from filtered),
  'totals',(select jsonb_build_object('sale',coalesce(sum(total),0),'purchase',coalesce(sum(coalesce(purchase_price,0)*quantity),0),'margin',coalesce(sum(margin),0)) from filtered),
  'warehouses',coalesce((select jsonb_agg(w order by w) from (select distinct warehouse w from matches where warehouse<>0) x),'[]'::jsonb)
 ) into result;
 return result;
end $$;


create or replace function public.traffic_payroll_report_v3(
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
  -- Preserve exact selected targets for payment CAS; omit all sibling works.
  -- Original array indices are explicit, so old records without IDs remain guarded.
  select p.id,p.name,p.percent,p.history_day,p.entry_order,
   (r.entry-'Записи') || case when bool_or(p.kind='work') then jsonb_build_object(
    'Записи',jsonb_agg(r.entry->'Записи'->p.work_index order by p.work_index),
    '__report_work_indexes',jsonb_agg(p.work_index order by p.work_index))
   else case when r.entry?'Записи' then jsonb_build_object('Записи',r.entry->'Записи') else '{}'::jsonb end end
   ||jsonb_build_object('__report_entry_revision',md5(r.entry::text)) entry
  from page p join raw_entries r on r.id=p.id and r.history_day=p.history_day and r.entry_order=p.entry_order
  group by p.id,p.name,p.percent,p.history_day,p.entry_order,r.entry
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
  'format_version',3,'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
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


-- Facets intentionally use the complete period/exclusion scope, independent
-- of shop/payment/warehouse filters, but do not construct report rows or totals.
create or replace function public.traffic_stock_accounting_facets(p_filter jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f text:=p_filter->>'from'; t text:=p_filter->>'to'; mode text:=coalesce(p_filter->>'dateMode','open');
 date_column text; date_type text; result jsonb;
begin
 if f is null or t is null or f!~'^\d{4}-\d{2}-\d{2}$' or t!~'^\d{4}-\d{2}-\d{2}$'
  or f::date>t::date or mode not in ('open','paid') then raise exception 'Invalid stock facet period';end if;
 if p_filter?'exclude' and (jsonb_typeof(p_filter->'exclude') is distinct from 'array'
  or jsonb_array_length(p_filter->'exclude')>2000) then raise exception 'Invalid excluded stock rows';end if;
 date_column:=case mode when 'paid' then 'rosraxovano' else 'time_on' end;
 select case a.atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz'
  when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into date_type
 from pg_attribute a where a.attrelid='public.sclad'::regclass and a.attname=date_column and a.attnum>0 and not a.attisdropped;
 if date_type is null then raise exception 'Unsupported stock date column';end if;
 execute format($query$
 with base as materialized (
  select s."scladNomer"::text warehouse,s.xto_zamovuv::text requester from public.sclad s
  where s.%1$I >= $2::%2$s and s.%1$I < $3::%2$s
   and public.traffic_shop_date(s.%1$I::text)>=$2 and public.traffic_shop_date(s.%1$I::text)<$3
   and not exists(select 1 from jsonb_array_elements_text(coalesce($1->'exclude','[]')) x where x=s.sclad_id::text)
 ), ids as (select distinct requester::bigint id from base where coalesce(requester,'')~'^[1-9][0-9]*$')
 select jsonb_build_object('warehouses',coalesce((select jsonb_agg(id order by id) from
  (select distinct warehouse::integer id from base where coalesce(warehouse,'')~'^[1-9][0-9]*$') w),'[]'),
 'requesters',coalesce((select jsonb_agg(jsonb_build_object('id',ids.id,
  'name',coalesce(public.traffic_json_object(s.data::jsonb)->>'Name','ID: '||ids.id)) order by ids.id)
  from ids left join public.slyusars s on s.slyusar_id=ids.id),'[]'))
 $query$,date_column,date_type) into result using p_filter,f,(t::date+1)::text;
 return result;
end $$;

create or replace function public.traffic_stock_accounting_page(
 p_filter jsonb,p_cursor jsonb default null,p_limit integer default 40,
 p_include_summary boolean default true,p_expected_revision text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; facets jsonb; filter_hash text:=md5(p_filter::text);
begin
 if p_limit is null or p_limit<1 or p_limit>200 or p_include_summary is null then raise exception 'Invalid stock accounting page';end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor->>'filter' is distinct from filter_hash
   or coalesce(p_cursor->>'id','')!~'^[1-9][0-9]*$' or coalesce(p_cursor->>'day','')!~'^\d{4}-\d{2}-\d{2}$'
   or p_expected_revision is null) then raise exception 'Invalid stock accounting cursor';end if;
 with filtered as materialized (select * from public.traffic_stock_accounting_rows(p_filter)),
 stamp as (select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) version from filtered),
 candidates as (
  select * from filtered where p_cursor is null or (sort_day,(row_data->>'sclad_id')::bigint)<(p_cursor->>'day',(p_cursor->>'id')::bigint)
  order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit+1
 ), page as (select * from candidates order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(row_data||jsonb_build_object('paymentFingerprint',public.traffic_stock_payment_fingerprint(row_data))
   order by sort_day desc,(row_data->>'sclad_id')::bigint desc) from page),'[]'),
  'has_more',(select count(*)>p_limit from candidates),
  'next_cursor',(select jsonb_build_object('day',sort_day,'id',row_data->'sclad_id','filter',filter_hash)
   from page order by sort_day,(row_data->>'sclad_id')::bigint limit 1),'revision',(select version from stamp))
  ||case when p_include_summary then jsonb_build_object('summary',
   (select jsonb_build_object('totalCount',count(*),'totalAmount',coalesce(sum(amount),0),
    'remainingAmount',coalesce(sum(remaining_amount),0),'payableCount',count(*) filter(where eligible),
    'payableAmount',coalesce(sum(amount) filter(where eligible),0),
    'payableBaseline',md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint) filter(where eligible),''))) from filtered)) else '{}'::jsonb end
 into result;
 if p_expected_revision is not null and result->>'revision' is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 if p_include_summary then
  facets:=public.traffic_stock_accounting_facets(p_filter);
  result:=result||jsonb_build_object('facets',facets);
 end if;
 return result;
end $$;


create or replace function public.traffic_profit_accounting_rows(p_filter jsonb,p_cursor jsonb default null)
returns setof jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare mode text:=coalesce(p_filter->>'mode','open'); from_day date; to_day date;
 act_column text; expense_column text; act_type text; expense_type text; act_predicate text; expense_predicate text;
begin
 if jsonb_typeof(p_filter) is distinct from 'object' or mode not in ('open','close','paid') then raise exception 'Invalid profit filter'; end if;
 if coalesce(p_filter->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_filter->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Select a valid profit date range'; end if;
 from_day:=(p_filter->>'from')::date; to_day:=(p_filter->>'to')::date;
 if from_day>to_day then raise exception 'Invalid profit date range'; end if;
 if coalesce(p_filter->>'payment','2') not in ('0','1','2') or coalesce(p_filter->>'type','2') not in ('0','1','2')
  or coalesce(p_filter->>'status','2') not in ('0','1','2') or coalesce(p_filter->>'discount','2') not in ('0','1','2') then raise exception 'Invalid profit switches'; end if;
 if jsonb_typeof(coalesce(p_filter->'exclude_ids','[]'::jsonb))<>'array' then raise exception 'Invalid hidden profit IDs'; end if;
 if exists(select 1 from jsonb_array_elements_text(coalesce(p_filter->'exclude_ids','[]'::jsonb)) id where id !~ '^-?[0-9]+$') then raise exception 'Invalid hidden profit IDs'; end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$') then raise exception 'Invalid profit cursor'; end if;
 act_column:=case mode when 'open' then 'date_on' when 'close' then 'date_off' else 'rosraxovano' end;
 expense_column:=case mode when 'paid' then 'dataOff' else 'dataOnn' end;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into act_type
  from pg_attribute where attrelid='public.acts'::regclass and attname=act_column and attnum>0 and not attisdropped;
 select case atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz' when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into expense_type
  from pg_attribute where attrelid='public.vutratu'::regclass and attname=expense_column and attnum>0 and not attisdropped;
 if act_type is null or expense_type is null then raise exception 'Unsupported accounting date column'; end if;
 act_predicate:=case when act_type='timestamptz' then format('a.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and a.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',act_column,act_column)
  else format('a.%I >= $1::%s and a.%I < $2::%s',act_column,act_type,act_column,act_type) end;
 expense_predicate:=case when expense_type='timestamptz' then format('v.%I >= ($1::timestamp at time zone ''Europe/Kyiv'') and v.%I < ($2::timestamp at time zone ''Europe/Kyiv'')',expense_column,expense_column)
  else format('v.%I >= $1::%s and v.%I < $2::%s',expense_column,expense_type,expense_column,expense_type) end;
 return query execute format($query$
 with acts as materialized (
  select a.act_id,a.client_id,a.cars_id,a.date_on,a.date_off,a.rosraxovano,a.xto_rozraxuvav,a.avans,a."tupOplatu",
   public.sto_read_object_v1(to_jsonb(a.data)) d,public.traffic_profit_accounting_day(a.date_on::text) AS day
  from public.acts a where %s
   and ($3->'payment_ids' is null or a.act_id in (select -(x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint<0))
 ), visible_acts as materialized (
  select * from acts where d->'Заморожений' is distinct from 'true'::jsonb
   and ($4 is null or (day,-act_id)<($4->>'date',($4->>'id')::bigint))
 ), staff as materialized (
  -- Parse each employee once; materialize histories only for receivers.
  select s.slyusar_id,parsed.d from public.slyusars s
  cross join lateral (select public.sto_read_object_v1(to_jsonb(s.data)) d offset 0) parsed
  where exists(select 1 from visible_acts) and parsed.d->>'Доступ'='Приймальник'
 ), salary_records as (
  select s.slyusar_id,h.key day_key,e.ord,public.traffic_profit_accounting_number(e.r->'Акт')::double precision act_id,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастин')::double precision parts,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаРоботи')::double precision work,
   public.traffic_profit_accounting_number(e.r->'ЗарплатаЗапчастистів')::double precision buyer
  from staff s cross join lateral jsonb_each(case when jsonb_typeof(s.d->'Історія')='object' then s.d->'Історія' else '{}'::jsonb end) h
   cross join lateral jsonb_array_elements(case when jsonb_typeof(h.value)='array' then h.value else '[]'::jsonb end) with ordinality e(r,ord)
  where s.d->>'Доступ'='Приймальник'
 ), salaries as (
  select s.act_id,sum(s.parts order by s.slyusar_id,s.day_key,s.ord) parts,sum(s.work order by s.slyusar_id,s.day_key,s.ord) work,sum(s.buyer order by s.slyusar_id,s.day_key,s.ord) buyer from salary_records s
   join visible_acts a on a.act_id=s.act_id where s.parts>0 or s.work>0 or s.buyer>0 group by s.act_id
 ), operands as (
  select a.*,public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за деталі')::double precision-coalesce(s.parts,0)-coalesce(s.buyer,0)) parts_profit,
   public.traffic_profit_accounting_round(public.traffic_profit_accounting_number(d->'Прибуток за роботу')::double precision-coalesce(s.work,0)) work_profit,
   public.traffic_profit_accounting_number(d->'За деталі')::double precision full_parts,public.traffic_profit_accounting_number(d->'За роботу')::double precision full_work,
   public.traffic_profit_accounting_number(d->'Знижка')::double precision discount_percent
  from visible_acts a left join salaries s on s.act_id=a.act_id
 ), act_rows as (
  select jsonb_build_object('id',-act_id,'date',day,'sortStamp',public.traffic_profit_accounting_stamp(date_on::text),'paymentDate',public.traffic_profit_accounting_day(date_off::text),'rosraxovanoDate',rosraxovano,
   'category','Прибуток','actNumber',act_id,'description','-','notes','-','amount',parts_profit::double precision+work_profit::double precision,'detailsAmount',parts_profit,'workAmount',work_profit,
   'paymentMethod',coalesce(to_jsonb(avans),'0'::jsonb),'isPaid',nullif(rosraxovano::text,'') is not null,'createdBy','Система',
   'clientId',client_id,'carId',cars_id,'xto_rozraxuvav',xto_rozraxuvav,'fullDetailsAmount',full_parts,'fullWorkAmount',full_work,'fullAmount',full_parts+full_work,
   'tupOplatu',"tupOplatu",'discount',discount_percent,'discountAmount',case when discount_percent>0 then public.traffic_profit_accounting_round((full_parts+full_work)*discount_percent/100,0,true) else 0 end) r
  from operands
 ), expenses as (
  select jsonb_build_object('id',v.vutratu_id,'date',public.traffic_profit_accounting_day(v."dataOnn"::text),'sortStamp',public.traffic_profit_accounting_stamp(v."dataOnn"::text),'paymentDate',public.traffic_profit_accounting_day(v."dataOff"::text),
   'rosraxovanoDate',v."dataOff",'category',coalesce(v.kategoria,''),'description',v.opys_vytraty,'amount',v.suma,
   'paymentMethod',coalesce(v.sposob_oplaty,''),'notes',coalesce(v.prymitky,''),'isPaid',nullif(v."dataOff"::text,'') is not null,'createdBy',v.xto_zapusav,'xto_rozraxuvav',v.xto_zapusav) r
  from public.vutratu v where v.suma<0 and v.act is null and %s
   and ($3->'payment_ids' is null or v.vutratu_id in (select (x#>>'{}')::bigint from jsonb_array_elements($3->'payment_ids') x where (x#>>'{}')::bigint>0))
   and ($4 is null or (public.traffic_profit_accounting_day(v."dataOnn"::text),v.vutratu_id)<($4->>'date',($4->>'id')::bigint))
 ), combined as (select r from act_rows union all select r from expenses)
 select r from combined where
  not exists(select 1 from jsonb_array_elements_text(coalesce($3->'exclude_ids','[]'::jsonb)) hidden where hidden::bigint=(r->>'id')::bigint)
  and
  (nullif($3->>'category','') is null or r->>'category'=$3->>'category')
  and (nullif($3->>'paymentMethod','') is null or case when r->>'category'='Прибуток' then position($3->>'paymentMethod' in coalesce(r->>'tupOplatu',''))>0 else r->>'paymentMethod'=$3->>'paymentMethod' end)
  and (coalesce($3->>'payment','2')='2' or (r->>'isPaid')::boolean=(($3->>'payment')='0'))
  and (coalesce($3->>'type','2')='2' or ((r->>'amount')::numeric>=0)=(($3->>'type')='0'))
  and (r->>'category'<>'Прибуток' or coalesce($3->>'status','2')='2' or (nullif(r->>'paymentDate','') is not null)=(($3->>'status')='0'))
  and (coalesce($3->>'discount','2')='2' or (($3->>'discount')='1' and coalesce((r->>'discountAmount')::numeric,0)>0)
   or (($3->>'discount')='0' and ((r->>'amount')::numeric<0 or coalesce((r->>'discountAmount')::numeric,0)<=0)))
 $query$,act_predicate,expense_predicate) using from_day::text,(to_day+1)::text,p_filter,p_cursor;
end $$;

revoke all on function public.traffic_accounting_canonical_id(text),
 public.traffic_shop_report_v3(jsonb,integer,integer),public.traffic_payroll_report_v3(jsonb,integer,boolean),
 public.write_payroll_report_payment_batch(jsonb),public.traffic_stock_accounting_facets(jsonb) from public;
grant execute on function public.traffic_accounting_canonical_id(text),
 public.traffic_shop_report_v3(jsonb,integer,integer),public.traffic_payroll_report_v3(jsonb,integer,boolean),
 public.write_payroll_report_payment_batch(jsonb),public.traffic_stock_accounting_facets(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
