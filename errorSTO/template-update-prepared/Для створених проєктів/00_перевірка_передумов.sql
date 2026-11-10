-- Лише читання схеми, без бізнес-даних. Відсутні об’єкти потрібно звірити до встановлення.
select name, to_regclass('public.' || name) is not null as exists_in_database
from unnest(array['acts','cars','clients','sclad','details','works','shops','slyusars','incomes','receivers','faktura','act_locks','atlas_reminders','atlas_reminder_logs']) name;
select p.proname, pg_get_function_identity_arguments(p.oid) arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('write_act_with_stock','trigger_reminder','guarded_write_act_with_stock_receipt','traffic_directory_write')
order by p.proname;
select table_name,column_name,data_type from information_schema.columns
where table_schema='public' and table_name in ('acts','sclad','act_locks','atlas_reminders','atlas_reminder_logs')
order by table_name,ordinal_position;
