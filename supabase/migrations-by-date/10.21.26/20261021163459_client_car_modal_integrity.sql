-- Client/car form: compact records, atomic delta writes, VIN restore and soft delete.
-- Existing package 8 is required. Existing caller permissions and RLS remain in force.
begin;

create or replace function public.traffic_client_car_vin(p_value text)
returns text language sql immutable security invoker set search_path=pg_catalog,public as $$
 select upper(regexp_replace(coalesce(p_value,''),'[[:space:]]','','g'));
$$;

create or replace function public.traffic_client_car_projection(p_kind text,p_data jsonb)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
 from jsonb_each(public.sto_read_object_v1(p_data))
 where key=any(case p_kind when 'client' then array['ПІБ','Телефон','Джерело','Додаткові']
 when 'car' then array['Авто','Номер авто','Обʼєм','Пальне','Vincode','VIN','Рік','КодДВЗ','Код ДВЗ'] else array[]::text[] end)
 or (p_kind='client' and key ilike '%телефон%' and jsonb_typeof(value)='string');
$$;

create or replace function public.traffic_client_car_record(p_kind text,p_id bigint)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 if p_kind='client_car' then
  result:=jsonb_build_object('client',public.traffic_client_car_record('client',p_id),
   'car',(select jsonb_build_object('cars_id',cars_id::text,'client_id',client_id::text,'is_deleted',false,
    'data',public.traffic_client_car_projection('car',data)) from public.cars where client_id=p_id and is_deleted is not true order by cars_id limit 1));
 elsif p_kind='client' then
  select jsonb_build_object('client_id',client_id::text,'data',public.traffic_client_car_projection('client',data)) into result
  from public.clients where client_id=p_id;
 elsif p_kind='car' then
  select jsonb_build_object('cars_id',cars_id::text,'client_id',client_id::text,'is_deleted',is_deleted is true,
   'data',public.traffic_client_car_projection('car',data)) into result from public.cars where cars_id=p_id;
 else raise exception 'Unsupported client/car record';end if;
 if result is null then raise exception 'Запис не знайдено або немає доступу. Повторіть вибір.';end if;
 return result;
end $$;

-- A non-unique index supports legacy databases with duplicate VINs. Ambiguous
-- records are rejected, never silently merged or removed by this migration.
create index if not exists cars_form_vin_idx on public.cars
 (public.traffic_client_car_vin(coalesce(nullif(public.sto_read_object_v1(data)->>'Vincode',''),public.sto_read_object_v1(data)->>'VIN')));
create index if not exists cars_form_request_idx on public.cars ((data->>'__client_car_request_id'))
 where data ? '__client_car_request_id';
create index if not exists clients_form_name_idx on public.clients ((lower(btrim(public.sto_read_object_v1(data)->>'ПІБ'))));

