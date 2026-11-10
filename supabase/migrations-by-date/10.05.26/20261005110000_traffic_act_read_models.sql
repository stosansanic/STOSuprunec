-- Requires 20261005100000_traffic_service_book.sql (JSON compatibility helper).
-- Read models only: never use these partial documents for saving or offline editing.
begin;

create or replace function public.sto_act_list_data_v1(p_data jsonb)
returns jsonb language sql immutable security invoker
set search_path = pg_catalog, public
as $$
  with d as (select public.sto_read_object_v1(p_data) as value)
  select case when p_data is null or p_data in ('null'::jsonb, '""'::jsonb, 'false'::jsonb, '0'::jsonb)
    then p_data else coalesce((select jsonb_object_agg(key, value) from jsonb_each(d.value)
    where key = any(array['Номер авто','Держ. номер','Автомобіль','Авто','Марка',
      'Загальна сума','total','amount','Знижка','За деталі','За роботу','Дзвінок',
      'Примітки','Рекомендації','Причина звернення','Заморожений'])), '{}'::jsonb)
    || jsonb_build_object(
      'Роботи', coalesce((select jsonb_agg(jsonb_build_object(
        'Робота', w->'Робота', 'Назва', w->'Назва', 'Слюсар', w->'Слюсар'))
        from jsonb_array_elements(case when jsonb_typeof(d.value->'Роботи')='array'
          then d.value->'Роботи' else '[]'::jsonb end) w), '[]'::jsonb),
      'Деталі', coalesce((select jsonb_agg(jsonb_build_object(
        'Деталь', w->'Деталь', 'Назва', w->'Назва'))
        from jsonb_array_elements(case when jsonb_typeof(d.value->'Деталі')='array'
          then d.value->'Деталі' else '[]'::jsonb end) w), '[]'::jsonb)
    ) end from d;
$$;

create or replace function public.sto_act_list_page_v1(
  p_from timestamptz default null, p_to timestamptz default null,
  p_mode text default null, p_before bigint default null
) returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  with page as (
    select a.* from public.acts a
    where (p_before is null or a.act_id < p_before)
      and case p_mode
        when 'open' then a.date_off is null
        when 'closed' then a.date_off is not null
        when 'frozen' then true
        else p_from is not null and p_to is not null and a.date_on >= p_from and a.date_on <= p_to
      end
    order by a.act_id desc limit 201
  ), visible as (select * from page order by act_id desc limit 200)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(
      (to_jsonb(a) - 'data' - 'info' - 'details') || jsonb_build_object(
        'data', public.sto_act_list_data_v1(a.data::jsonb),
        '__sto_projection', 'act-list-v1'
      ) || case when to_jsonb(a)->>'info' is not null then jsonb_build_object(
        'info', public.sto_act_list_data_v1(to_jsonb(a)->'info')) else '{}'::jsonb end
        || case when to_jsonb(a)->>'details' is not null then jsonb_build_object(
        'details', public.sto_act_list_data_v1(to_jsonb(a)->'details')) else '{}'::jsonb end
      order by a.act_id desc) from visible a), '[]'::jsonb),
    'has_more', (select count(*) > 200 from page),
    'next_cursor', (select min(act_id) from visible)
  );
$$;

create or replace function public.sto_previous_recommendations_v1(
  p_car_id bigint, p_exclude_act bigint, p_before bigint default null
) returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  with page as (
    select a.act_id, a.cars_id, a.date_off, a.pruimalnyk,
      public.sto_read_object_v1(a.data::jsonb) as d
    from public.acts a where a.cars_id = p_car_id and a.act_id <> p_exclude_act
      and (p_before is null or a.act_id < p_before)
    order by a.act_id desc limit 201
  ), visible as (select * from page order by act_id desc limit 200)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'act_id', act_id, 'cars_id', cars_id, 'date_off', date_off, 'pruimalnyk', pruimalnyk,
      'data', jsonb_build_object('Рекомендації', d->'Рекомендації',
        'Заморожений', d->'Заморожений') || case when d ? '__workshop_v1'
          then jsonb_build_object('__workshop_v1', d->'__workshop_v1') else '{}'::jsonb end
      ) order by act_id desc) from visible), '[]'::jsonb),
    'has_more', (select count(*) > 200 from page),
    'next_cursor', (select min(act_id) from visible)
  );
$$;

create or replace function public.sto_act_attention_page_v1(
  p_after bigint default null, p_reception text default null
) returns jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $$
  with page as (
    select a.act_id, a.date_on, a.date_off, a.pruimalnyk, a."slusarsOn",
      public.sto_read_object_v1(a.data::jsonb) as d
    from public.acts a
    where (p_after is null or a.act_id > p_after)
      and (p_reception is null or a.pruimalnyk = p_reception)
    order by a.act_id limit 201
  ), visible as (select * from page order by act_id limit 200)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'act_id', act_id, 'date_on', date_on, 'date_off', date_off,
      'pruimalnyk', pruimalnyk, 'slusarsOn', "slusarsOn",
      'data', jsonb_build_object(
        'Заморожений', d->'Заморожений', '__payroll_pending', d->'__payroll_pending',
        'Роботи', coalesce((select jsonb_agg(jsonb_build_object(
          'Робота', w->'Робота', 'Слюсар', w->'Слюсар', 'Ціна', w->'Ціна'))
          from jsonb_array_elements(case when jsonb_typeof(d->'Роботи')='array'
            then d->'Роботи' else '[]'::jsonb end) w), '[]'::jsonb),
        'Деталі', coalesce((select jsonb_agg(jsonb_build_object(
          'Деталь', w->'Деталь', 'Ціна', w->'Ціна'))
          from jsonb_array_elements(case when jsonb_typeof(d->'Деталі')='array'
            then d->'Деталі' else '[]'::jsonb end) w), '[]'::jsonb)
      ) || case when d ? '__workshop_v1' then jsonb_build_object(
        '__workshop_v1', d->'__workshop_v1') else '{}'::jsonb end
    ) order by act_id) from visible), '[]'::jsonb),
    'has_more', (select count(*) > 200 from page),
    'next_cursor', (select max(act_id) from visible)
  );
$$;

revoke all on function public.sto_act_attention_page_v1(bigint,text) from public;
grant execute on function public.sto_act_attention_page_v1(bigint,text) to anon, authenticated;
revoke all on function public.sto_act_list_data_v1(jsonb) from public;
revoke all on function public.sto_act_list_page_v1(timestamptz,timestamptz,text,bigint) from public;
revoke all on function public.sto_previous_recommendations_v1(bigint,bigint,bigint) from public;
grant execute on function public.sto_act_list_data_v1(jsonb) to anon, authenticated;
grant execute on function public.sto_act_list_page_v1(timestamptz,timestamptz,text,bigint) to anon, authenticated;
grant execute on function public.sto_previous_recommendations_v1(bigint,bigint,bigint) to anon, authenticated;
commit;
