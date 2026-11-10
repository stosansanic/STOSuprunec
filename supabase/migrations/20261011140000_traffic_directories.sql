begin;
create or replace function public.traffic_directory_name(v text) returns text
language sql immutable security invoker set search_path=pg_catalog as $$
 select lower(btrim(regexp_replace(normalize(coalesce(v,''),NFKC),'[[:space:]]+',' ','g')));
$$;
create or replace function public.traffic_directory_page(p_kind text,p_query text default '',p_offset integer default 0,p_exact boolean default false,p_id bigint default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare id_col text; result jsonb; projection text; label text;
begin
 id_col:=case p_kind when 'slyusars' then 'slyusar_id' when 'incomes' then 'income_id' when 'receivers' then 'receiver_id' when 'faktura' then 'faktura_id' end;
 if id_col is null or p_offset<0 then raise exception 'Invalid directory';end if;
 if p_kind='faktura' then
  projection:='jsonb_build_object(''faktura_id'',t.faktura_id,''name'',t.name,''oderjyvach'',t.oderjyvach,''prumitka'',t.prumitka,''data'',t.data,''namber'',t.namber)';
  label:='coalesce(t.oderjyvach,'''')';
 else
  projection:=format('jsonb_build_object(%L,t.%I,''data'',(select coalesce(jsonb_object_agg(key,value),''{}''::jsonb) from jsonb_each(public.sto_read_object_v1(to_jsonb(t.data))) where key=any(%L::text[])))',id_col,id_col,
   case when p_kind='slyusars' then case when p_id is null then '{Name,Доступ,ПроцентРоботи,ПроцентЗапчастин,Склад}' else '{Name,Доступ,ПроцентРоботи,ПроцентЗапчастин,Склад,Пароль}' end else '{Name}' end);
  label:='coalesce(public.sto_read_object_v1(to_jsonb(t.data))->>''Name'','''')';
 end if;
 execute format('with matches as materialized (select t.%I id,%s row,%s label from public.%I t where ($4 is null or t.%I=$4) and (case when $3 then public.traffic_directory_name(%s)=public.traffic_directory_name($1) else strpos(public.traffic_directory_name(%s),public.traffic_directory_name($1))>0 end)),page as (select * from matches order by label,id offset $2 limit 50) select jsonb_build_object(''items'',coalesce((select jsonb_agg(row order by label,id) from page),''[]''::jsonb),''total'',(select count(*) from matches))',id_col,projection,label,p_kind,id_col,label,label)
 into result using p_query,p_offset,p_exact,p_id;
 return result;
end $$;

create or replace function public.traffic_employee_counts() returns jsonb
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(jsonb_object_agg(role,n),'{}'::jsonb) from (
  select coalesce(nullif(public.sto_read_object_v1(to_jsonb(data))->>'Доступ',''),'Невідомо') role,count(*) n from public.slyusars group by 1
 ) s;
$$;

revoke all on function public.traffic_directory_page(text,text,integer,boolean,bigint),public.traffic_employee_counts() from public;
grant execute on function public.traffic_directory_page(text,text,integer,boolean,bigint),public.traffic_employee_counts() to anon,authenticated;
commit;
