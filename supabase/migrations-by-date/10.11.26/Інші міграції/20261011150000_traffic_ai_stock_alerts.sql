-- Filter before paging; healthy stock and unused price/status/notes stay on the server.
create or replace function public.traffic_ai_stock_alerts(p_threshold double precision default 2,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as (
  select sclad_id,name,part_number,shops,
   coalesce(public.traffic_search_number(to_jsonb(kilkist_on)),0)-coalesce(public.traffic_search_number(to_jsonb(kilkist_off)),0) current_qty,
   coalesce((regexp_match(prumitka::text,U&'(?:min|мін|мин)[:[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*([0-9]+)','i'))[1]::double precision,p_threshold) threshold
  from public.sclad
 ), filtered as(select * from source where current_qty<=0 or current_qty<=threshold),
 page as(select * from filtered order by name,sclad_id offset greatest(coalesce(p_offset,0),0) limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(page) order by name,sclad_id) from page),'[]'::jsonb),
  'total_stock',(select count(*) from source),'total_alerts',(select count(*) from filtered),
  'has_more',(select count(*) from filtered)>greatest(coalesce(p_offset,0),0)+200);
$$;
revoke all on function public.traffic_ai_stock_alerts(double precision,integer) from public;
grant execute on function public.traffic_ai_stock_alerts(double precision,integer) to anon,authenticated;
