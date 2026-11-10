-- Compact visible bookings with only the labels actually used by day/week renderers.
create or replace function public.traffic_planner_bookings(p_start timestamptz,p_end timestamptz,p_staff bigint[] default null,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>interval '8 days' then raise exception 'Expected visible planner range'; end if;
 if p_offset<0 or coalesce(cardinality(p_staff),0)>200 then raise exception 'Invalid planner page'; end if;
 with bookings as (
 select post_arxiv_id,slyusar_id,name_post,client_id,cars_id,status,data_on,data_off,komentar,act_id,xto_zapusav
 from public.post_arxiv where data_on>=p_start and data_on<=p_end and (p_staff is null or slyusar_id=any(p_staff))
 order by post_arxiv_id limit 201 offset p_offset
 ), page as (select * from bookings order by post_arxiv_id limit 200), projected as (
 select p.post_arxiv_id,to_jsonb(p)||jsonb_build_object('version',md5(to_jsonb(p)::text),
 'client_data',coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(case when jsonb_typeof(to_jsonb(c.data))='object' then to_jsonb(c.data) else '{}'::jsonb end) e where e.key='ПІБ' or lower(e.key) like '%телефон%'),'{}'::jsonb),
 'car_data',case when jsonb_typeof(to_jsonb(v.data))='object' then jsonb_build_object('Авто',to_jsonb(v.data)->'Авто','Номер авто',to_jsonb(v.data)->'Номер авто') else '{}'::jsonb end) item
 from page p
 left join public.clients c on c.client_id=case when p.client_id::text ~ '^\s*[+]?[0-9]+(\.0+)?\s*$' then p.client_id::text::numeric else null end
 left join public.cars v on v.cars_id=case when p.cars_id::text ~ '^\s*[+]?[0-9]+(\.0+)?\s*$' then p.cars_id::text::numeric else null end and v.is_deleted is distinct from true
 )
 select jsonb_build_object('items',coalesce((select jsonb_agg(item order by post_arxiv_id) from projected),'[]'::jsonb),'has_more',(select count(*)>200 from bookings)) into result;
 return result;
end $$;
grant execute on function public.traffic_planner_bookings(timestamptz,timestamptz,bigint[],integer) to anon,authenticated;