create or replace function public.traffic_client_car_save(p_request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare
 op text:=p_request->>'operation'; cid bigint:=nullif(p_request->>'client_id','')::bigint;
 carid bigint:=nullif(p_request->>'cars_id','')::bigint; original_carid bigint:=carid;
 cp jsonb:=coalesce(p_request->'client_patch','{}'); vp jsonb:=coalesce(p_request->'car_patch','{}');
 ce jsonb:=coalesce(p_request->'client_expected','{}'); ve jsonb:=coalesce(p_request->'car_expected','{}');
 cd jsonb; vd jsonb; merged jsonb; owner_id bigint; deleted boolean; ids bigint[]; field text;
  vin text; token text:=p_request->>'request_id'; affected bigint; old_owner bigint; alias_key text;
 client_created boolean:=false; car_created boolean:=false; restored boolean:=false;
 client_changed boolean:=false; car_changed boolean:=false;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or op is null or op not in ('add','edit','delete') then raise exception 'Invalid client/car operation';end if;
 if jsonb_typeof(cp) is distinct from 'object' or jsonb_typeof(vp) is distinct from 'object'
  or jsonb_typeof(ce) is distinct from 'object' or jsonb_typeof(ve) is distinct from 'object' then raise exception 'Invalid field patch';end if;
 for field in select jsonb_object_keys(cp) loop
  if field<>all(array['ПІБ','Телефон','Джерело','Додаткові']) or jsonb_typeof(cp->field) not in ('string','number','null') then raise exception 'Invalid client field %',field;end if;
 end loop;
 for field in select jsonb_object_keys(vp) loop
  if field<>all(array['Авто','Номер авто','Обʼєм','Пальне','Vincode','Рік','КодДВЗ']) or jsonb_typeof(vp->field) not in ('string','number','null') then raise exception 'Invalid car field %',field;end if;
 end loop;
 -- Serializes this short write path, including retry tokens and VIN reassignment.
 perform pg_advisory_xact_lock(1937010547,1);
 if op='add' then
  if token is null or token !~ '^[a-zA-Z0-9_-]{16,100}$' then raise exception 'Missing save request ID';end if;
  select array_agg(cars_id::bigint) into ids from public.cars where data ? '__client_car_request_id' and data->>'__client_car_request_id'=token;
  if cardinality(ids)>1 then raise exception 'Неоднозначне повторне збереження. Оновіть запис.';end if;
  if cardinality(ids)=1 then
   carid:=ids[1];select client_id,is_deleted into owner_id,deleted from public.cars where cars_id=carid;
   if deleted is true or (cid is not null and cid<>owner_id) then raise exception 'Автомобіль уже змінено. Повторіть вибір.';end if;
   return jsonb_build_object('client_id',owner_id::text,'cars_id',carid::text,'saved',true,'replayed',true,
    'client_changed',false,'car_changed',false,'client_created',false,'car_created',false,'car_restored',false,
    'client',public.traffic_client_car_record('client',owner_id),'car',public.traffic_client_car_record('car',carid));
  end if;
 end if;
 if cid is null then
  if op<>'add' then raise exception 'Оберіть клієнта.';end if;
  if nullif(btrim(cp->>'ПІБ'),'') is null or nullif(btrim(cp->>'Телефон'),'') is null then raise exception 'Заповніть ПІБ і телефон клієнта.';end if;
  select array_agg(client_id) into ids from public.clients
   where lower(btrim(public.sto_read_object_v1(data)->>'ПІБ'))=lower(btrim(cp->>'ПІБ'));
  if cardinality(ids)>0 then
   -- Do not choose one of two people with the same name from list ordering.
   select array_agg(c.client_id) into ids from public.clients c where c.client_id=any(ids)
    and exists(select 1 from regexp_split_to_table(coalesce(public.sto_read_object_v1(c.data)->>'Телефон',''),'[,;]') p
     where regexp_replace(p,'[^0-9]','','g')=regexp_replace(cp->>'Телефон','[^0-9]','','g'));
   if cardinality(ids)=1 then cid:=ids[1];cp:='{}';
   else raise exception 'Клієнт із таким ПІБ уже існує. Оберіть потрібного зі списку.';end if;
  else
   insert into public.clients(data) values(cp) returning client_id into cid;
   if cid is null then raise exception 'База не підтвердила створення клієнта.';end if;
   client_created:=true;client_changed:=true;
  end if;
 end if;
 select public.sto_read_object_v1(data) into cd from public.clients where client_id=cid for update;
 if cd is null then raise exception 'Клієнт недоступний. Повторіть вибір.';end if;
 if op<>'delete' then
  if not client_created then
   for field in select jsonb_object_keys(cp) loop
    if coalesce(cd->field,'null') is distinct from coalesce(ce->field,'null') and coalesce(cd->field,'null') is distinct from cp->field then
     raise exception 'Поле клієнта % змінено іншим користувачем. Повторіть вибір.',field;
    end if;
   end loop;
   merged:=cd||cp;
   if nullif(btrim(merged->>'ПІБ'),'') is null then raise exception 'Заповніть ПІБ клієнта.';end if;
   if merged is distinct from cd then
    update public.clients set data=merged where client_id=cid;get diagnostics affected=row_count;
    if affected<>1 then raise exception 'База не підтвердила зміну клієнта.' using errcode='42501';end if;
    client_changed:=true;
   end if;
  end if;
 end if;
 if op='add' then
  if nullif(btrim(vp->>'Авто'),'') is null then raise exception 'Заповніть автомобіль.';end if;
  vin:=public.traffic_client_car_vin(vp->>'Vincode');
  if vin<>'' then
   select array_agg(cars_id::bigint order by cars_id) into ids from public.cars
   where public.traffic_client_car_vin(coalesce(nullif(public.sto_read_object_v1(data)->>'Vincode',''),public.sto_read_object_v1(data)->>'VIN'))=vin;
  else ids:=null;end if;
  if cardinality(ids)>1 then raise exception 'Знайдено кілька автомобілів із цим VIN. Потрібно перевірити дублікати; історію не змінено.';end if;
  if cardinality(ids)=1 then
   carid:=ids[1];
   select public.sto_read_object_v1(data),client_id,is_deleted into vd,owner_id,deleted from public.cars where cars_id=carid for update;
   if vd is null or public.traffic_client_car_vin(coalesce(nullif(vd->>'Vincode',''),vd->>'VIN')) is distinct from vin then
    raise exception 'VIN автомобіля змінено іншим користувачем. Повторіть вибір.';
   end if;
   if deleted is not true then raise exception 'Автомобіль із цим VIN уже активний. Оберіть його; для зміни власника спочатку приховайте авто у попереднього.';end if;
   if original_carid is not null and original_carid<>carid then raise exception 'Вибраний автомобіль не відповідає VIN. Повторіть вибір.';end if;
   if original_carid is not null then
    for field in select jsonb_object_keys(vp) loop
     if coalesce(vd->field,'null') is distinct from coalesce(ve->field,'null') and coalesce(vd->field,'null') is distinct from vp->field then
      raise exception 'Поле автомобіля % змінено іншим користувачем. Повторіть вибір.',field;
     end if;
     alias_key:=case field when 'Vincode' then 'VIN' when 'КодДВЗ' then 'Код ДВЗ' else null end;
     if alias_key is not null and coalesce(vd->alias_key,'null') is distinct from coalesce(ve->alias_key,'null')
      and coalesce(vd->alias_key,'null') is distinct from vp->field then
      raise exception 'Поле автомобіля % змінено іншим користувачем. Повторіть вибір.',alias_key;
     end if;
    end loop;
   end if;
   old_owner:=owner_id;
   merged:=vd||vp;
   if vp ? 'Vincode' and vd ? 'VIN' then merged:=merged||jsonb_build_object('VIN',vp->'Vincode');end if;
   if vp ? 'КодДВЗ' and vd ? 'Код ДВЗ' then merged:=merged||jsonb_build_object('Код ДВЗ',vp->'КодДВЗ');end if;
   update public.cars set client_id=cid,is_deleted=false,data=merged||jsonb_build_object('__client_car_request_id',token) where cars_id=carid;
   get diagnostics affected=row_count;if affected<>1 then raise exception 'База не підтвердила відновлення авто.' using errcode='42501';end if;
   restored:=true;car_changed:=true;
  else
   if original_carid is not null then raise exception 'VIN вибраного автомобіля змінився. Повторіть вибір.';end if;
   insert into public.cars(client_id,is_deleted,data) values(cid,false,vp||jsonb_build_object('__client_car_request_id',token)) returning cars_id into carid;
   if carid is null then raise exception 'База не підтвердила створення авто.';end if;
   car_created:=true;car_changed:=true;
  end if;
 elsif carid is not null then
  select public.sto_read_object_v1(data),client_id,is_deleted into vd,owner_id,deleted from public.cars where cars_id=carid for update;
  if vd is null or owner_id is distinct from cid then raise exception 'Автомобіль уже належить іншому клієнту або недоступний. Повторіть вибір.';end if;
  if op='delete' then
   if deleted is not true then
    for field in select jsonb_object_keys(public.traffic_client_car_projection('car',vd)) loop
     if coalesce(vd->field,'null') is distinct from coalesce(ve->field,'null') then raise exception 'Дані автомобіля змінено. Повторіть вибір перед видаленням.';end if;
    end loop;
    update public.cars set is_deleted=true where cars_id=carid;get diagnostics affected=row_count;
    if affected<>1 then raise exception 'База не підтвердила приховування авто.' using errcode='42501';end if;
    car_changed:=true;
   end if;
  else
   if deleted is true then raise exception 'Автомобіль приховано. Відновіть його через «Додати» за VIN.';end if;
   for field in select jsonb_object_keys(vp) loop
    if coalesce(vd->field,'null') is distinct from coalesce(ve->field,'null') and coalesce(vd->field,'null') is distinct from vp->field then
     raise exception 'Поле автомобіля % змінено іншим користувачем. Повторіть вибір.',field;
    end if;
    alias_key:=case field when 'Vincode' then 'VIN' when 'КодДВЗ' then 'Код ДВЗ' else null end;
    if alias_key is not null and coalesce(vd->alias_key,'null') is distinct from coalesce(ve->alias_key,'null')
     and coalesce(vd->alias_key,'null') is distinct from vp->field then
     raise exception 'Поле автомобіля % змінено іншим користувачем. Повторіть вибір.',alias_key;
    end if;
   end loop;
   merged:=vd||vp;
   -- Keep aliases coherent when a legacy record is edited, including clearing
   -- a value. An old alias must not resurrect a deliberately removed VIN/code.
   if vp ? 'Vincode' and vd ? 'VIN' then merged:=merged||jsonb_build_object('VIN',vp->'Vincode');end if;
   if vp ? 'КодДВЗ' and vd ? 'Код ДВЗ' then merged:=merged||jsonb_build_object('Код ДВЗ',vp->'КодДВЗ');end if;
   if nullif(btrim(merged->>'Авто'),'') is null then raise exception 'Заповніть автомобіль.';end if;
   if vp ? 'Vincode' then
    vin:=public.traffic_client_car_vin(vp->>'Vincode');
    if vin<>'' and exists(select 1 from public.cars where cars_id<>carid and
     public.traffic_client_car_vin(coalesce(nullif(public.sto_read_object_v1(data)->>'Vincode',''),public.sto_read_object_v1(data)->>'VIN'))=vin) then
     raise exception 'VIN уже належить іншому автомобілю. Історію не змінено.';
    end if;
   end if;
   if merged is distinct from vd then
    update public.cars set data=merged where cars_id=carid;get diagnostics affected=row_count;
    if affected<>1 then raise exception 'База не підтвердила зміну авто.' using errcode='42501';end if;
    car_changed:=true;
   end if;
  end if;
 elsif op='delete' or vp<>'{}' then raise exception 'Оберіть автомобіль.';
 end if;
 return jsonb_build_object('client_id',cid::text,'cars_id',carid::text,'saved',true,'client_created',client_created,
  'car_created',car_created,'car_restored',restored,'client_changed',client_changed,'car_changed',car_changed,'previous_client_id',old_owner::text,
  'client',public.traffic_client_car_record('client',cid),'car',case when carid is not null then public.traffic_client_car_record('car',carid) else null end);
end $$;

-- Add one exact VIN lookup for restoring a hidden vehicle. All existing bounded
-- client/scalar options keep their prior implementation and signatures.
create or replace function public.traffic_client_car_vin_option(p_query text,p_after bigint default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
  select cars_id as id,client_id,is_deleted,public.traffic_client_car_projection('car',data) d from public.cars
  where public.traffic_client_car_vin(p_query)<>'' and (p_after is null or cars_id>p_after)
   and public.traffic_client_car_vin(coalesce(nullif(public.sto_read_object_v1(data)->>'Vincode',''),public.sto_read_object_v1(data)->>'VIN'))=public.traffic_client_car_vin(p_query)
  order by cars_id limit 21
 ), visible as(select * from page order by id limit 20)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',id::text,'client_id',client_id::text,
  'is_deleted',is_deleted is true,'label',coalesce(nullif(d->>'Vincode',''),d->>'VIN'),'Авто',d->>'Авто','Номер авто',d->>'Номер авто') order by id) from visible),'[]'),
  'has_more',(select count(*)>20 from page),'next_cursor',(select max(id) from visible));
