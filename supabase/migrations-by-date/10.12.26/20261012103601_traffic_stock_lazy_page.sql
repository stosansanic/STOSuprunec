-- Requires traffic_stock_pages; preserves RLS and existing tables.
begin;
create or replace function public.traffic_stock_page_v2(p_status text default null,p_from text default null,p_to text default null,p_query text default '',p_before bigint default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
 select n.sclad_id,n.time_on,n.shops,n.part_number,n.name,n.kilkist_on,n.price,n."scladNomer",n.rahunok,n.akt,n.unit_measurement,n.statys,n.prumitka,n.xto_zamovuv,n.client_price
 from public.sclad n
 where (case when p_status='Прибула' then n.statys is null when p_status in ('Замовити','Замовлено') then n.statys=p_status else n.statys in ('Замовити','Замовлено') end)
 and (nullif(p_from,'') is null or n.time_on >= nullif(p_from,'')::timestamptz)
 and (nullif(p_to,'') is null or n.time_on <= nullif(p_to,'')::timestamptz)
 and (p_before is null or n.sclad_id<p_before)
 and (nullif(btrim(p_query),'') is null or strpos(lower(coalesce(n.part_number,'')),lower(btrim(p_query)))>0 or
 (public.traffic_catalog_key(p_query)<>'' and strpos(public.traffic_catalog_key(n.part_number),public.traffic_catalog_key(p_query))>0))
 order by n.sclad_id desc limit least(20,greatest(1,coalesce(p_limit,20)))+1
 ), visible as (select * from page order by sclad_id desc limit least(20,greatest(1,coalesce(p_limit,20))))
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by v.sclad_id desc) from visible v),'[]'::jsonb),
 'has_more',(select count(*)>least(20,greatest(1,coalesce(p_limit,20))) from page),'next_cursor',(select min(sclad_id) from visible));
$$;



revoke all on function public.traffic_stock_page_v2(text,text,text,text,bigint,integer) from public;
grant execute on function public.traffic_stock_page_v2(text,text,text,text,bigint,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
