-- ═══════════════════════════════════════════════════════
-- 🔢 apply_sclad_delta — Атомарно оновлює kilkist_off у таблиці sclad
-- Приймає sclad_id та дельту (може бути від'ємною при видаленні з акту)
-- Використовує GREATEST(0, ...) для захисту від від'ємних значень
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_sclad_delta(sid INT, delta_val NUMERIC)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.sclad
  SET kilkist_off = GREATEST(COALESCE(kilkist_off, 0) + delta_val, 0)
  WHERE sclad_id = sid;
END;
$$;

-- Дозволити виклик через RPC
GRANT EXECUTE ON FUNCTION public.apply_sclad_delta(INT, NUMERIC) TO anon;
GRANT EXECUTE ON FUNCTION public.apply_sclad_delta(INT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sclad_delta(INT, NUMERIC) TO service_role;

COMMENT ON FUNCTION public.apply_sclad_delta(INT, NUMERIC) IS
'Атомарно змінює kilkist_off у таблиці sclad. delta_val > 0 — списання зі складу (додано в акт), delta_val < 0 — повернення на склад (видалено з акту). Мінімальне значення = 0.';
