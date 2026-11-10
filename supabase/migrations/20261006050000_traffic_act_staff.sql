-- Read-only employee metadata and complete history entries for one act.
-- Never use this projection as the baseline for saving an employee document.
create or replace function public.traffic_act_staff(p_act_id bigint default null, p_after bigint default null)
returns jsonb language sql stable security invoker set search_path = public
as $$
  with candidates as (
    select s.slyusar_id, public.traffic_json_object(s.data::jsonb) as body
    from public.slyusars s
    where p_after is null or s.slyusar_id > p_after
    order by s.slyusar_id limit 201
  ), page as (select * from candidates order by slyusar_id limit 200)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'slyusar_id', p.slyusar_id,
      'data', (p.body - 'Історія') || jsonb_build_object('Історія',
        coalesce((select jsonb_object_agg(day.key, entries.value)
          from jsonb_each(case when jsonb_typeof(p.body->'Історія')='object'
            then p.body->'Історія' else '{}'::jsonb end) day
          cross join lateral (
            select jsonb_agg(entry.value order by entry.ordinality) as value
            from jsonb_array_elements(case when jsonb_typeof(day.value)='array'
              then day.value else '[]'::jsonb end) with ordinality entry(value,ordinality)
            where p_act_id is not null and entry.value->>'Акт' = p_act_id::text
          ) entries
          where entries.value is not null),'{}'::jsonb)),
      '__sto_projection','act-staff-v1'
    ) order by p.slyusar_id) from page p),'[]'::jsonb),
    'has_more', (select count(*) > 200 from candidates),
    'next_cursor', (select max(slyusar_id) from page)
  );
$$;
revoke all on function public.traffic_act_staff(bigint,bigint) from public;
grant execute on function public.traffic_act_staff(bigint,bigint) to anon, authenticated;
