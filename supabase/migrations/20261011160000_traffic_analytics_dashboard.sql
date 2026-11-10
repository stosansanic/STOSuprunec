-- Read-only accounting dashboard operands/aggregates. No new tables.
create or replace function public.traffic_analytics_or(v jsonb,fallback jsonb default '0'::jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select case when public.traffic_search_truthy(v) then v else fallback end;
$$;
create or replace function public.traffic_analytics_add(a jsonb,b jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
begin
 -- Existing formulas use JS +, including its string concatenation semantics.
 if jsonb_typeof(a) in ('string','array','object') or jsonb_typeof(b) in ('string','array','object') then
  return to_jsonb(public.traffic_search_string(a)||public.traffic_search_string(b));
 end if;
 return to_jsonb(public.traffic_search_number(a)+public.traffic_search_number(b));
end $$;
create or replace function public.traffic_analytics_date(v text,p_timezone text)
returns timestamptz language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare parts text[];y integer;m integer;d integer;
begin
 if v is null or v='' then return null;end if;
 -- Date-only ISO history keys use UTC in JS; timestamp-without-zone fields use
 -- the browser zone. In particular acts and vutratu are NOT timestamptz.
 if v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
  parts:=string_to_array(v,'-');y:=parts[1]::integer;m:=parts[2]::integer;d:=parts[3]::integer;
  if m not between 1 and 12 or d not between 1 and 31 then return null;end if;
  return (make_date(y,m,1)+(d-1))::timestamp at time zone 'UTC';
 end if;
 if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]' then return null;end if;
 if v ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then return v::timestamptz;end if;
 return v::timestamp at time zone p_timezone;
 exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;
create or replace function public.traffic_analytics_mechanics(p_from timestamptz default null,p_to timestamptz default null,p_timezone text default 'Europe/Kyiv')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare staff record;body jsonb;day record;entry jsonb;rec jsonb;date_value timestamptz;
 acts_count integer;earned jsonb;salary jsonb;works_count integer;items jsonb:='[]'::jsonb;
begin
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Invalid timezone';end if;
 for staff in select slyusar_id,data from public.slyusars order by slyusar_id loop
  body:=staff.data::jsonb;
  if not public.traffic_search_truthy(body->'Name') or not public.traffic_search_truthy(body->'Історія') or body->>'Доступ'='Приймальник' then continue;end if;
  acts_count:=0;earned:='0';salary:='0';works_count:=0;
  if jsonb_typeof(body->'Історія') is distinct from 'object' then continue;end if;
  for day in select * from jsonb_each(body->'Історія') loop
   if p_from is not null or p_to is not null then
    date_value:=public.traffic_analytics_date(day.key,p_timezone);
    if date_value is null or date_value<p_from or date_value>p_to then continue;end if;
   end if;
   if jsonb_typeof(day.value) is distinct from 'array' then continue;end if;
   for entry in select value from jsonb_array_elements(day.value) loop
    if entry='null'::jsonb then raise exception 'Invalid analytics salary history entry';end if;
    acts_count:=acts_count+1;
    earned:=public.traffic_analytics_add(earned,public.traffic_analytics_or(entry->'СуммаРоботи'));
    if public.traffic_search_truthy(entry->'Записи') then
     if jsonb_typeof(entry->'Записи') is distinct from 'array' then raise exception 'Invalid analytics salary records';end if;
     works_count:=works_count+jsonb_array_length(entry->'Записи');
     for rec in select value from jsonb_array_elements(entry->'Записи') loop
      if rec='null'::jsonb then raise exception 'Invalid analytics salary record';end if;
      salary:=public.traffic_analytics_add(salary,public.traffic_analytics_or(rec->'Зарплата'));
     end loop;
    end if;
   end loop;
  end loop;
  if acts_count>0 then items:=items||jsonb_build_array(jsonb_build_object('name',body->'Name','actsCount',acts_count,'totalEarned',earned,'totalSalary',salary,
    'avgPerAct',floor(public.traffic_search_number(earned)/acts_count+0.5),'totalWorks',works_count));end if;
 end loop;
 select coalesce(jsonb_agg(value order by public.traffic_search_number(value->'totalEarned') desc,ord),'[]'::jsonb) into items from jsonb_array_elements(items) with ordinality x(value,ord);
 return jsonb_build_object('items',items,'complete',true,'as_of',statement_timestamp());
end $$;
revoke all on function public.traffic_analytics_or(jsonb,jsonb),public.traffic_analytics_add(jsonb,jsonb),public.traffic_analytics_date(text,text),public.traffic_analytics_mechanics(timestamptz,timestamptz,text) from public;
grant execute on function public.traffic_analytics_or(jsonb,jsonb),public.traffic_analytics_add(jsonb,jsonb),public.traffic_analytics_date(text,text),public.traffic_analytics_mechanics(timestamptz,timestamptz,text) to anon,authenticated;

do $$ begin
 if to_regprocedure('public.traffic_analytics_sum(jsonb)') is null then
  execute 'create aggregate public.traffic_analytics_sum(jsonb) (sfunc=public.traffic_analytics_add,stype=jsonb,initcond=''0'')';
 end if;
end $$;

create or replace function public.traffic_analytics_dashboard(p_from timestamptz default null,p_to timestamptz default null,p_timezone text default 'Europe/Kyiv',p_now timestamptz default now())
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; heat_from timestamptz;heat_to timestamptz;
begin
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Invalid timezone';end if;
 heat_from:=date_trunc('day',coalesce(p_from,case when p_to is not null then p_to else p_now end) at time zone p_timezone
   -case when p_from is null then interval '14 days' else interval '0 days' end) at time zone p_timezone;
 heat_to:=((case when p_to is not null then p_to at time zone p_timezone
   when p_from is not null then p_from at time zone p_timezone+interval '14 days'
   else p_now at time zone p_timezone end)::date+1)::timestamp at time zone p_timezone;
 with source as materialized (
  select a.act_id,a.client_id,a.cars_id,a.date_on,a.date_off,(a.data is not null and a.data::jsonb<>'null'::jsonb) has_body,public.traffic_json_object(a.data::jsonb) body,
    public.traffic_analytics_date(a.date_on::text,p_timezone) opened,
    public.traffic_analytics_date(a.date_off::text,p_timezone) closed
  from public.acts a
 ), acts as materialized (
  select *,row_number() over(order by date_on desc,act_id) rank,
    public.traffic_analytics_add(public.traffic_analytics_or(body->'За роботу'),public.traffic_analytics_or(body->'За деталі')) revenue
  from source
  where body->'Заморожений' is distinct from 'true'::jsonb
    and (p_from is null or coalesce(closed,opened)>=p_from) and (p_to is null or coalesce(closed,opened)<=p_to)
 ), works as materialized (
  select a.act_id,a.rank,w.ord,w.item,
   public.traffic_search_trim(w.item->>'Робота') name,
   public.traffic_search_number(public.traffic_analytics_or(w.item->'Ціна'))*
    public.traffic_search_number(public.traffic_analytics_or(w.item->'Кількість','1')) amount
  from acts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.body->'Роботи')='array' then a.body->'Роботи' else '[]' end) with ordinality w(item,ord)
 ), parts as materialized (
  select a.rank,d.ord,public.traffic_search_trim(d.item->>'Деталь') name,
    public.traffic_analytics_or(d.item->'Кількість','1') qty,
    public.traffic_search_number(public.traffic_analytics_or(d.item->'Ціна'))*
    public.traffic_search_number(public.traffic_analytics_or(d.item->'Кількість','1')) amount
  from acts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.body->'Деталі')='array' then a.body->'Деталі' else '[]' end) with ordinality d(item,ord)
 ), expense_rows as materialized (
  select v.vutratu_id,v.suma,v.act,public.traffic_analytics_date(v."dataOnn"::text,p_timezone) date_value
  from public.vutratu v
 ), expense_months as (
  select to_char(date_value at time zone p_timezone,'YYYY-MM') AS month,
    coalesce(sum(abs(suma::double precision) order by date_value desc,vutratu_id) filter(where suma<0),0) expenses
  from expense_rows where (act is null or act=0) and date_value is not null
    and (p_from is null or date_value>=p_from) and (p_to is null or date_value<=p_to) group by 1
 ), act_months as (
  select to_char(closed at time zone p_timezone,'YYYY-MM') AS month,
    public.traffic_analytics_sum(revenue order by rank) revenue,count(*) acts_count
  from acts where closed is not null group by 1
 ), months as (
  select coalesce(a.month,e.month) AS month,coalesce(a.revenue,'0'::jsonb) revenue,coalesce(e.expenses,0) expenses,
   public.traffic_search_number(coalesce(a.revenue,'0'))-coalesce(e.expenses,0) profit,coalesce(a.acts_count,0) acts_count
  from act_months a full join expense_months e using(month)
  order by 1 desc limit 12
 ), work_groups as (
  select name,sum(amount order by rank,ord) total,count(*) count,min(rank*1000000+ord) rank
  from works where coalesce(name,'')<>'' group by name
 ), part_groups as (
  select name,sum(amount order by rank,ord) total,public.traffic_analytics_sum(qty order by rank,ord) qty,count(*) count,min(rank*1000000+ord) rank
  from parts where coalesce(name,'')<>'' group by name
 ), category_rules as (
  select item->>0 name,item->1 keywords,ord from jsonb_array_elements('[["Ходова",["важіль","амортизатор","сайлентблок","тяга","наконечник","кульова","підшипник","пружина","втулка","стійка","ходова","кулак","балка","развал","сход"]],["Двигун",["двигун","гзм","грм","масло","фільтр","прокладка","сальник","свічки","клапан","головка","циліндр","поршень","ремен","ланцюг","турбіна","гбц"]],["Гальмівна",["гальм","колодки","диск","супорт","шланг","циліндр гальм","абс","abs","ручник"]],["Трансмісія",["кпп","акпп","зчеплення","демпфер","шрус","піввісь","редуктор","кардан","масло кпп"]],["Електрика",["світло","фара","ламп","провод","датчик","стартер","генератор","акумулятор","діагностика","комп","електри"]],["ТО",["діагностика","огляд","перевірка","то-","технічне обслуговування","фільтр повітр","фільтр палив"]],["Вихлопна",["глушник","резонатор","каталізатор","зварювання","гофра"]],["Охолодження",["радіатор","помпа","термостат","антифриз","патрубок","вентилятор"]]]'::jsonb) with ordinality c(item,ord)
 ), category_groups as (
  select coalesce(c.name,'Інше') name,sum(w.amount order by w.rank,w.ord) total,min(w.rank*1000000+w.ord) rank
  from works w left join lateral (
   select name from category_rules c where exists(select 1 from jsonb_array_elements_text(c.keywords) k where position(k in lower(coalesce(w.item->>'Робота','')))>0) order by c.ord limit 1
  ) c on true group by coalesce(c.name,'Інше')
 ), client_groups as (
  select client_id,count(*) count,public.traffic_analytics_sum(revenue order by rank) total,min(rank) rank
  from acts where client_id is not null and client_id<>0 group by client_id
 ), car_groups as (
  select cars_id,count(*) count,public.traffic_analytics_sum(revenue order by rank) total,min(rank) rank
  from acts where cars_id is not null and cars_id<>0 group by cars_id
 ), client_top as (
  select * from (select g.*,row_number() over(order by public.traffic_search_number(total) desc,rank) by_sum,row_number() over(order by count desc,rank) by_count from client_groups g) x where by_sum<=10 or by_count<=10
 ), car_top as (
  select * from (select g.*,row_number() over(order by public.traffic_search_number(total) desc,rank) by_sum,row_number() over(order by count desc,rank) by_count from car_groups g) x where by_sum<=10 or by_count<=10
 ), client_labels as (
  select t.*,jsonb_build_object('clientId',t.client_id,'totalSum',t.total,'actsCount',t.count,
   'pib',public.traffic_analytics_or(public.traffic_json_object(c.data::jsonb)->'ПІБ','"Невідомий"')) item
  from client_top t left join public.clients c using(client_id)
 ), car_labels as (
  select t.*,jsonb_build_object('carsId',t.cars_id,'totalSum',t.total,'actsCount',t.count,
   'carName',public.traffic_analytics_or(public.traffic_json_object(c.data::jsonb)->'Авто','"Невідомо"'),
   'plate',public.traffic_analytics_or(public.traffic_json_object(c.data::jsonb)->'Номер авто','""')) item
  from car_top t left join public.cars c on c.cars_id=t.cars_id and c.is_deleted is distinct from true
 ), anomaly_candidates as (
  select 1 priority,a.rank,jsonb_build_object('kind','salary','actId',a.act_id,'value',public.traffic_analytics_or(a.body->'За роботу')) item
  from acts a where a.closed is not null and public.traffic_search_number(public.traffic_analytics_or(a.body->'За роботу'))>0
   and exists(select 1 from works w where w.act_id=a.act_id)
   and (select public.traffic_analytics_sum(public.traffic_analytics_or(w.item->'Зарплата') order by w.ord) from works w where w.act_id=a.act_id)='0'::jsonb
  union all select 2,rank,jsonb_build_object('kind','zero','actId',act_id) from acts where closed is not null and has_body and revenue='0'::jsonb
  union all select 3,rank,jsonb_build_object('kind','old','actId',act_id,'days',floor(extract(epoch from(p_now-opened))/86400))
   from acts where closed is null and opened < ((p_now at time zone p_timezone)-interval '30 days') at time zone p_timezone
 ), day_groups as (
  select extract(dow from coalesce(closed,opened) at time zone p_timezone)::integer AS day,count(*) count,public.traffic_analytics_sum(revenue order by rank) revenue
  from acts where coalesce(closed,opened) is not null group by 1
 )
 select jsonb_build_object(
  'complete',true,'formula_version',1,'as_of',statement_timestamp(),
  'min_date',(select min(date_on) from source),
  'monthly',coalesce((select jsonb_agg(jsonb_build_object('month',month,'revenue',revenue,'expenses',expenses,'profit',profit,'actsCount',acts_count) order by month) from months),'[]'::jsonb),
  'avg_check',coalesce((select jsonb_agg(jsonb_build_object('month',month,'avg',floor(public.traffic_search_number(revenue)/acts_count+0.5)) order by month) from (select * from act_months order by month desc limit 12)x),'[]'::jsonb),
  'top_works',coalesce((select jsonb_agg(jsonb_build_object('name',name,'totalRevenue',total,'count',count) order by total desc,rank) from (select * from work_groups order by total desc,rank limit 10)x),'[]'::jsonb),
  'categories',coalesce((select jsonb_agg(jsonb_build_object('name',name,'value',total) order by total desc,rank) from category_groups where total>0),'[]'::jsonb),
  'days',coalesce((select jsonb_agg(to_jsonb(g) order by day) from day_groups g),'[]'::jsonb),
  'parts_sum',coalesce((select jsonb_agg(jsonb_build_object('name',name,'totalSum',total,'totalQty',qty,'actsCount',count) order by total desc,rank) from(select * from part_groups order by total desc,rank limit 10)x),'[]'::jsonb),
  'parts_count',coalesce((select jsonb_agg(jsonb_build_object('name',name,'totalSum',total,'totalQty',qty,'actsCount',count) order by count desc,public.traffic_search_number(qty) desc,rank) from(select * from part_groups order by count desc,public.traffic_search_number(qty) desc,rank limit 10)x),'[]'::jsonb),
  'clients_sum',coalesce((select jsonb_agg(item order by by_sum) from client_labels where by_sum<=10),'[]'::jsonb),
  'clients_count',coalesce((select jsonb_agg(item order by by_count) from client_labels where by_count<=10),'[]'::jsonb),
  'cars_sum',coalesce((select jsonb_agg(item order by by_sum) from car_labels where by_sum<=10),'[]'::jsonb),
  'cars_count',coalesce((select jsonb_agg(item order by by_count) from car_labels where by_count<=10),'[]'::jsonb),
  'anomalies',coalesce((select jsonb_agg(item order by priority,rank) from(select * from anomaly_candidates order by priority,rank limit 20)x),'[]'::jsonb),
  'summary',jsonb_build_object(
   'totalActs',(select count(*) from acts),'openActs',(select count(*) from acts where closed is null),
   'closedCount',(select count(*) from acts where closed is not null),
   'avgCheck',(select coalesce(floor(public.traffic_search_number(public.traffic_analytics_sum(revenue order by rank))/nullif(count(*),0)+0.5),0) from acts where closed is not null),
   'maxAct',coalesce((select jsonb_build_object('id',act_id,'total',revenue) from acts where closed is not null and public.traffic_search_number(revenue)>0 order by public.traffic_search_number(revenue) desc,rank limit 1),'{"id":0,"total":0}'),
   'uniqueClients',(select count(distinct client_id) from acts where client_id is not null and client_id<>0),
   'avgDays',(select coalesce(floor(avg(greatest(0,extract(epoch from(closed-opened))/86400))*10+0.5)/10,0) from acts where opened is not null and closed is not null)),
  'mechanics',public.traffic_analytics_mechanics(p_from,p_to,p_timezone)->'items',
  'planning',coalesce((select jsonb_agg(jsonb_build_object('data_on',data_on,'data_off',data_off,'status',status) order by post_arxiv_id)
    from public.post_arxiv where data_on<heat_to and data_off>=heat_from and status is distinct from 'Скасовано'),'[]'::jsonb),
  'posts_count',(select count(*) from public.post_name)
 ) into result;
 return result;
end $$;
revoke all on function public.traffic_analytics_dashboard(timestamptz,timestamptz,text,timestamptz) from public;
grant execute on function public.traffic_analytics_sum(jsonb),public.traffic_analytics_dashboard(timestamptz,timestamptz,text,timestamptz) to anon,authenticated;

