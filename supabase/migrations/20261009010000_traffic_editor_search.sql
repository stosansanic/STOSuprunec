-- Editor stock search: same matching rules, stable ID pages, existing permissions.
create or replace function public.traffic_editor_stock_search(p_query text,p_by_name boolean default false,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with q as (select lower(btrim(coalesce(p_query,''))) raw, public.traffic_editor_catalog_key(p_query) normalized),
 matches as (
 select s.sclad_id from public.sclad s cross join q
 where q.raw <> '' and (p_after is null or s.sclad_id > p_after)
 and case when p_by_name then
   not exists (select 1 from unnest(regexp_split_to_array(q.raw,'\s+')) token where strpos(lower(coalesce(s.name::text,'')),token)=0)
 else strpos(lower(coalesce(s.part_number::text,'')),q.raw)>0
   or strpos(lower(coalesce(s.name::text,'')),q.raw)>0
   or (q.normalized <> '' and (strpos(public.traffic_editor_catalog_key(s.part_number::text),q.normalized)>0
     or strpos(public.traffic_editor_catalog_key(s.name::text),q.normalized)>0)) end
 order by s.sclad_id asc limit 51
 ), page as (select sclad_id from matches order by sclad_id limit 50)
 select jsonb_build_object('ids',coalesce((select jsonb_agg(sclad_id order by sclad_id) from page),'[]'::jsonb),
 'has_more',(select count(*)>50 from matches),'next_cursor',(select max(sclad_id) from page))
$$;
grant execute on function public.traffic_editor_stock_search(text,boolean,bigint) to anon,authenticated;
