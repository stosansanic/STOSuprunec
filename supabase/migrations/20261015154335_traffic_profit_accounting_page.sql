-- Exact profit/cash totals with cursor pages and a fingerprint of the filtered result.
-- All queries and writes preserve caller RLS. No client/history/act documents leave the RPC.
begin;

create or replace function public.traffic_profit_accounting_number(p_value jsonb)
returns numeric language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare value text; radix integer; digit integer; result numeric:=0; i integer;
begin
 if p_value is null or p_value='null'::jsonb then return 0; end if;
 if p_value='true'::jsonb then return 1; end if;
 if p_value='false'::jsonb then return 0; end if;
 if jsonb_typeof(p_value) not in ('number','string') then return 0; end if;
 value:=btrim(p_value#>>'{}',E' \t\r\n'||chr(160));
 if value='' then return 0; end if;
 if value ~* '^0(x[0-9a-f]+|b[01]+|o[0-7]+)$' then
  radix:=case lower(substr(value,2,1)) when 'x' then 16 when 'b' then 2 else 8 end;
  if length(value)>1026 then raise exception 'Accounting number is outside the JavaScript range'; end if;
  for i in 3..length(value) loop
   digit:=strpos('0123456789abcdef',lower(substr(value,i,1)))-1;
   result:=result*radix+digit;
  end loop;
  return result;
 end if;
 if value !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' then return 0; end if;
 begin return value::numeric; exception when numeric_value_out_of_range then return 0; end;
end $$;

-- Decode the IEEE-754 input before rounding. numeric(double::text) would lose
-- the binary half-cent behavior of Number(value.toFixed(2)) / Math.round(value).
create or replace function public.traffic_profit_accounting_round(p_value double precision,p_digits integer default 2,p_math_round boolean default false)
returns numeric language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare bytes bytea:=float8send(p_value); sign integer; exponent integer; mantissa numeric; numerator numeric; denominator numeric:=1; factor numeric; i integer;
begin
 if p_value is null then return 0; end if;
 if p_digits not in (0,2) then raise exception 'Unsupported accounting precision'; end if;
 sign:=case when get_byte(bytes,0)>=128 then -1 else 1 end;
 exponent:=((get_byte(bytes,0)&127)*16)+(get_byte(bytes,1)>>4);
 if exponent=2047 then raise exception 'Non-finite accounting number'; end if;
 mantissa:=get_byte(bytes,1)&15;
 for i in 2..7 loop mantissa:=mantissa*256+get_byte(bytes,i); end loop;
 if exponent=0 then exponent:=-1074; else mantissa:=mantissa+4503599627370496; exponent:=exponent-1075; end if;
 factor:=case when p_digits=2 then 100 else 1 end;
 numerator:=mantissa*factor;
 if exponent>=0 then numerator:=numerator*power(2::numeric,exponent); else denominator:=power(2::numeric,-exponent); end if;
 return sign*div(2*numerator+denominator-case when p_math_round and sign<0 then 1 else 0 end,2*denominator)/factor;
end $$;

create or replace function public.traffic_profit_accounting_stamp(p_value text)
returns text language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if nullif(btrim(p_value),'') is null then return null; end if;
 if p_value ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' and p_value ~ '[T ]' then
  return to_char(p_value::timestamptz at time zone 'Europe/Kyiv','YYYY-MM-DD"T"HH24:MI:SS.US');
 end if;
 return to_char(p_value::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.US');
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;

create or replace function public.traffic_profit_accounting_day(p_value text)
returns text language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if nullif(btrim(p_value),'') is null then return null; end if;
 if p_value ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' and p_value ~ '[T ]' then
  return to_char(p_value::timestamptz at time zone 'Europe/Kyiv','YYYY-MM-DD');
 end if;
 return to_char(p_value::timestamp,'YYYY-MM-DD');
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;

-- One reusable financial relation for page, summary and payment eligibility.
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
 ), visible_acts as materialized (
  select * from acts where d->'Заморожений' is distinct from 'true'::jsonb
   and ($4 is null or (day,-act_id)<($4->>'date',($4->>'id')::bigint))
 ), staff as materialized (
  select s.slyusar_id,public.sto_read_object_v1(to_jsonb(s.data)) d from public.slyusars s
  where exists(select 1 from visible_acts)
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

create or replace function public.traffic_profit_accounting_page(p_filter jsonb,p_cursor jsonb default null,p_limit integer default 30,p_summary boolean default true,p_expected_revision text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare revision text; result jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'Invalid profit page size'; end if;
 if p_cursor is not null and (coalesce(p_cursor->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or coalesce(p_cursor->>'id','') !~ '^-?[0-9]+$' or nullif(p_cursor->>'stamp','') is null) then raise exception 'Invalid profit cursor'; end if;
 if p_cursor is not null and p_expected_revision is null then raise exception 'A profit cursor requires its revision'; end if;
 if p_summary and p_cursor is not null then raise exception 'Summary is only available on the first page'; end if;
 with report as materialized (select r from public.traffic_profit_accounting_rows(p_filter) r),
 fingerprint as (select md5(coalesce(string_agg(md5(r::text),',' order by (r->>'id')::bigint),'')) value from report),
 candidates as (select r from report where p_cursor is null or (r->>'date',(r->>'id')::bigint>0,r->>'sortStamp',abs((r->>'id')::bigint))<(p_cursor->>'date',(p_cursor->>'id')::bigint>0,p_cursor->>'stamp',abs((p_cursor->>'id')::bigint))
  order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit+1),
 page as (select r from candidates order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc limit p_limit),
 labelled as (
  select p.r || case when coalesce((p_filter->>'include_client')::boolean,false) and p.r->>'category'='Прибуток' and c.d is not null then
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
 select jsonb_build_object('formula_version',1,'revision',(select value from fingerprint),'rows',coalesce((select jsonb_agg(r order by r->>'date' desc,((r->>'id')::bigint>0) desc,r->>'sortStamp' desc,abs((r->>'id')::bigint) desc) from labelled),'[]'::jsonb),
  'has_more',(select count(*)>p_limit from candidates),'next_cursor',(select jsonb_build_object('date',r->>'date','id',(r->>'id')::bigint,'stamp',r->>'sortStamp') from page order by r->>'date',((r->>'id')::bigint>0),r->>'sortStamp',abs((r->>'id')::bigint) limit 1))
  ||case when p_summary then jsonb_build_object('summary',(select to_jsonb(t) from totals t)) else '{}'::jsonb end into result;
 revision:=result->>'revision';
 if p_expected_revision is not null and p_expected_revision is distinct from revision then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 return result;
end $$;

create or replace function public.traffic_profit_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_actor text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare captured bigint[]; baseline text; current_revision text; updated_count bigint:=0; changed bigint; stamp timestamp:=clock_timestamp() at time zone 'Europe/Kyiv';
begin
 if p_expected_revision is null or p_baseline is null or nullif(btrim(p_actor),'') is null then raise exception 'Missing payment baseline'; end if;
 select md5(coalesce(string_agg(md5(r::text),',' order by (r->>'id')::bigint),'')),
  coalesce(array_agg((r->>'id')::bigint order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'{}'::bigint[]),
  md5(coalesce(string_agg(r::text,'|' order by (r->>'id')::bigint) filter(where not (r->>'isPaid')::boolean),'')) into current_revision,captured,baseline
  from public.traffic_profit_accounting_rows(p_filter) r;
 if current_revision is distinct from p_expected_revision or baseline is distinct from p_baseline then raise exception using errcode='P0001',message='ACCOUNTING_REPORT_STALE'; end if;
 perform act_id from public.acts where -act_id=any(captured) order by act_id for update;
 perform vutratu_id from public.vutratu where vutratu_id=any(captured) order by vutratu_id for update;
 -- The second snapshot validates the confirmed financial inputs after row locks.
 -- Only captured IDs are paid; unrelated/new rows are never added by UPDATE.
 select md5(coalesce(string_agg(md5(r::text),',' order by (r->>'id')::bigint),'')),
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

revoke all on function public.traffic_profit_accounting_round(double precision,integer,boolean),public.traffic_profit_accounting_stamp(text),public.traffic_profit_accounting_number(jsonb),public.traffic_profit_accounting_day(text),public.traffic_profit_accounting_rows(jsonb,jsonb),public.traffic_profit_accounting_page(jsonb,jsonb,integer,boolean,text),public.traffic_profit_accounting_pay(jsonb,text,text,text) from public;
grant execute on function public.traffic_profit_accounting_round(double precision,integer,boolean),public.traffic_profit_accounting_stamp(text),public.traffic_profit_accounting_number(jsonb),public.traffic_profit_accounting_day(text),public.traffic_profit_accounting_rows(jsonb,jsonb),public.traffic_profit_accounting_page(jsonb,jsonb,integer,boolean,text),public.traffic_profit_accounting_pay(jsonb,text,text,text) to anon,authenticated;
-- Avoid duplicate indexes when an existing valid btree already leads with the date.
do $$
declare target record; relation regclass; number smallint;
begin
 for target in select * from (values ('acts','date_on'),('acts','date_off'),('acts','rosraxovano'),('vutratu','dataOnn'),('vutratu','dataOff')) x(table_name,column_name) loop
  relation:=to_regclass(format('public.%I',target.table_name));
  select attnum into number from pg_attribute where attrelid=relation and attname=target.column_name and attnum>0 and not attisdropped;
  if number is not null and not exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am a on a.oid=c.relam
   where i.indrelid=relation and i.indisvalid and i.indisready and i.indpred is null and i.indkey[0]=number and a.amname='btree') then
   execute format('create index %I on public.%I (%I)', 'traffic_profit_'||target.table_name||'_'||lower(target.column_name)||'_idx',target.table_name,target.column_name);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
