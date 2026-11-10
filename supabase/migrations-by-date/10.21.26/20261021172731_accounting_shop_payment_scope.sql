begin;
-- Exact loaded-row settlements. Existing tables and RLS remain authoritative.
-- Requires traffic_shop_report_page, traffic_shop_report_v2 and traffic_stock_accounting_page.
create or replace function public.traffic_stock_payment_fingerprint(p_row jsonb)
returns text language sql immutable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce((select jsonb_object_agg(k,coalesce(p_row->k,'null'::jsonb))
 from unnest(array['sclad_id','time_on','shops','rahunok','akt','name','part_number','kilkist_on','kilkist_off','price',
 'povernennya','xto_povernyv','scladNomer','xto_zamovuv']) k),'{}'::jsonb)::text,'UTF8')),'hex')
$$;

create or replace function public.traffic_shop_report_page(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if nullif(p_filter->>'from','') is null or nullif(p_filter->>'to','') is null then raise exception 'Встановіть період звіту';end if;
 if p_offset<0 or p_limit<1 or p_limit>200 then raise exception 'Invalid report page'; end if;
 with shops as materialized (
  select shop_id,public.sto_read_object_v1(to_jsonb(data)) body from public.shops
 ), history as materialized (
  select s.shop_id,s.body->>'Name' shop,h.key date_open,e.entry,e.ord entry_ord
  from shops s cross join lateral jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.value)='array' then h.value else '[]'::jsonb end) with ordinality e(entry,ord)
  where public.traffic_search_truthy(s.body->'Name')
 ), raw as (
  select h.shop_id,h.shop,h.date_open,h.entry_ord,h.entry-'Деталі' entry,d.detail,d.detail_ord,a.act_id,a.date_off,
   public.sto_read_object_v1(to_jsonb(a.data)) act_body,
   n.sclad_id stock_id,to_jsonb(n) stock_row,public.sto_read_object_v1(to_jsonb(n)->'data') stock_body
  from history h
  cross join lateral jsonb_array_elements(case when jsonb_typeof(h.entry->'Деталі')='array' then h.entry->'Деталі' else '[]'::jsonb end) with ordinality d(detail,detail_ord)
  left join public.acts a on a.act_id::text=h.entry->>'Акт'
  left join public.sclad n on n.sclad_id::text=d.detail->>'sclad_id'
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
 ), page_entries as (
  select distinct p.shop_id,p.shop,p.date_open,p.entry_ord,h.entry from page p
  join history h on h.shop_id=p.shop_id and h.date_open=p.date_open and h.entry_ord=p.entry_ord
 ), page_days as (
  select shop_id,shop,date_open,jsonb_agg(entry order by entry_ord) entries from page_entries group by shop_id,shop,date_open
 ), page_shops as (
  select shop_id,jsonb_build_object('Name',shop,'Історія',jsonb_object_agg(date_open,entries)) data from page_days group by shop_id,shop
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
    where s.slyusar_id::text=coalesce(stock_body->>'xto_zamovuv',stock_row->>'xto_zamovuv'))
  )) order by sort_date desc,shop_id,date_open,entry_ord,detail_ord) from page),'[]'::jsonb),
  'shops',coalesce((select jsonb_agg(to_jsonb(s) order by shop_id) from page_shops s),'[]'::jsonb),
  'totalCount',(select count(*) from filtered),
  'totals',(select jsonb_build_object('sale',coalesce(sum(total),0),'purchase',coalesce(sum(coalesce(purchase_price,0)*quantity),0),'margin',coalesce(sum(margin),0)) from filtered),
  'warehouses',coalesce((select jsonb_agg(w order by w) from (select distinct warehouse w from matches where warehouse<>0) x),'[]'::jsonb)
 ) into result;
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
  with base as (select row_data from public.traffic_stock_accounting_rows(jsonb_build_object(
   'from',p_filter->'from','to',p_filter->'to','dateMode',p_filter->'dateMode','exclude',coalesce(p_filter->'exclude','[]')))),
  ids as (select distinct (row_data->>'xto_zamovuv')::bigint id from base where coalesce(row_data->>'xto_zamovuv','')~'^[1-9][0-9]*$')
  select jsonb_build_object('warehouses',coalesce((select jsonb_agg(id order by id) from (select distinct (row_data->>'scladNomer')::integer id
   from base where coalesce(row_data->>'scladNomer','')~'^[1-9][0-9]*$') w),'[]'),
   'requesters',coalesce((select jsonb_agg(jsonb_build_object('id',ids.id,'name',coalesce(public.traffic_json_object(s.data::jsonb)->>'Name','ID: '||ids.id)) order by ids.id)
    from ids left join public.slyusars s on s.slyusar_id=ids.id),'[]')) into facets;
  result:=result||jsonb_build_object('facets',facets);
 end if;
 return result;
