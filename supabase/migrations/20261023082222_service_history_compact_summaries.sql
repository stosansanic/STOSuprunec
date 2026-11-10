-- Preserve legacy JS operands for unusual values; compress ordinary numeric histories.
begin;
create or replace function public.traffic_service_chart_data(p_data jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare original jsonb:=public.traffic_service_history_data(p_data,true); result jsonb:=original;
 k text; total_key text; operand jsonb; item jsonb; quantity double precision; price double precision; total double precision;
begin
 foreach k in array array['Роботи','Деталі'] loop
  total_key:=case when k='Роботи' then 'За роботу' else 'За деталі' end;
  operand:=original->total_key;
  -- Existing browser code chooses a truthy stored total before calculating rows.
  if operand is not null and operand<>'null'::jsonb and operand<>'false'::jsonb and operand<>'0'::jsonb and operand<>'""'::jsonb then
   result:=jsonb_set(result,array[k],'[]'::jsonb,true);
   continue;
  end if;
  total:=0;
  for item in select value from jsonb_array_elements(original->k) loop
   if (item->'Кількість' is not null and jsonb_typeof(item->'Кількість') not in ('number','null'))
     or (item->'Ціна' is not null and jsonb_typeof(item->'Ціна') not in ('number','null')) then
    -- String/boolean legacy coercion stays exactly in the existing browser path.
    return original;
   end if;
   quantity:=coalesce(nullif((item->>'Кількість')::double precision,0),1);
   price:=coalesce((item->>'Ціна')::double precision,0);
   total:=total+price*quantity;
  end loop;
  result:=jsonb_set(jsonb_set(result,array[total_key],to_jsonb(total),true),array[k],'[]'::jsonb,true);
 end loop;
 return result;
exception when numeric_value_out_of_range then return original;
end $$;
create or replace function public.traffic_service_history(
 p_car bigint,p_before jsonb default null,p_summary boolean default false)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
  select act_id,date_on,date_off,client_id,cars_id,
   case when p_summary then public.traffic_service_chart_data(data::jsonb) else public.traffic_service_history_data(data::jsonb,false) end data
  from public.acts where cars_id=p_car and (p_before is null
   or (p_before->>'date_on' is null and date_on is not null)
   or (date_on is null and p_before->>'date_on' is null and act_id<(p_before->>'act_id')::bigint)
   or date_on<(p_before->>'date_on')::timestamptz
   or (date_on=(p_before->>'date_on')::timestamptz and act_id<(p_before->>'act_id')::bigint))
  order by date_on desc nulls first,act_id desc limit case when p_summary then 201 else 51 end
 ), visible as (select * from page order by date_on desc nulls first,act_id desc limit case when p_summary then 200 else 50 end)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by date_on desc nulls first,act_id desc) from visible v),'[]'::jsonb),
  'has_more',(select count(*)>case when p_summary then 200 else 50 end from page),
  'next_cursor',(select jsonb_build_object('date_on',date_on,'act_id',act_id) from visible order by date_on asc nulls last,act_id asc limit 1));
$$;
revoke all on function public.traffic_service_chart_data(jsonb) from public;
grant execute on function public.traffic_service_chart_data(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
