-- SQL Editor: виправлення Invalid directory у полі «Магазин».
-- Виконати весь файл у тому самому Supabase-проєкті, до якого підключено сайт.
-- Після Success закрити й повторно відкрити модалку. Оновлення сайту не потрібне для SQL-виправлення.
-- Відновлює актуальне читання довідників з усіма допоміжними функціями.
-- Магазини: тільки shop_id і data.Name, до 50 назв на сторінку.
-- Таблиці, записи, історія, RLS та функції збереження залишаються без змін.
-- Файл №8 для нових проєктів уже містить ці визначення.
begin;

-- SOURCE: 20261005100000_traffic_service_book.sql
create or replace function public.sto_read_object_v1(p_value jsonb)
returns jsonb language plpgsql immutable security invoker
set search_path = pg_catalog
as $$
declare parsed jsonb;
begin
  if jsonb_typeof(p_value) = 'object' then return p_value; end if;
  if jsonb_typeof(p_value) = 'string' then
    begin
      parsed := (p_value #>> '{}')::jsonb;
      if jsonb_typeof(parsed) = 'object' then return parsed; end if;
    exception when invalid_text_representation then return '{}'::jsonb;
    end;
  end if;
  return '{}'::jsonb;
end;
$$;

-- SOURCE: 20261005010000_traffic_detail_suggestions.sql
create or replace function public.traffic_reference_name(p_data jsonb)
returns text language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare v jsonb := p_data; s text; k text;
begin
  if jsonb_typeof(v) = 'string' then
    s := btrim(v #>> '{}');
    if left(s,1) in ('{','[') then
      begin v := s::jsonb; exception when invalid_text_representation then return s; end;
    else return s; end if;
  end if;
  foreach k in array array['Name','name','Назва','Текст','text','ПІБ'] loop
    if jsonb_typeof(v->k) in ('string','number') then
      s := btrim(v->>k);
      if s <> '' then return s; end if;
    end if;
  end loop;
  return null;
end $$;

-- SOURCE: 20261011140000_traffic_directories.sql
create or replace function public.traffic_directory_name(v text) returns text
language sql immutable security invoker set search_path=pg_catalog as $$
 select lower(btrim(regexp_replace(normalize(coalesce(v,''),NFKC),'[[:space:]]+',' ','g')));
$$;

-- SOURCE: 20261021154545_traffic_directory_modal_read.sql
create or replace function public.traffic_directory_page(p_kind text,p_query text default '',p_offset integer default 0,p_exact boolean default false,p_id bigint default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare id_col text; result jsonb; projection text; label text;
begin
 id_col:=case p_kind when 'slyusars' then 'slyusar_id' when 'incomes' then 'income_id' when 'receivers' then 'receiver_id' when 'faktura' then 'faktura_id' when 'works' then 'work_id' when 'shops' then 'shop_id' when 'details' then 'detail_id' end;
 if id_col is null or p_offset is null or p_offset<0 or (p_id is not null and p_id<=0) then raise exception 'Invalid directory';end if;
 if p_kind='faktura' then
  projection:='jsonb_build_object(''faktura_id'',t.faktura_id,''name'',t.name,''oderjyvach'',t.oderjyvach,''prumitka'',t.prumitka,''data'',t.data,''namber'',t.namber)';
  label:='coalesce(t.oderjyvach,'''')';
 elsif p_kind in ('works','details') then
  projection:=format('jsonb_build_object(%L,t.%I,''data'',public.traffic_reference_name(to_jsonb(t.data)))',id_col,id_col);
  label:='coalesce(public.traffic_reference_name(to_jsonb(t.data)),'''')';
 else
  projection:=format('jsonb_build_object(%L,t.%I,''data'',(select coalesce(jsonb_object_agg(key,value),''{}''::jsonb) from jsonb_each(public.sto_read_object_v1(to_jsonb(t.data))) where key=any(%L::text[])))',id_col,id_col,
   case when p_kind='slyusars' then case when p_id is null then '{Name,Доступ}' else '{Name,Доступ,ПроцентРоботи,ПроцентЗапчастин,Склад,Пароль}' end else '{Name}' end);
  label:='coalesce(public.sto_read_object_v1(to_jsonb(t.data))->>''Name'','''')';
 end if;
 -- Count/filter only IDs and names. Build response JSON after the page boundary,
 -- avoiding extraction of editable metadata for every matching employee/record.
 execute format($query$
  with matches as materialized (
   select t.%I id,%s label from public.%I t
   where ($4 is null or t.%I=$4)
    and (case when $3 then public.traffic_directory_name(%s)=public.traffic_directory_name($1)
     else strpos(public.traffic_directory_name(%s),public.traffic_directory_name($1))>0 end)
  ), page as (select * from matches order by label,id offset $2 limit 50),
  serialized as (select p.id,p.label,%s row from page p join public.%I t on t.%I=p.id)
  select jsonb_build_object('items',coalesce((select jsonb_agg(row order by label,id) from serialized),'[]'::jsonb),
   'total',(select count(*) from matches))
 $query$,id_col,label,p_kind,id_col,label,label,projection,p_kind,id_col)
 into result using p_query,p_offset,p_exact,p_id;
 return result;
end $$;

revoke all on function public.traffic_directory_page(text,text,integer,boolean,bigint) from public;
grant execute on function public.traffic_directory_page(text,text,integer,boolean,bigint) to anon,authenticated;
grant execute on function public.sto_read_object_v1(jsonb),public.traffic_reference_name(jsonb),public.traffic_directory_name(text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
