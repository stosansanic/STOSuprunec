-- Read-only aggregation; preserves existing calendar grouping and Math.round per booking.
-- Overlap semantics deliberately unchanged: reservations' durations are additive.
create or replace function public.traffic_planner_occupancy(p_start timestamptz,p_end timestamptz,p_timezone text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_start is null or p_end is null or p_end<=p_start or p_end-p_start>interval '32 days' then
   raise exception 'Expected a calendar month interval';
 end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Invalid timezone'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.day,x.post),'[]'::jsonb) into result from (
   select to_char(n.data_on::timestamptz at time zone p_timezone,'YYYY-MM-DD') as day,
     n.name_post post,
     sum(floor(extract(epoch from (n.data_off::timestamptz-n.data_on::timestamptz))/60+0.5)) minutes
   from public.post_arxiv n
   where n.data_on>=p_start and n.data_on<p_end and n.name_post is not null and n.name_post<>0
   group by 1,2
 ) x;
 return result;
end $$;
grant execute on function public.traffic_planner_occupancy(timestamptz,timestamptz,text) to anon,authenticated;

