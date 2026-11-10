begin;

-- Bound every scan to the requested period using the raw date column.
-- Reuse an existing leading-column btree index, including a composite index.
do $$
declare date_column text; column_number smallint;
begin
 foreach date_column in array array['time_on','rosraxovano'] loop
  select attnum into column_number from pg_attribute
   where attrelid='public.sclad'::regclass and attname=date_column and attnum>0 and not attisdropped;
  if column_number is null then raise exception 'Missing stock date column: %',date_column;end if;
  if not exists(
   select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
   where i.indrelid='public.sclad'::regclass and i.indisvalid and i.indisready
    and i.indpred is null and i.indnkeyatts>0 and i.indkey[0]=column_number and am.amname='btree'
  ) then
   execute format('create index %I on public.sclad (%I)','traffic_stock_accounting_'||date_column||'_idx',date_column);
  end if;
 end loop;
end $$;

-- One authoritative predicate for pages, totals, export and bulk settlement.
-- Existing tables and their RLS remain authoritative; no full JSON leaves SQL.
create or replace function public.traffic_stock_accounting_rows(p_filter jsonb)
returns table(row_data jsonb,sort_day text,amount numeric,remaining_amount numeric,eligible boolean)
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f text:=p_filter->>'from'; t text:=p_filter->>'to'; mode text:=coalesce(p_filter->>'dateMode','open');
 date_column text; date_type text;
begin
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
 )
 select (select jsonb_object_agg(key,value) from jsonb_each(d) where key=any(array[
   'sclad_id','time_on','shops','rahunok','akt','name','part_number','kilkist_on','kilkist_off','price',
   'rosraxovano','povernennya','xto_povernyv','scladNomer','xto_zamovuv']))||jsonb_build_object('requester_name',public.traffic_json_object(st.data::jsonb)->>'Name'),day,
   quantity*price,greatest(quantity-used,0)*price,not paid and not returned
 from prepared left join public.slyusars st on st.slyusar_id=case when coalesce(d->>'xto_zamovuv','')~'^[1-9][0-9]*$' then (d->>'xto_zamovuv')::bigint end
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
 $query$,date_column,date_type) using p_filter,f,(t::date+1)::text,mode;
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
 select jsonb_build_object('items',coalesce((select jsonb_agg(row_data
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

-- Only names, scoped to period/shop, requested on focus/typing. No row/history download.
create or replace function public.traffic_stock_accounting_suggest(p_filter jsonb,p_field text,p_query text default '',p_item_exact text default null,p_after text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare field_name text; result jsonb;
begin
 field_name:=case p_field when 'bill' then 'rahunok' when 'item' then 'name' when 'catalog' then 'part_number' end;
 if field_name is null or length(coalesce(p_query,''))>200 then raise exception 'Invalid stock suggestion';end if;
 with names as (
  select distinct btrim(row_data->>field_name) value from public.traffic_stock_accounting_rows(jsonb_build_object(
   'from',p_filter->'from','to',p_filter->'to','dateMode',p_filter->'dateMode','shop',p_filter->'shop'))
  where nullif(btrim(row_data->>field_name),'') is not null
   and (p_item_exact is null or btrim(row_data->>'name')=p_item_exact)
 ), matches as (
  select value from names where (p_after is null or value>p_after) and
   (coalesce(p_query,'')='' or strpos(lower(value),lower(p_query))>0 or p_field='catalog' and
    regexp_replace(lower(normalize(p_query,NFKC)),'[^[:alnum:]]','','g')<>'' and
    strpos(regexp_replace(lower(normalize(value,NFKC)),'[^[:alnum:]]','','g'),regexp_replace(lower(normalize(p_query,NFKC)),'[^[:alnum:]]','','g'))>0)
  order by value limit 51
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(value order by value) from (select value from matches order by value limit 50) visible),'[]'),
   'has_more',(select count(*)>50 from matches)) into result;
 return result;
end $$;

-- A retry after commit is rejected as stale; it cannot settle any row twice.
-- Fix the candidate IDs before locking; never reevaluate a broader UPDATE filter.
create or replace function public.traffic_stock_accounting_pay(p_filter jsonb,p_expected_revision text,p_baseline text,p_paid_at text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare ids bigint[]; locked_ids bigint[]; baseline text; version text; n integer; converted public.sclad%rowtype;
begin
 if nullif(p_expected_revision,'') is null or coalesce(p_baseline,'')!~'^[0-9a-f]{32}$'
  or coalesce(p_paid_at,'')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid stock settlement';end if;
 select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) into version from public.traffic_stock_accounting_rows(p_filter);
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
 select md5(coalesce(string_agg(row_data::text,E'\n' order by (row_data->>'sclad_id')::bigint),'')) into version from public.traffic_stock_accounting_rows(p_filter);
 if baseline is distinct from p_baseline or version is distinct from p_expected_revision then
  raise exception 'ACCOUNTING_REPORT_STALE';end if;
 converted:=jsonb_populate_record(null::public.sclad,jsonb_build_object('rosraxovano',p_paid_at));
 update public.sclad set rosraxovano=converted.rosraxovano where sclad_id=any(ids) and rosraxovano is null and povernennya is null;
 get diagnostics n=row_count;
 if n<>cardinality(ids) then raise exception 'ACCOUNTING_REPORT_STALE';end if;
 return jsonb_build_object('updatedCount',n);
end $$;

revoke all on function public.traffic_stock_accounting_rows(jsonb),public.traffic_stock_accounting_page(jsonb,jsonb,integer,boolean,text),public.traffic_stock_accounting_suggest(jsonb,text,text,text,text),public.traffic_stock_accounting_pay(jsonb,text,text,text) from public;
grant execute on function public.traffic_stock_accounting_rows(jsonb),public.traffic_stock_accounting_page(jsonb,jsonb,integer,boolean,text),public.traffic_stock_accounting_suggest(jsonb,text,text,text,text),public.traffic_stock_accounting_pay(jsonb,text,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
