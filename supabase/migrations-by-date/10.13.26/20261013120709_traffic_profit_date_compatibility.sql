-- Profit report operands only. No financial writes or new tables.
create or replace function public.traffic_profit_acts(
 p_mode text, p_from text, p_to text default null, p_offset integer default 0
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
 result jsonb;
 date_column text;
 date_type text;
begin
 if p_mode not in ('open','close','paid') or p_mode is null then raise exception 'Invalid date mode'; end if;
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset'; end if;
 -- Cast parameters to the actual column type, never the indexed column.
 -- Older projects use text; newer templates use timestamp for rosraxovano.
 date_column := case p_mode when 'open' then 'date_on' when 'close' then 'date_off' else 'rosraxovano' end;
 select case a.atttypid
   when 'timestamp'::regtype then 'timestamp'
   when 'timestamptz'::regtype then 'timestamptz'
   when 'date'::regtype then 'date'
   when 'text'::regtype then 'text'
   when 'varchar'::regtype then 'text'
 end into date_type
 from pg_attribute a
 where a.attrelid='public.acts'::regclass and a.attname=date_column
   and a.attnum>0 and not a.attisdropped;
 if date_type is null then
   raise exception 'Unsupported or missing date column public.acts.%', date_column;
 end if;
 execute format($query$
 with candidates as (
   select a.act_id,a.date_on,to_jsonb(a) row_data,public.sto_read_object_v1(to_jsonb(a.data)) body
   from public.acts a
   where ($1 is null or a.%1$I >= $1::%2$s)
     and ($2 is null or a.%1$I <= $2::%2$s)
   order by a.date_on desc,a.act_id desc limit 201 offset $3
 ), page as (select * from candidates order by date_on desc,act_id desc limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(
   (select jsonb_object_agg(key,value) from jsonb_each(p.row_data)
    where key=any(array['act_id','date_on','date_off','rosraxovano','xto_rozraxuvav','client_id','cars_id','avans','tupOplatu']))
   ||jsonb_build_object('data',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.body)
    where key=any(array['Прибуток за деталі','Прибуток за роботу','За деталі','За роботу','Знижка','Заморожений'])))
   order by p.date_on desc,p.act_id desc) from page p),'[]'::jsonb),
   'has_more',(select count(*)>200 from candidates))
 $query$, date_column, date_type) into result using p_from, p_to, p_offset;
 return result;
end $$;
revoke all on function public.traffic_profit_acts(text,text,text,integer) from public;
grant execute on function public.traffic_profit_acts(text,text,text,integer) to anon,authenticated;

notify pgrst, 'reload schema';
