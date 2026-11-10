begin;
-- Additive accounting API. Existing tables, grants and RLS remain authoritative.
-- Requires traffic_shop_report_page, traffic_payroll_report, payroll_fragments.

create or replace function public.traffic_shop_report_v2(p_filter jsonb default '{}'::jsonb,p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb; shop jsonb; day record; entry jsonb; entries jsonb; history jsonb; shops jsonb:='[]';
begin
 result:=public.traffic_shop_report_page(p_filter,p_offset,p_limit);
 for shop in select value from jsonb_array_elements(result->'shops') loop
  history:='{}';
  for day in select * from jsonb_each(shop#>'{data,Історія}') loop
   entries:='[]';
   for entry in select value from jsonb_array_elements(day.value) loop
    entries:=entries||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
     'Акт',entry->'Акт','Розрахунок',entry->'Розрахунок',
     '__payment_fingerprint',encode(sha256(convert_to((entry-'Розрахунок')::text,'UTF8')),'hex'))));
   end loop;
   history:=history||jsonb_build_object(day.key,entries);
  end loop;
  shops:=shops||jsonb_build_array(jsonb_build_object('shop_id',shop->'shop_id','data',jsonb_build_object('Name',shop#>'{data,Name}','Історія',history)));
 end loop;
 return jsonb_set(result,'{shops}',shops);
end $$;

create or replace function public.write_shop_payment_fragments(p_shops jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; change jsonb; row_value public.shops%rowtype; converted public.shops%rowtype;
 original jsonb; body jsonb; bucket jsonb; target jsonb; next_target jsonb; paid jsonb;
 day text; act text; entry_index integer; match_count integer; receipts jsonb:='[]';
begin
 if jsonb_typeof(p_shops) is distinct from 'array' or jsonb_array_length(p_shops)>50 then raise exception 'Некоректний пакет магазинів';end if;
 if exists(select 1 from jsonb_array_elements(p_shops)x where coalesce(x->>'id','')!~'^[1-9][0-9]*$' or jsonb_typeof(x->'changes') is distinct from 'array') then raise exception 'Некоректний запит розрахунку';end if;
 if exists(select 1 from jsonb_array_elements(p_shops)x group by x->>'id' having count(*)>1) then raise exception 'Повторний магазин';end if;
 for item in select value from jsonb_array_elements(p_shops) order by (value->>'id')::bigint loop
  select * into row_value from public.shops where shop_id=(item->>'id')::bigint for update;
  if not found then raise exception 'Магазин відсутній або недоступний' using errcode='40001';end if;
  original:=to_jsonb(row_value.data);body:=public.payroll_json_object(original);
  if jsonb_array_length(item->'changes')>2000 then raise exception 'Завеликий пакет розрахунків';end if;
  for change in select value from jsonb_array_elements(item->'changes') loop
   day:=change->>'date';act:=change->>'act';paid:=coalesce(change->'desired','null'::jsonb);
   if nullif(day,'') is null or nullif(act,'') is null or jsonb_typeof(paid) not in ('null','string') then raise exception 'Некоректна дата або акт';end if;
   bucket:=body#>array['Історія',day];
   if jsonb_typeof(bucket) is distinct from 'array' then raise exception 'Запис переміщено або видалено' using errcode='40001';end if;
   select count(*),min(ordinality)::integer-1 into match_count,entry_index from jsonb_array_elements(bucket) with ordinality where value->>'Акт'=act;
   if match_count<>1 then raise exception 'Акт відсутній або дублюється в історії' using errcode='40001';end if;
   target:=bucket->entry_index;
   if encode(sha256(convert_to((target-'Розрахунок')::text,'UTF8')),'hex') is distinct from change->>'fingerprint' then
    raise exception 'Деталі акта змінилися. Перевірте суму перед оплатою.' using errcode='40001';
   end if;
   if coalesce(target->'Розрахунок','null'::jsonb) is distinct from coalesce(change->'expected','null'::jsonb)
      and coalesce(target->'Розрахунок','null'::jsonb) is distinct from paid then
    raise exception 'Розрахунок уже змінено. Оновіть звіт.' using errcode='40001';
   end if;
   next_target:=case when paid='null'::jsonb then target-'Розрахунок' else jsonb_set(target,'{Розрахунок}',paid) end;
   body:=jsonb_set(body,array['Історія',day,entry_index::text],next_target);
  end loop;
  if body is distinct from public.payroll_json_object(original) then
   converted:=jsonb_populate_record(null::public.shops,jsonb_build_object('data',case when jsonb_typeof(original)='string' then to_jsonb(body::text) else body end));
   update public.shops set data=converted.data where shop_id=row_value.shop_id;
   if not found then raise exception 'Запис магазину заборонено' using errcode='42501';end if;
  end if;
  receipts:=receipts||jsonb_build_array(jsonb_build_object('id',row_value.shop_id,'status','saved'));
 end loop;
 return receipts;
end $$;

create or replace function public.traffic_profit_labels(p_resource text,p_ids bigint[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if coalesce(cardinality(p_ids),0)>200 then raise exception 'Завеликий пакет підписів';end if;
 if p_resource='clients' then
  select coalesce(jsonb_agg(jsonb_build_object('id',client_id,'data',jsonb_build_object('ПІБ',d->'ПІБ','Телефон',d->'Телефон','Джерело',d->'Джерело','Додаткові',d->'Додаткові'))),'[]') into result
  from (select client_id,public.payroll_json_object(to_jsonb(data)) d from public.clients where client_id=any(p_ids)) q;
 elsif p_resource='cars' then
  select coalesce(jsonb_agg(jsonb_build_object('id',cars_id,'data',jsonb_build_object('Авто',d->'Авто','Номер авто',d->'Номер авто','Обʼєм',d->'Обʼєм','КодДВЗ',d->'КодДВЗ','Пальне',d->'Пальне'))),'[]') into result
  from (select cars_id,public.payroll_json_object(to_jsonb(data)) d from public.cars where cars_id=any(p_ids)) q;
 else raise exception 'Невідомий довідник';end if;
 return result;
end $$;

create or replace function public.write_payroll_payment_batch(p_employees jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; act_number bigint; result jsonb:='[]';
begin
 if jsonb_typeof(p_employees) is distinct from 'array' or jsonb_array_length(p_employees)>50 then raise exception 'Некоректний пакет зарплати';end if;
 if exists(select 1 from jsonb_array_elements(p_employees)e where coalesce(e->>'id','')!~'^[1-9][0-9]*$' or jsonb_typeof(e->'changes') is distinct from 'array') then raise exception 'Некоректний працівник';end if;
 if exists(select 1 from jsonb_array_elements(p_employees)e group by e->>'id' having count(*)>1) then raise exception 'Повторний працівник';end if;
 -- Same lock order as single employee writes: all acts first, then employees.
 for act_number in select distinct (c->>'act_id')::bigint from jsonb_array_elements(p_employees)e cross join lateral jsonb_array_elements(e->'changes')c order by 1 loop
  perform 1 from public.acts where act_id=act_number for update;
  if not found then raise exception 'Акт відсутній або недоступний' using errcode='40001';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_employees) order by (value->>'id')::bigint loop
  result:=result||jsonb_build_array(public.write_payroll_fragments((item->>'id')::bigint,'payment',item->'changes'));
 end loop;
 return result;
end $$;

create or replace function public.traffic_payroll_report_v2(p_filters jsonb,p_offset integer default 0,p_options boolean default true)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 result:=public.traffic_payroll_report(p_filters,p_offset);
 if not p_options then result:=result||'{"acts":[],"works":[]}'::jsonb;end if;
 return result;
end $$;

create or replace function public.traffic_audit_page(p_filter jsonb default '{}'::jsonb,p_before timestamptz default null,p_before_id bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with source as (
  select id,created_at,user_login,user_role,action,act_id,
   coalesce(nullif(details->>'_category',''),case
    when action like 'act\_%' escape '\' or action in ('open_act','close_act','freeze_act','unfreeze_act','update_act_items','update_act_info') then 'act'
    when action like 'planning\_%' escape '\' then 'planning'
    when action like 'client\_%' escape '\' or action like 'car\_%' escape '\' then 'client'
    when action like 'settings\_%' escape '\' or action in ('db_edit_slyusars','db_delete_slyusars','db_add_slyusars') then 'settings'
    when action like 'warehouse\_%' escape '\' or action like 'db_edit\_%' escape '\' or action like 'db_delete\_%' escape '\' or action like 'db_add\_%' escape '\' then 'warehouse'
    else 'act' end) category
  from public.audit_logs
  where action<>'update_act_info'
   and (nullif(p_filter->>'from','') is null or created_at>=((p_filter->>'from')::date::timestamp at time zone 'Europe/Kyiv'))
   and (nullif(p_filter->>'to','') is null or created_at<(((p_filter->>'to')::date+1)::timestamp at time zone 'Europe/Kyiv'))
   and (nullif(p_filter->>'user','') is null or user_login=p_filter->>'user')
   and (nullif(p_filter->>'role','') is null or user_role=p_filter->>'role')
   and (p_before is null or (created_at,id)<(p_before,p_before_id))
 ), candidates as (
  select * from source where coalesce(p_filter->>'category','all')='all' or category=p_filter->>'category'
  order by created_at desc,id desc limit 51
 ), page as (select * from candidates order by created_at desc,id desc limit 50)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from page p),'[]'),
  'has_more',(select count(*)>50 from candidates),
  'users',case when p_before is null then (select coalesce(jsonb_agg(v order by v),'[]') from (select distinct user_login v from public.audit_logs)u) else '[]'::jsonb end,
  'roles',case when p_before is null then (select coalesce(jsonb_agg(v order by v),'[]') from (select distinct user_role v from public.audit_logs where user_role is not null)u) else '[]'::jsonb end)
$$;
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc,id desc);

revoke all on function public.traffic_shop_report_v2(jsonb,integer,integer),public.write_shop_payment_fragments(jsonb),public.traffic_profit_labels(text,bigint[]),public.write_payroll_payment_batch(jsonb),public.traffic_payroll_report_v2(jsonb,integer,boolean),public.traffic_audit_page(jsonb,timestamptz,bigint) from public;
grant execute on function public.traffic_shop_report_v2(jsonb,integer,integer),public.write_shop_payment_fragments(jsonb),public.traffic_profit_labels(text,bigint[]),public.write_payroll_payment_batch(jsonb),public.traffic_payroll_report_v2(jsonb,integer,boolean),public.traffic_audit_page(jsonb,timestamptz,bigint) to anon,authenticated;
notify pgrst,'reload schema';
commit;
