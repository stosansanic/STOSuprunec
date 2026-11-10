-- Profit report operands only. No financial writes or new tables.
create or replace function public.traffic_profit_acts(
 p_mode text, p_from text, p_to text default null, p_offset integer default 0
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_mode not in ('open','close','paid') or p_mode is null then raise exception 'Invalid date mode'; end if;
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset'; end if;
 with candidates as (
   select a.act_id,a.date_on,to_jsonb(a) row_data,public.sto_read_object_v1(to_jsonb(a.data)) body
   from public.acts a
   where case p_mode
     when 'open' then (p_from is null or a.date_on>=p_from::timestamptz) and (p_to is null or a.date_on<=p_to::timestamptz)
     when 'close' then (p_from is null or a.date_off>=p_from::timestamptz) and (p_to is null or a.date_off<=p_to::timestamptz)
     -- This existing column is text: preserve the report's existing PostgREST comparison.
     when 'paid' then (p_from is null or a.rosraxovano>=p_from) and (p_to is null or a.rosraxovano<=p_to)
   end
   order by a.date_on desc,a.act_id desc limit 201 offset p_offset
 ), page as (select * from candidates order by date_on desc,act_id desc limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(
   (select jsonb_object_agg(key,value) from jsonb_each(p.row_data)
    where key=any(array['act_id','date_on','date_off','rosraxovano','xto_rozraxuvav','client_id','cars_id','avans','tupOplatu']))
   ||jsonb_build_object('data',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.body)
    where key=any(array['Прибуток за деталі','Прибуток за роботу','За деталі','За роботу','Знижка','Заморожений'])))
   order by p.date_on desc,p.act_id desc) from page p),'[]'::jsonb),
   'has_more',(select count(*)>200 from candidates)) into result;
 return result;
end $$;
revoke all on function public.traffic_profit_acts(text,text,text,integer) from public;
grant execute on function public.traffic_profit_acts(text,text,text,integer) to anon,authenticated;
