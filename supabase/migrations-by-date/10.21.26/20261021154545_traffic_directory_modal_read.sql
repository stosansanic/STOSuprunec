-- Compact modal directory pages and selected stock baseline. Existing RLS remains in force.
begin;

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

create or replace function public.traffic_stock_position(p_id bigint)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('sclad_id',s.sclad_id,'time_on',s.time_on,'shops',s.shops,'part_number',s.part_number,'name',s.name,
  'kilkist_on',s.kilkist_on,'price',s.price,'rahunok',s.rahunok,'unit_measurement',s.unit_measurement,'scladNomer',s."scladNomer",'xto_zamovuv',s.xto_zamovuv,
  'shop_id',public.traffic_reference_id('shops',s.shops),'detail_id',public.traffic_reference_id('details',s.name),
  'employee_name',(select public.traffic_reference_name(to_jsonb(e.data)) from public.slyusars e where e.slyusar_id=s.xto_zamovuv))
  || (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(to_jsonb(s)) where key=any(array['kilkist_off','akt','statys','prumitka','client_price']))
 from public.sclad s where s.sclad_id=p_id
$$;
revoke all on function public.traffic_stock_position(bigint) from public;
grant execute on function public.traffic_stock_position(bigint) to anon,authenticated;

-- The existing lazy page also serves as a baseline for guarded editing/deletion.
-- Include consumed quantity once per loaded row, avoiding a selected-row re-read.
create or replace function public.traffic_stock_page_v2(p_status text default null,p_from text default null,p_to text default null,p_query text default '',p_before bigint default null,p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 with page as (
 select n.sclad_id,n.time_on,n.shops,n.part_number,n.name,n.kilkist_on,n.kilkist_off,n.price,n."scladNomer",n.rahunok,n.akt,n.unit_measurement,n.statys,n.prumitka,n.xto_zamovuv,to_jsonb(n)->'client_price' as client_price
 from public.sclad n
 where (case when p_status='Прибула' then n.statys is null when p_status in ('Замовити','Замовлено') then n.statys=p_status else n.statys in ('Замовити','Замовлено') end)
 and (nullif(p_from,'') is null or n.time_on >= nullif(p_from,'')::timestamptz)
 and (nullif(p_to,'') is null or n.time_on <= nullif(p_to,'')::timestamptz)
 and (p_before is null or n.sclad_id<p_before)
 and (nullif(btrim(p_query),'') is null or strpos(lower(coalesce(n.part_number,'')),lower(btrim(p_query)))>0 or
 (public.traffic_catalog_key(p_query)<>'' and strpos(public.traffic_catalog_key(n.part_number),public.traffic_catalog_key(p_query))>0))
 order by n.sclad_id desc limit least(20,greatest(1,coalesce(p_limit,20)))+1
 ), visible as (select * from page order by sclad_id desc limit least(20,greatest(1,coalesce(p_limit,20))))
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(v) order by v.sclad_id desc) from visible v),'[]'::jsonb),
 'has_more',(select count(*)>least(20,greatest(1,coalesce(p_limit,20))) from page),'next_cursor',(select min(sclad_id) from visible));
$$;
revoke all on function public.traffic_stock_page_v2(text,text,text,text,bigint,integer) from public;
grant execute on function public.traffic_stock_page_v2(text,text,text,text,bigint,integer) to anon,authenticated;


revoke all on function public.traffic_directory_page(text,text,integer,boolean,bigint) from public;
grant execute on function public.traffic_directory_page(text,text,integer,boolean,bigint) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
