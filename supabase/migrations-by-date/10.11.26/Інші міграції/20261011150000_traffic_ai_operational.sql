-- Compact Atlas operational reads over existing tables. No writes/new tables.
create or replace function public.traffic_ai_body(v jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog as $$
 select case when jsonb_typeof(v)='object' then v else '{}'::jsonb end;
$$;
create or replace function public.traffic_ai_operational(p_mode text,p_args jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare result jsonb; items jsonb:='[]'; groups jsonb:='{}'; info jsonb; d jsonb; r record; cid text; date_value timestamptz;
 now_value timestamptz:=coalesce((p_args->>'now')::timestamptz,now()); tz text:=coalesce(p_args->>'timezone','Europe/Kyiv');
 car bigint:=(p_args->>'car')::bigint; excluded bigint:=coalesce((p_args->>'exclude')::bigint,0);
 offset_value integer:=greatest(coalesce((p_args->>'offset')::integer,0),0);
 limit_value integer:=least(greatest(coalesce((p_args->>'limit')::integer,50),1),200);
 name_value text; needle text; total bigint; total_sum double precision; latest jsonb;
begin
 if p_mode='recommend' then
  with loads as (
   select public.traffic_ai_body(to_jsonb(data))->>'Слюсар' name,count(*) count from public.acts where date_off is null group by 1
  ) select coalesce(jsonb_agg(jsonb_build_object('slyusar_id',s.slyusar_id,'post_sluysar',s.post_sluysar,
    'data',jsonb_build_object('Name',d->'Name','Спеціалізація',d->'Спеціалізація','Рейтинг',d->'Рейтинг'),'current_load',coalesce(l.count,0)) order by s.slyusar_id),'[]') into items
   from public.slyusars s cross join lateral (select public.traffic_ai_body(to_jsonb(s.data)) d)x left join loads l on l.name=d->>'Name';
  result:=jsonb_build_object('items',items,'total',jsonb_array_length(items),'has_more',false);
 elsif p_mode in ('maintenance','vehicle') then
  -- Search the complete VIN/car history before choosing latest matching maintenance acts.
  with car_ids as (
   select car id union select cars_id from public.cars where length(btrim(coalesce(p_args->>'vin','')) )>=5
    and public.traffic_ai_body(to_jsonb(data))->>'Vincode'=btrim(p_args->>'vin')
  ), source as materialized (
   select act_id,date_on,date_off,public.traffic_ai_body(to_jsonb(data)) d from public.acts
    where cars_id in(select id from car_ids) and act_id<>excluded
  ), checks as(select value keywords,ordinality-1 idx from jsonb_array_elements(coalesce(p_args->'checks','[]')) with ordinality), matches as (
   select c.idx,a.act_id,a.date_on,a.date_off,a.d from checks c cross join lateral (
    select * from source s where exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.d->'Роботи')='array' then s.d->'Роботи' else '[]' end)w,
     jsonb_array_elements_text(c.keywords)k where strpos(lower(coalesce(w->>'Робота','')),lower(k))>0)
    order by date_on desc nulls first,act_id desc limit 1
   )a
  ) select (select count(*) from source),coalesce((select sum(public.traffic_ai_parse_float(d->'Загальна сума') order by date_on desc,act_id desc) from source),0),
   coalesce((select jsonb_agg(jsonb_build_object('index',idx,'act_id',act_id,'date_on',date_on,'date_off',date_off,'mileage',d->'Пробіг') order by idx) from matches),'[]'),
   coalesce((select jsonb_agg(row order by date_on desc nulls first,act_id desc) from (
    select act_id,date_on,jsonb_build_object('act_id',act_id,'date_on',date_on,'date_off',date_off,'mileage',d->'Пробіг','total_sum',public.traffic_ai_parse_float(d->'Загальна сума'),
     'works',coalesce((select jsonb_agg(w->>'Робота') from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array' then d->'Роботи' else '[]' end)w where coalesce(w->>'Робота','')<>''),'[]'),
     'details',coalesce((select jsonb_agg(w->>'Деталь') from jsonb_array_elements(case when jsonb_typeof(d->'Деталі')='array' then d->'Деталі' else '[]' end)w where coalesce(w->>'Деталь','')<>''),'[]')) row
    from source where p_mode='vehicle' order by date_on desc nulls first,act_id desc offset offset_value limit limit_value
   )p),'[]') into total,total_sum,latest,items;
  result:=jsonb_build_object('items',items,'latest',latest,'total',total,'total_sum',total_sum,'has_more',p_mode='vehicle' and total>offset_value+limit_value,'next_offset',offset_value+limit_value);
 elsif p_mode='inactive' then
  -- Preserve legacy descending-created traversal and last-visit contact fallback rules.
  for r in select act_id,client_id,date_on,date_off,data from public.acts where client_id is not null order by date_on desc nulls first,act_id desc loop
   d:=public.traffic_ai_body(to_jsonb(r.data));cid:=r.client_id::text;
   date_value:=case when pg_typeof(r.date_on)='timestamp without time zone'::regtype then coalesce(r.date_off,r.date_on)::timestamp at time zone tz else coalesce(r.date_off,r.date_on)::timestamptz end;
   info:=groups->cid;
   if info is null then
    info:=jsonb_build_object('date',date_value,'name',coalesce(nullif(d->>'ПІБ',''),'—'),'phone',coalesce(nullif(d->>'Телефон',''),'—'),'totalActs',1,
      'totalSum',public.traffic_ai_parse_float(d->'Загальна сума'),'lastCar',coalesce(nullif(btrim(coalesce(d->>'Марка','')||' '||coalesce(d->>'Модель','')),''),nullif(d->>'Авто',''),'—'));
   else
    info:=info||jsonb_build_object('totalActs',(info->>'totalActs')::bigint+1,'totalSum',(info->>'totalSum')::double precision+public.traffic_ai_parse_float(d->'Загальна сума'));
    if date_value>(info->>'date')::timestamptz then
     info:=info||jsonb_build_object('date',date_value,'name',coalesce(nullif(d->>'ПІБ',''),info->>'name'),'phone',coalesce(nullif(d->>'Телефон',''),info->>'phone'),
      'lastCar',coalesce(nullif(btrim(coalesce(d->>'Марка','')||' '||coalesce(d->>'Модель','')),''),nullif(d->>'Авто',''),info->>'lastCar'));
    end if;
   end if;
   groups:=jsonb_set(groups,array[cid],info);
  end loop;
  with inactive as (
   select key::bigint client_id,value info,floor(extract(epoch from now_value-(value->>'date')::timestamptz)/86400) days from jsonb_each(groups)
  ), matches as(select * from inactive where days>=greatest(coalesce((p_args->>'days')::integer,180),0))
  select (select count(*) from matches),coalesce((select jsonb_agg(row order by spent desc,client_id) from (
    select client_id,floor((info->>'totalSum')::double precision+0.5) spent,jsonb_build_object('client_id',client_id,'name',info->'name','phone',info->'phone',
     'last_visit',to_char((info->>'date')::timestamptz at time zone 'UTC','YYYY-MM-DD'),'days_since',days,'months_since',floor(days/30),'total_acts',info->'totalActs',
     'total_spent',floor((info->>'totalSum')::double precision+0.5),'last_car',info->'lastCar','loyalty',case when (info->>'totalActs')::bigint>=5 then '🌟 постійний' when (info->>'totalActs')::bigint>=2 then '🔄 повторний' else '🆕 разовий' end) row
    from matches order by spent desc,client_id offset offset_value limit limit_value
  )p),'[]') into total,items;
  result:=jsonb_build_object('items',items,'total',total,'has_more',total>offset_value+limit_value,'next_offset',offset_value+limit_value);
 elsif p_mode='achievements' then
  needle:=coalesce(p_args->>'name','');needle:=left(needle,greatest(3,length(needle)-2));
  select coalesce(to_jsonb(s)->>'Name',public.traffic_ai_body(to_jsonb(s.data))->>'Name') into name_value from public.slyusars s
   where coalesce(to_jsonb(s)->>'Name',public.traffic_ai_body(to_jsonb(s.data))->>'Name') ilike '%'||needle||'%' order by slyusar_id limit 1;
  if name_value is null then return jsonb_build_object('name',null,'complete',true,'as_of',now_value);end if;
  needle:=left(name_value,greatest(3,length(name_value)-2));
  with source as materialized (
   select act_id,date_on,date_off,public.traffic_ai_body(to_jsonb(data)) d,
    case when pg_typeof(date_on)='timestamp without time zone'::regtype then date_on::timestamp at time zone tz else date_on::timestamptz end opened,
    case when pg_typeof(date_off)='timestamp without time zone'::regtype then date_off::timestamp at time zone tz else date_off::timestamptz end closed
   from public.acts where public.traffic_ai_body(to_jsonb(data))->>'Слюсар' ilike '%'||needle||'%'
  ), clients as(select d->>'ПІБ' name,count(*) count from source where coalesce(d->>'ПІБ','')<>'' group by 1), recent as(
   select extract(epoch from closed-opened)/3600 hours from source where date_off is not null order by date_on desc nulls first,act_id desc limit 50
  ) select jsonb_build_object('name',name_value,'total_acts',count(*),'closed_acts',count(*) filter(where date_off is not null),
   'total_revenue',coalesce(sum(public.traffic_ai_parse_float(d->'Загальна сума') order by date_on desc,act_id desc) filter(where date_off is not null),0),
   'this_month',count(*) filter(where opened>=(p_args->>'month_start')::timestamptz),
   'today',count(*) filter(where left(date_on::text,10)=p_args->>'today'),
   'unique_clients',(select count(*) from clients),'loyal_clients',(select count(*) from clients where count>=3),
   'close_times',coalesce((select jsonb_agg(hours) from recent where hours>0 and hours<720),'[]'),
   'work_days',coalesce((select jsonb_agg(work_day) from (select distinct left(date_on::text,10) work_day from source where date_on>=(now_value at time zone tz)-interval '366 days')w),'[]')) into result from source;
 else raise exception 'Unknown Atlas operational mode';
 end if;
 return result||jsonb_build_object('complete',true,'as_of',now_value,'scope',p_mode);
end $$;
revoke all on function public.traffic_ai_body(jsonb),public.traffic_ai_operational(text,jsonb) from public;
grant execute on function public.traffic_ai_body(jsonb),public.traffic_ai_operational(text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';
