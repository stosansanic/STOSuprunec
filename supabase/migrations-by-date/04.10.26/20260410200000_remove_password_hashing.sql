-- ═══════════════════════════════════════════════════════
-- 🔓 Прибрати хешування паролів — просте порівняння
-- ═══════════════════════════════════════════════════════

-- ── 1. Видалити тригер хешування ──
DROP TRIGGER IF EXISTS trigger_hash_slyusar_password ON public.slyusars;
DROP FUNCTION IF EXISTS public.hash_slyusar_password();

-- ── 2. Замінити RPC verify_slyusar_password на просте порівняння ──
CREATE OR REPLACE FUNCTION public.verify_slyusar_password(
  input_name TEXT,
  input_password TEXT
)
RETURNS TABLE(
  is_valid BOOLEAN,
  slyusar_id INT,
  user_role TEXT,
  user_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  stored_pass TEXT;
BEGIN
  FOR rec IN
    SELECT s.slyusar_id AS sid, s.data
    FROM public.slyusars s
    WHERE LOWER(TRIM(s.data->>'Name')) = LOWER(TRIM(input_name))
  LOOP
    stored_pass := rec.data->>'Пароль';
    
    IF stored_pass IS NOT NULL AND stored_pass != '' 
       AND TRIM(stored_pass) = TRIM(input_password) THEN
      RETURN QUERY SELECT 
        true, 
        rec.sid, 
        COALESCE(rec.data->>'Доступ', 'Адміністратор'), 
        (rec.data->>'Name')::TEXT;
      RETURN;
    END IF;
  END LOOP;
  
  RETURN QUERY SELECT false, NULL::INT, NULL::TEXT, NULL::TEXT;
END;
$$;

-- ── 3. Замінити RPC verify_slyusar_password_by_id на просте порівняння ──
CREATE OR REPLACE FUNCTION public.verify_slyusar_password_by_id(
  input_slyusar_id INT,
  input_password TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stored_pass TEXT;
BEGIN
  SELECT data->>'Пароль'
  INTO stored_pass
  FROM public.slyusars
  WHERE slyusar_id = input_slyusar_id;
  
  IF stored_pass IS NULL OR stored_pass = '' THEN
    RETURN false;
  END IF;
  
  RETURN TRIM(stored_pass) = TRIM(input_password);
END;
$$;
