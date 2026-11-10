-- ═══════════════════════════════════════════════════════
-- 🔢 increment_token — Атомарно збільшує лічильник токенів
-- Приймає setting_id та кількість токенів для додавання
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.increment_token(sid INT, amount INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.settings
  SET token = COALESCE(token, 0) + amount
  WHERE setting_id = sid;
END;
$$;
