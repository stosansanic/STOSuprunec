-- ─────────────────────────────────────────────────────────────────────────────
-- Автоматичне очищення audit_logs через pg_cron
-- Зберігаємо: 90 днів
-- Запуск: щодня о 03:00 UTC (05:00 за Київським часом)
-- ─────────────────────────────────────────────────────────────────────────────

-- Увімкнути розширення pg_cron (якщо не увімкнено)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Видалити старий job якщо вже існує (безпечно при повторному запуску)
SELECT cron.unschedule('audit_logs_cleanup')
WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'audit_logs_cleanup'
);

-- Створити job: щодня о 03:00 UTC видаляти записи старші 90 днів
SELECT cron.schedule(
    'audit_logs_cleanup',                          -- назва job-а
    '0 3 * * *',                                   -- щодня о 03:00 UTC
    $$
        DELETE FROM public.audit_logs
        WHERE created_at < NOW() - INTERVAL '90 days';
    $$
);
