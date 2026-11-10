-- ============================================================
-- Core-скіл: Повна схема БД (завантажується ЗАВЖДИ)
-- ============================================================

-- Спочатку фіксимо sequence щоб не було конфлікту з існуючим skill_id=22
SELECT setval('ai_skills_skill_id_seq', COALESCE((SELECT MAX(skill_id) FROM ai_skills), 0));

INSERT INTO public.ai_skills (name, category, keywords, prompt, is_active, priority)
VALUES (
  'Схема бази даних',
  'database',
  ARRAY[]::text[],  -- без keywords = core скіл (завантажується завжди)
  '📦 СХЕМА БАЗИ ДАНИХ СТО — КАРТА ТАБЛИЦЬ І ПОЛІВ

═══ acts (Акти / заказ-наряди) ═══
PK: act_id (bigint)
  date_on          — timestamptz, дата відкриття
  date_off         — timestamptz, дата закриття (NULL = відкритий)
  frozen           — bool, заморожений (виключити з фінансів)
  client_id        — FK → clients
  cars_id          — FK → cars
  avans            — numeric
  pruimalnyk       — text, приймальник
  slusarsOn        — bool
  rosraxovano      — text
  tupOplatu        — text
  data (JSONB):
    "ПІБ", "Телефон", "Марка", "Модель", "Держ. номер", "VIN", "Пробіг"
    "Приймальник", "Слюсар", "Причина звернення", "Рекомендації", "Примітки"
    "Знижка" (число), "За деталі" (число), "За роботу" (число)
    "Загальна сума" (число), "Прибуток за деталі", "Прибуток за роботу"
    "Роботи" — JSON масив: [{Робота, Кількість, Ціна, Зарплата, Прибуток}]
    "Деталі" — JSON масив: [{Деталь, Кількість, Ціна, Сума, Каталог, Магазин, sclad_id}]

═══ clients (Клієнти) ═══
PK: client_id
  data (JSONB):
    "ПІБ"         — прізвище ім''я по-батькові, ilike ''%Іванч%'' (обрізай закінчення!)
    "Телефон"      — +380..., ilike ''%0671234%''
    "Додаткові"    — примітки
    "Додатковий"   — другий телефон
    "Джерело"      — звідки клієнт (OLX, рекомендація...)

═══ cars (Автомобілі) ═══
PK: cars_id
  client_id        — FK → clients (власник)
  is_deleted       — bool (м''яке видалення, фільтруй is_deleted != true)
  data (JSONB):
    "Авто"         — марка+модель разом ("Ford Escape"), ilike ''%ford%''
    "Номер авто"   — держ номер ("AA1234BB")
    "Vincode"      — VIN-код (17 символів)
    "Рік"          — рік випуску (текст)
    "Об''єм"       — об''єм двигуна (текст, "1.5")
    "Пальне"       — тип пального ("Бензин", "Дизель")
    "КодДВЗ"       — код двигуна

═══ sclad (Склад) ═══
PK: sclad_id
  name             — назва деталі, ilike
  part_number      — артикул/каталожний номер
  price            — numeric, ціна за одиницю
  kilkist_on       — numeric, ПРИХІД (скільки надійшло)
  kilkist_off      — numeric, СПИСАННЯ (скільки списали)
  ❗ ЗАЛИШОК = COALESCE(kilkist_on,0) - COALESCE(kilkist_off,0). Колонки quantity НЕМАЄ!
  unit_measurement — одиниця виміру
  shops            — постачальник
  rahunok          — рахунок
  scladNomer       — номер полиці/складу
  akt              — FK → acts (акт куди списали)
  statys           — "На складі", "Замовити", "Замовлено"
  time_on          — timestamptz, час приходу
  time_off         — timestamptz, час списання
  receivers        — отримувач
  rosraxovano      — bool
  povernennya      — текст повернення
  xto_povernyv     — хто повернув
  xto_zamovuv      — хто замовив
  prumitka         — примітка

═══ slyusars (Працівники) ═══
PK: slyusar_id
  Name             — text, ПІБ
  namber           — табельний номер
  post_sluysar     — FK → post_name (посада)
  data (JSONB):
    "Name"            — ПІБ
    "Доступ"          — "Адміністратор" / "Слюсар" / "Приймальник" / "Запчастист" / "Складовщик"
    "Телефон"         — телефон
    "Посада"          — посада
    "ПроцентРоботи"   — відсоток зарплати від роботи
    "Історія"         — {дата: [{Акт, СуммаРоботи, ЗарплатаРоботи, ЗарплатаЗапчастин, Статус, Записи[]}]}

═══ vutratu (Витрати) ═══
PK: vutratu_id
  dataOnn          — timestamptz, дата
  kategoria        — текст (категорія витрати)
  suma             — numeric (сума, від''ємна = витрата)
  opys_vytraty     — текст (опис)
  sposob_oplaty    — текст (спосіб оплати)
  xto_zapusav      — хто записав
  act              — FK → acts

═══ post_arxiv (Бронювання постів / планування) ═══
PK: post_arxiv_id
  slyusar_id       — FK → slyusars
  name_post        — FK → post_name (пост/бокс)
  client_id        — FK → clients
  cars_id          — FK → cars
  act_id           — FK → acts
  status           — "Запланований" / "В роботі" / "Відремонтований" / "Не приїхав"
  data_on          — timestamptz, початок
  data_off         — timestamptz, кінець
  komentar         — текст

═══ post_name (Пости/бокси) ═══
PK: post_id
  name             — назва ("Бокс 1", "Яма 2")
  category         — FK → post_category

═══ post_category (Категорії постів) ═══
PK: category_id
  category         — текст ("Підйомник", "Яма")

═══ shops (Постачальники) ═══
PK: shop_id
  data (JSONB): "Name" — назва магазину

═══ works (Довідник робіт) ═══
PK: work_id
  data             — text (назва роботи, НЕ JSONB!)

═══ details (Довідник деталей) ═══
PK: detail_id
  data             — text (назва деталі, НЕ JSONB!)

═══ faktura (Рахунки-фактури) ═══
PK: faktura_id
  name, namber, act_id (FK → acts), oderjyvach

═══ atlas_reminders (Нагадування) ═══
PK: reminder_id
  title, description, reminder_type ("once"/"recurring"/"conditional")
  condition_query  — SQL для conditional
  recipients (JSONB) — масив ID або "self"/"all"/"mechanics"
  channel          — "app" / "telegram" / "both"
  priority         — "low" / "normal" / "high" / "urgent"
  schedule (JSONB) — {type, time, day, hours, minutes, days[]}
  status           — "active" / "completed" / "paused" / "cancelled"
  next_trigger_at, last_triggered_at, trigger_count
  created_by       — FK → slyusars

═══ audit_logs (Аудит) ═══
PK: id (bigint)
  created_at, user_login, user_role, action, act_id
  details (JSONB)  — деталі дії

═══ ЗВ''ЯЗКИ (FK) ═══
clients(1) → cars(N)       через cars.client_id
clients(1) → acts(N)       через acts.client_id
cars(1)    → acts(N)       через acts.cars_id
acts(1)    → sclad(N)      через sclad.akt
acts(1)    → faktura(N)    через faktura.act_id
acts(1)    → vutratu(N)    через vutratu.act
slyusars   → post_arxiv    через post_arxiv.slyusar_id

═══ ПРАВИЛА JSONB ЗАПИТІВ ═══
• Текстові поля: data->>''ПІБ'' (як text), фільтруй через ilike
• Числові поля: (data->>''За роботу'')::numeric для порівнянь
• Масиви: data->''Роботи'' — це JSON масив, шукай через jsonb_array_elements
• Імена/прізвища: ЗАВЖДИ обрізай закінчення! "Іванченко" → ilike ''%Іванченк%''
• cars.data->>''Авто'' містить марку+модель разом: ilike ''%BMW%'' або ilike ''%X5%''
• acts.data містить КОПІЮ даних клієнта/авто на момент закриття

═══ ТИПОВІ ПОМИЛКИ (НЕ РОБИ ТАК) ═══
• ❌ sclad.quantity — такого поля НЕМАЄ, рахуй kilkist_on - kilkist_off
• ❌ cars.data->>''Марка'' — НЕМАЄ окремого поля, є "Авто" (марка+модель)
• ❌ clients.data->>''Ім''''я'' — НЕМАЄ, є тільки "ПІБ" (все разом)
• ❌ acts.total — НЕМАЄ, рахуй (data->>''За роботу'')::numeric + (data->>''За деталі'')::numeric
• ❌ Фільтр deleted на cars — поле називається is_deleted (bool)',
  true,
  100  -- найвищий пріоритет, без keywords = core скіл, завантажується ЗАВЖДИ
);
