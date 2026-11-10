-- Report revisions use transactional resource markers; target payment baselines remain exact.
-- Requires 20261023081314 and 20261023081918. No financial formulas or RLS policies change.
begin;

create or replace function public.traffic_stock_accounting_page_rows(p_filter jsonb,p_cursor jsonb,p_limit integer)
returns table(row_data jsonb,sort_day text,amount numeric,remaining_amount numeric,eligible boolean)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f text:=p_filter->>'from'; t text:=p_filter->>'to'; mode text:=coalesce(p_filter->>'dateMode','open');
 date_column text; date_type text;
begin
 if p_limit is not null and (p_limit<1 or p_limit>201) then raise exception 'Invalid stock candidate limit';end if;
 if jsonb_typeof(p_filter) is distinct from 'object' or f is null or t is null
  or f!~'^\d{4}-\d{2}-\d{2}$' or t!~'^\d{4}-\d{2}-\d{2}$' or f::date>t::date
  or mode not in ('open','paid') or coalesce(p_filter->>'payment','2') not in ('0','1','2')
  or coalesce(p_filter->>'availability','4') not in ('0','1','2','3','4') then
  raise exception 'Invalid stock accounting filter';
 end if;
 if p_filter ? 'exclude' and (jsonb_typeof(p_filter->'exclude') is distinct from 'array' or jsonb_array_length(p_filter->'exclude')>2000) then
  raise exception 'Invalid excluded stock rows';
 end if;
 date_column:=case mode when 'paid' then 'rosraxovano' else 'time_on' end;
 select case a.atttypid when 'timestamp'::regtype then 'timestamp' when 'timestamptz'::regtype then 'timestamptz'
  when 'date'::regtype then 'date' when 'text'::regtype then 'text' when 'varchar'::regtype then 'text' end into date_type
 from pg_attribute a where a.attrelid='public.sclad'::regclass and a.attname=date_column and a.attnum>0 and not a.attisdropped;
 if date_type is null then raise exception 'Unsupported stock date column';end if;
 -- Cast bounds to the actual column type, never the indexed date column.
 return query execute format($query$
 with base as (
  select to_jsonb(s) d,public.traffic_shop_date(case $4 when 'paid' then s.rosraxovano::text else s.time_on::text end) AS day
  from public.sclad s where s.%1$I >= $2::%2$s and s.%1$I < $3::%2$s
 ), prepared as (
  select d,day,coalesce(nullif(d->>'kilkist_on',''),'0')::numeric quantity,
   coalesce(nullif(d->>'kilkist_off',''),'0')::numeric used,coalesce(nullif(d->>'price',''),'0')::numeric price,
   nullif(d->>'rosraxovano','') is not null paid,nullif(d->>'povernennya','') is not null returned
  from base where day>=$2 and day<$3
   and ($5 is null or (day,(d->>'sclad_id')::bigint)<($5->>'day',($5->>'id')::bigint))
 ), selected as (
 select * from prepared
 where (nullif($1->>'shop','') is null or lower(btrim(coalesce(d->>'shops','')))=lower(btrim($1->>'shop')))
  and (nullif($1->>'bill','') is null or strpos(lower(coalesce(d->>'rahunok','')),lower($1->>'bill'))>0)
  and (nullif($1->>'item','') is null or strpos(lower(coalesce(d->>'name','')),lower($1->>'item'))>0)
  and (nullif($1->>'catalog','') is null or strpos(lower(coalesce(d->>'part_number','')),lower($1->>'catalog'))>0
   or (regexp_replace(lower(normalize($1->>'catalog',NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(coalesce(d->>'part_number',''),NFKC)),'[^[:alnum:]]','','g'),
     regexp_replace(lower(normalize($1->>'catalog',NFKC)),'[^[:alnum:]]','','g'))>0))
  and (coalesce($1->>'payment','2')='2' or paid=($1->>'payment'='0'))
  and (coalesce($1->>'availability','4')='4'
    or $1->>'availability'='0' and quantity-used>0
    or $1->>'availability'='1' and quantity-used=0
    or $1->>'availability'='2' and quantity-used<0
    or $1->>'availability'='3' and returned)
  and (nullif($1->>'warehouse','') is null or d->>'scladNomer'=$1->>'warehouse')
  and (nullif($1->>'requester','') is null or d->>'xto_zamovuv'=$1->>'requester')
  and not exists(select 1 from jsonb_array_elements_text(coalesce($1->'exclude','[]')) x where x=d->>'sclad_id')
 order by day desc,(d->>'sclad_id')::bigint desc limit $6
 )
 select (select jsonb_object_agg(key,value) from jsonb_each(d) where key=any(array[
   'sclad_id','time_on','shops','rahunok','akt','name','part_number','kilkist_on','kilkist_off','price',
   'rosraxovano','povernennya','xto_povernyv','scladNomer','xto_zamovuv']))||jsonb_build_object('requester_name',public.traffic_json_object(st.data::jsonb)->>'Name'),day,
   quantity*price,greatest(quantity-used,0)*price,not paid and not returned
 from selected left join public.slyusars st on st.slyusar_id=case when coalesce(d->>'xto_zamovuv','')~'^[1-9][0-9]*$' then (d->>'xto_zamovuv')::bigint end
 $query$,date_column,date_type) using p_filter,f,(t::date+1)::text,mode,p_cursor,p_limit;
