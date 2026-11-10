# Міграції, згруповані за датою

Папки названі у форматі `місяць.день.рік`. Усередині лежать копії для перегляду; оригінальні міграції Supabase CLI читає з `../migrations/`. Не запускайте копії з цього каталогу окремо.

## 10.13.26 — 2 міграції

- [20261013120709_traffic_profit_date_compatibility.sql](./10.13.26/20261013120709_traffic_profit_date_compatibility.sql) — сумісність дат звіту «Прибуток» із timestamp, timestamptz, date і текстовими полями старих проєктів.

- [20261013105659_payroll_pending_recovery.sql](./10.13.26/20261013105659_payroll_pending_recovery.sql) — перелік незавершених нарахувань і запис зарплатного пакета за один акт із перевіркою виплат.

## 01.01.26 — 2 у групі, 0 інших файлів
- [20260101000000_create_execute_condition_query.sql](./01.01.26/20260101000000_create_execute_condition_query.sql)
- [20260101000001_set_replica_identity_full.sql](./01.01.26/20260101000001_set_replica_identity_full.sql)

## 03.08.26 — 1 у групі, 0 інших файлів
- [20260308120000_create_increment_token.sql](./03.08.26/20260308120000_create_increment_token.sql)

## 03.09.26 — 1 у групі, 0 інших файлів
- [20260309000000_create_apply_sclad_delta.sql](./03.09.26/20260309000000_create_apply_sclad_delta.sql)

## 03.18.26 — 1 у групі, 0 інших файлів
- [20260318000000_create_audit_logs.sql](./03.18.26/20260318000000_create_audit_logs.sql)

## 03.19.26 — 2 у групі, 0 інших файлів
- [20260319000000_audit_logs_auto_cleanup.sql](./03.19.26/20260319000000_audit_logs_auto_cleanup.sql)
- [20260319000001_optimize_get_due_reminders.sql](./03.19.26/20260319000001_optimize_get_due_reminders.sql)

## 03.20.26 — 1 у групі, 0 інших файлів
- [20260320000000_add_acts_frozen.sql](./03.20.26/20260320000000_add_acts_frozen.sql)

## 03.21.26 — 1 у групі, 0 інших файлів
- [20260321000000_create_ai_skills.sql](./03.21.26/20260321000000_create_ai_skills.sql)

## 03.22.26 — 1 у групі, 0 інших файлів
- [20260322000000_ai_messages_replica_identity.sql](./03.22.26/20260322000000_ai_messages_replica_identity.sql)

## 03.26.26 — 2 у групі, 0 інших файлів
- [20260326143000_refresh_ai_skills.sql](./03.26.26/20260326143000_refresh_ai_skills.sql)
- [20260326160000_add_parts_search_skill.sql](./03.26.26/20260326160000_add_parts_search_skill.sql)

## 03.28.26 — 2 у групі, 0 інших файлів
- [20260328000000_optimize_ai_skills.sql](./03.28.26/20260328000000_optimize_ai_skills.sql)
- [20260328100000_add_db_schema_skill.sql](./03.28.26/20260328100000_add_db_schema_skill.sql)

## 03.29.26 — 1 у групі, 0 інших файлів
- [20260329000000_add_formatting_skill.sql](./03.29.26/20260329000000_add_formatting_skill.sql)

## 03.30.26 — 1 у групі, 0 інших файлів
- [20260330000000_update_photo_docs_skill.sql](./03.30.26/20260330000000_update_photo_docs_skill.sql)

## 04.09.26 — 3 у групі, 0 інших файлів
- [20260409000000_fix_sql_functions_security.sql](./04.09.26/20260409000000_fix_sql_functions_security.sql)
- [20260409000001_hash_passwords_and_verify_rpc.sql](./04.09.26/20260409000001_hash_passwords_and_verify_rpc.sql)
- [20260409000002_restrict_whitelist_rls.sql](./04.09.26/20260409000002_restrict_whitelist_rls.sql)

## 04.10.26 — 3 у групі, 0 інших файлів
- [20260410000000_beautify_photo_docs_format.sql](./04.10.26/20260410000000_beautify_photo_docs_format.sql)
- [20260410100000_fix_ai_photos_storage_policy.sql](./04.10.26/20260410100000_fix_ai_photos_storage_policy.sql)
- [20260410200000_remove_password_hashing.sql](./04.10.26/20260410200000_remove_password_hashing.sql)

## 05.02.26 — 2 у групі, 0 інших файлів
- [20260502000000_schedule_check_reminders_cron.sql](./05.02.26/20260502000000_schedule_check_reminders_cron.sql)
- [20260502001000_dynamic_check_reminders_cron.sql](./05.02.26/20260502001000_dynamic_check_reminders_cron.sql)

## 05.05.26 — 1 у групі, 0 інших файлів
- [20260505190000_update_atlas_lookup_skills.sql](./05.05.26/20260505190000_update_atlas_lookup_skills.sql)

## 07.03.26 — 1 у групі, 0 інших файлів
- [20260703000000_add_sclad_client_price.sql](./07.03.26/20260703000000_add_sclad_client_price.sql)

## 09.27.26 — 1 у групі, 0 інших файлів
- [20260927000000_nova_poshta.sql](./09.27.26/20260927000000_nova_poshta.sql)

## 09.28.26 — 1 у групі, 0 інших файлів
- [20260928000000_nova_poshta_connection_controls.sql](./09.28.26/20260928000000_nova_poshta_connection_controls.sql)

