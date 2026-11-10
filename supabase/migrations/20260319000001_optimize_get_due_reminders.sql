-- ═════════════════════════════════════════════════════════════════════════
-- Оптимізація системи нагадувань
-- ═════════════════════════════════════════════════════════════════════════

-- ── 1. Складений індекс для швидкого пошуку due нагадувань ──────────────
CREATE INDEX IF NOT EXISTS idx_reminders_status_next
    ON public.atlas_reminders (status, next_trigger_at ASC)
    WHERE status = 'active' AND next_trigger_at IS NOT NULL;


-- ── 2. Оптимізована get_due_reminders ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_due_reminders()
RETURNS TABLE (
    reminder_id     BIGINT,
    title           TEXT,
    description     TEXT,
    reminder_type   TEXT,
    recipients      JSONB,
    channel         TEXT,
    priority        TEXT,
    condition_query TEXT,
    schedule        JSONB,
    trigger_count   INTEGER,
    created_by      BIGINT,
    creator_name    TEXT,
    meta            JSONB
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT
        r.reminder_id,
        r.title,
        r.description,
        r.reminder_type,
        r.recipients,
        r.channel,
        r.priority,
        r.condition_query,
        r.schedule,
        r.trigger_count,
        r.created_by,
        COALESCE(s.data->>'Name', '—') AS creator_name,
        r.meta
    FROM public.atlas_reminders r
    LEFT JOIN public.slyusars s ON s.slyusar_id = r.created_by
    WHERE r.status = 'active'
      AND r.next_trigger_at IS NOT NULL
      AND r.next_trigger_at <= NOW()
    ORDER BY
        CASE r.priority
            WHEN 'urgent' THEN 1
            WHEN 'high'   THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low'    THEN 4
            ELSE 5
        END,
        r.next_trigger_at ASC
    LIMIT 50;
$$;

REVOKE EXECUTE ON FUNCTION public.get_due_reminders() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_due_reminders() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_due_reminders() TO service_role;


-- ── 3. Виправлена trigger_reminder — interval враховує hours і minutes ───
CREATE OR REPLACE FUNCTION public.trigger_reminder(p_reminder_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_type     TEXT;
    v_schedule JSONB;
    v_next     TIMESTAMPTZ;
    v_hours    INT;
    v_minutes  INT;
BEGIN
    SELECT reminder_type, schedule
    INTO v_type, v_schedule
    FROM public.atlas_reminders
    WHERE reminder_id = p_reminder_id;

    IF NOT FOUND THEN RETURN; END IF;

    IF v_type = 'once' THEN
        UPDATE public.atlas_reminders SET
            status            = 'completed',
            last_triggered_at = NOW(),
            trigger_count     = trigger_count + 1,
            next_trigger_at   = NULL,
            updated_at        = NOW()
        WHERE reminder_id = p_reminder_id;

    ELSIF v_type IN ('recurring', 'conditional') THEN
        v_next := NULL;

        IF v_schedule IS NOT NULL THEN
            CASE v_schedule->>'type'
                WHEN 'daily' THEN
                    v_next := (CURRENT_DATE + 1)::TIMESTAMPTZ
                              + (COALESCE(v_schedule->>'time', '09:00'))::TIME;

                WHEN 'weekly' THEN
                    v_next := NOW() + INTERVAL '7 days';

                WHEN 'monthly' THEN
                    v_next := (DATE_TRUNC('month', NOW()) + INTERVAL '1 month')::DATE
                              + (COALESCE((v_schedule->>'day')::INT - 1, 0)) * INTERVAL '1 day'
                              + (COALESCE(v_schedule->>'time', '09:00'))::TIME;

                WHEN 'interval' THEN
                    -- ✅ Виправлено: враховуємо і hours, і minutes
                    v_hours   := COALESCE((v_schedule->>'hours')::INT, 0);
                    v_minutes := COALESCE((v_schedule->>'minutes')::INT, 0);

                    -- Якщо обидва нулі — ставимо 1 годину за замовчуванням
                    IF v_hours = 0 AND v_minutes = 0 THEN
                        v_hours := 1;
                    END IF;

                    v_next := NOW()
                              + (v_hours   * INTERVAL '1 hour')
                              + (v_minutes * INTERVAL '1 minute');

                ELSE
                    v_next := NOW() + INTERVAL '1 hour';
            END CASE;
        ELSE
            v_next := NOW() + INTERVAL '1 hour';
        END IF;

        UPDATE public.atlas_reminders SET
            last_triggered_at = NOW(),
            trigger_count     = trigger_count + 1,
            next_trigger_at   = v_next,
            updated_at        = NOW()
        WHERE reminder_id = p_reminder_id;
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trigger_reminder(BIGINT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.trigger_reminder(BIGINT) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.trigger_reminder(BIGINT) TO service_role;

-- ═════════════════════════════════════════════════════════════════════════
NOTIFY pgrst, 'reload schema';
-- ═════════════════════════════════════════════════════════════════════════
