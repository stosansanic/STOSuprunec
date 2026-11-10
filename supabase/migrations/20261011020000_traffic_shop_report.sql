-- Details-by-act report needs history and name, never shop stock/configuration.
create or replace function public.traffic_shop_report(p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (
  select shop_id,public.sto_read_object_v1(to_jsonb(data)) body from public.shops
  where p_after is null or shop_id>p_after order by shop_id limit 201
 ), page as (select * from candidates order by shop_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'shop_id',shop_id,'data',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
   from jsonb_each(body) where key in ('Name','Історія'))) order by shop_id) from page),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(shop_id) from page));
$$;
revoke all on function public.traffic_shop_report(bigint) from public;
grant execute on function public.traffic_shop_report(bigint) to anon,authenticated;
