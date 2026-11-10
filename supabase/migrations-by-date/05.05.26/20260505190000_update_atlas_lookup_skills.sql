-- Atlas: точна перевірка існування клієнта/авто перед створенням картки

UPDATE public.ai_skills
SET
  category = 'database',
  updated_at = now()
WHERE name IN ('Оптимізація JSONB', 'Моніторинг розміру БД')
  AND category <> 'database';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ai_skills
    WHERE name = 'Перевірка існування клієнта/авто'
  ) THEN
    UPDATE public.ai_skills
    SET
      category = 'database',
      keywords = ARRAY[
        'перевір',
        'чи є',
        'існує',
        'є в базі',
        'клієнт',
        'авто',
        'машина',
        'телефон',
        'vin',
        'вінкод',
        'номер авто',
        'держ номер'
      ],
      prompt = $skill$
Коли користувач питає, чи є клієнт або авто в базі, НЕ обмежуйся таблицею clients.

Обов'язково використовуй multi_query_database і перевіряй усі можливі джерела:
1. clients по data->>'ПІБ' через ilike з основою прізвища/імені.
2. clients по data->>'Телефон' з урахуванням різних форматів телефону.
3. cars по data->>'Vincode', data->>'VIN' і data->>'Номер авто'.
4. acts по data->>'ПІБ', data->>'Телефон', data->>'VIN' і data->>'Держ. номер'.

Правила відповіді:
- якщо clients порожній, але cars знайдено — пиши "авто знайдено, картку клієнта треба перевірити";
- якщо clients порожній, але acts знайдено — пиши "є історія в актах, окрема картка клієнта не знайдена";
- якщо знайдено клієнта і авто — покажи клієнта, телефон, авто, номер і VIN;
- висновок "немає в базі" дозволений тільки після перевірки clients + cars + acts.
$skill$,
      priority = 92,
      is_active = true,
      updated_at = now()
    WHERE name = 'Перевірка існування клієнта/авто';
  ELSE
    INSERT INTO public.ai_skills (
      name,
      category,
      keywords,
      prompt,
      is_active,
      priority,
      created_at,
      updated_at
    )
    VALUES (
      'Перевірка існування клієнта/авто',
      'database',
      ARRAY[
        'перевір',
        'чи є',
        'існує',
        'є в базі',
        'клієнт',
        'авто',
        'машина',
        'телефон',
        'vin',
        'вінкод',
        'номер авто',
        'держ номер'
      ],
      $skill$
Коли користувач питає, чи є клієнт або авто в базі, НЕ обмежуйся таблицею clients.

Обов'язково використовуй multi_query_database і перевіряй усі можливі джерела:
1. clients по data->>'ПІБ' через ilike з основою прізвища/імені.
2. clients по data->>'Телефон' з урахуванням різних форматів телефону.
3. cars по data->>'Vincode', data->>'VIN' і data->>'Номер авто'.
4. acts по data->>'ПІБ', data->>'Телефон', data->>'VIN' і data->>'Держ. номер'.

Правила відповіді:
- якщо clients порожній, але cars знайдено — пиши "авто знайдено, картку клієнта треба перевірити";
- якщо clients порожній, але acts знайдено — пиши "є історія в актах, окрема картка клієнта не знайдена";
- якщо знайдено клієнта і авто — покажи клієнта, телефон, авто, номер і VIN;
- висновок "немає в базі" дозволений тільки після перевірки clients + cars + acts.
$skill$,
      true,
      92,
      now(),
      now()
    );
  END IF;
END $$;

UPDATE public.ai_skills
SET
  prompt = prompt || $append$

---
🔎 ПЕРЕВІРКА ІСНУВАННЯ ПЕРЕД СТВОРЕННЯМ
Перед відповіддю "даних не знайдено" або пропозицією створити нового клієнта перевір:
- clients по ПІБ і телефону;
- cars по VIN, Vincode і номеру авто;
- acts по ПІБ, телефону, VIN і держ. номеру.
Якщо знайдено авто або акт, не кажи просто "клієнта немає" — поясни, де саме є збіг.
$append$,
  updated_at = now()
WHERE name IN ('Клієнти', 'Авто')
  AND prompt NOT ILIKE '%ПЕРЕВІРКА ІСНУВАННЯ ПЕРЕД СТВОРЕННЯМ%';

UPDATE public.ai_skills
SET
  prompt = prompt || $append$

---
🔎 ПЕРЕВІРКА БД ПІСЛЯ OCR
Після розпізнавання документа або сервісної книжки, якщо є ПІБ, телефон, VIN або номер авто:
1. Спочатку перевір clients, cars і acts через multi_query_database.
2. Не пропонуй "Внести клієнта та авто в базу", доки не перевіриш ці таблиці.
3. Якщо авто знайдено по VIN/номеру, але клієнт не знайдений у clients — напиши це окремо.
4. Якщо є історія тільки в acts — напиши "є історія в актах".
$append$,
  updated_at = now()
WHERE name = 'Фото документів'
  AND prompt NOT ILIKE '%ПЕРЕВІРКА БД ПІСЛЯ OCR%';

UPDATE public.ai_skills
SET
  prompt = prompt || $append$

---
🔎 ПЕРЕКЛАД ЗАПИТІВ "ЧИ Є В БАЗІ"
"перевір чи є Сергій клієнт" =
multi_query_database:
1. clients where data->>'ПІБ' ilike '%Сергій%';
2. acts where data->>'ПІБ' ilike '%Сергій%'.

"перевір AB3080MA" =
multi_query_database:
1. cars where data->>'Номер авто' ilike '%AB3080MA%';
2. acts where data->>'Держ. номер' ilike '%AB3080MA%'.

"перевір VIN 1FMCU9G6XLUA81694" =
multi_query_database:
1. cars where data->>'Vincode' ilike '%1FMCU9G6XLUA81694%';
2. cars where data->>'VIN' ilike '%1FMCU9G6XLUA81694%';
3. acts where data->>'VIN' ilike '%1FMCU9G6XLUA81694%'.
$append$,
  updated_at = now()
WHERE name = 'Перекладач запитів'
  AND prompt NOT ILIKE '%ПЕРЕКЛАД ЗАПИТІВ "ЧИ Є В БАЗІ"%';
