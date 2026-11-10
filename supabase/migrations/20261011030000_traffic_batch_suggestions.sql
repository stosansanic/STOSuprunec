-- Bounded stock-form lookups. No new tables; all reads obey caller RLS.
create or replace function public.traffic_batch_suggestions(p_kind text,p_query text default '',p_offset integer default 0,p_exact boolean default false)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare rows jsonb; q text := lower(btrim(coalesce(p_query,'')));
begin
 if p_kind in ('shops','details') then
  with names as (
   select public.traffic_reference_name(to_jsonb(s.data)) as name from public.shops s where p_kind='shops'
   union all select public.traffic_reference_name(to_jsonb(d.data)) from public.details d where p_kind='details'
  ) select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
   select distinct name as value from names where name is not null and
   (case when p_exact then lower(btrim(name))=q else strpos(lower(name),q)>0 end)
   order by value offset greatest(p_offset,0) limit 21
  ) x;
 elsif p_kind='catalogs' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
   select distinct btrim(s.part_number::text) as value,btrim(s.name::text) as name
   from public.sclad s where nullif(btrim(s.part_number::text),'') is not null and
   (case when p_exact then btrim(s.part_number::text)=btrim(p_query)
    else q='' or strpos(lower(s.part_number),q)>0 or (public.traffic_catalog_key(p_query)<>'' and strpos(public.traffic_catalog_key(s.part_number),public.traffic_catalog_key(p_query))>0) end)
   order by value,name offset greatest(p_offset,0) limit 21
  ) x;
 elsif p_kind='acts' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
   select a.act_id::text as value,a.date_off, concat_ws(' · ',a.act_id::text,public.sto_read_object_v1(c.data::jsonb)->>'ПІБ',public.sto_read_object_v1(v.data::jsonb)->>'Авто',public.sto_read_object_v1(v.data::jsonb)->>'Номер авто') as label from public.acts a
   left join public.clients c on c.client_id=a.client_id
   left join public.cars v on v.cars_id=a.cars_id
   where a.date_off is null and
   (case when p_exact then a.act_id::text=btrim(p_query) else strpos(lower(concat_ws(' ',a.act_id::text,public.sto_read_object_v1(c.data::jsonb)->>'ПІБ',public.sto_read_object_v1(v.data::jsonb)->>'Авто',public.sto_read_object_v1(v.data::jsonb)->>'Номер авто')),q)>0 end)
   order by a.act_id desc offset greatest(p_offset,0) limit 21
  ) x;
 else raise exception 'Unsupported batch lookup'; end if;
 return jsonb_build_object('items',(select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb)
  from jsonb_array_elements(rows) with ordinality where ordinality<=20),'has_more',jsonb_array_length(rows)>20);
end $$;
revoke all on function public.traffic_batch_suggestions(text,text,integer,boolean) from public;
grant execute on function public.traffic_batch_suggestions(text,text,integer,boolean) to anon,authenticated;

-- One bounded OCR mapping request for up to 100 unique catalog numbers.
create or replace function public.traffic_invoice_catalogs(p_catalogs text[],p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare rows jsonb;
begin
 if coalesce(cardinality(p_catalogs),0)>100 then raise exception 'Expected at most 100 catalogs';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into rows from (
  select btrim(s.part_number::text) as catalog,btrim(s.name::text) as name,min(s.sclad_id) as id
  from public.sclad s where btrim(s.part_number::text)=any(p_catalogs) and nullif(btrim(s.name::text),'') is not null
  group by btrim(s.part_number::text),btrim(s.name::text) order by catalog,name
  offset greatest(coalesce(p_offset,0),0) limit 201
 ) x;
 return jsonb_build_object('items',(select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb)
  from jsonb_array_elements(rows) with ordinality where ordinality<=200),'has_more',jsonb_array_length(rows)>200);
end $$;
revoke all on function public.traffic_invoice_catalogs(text[],integer) from public;
grant execute on function public.traffic_invoice_catalogs(text[],integer) to anon,authenticated;

create or replace function public.traffic_stock_position(p_id bigint)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
 select jsonb_build_object('sclad_id',s.sclad_id,'time_on',s.time_on,'shops',s.shops,'part_number',s.part_number,'name',s.name,
  'kilkist_on',s.kilkist_on,'price',s.price,'rahunok',s.rahunok,'unit_measurement',s.unit_measurement,'scladNomer',s."scladNomer",'xto_zamovuv',s.xto_zamovuv,
  'shop_id',public.traffic_reference_id('shops',s.shops),'detail_id',public.traffic_reference_id('details',s.name),
  'employee_name',(select public.traffic_reference_name(to_jsonb(e.data)) from public.slyusars e where e.slyusar_id=s.xto_zamovuv))
 from public.sclad s where s.sclad_id=p_id
$$;
revoke all on function public.traffic_stock_position(bigint) from public;
grant execute on function public.traffic_stock_position(bigint) to anon,authenticated;

create or replace function public.traffic_detail_employee(p_name text)
returns text language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(public.sto_read_object_v1(to_jsonb(e.data))->>'Name',public.sto_read_object_v1(to_jsonb(e.data))->>'Ім''я')
 from (select s.xto_zamovuv from public.sclad s where s.name=p_name order by s.sclad_id desc limit 1) s
 left join public.slyusars e on e.slyusar_id=s.xto_zamovuv
$$;
revoke all on function public.traffic_detail_employee(text) from public;
grant execute on function public.traffic_detail_employee(text) to anon,authenticated;
