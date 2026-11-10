-- Atlas financial aggregates over existing rows. No new tables or writes.
create or replace function public.traffic_ai_parse_float(v jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare value text; matched text; mantissa text; digits text; exponent_text text; decimal_exponent numeric;
begin
 value:=public.traffic_search_trim(public.traffic_search_string(v));
 matched:=substring(ltrim(value,E' \t\n\r') from '^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?');
 if matched is null then
  if ltrim(value) ~ '^[+-]?Infinity' then raise exception 'Nonfinite amount in Atlas financial report'; end if;
  return 0;
 end if;
 begin
  return matched::double precision;
 exception when numeric_value_out_of_range then
  -- JS parseFloat underflows to zero; PostgreSQL raises instead. Distinguish
  -- tiny finite values from overflow, which must still reject a financial report.
  mantissa:=regexp_replace(split_part(lower(matched),'e',1),'^[+-]','');
  digits:=replace(mantissa,'.','');
  exponent_text:=nullif(split_part(lower(matched),'e',2),'');
  begin decimal_exponent:=coalesce(exponent_text::numeric,0);
  exception when numeric_value_out_of_range then
   if left(exponent_text,1)='-' then return 0;end if;
   raise;
  end;
  decimal_exponent:=decimal_exponent+length(split_part(mantissa,'.',1))-(length(digits)-length(ltrim(digits,'0')))-1;
  if decimal_exponent < -308 then return 0;end if;
  raise;
 end;
end $$;
create or replace function public.traffic_ai_financial(p_current timestamptz,p_previous timestamptz)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare r record; body jsonb; amount double precision; is_current boolean; expense_date timestamptz;
 current_revenue double precision:=0; previous_revenue double precision:=0;
 current_expenses double precision:=0; previous_expenses double precision:=0;
 current_count bigint:=0; previous_count bigint:=0;
begin
 if p_current is null or p_previous is null or p_previous>p_current then raise exception 'Invalid financial interval';end if;
 for r in select act_id,date_on,data from public.acts where date_on>=p_previous order by act_id loop
  -- Preserve existing Atlas revenue fields and its object-only data semantics.
  body:=case when jsonb_typeof(r.data::jsonb)='object' then r.data::jsonb else '{}'::jsonb end;
  amount:=public.traffic_ai_parse_float(body->'СумаРобіт')+public.traffic_ai_parse_float(body->'СумаДеталей');
  if r.date_on>=p_current then current_revenue:=current_revenue+amount;current_count:=current_count+1;
  else previous_revenue:=previous_revenue+amount;previous_count:=previous_count+1;end if;
 end loop;
 for r in select to_jsonb(v) row_data from public.vutratu v order by vutratu_id loop
  body:=r.row_data;
  -- Current project schema uses dataOnn; retain compatibility with older installations.
  -- The legacy .gte(date, boundary) excludes NULL dates; they must not abort
  -- an otherwise valid report just because an old row has no timestamp.
  if coalesce(body->>'data_vutratu',body->>'dataOnn') is null then continue;end if;
  expense_date:=case when body ? 'data_vutratu' then (body->>'data_vutratu')::timestamptz
    else (body->>'dataOnn')::timestamp at time zone 'Europe/Kyiv' end;
  if expense_date<p_previous then continue;end if;
  is_current:=expense_date>=p_current;
  amount:=public.traffic_ai_parse_float(body->'suma');
  if is_current then current_expenses:=current_expenses+amount;
  else previous_expenses:=previous_expenses+amount;end if;
 end loop;
 return jsonb_build_object('current',jsonb_build_object('revenue',current_revenue,'expenses',current_expenses,'acts_count',current_count),
  'previous',jsonb_build_object('revenue',previous_revenue,'expenses',previous_expenses,'acts_count',previous_count),
  'scope',jsonb_build_object('current_from',p_current,'previous_from',p_previous),'complete',true);
end $$;
revoke all on function public.traffic_ai_parse_float(jsonb),public.traffic_ai_financial(timestamptz,timestamptz) from public;
grant execute on function public.traffic_ai_parse_float(jsonb),public.traffic_ai_financial(timestamptz,timestamptz) to anon,authenticated;
-- Complete VIP grouping before the requested top-N display limit.
create or replace function public.traffic_ai_vip(p_since timestamptz,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as (
  select a.act_id,a.client_id,a.date_on,case when jsonb_typeof(a.data::jsonb)='object' then a.data::jsonb else '{}'::jsonb end body
  from public.acts a where a.date_on>=p_since and a.client_id is not null and a.client_id<>0
 ), grouped as (
  select client_id,count(*) acts,
   sum(public.traffic_ai_parse_float(body->'СумаРобіт')+public.traffic_ai_parse_float(body->'СумаДеталей') order by date_on desc,act_id desc) revenue,
   (array_agg(body->'ПІБ' order by date_on desc,act_id desc))[1] name,
   (array_agg(body->'Телефон' order by date_on desc,act_id desc))[1] phone,max(date_on) last_visit
  from source group by client_id
 ), page as(select * from grouped order by revenue desc,last_visit desc,client_id limit greatest(1,least(coalesce(p_limit,20),200)))
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_array(client_id,jsonb_build_object(
   'acts',acts,'revenue',revenue,'name',case when public.traffic_search_truthy(name) then name else to_jsonb('—'::text) end,
   'phone',case when public.traffic_search_truthy(phone) then phone else to_jsonb(''::text) end,'lastVisit',last_visit)) order by revenue desc,last_visit desc,client_id) from page),'[]'::jsonb),
 'total_clients',(select count(*) from grouped),'has_more',(select count(*) from grouped)>greatest(1,least(coalesce(p_limit,20),200)),
 'since',p_since,'complete',true);
