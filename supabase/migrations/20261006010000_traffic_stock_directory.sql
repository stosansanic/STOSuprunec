-- Compact stock form directories; preserves caller privileges and existing RLS.
-- Requires 20261005010000_traffic_detail_suggestions.sql. No tables or data changes.
create or replace function public.traffic_stock_staff_data(p_data jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare v jsonb := p_data;
begin
  if jsonb_typeof(v) = 'string' then
    begin v := (v #>> '{}')::jsonb; exception when invalid_text_representation then return '{}'::jsonb; end;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'Name', v->'Name', 'name', v->'name', 'Ім''я', v->'Ім''я',
    'Доступ', v->'Доступ', 'доступ', v->'доступ'));
end $$;

create or replace function public.traffic_stock_directory(p_kind text, p_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public as $$
declare rows jsonb;
begin
  if p_kind = 'staff' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
      select s.slyusar_id, public.traffic_stock_staff_data(to_jsonb(s.data)) as data
      from public.slyusars s order by s.slyusar_id
      offset greatest(coalesce(p_offset,0),0) limit 501
    ) x;
  elsif p_kind = 'details' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
      select d.detail_id, public.traffic_reference_name(to_jsonb(d.data)) as name
      from public.details d order by d.detail_id
      offset greatest(coalesce(p_offset,0),0) limit 501
    ) x;
  elsif p_kind = 'shops' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
      select s.shop_id, public.traffic_reference_name(to_jsonb(s.data)) as name
      from public.shops s order by s.shop_id
      offset greatest(coalesce(p_offset,0),0) limit 501
    ) x;
  elsif p_kind = 'catalogs' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
      select distinct btrim(s.part_number::text) as part_number, btrim(s.name::text) as name
      from public.sclad s where nullif(btrim(s.part_number::text),'') is not null
      order by part_number, name
      offset greatest(coalesce(p_offset,0),0) limit 501
    ) x;
  else raise exception 'Unsupported stock directory'; end if;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb)
    from jsonb_array_elements(rows) with ordinality where ordinality <= 500),
    'has_more', jsonb_array_length(rows) > 500);
end $$;
