-- Read-only details-by-act report. All filters and totals precede pagination.
begin;
create or replace function public.traffic_shop_date(v text) returns text
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare s text; m text[]; y text;
begin
 if coalesce(v,'')='' then return ''; end if;
 m:=regexp_match(btrim(v),'^(\d{4})-(\d{2})-(\d{2})($|[T\s])');
 if m is not null then return m[1]||'-'||m[2]||'-'||m[3]; end if;
 s:=regexp_replace(normalize(btrim(v),NFKC),'[^0-9.\-/]','','g');
 m:=regexp_match(s,'^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$');
 if m is not null then return m[1]||'-'||lpad(m[2],2,'0')||'-'||lpad(m[3],2,'0'); end if;
 m:=regexp_match(s,'^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$');
 if m is null then return ''; end if;
 y:=m[3]; if length(y)=2 then y:=(case when y::integer>=70 then '19' else '20' end)||y;end if;
 return y||'-'||lpad(m[2],2,'0')||'-'||lpad(m[1],2,'0');
end $$;

create or replace function public.traffic_shop_report_page(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
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
   public.traffic_search_truthy(entry->'Розрахунок') is_paid,
   coalesce(entry->>'Розрахунок','') payment_date,
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
revoke all on function public.traffic_shop_report_page(jsonb,integer,integer) from public;
grant execute on function public.traffic_shop_report_page(jsonb,integer,integer) to anon,authenticated;
commit;
