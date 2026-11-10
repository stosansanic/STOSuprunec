-- Act editor traffic: scoped shop fragments, compact list refresh and atomic status/stock transitions.
-- Requires the existing act delta, shop payment-scope, search and payroll migrations.
begin;

create or replace function public.traffic_act_shop_context(p_act_id integer,p_revision text,p_names text[] default '{}')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; client_doc jsonb; car_doc jsonb; shops_json jsonb; stock_json jsonb;
begin
 if cardinality(p_names)>1000 then raise exception 'Забагато магазинів у одному акті';end if;
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if doc->>'__act_revision' is distinct from p_revision then raise exception 'Акт змінився під час синхронізації магазинів' using errcode='40001';end if;
 select public.sto_read_object_v1(to_jsonb(c.data)) into client_doc from public.clients c where c.client_id=a.client_id;
 select public.sto_read_object_v1(to_jsonb(c.data)) into car_doc from public.cars c where c.cars_id=a.cars_id;
 with source as (
  select s.shop_id,public.sto_read_object_v1(to_jsonb(s.data)) body from public.shops s
 ), scoped as (
  select s.shop_id,s.body->>'Name' name,coalesce((
   select jsonb_agg(jsonb_build_object('date',d.key,'entry',e.value) order by d.key,e.ordinality)
   from jsonb_each(case when jsonb_typeof(s.body->'Історія')='object' then s.body->'Історія' else '{}'::jsonb end) d
   cross join lateral jsonb_array_elements(case when jsonb_typeof(d.value)='array' then d.value else '[]'::jsonb end) with ordinality e(value,ordinality)
   where e.value->>'Акт'=p_act_id::text
  ),'[]'::jsonb) entries from source s
 ) select coalesce(jsonb_agg(to_jsonb(s) order by s.shop_id),'[]'::jsonb) into shops_json from scoped s
 where s.name=any(p_names) or jsonb_array_length(s.entries)>0;
 select coalesce(jsonb_agg(jsonb_build_object('sclad_id',s.sclad_id,'rahunok',s.rahunok,'time_off',s.time_off) order by s.sclad_id),'[]'::jsonb)
 into stock_json from public.sclad s where s.sclad_id in (
  select distinct (d->>'sclad_id')::bigint from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d
  where d->>'sclad_id' ~ '^[1-9][0-9]*$'
 );
 return jsonb_build_object('act_id',a.act_id,'revision',p_revision,'date_on',a.date_on,'date_off',a.date_off,
  'context_checksum',md5(jsonb_build_array(a.date_on,a.date_off,a.client_id,a.cars_id,a.pruimalnyk)::text),
  'clientInfo',coalesce(nullif(client_doc->>'ПІБ',''),nullif(client_doc->>'fio',''),'—'),
  'carInfo',coalesce(nullif(btrim(concat_ws(' ',car_doc->>'Авто',car_doc->>'Рік',car_doc->>'Номер авто')),''),'—'),
  'shops',shops_json,'stock',stock_json);
end $$;

