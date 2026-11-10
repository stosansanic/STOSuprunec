-- Editor save receipts use a server hash of the authoritative JSONB, never client JSON serialization.
create or replace function public.guarded_write_act_with_stock_receipt(p_act_id integer,p_expected jsonb,p_next jsonb,p_lock_owner text,p_avans numeric default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare saved jsonb; stored jsonb; car_id bigint; current_avans numeric;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select public.payroll_json_object(to_jsonb(data)),cars_id,avans into stored,car_id,current_avans from public.acts where act_id=p_act_id for update;
 if stored=p_next and nullif(p_next->>'__act_revision','') is not null and (p_avans is null or current_avans=p_avans) then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',stored->>'__act_revision','checksum',md5(stored::text),'cars_id',car_id);
 end if;
 saved:=public.write_act_with_stock(p_act_id,p_expected,p_next,p_avans);
 if saved is distinct from p_next or nullif(saved->>'__act_revision','') is null then raise exception 'Некоректна квитанція акту';end if;
 select public.payroll_json_object(to_jsonb(data)),cars_id into stored,car_id from public.acts where act_id=p_act_id;
 if stored is distinct from saved then raise exception 'Акт змінений сервером під час збереження' using errcode='40001';end if;
 return jsonb_build_object('act_id',p_act_id,'status','updated','revision',saved->>'__act_revision','checksum',md5(saved::text),'cars_id',car_id);
end $$;

create or replace function public.guarded_act_payroll_context(p_act_id integer,p_checksum text,p_revision text,p_lock_owner text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare row_value public.acts%rowtype; doc jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into row_value from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(row_value.data));
 if md5(doc::text) is distinct from p_checksum or doc->>'__act_revision' is distinct from p_revision then raise exception 'Акт змінився під час синхронізації зарплати' using errcode='40001';end if;
 if row_value.date_off is not null or doc->'Заморожений'='true'::jsonb then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 return jsonb_build_object('pruimalnyk',row_value.pruimalnyk,'date_off',row_value.date_off,'revision',p_revision,'checksum',p_checksum);
end $$;

create or replace function public.guarded_finish_act_payroll(p_act_id integer,p_checksum text,p_revision text,p_next_revision text,p_lock_owner text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare row_value public.acts%rowtype; doc jsonb;
begin
 perform public.assert_editor_act_lease(p_act_id,p_lock_owner);
 select * into row_value from public.acts where act_id=p_act_id for update;
 if not found then raise exception 'Акт не знайдено' using errcode='40001';end if;
 doc:=public.payroll_json_object(to_jsonb(row_value.data));
 -- Retry of the same acknowledged patch is harmless.
 if doc->>'__act_revision'=p_next_revision and doc->'__payroll_pending'='false'::jsonb
  and md5((doc||jsonb_build_object('__payroll_pending',true,'__act_revision',p_revision))::text)=p_checksum then
  return jsonb_build_object('act_id',p_act_id,'status','unchanged','revision',p_next_revision,'checksum',md5(doc::text),'cars_id',row_value.cars_id);
 end if;
 if md5(doc::text) is distinct from p_checksum or doc->>'__act_revision' is distinct from p_revision then raise exception 'Акт змінився під час синхронізації зарплати' using errcode='40001';end if;
 if row_value.date_off is not null or doc->'Заморожений'='true'::jsonb then raise exception 'Акт закритий або заморожений' using errcode='55000';end if;
 if nullif(p_next_revision,'') is null then raise exception 'Потрібна редакція акту';end if;
 if doc->'__payroll_pending' is distinct from 'true'::jsonb then raise exception 'Розрахунок зарплати не очікує завершення' using errcode='40001';end if;
 doc:=doc||jsonb_build_object('__payroll_pending',false,'__act_revision',p_next_revision);
 update public.acts set data=doc where act_id=p_act_id;
 if doc is distinct from (select public.payroll_json_object(to_jsonb(data)) from public.acts where act_id=p_act_id) then
  raise exception 'Акт змінений сервером під час завершення зарплати' using errcode='40001';
 end if;
 return jsonb_build_object('act_id',p_act_id,'status','updated','revision',p_next_revision,'checksum',md5(doc::text),'cars_id',row_value.cars_id);
end $$;
revoke all on function public.guarded_write_act_with_stock_receipt(integer,jsonb,jsonb,text,numeric),public.guarded_act_payroll_context(integer,text,text,text),public.guarded_finish_act_payroll(integer,text,text,text,text) from public,anon;
grant execute on function public.guarded_write_act_with_stock_receipt(integer,jsonb,jsonb,text,numeric),public.guarded_act_payroll_context(integer,text,text,text),public.guarded_finish_act_payroll(integer,text,text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';
