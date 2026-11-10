-- Narrow accounting read contract. No tables, writes, or privilege escalation.
create or replace function public.traffic_json_object(p_value jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = public
as $$
begin
  if jsonb_typeof(p_value) = 'string' then
    p_value := (p_value #>> '{}')::jsonb;
  end if;
  if jsonb_typeof(p_value) = 'object' then return p_value; end if;
  return '{}'::jsonb;
exception when invalid_text_representation then
  return '{}'::jsonb;
end;
$$;

create or replace function public.traffic_accounting_statuses(p_ids bigint[] default null, p_after bigint default null, p_limit integer default 200)
returns jsonb language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'act_id', q.act_id, 'date_off', q.date_off, 'rosraxovano', q.rosraxovano,
    'data', jsonb_build_object('Заморожений', q.body->'Заморожений',
      '__payroll_pending', q.body->'__payroll_pending', 'Знижка', q.body->'Знижка')
  ) order by q.act_id), '[]'::jsonb)
  from (
    select a.act_id, a.date_off, a.rosraxovano,
      public.traffic_json_object(a.data::jsonb) as body
    from public.acts a
    where (p_ids is null or a.act_id = any(p_ids)) and (p_after is null or a.act_id > p_after)
    order by a.act_id limit greatest(1, least(coalesce(p_limit, 200), 200))
  ) q;
$$;
-- The existing custom employee login can use the anon database role. INVOKER
-- preserves that role's existing table grants/RLS; this does not bypass them.
revoke all on function public.traffic_accounting_statuses(bigint[],bigint,integer) from public;
grant execute on function public.traffic_accounting_statuses(bigint[],bigint,integer) to anon, authenticated;

-- Employee labels without payroll history. Caller RLS remains authoritative.
create or replace function public.traffic_employee_names()
returns jsonb language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('slyusar_id', s.slyusar_id,
    'name', public.traffic_json_object(s.data::jsonb)->>'Name') order by s.slyusar_id), '[]'::jsonb)
  from public.slyusars s;
$$;
revoke all on function public.traffic_employee_names() from public;
grant execute on function public.traffic_employee_names() to anon, authenticated;

-- Edge authorization also supports legacy string-encoded employee JSON without
-- transferring the employee's payroll history. Service-role callers only.
create or replace function public.traffic_np_employee(p_id bigint)
returns jsonb language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object('slyusar_id', s.slyusar_id,
    'name', public.traffic_json_object(s.data::jsonb)->>'Name',
    'role', public.traffic_json_object(s.data::jsonb)->>'Доступ')
  from public.slyusars s where s.slyusar_id = p_id;
$$;
revoke all on function public.traffic_np_employee(bigint) from public, anon, authenticated;
grant execute on function public.traffic_np_employee(bigint) to service_role;

-- Search before transfer; only fields actually used by Atlas lookup cards.
-- Search normalization is supplied by the existing UI parser, not guessed here.
create or replace function public.traffic_ai_lookup(
  p_names text[] default '{}', p_phone text default '', p_brand text default '',
  p_plate text default '', p_vin text default '', p_limit integer default 50)
returns jsonb language sql stable security invoker set search_path = public
as $$
  with clients as (
    select c.client_id, public.traffic_json_object(c.data::jsonb) d from public.clients c
  ), cars as (
    select c.cars_id, c.client_id, public.traffic_json_object(c.data::jsonb) d
    from public.cars c where c.is_deleted is not true
  ), direct_clients as (
    select c.* from clients c where
      (cardinality(coalesce(p_names,'{}')) = 0 and p_phone = '' and p_brand = '' and p_plate = '' and p_vin = '') or
      exists (select 1 from unnest(p_names) n where n <> '' and
        position(lower(n) in lower(coalesce(nullif(c.d->>'ПІБ',''),c.d->>'Клієнт',''))) > 0)
      or (p_phone <> '' and (position(p_phone in regexp_replace(coalesce(c.d->>'Телефон',''),'[^0-9]','','g')) > 0
        or position(p_phone in regexp_replace(coalesce(c.d->>'Додатковий',''),'[^0-9]','','g')) > 0))
  ), matched_cars as (
    select c.* from cars c where
      (cardinality(coalesce(p_names,'{}')) = 0 and p_phone = '' and p_brand = '' and p_plate = '' and p_vin = '') or
      (p_brand <> '' and position(lower(p_brand) in lower(coalesce(c.d->>'Авто',''))) > 0)
      or (p_plate <> '' and position(p_plate in regexp_replace(translate(upper(coalesce(c.d->>'Номер авто','')),
        'АВЕКМНОРСТУХІЇ','ABEKMHOPCTYXII'),'[^A-Z0-9]','','g')) > 0)
      or (p_vin <> '' and position(p_vin in regexp_replace(translate(upper(coalesce(nullif(c.d->>'Vincode',''),c.d->>'VIN','')),
        'АВЕКМНОРСТУХІЇ','ABEKMHOPCTYXII'),'[^A-Z0-9]','','g')) > 0)
      or c.client_id in (select client_id from direct_clients)
  ), matched_clients as (
    select c.* from clients c where c.client_id in (select client_id from direct_clients)
      or c.client_id in (select client_id from matched_cars)
  ), client_page as (
    select * from matched_clients order by client_id limit greatest(1,least(coalesce(p_limit,50),200))
  ), car_page as (
    select * from matched_cars order by cars_id limit greatest(1,least(coalesce(p_limit,50),200))
  )
  select jsonb_build_object(
    'clients', coalesce((select jsonb_agg(jsonb_build_object('client_id',c.client_id,'data',
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(c.d)
       where key = any(array['ПІБ','Клієнт','Телефон','Джерело','Додаткові','Додатковий']))) order by c.client_id) from client_page c),'[]'::jsonb),
    'cars', coalesce((select jsonb_agg(jsonb_build_object('cars_id',c.cars_id,'client_id',c.client_id,'data',
      (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(c.d)
       where key = any(array['Авто','Номер авто','Vincode','VIN','Рік','Обʼєм','Об''єм','Пальне','КодДВЗ']))) order by c.cars_id) from car_page c),'[]'::jsonb),
    'clientCount',(select count(*) from matched_clients), 'carCount',(select count(*) from matched_cars)
  );
$$;
revoke all on function public.traffic_ai_lookup(text[],text,text,text,text,integer) from public;
grant execute on function public.traffic_ai_lookup(text[],text,text,text,text,integer) to anon, authenticated;