create or replace function public.guarded_write_act_shop_fragments(p_act_id integer,p_revision text,p_context_checksum text,p_lock_owner text,p_shops jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; item jsonb; change jsonb; result jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if doc->>'__act_revision' is distinct from p_revision or
  md5(jsonb_build_array(a.date_on,a.date_off,a.client_id,a.cars_id,a.pruimalnyk)::text) is distinct from p_context_checksum then
  raise exception 'Акт змінився під час синхронізації магазинів' using errcode='40001';end if;
 if jsonb_typeof(p_shops) is distinct from 'array' or jsonb_array_length(p_shops)>1000 then raise exception 'Некоректний пакет магазинів';end if;
 if exists(select 1 from jsonb_array_elements(p_shops) s group by s->>'shop_id' having count(*)>1) then raise exception 'Магазин дублюється у пакеті';end if;
 for item in select value from jsonb_array_elements(p_shops) order by (value->>'shop_id')::bigint loop
  if jsonb_typeof(item->'changes') is distinct from 'array' then raise exception 'Некоректні зміни магазину';end if;
  for change in select value from jsonb_array_elements(item->'changes') loop
   if change->>'act' is distinct from p_act_id::text or
    (nullif(change->'expected','null'::jsonb) is not null and change#>>'{expected,Акт}' is distinct from p_act_id::text) or
    (nullif(change->'desired','null'::jsonb) is not null and change#>>'{desired,Акт}' is distinct from p_act_id::text) then
    raise exception 'Пакет містить історію іншого акта';end if;
  end loop;
  result:=public.write_shop_history_fragments((item->>'shop_id')::bigint,item->'changes');
  if result->>'status' is distinct from 'saved' then raise exception 'Не підтверджено запис історії магазину';end if;
 end loop;
 return jsonb_build_object('act_id',p_act_id,'revision',p_revision,'status','saved');
end $$;

-- Evaluate search predicates on the server, while returning only the list projection.
create or replace function public.traffic_act_row(p_act_id bigint,p_filters jsonb default '[]')
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare raw jsonb; client_row jsonb; car_row jsonb; projected jsonb;
begin
 if jsonb_typeof(p_filters) is distinct from 'array' or jsonb_array_length(p_filters)>50 then raise exception 'Некоректний пошук';end if;
 select to_jsonb(a),to_jsonb(cl),to_jsonb(c) into raw,client_row,car_row from public.acts a
 left join public.clients cl on cl.client_id=a.client_id left join public.cars c on c.cars_id=a.cars_id where a.act_id=p_act_id;
 if raw is null then return null;end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into projected from jsonb_each(raw) where key=any(array[
  'act_id','date_on','date_off','cars_id','client_id','pruimalnyk','slusarsOn','sms','avans','rosraxovano',
  'contrAgent_act','contrAgent_act_data','contrAgent_raxunok','contrAgent_raxunok_data','total','amount']);
 projected:=projected||jsonb_build_object('__sto_projection','act-search-v1','data',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'data'))='object' then public.sto_act_list_data_v1(raw->'data')-'Роботи'-'Деталі' else raw->'data' end);
 if raw ? 'info' then projected:=projected||jsonb_build_object('info',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'info'))='object' then public.sto_act_list_data_v1(raw->'info')-'Роботи'-'Деталі' else raw->'info' end);end if;
 if raw ? 'details' then projected:=projected||jsonb_build_object('details',case when jsonb_typeof(public.sto_act_list_data_v1(raw->'details'))='object' then public.sto_act_list_data_v1(raw->'details')-'Роботи'-'Деталі' else raw->'details' end);end if;
 return jsonb_build_object('act',projected,
  'matches',public.traffic_act_search_match(raw,client_row->'data',car_row->'data',p_filters),
  'clients',case when client_row->>'client_id' is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('client_id',client_row->'client_id','data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(client_row->'data')) where key=any(array['ПІБ','Телефон'])))) end,
  'cars',case when car_row->>'cars_id' is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('cars_id',car_row->'cars_id','data',
   (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.sto_read_object_v1(car_row->'data')) where key=any(array['Номер авто','Держ. номер','plate','number','Авто','Автомобіль','auto','car','name','Марка','brand','make','Модель','model'])))) end);
end $$;

-- Keep the existing editor checksum/delta contract; link mutations share its transaction.
create or replace function public.guarded_patch_act_with_stock(
 p_act_id integer,p_checksum text,p_changes jsonb,p_revision text,p_lock_owner text,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; next_doc jsonb; op jsonb; path text[]; parent jsonb;
 receipt jsonb; before_ids bigint[]; after_ids bigint[]; conflicts jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if a.date_off is not null or doc->>'Заморожений'='true' then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 if md5(jsonb_build_array(doc,a.avans,a.pruimalnyk,a.date_off)::text) is distinct from p_checksum then
  raise exception 'Акт змінився. Відкрийте його повторно.' using errcode='40001';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or nullif(p_revision,'') is null then raise exception 'Некоректний пакет змін';end if;
 next_doc:=doc;
 for op in select value from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(op->'path') is distinct from 'array' then raise exception 'Некоректний шлях зміни';end if;
  if exists(select 1 from jsonb_array_elements(op->'path') p where jsonb_typeof(p)<>'string') then raise exception 'Некоректний шлях зміни';end if;
  select array_agg(value order by ordinality) into path from jsonb_array_elements_text(op->'path') with ordinality;
  if coalesce(cardinality(path),0)=0 or path[1]='__act_revision' then raise exception 'Недозволений шлях зміни';end if;
  parent:=case when cardinality(path)=1 then next_doc else next_doc#>path[1:cardinality(path)-1] end;
  if parent is null or jsonb_typeof(parent) not in ('object','array') then raise exception 'Батьківське поле не існує';end if;
  if jsonb_typeof(parent)='array' and (path[cardinality(path)]!~'^(0|[1-9][0-9]*)$') then raise exception 'Некоректний індекс';end if;
  if op->'remove'='true'::jsonb then
   if jsonb_typeof(parent)='array' then raise exception 'Видалення позиції потребує нового масиву';end if;
   next_doc:=next_doc#-path;
  elsif op?'value' then next_doc:=jsonb_set(next_doc,path,op->'value',true);
  else raise exception 'Відсутнє значення зміни';end if;
 end loop;
 if next_doc=doc and (p_avans is null or a.avans is not distinct from p_avans) then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',coalesce(doc->>'__act_revision',''),'checksum',md5(doc::text),'cars_id',a.cars_id);
 end if;
 select coalesce(array_agg(distinct (d->>'sclad_id')::bigint),'{}'::bigint[]) into before_ids
 from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d where d->>'sclad_id' ~ '^[1-9][0-9]*$';
 select coalesce(array_agg(distinct (d->>'sclad_id')::bigint),'{}'::bigint[]) into after_ids
 from jsonb_array_elements(coalesce(next_doc->'Деталі','[]')) d where d->>'sclad_id' ~ '^[1-9][0-9]*$';
 -- Lock inventory in the same stable order as the quantity writer.
 perform 1 from public.sclad where sclad_id=any(before_ids||after_ids) order by sclad_id for update;
 next_doc:=next_doc||jsonb_build_object('__act_revision',p_revision);
 receipt:=public.guarded_write_act_with_stock_receipt(p_act_id,doc,next_doc,p_lock_owner,p_avans);
 -- Existing scalar foreign links may represent shared stock. Never steal or clear them.
 select coalesce(jsonb_agg(s.sclad_id order by s.sclad_id),'[]'::jsonb) into conflicts from public.sclad s
 where s.sclad_id=any(after_ids) and not(s.sclad_id=any(before_ids)) and nullif(btrim(s.akt::text),'') is not null and s.akt::text<>p_act_id::text;
 update public.sclad set akt=p_act_id where sclad_id=any(after_ids) and not(sclad_id=any(before_ids)) and nullif(btrim(akt::text),'') is null;
 update public.sclad set akt=null where sclad_id=any(before_ids) and not(sclad_id=any(after_ids)) and akt::text=p_act_id::text;
 return receipt||jsonb_build_object('stock_link_conflicts',conflicts);
end $$;

create or replace function public.traffic_act_transition_state(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb;
begin
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,'total',doc->'Загальна сума',
  'frozen',coalesce(doc->'Заморожений'='true'::jsonb,false),'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision',
  'checksum',md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text));