end $$;


create or replace function public.write_stock_payment_rows(p_changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare change jsonb; current_row public.sclad%rowtype; converted public.sclad%rowtype; desired jsonb; actual jsonb; result jsonb:='[]'; n integer;
begin
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)<1 or jsonb_array_length(p_changes)>2000 then raise exception 'Некоректний пакет розрахунків';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) x where coalesce(x->>'id','')!~'^[1-9][0-9]*$' or coalesce(x->>'fingerprint','')!~'^[a-f0-9]{64}$' or not(x ? 'expected') or not(x ? 'desired'))
 or exists(select 1 from jsonb_array_elements(p_changes) x group by x->>'id' having count(*)>1) then raise exception 'Некоректні або повторні позиції';end if;
 for change in select value from jsonb_array_elements(p_changes) order by (value->>'id')::bigint loop
  desired:=change->'desired';
  if desired<>'null'::jsonb and (jsonb_typeof(desired)<>'string' or coalesce(change->>'desired','')!~'^\d{4}-\d{2}-\d{2}$') then raise exception 'Некоректна дата оплати';end if;
  if desired<>'null'::jsonb then perform (change->>'desired')::date;end if;
  select * into current_row from public.sclad where sclad_id=(change->>'id')::bigint for update;
  if not found then raise exception 'Позицію видалено або вона недоступна' using errcode='40001';end if;
  if nullif(current_row.povernennya::text,'') is not null then raise exception 'Повернену позицію не можна розрахувати' using errcode='40001';end if;
  if public.traffic_stock_payment_fingerprint(to_jsonb(current_row)) is distinct from change->>'fingerprint' then raise exception 'Позицію змінено. Оновіть звіт і перевірте суму.' using errcode='40001';end if;
  actual:=coalesce(to_jsonb(current_row)->'rosraxovano','null'::jsonb);
  converted:=jsonb_populate_record(null::public.sclad,jsonb_build_object('rosraxovano',desired));
  if actual is distinct from change->'expected' and actual is distinct from to_jsonb(converted)->'rosraxovano' then raise exception 'Оплату вже змінено' using errcode='40001';end if;
  if actual is distinct from to_jsonb(converted)->'rosraxovano' then
   update public.sclad set rosraxovano=converted.rosraxovano where sclad_id=current_row.sclad_id;
   get diagnostics n=row_count;if n<>1 then raise exception 'Запис оплати заборонено' using errcode='42501';end if;
  end if;
  result:=result||jsonb_build_array(jsonb_build_object('id',current_row.sclad_id,'paidAt',desired,'fingerprint',change->'fingerprint'));
 end loop;
 return result;
end $$;

