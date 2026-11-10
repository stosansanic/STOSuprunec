-- ═══════════════════════════════════════════════════════
-- 🔐 Обмеження whitelist: тільки authenticated SELECT,
-- модифікація тільки через service_role
-- ═══════════════════════════════════════════════════════

-- Видалити стару дозвільну policy на модифікацію
DROP POLICY IF EXISTS "whitelist_auth_modify" ON public.whitelist;

-- SELECT залишаємо для всіх (потрібно для перевірки email при вході)
-- Вже існує: whitelist_auth_select з USING (true)

-- Модифікація whitelist ТІЛЬКИ через service_role (Edge Functions, адмін-панель)
CREATE POLICY "whitelist_service_modify" ON public.whitelist
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════
-- ⚠️ Тепер для додавання/видалення email з whitelist
-- потрібно використовувати service_role ключ
-- (Edge Function або Supabase Dashboard)
-- ═══════════════════════════════════════════════════════
