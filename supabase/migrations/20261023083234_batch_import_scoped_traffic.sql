-- Excel import keeps its existing formulas and per-cell CAS, with bounded transport.
begin;
create or replace function public.traffic_batch_act_details(p_act_id integer)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare doc jsonb; projection jsonb;
begin
 select public.payroll_json_object(to_jsonb(data)) into doc from public.acts where act_id=p_act_id;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into projection from jsonb_each(doc) where key=any(array['Деталі','За деталі','Загальна сума']);
 return jsonb_build_object('act_id',p_act_id,'data',projection,'checksum',md5(doc::text));
end $$;

create or replace function public.write_batch_act_details(p_act_id integer,p_checksum text,p_projection jsonb,p_revision text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare a public.acts%rowtype; doc jsonb; next_doc jsonb; saved jsonb;
begin
 if jsonb_typeof(p_projection) is distinct from 'object' or jsonb_typeof(p_projection->'Деталі') is distinct from 'array' or nullif(p_revision,'') is null then raise exception 'Некоректний пакет деталей';end if;
 if exists(select 1 from jsonb_object_keys(p_projection) k where k<>all(array['Деталі','За деталі','Загальна сума'])) then raise exception 'Недозволене поле акту';end if;
 select * into a from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт недоступний' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(a.data));
 if md5(doc::text) is distinct from p_checksum then raise exception 'Акт змінено. Повторіть синхронізацію деталей.' using errcode='40001';end if;
 next_doc:=doc||p_projection||jsonb_build_object('__act_revision',p_revision);
 -- This existing writer enforces closed/frozen guards and applies stock deltas atomically.
 saved:=public.write_act_with_stock(p_act_id,doc,next_doc,null);
 if saved is distinct from next_doc or saved is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then raise exception 'Не підтверджено запис деталей' using errcode='40001';end if;
 return jsonb_build_object('act_id',p_act_id,'revision',p_revision,'cars_id',a.cars_id,'status','updated');
end $$;

create or replace function public.write_batch_stock_cells(p_items jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare item jsonb; changes jsonb; expected jsonb; field text; assignments text; guards text; changed_count integer; receipts jsonb:='[]'::jsonb;
 allowed constant text[]:=array['time_on','shops','part_number','name','kilkist_on','price','client_price','rahunok','unit_measurement','akt','scladNomer','statys','prumitka','xto_zamovuv'];
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>100 then raise exception 'Некоректний пакет комірок';end if;
 if exists(select 1 from jsonb_array_elements(p_items) i group by i->>'key' having count(*)>1) or
    exists(select 1 from jsonb_array_elements(p_items) i group by i->>'id' having count(*)>1) then raise exception 'Повторна складська позиція у пакеті';end if;
 -- A per-row subtransaction retains the current partial-success behavior.
 for item in select value from jsonb_array_elements(p_items) order by (value->>'id')::bigint loop
  begin
   changes:=item->'changes';expected:=item->'expected';assignments:='';guards:='';
   if nullif(item->>'key','') is null or jsonb_typeof(changes) is distinct from 'object' or changes='{}'::jsonb or jsonb_typeof(expected) is distinct from 'object' then raise exception 'Некоректні комірки';end if;
   for field in select jsonb_object_keys(changes) order by 1 loop
    if not(field=any(allowed)) or not(expected ? field) then raise exception 'Неповний або недозволений знімок комірок';end if;
    assignments:=assignments||case when assignments='' then '' else ',' end||format('%I=(jsonb_populate_record(null::public.sclad,$1)).%I',field,field);
    guards:=guards||format(' and s.%I is not distinct from (jsonb_populate_record(null::public.sclad,$2)).%I',field,field);
   end loop;
   execute 'update public.sclad s set '||assignments||' where s.sclad_id=$3'||guards using changes,expected,(item->>'id')::bigint;
   get diagnostics changed_count=row_count;
   if changed_count<>1 then raise exception 'Комірки вже змінено іншим користувачем. Оновіть склад і повторіть редагування.' using errcode='40001';end if;
   receipts:=receipts||jsonb_build_array(jsonb_build_object('key',item->>'key','id',item->'id','status','updated'));
  exception when others then
   receipts:=receipts||jsonb_build_array(jsonb_build_object('key',item->>'key','id',item->'id','status','error','message',sqlerrm));
  end;
 end loop;
 return receipts;
end $$;
revoke all on function public.traffic_batch_act_details(integer),public.write_batch_act_details(integer,text,jsonb,text),public.write_batch_stock_cells(jsonb) from public,anon;
grant execute on function public.traffic_batch_act_details(integer),public.write_batch_act_details(integer,text,jsonb,text),public.write_batch_stock_cells(jsonb) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
