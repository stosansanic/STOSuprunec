-- Лише читання. Виконати у SQL Editor проєкту eksifjzzszcqsufwcbsx.
-- Порівняння роботи в акті №1274 з її збереженою зарплатою.
-- Нічого не оновлює, не видаляє і не змінює позначки виплат.
with act_rows as (
  select a.act_id, a.date_on::text as history_date, w.value as work
  from public.acts a
  cross join lateral jsonb_array_elements(
    coalesce(nullif(public.payroll_json_object(to_jsonb(a.data))->'Роботи', 'null'::jsonb), '[]'::jsonb)
  ) w
  where a.act_id = 1274
    and w.value->>'Робота' ilike '%Полоскання%'
), employee as (
  select s.slyusar_id, public.payroll_json_object(to_jsonb(s.data)) as data
  from public.slyusars s
  where trim(public.payroll_json_object(to_jsonb(s.data))->>'Name') = 'Артем Д'
), payroll_rows as (
  select e.slyusar_id, e.data->>'Name' as employee_name, h.key as history_date,
    a.value as entry, w.value as work
  from employee e
  cross join lateral jsonb_each(coalesce(nullif(e.data->'Історія', 'null'::jsonb), '{}'::jsonb)) h
  cross join lateral jsonb_array_elements(h.value) a
  cross join lateral jsonb_array_elements(coalesce(nullif(a.value->'Записи', 'null'::jsonb), '[]'::jsonb)) w
  where a.value->>'Акт' = '1274'
    and w.value->>'Робота' ilike '%Полоскання%'
)
select 'Акт' as "Джерело", act_id::text as "Акт",
  work->>'slyusar_id' as "ID працівника", work->>'Слюсар' as "Працівник",
  work->>'Робота' as "Робота", work->>'recordId' as "ID рядка",
  work->>'Кількість' as "Кількість", work->>'Ціна' as "Ціна",
  work->>'Сума' as "Сума", work->>'Зарплата' as "Зарплата",
  null::text as "Виплата роботи", null::text as "Виплата всього нарахування",
  history_date as "Дата", work as "Повний рядок"
from act_rows
union all
select 'Історія зарплати', entry->>'Акт',
  slyusar_id::text, employee_name,
  work->>'Робота', work->>'recordId',
  work->>'Кількість', work->>'Ціна',
  work->>'Сума', work->>'Зарплата',
  work->>'Розраховано', entry->>'Розраховано',
  history_date, work
from payroll_rows
order by "Джерело", "Дата", "ID рядка";
