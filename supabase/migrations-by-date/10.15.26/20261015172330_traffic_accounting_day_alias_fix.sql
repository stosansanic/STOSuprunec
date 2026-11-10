-- Виправлення syntax error at or near "day" у бухгалтерії складу та прибутку.
-- Виконати весь файл у Supabase SQL Editor потрібного проєкту.
-- Змінює лише псевдонім у вже встановлених функціях; дані таблиць не змінює.
-- DAY requires AS as a SELECT label. Dynamic SQL was only parsed on first use.
begin;

do $repair$
declare
  target record;
  function_id regprocedure;
  definition text;
  corrected text;
begin
  for target in
    select * from (values
      ('public.traffic_stock_accounting_rows(jsonb)',
       $stock$public.traffic_shop_date(case $4 when 'paid' then s.rosraxovano::text else s.time_on::text end) day$stock$,
       $stock$public.traffic_shop_date(case $4 when 'paid' then s.rosraxovano::text else s.time_on::text end) AS day$stock$),
      ('public.traffic_profit_accounting_rows(jsonb,jsonb)',
       $profit$public.traffic_profit_accounting_day(a.date_on::text) day$profit$,
       $profit$public.traffic_profit_accounting_day(a.date_on::text) AS day$profit$)
    ) as fixes(signature, before_sql, after_sql)
  loop
    function_id := to_regprocedure(target.signature);
    -- Some projects installed only one of the two accounting reports.
    if function_id is null then
      raise notice 'Функцію % не встановлено; пропущено.', target.signature;
      continue;
    end if;

    definition := pg_get_functiondef(function_id);
    corrected := replace(definition, target.before_sql, target.after_sql);
    if corrected is distinct from definition then
      -- Preserve the deployed body, signature, RLS mode, settings and grants.
      execute corrected;
      raise notice 'Виправлено: %', target.signature;
    elsif strpos(definition, target.after_sql) > 0 then
      raise notice 'Вже виправлено: %', target.signature;
    else
      raise exception 'Неочікувана версія функції %. Оновіть accounting-pages.sql.', target.signature;
    end if;
  end loop;
end $repair$;

notify pgrst, 'reload schema';
commit;