## 10.02.26 — 2 у групі, 0 інших файлів
- [20261002000000_nova_poshta_shipment_details.sql](./10.02.26/20261002000000_nova_poshta_shipment_details.sql)
- [20261002120000_nova_poshta_online.sql](./10.02.26/20261002120000_nova_poshta_online.sql)

## 10.03.26 — 3 у групі, 0 інших файлів
- [20261003000000_nova_poshta_archive.sql](./10.03.26/20261003000000_nova_poshta_archive.sql)
- [20261003010000_nova_poshta_act_numbers.sql](./10.03.26/20261003010000_nova_poshta_act_numbers.sql)
- [20261003020000_nova_poshta_link_options.sql](./10.03.26/20261003020000_nova_poshta_link_options.sql)

## 10.04.26 — 1 у групі, 0 інших файлів
- [20261004000000_write_act_with_stock.sql](./10.04.26/20261004000000_write_act_with_stock.sql)

## 10.05.26 — 4 у групі, 0 інших файлів
- [20261005010000_traffic_detail_suggestions.sql](./10.05.26/20261005010000_traffic_detail_suggestions.sql)
- [20261005100000_traffic_service_book.sql](./10.05.26/20261005100000_traffic_service_book.sql)
- [20261005110000_traffic_act_read_models.sql](./10.05.26/20261005110000_traffic_act_read_models.sql)
- [20261005130000_traffic_reports.sql](./10.05.26/20261005130000_traffic_reports.sql)

## 10.06.26 — 5 у групі, 0 інших файлів
- [20261006010000_traffic_stock_directory.sql](./10.06.26/20261006010000_traffic_stock_directory.sql)
- [20261006020000_traffic_export_pages.sql](./10.06.26/20261006020000_traffic_export_pages.sql)
- [20261006030000_traffic_invoice_origins.sql](./10.06.26/20261006030000_traffic_invoice_origins.sql)
- [20261006040000_traffic_analytics.sql](./10.06.26/20261006040000_traffic_analytics.sql)
- [20261006050000_traffic_act_staff.sql](./10.06.26/20261006050000_traffic_act_staff.sql)

## 10.07.26 — 6 у групі, 0 інших файлів
- [20261007010000_traffic_stock_shop_names.sql](./10.07.26/20261007010000_traffic_stock_shop_names.sql)
- [20261007110000_traffic_stock_pages.sql](./10.07.26/20261007110000_traffic_stock_pages.sql)
- [20261007120000_traffic_client_form.sql](./10.07.26/20261007120000_traffic_client_form.sql)
- [20261007130000_traffic_service_history.sql](./10.07.26/20261007130000_traffic_service_history.sql)
- [20261007140000_traffic_offline_pages.sql](./10.07.26/20261007140000_traffic_offline_pages.sql)
- [20261007150000_traffic_stock_costs.sql](./10.07.26/20261007150000_traffic_stock_costs.sql)

## 10.08.26 — 2 у групі, 0 інших файлів
- [20261008010000_traffic_dashboard.sql](./10.08.26/20261008010000_traffic_dashboard.sql)
- [20261008020000_traffic_editor_catalog.sql](./10.08.26/20261008020000_traffic_editor_catalog.sql)

## 10.09.26 — 3 у групі, 0 інших файлів
- [20261009010000_traffic_editor_search.sql](./10.09.26/20261009010000_traffic_editor_search.sql)
- [20261009020000_traffic_analytics_staff.sql](./10.09.26/20261009020000_traffic_analytics_staff.sql)
- [20261009030000_traffic_client_values.sql](./10.09.26/20261009030000_traffic_client_values.sql)

## 10.10.26 — 1 у групі, 0 інших файлів
- [20261010010000_traffic_receipter_salaries.sql](./10.10.26/20261010010000_traffic_receipter_salaries.sql)

## 10.11.26 — 8 у групі, 21 інших файлів
- [20261004000000_write_act_with_stock.sql](./10.11.26/20261004000000_write_act_with_stock.sql)
- [20261011040000_stock_reference_resolve.sql](./10.11.26/20261011040000_stock_reference_resolve.sql)
- [20261011050000_stock_invoice_idempotency.sql](./10.11.26/20261011050000_stock_invoice_idempotency.sql)
- [20261011070000_act_editor_lease_guard.sql](./10.11.26/20261011070000_act_editor_lease_guard.sql)
- [20261011080000_payroll_fragments.sql](./10.11.26/20261011080000_payroll_fragments.sql)
- [20261011100000_reminder_delivery_claims.sql](./10.11.26/20261011100000_reminder_delivery_claims.sql)
- [20261011160000_act_save_receipts.sql](./10.11.26/20261011160000_act_save_receipts.sql)
- [20261011170000_directory_writes.sql](./10.11.26/20261011170000_directory_writes.sql)
- [Інші міграції — 21 файлів](./10.11.26/Інші%20міграції/)


## 10.12.26 — 5 міграцій

- [20261012102004_act_delta_save.sql](./10.12.26/20261012102004_act_delta_save.sql)
- [20261012103601_traffic_stock_lazy_page.sql](./10.12.26/20261012103601_traffic_stock_lazy_page.sql)
- [20261012122102_accounting_traffic_optimization.sql](./10.12.26/20261012122102_accounting_traffic_optimization.sql)
- [20261012131746_traffic_payroll_report_timeout.sql](./10.12.26/20261012131746_traffic_payroll_report_timeout.sql)
- [20261012133426_traffic_accounting_lazy_rows.sql](./10.12.26/20261012133426_traffic_accounting_lazy_rows.sql)
