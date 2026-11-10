-- ═══════════════════════════════════════════════════════
-- 🔐 Хешування паролів + RPC верифікація
-- ⚠️ ВАЖЛИВО: Зробіть бекап БД перед запуском!
-- ═══════════════════════════════════════════════════════

-- ── 1. Увімкнути pgcrypto для хешування ──
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 2. Хешувати всі існуючі паролі в slyusars.data ──
-- Паролі зберігаються в JSONB полі data->>'Пароль'
-- Замінюємо plaintext на bcrypt хеш
UPDATE public.slyusars
SET data = jsonb_set(
  data,
  '{Пароль}',
  to_jsonb(crypt(data->>'Пароль', gen_salt('bf', 10)))
)
WHERE data->>'Пароль' IS NOT NULL
  AND data->>'Пароль' != ''
  AND data->>'Пароль' NOT LIKE '$2a$%'
  AND data->>'Пароль' NOT LIKE '$2b$%';

-- ── 3. RPC: Верифікація пароля по імені ──
-- Використовується фронтендом та Telegram-ботом
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
  stored_hash TEXT;
  found_name TEXT;
  found_role TEXT;
  found_id INT;
BEGIN
  -- Шукаємо користувача за ім'ям (case-insensitive)
  FOR rec IN
    SELECT s.slyusar_id AS sid, s.data
    FROM public.slyusars s
    WHERE LOWER(TRIM(s.data->>'Name')) = LOWER(TRIM(input_name))
  LOOP
    stored_hash := rec.data->>'Пароль';
    
    IF stored_hash IS NOT NULL AND stored_hash != '' THEN
      -- Перевіряємо bcrypt хеш
      IF crypt(input_password, stored_hash) = stored_hash THEN
        found_id := rec.sid;
        found_name := rec.data->>'Name';
        found_role := COALESCE(rec.data->>'Доступ', 'Адміністратор');
        
        RETURN QUERY SELECT true, found_id, found_role, found_name;
        RETURN;
      END IF;
    END IF;
  END LOOP;
  
  -- Не знайдено або невірний пароль
  RETURN QUERY SELECT false, NULL::INT, NULL::TEXT, NULL::TEXT;
END;
$$;

-- 🔐 Дозволити виклик authenticated та service_role
REVOKE EXECUTE ON FUNCTION public.verify_slyusar_password(TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_slyusar_password(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_slyusar_password(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_slyusar_password(TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.verify_slyusar_password(TEXT, TEXT) IS 
'Безпечна перевірка пароля слюсаря через bcrypt. Повертає is_valid, slyusar_id, user_role, user_name.';

-- ── 4. RPC: Верифікація пароля по slyusar_id (для підтвердження дій) ──
CREATE OR REPLACE FUNCTION public.verify_slyusar_password_by_id(
  input_slyusar_id INT,
  input_password TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stored_hash TEXT;
BEGIN
  SELECT data->>'Пароль'
  INTO stored_hash
  FROM public.slyusars
  WHERE slyusar_id = input_slyusar_id;
  
  IF stored_hash IS NULL OR stored_hash = '' THEN
    RETURN false;
  END IF;
  
  RETURN crypt(input_password, stored_hash) = stored_hash;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.verify_slyusar_password_by_id(INT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_slyusar_password_by_id(INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_slyusar_password_by_id(INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_slyusar_password_by_id(INT, TEXT) TO service_role;

COMMENT ON FUNCTION public.verify_slyusar_password_by_id(INT, TEXT) IS 
'Перевірка пароля за slyusar_id. Для підтвердження дій (відкриття акту тощо).';

-- ── 5. Тригер: автоматично хешувати паролі при INSERT/UPDATE ──
-- Якщо пароль не схожий на bcrypt хеш — хешуємо його
CREATE OR REPLACE FUNCTION public.hash_slyusar_password()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_pass TEXT;
BEGIN
  current_pass := NEW.data->>'Пароль';
  
  IF current_pass IS NOT NULL 
     AND current_pass != '' 
     AND current_pass NOT LIKE '$2a$%' 
     AND current_pass NOT LIKE '$2b$%' THEN
    NEW.data := jsonb_set(
      NEW.data,
      '{Пароль}',
      to_jsonb(crypt(current_pass, gen_salt('bf', 10)))
    );
  END IF;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_hash_slyusar_password ON public.slyusars;
CREATE TRIGGER trigger_hash_slyusar_password
  BEFORE INSERT OR UPDATE ON public.slyusars
  FOR EACH ROW
  EXECUTE FUNCTION public.hash_slyusar_password();
