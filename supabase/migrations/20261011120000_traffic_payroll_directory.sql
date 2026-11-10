-- Initial accounting directory: no payroll histories, credentials or act documents.
create or replace function public.traffic_payroll_directory(p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as (
  select s.slyusar_id,public.traffic_json_object(s.data::jsonb) body from public.slyusars s
  where p_after is null or s.slyusar_id>p_after order by s.slyusar_id limit 201
 ), page as(select * from candidates order by slyusar_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('slyusar_id',p.slyusar_id,
  'data',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.body)
          where key in ('Name','ПроцентРоботи'))) order by p.slyusar_id) from page p),'[]'::jsonb),
 'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(slyusar_id) from page),
 'pending_count',case when p_after is null then (select count(*) from public.acts a
  where public.traffic_json_object(a.data::jsonb)->'__payroll_pending'='true'::jsonb
    and public.traffic_json_object(a.data::jsonb)->'Заморожений' is distinct from 'true'::jsonb) else null end);
$$;
revoke all on function public.traffic_payroll_directory(bigint) from public;
grant execute on function public.traffic_payroll_directory(bigint) to anon,authenticated;
