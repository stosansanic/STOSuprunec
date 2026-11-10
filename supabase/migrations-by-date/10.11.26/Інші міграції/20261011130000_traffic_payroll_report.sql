-- Read-only report pages. Formulas mirror zarplata.ts; full histories never leave the server.
create or replace function public.traffic_payroll_iso(p_value text)
returns text language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare s text; m text[];
begin
 m:=regexp_match(btrim(coalesce(p_value,'')),'^([0-9]{4})-([0-9]{2})-([0-9]{2})($|[T[:space:]])');
 if m is not null then return m[1]||'-'||m[2]||'-'||m[3];end if;
 s:=regexp_replace(normalize(coalesce(p_value,''),NFKC),'[^0-9./-]','','g');
 m:=regexp_match(s,'^([0-9]{4})[./-]([0-9]{1,2})[./-]([0-9]{1,2})$');
 if m is not null then return m[1]||'-'||lpad(m[2],2,'0')||'-'||lpad(m[3],2,'0');end if;
 m:=regexp_match(s,'^([0-9]{1,2})[./-]([0-9]{1,2})[./-]([0-9]{2,4})$');
 if m is not null then
  if length(m[3])=2 then m[3]:=case when m[3]::int>=70 then '19' else '20' end||m[3];end if;
  return m[3]||'-'||lpad(m[2],2,'0')||'-'||lpad(m[1],2,'0');
 end if;
 return '';
end $$;

