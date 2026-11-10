-- Динамічний Telegram-cron:
-- створюється тільки коли є active нагадування з channel telegram/both,
-- і сам видаляється коли таких нагадувань більше немає.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN PERFORM cron.unschedule('check-reminders-every-minute'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('check-reminders-conditional-minute'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('atlas_check_reminders_every_minute'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.sync_atlas_reminder_cron_now()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
DECLARE
    has_active_telegram boolean;
    job_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.atlas_reminders
        WHERE status = 'active'
          AND channel IN ('telegram', 'both')
        LIMIT 1
    )
    INTO has_active_telegram;

    SELECT EXISTS (
        SELECT 1
        FROM cron.job
        WHERE jobname = 'atlas_check_reminders_every_minute'
    )
    INTO job_exists;

    IF has_active_telegram AND NOT job_exists THEN
        PERFORM cron.schedule(
            'atlas_check_reminders_every_minute',
            '* * * * *',
            $cron$
            SELECT net.http_post(
                url := 'https://yeouatwoanncfgjgqhyi.supabase.co/functions/v1/check-reminders',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'x-atlas-cron', 'check-reminders'
                ),
                body := jsonb_build_object('source', 'pg_cron'),
                timeout_milliseconds := 5000
            );
            $cron$
        );
    ELSIF NOT has_active_telegram AND job_exists THEN
        PERFORM cron.unschedule('atlas_check_reminders_every_minute');
    END IF;

    RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_now() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_now() FROM public;
GRANT EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_now() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_now() TO service_role;

CREATE OR REPLACE FUNCTION public.sync_atlas_reminder_cron_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
BEGIN
    PERFORM public.sync_atlas_reminder_cron_now();
    RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_trigger() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_trigger() FROM public;
GRANT EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_trigger() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_atlas_reminder_cron_trigger() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_atlas_reminder_cron ON public.atlas_reminders;
CREATE TRIGGER trg_sync_atlas_reminder_cron
    AFTER INSERT OR UPDATE OR DELETE ON public.atlas_reminders
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.sync_atlas_reminder_cron_trigger();

-- Переналаштувати поточний стан одразу після встановлення.
DO $$
BEGIN
    PERFORM public.sync_atlas_reminder_cron_now();
END $$;

NOTIFY pgrst, 'reload schema';
