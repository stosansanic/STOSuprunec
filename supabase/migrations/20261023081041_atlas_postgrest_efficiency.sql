begin;

-- All browser reads keep the caller's existing table privileges/RLS. No row
-- retention, business-history deletion or delivery-claim reset is performed.
create or replace function public.traffic_atlas_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare parsed jsonb;
begin
 if jsonb_typeof(p_value)='object' then return p_value;end if;
 if jsonb_typeof(p_value)='string' then
  begin parsed:=(p_value#>>'{}')::jsonb;
   if jsonb_typeof(parsed)='object' then return parsed;end if;
  exception when invalid_text_representation then return '{}'::jsonb;end;
 end if;
 return '{}'::jsonb;
end $$;

-- Number(value || fallback), for the existing historical price calculation.
-- Invalid numeric strings remain NULL rather than becoming a false sample.
create or replace function public.traffic_atlas_number(p_value jsonb,p_fallback double precision)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare value text;
begin
 if p_value is null or p_value in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb) then return p_fallback;end if;
 if p_value='true'::jsonb then return 1;end if;
 value:=btrim(p_value#>>'{}',E' \t\n\r');
 if value='' then return 0;end if;
 if value !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then return null;end if;
 begin return value::double precision;exception when numeric_value_out_of_range then return null;end;
end $$;

create or replace function public.traffic_ai_price_summary(p_name text,p_type text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_type not in ('work','detail') or p_type is null then raise exception 'Unknown price suggestion type';end if;
 with recent as materialized (
  select act_id,public.traffic_atlas_object(to_jsonb(data)) body from public.acts
  where data is not null order by act_id desc limit 50
 ), entries as (
  select r.act_id,e.ord,e.item from recent r cross join lateral
   jsonb_array_elements(case when jsonb_typeof(r.body->case when p_type='work' then 'Роботи' else 'Деталі' end)='array'
    then r.body->case when p_type='work' then 'Роботи' else 'Деталі' end else '[]'::jsonb end) with ordinality e(item,ord)
 ), parsed as (
  select act_id,ord,item->case when p_type='work' then 'Робота' else 'Найменування' end name,
   public.traffic_atlas_number(item->'Ціна',0) price,public.traffic_atlas_number(item->'Кількість',1) quantity,
   case when p_type='work' then public.traffic_atlas_number(item->'Зар-та',0) else 0 end salary,
   case when p_type='work' then btrim(coalesce(item->>'ПІБ _ Магазин','')) else '' end mechanic from entries
 ), matches as materialized (
  select *,row_number() over(order by act_id desc,ord) sequence from parsed
  where price>0 and jsonb_typeof(name)='string' and name#>>'{}'<>'' and
   (strpos(lower(name#>>'{}'),lower(coalesce(p_name,'')))>0 or strpos(lower(coalesce(p_name,'')),lower(name#>>'{}'))>0)
 ), mechanics as (
  select mechanic,count(*) occurrences,min(sequence) first_seen from matches where mechanic<>'' group by mechanic
 ) select case when count(*)=0 then null else jsonb_build_object(
  'minPrice',min(price),'maxPrice',max(price),'count',count(*),
  'avgQuantity',case when count(quantity)=count(*) then floor(sum(quantity order by sequence)/count(*)+0.5) else null end,
  'avgSalary',floor((sum(salary order by sequence) filter(where salary>0))/nullif(count(*) filter(where salary>0),0)+0.5),
  'mostFrequentSlyusar',(select mechanic from mechanics order by occurrences desc,first_seen limit 1),
  'sourceWindow','latest_50_nonnull_acts','as_of',statement_timestamp()) end into result from matches;
 return result;
end $$;

-- One service-only candidate stream. Existing atomic evaluation and recipient
-- claim/start/finish functions remain the final authority before sending.
create or replace function public.traffic_reminder_candidates(p_after bigint default null,p_at timestamptz default now())
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with candidates as materialized (
  select r.reminder_id,r.title,r.description,r.reminder_type,r.recipients,r.channel,r.priority,r.condition_query,
   r.schedule,r.trigger_count,r.created_by,coalesce(s.data->>'Name','—') creator_name,r.meta,r.next_trigger_at
  from public.atlas_reminders r left join public.slyusars s on s.slyusar_id=r.created_by
  where r.status='active' and r.channel in ('telegram','both') and (p_after is null or r.reminder_id>p_after)
   and (r.evaluation_lease_until is null or r.evaluation_lease_until<=p_at)
   and ((r.next_trigger_at is not null and r.next_trigger_at<=p_at) or
    (r.reminder_type='conditional' and r.condition_query is not null and public.traffic_atlas_object(to_jsonb(r.schedule))->>'type'='realtime'))
  order by r.reminder_id limit 201
 ), page as(select * from candidates order by reminder_id limit 200)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by reminder_id) from page p),'[]'::jsonb),
  'has_more',(select count(*)>200 from candidates),'next_cursor',(select max(reminder_id) from page));
$$;

-- The legacy validator/authorization remains in execute_condition_query.
-- Only a bounded page crosses HTTP; count covers the complete SQL result.
create or replace function public.traffic_ai_condition_page(p_query text,p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare source jsonb;items jsonb;total integer;page_size integer:=least(greatest(coalesce(p_limit,50),1),100);
 skip integer:=greatest(coalesce(p_offset,0),0);
begin
 source:=public.execute_condition_query(p_query);
 if jsonb_typeof(source)<>'array' then raise exception 'Expected SQL row array';end if;
 total:=jsonb_array_length(source);
 select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into items
 from jsonb_array_elements(source) with ordinality e(value,ord) where ord>skip and ord<=skip+page_size;
 if octet_length(items::text)>262144 then raise exception 'SQL page exceeds 256 KiB: select fewer fields or request a smaller page';end if;
 return jsonb_build_object('items',items,'total',total,'has_more',skip+jsonb_array_length(items)<total,
  'next_offset',skip+jsonb_array_length(items),'as_of',statement_timestamp());
end $$;

-- Keep employee visibility in the existing function. A POST wrapper accepts
-- both its table-row and scalar JSON-array forms without relying on volatility.
create or replace function public.traffic_my_reminder_counts(p_slyusar_id integer)
returns jsonb language sql security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select to_jsonb(r) body from public.get_my_reminders(p_slyusar_id) r
 ), rows as (
  select item from source cross join lateral jsonb_array_elements(
   case when jsonb_typeof(body)='array' then body when jsonb_typeof(body)='object' then jsonb_build_array(body) else '[]'::jsonb end
  ) item
 ) select jsonb_build_object('total',count(*),'active',count(*) filter(where item->>'status'='active')) from rows;
$$;

-- Atomic append + sidebar timestamp; record conversion supports the existing
-- images column type (JSON/JSONB or a text array) without changing the schema.
create or replace function public.traffic_chat_append(p_chat_id bigint,p_role text,p_text text,p_images jsonb default '[]'::jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare created_id bigint;message_record public.ai_messages%rowtype;
begin
 if p_role not in ('user','assistant') or p_role is null or jsonb_typeof(p_images) is distinct from 'array' then raise exception 'Invalid chat message';end if;
 -- UPDATE/INSERT are both checked with the caller's existing policies.
 update public.ai_chats set updated_at=clock_timestamp() where chat_id=p_chat_id;
 if not found then raise exception 'Chat unavailable';end if;
 message_record:=jsonb_populate_record(null::public.ai_messages,jsonb_build_object('role',p_role,'text',p_text,'images',p_images));
 insert into public.ai_messages(chat_id,role,text,images) values(p_chat_id,message_record.role,message_record.text,message_record.images) returning message_id into created_id;
 return jsonb_build_object('message_id',created_id);
end $$;

create or replace function public.traffic_atlas_integer(p_value jsonb)
returns double precision language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare matched text;
begin
 matched:=substring(ltrim(coalesce(p_value#>>'{}',''),E' \t\n\r') from '^[+-]?[0-9]+');
 if matched is null then return 0;end if;
 begin return matched::double precision;exception when numeric_value_out_of_range then raise exception 'Nonfinite mileage';end;
end $$;

create or replace function public.traffic_ai_maintenance_summary(
 p_checks jsonb,p_limit integer default 30,p_now timestamptz default now(),p_timezone text default 'Europe/Kyiv'
) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select act_id,cars_id,date_on,date_off,
   case when jsonb_typeof(to_jsonb(data))='object' then to_jsonb(data) else '{}'::jsonb end body,
   case when pg_typeof(date_on)='timestamp without time zone'::regtype
    then coalesce(date_off,date_on)::timestamp at time zone p_timezone else coalesce(date_off,date_on)::timestamptz end visit_at,
   row_number() over(order by date_on desc nulls first,act_id desc) sequence
  from public.acts where date_off is not null and cars_id is not null and cars_id<>0
 ), car_rows as (
  select *,public.traffic_atlas_integer(body->'Пробіг') mileage,
   max(public.traffic_atlas_integer(body->'Пробіг')) over(partition by cars_id) max_mileage from source
 ), cars as materialized (
  select distinct on(cars_id) cars_id,body,coalesce(date_off,date_on) last_visit,max_mileage,sequence
  from car_rows order by cars_id,sequence
 ), checks as (
  select value rule,ordinality idx from jsonb_array_elements(p_checks) with ordinality
 ), latest as (
  select c.cars_id,c.sequence,c.max_mileage,k.rule,k.idx,a.visit_at,a.mileage
  from cars c cross join checks k cross join lateral (
   select s.visit_at,s.mileage from car_rows s where s.cars_id=c.cars_id and exists(
    select 1 from jsonb_array_elements(case when jsonb_typeof(s.body->'Роботи')='array' then s.body->'Роботи' else '[]'::jsonb end) w,
     jsonb_array_elements_text(k.rule->'keywords') word where strpos(lower(coalesce(w->>'Робота','')),word)>0
   ) order by s.sequence limit 1
  )a
 ), distances as (
  select *,floor(extract(epoch from p_now-visit_at)/86400) days_since,max_mileage-mileage km_since from latest
 ), remaining as (
  select *, (rule->>'interval_days')::integer-days_since days_left,(rule->>'interval_km')::integer-km_since km_left from distances
 ), evaluated as (
  select *,case when km_left<0 or days_left<0 then 0 when km_left<2000 or days_left<30 then 1 when km_left<5000 or days_left<90 then 2 end urgency from remaining
 ), candidates as materialized (
  select c.cars_id,c.sequence,count(*) filter(where e.urgency=0) critical_count,
   jsonb_build_object('car_id',c.cars_id,'client_name',coalesce(nullif(c.body->>'ПІБ',''),'—'),
    'car_name',coalesce(nullif(btrim(coalesce(c.body->>'Марка','')||' '||coalesce(c.body->>'Модель','')),''),nullif(c.body->>'Авто',''),'—'),
    'plate',coalesce(nullif(c.body->>'Держ. номер',''),'—'),'phone',coalesce(nullif(c.body->>'Телефон',''),'—'),
    'last_visit_date',c.last_visit,'last_mileage',c.max_mileage,'alerts',jsonb_agg(jsonb_build_object(
     'work_name',e.rule->>'name','urgency',case e.urgency when 0 then 'critical' when 1 then 'high' else 'medium' end,
     'days_since',e.days_since,'km_since',e.km_since,'km_left',e.km_left,'days_left',e.days_left) order by e.urgency,e.idx)) row
  from cars c join evaluated e on e.cars_id=c.cars_id and e.urgency is not null
  group by c.cars_id,c.sequence,c.body,c.last_visit,c.max_mileage
 ), page as (
  select * from candidates order by critical_count desc,sequence limit least(greatest(coalesce(p_limit,30),1),500)
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(row order by critical_count desc,sequence) from page),'[]'::jsonb),
  'scanned',(select count(*) from cars),'total',(select count(*) from candidates),
  'critical',(select count(*) from candidates where critical_count>0),
  'has_more',(select count(*) from candidates)>(select count(*) from page),'as_of',p_now);
$$;

create or replace function public.traffic_ai_retention_summary(
 p_days integer default 180,p_limit integer default 30,p_now timestamptz default now(),p_timezone text default 'Europe/Kyiv'
) returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as materialized (
  select act_id,client_id,case when jsonb_typeof(to_jsonb(data))='object' then to_jsonb(data) else '{}'::jsonb end body,
   case when pg_typeof(date_on)='timestamp without time zone'::regtype
    then coalesce(date_off,date_on)::timestamp at time zone p_timezone else coalesce(date_off,date_on)::timestamptz end visit_at,
   row_number() over(order by date_on desc nulls first,act_id desc) sequence
  from public.acts where date_off is not null and client_id is not null and client_id<>0
 ), traversed as (
  select *,max(visit_at) over(partition by client_id order by sequence rows between unbounded preceding and 1 preceding) previous_latest from source
 ), contact_updates as materialized (
  -- Match the original descending-created traversal: contact fields change
  -- only when an act advances the maximum visit date seen so far.
  select *,coalesce(nullif(btrim(coalesce(body->>'Марка','')||' '||coalesce(body->>'Модель','')),''),nullif(body->>'Авто','')) car
  from traversed where previous_latest is null or visit_at>previous_latest
 ), totals as (
  select client_id,min(sequence) sequence,max(visit_at) last_visit,count(*) total_acts,
   floor(sum(public.traffic_ai_parse_float(body->'Загальна сума') order by sequence)+0.5) total_spent from source group by client_id
 ), clients as (
  select t.*,floor(extract(epoch from p_now-t.last_visit)/86400) days_since,
   coalesce((select nullif(body->>'ПІБ','') from contact_updates u where u.client_id=t.client_id and coalesce(body->>'ПІБ','')<>'' order by sequence desc limit 1),'—') name,
   coalesce((select nullif(body->>'Телефон','') from contact_updates u where u.client_id=t.client_id and coalesce(body->>'Телефон','')<>'' order by sequence desc limit 1),'—') phone,
   coalesce((select car from contact_updates u where u.client_id=t.client_id and car is not null order by sequence desc limit 1),'—') last_car
  from totals t
 ), matches as materialized (
  select *,floor(days_since/30) months_since from clients where days_since>=p_days and phone<>'—' and length(phone)>=10
 ), page as (
  select * from matches order by (total_acts>=5) desc,total_spent desc,sequence limit least(greatest(coalesce(p_limit,30),1),500)
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'client_id',client_id,'name',name,'phone',phone,'last_visit',to_char(last_visit at time zone 'UTC','YYYY-MM-DD'),
  'months_since',months_since,'total_spent',total_spent,'total_acts',total_acts,'last_car',last_car,
  'loyalty',case when total_acts>=5 then '🌟 постійний' when total_acts>=2 then '🔄 повторний' else '🆕 разовий' end)
  order by (total_acts>=5) desc,total_spent desc,sequence) from page),'[]'::jsonb),
  'total',(select count(*) from matches),'has_more',(select count(*) from matches)>(select count(*) from page),'as_of',p_now);