create or replace function public.traffic_payroll_validate(p_data jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare history jsonb:=coalesce(nullif(p_data->'Історія','null'::jsonb),'{}'::jsonb);bucket jsonb;entry jsonb;seen text[]:='{}';act text;
begin
 if jsonb_typeof(history) is distinct from 'object' then raise exception 'Некоректна історія зарплат';end if;
 for bucket in select value from jsonb_each(history) loop
  if jsonb_typeof(bucket) is distinct from 'array' then raise exception 'Некоректна дата історії зарплат';end if;
  for entry in select value from jsonb_array_elements(bucket) loop
   act:=entry->>'Акт';if act is null then raise exception 'Нарахування без номера акта';end if;
   if act=any(seen) then raise exception 'Дублікати зарплати за актом %',act;end if;seen:=array_append(seen,act);
   if entry?'Записи' and entry->'Записи'<>'null'::jsonb then
    if jsonb_typeof(entry->'Записи') is distinct from 'array' then raise exception 'Некоректний список робіт';end if;
    if exists(select 1 from jsonb_array_elements(entry->'Записи')r where nullif(r->>'recordId','') is not null group by r->>'recordId' having count(*)>1) then raise exception 'Повторні ідентифікатори робіт в акті %',act;end if;
   end if;
  end loop;
 end loop;
 return true;
end $$;

create or replace function public.traffic_payroll_report(p_filters jsonb,p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; selected_name text:=coalesce(p_filters->>'name','');mode text:=coalesce(p_filters->>'mode','open');
 from_day text:=public.traffic_payroll_iso(p_filters->>'from');to_day text:=public.traffic_payroll_iso(p_filters->>'to');
begin
 if mode not in ('open','close','paid') then raise exception 'Невідомий режим дат';end if;
 if to_day='' then raise exception 'Потрібна кінцева дата звіту';end if;
 -- Validate selected employees before narrowing dates: hidden duplicates must not become payable.
 perform public.traffic_payroll_validate(public.payroll_json_object(to_jsonb(s.data))) from public.slyusars s
  where selected_name='' or public.payroll_json_object(to_jsonb(s.data))->>'Name'=selected_name;
 with employees as materialized (
  select s.slyusar_id id,public.payroll_json_object(to_jsonb(s.data)) doc from public.slyusars s
  where selected_name='' or public.payroll_json_object(to_jsonb(s.data))->>'Name'=selected_name
 ), entries as materialized (
  select e.id,e.doc->>'Name' name,e.doc->'ПроцентРоботи' percent,h.key history_day,x.value entry,x.ordinality entry_order,
   a.act_id existing_act_id,a.date_off,(case when a.act_id is null then '{}'::jsonb else public.payroll_json_object(to_jsonb(a.data)) end)->'Заморожений'='true'::jsonb frozen,
   (case when a.act_id is null then '{}'::jsonb else public.payroll_json_object(to_jsonb(a.data)) end)->'__payroll_pending'='true'::jsonb pending,
   case when a.act_id is not null then coalesce(a.date_off::text,'') else coalesce(x.value->>'ДатаЗакриття','') end close_day,
   case when a.act_id is not null then a.date_off is not null else coalesce(x.value->>'ДатаЗакриття','')<>'' end closed
  from employees e cross join lateral jsonb_each(coalesce(nullif(e.doc->'Історія','null'::jsonb),'{}'::jsonb))h
   cross join lateral jsonb_array_elements(h.value) with ordinality x
   left join public.acts a on a.act_id::text=x.value->>'Акт'
 ), expanded as (
  select e.*,case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0 then 'work'
   when entry?'СуммаРоботи' then 'receiver' when entry?'СуммаЗапчастин' then 'parts' else 'unknown' end kind,
   r.value row_data,r.ordinality::integer-1 work_index
  from entries e cross join lateral jsonb_array_elements(case when jsonb_array_length(coalesce(nullif(entry->'Записи','null'::jsonb),'[]'::jsonb))>0 then entry->'Записи' else '[null]'::jsonb end) with ordinality r
  where not coalesce(frozen,false)
 ), value_rows as (
  select *,case when kind='work' then coalesce(row_data->>'Розраховано','') else coalesce(entry->>'Розраховано','') end paid_day,
   case when kind='work' then coalesce(row_data->>'Робота','') when kind='receiver' then '-' else 'Запчастини' end work,
   coalesce(public.traffic_search_number(row_data->'Ціна'),0)*coalesce(public.traffic_search_number(row_data->'Кількість'),0) work_total,
   coalesce(public.traffic_search_number(row_data->'Зарплата'),0) work_salary,
   coalesce(public.traffic_search_number(entry->'СуммаРоботи'),0) work_sum,
   coalesce(public.traffic_search_number(entry->'СуммаЗапчастин'),0) parts_sum,
   coalesce(public.traffic_search_number(entry->'ЗарплатаРоботи'),0) receiver_work_salary,
   coalesce(public.traffic_search_number(entry->'ЗарплатаЗапчастин'),0) parts_salary
  from expanded where kind<>'unknown' and not(kind='work' and coalesce(row_data->'Кількість'='0'::jsonb,false) and not public.traffic_search_truthy(row_data->'Зарплата'))
 ), calculated as (
  select *,case when kind='work' then work_total when kind='receiver' then work_sum+parts_sum else parts_sum end revenue,
   case when kind='work' then work_salary when kind='receiver' then (case when work_sum>0 then receiver_work_salary else 0 end)+parts_salary else case when parts_sum>0 then parts_salary else 0 end end salary,
   public.traffic_payroll_iso(case when mode='paid' then paid_day when mode='close' then close_day else history_day end) filter_day
  from value_rows
 ), date_matches as materialized (
  select * from calculated where filter_day<>'' and (from_day='' or filter_day>=from_day) and filter_day<=to_day
 ), matches as materialized (
  select * from date_matches where
   (coalesce(p_filters->>'act','')='' or entry->>'Акт'=p_filters->>'act')
   and (coalesce(p_filters->>'work','')='' or strpos(lower(work),lower(p_filters->>'work'))>0)
   and (coalesce(p_filters->>'payment','all')='all' or (p_filters->>'payment'='paid' and paid_day<>'') or (p_filters->>'payment'='unpaid' and paid_day=''))
   and (coalesce(p_filters->>'status','all')='all' or (p_filters->>'status'='closed' and closed) or (p_filters->>'status'='open' and not closed))
   and (coalesce(p_filters->>'percentage','all')='all' or (kind='work' and salary<>0 and coalesce(public.traffic_search_number(percent),0)<>0 and
    case when p_filters->>'percentage'='higher' then (case when revenue>0 then salary/revenue*100 else 0 end)>public.traffic_search_number(percent)
     else (case when revenue>0 then salary/revenue*100 else 0 end)<public.traffic_search_number(percent) end))
 ), page as materialized (
  select * from matches order by coalesce(substring(entry->>'Акт' from '^[-+]?[0-9]+')::numeric,0) desc,
   public.traffic_payroll_iso(case when mode='paid' then paid_day else history_day end) desc,id,history_day,entry_order,work_index
   offset greatest(coalesce(p_offset,0),0) limit 50
 ), page_entries as (
  select distinct id,name,percent,history_day,entry,entry_order from page
 ), histories as (
  select id,name,percent,history_day,jsonb_agg(entry order by entry_order) entries from page_entries group by id,name,percent,history_day
 ), rows as (
  select id,jsonb_build_object('slyusar_id',id,'data',jsonb_build_object('Name',name,'ПроцентРоботи',percent,'Історія',jsonb_object_agg(history_day,entries))) row from histories group by id,name,percent
 )
 select jsonb_build_object(
  'employees',coalesce((select jsonb_agg(row order by id) from rows),'[]'::jsonb),
  'keys',coalesce((select jsonb_agg(jsonb_build_array(id,history_day,entry->>'Акт',case when kind='work' then work_index else null end)) from page),'[]'::jsonb),
  'statuses',coalesce((select jsonb_agg(jsonb_build_object('actId',id,'dateOff',date_off,'isClosed',closed,'isFrozen',false,'payrollPending',pending)) from (select distinct existing_act_id::text id,date_off,closed,pending from page where existing_act_id is not null)s),'[]'::jsonb),
  'total',(select count(*) from matches),'revenue',coalesce((select sum(revenue) from matches),0),'salary',coalesce((select sum(salary) from matches),0),
  'has_more',(select count(*) from matches)>greatest(coalesce(p_offset,0),0)+50,
  'acts',coalesce((select jsonb_agg(act order by coalesce(substring(act from '^[-+]?[0-9]+')::numeric,0) desc) from(select distinct entry->>'Акт' act from date_matches)a),'[]'::jsonb),
  'works',coalesce((select jsonb_agg(work order by work) from(select distinct work from date_matches order by work limit 150)w),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.traffic_payroll_iso(text),public.traffic_payroll_validate(jsonb),public.traffic_payroll_report(jsonb,integer) from public;
grant execute on function public.traffic_payroll_iso(text),public.traffic_payroll_validate(jsonb),public.traffic_payroll_report(jsonb,integer) to anon,authenticated;
notify pgrst,'reload schema';
