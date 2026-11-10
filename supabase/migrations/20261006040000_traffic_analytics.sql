-- Analytics reads only; existing financial formulas remain in the browser.
-- Requires 20261005130000_traffic_reports.sql. No tables or writes.
create or replace function public.traffic_analytics_acts(p_after bigint default null)
returns jsonb language sql stable security invoker set search_path = public
as $$
  with candidates as (
    select a.act_id, to_jsonb(a) as row_data,
      public.traffic_json_object(a.data::jsonb) as body
    from public.acts a
    where p_after is null or a.act_id > p_after
    order by a.act_id limit 201
  ), page as (
    select * from candidates order by act_id limit 200
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
       from jsonb_each(p.row_data) where key = any(array[
         'act_id','date_on','date_off','rosraxovano','avans','tupOplatu','client_id','cars_id'
       ])) || jsonb_build_object('data',
         (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
          from jsonb_each(p.body) where key = any(array[
            'За роботу','За деталі','Прибуток за роботу','Прибуток за деталі',
            'Знижка','Заморожений','Роботи','Деталі'
          ])), '__sto_projection','analytics-v1')
      order by p.act_id) from page p),'[]'::jsonb),
    'has_more', (select count(*) > 200 from candidates),
    'next_cursor', (select max(act_id) from page)
  );
$$;
revoke all on function public.traffic_analytics_acts(bigint) from public;
grant execute on function public.traffic_analytics_acts(bigint) to anon, authenticated;