end $$;

create or replace function public.guarded_set_act_frozen(p_act_id integer,p_frozen boolean,p_checksum text,p_revision text,p_lock_owner text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; allocation record; stock_ids jsonb:='[]'::jsonb; frozen boolean; changed boolean;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if p_frozen is null or nullif(p_revision,'') is null then raise exception 'Некоректний стан акту';end if;
 if a.date_off is not null then raise exception 'Закритий акт не можна заморожувати або розморожувати' using errcode='55000';end if;
 if md5(jsonb_build_array(doc,a.date_off,a.pruimalnyk)::text) is distinct from p_checksum then raise exception 'Акт змінився. Повторіть операцію.' using errcode='40001';end if;
 frozen:=coalesce(doc->'Заморожений'='true'::jsonb,false);changed:=frozen is distinct from p_frozen;
 if changed then
  for allocation in
   select (d->>'sclad_id')::bigint sid,sum((d->>'Кількість')::numeric) qty
   from jsonb_array_elements(coalesce(doc->'Деталі','[]')) d
   where d->>'sclad_id' ~ '^[1-9][0-9]*$' and coalesce(nullif(d->>'Кількість','')::numeric,0)>0
   group by (d->>'sclad_id')::bigint order by (d->>'sclad_id')::bigint
  loop
   update public.sclad set kilkist_off=greatest(coalesce(kilkist_off,0)+case when p_frozen then -allocation.qty else allocation.qty end,0)
   where sclad_id=allocation.sid;
   if not found then raise exception 'Складська позиція % недоступна',allocation.sid using errcode='40001';end if;
   stock_ids:=stock_ids||jsonb_build_array(allocation.sid);
  end loop;
  doc:=doc||jsonb_build_object('Заморожений',p_frozen,'__payroll_pending',true,'__act_revision',p_revision);
  update public.acts set data=doc where act_id=p_act_id;
  if doc is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then
   raise exception 'Акт змінений сервером під час зміни стану' using errcode='40001';end if;
 end if;
 return jsonb_build_object('act_id',a.act_id,'date_on',a.date_on,'date_off',a.date_off,'slusarsOn',to_jsonb(a)->'slusarsOn','pruimalnyk',a.pruimalnyk,
  'frozen',p_frozen,'payroll_pending',coalesce(doc->'__payroll_pending'='true'::jsonb,false),'revision',doc->>'__act_revision','status',case when changed then 'updated' else 'unchanged' end,'stock_ids',stock_ids);
end $$;

revoke all on function public.traffic_act_shop_context(integer,text,text[]),public.guarded_write_act_shop_fragments(integer,text,text,text,jsonb),public.traffic_act_row(bigint,jsonb) from public,anon;
grant execute on function public.traffic_act_shop_context(integer,text,text[]),public.guarded_write_act_shop_fragments(integer,text,text,text,jsonb) to authenticated,service_role;
grant execute on function public.traffic_act_row(bigint,jsonb) to authenticated,anon;
revoke all on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) from public,anon;
grant execute on function public.traffic_act_transition_state(integer),public.guarded_set_act_frozen(integer,boolean,text,text,text) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
