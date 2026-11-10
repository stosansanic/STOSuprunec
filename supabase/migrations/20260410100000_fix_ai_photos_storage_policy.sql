-- Додаємо політику DELETE для bucket ai-photos (якщо відсутня)
-- Без цієї політики Supabase Storage не дозволяє видаляти файли через anon-ключ

-- Перевіряємо та створюємо bucket (якщо ще не існує)
INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-photos', 'ai-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Видаляємо старі політики (якщо є) щоб не дублювати
DROP POLICY IF EXISTS "Allow public read ai-photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon insert ai-photos" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon delete ai-photos" ON storage.objects;

-- SELECT — публічний читати
CREATE POLICY "Allow public read ai-photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'ai-photos');

-- INSERT — вставляти через anon-ключ
CREATE POLICY "Allow anon insert ai-photos"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'ai-photos');

-- DELETE — видаляти через anon-ключ (ЦЕ ГОЛОВНЕ ЩО БУЛО ВІДСУТНЄ)
CREATE POLICY "Allow anon delete ai-photos"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'ai-photos');