$$;

create index if not exists acts_form_request_idx on public.acts ((data->>'__client_car_request_id')) where data ? '__client_car_request_id';
create or replace function public.traffic_client_car_create_act(p_request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare cid bigint:=(p_request->>'client_id')::bigint; carid bigint:=(p_request->>'cars_id')::bigint;
 token text:=p_request->>'request_id'; id bigint; old_client bigint; old_car bigint; owner_id bigint; deleted boolean; payload jsonb;
begin
 if token is null or token !~ '^[a-zA-Z0-9_-]{16,100}$' or cid is null or carid is null then raise exception 'Оберіть клієнта та автомобіль.';end if;
 perform pg_advisory_xact_lock(1937010547,1);
 select act_id,client_id,cars_id into id,old_client,old_car from public.acts where data ? '__client_car_request_id' and data->>'__client_car_request_id'=token;
 if id is not null then
  if old_client<>cid or old_car<>carid then raise exception 'Повторний запит стосується іншого авто.';end if;
  return jsonb_build_object('act_id',id,'replayed',true);
 end if;
 perform 1 from public.clients where client_id=cid for key share;
 if not found then raise exception 'Клієнт недоступний.';end if;
 select client_id,is_deleted into owner_id,deleted from public.cars where cars_id=carid for share;
 if not found or owner_id is distinct from cid or deleted is true then raise exception 'Автомобіль приховано або власника змінено. Повторіть вибір.';end if;
 payload:=jsonb_build_object('Деталі',jsonb_build_array(jsonb_build_object('Сума',0,'Ціна',0,'Деталь','','Магазин','','Кількість',0)),
  'Роботи',jsonb_build_array(jsonb_build_object('Сума',0,'Ціна',0,'Робота','','Слюсар','','Кількість',0)),
  'Пробіг',0,'За деталі',0,'За роботу',0,'Приймальник','','Рекомендації','','Примітки','','Загальна сума',0,
  'Причина звернення',coalesce(p_request->>'reason',''),'Прибуток за деталі',0,'Прибуток за роботу',0,'__client_car_request_id',token);
 insert into public.acts(date_on,client_id,cars_id,data,avans,pruimalnyk)
 values(coalesce(nullif(p_request->>'date_on','')::timestamp,localtimestamp),cid,carid,payload,0,nullif(p_request->>'pruimalnyk','')) returning act_id into id;
 if id is null then raise exception 'База не підтвердила створення акта.';end if;
 return jsonb_build_object('act_id',id,'replayed',false);
end $$;

revoke all on function public.traffic_client_car_vin(text),public.traffic_client_car_projection(text,jsonb),
 public.traffic_client_car_record(text,bigint),public.traffic_client_car_save(jsonb),public.traffic_client_car_vin_option(text,bigint),public.traffic_client_car_create_act(jsonb) from public;
grant execute on function public.traffic_client_car_vin(text),public.traffic_client_car_projection(text,jsonb),
 public.traffic_client_car_record(text,bigint),public.traffic_client_car_save(jsonb),public.traffic_client_car_vin_option(text,bigint),public.traffic_client_car_create_act(jsonb) to anon,authenticated;
notify pgrst,'reload schema';
commit;