end $$;

create or replace function public.traffic_stock_accounting_page(
 p_filter jsonb,p_cursor jsonb default null,p_limit integer default 40,
 p_include_summary boolean default true,p_expected_revision text default null
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; facets jsonb; filter_hash text:=md5(p_filter::text); revision text;
begin
 if p_limit is null or p_limit<1 or p_limit>200 or p_include_summary is null then raise exception 'Invalid stock accounting page';end if;
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor->>'filter' is distinct from filter_hash
   or coalesce(p_cursor->>'id','')!~'^[1-9][0-9]*$' or coalesce(p_cursor->>'day','')!~'^\d{4}-\d{2}-\d{2}$'
   or p_expected_revision is null) then raise exception 'Invalid stock accounting cursor';end if;
 revision:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 with filtered as materialized (select * from public.traffic_stock_accounting_page_rows(p_filter,
  case when p_include_summary then null else p_cursor end,case when p_include_summary then null else p_limit+1 end)),
 candidates as (
  select * from filtered where p_cursor is null or (sort_day,(row_data->>'sclad_id')::bigint)<(p_cursor->>'day',(p_cursor->>'id')::bigint)
  order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit+1
 ), page as (select * from candidates order by sort_day desc,(row_data->>'sclad_id')::bigint desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(row_data||jsonb_build_object('paymentFingerprint',public.traffic_stock_payment_fingerprint(row_data))
   order by sort_day desc,(row_data->>'sclad_id')::bigint desc) from page),'[]'),
  'has_more',(select count(*)>p_limit from candidates),
  'next_cursor',(select jsonb_build_object('day',sort_day,'id',row_data->'sclad_id','filter',filter_hash)
   from page order by sort_day,(row_data->>'sclad_id')::bigint limit 1),'revision',revision)
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
 if p_cursor is not null and (jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$' or nullif(p_cursor->>'stamp','') is null) then raise exception 'Invalid profit cursor'; end if;
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
   and ($4 is null or (day,false,public.traffic_profit_accounting_stamp(date_on::text),act_id)<($4->>'date',($4->>'id')::bigint>0,$4->>'stamp',abs(($4->>'id')::bigint)))
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
   and ($4 is null or (public.traffic_profit_accounting_day(v."dataOnn"::text),true,public.traffic_profit_accounting_stamp(v."dataOnn"::text),v.vutratu_id)<($4->>'date',($4->>'id')::bigint>0,$4->>'stamp',abs(($4->>'id')::bigint)))
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

create or replace function public.traffic_profit_accounting_page(p_filter jsonb,p_cursor jsonb default null,p_limit integer default 30,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare revision text; result jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'Invalid profit page size'; end if;
 if p_cursor is not null and (coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$' or nullif(p_cursor->>'stamp','') is null) then raise exception 'Invalid profit cursor'; end if;
 if p_cursor is not null and p_expected_revision is null then raise exception 'A profit cursor requires its revision'; end if;
 if p_summary and p_cursor is not null then raise exception 'Summary is only available on the first page'; end if;
 revision:=md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text);
 if p_expected_revision is not null and p_expected_revision is distinct from revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 with report as materialized (select r from public.traffic_profit_accounting_rows(p_filter,case when p_summary then null else p_cursor end) r),
 candidates as (select r from report where p_cursor is null or (r->>'date',(r->>'id')::bigint>0,r->>'sortStamp',abs((r->>'id')::bigint))<(p_cursor->>'date',(p_cursor->>'id')::bigint>0,p_cursor->>'stamp',abs((p_cursor->>'id')::bigint))
  order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit+1),
 page as (select r from candidates order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit),
 labelled as (
  select p.r || jsonb_build_object('paymentBaseline',public.traffic_profit_payment_baseline(p.r)) || case when coalesce((p_filter->>'include_client')::boolean,false) and p.r->>'category'='Прибуток' and c.d is not null then
   jsonb_build_object('clientLabel',jsonb_build_object('ПІБ',c.d->'ПІБ','Телефон',c.d->'Телефон','Джерело',c.d->'Джерело','Додаткові',c.d->'Додаткові')) else '{}'::jsonb end
   || case when coalesce((p_filter->>'include_car')::boolean,false) and p.r->>'category'='Прибуток' and a.d is not null then
   jsonb_build_object('carLabel',jsonb_build_object('Авто',a.d->'Авто','Номер авто',a.d->'Номер авто','Обʼєм',a.d->'Обʼєм','КодДВЗ',a.d->'КодДВЗ','Пальне',a.d->'Пальне')) else '{}'::jsonb end r
  from page p left join lateral (select public.sto_read_object_v1(to_jsonb(data)) d from public.clients where client_id=(p.r->>'clientId')::bigint and coalesce((p_filter->>'include_client')::boolean,false)) c on true
   left join lateral (select public.sto_read_object_v1(to_jsonb(data)) d from public.cars where cars_id=(p.r->>'carId')::bigint and coalesce((p_filter->>'include_car')::boolean,false)) a on true
 ), totals as (
  select count(*) count,coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc),0) amount,
   coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'<>'Прибуток'),0) negative,
   coalesce(sum(greatest(public.traffic_profit_accounting_number(r->'paymentMethod')::double precision,0) order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is null),0) advances,
   coalesce(sum((r->>'detailsAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "detailsProfit",
   coalesce(sum((r->>'workAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "workProfit",
   coalesce(sum((r->>'fullDetailsAmount')::double precision-case when (r->>'discountAmount')::double precision>0 and (r->>'fullAmount')::double precision>0 then (r->>'fullDetailsAmount')::double precision*((r->>'discountAmount')::double precision/(r->>'fullAmount')::double precision) else 0::double precision end order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "cashDetails",
   coalesce(sum((r->>'fullWorkAmount')::double precision-case when (r->>'discountAmount')::double precision>0 and (r->>'fullAmount')::double precision>0 then (r->>'fullWorkAmount')::double precision*((r->>'discountAmount')::double precision/(r->>'fullAmount')::double precision) else 0::double precision end order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) "cashWork",
   coalesce(sum((r->>'discountAmount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where r->>'category'='Прибуток' and nullif(r->>'paymentDate','') is not null),0) discount,
   count(*) filter(where not (r->>'isPaid')::boolean) "eligibleCount",
   coalesce(sum((r->>'amount')::double precision order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) filter(where not (r->>'isPaid')::boolean),0) "eligibleAmount",
   md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) "eligibleBaseline"
  from report where p_summary
 )
 select jsonb_build_object('formula_version',1,'revision',revision,'rows',coalesce((select jsonb_agg(r order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) from labelled),'[]'::jsonb),
  'has_more',(select count(*)>p_limit from candidates),'next_cursor',(select jsonb_build_object('date',r->>'date','id',(r->>'id')::bigint,'stamp',r->>'sortStamp') from page order by r->>'date',((r->>'id')::bigint>0),r->>'sortStamp',abs((r->>'id')::bigint) limit 1))
  ||case when p_summary then jsonb_build_object('summary',(select to_jsonb(t) from totals t)) else '{}'::jsonb end into result;
 revision:=result->>'revision';
 if p_expected_revision is not null and p_expected_revision is distinct from revision then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 return result;
end $$;

create or replace function public.traffic_stock_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_paid_at text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare ids bigint[]; locked_ids bigint[]; baseline text; version text; n integer; converted public.sclad%rowtype;
begin
 if nullif(p_expected_revision,'') is null or coalesce(p_baseline,'')!~'^[0-9a-f]{32}$'
  or coalesce(p_paid_at,'')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid stock settlement';end if;
 version:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if version is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 select array_agg((row_data->>'sclad_id')::bigint order by (row_data->>'sclad_id')::bigint) into ids
  from public.traffic_stock_accounting_rows(p_filter) where eligible;
 if coalesce(cardinality(ids),0)=0 then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 select array_agg(sclad_id order by sclad_id) into locked_ids from
  (select sclad_id from public.sclad where sclad_id=any(ids) order by sclad_id for update) locked;
 if locked_ids is distinct from ids then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 -- Re-read after acquiring the locks: concurrent edits/deletions/settlements fail.
 select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) into baseline
  from public.traffic_stock_accounting_rows(p_filter) where eligible;
 version:=md5(public.traffic_resource_revision(array['sclad','slyusars'])||':'||p_filter::text);
 if baseline is distinct from p_baseline or version is distinct from p_expected_revision then
  raise exception 'ACCOUNTING_REPORT_STALE';end if;
 converted:=jsonb_populate_record(null::public.sclad,jsonb_build_object('rosraxovano',p_paid_at));
 update public.sclad set rosraxovano=converted.rosraxovano where sclad_id=any(ids) and rosraxovano is null and povernennya is null;
 get diagnostics n=row_count;
 if n<>cardinality(ids) then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 return jsonb_build_object('updatedCount',n);
end $$;

create or replace function public.traffic_profit_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_actor text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare captured bigint[]; baseline text; current_revision text; updated_count bigint:=0; changed bigint; stamp timestamp:=clock_timestamp() at time zone 'Europe/Kyiv';
begin
 if p_expected_revision is null or p_baseline is null or nullif(btrim(p_actor),'') is null then raise exception 'Missing payment baseline'; end if;
 select md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text),
  coalesce(array_agg((r->>'id')::bigint order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'{}'::bigint[]),
  md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) into current_revision,captured,baseline
  from public.traffic_profit_accounting_rows(p_filter) r;
 if current_revision is distinct from p_expected_revision or baseline is distinct from p_baseline then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 perform act_id from public.acts where -act_id=any(captured) order by act_id for update;
 perform vutratu_id from public.vutratu where vutratu_id=any(captured) order by vutratu_id for update;
 -- The second snapshot validates the confirmed financial inputs after row locks.
 -- Only captured IDs are paid; unrelated/new rows are never added by UPDATE.
 select md5(public.traffic_resource_revision(array['acts','vutratu','slyusars','clients','cars'])||':'||p_filter::text),
  md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) into current_revision,baseline
  from public.traffic_profit_accounting_rows(p_filter) r;
 if current_revision is distinct from p_expected_revision or baseline is distinct from p_baseline then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 update public.acts set rosraxovano=stamp,xto_rozraxuvav=p_actor where -act_id=any(captured) and nullif(rosraxovano::text,'') is null;
 get diagnostics changed=row_count; updated_count:=updated_count+changed;
 update public.vutratu set "dataOff"=stamp where vutratu_id=any(captured) and nullif("dataOff"::text,'') is null;
 get diagnostics changed=row_count; updated_count:=updated_count+changed;
 if updated_count<>cardinality(captured) then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 return jsonb_build_object('updated_count',updated_count);
end $$;

revoke all on function public.traffic_stock_accounting_page_rows(jsonb,jsonb,integer) from public;
grant execute on function public.traffic_stock_accounting_page_rows(jsonb,jsonb,integer) to anon,authenticated;

create or replace function public.traffic_payroll_report_v4(
 p_filters jsonb,p_offset integer default 0,p_options boolean default true,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
 result jsonb; revision text;
 page_size integer:=greatest(1,least(200,case when coalesce(p_filters->>'page_size','')~'^[0-9]{1,3}$' then (p_filters->>'page_size')::integer else 50 end));
 selected_name text:=coalesce(p_filters->>'name','');
 mode text:=coalesce(p_filters->>'mode','open');
 from_day text:=public.traffic_payroll_iso(p_filters->>'from');
 to_day text:=public.traffic_payroll_iso(p_filters->>'to');
begin
 if p_summary is null or (not p_summary and p_expected_revision is null) then raise exception 'Missing payroll report revision';end if;
 revision:=md5(public.traffic_resource_revision(array['slyusars','acts'])||':'||(p_filters-'page_size')::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
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
 ), candidates as materialized (
  select *,coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) sort_act,
   case when mode='paid' then public.traffic_payroll_iso(paid_day) else history_iso end sort_day
  from matches order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index
  offset greatest(coalesce(p_offset,0),0) limit page_size+1
 ), page as materialized (
  select * from candidates order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index limit page_size
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
   coalesce(sum(overpaid),0) overpaid,coalesce(sum(paid_period),0) paid_period from matches where p_summary
 )
 select jsonb_build_object(
  'format_version',4,'revision',revision,'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
  'keys',coalesce((select jsonb_agg(jsonb_build_array(id,history_day,act,case when kind='work' then work_index else null end)
   order by sort_act desc,sort_day desc,id,history_day,entry_order,work_index) from page),'[]'::jsonb),
  'statuses',coalesce((select jsonb_agg(jsonb_build_object('actId',id,'dateOff',date_off,'isClosed',closed,'isFrozen',false,'payrollPending',pending))
   from (select distinct existing_act_id::text id,date_off,closed,pending from page where existing_act_id is not null)s),'[]'::jsonb),
  'page_size',page_size,'total',t.total,'revenue',t.revenue,'salary',t.salary,
  'paidAmount',t.paid_amount,'due',t.due,'overpaid',t.overpaid,'paidInPeriod',t.paid_period,
  'has_more',(select count(*)>page_size from candidates),
  'acts',case when coalesce(p_options,true) then coalesce((select jsonb_agg(act order by coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) desc)
   from(select distinct act from date_matches)a),'[]'::jsonb) else '[]'::jsonb end,
  'works',case when coalesce(p_options,true) then coalesce((select jsonb_agg(work order by work)
   from(select distinct work from date_matches order by work limit 150)w),'[]'::jsonb) else '[]'::jsonb end
 ) into result from totals t;
 if not p_summary then result:=result-array['total','revenue','salary','paidAmount','due','overpaid','paidInPeriod'];end if;
 return result;
end $$;

create or replace function public.traffic_shop_report_v4(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; revision text;
begin
 if p_summary is null or (not p_summary and p_expected_revision is null) then raise exception 'Missing shop report revision';end if;
 revision:=md5(public.traffic_resource_revision(array['shops','acts','sclad','slyusars'])||':'||p_filter::text);
 if p_expected_revision is not null and revision is distinct from p_expected_revision then raise exception 'ACCOUNTING_REPORT_STALE';end if;
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
 ), candidates as materialized (
  select * from filtered order by sort_date desc,shop_id,date_open,entry_ord,detail_ord offset p_offset limit p_limit+1
 ), page as materialized (
  select * from candidates order by sort_date desc,shop_id,date_open,entry_ord,detail_ord limit p_limit
 )
 select jsonb_build_object(
  'revision',revision,'has_more',(select count(*)>p_limit from candidates),
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
  'totalCount',(select count(*) from filtered where p_summary),
  'totals',(select jsonb_build_object('sale',coalesce(sum(total),0),'purchase',coalesce(sum(coalesce(purchase_price,0)*quantity),0),'margin',coalesce(sum(margin),0)) from filtered where p_summary),
  'warehouses',coalesce((select jsonb_agg(w order by w) from (select distinct warehouse w from matches where p_summary and warehouse<>0) x),'[]'::jsonb)
 ) into result;
 if not p_summary then result:=result-array['totalCount','totals','warehouses'];end if;
 return result;
end $$;

revoke all on function public.traffic_payroll_report_v4(jsonb,integer,boolean,boolean,text),public.traffic_shop_report_v4(jsonb,integer,integer,boolean,text) from public;
grant execute on function public.traffic_payroll_report_v4(jsonb,integer,boolean,boolean,text),public.traffic_shop_report_v4(jsonb,integer,integer,boolean,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
