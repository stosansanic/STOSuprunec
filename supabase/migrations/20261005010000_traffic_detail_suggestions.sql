-- Read-only, bounded name suggestions. Uses caller privileges and existing RLS.
-- No tables, data rewrites, or privilege elevation.
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



create or replace function public.traffic_detail_suggestions(p_query text, p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = pg_catalog, public as $$
  with matches as (
    select d.detail_id, public.traffic_reference_name(to_jsonb(d.data)) as name
    from public.details d
  ), page as (
    select detail_id, name from matches
    where name is not null and strpos(lower(name), lower(btrim(coalesce(p_query,'')))) > 0
    order by name, detail_id
    offset greatest(coalesce(p_offset,0),0) limit 21
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(x)) from
      (select * from page order by name, detail_id limit 20) x), '[]'::jsonb),
    'has_more', (select count(*) > 20 from page)
  );
$$;

-- Exact case-insensitive reference lookup; historic duplicates keep their IDs.
-- Prefer exact spelling, then the oldest stable ID, matching existing lookup intent.
create or replace function public.traffic_reference_id(p_kind text, p_name text)
returns bigint language plpgsql stable security invoker set search_path = pg_catalog, public as $$
declare result bigint;
begin
  if nullif(btrim(p_name),'') is null then return null; end if;
  if p_kind = 'details' then
    select d.detail_id into result from public.details d
    where regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(d.data)))), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(btrim(p_name)), '[[:space:]]+', ' ', 'g')
    order by (public.traffic_reference_name(to_jsonb(d.data)) = btrim(p_name)) desc, d.detail_id limit 1;
  elsif p_kind = 'shops' then
    select s.shop_id into result from public.shops s
    where regexp_replace(lower(btrim(public.traffic_reference_name(to_jsonb(s.data)))), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(btrim(p_name)), '[[:space:]]+', ' ', 'g')
    order by (public.traffic_reference_name(to_jsonb(s.data)) = btrim(p_name)) desc, s.shop_id limit 1;
  else raise exception 'Unsupported reference'; end if;
  return result;
end $$;

create or replace function public.traffic_reference_ids(p_items jsonb)
returns jsonb language plpgsql stable security invoker set search_path = pg_catalog, public as $$
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'Expected at most 100 names';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', x->>'kind', 'name', x->>'name',
    'id', public.traffic_reference_id(x->>'kind', x->>'name'))) from jsonb_array_elements(p_items) x), '[]'::jsonb);
end $$;
