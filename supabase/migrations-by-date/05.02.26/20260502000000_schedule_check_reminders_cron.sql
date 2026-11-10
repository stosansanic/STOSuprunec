-- Серверний запуск Telegram-нагадувань без відкритого браузера.
-- pg_cron кожну хвилину викликає Supabase Edge Function check-reminders.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('atlas_check_reminders_every_minute')
WHERE EXISTS (
  SELECT 1
  FROM cron.job
  WHERE jobname = 'atlas_check_reminders_every_minute'
);

SELECT cron.schedule(
  'atlas_check_reminders_every_minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://yeouatwoanncfgjgqhyi.supabase.co/functions/v1/check-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-atlas-cron', 'check-reminders'
    ),
    body := jsonb_build_object('source', 'pg_cron')
  );
  $$
);

NOTIFY pgrst, 'reload schema';
