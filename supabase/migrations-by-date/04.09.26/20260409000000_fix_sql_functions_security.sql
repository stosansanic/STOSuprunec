-- ═══════════════════════════════════════════════════════
-- 🔐 Виправлення безпеки SQL-функцій
-- 1. increment_token — REVOKE від anon
-- 2. execute_condition_query — блокування системних функцій
-- ═══════════════════════════════════════════════════════

-- ── 1. increment_token: закрити доступ для anon ──
REVOKE EXECUTE ON FUNCTION public.increment_token(INT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_token(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_token(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_token(INT, INT) TO service_role;

-- ── 2. execute_condition_query: додаткові блокування ──
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
  
  -- 🔐 Блокуємо доступ до системних таблиць та чутливих даних
  IF clean_query ~* '\b(pg_shadow|pg_auth|pg_roles|pg_user|information_schema|pg_catalog\.pg_auth|pg_stat_activity|pg_settings)\b' THEN
    RAISE EXCEPTION 'Доступ до системних таблиць заборонено';
  END IF;
  
  -- 🔐 Блокуємо підзапити з модифікацією (CTE з INSERT/UPDATE/DELETE)
  IF clean_query ~* '\bWITH\b.*\b(INSERT|UPDATE|DELETE)\b' THEN
    RAISE EXCEPTION 'CTE з модифікацією заборонені';
  END IF;

  -- 🔐 Блокуємо небезпечні системні функції
  IF clean_query ~* '\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_get|lo_put|copy|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|current_setting|pg_sleep|dblink|dblink_connect|dblink_exec)\s*\(' THEN
    RAISE EXCEPTION 'Виклик системних функцій заборонено';
  END IF;

  -- 🔐 Блокуємо доступ до таблиці whitelist та auth-схеми
  IF clean_query ~* '\b(whitelist|auth\.users|auth\.sessions|auth\.refresh_tokens|vault\.secrets)\b' THEN
    RAISE EXCEPTION 'Доступ до захищених таблиць заборонено';
  END IF;

  -- 🔐 Блокуємо COPY, INTO OUTFILE та інші спроби запису
  IF clean_query ~* '\b(COPY|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b' THEN
    RAISE EXCEPTION 'Операції запису заборонені';
  END IF;
  
  -- Виконуємо запит і повертаємо результат як JSON масив
  EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), ''[]''::jsonb) FROM (%s) t', clean_query)
  INTO result;
  
  RETURN result;
END;
$$;

-- 🔐 Дозволити виклик лише через authenticated та service_role (не anon)
REVOKE EXECUTE ON FUNCTION public.execute_condition_query(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.execute_condition_query(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_condition_query(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_condition_query(TEXT) TO service_role;

COMMENT ON FUNCTION public.execute_condition_query(TEXT) IS 
'Виконує безпечний SELECT-запит для перевірки умов у нагадуваннях. Повертає JSONB масив рядків. Захищено від SQL injection та системних функцій.';
