-- Distinct supplier filter options from the stock itself, including historical
-- names absent from the shops directory. No trimming/renaming of stored values.
create or replace function public.traffic_stock_shop_names(p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = public
as $$
  with names as (
    select distinct to_jsonb(s.shops) as value from public.sclad s
    where s.shops is not null and s.shops::text <> ''
  ), page as (
    select value from names order by value
    offset greatest(coalesce(p_offset,0),0) limit 501
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('shops',value) order by value)
      from (select value from page order by value limit 500) visible),'[]'::jsonb),
    'has_more', (select count(*) > 500 from page)
  );
$$;
revoke all on function public.traffic_stock_shop_names(integer) from public;
grant execute on function public.traffic_stock_shop_names(integer) to anon, authenticated;
