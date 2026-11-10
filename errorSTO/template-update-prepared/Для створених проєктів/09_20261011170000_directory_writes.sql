-- Requires 20261011140000_traffic_directories.sql. Existing tables only.
begin;
-- Whitelisted metadata only: the current history/password triggers remain intact.
create or replace function public.traffic_directory_write(p_kind text,p_id bigint,p_patch jsonb,p_expected jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare id_col text; allowed text[]; old jsonb; merged jsonb; name text; matches bigint[]; next_id bigint; value_type text; result jsonb; field text;
begin
 id_col:=case p_kind when 'slyusars' then 'slyusar_id' when 'incomes' then 'income_id' when 'receivers' then 'receiver_id' end;
 if id_col is null or jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid directory patch';end if;
 allowed:=case when p_kind='slyusars' then array['Name','Пароль','Доступ','ПроцентРоботи','ПроцентЗапчастин','Склад'] else array['Name'] end;
 if exists(select 1 from jsonb_object_keys(p_patch) k where not k=any(allowed)) then raise exception 'Only directory metadata may change';end if;
 perform pg_advisory_xact_lock(hashtext('traffic-directory:'||p_kind));
 if p_id is null then execute format('lock table public.%I in share row exclusive mode',p_kind);
 else
  execute format('select public.sto_read_object_v1(to_jsonb(data)) from public.%I where %I=$1 for update',p_kind,id_col) into old using p_id;
  if old is null then raise exception 'Directory record not found';end if;
  if p_expected is null then raise exception 'Directory baseline required';end if;
  for field in select jsonb_object_keys(p_patch) loop
   if old->field is distinct from p_expected->field and old->field is distinct from p_patch->field then raise exception 'Поле % змінено іншим користувачем. Оновіть дані.',field;end if;
  end loop;
 end if;
 if p_kind='slyusars' and p_id=1 then p_patch:=p_patch-'Name'-'Доступ';end if;
 merged:=coalesce(old,case when p_kind='slyusars' then '{"Опис":{},"Історія":{}}'::jsonb else '{}'::jsonb end)||p_patch;
 name:=public.traffic_directory_name(merged->>'Name');if name='' then raise exception 'Назва обов’язкова';end if;
 if p_id is null or name is distinct from public.traffic_directory_name(old->>'Name') then
  execute format('select array_agg(%I order by %I) from public.%I where public.traffic_directory_name(public.sto_read_object_v1(to_jsonb(data))->>''Name'')=$1 and ($2 is null or %I<>$2)',id_col,id_col,p_kind,id_col) into matches using name,p_id;
 end if;
 if coalesce(cardinality(matches),0)>1 then raise exception 'Неоднозначна назва: декілька історичних записів. Виберіть ID.';end if;
 if coalesce(cardinality(matches),0)=1 then
  if p_id is not null then raise exception 'Запис із такою назвою вже існує';end if;
  result:=public.traffic_directory_page(p_kind,'',0,false,matches[1]);return jsonb_build_object('status','existing','row',result->'items'->0);
 end if;
 select format_type(a.atttypid,a.atttypmod) into value_type from pg_attribute a where a.attrelid=format('public.%I',p_kind)::regclass and a.attname='data';
 if p_id is null then
  execute format('select coalesce(max(%I),0)+1 from public.%I',id_col,p_kind) into next_id;
  execute format('insert into public.%I(%I,data) values($1,$2::%s)',p_kind,id_col,value_type) using next_id,merged::text;p_id:=next_id;
 else execute format('update public.%I set data=$1::%s where %I=$2',p_kind,value_type,id_col) using merged::text,p_id;
 end if;
 result:=public.traffic_directory_page(p_kind,'',0,false,p_id);
 return jsonb_build_object('status',case when next_id is null then 'updated' else 'created' end,'row',result->'items'->0);
end $$;
create or replace function public.traffic_contragent_write(p_id bigint,p_patch jsonb,p_expected jsonb default null)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare old jsonb; merged jsonb; iban text; n integer; next_id bigint; field text; result jsonb;
begin
 if jsonb_typeof(p_patch) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('name','oderjyvach','prumitka','data','namber')) then raise exception 'Invalid counterparty patch';end if;
 perform pg_advisory_xact_lock(hashtext('traffic-directory:faktura'));
 if p_id is null then lock table public.faktura in share row exclusive mode;
 else
  select to_jsonb(f) into old from public.faktura f where faktura_id=p_id for update;
  if old is null or p_expected is null then raise exception 'Оновіть контрагента перед редагуванням';end if;
  for field in select jsonb_object_keys(p_patch) loop
   if old->field is distinct from p_expected->field and old->field is distinct from p_patch->field then raise exception 'Контрагент змінений іншим користувачем. Оновіть дані.';end if;
  end loop;
 end if;
 merged:=coalesce(old,'{}'::jsonb)||p_patch;
 if public.traffic_directory_name(merged->>'name')='' then raise exception 'Назва обов’язкова';end if;
 iban:=substring(regexp_replace(upper(coalesce(merged->>'prumitka','')),'[[:space:]]','','g') from 'UA[0-9]{27}');
 -- An entity can have several bank accounts. Compare IBAN when available;
 -- without one, compare the complete normalized name/recipient pair.
 select count(*) into n from public.faktura f where (p_id is null or f.faktura_id<>p_id) and
  case when iban is not null then substring(regexp_replace(upper(coalesce(f.prumitka,'')),'[[:space:]]','','g') from 'UA[0-9]{27}')=iban
   else public.traffic_directory_name(f.name)=public.traffic_directory_name(merged->>'name') and public.traffic_directory_name(f.oderjyvach)=public.traffic_directory_name(merged->>'oderjyvach') end;
 if n>0 and (p_id is null or public.traffic_directory_name(old->>'name') is distinct from public.traffic_directory_name(merged->>'name')
  or public.traffic_directory_name(old->>'oderjyvach') is distinct from public.traffic_directory_name(merged->>'oderjyvach')
  or substring(regexp_replace(upper(coalesce(old->>'prumitka','')),'[[:space:]]','','g') from 'UA[0-9]{27}') is distinct from iban)
 then raise exception 'Контрагент з такими реквізитами вже існує (% записів). Виберіть потрібний ID.',n;end if;
 if p_id is null then
  select coalesce(max(faktura_id),0)+1 into next_id from public.faktura;
  merged:=merged||jsonb_build_object('faktura_id',next_id);
  insert into public.faktura(faktura_id,name,oderjyvach,prumitka,data,namber)
   select f.faktura_id,f.name,f.oderjyvach,f.prumitka,f.data,f.namber from jsonb_populate_record(null::public.faktura,merged) f;
  p_id:=next_id;
 else
  update public.faktura t set name=f.name,oderjyvach=f.oderjyvach,prumitka=f.prumitka,data=f.data,namber=f.namber from jsonb_populate_record(null::public.faktura,merged) f where t.faktura_id=p_id;
 end if;
 select to_jsonb(f) into result from public.faktura f where faktura_id=p_id;
 return result;
end $$;
revoke all on function public.traffic_contragent_write(bigint,jsonb,jsonb) from public;
grant execute on function public.traffic_contragent_write(bigint,jsonb,jsonb) to anon,authenticated;
revoke all on function public.traffic_directory_write(text,bigint,jsonb,jsonb) from public;
grant execute on function public.traffic_directory_write(text,bigint,jsonb,jsonb) to anon,authenticated;
commit;
