-- Complete work directory repair: create, edit and delete.
-- Uses existing tables and the installed traffic_directory_page read function.
-- Installing this script creates no tables or columns and changes no records.
begin;

create or replace function public.traffic_directory_rename_reference(p_data jsonb,p_name text)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare document jsonb:=p_data; serialized boolean:=false; content text; field text;
begin
 if p_data is null or p_data='null'::jsonb then return to_jsonb(p_name);end if;
 if jsonb_typeof(document)='string' then
  content:=btrim(document#>>'{}');
  if left(content,1) not in ('{','[') then return to_jsonb(p_name);end if;
  begin document:=content::jsonb;exception when invalid_text_representation then return to_jsonb(p_name);end;
  serialized:=true;
 end if;
 if jsonb_typeof(document) is distinct from 'object' then raise exception 'Непідтримуваний формат назви довідника. Дані залишено без змін.';end if;
 foreach field in array array['Name','name','Назва','Текст','text','ПІБ'] loop
  if jsonb_typeof(document->field) in ('string','number') and nullif(btrim(document->>field),'') is not null then
   document:=jsonb_set(document,array[field],to_jsonb(p_name),false);
   return case when serialized then to_jsonb(document::text) else document end;
  end if;
 end loop;
 raise exception 'Не знайдено поле назви довідника. Дані залишено без змін.';
end $$;

create or replace function public.traffic_directory_write(p_kind text,p_id bigint,p_patch jsonb,p_expected jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare id_col text; allowed text[]; old jsonb; merged jsonb; name text; matches bigint[]; next_id bigint; value_type text; result jsonb; field text; payload text; name_expr text; affected bigint; plain boolean; original_data jsonb; renamed_data jsonb; outcome text:='updated';
begin
 id_col:=case p_kind when 'slyusars' then 'slyusar_id' when 'incomes' then 'income_id' when 'receivers' then 'receiver_id' when 'shops' then 'shop_id' when 'works' then 'work_id' when 'details' then 'detail_id' end;
 if id_col is null or jsonb_typeof(p_patch) is distinct from 'object' or (p_id is not null and p_id<=0) then raise exception 'Invalid directory patch';end if;
 plain:=p_kind in ('works','details');
 allowed:=case when plain then array['data'] when p_kind='slyusars' then array['Name','Пароль','Доступ','ПроцентРоботи','ПроцентЗапчастин','Склад'] else array['Name'] end;
 if exists(select 1 from jsonb_object_keys(p_patch) k where not k=any(allowed)) then raise exception 'Only directory metadata may change';end if;
 for field in select jsonb_object_keys(p_patch) loop
  if field in ('Name','data','Доступ','Пароль') and jsonb_typeof(p_patch->field) is distinct from 'string' then raise exception 'Некоректне текстове поле %',field;end if;
  if field in ('ПроцентРоботи','ПроцентЗапчастин','Склад') then
   if jsonb_typeof(p_patch->field) is distinct from 'number' then raise exception 'Некоректне числове поле %',field;end if;
   if (p_patch->>field)::numeric<0 or (field<>'Склад' and (p_patch->>field)::numeric>100) or (field='Склад' and trunc((p_patch->>field)::numeric)<>(p_patch->>field)::numeric) then raise exception 'Некоректне значення поля %',field;end if;
  end if;
 end loop;
 if p_kind in ('shops','details') then perform pg_advisory_xact_lock(1937010546,1);end if;
 perform pg_advisory_xact_lock(hashtext('traffic-directory:'||p_kind));
 if p_id is null then execute format('lock table public.%I in share row exclusive mode',p_kind);
 else
  if plain then
   execute format('select jsonb_build_object(''data'',public.traffic_reference_name(to_jsonb(data))),to_jsonb(data) from public.%I where %I=$1 for update',p_kind,id_col) into old,original_data using p_id;
  else execute format('select public.sto_read_object_v1(to_jsonb(data)) from public.%I where %I=$1 for update',p_kind,id_col) into old using p_id;end if;
  if old is null then raise exception 'Запис не знайдено або немає доступу. Оновіть список.';end if;
  if jsonb_typeof(p_expected) is distinct from 'object' then raise exception 'Directory baseline required';end if;
  if p_kind='slyusars' and p_id=1 then p_patch:=p_patch-'Name'-'Доступ';end if;
  for field in select jsonb_object_keys(p_patch) loop
   if old->field is distinct from p_expected->field and old->field is distinct from p_patch->field then raise exception 'Поле % змінено іншим користувачем. Оновіть дані.',field;end if;
  end loop;
 end if;
 merged:=coalesce(old,case when p_kind='slyusars' then '{"Опис":{},"Історія":{}}'::jsonb when p_kind='shops' then '{"Склад":{},"Історія":{},"Про магазин":""}'::jsonb else '{}'::jsonb end)||p_patch;
 field:=case when plain then 'data' else 'Name' end;
 name:=public.traffic_directory_name(merged->>field);if name='' then raise exception 'Назва обов’язкова';end if;
 name_expr:=case when plain then 'public.traffic_reference_name(to_jsonb(data))' else 'public.sto_read_object_v1(to_jsonb(data))->>''Name''' end;
 if p_id is null or name is distinct from public.traffic_directory_name(old->>field) then
  execute format('select array_agg(%I order by %I) from public.%I where public.traffic_directory_name(%s)=$1 and ($2 is null or %I<>$2)',id_col,id_col,p_kind,name_expr,id_col) into matches using name,p_id;
 end if;
 if coalesce(cardinality(matches),0)>1 then raise exception 'Неоднозначна назва: декілька історичних записів. Виберіть ID.';end if;
 if coalesce(cardinality(matches),0)=1 then
  if p_id is not null then raise exception 'Запис із такою назвою вже існує';end if;
  result:=public.traffic_directory_page(p_kind,'',0,false,matches[1]);return jsonb_build_object('status','existing','row',result->'items'->0);
 end if;
 if old is not null and merged=old then
  result:=public.traffic_directory_page(p_kind,'',0,false,p_id);return jsonb_build_object('status','unchanged','row',result->'items'->0);
 end if;
 select format_type(a.atttypid,a.atttypmod) into value_type from pg_attribute a where a.attrelid=format('public.%I',p_kind)::regclass and a.attname='data';
 if plain then
  renamed_data:=public.traffic_directory_rename_reference(original_data,merged->>'data');
  payload:=case when value_type in ('json','jsonb') or jsonb_typeof(renamed_data)<>'string' then renamed_data::text else renamed_data#>>'{}' end;
 else payload:=merged::text;end if;
 if p_id is null then
  execute format('select coalesce(max(%I),0)+1 from public.%I',id_col,p_kind) into next_id;
  execute format('insert into public.%I(%I,data) values($1,$2::%s)',p_kind,id_col,value_type) using next_id,payload;
  get diagnostics affected=row_count;p_id:=next_id;outcome:='created';
 else
  execute format('update public.%I set data=$1::%s where %I=$2',p_kind,value_type,id_col) using payload,p_id;
  get diagnostics affected=row_count;
 end if;
 if affected<>1 then raise exception 'База не підтвердила збереження. Перевірте доступ або оновіть запис.' using errcode='42501';end if;
 result:=public.traffic_directory_page(p_kind,'',0,false,p_id);
 if result->'items'->0 is null then raise exception 'Не отримано збережений запис';end if;
 return jsonb_build_object('status',outcome,'row',result->'items'->0);
end $$;

create or replace function public.traffic_directory_has_history(v jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare child jsonb; parsed jsonb;
begin
 if v is null or v in ('null'::jsonb,'{}'::jsonb,'[]'::jsonb,'""'::jsonb) then return false;end if;
 if jsonb_typeof(v)='object' then
  for child in select value from jsonb_each(v) loop if public.traffic_directory_has_history(child) then return true;end if;end loop;return false;
 elsif jsonb_typeof(v)='array' then
  for child in select value from jsonb_array_elements(v) loop if public.traffic_directory_has_history(child) then return true;end if;end loop;return false;
 elsif jsonb_typeof(v)='string' then
  if btrim(v#>>'{}')='' then return false;end if;
  begin parsed:=(v#>>'{}')::jsonb;exception when others then return true;end;
  return public.traffic_directory_has_history(parsed);
 end if;
 return true;
end $$;

create or replace function public.traffic_directory_delete(p_kind text,p_id bigint,p_expected jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare id_col text; old jsonb; field text; affected bigint;
begin
 id_col:=case p_kind when 'slyusars' then 'slyusar_id' when 'incomes' then 'income_id' when 'receivers' then 'receiver_id' when 'shops' then 'shop_id' when 'works' then 'work_id' when 'details' then 'detail_id' when 'faktura' then 'faktura_id' end;
 if id_col is null or p_id is null or p_id<=0 or jsonb_typeof(p_expected) is distinct from 'object' or p_expected='{}'::jsonb then raise exception 'Виберіть запис для видалення зі списку.';end if;
 if p_kind='slyusars' and p_id=1 then raise exception 'Видалення адміністраторського акаунту заборонено!';end if;
 if p_kind in ('shops','details') then perform pg_advisory_xact_lock(1937010546,1);end if;
 perform pg_advisory_xact_lock(hashtext('traffic-directory:'||p_kind));
 if p_kind='faktura' then select to_jsonb(f) into old from public.faktura f where faktura_id=p_id for update;
 elsif p_kind in ('works','details') then execute format('select jsonb_build_object(''data'',public.traffic_reference_name(to_jsonb(data))) from public.%I where %I=$1 for update',p_kind,id_col) into old using p_id;
 else execute format('select public.sto_read_object_v1(to_jsonb(data)) from public.%I where %I=$1 for update',p_kind,id_col) into old using p_id;end if;
 if old is null then raise exception 'Запис уже видалено або немає доступу. Оновіть список.';end if;
 if (p_kind in ('works','details') and not (p_expected ? 'data')) or (p_kind not in ('works','details','faktura') and not (p_expected ? 'Name')) or (p_kind='faktura' and not (p_expected ? 'name')) then raise exception 'Немає вихідних даних запису. Виберіть його повторно.';end if;
 for field in select jsonb_object_keys(p_expected) loop
  if old->field is distinct from p_expected->field then raise exception 'Запис змінився після вибору. Оновіть його перед видаленням.';end if;
 end loop;
 if p_kind in ('slyusars','shops') and (public.traffic_directory_has_history(old->'Історія') or (p_kind='shops' and public.traffic_directory_has_history(old->'Склад'))) then
  raise exception 'Запис має історію або складські дані. Його видалення знищить ці дані та заблоковане.';
 end if;
 execute format('delete from public.%I where %I=$1',p_kind,id_col) using p_id;
 get diagnostics affected=row_count;
 if affected<>1 then raise exception 'База не підтвердила видалення. Перевірте права доступу.' using errcode='42501';end if;
 return jsonb_build_object('status','deleted','id',p_id);
end $$;

revoke all on function public.traffic_directory_rename_reference(jsonb,text), public.traffic_directory_write(text,bigint,jsonb,jsonb), public.traffic_directory_has_history(jsonb), public.traffic_directory_delete(text,bigint,jsonb) from public;
grant execute on function public.traffic_directory_rename_reference(jsonb,text), public.traffic_directory_write(text,bigint,jsonb,jsonb), public.traffic_directory_has_history(jsonb), public.traffic_directory_delete(text,bigint,jsonb) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