create or replace function public.write_shop_detail_payments(p_changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare change jsonb; shop_id_value bigint; current_row public.shops%rowtype; converted public.shops%rowtype; original jsonb; body jsonb; bucket jsonb; entry jsonb; detail jsonb; desired jsonb; actual jsonb; result jsonb:='[]'; entry_index integer; detail_index integer; n integer; day_key text;
begin
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)<1 or jsonb_array_length(p_changes)>2000 then raise exception 'Некоректний пакет розрахунків';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) x where coalesce(x->>'shopId','')!~'^[1-9][0-9]*$' or coalesce(x->>'entryOrdinal','')!~'^[1-9][0-9]*$' or coalesce(x->>'detailOrdinal','')!~'^[1-9][0-9]*$' or coalesce(x->>'fingerprint','')!~'^[a-f0-9]{64}$' or nullif(x->>'date','') is null or nullif(x->>'act','') is null or not(x ? 'expected') or not(x ? 'desired'))
 or exists(select 1 from jsonb_array_elements(p_changes) x group by x->>'shopId',x->>'date',x->>'entryOrdinal',x->>'detailOrdinal' having count(*)>1) then raise exception 'Некоректні або повторні позиції';end if;
 for shop_id_value in select distinct (value->>'shopId')::bigint from jsonb_array_elements(p_changes) order by 1 loop
  select * into current_row from public.shops where shop_id=shop_id_value for update;
  if not found then raise exception 'Магазин недоступний' using errcode='40001';end if;
  original:=to_jsonb(current_row.data);body:=public.sto_read_object_v1(original);
  for change in select value from jsonb_array_elements(p_changes) where (value->>'shopId')::bigint=shop_id_value loop
   day_key:=change->>'date';entry_index:=(change->>'entryOrdinal')::integer-1;detail_index:=(change->>'detailOrdinal')::integer-1;desired:=change->'desired';
   if desired<>'null'::jsonb and (jsonb_typeof(desired)<>'string' or coalesce(change->>'desired','')!~'^\d{4}-\d{2}-\d{2}$') then raise exception 'Некоректна дата оплати';end if;
   if desired<>'null'::jsonb then perform (change->>'desired')::date;end if;
   bucket:=body#>array['Історія',day_key];entry:=bucket->entry_index;detail:=entry#>array['Деталі',detail_index::text];
   if jsonb_typeof(bucket) is distinct from 'array' or jsonb_typeof(detail) is distinct from 'object' or entry->>'Акт' is distinct from change->>'act' then raise exception 'Позицію переміщено або видалено' using errcode='40001';end if;
   if encode(sha256(convert_to((detail-'Розраховано')::text,'UTF8')),'hex') is distinct from change->>'fingerprint' then raise exception 'Деталь змінено. Перевірте суму перед оплатою.' using errcode='40001';end if;
   actual:=coalesce(case when detail ? 'Розраховано' then detail->'Розраховано' else entry->'Розрахунок' end,'null'::jsonb);
   if actual='""'::jsonb then actual:='null';end if;
   if actual is distinct from change->'expected' and actual is distinct from desired then raise exception 'Оплату деталі вже змінено' using errcode='40001';end if;
   -- Explicit null overrides a legacy whole-act settlement without touching siblings.
   if actual is distinct from desired then body:=jsonb_set(body,array['Історія',day_key,entry_index::text,'Деталі',detail_index::text,'Розраховано'],desired);end if;
   result:=result||jsonb_build_array(jsonb_build_object('rowId',concat(shop_id_value,':',day_key,':',entry_index+1,':',detail_index+1),'paidAt',desired,'fingerprint',change->'fingerprint'));
  end loop;
  if body is distinct from public.sto_read_object_v1(original) then
   converted:=jsonb_populate_record(null::public.shops,jsonb_build_object('data',case when jsonb_typeof(original)='string' then to_jsonb(body::text) else body end));
   update public.shops set data=converted.data where shop_id=shop_id_value;
   get diagnostics n=row_count;if n<>1 then raise exception 'Запис оплати заборонено' using errcode='42501';end if;
  end if;
 end loop;
 return result;
end $$;
revoke all on function public.traffic_stock_payment_fingerprint(jsonb),public.write_stock_payment_rows(jsonb),public.write_shop_detail_payments(jsonb) from public;
grant execute on function public.traffic_stock_payment_fingerprint(jsonb),public.write_stock_payment_rows(jsonb),public.write_shop_detail_payments(jsonb) to anon,authenticated;