$$;
revoke all on function public.traffic_ai_vip(timestamptz,integer) from public;
grant execute on function public.traffic_ai_vip(timestamptz,integer) to anon,authenticated;
-- Staff ranking aggregates; employee payroll histories never leave this function.
create or replace function public.traffic_ai_staff_ranking(p_since timestamptz,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with staff as materialized (
  select s.slyusar_id,to_jsonb(s)->'post_sluysar' post,
   case when jsonb_typeof(s.data::jsonb)='object' then s.data::jsonb else '{}'::jsonb end body from public.slyusars s
 ), acts as (
  select a.act_id,a.date_off,case when jsonb_typeof(a.data::jsonb)='object' then a.data::jsonb else '{}'::jsonb end body
  from public.acts a where a.date_on>=p_since
 ), matched as (
  select a.*,s.slyusar_id from acts a join lateral (
   select s.slyusar_id from staff s where jsonb_typeof(s.body->'Name')='string'
    and jsonb_typeof(a.body->'Слюсар')='string' and a.body->>'Слюсар'<>''
    and lower(s.body->>'Name')=lower(a.body->>'Слюсар') order by s.slyusar_id limit 1
  ) s on true
 ), totals as (
  select slyusar_id,count(*) acts,count(*) filter(where date_off is null) open_acts,
   sum(public.traffic_ai_parse_float(body->'СумаРобіт')+public.traffic_ai_parse_float(body->'СумаДеталей') order by act_id) revenue
  from matched group by slyusar_id
 ), candidates as (select * from staff where p_after is null or slyusar_id>p_after order by slyusar_id limit 201),
 page as (select * from candidates order by slyusar_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('slyusar_id',p.slyusar_id,'post_sluysar',p.post,
  'data',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p.body) where key in ('Name','Спеціалізація','Рейтинг')),
  '__stats',jsonb_build_object('acts',coalesce(t.acts,0),'revenue',coalesce(t.revenue,0),'openActs',coalesce(t.open_acts,0))) order by p.slyusar_id)
  from page p left join totals t using(slyusar_id)),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(slyusar_id) from page),'since',p_since);
$$;
revoke all on function public.traffic_ai_staff_ranking(timestamptz,bigint) from public;
grant execute on function public.traffic_ai_staff_ranking(timestamptz,bigint) to anon,authenticated;
