-- Additive read-only API. Uses the caller's existing table permissions and RLS.
begin;

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

create or replace function public.sto_service_book_search_v1(
  p_query text, p_after bigint default null
) returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  with candidates as (
    select c.cars_id, c.client_id,
      public.sto_read_object_v1(c.data::jsonb) as car_data,
      public.sto_read_object_v1(cl.data::jsonb) as client_data
    from public.cars c
    left join public.clients cl on cl.client_id = c.client_id
    where c.is_deleted is not true
      and (p_after is null or c.cars_id > p_after)
  ), page as (
    select * from candidates
    where length(btrim(coalesce(p_query, ''))) > 0
      and exists (
        select 1 from unnest(array[
          car_data->>'Авто', car_data->>'Номер авто', car_data->>'Vincode',
          car_data->>'КодДВЗ', client_data->>'ПІБ', client_data->>'Телефон'
        ]) as value(text_value)
        where strpos(lower(coalesce(text_value, '')), lower(btrim(p_query))) > 0
      )
    order by cars_id limit 21
  ), visible as (select * from page order by cars_id limit 20)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'car', jsonb_build_object('cars_id', cars_id, 'client_id', client_id, 'data', car_data),
      'client', jsonb_build_object('client_id', client_id, 'data', client_data)
    ) order by cars_id) from visible), '[]'::jsonb),
    'has_more', (select count(*) > 20 from page),
    'next_cursor', (select max(cars_id) from visible)
  );
$$;

revoke all on function public.sto_read_object_v1(jsonb) from public;
revoke all on function public.sto_service_book_search_v1(text,bigint) from public;
grant execute on function public.sto_read_object_v1(jsonb) to anon, authenticated;
grant execute on function public.sto_service_book_search_v1(text,bigint) to anon, authenticated;
commit;