-- Preserve payment metadata while an act changes the non-payment part of one history entry.
create or replace function public.traffic_shop_entry_without_payments(p_entry jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
 select case when p_entry is null or p_entry='null' then p_entry else
 jsonb_set(p_entry-'Розрахунок','{Деталі}',coalesce((select jsonb_agg(value-'Розраховано' order by ord)
 from jsonb_array_elements(coalesce(p_entry->'Деталі','[]')) with ordinality d(value,ord)),'[]')) end
$$;
create or replace function public.traffic_shop_detail_legacy_identity(p_detail jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
 select jsonb_build_array(p_detail->>'sclad_id',p_detail->>'Каталог',p_detail->>'Найменування',p_detail->>'Рахунок')
$$;
create or replace function public.write_shop_history_fragments(p_shop_id bigint,p_changes jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare current_row public.shops%rowtype; converted public.shops%rowtype; original jsonb; body jsonb; change jsonb; bucket jsonb; entry jsonb; desired jsonb; old_detail jsonb; detail jsonb; details jsonb; matches integer; idx integer; n integer; day_key text; act_key text;
begin
 if p_shop_id is null or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>100 then raise exception 'Некоректний пакет історії';end if;
 select * into current_row from public.shops where shop_id=p_shop_id for update;
 if not found then raise exception 'Магазин недоступний' using errcode='40001';end if;
 original:=to_jsonb(current_row.data);body:=public.sto_read_object_v1(original);
 for change in select value from jsonb_array_elements(p_changes) loop
  day_key:=change->>'date';act_key:=change->>'act';desired:=nullif(change->'desired','null'::jsonb);
  if nullif(day_key,'') is null or nullif(act_key,'') is null or not(change ? 'expected') or not(change ? 'desired') then raise exception 'Некоректна позиція історії';end if;
  bucket:=coalesce(body#>array['Історія',day_key],'[]'::jsonb);
  if jsonb_typeof(bucket)<>'array' then raise exception 'Некоректна історія';end if;
  select count(*),min(ord)::int-1 into matches,idx from jsonb_array_elements(bucket) with ordinality x(value,ord) where value->>'Акт'=act_key;
  if matches>1 then raise exception 'Акт дублюється в історії' using errcode='40001';end if;
  entry:=case when matches=1 then bucket->idx else null end;
  if public.traffic_shop_entry_without_payments(entry) is distinct from public.traffic_shop_entry_without_payments(nullif(change->'expected','null'::jsonb))
   and public.traffic_shop_entry_without_payments(entry) is distinct from public.traffic_shop_entry_without_payments(desired) then raise exception 'Історію акта змінено. Повторіть збереження.' using errcode='40001';end if;
  if desired is not null then
   if jsonb_typeof(desired) is distinct from 'object' or desired->>'Акт' is distinct from act_key or jsonb_typeof(desired->'Деталі') is distinct from 'array' then raise exception 'Некоректна історія акта';end if;
   if exists(select 1 from jsonb_array_elements(desired->'Деталі') d where nullif(d->>'recordId','') is not null group by d->>'recordId' having count(*)>1) then raise exception 'Повторний recordId деталі' using errcode='40001';end if;
   desired:=desired-'Розрахунок';if entry ? 'Розрахунок' then desired:=desired||jsonb_build_object('Розрахунок',entry->'Розрахунок');end if;
   details:='[]';
   for detail in select value from jsonb_array_elements(desired->'Деталі') loop
    old_detail:=null;
    if nullif(detail->>'recordId','') is not null then
     select count(*) into matches from jsonb_array_elements(coalesce(entry->'Деталі','[]')) x where x->>'recordId'=detail->>'recordId';
     if matches>1 then raise exception 'Повторний recordId деталі' using errcode='40001';end if;
     select value into old_detail from jsonb_array_elements(coalesce(entry->'Деталі','[]')) where value->>'recordId'=detail->>'recordId';
    else
     select count(*) into matches from jsonb_array_elements(coalesce(entry->'Деталі','[]')) x where x-'Розраховано'=detail-'Розраховано';
     if matches>1 then raise exception 'Неоднозначна деталь без recordId' using errcode='40001';end if;
     select value into old_detail from jsonb_array_elements(coalesce(entry->'Деталі','[]')) where value-'Розраховано'=detail-'Розраховано';
    end if;
    -- Older close/reopen code removed recordId. Recover only an unambiguous
    -- legacy product identity under the already checked financial baseline.
    if old_detail is null then
     select count(*) into matches from jsonb_array_elements(coalesce(entry->'Деталі','[]')) x
      where nullif(x->>'recordId','') is null and public.traffic_shop_detail_legacy_identity(x)=public.traffic_shop_detail_legacy_identity(detail);
     if matches>1 then raise exception 'Неоднозначна стара деталь без recordId' using errcode='40001';end if;
     if matches=1 then
      if (select count(*) from jsonb_array_elements(desired->'Деталі') x where public.traffic_shop_detail_legacy_identity(x)=public.traffic_shop_detail_legacy_identity(detail))<>1 then raise exception 'Неоднозначне зіставлення старої деталі' using errcode='40001';end if;
      select value into old_detail from jsonb_array_elements(entry->'Деталі') where nullif(value->>'recordId','') is null and public.traffic_shop_detail_legacy_identity(value)=public.traffic_shop_detail_legacy_identity(detail);
     end if;
    end if;
    detail:=detail-'Розраховано';
    if old_detail ? 'Розраховано' then detail:=detail||jsonb_build_object('Розраховано',old_detail->'Розраховано');
    elsif old_detail is null then detail:=detail||jsonb_build_object('Розраховано',null);end if;
    details:=details||jsonb_build_array(detail);
   end loop;
   -- A paid position cannot disappear through an unrelated act save.
   for old_detail in select value from jsonb_array_elements(coalesce(entry->'Деталі','[]')) loop
    if coalesce(case when old_detail ? 'Розраховано' then old_detail->>'Розраховано' else entry->>'Розрахунок' end,'')<>''
     and not exists(select 1 from jsonb_array_elements(details) d where
       nullif(old_detail->>'recordId','') is not null and d->>'recordId'=old_detail->>'recordId'
       or nullif(old_detail->>'recordId','') is null and public.traffic_shop_detail_legacy_identity(d)=public.traffic_shop_detail_legacy_identity(old_detail)) then raise exception 'Спочатку скасуйте розрахунок видаленої деталі' using errcode='40001';end if;
   end loop;
   desired:=jsonb_set(desired,'{Деталі}',details);
   if idx is null then bucket:=bucket||jsonb_build_array(desired);else bucket:=jsonb_set(bucket,array[idx::text],desired);end if;
  elsif entry is not null then
   if exists(select 1 from jsonb_array_elements(coalesce(entry->'Деталі','[]')) d where coalesce(case when d ? 'Розраховано' then d->>'Розраховано' else entry->>'Розрахунок' end,'')<>'') then raise exception 'Спочатку скасуйте розрахунок видалених деталей' using errcode='40001';end if;
   bucket:=bucket-idx;
  end if;
  if not(body ? 'Історія') then body:=jsonb_set(body,'{Історія}','{}');end if;
  body:=jsonb_set(body,array['Історія',day_key],bucket);
 end loop;
 if body is distinct from public.sto_read_object_v1(original) then
  converted:=jsonb_populate_record(null::public.shops,jsonb_build_object('data',case when jsonb_typeof(original)='string' then to_jsonb(body::text) else body end));
  update public.shops set data=converted.data where shop_id=p_shop_id;get diagnostics n=row_count;
  if n<>1 then raise exception 'Запис історії заборонено' using errcode='42501';end if;
 end if;
 return jsonb_build_object('id',p_shop_id,'status','saved');
end $$;

create or replace function public.write_shop_act_status(p_act_id bigint,p_date_key text,p_shop_names text[])
returns integer language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare shop_row public.shops%rowtype; converted public.shops%rowtype; original jsonb; body jsonb; bucket jsonb; entry jsonb; idx integer; n integer; changed integer:=0; closed_at jsonb;
begin
 if p_act_id is null or nullif(p_date_key,'') is null or cardinality(p_shop_names)>2000 then raise exception 'Некоректна історія акта';end if;
 select coalesce(to_jsonb(date_off),'null') into closed_at from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 for shop_row in select * from public.shops where public.sto_read_object_v1(to_jsonb(data))->>'Name'=any(p_shop_names) order by shop_id for update loop
  original:=to_jsonb(shop_row.data);body:=public.sto_read_object_v1(original);bucket:=body#>array['Історія',p_date_key];
  if jsonb_typeof(bucket) is distinct from 'array' then continue;end if;
  select count(*),min(ord)::int-1 into n,idx from jsonb_array_elements(bucket) with ordinality x(value,ord) where value->>'Акт'=p_act_id::text;
  if n>1 then raise exception 'Акт дублюється в історії';end if;if n=0 then continue;end if;
  entry:=bucket->idx;if coalesce(entry->'ДатаЗакриття','null')=closed_at then continue;end if;
  body:=jsonb_set(body,array['Історія',p_date_key,idx::text,'ДатаЗакриття'],closed_at);
  converted:=jsonb_populate_record(null::public.shops,jsonb_build_object('data',case when jsonb_typeof(original)='string' then to_jsonb(body::text) else body end));
  update public.shops set data=converted.data where shop_id=shop_row.shop_id;get diagnostics n=row_count;
  if n<>1 then raise exception 'Запис історії заборонено' using errcode='42501';end if;changed:=changed+1;
 end loop;return changed;
end $$;
revoke all on function public.traffic_shop_entry_without_payments(jsonb),public.traffic_shop_detail_legacy_identity(jsonb),public.write_shop_history_fragments(bigint,jsonb),public.write_shop_act_status(bigint,text,text[]) from public;
grant execute on function public.traffic_shop_entry_without_payments(jsonb),public.traffic_shop_detail_legacy_identity(jsonb),public.write_shop_history_fragments(bigint,jsonb),public.write_shop_act_status(bigint,text,text[]) to anon,authenticated;

-- Row-level tokens replace legacy whole-act history baselines in the accounting UI.
create or replace function public.traffic_shop_report_v3(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select jsonb_set(public.traffic_shop_report_page(p_filter,p_offset,p_limit),'{shops}','[]'::jsonb)
$$;
revoke all on function public.traffic_shop_report_v3(jsonb,integer,integer) from public;
grant execute on function public.traffic_shop_report_v3(jsonb,integer,integer) to anon,authenticated;

notify pgrst,'reload schema';
commit;