$$;

revoke all on function public.traffic_atlas_object(jsonb),public.traffic_atlas_number(jsonb,double precision),
 public.traffic_atlas_integer(jsonb),public.traffic_ai_maintenance_summary(jsonb,integer,timestamptz,text),
 public.traffic_ai_retention_summary(integer,integer,timestamptz,text),
 public.traffic_my_reminder_counts(integer),
 public.traffic_ai_price_summary(text,text),public.traffic_reminder_candidates(bigint,timestamptz),
 public.traffic_ai_condition_page(text,integer,integer),public.traffic_chat_append(bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.traffic_atlas_object(jsonb) to anon,authenticated,service_role;
grant execute on function public.traffic_atlas_number(jsonb,double precision),public.traffic_ai_price_summary(text,text),
 public.traffic_atlas_integer(jsonb),public.traffic_ai_maintenance_summary(jsonb,integer,timestamptz,text),
 public.traffic_ai_retention_summary(integer,integer,timestamptz,text),
 public.traffic_my_reminder_counts(integer),
 public.traffic_chat_append(bigint,text,text,jsonb) to anon,authenticated;
grant execute on function public.traffic_ai_condition_page(text,integer,integer) to authenticated,service_role;
grant execute on function public.traffic_reminder_candidates(bigint,timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
