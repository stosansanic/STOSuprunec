-- Delta transport for the act editor. Requires act_save_receipts and its dependencies.
begin;
create or replace function public.guarded_read_act_delta(p_act_id integer,p_lock_owner text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into a from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 return jsonb_build_object('data',doc,'date_off',a.date_off,'avans',a.avans,'pruimalnyk',a.pruimalnyk,
  'checksum',md5(jsonb_build_array(doc,a.avans,a.pruimalnyk,a.date_off)::text));
end $$;
create or replace function public.guarded_patch_act_with_stock(
 p_act_id integer,p_checksum text,p_changes jsonb,p_revision text,p_lock_owner text,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; next_doc jsonb; op jsonb; path text[]; parent jsonb;
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
  elsif op?'value' then
   next_doc:=jsonb_set(next_doc,path,op->'value',true);
  else raise exception 'Відсутнє значення зміни';end if;
 end loop;
 if next_doc=doc and (p_avans is null or a.avans is not distinct from p_avans) then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',coalesce(doc->>'__act_revision',''),'checksum',md5(doc::text),'cars_id',a.cars_id);
 end if;
 next_doc:=next_doc||jsonb_build_object('__act_revision',p_revision);
 -- Existing transaction retains atomic stock delta, lease, RLS and trigger verification.
 return public.guarded_write_act_with_stock_receipt(p_act_id,doc,next_doc,p_lock_owner,p_avans);
end $$;
revoke all on function public.guarded_read_act_delta(integer,text),public.guarded_patch_act_with_stock(integer,text,jsonb,text,text,numeric) from public,anon;
grant execute on function public.guarded_read_act_delta(integer,text),public.guarded_patch_act_with_stock(integer,text,jsonb,text,text,numeric) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
