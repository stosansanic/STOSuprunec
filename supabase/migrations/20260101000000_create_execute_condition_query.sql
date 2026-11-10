-- ═══════════════════════════════════════════════════════
-- 📊 execute_condition_query — Виконує SQL SELECT-запит для умовних нагадувань
-- Приймає текст SQL-запиту, перевіряє що це SELECT,
-- виконує і повертає результат як JSON-масив.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.execute_condition_query(query_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
  clean_query TEXT;
BEGIN
  -- Очистити запит
  clean_query := TRIM(query_text);
  
  -- Видалити крапку з комою в кінці якщо є
  clean_query := RTRIM(clean_query, ';');
  
  -- Безпека: дозволяємо тільки SELECT
  IF NOT (UPPER(LEFT(clean_query, 6)) = 'SELECT') THEN
    RAISE EXCEPTION 'Дозволені тільки SELECT запити';
  END IF;
  
  -- Перевіряємо на небезпечні операції
  IF clean_query ~* '\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE)\b' THEN
    RAISE EXCEPTION 'Запит містить заборонені операції';
  END IF;
  
  -- Виконуємо запит і повертаємо результат як JSON масив
  EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), ''[]''::jsonb) FROM (%s) t', clean_query)
  INTO result;
  
  RETURN result;
END;
$$;

-- Дозволити виклик через RPC (anon та authenticated)
GRANT EXECUTE ON FUNCTION public.execute_condition_query(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.execute_condition_query(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_condition_query(TEXT) TO service_role;

-- Коментар
COMMENT ON FUNCTION public.execute_condition_query(TEXT) IS 
'Виконує безпечний SELECT-запит для перевірки умов у нагадуваннях. Повертає JSONB масив рядків.';
