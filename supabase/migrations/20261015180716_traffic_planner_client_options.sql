-- Planner suggestions: only client IDs, names and phone fields leave the database.
-- Requires sto_read_object_v1 from the existing traffic optimization package.
begin;

create or replace function public.traffic_planner_client_options(
  p_kind text,
  p_query text default '',
  p_after bigint default null,
  p_client bigint default null
) returns jsonb
language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_result jsonb;
begin
  if p_kind is null or p_kind not in ('client', 'phone') then
    raise exception 'Unsupported planner client field' using errcode = '22023';
  end if;

  if p_kind = 'phone' and v_digits <> '' then
    v_query := v_digits;
  end if;

  -- Empty/short global searches must never enumerate the whole directory.
  -- An explicit client ID can still be restored without entering its name.
  if p_client is null and char_length(v_query) < 3 then
    return jsonb_build_object('items', '[]'::jsonb, 'has_more', false, 'next_cursor', null);
  end if;

  with candidates as (
    select c.client_id as id, public.sto_read_object_v1(c.data::jsonb) as d
    from public.clients c
    where (p_after is null or c.client_id > p_after)
      and (p_client is null or c.client_id = p_client)
  ), named as (
    select id, d, coalesce(d->>'ПІБ', '') as full_name
    from candidates
    where btrim(coalesce(d->>'ПІБ', '')) <> ''
      and (p_kind = 'phone' or strpos(lower(coalesce(d->>'ПІБ', '')), v_query) > 0)
  ), contacts as (
    select n.id, n.full_name, contact.phones
    from named n
    cross join lateral (
      select coalesce(array_agg(btrim(e.value) order by
        case when lower(e.key) = 'телефон' then 0 else 1 end, e.key), '{}'::text[]) as phones
      from jsonb_each_text(n.d) as e(key, value)
      where e.key ilike '%телефон%'
        and jsonb_typeof(n.d->e.key) = 'string'
        and btrim(e.value) <> ''
    ) as contact
  ), matched as (
    select c.id, c.full_name, c.phones,
      case when p_kind = 'phone' then (
        select p.value
        from unnest(c.phones) with ordinality as p(value, phone_order)
        where strpos(lower(p.value), v_query) > 0
          or (v_digits <> '' and strpos(regexp_replace(p.value, '[^0-9]', '', 'g'), v_digits) > 0)
        order by p.phone_order limit 1
      ) else c.phones[1] end as phone
    from contacts c
  ), page as (
    select id, full_name, phones, phone
    from matched
    where p_kind = 'client' or phone is not null
    order by id limit 21
  ), visible as (
    select id, full_name, phones, phone from page order by id limit 20
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id::text,
      'fullName', full_name,
      'phone', coalesce(phone, ''),
      'phones', to_jsonb(phones)
    ) order by id) from visible), '[]'::jsonb),
    'has_more', (select count(*) > 20 from page),
    'next_cursor', (select max(id) from visible)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.traffic_planner_client_options(text,text,bigint,bigint) from public;
grant execute on function public.traffic_planner_client_options(text,text,bigint,bigint) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
