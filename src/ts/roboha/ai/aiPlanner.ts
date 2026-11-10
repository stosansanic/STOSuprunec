// ═══════════════════════════════════════
// � aiPlanner.ts — Повідомлення Атласа
// CRUD нагадувань + рендеринг UI
// ═══════════════════════════════════════

import { supabase } from "../../vxid/supabaseClient";
import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";
import { REMINDER_CHANGE_COLUMNS } from "./reminderRealtime";
import { createLatestCallbackReader } from "./reminderCallbackRead";
import {
  cancelDeleteCountdown,
  isDeleteCountdownActive,
  startDeleteCountdown,
} from "./deleteCountdown";

// ── AI генерація SQL ──

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENROUTER_MODEL = "openrouter/free";

interface AIKeyInfo {
  key: string;
  settingId: number;
}

async function loadAIKeys(): Promise<AIKeyInfo[]> {
  try {
    const { data } = await supabase
      .from("settings")
      .select('setting_id, "Загальні"')
      .gte("setting_id", 20)
      .not("Загальні", "is", null)
      .order("setting_id");
    if (!data) return [];
    return data
      .filter(
        (r: any) =>
          r["Загальні"] &&
          typeof r["Загальні"] === "string" &&
          r["Загальні"].trim(),
      )
      .map((r: any) => ({
        key: r["Загальні"].trim(),
        settingId: r.setting_id,
      }));
  } catch {
    return [];
  }
}

/**
 * Додає токени до лічильника ключа в БД (інкрементно — безпечно для конкурентного доступу)
 */
async function addTokensToDB(
  settingId: number,
  tokensToAdd: number,
): Promise<void> {
  if (settingId <= 0 || tokensToAdd <= 0) return;
  try {
    await supabase
      .rpc("increment_token", { sid: settingId, amount: tokensToAdd })
      .maybeSingle();
  } catch {
    // Фолбек: читаємо поточне значення і оновлюємо
    try {
      const { data } = await supabase
        .from("settings")
        .select("token")
        .eq("setting_id", settingId)
        .single();
      const current = (data as any)?.token ?? 0;
      await supabase
        .from("settings")
        .update({ token: current + tokensToAdd })
        .eq("setting_id", settingId);
    } catch {
      /* silent */
    }
  }
}

async function callGroqPlanner(
  key: string,
  settingId: number,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<any> {
  const { data, error } = await supabase.functions.invoke("groq-chat", {
    body: {
      setting_id: settingId > 0 ? settingId : null,
      api_key: settingId > 0 ? undefined : key,
      request: {
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
      },
    },
  });

  if (error || !data?.ok) {
    throw new Error(data?.errorText || error?.message || "Groq API error");
  }

  return data.data;
}

async function callOpenRouterPlanner(
  key: string,
  settingId: number,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
): Promise<any> {
  const { data, error } = await supabase.functions.invoke("openrouter-chat", {
    body: {
      setting_id: settingId > 0 ? settingId : null,
      api_key: settingId > 0 ? undefined : key,
      request: {
        model: OPENROUTER_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
      },
    },
  });

  if (error || !data?.ok) {
    throw new Error(
      data?.errorText || error?.message || "OpenRouter API error",
    );
  }

  return data.data;
}

const SQL_SYSTEM_PROMPT = `SQL-генератор PostgreSQL для СТО. Поверни ТІЛЬКИ SELECT-запит.

БД:
acts: act_id(PK),date_on(ts),date_off(ts|null=відкритий),slusarsOn(bool),client_id→clients,cars_id→cars,avans(число),pruimalnyk(текст),frozen(bool),data{ПІБ,Телефон,Марка,Модель,"Держ. номер",VIN,Пробіг,Приймальник,Слюсар,"Причина звернення",Рекомендації,Знижка,Аванс,"За деталі","За роботу","Загальна сума","Прибуток за деталі","Прибуток за роботу",Роботи[{Робота,Кількість,Ціна,Зарплата,Прибуток}],Деталі[{Деталь,Кількість,Ціна,Сума,Каталог,Магазин,sclad_id}]}
clients: client_id(PK),data{ПІБ,Телефон,Email,Додаткові(примітки),Додатковий(дод.тел),Джерело}
cars: cars_id(PK),client_id→clients,data{Авто(марка+модель),"Номер авто"(держ.номер),Vincode,VIN,Рік,Марка,Модель,Обʼєм,Пальне,КодДВЗ}
slyusars: slyusar_id(PK),Name(ПІБ),namber(табельний),post_sluysar→post_name,data{Name,"Ім'я",Доступ,Телефон,Посада,ПроцентРоботи,Історія{"дата":[{Акт,ЗарплатаРоботи,ЗарплатаЗапчастин,СуммаРоботи,Статус}]}}
sclad: sclad_id(PK),name(назва),part_number(артикул),price(ціна),kilkist_on(прихід),kilkist_off(розхід),quantity(залишок),unit_measurement(од),shops(постачальник),rahunok(рахунок),scladNomer(полиця),akt→acts,rosraxovano(bool),time_on(дата),statys(статус)
vutratu: vutratu_id(PK),dataOnn(ts дата),kategoria(текст),suma(число),opys_vytraty(текст),sposob_oplaty(текст),xto_zapusav(текст)
faktura: faktura_id(PK),name(назва),namber(номер),act_id→acts,oderjyvach(отримувач)
shops: shop_id(PK),data{Name,Історія[]}
post_category: category_id(PK),category(назва)
post_name: post_id(PK),name(назва поста/боксу),category→post_category
post_arxiv: slyusar_id→slyusars,name_post→post_name,client_id→clients,cars_id→cars,status(Запланований|В роботі|Відремонтований|Не приїхав),data_on(початок),data_off(кінець),komentar,act_id→acts
atlas_reminders: reminder_id(PK),title,description,reminder_type(once|recurring|conditional),condition_query,recipients(JSONB),channel(app|telegram|both),priority,schedule(JSONB),status(active|completed|paused),next_trigger_at,created_by→slyusars
settings: setting_id(PK),"Загальні"(text),API(bool),data(JSONB),token(int),date
works: work_id(PK),data(назва роботи)
details: detail_id(PK),data(назва деталі)
audit_logs: id(PK),created_at,user_login,user_role,action,act_id,details(JSONB)

ЗВ'ЯЗКИ: clients(1)→cars(N)→acts(N)→sclad.akt(N), acts→faktura(N), slyusars→post_arxiv(N), post_name→post_arxiv(N)

ПРАВИЛА:
1. ТІЛЬКИ SELECT 2. Відкритий: date_off IS NULL 3. Старіший N днів: date_on<NOW()-INTERVAL'N days'
4. JSONB: data->>'ПІБ' 5. Слюсар→acts.data->>'Слюсар'=slyusars."Name"
6. Тільки SQL, без пояснень/\`\`\`sql/коментарів
7. JSONB значення=TEXT! Для чисел: (data->>'Загальна сума')::numeric
8. Масив JSONB: jsonb_array_length(data->'Роботи'), data->'Роботи' @> '[{"Робота":"Заміна масла"}]'

AS з УКРАЇНСЬКИМИ назвами: act_id AS "Акт №", date_on AS "Дата відкриття", date_off AS "Дата закриття", data->>'ПІБ' AS "Клієнт", data->>'Телефон' AS "Телефон", data->>'Слюсар' AS "Слюсар", data->>'Загальна сума' AS "Сума", CASE WHEN date_off IS NULL THEN 'Відкритий' ELSE 'Закритий' END AS "Статус"
Кожен стовпець — з AS українською!

ПРИКЛАДИ:
Відкриті акти старше 7 днів:
SELECT act_id AS "Акт №", date_on AS "Дата відкриття", data->>'ПІБ' AS "Клієнт", data->>'Слюсар' AS "Слюсар" FROM acts WHERE date_off IS NULL AND date_on < NOW() - INTERVAL '7 days' ORDER BY date_on ASC

Топ-5 клієнтів по сумі:
SELECT data->>'ПІБ' AS "Клієнт", COUNT(*) AS "Кількість актів", SUM((data->>'Загальна сума')::numeric) AS "Загальна сума" FROM acts GROUP BY data->>'ПІБ' ORDER BY "Загальна сума" DESC LIMIT 5

Залишки на складі > 0:
SELECT sclad_id AS "ID", name AS "Деталь", part_number AS "Артикул", (kilkist_on - kilkist_off) AS "Залишок" FROM sclad WHERE (kilkist_on - kilkist_off) > 0 ORDER BY name

Витрати за останній місяць:
SELECT vutratu_id AS "ID", "dataOnn" AS "Дата", kategoria AS "Категорія", suma AS "Сума", opys_vytraty AS "Опис" FROM vutratu WHERE "dataOnn" >= NOW() - INTERVAL '30 days' ORDER BY "dataOnn" DESC`;

// Окремий промпт для генерації JSON-правил для режиму "Контроль" (Realtime)
const REALTIME_RULE_PROMPT = `Генератор правил моніторингу для СТО. Прочитай умову → поверни JSON.

ТАБЛИЦІ: acts(акти), slyusars(персонал), clients(клієнти), cars(авто), sclad(склад), vutratu(витрати), faktura(рахунки), post_arxiv(бронювання постів), incomes(доходи), settings(налаштування)

CHECK-УМОВИ:
Стовпці: "date_off CLOSED"(заповнили), "date_off OPENED"(очистили), "date_off CHANGED"(будь-яка зміна), "date_off IS NOT NULL"
JSONB: "data.Пароль CHANGED", "data.Слюсар CHANGED", "data.\\"Загальна сума\\" CHANGED"(лапки для пробілів)
Масиви: "data.Роботи CHANGED"(+/-робота), "data.Деталі CHANGED"(+/-деталь)
Порожній ""=будь-яка зміна. EVENTS: INSERT/UPDATE/DELETE

ФОРМАТ (тільки JSON):
{"table":"назва","events":["INSERT","UPDATE"],"check":"умова","show_fields":["Поле1"]}
show_fields — НЕобов'язкове, тільки якщо явно просять конкретні поля.

ПРИКЛАДИ:
"зміни в акті"→{"table":"acts","events":["UPDATE"],"check":""}
"додали/видалили роботу"→{"table":"acts","events":["UPDATE"],"check":"data.Роботи CHANGED"}
"акт закрився"→{"table":"acts","events":["UPDATE"],"check":"date_off CLOSED"}
"акт відкрився"→{"table":"acts","events":["UPDATE"],"check":"date_off OPENED"}
"новий акт"→{"table":"acts","events":["INSERT"],"check":""}
"змінили пароль"→{"table":"slyusars","events":["UPDATE"],"check":"data.Пароль CHANGED"}
"новий клієнт"→{"table":"clients","events":["INSERT"],"check":""}
"закриття акту, покажи суму"→{"table":"acts","events":["UPDATE"],"check":"date_off CLOSED","show_fields":["Загальна сума","Приймальник"]}
"нова витрата"→{"table":"vutratu","events":["INSERT"],"check":""}
"змінили статус бронювання"→{"table":"post_arxiv","events":["UPDATE"],"check":"status CHANGED"}
"нове бронювання поста"→{"table":"post_arxiv","events":["INSERT"],"check":""}
"рух на складі"→{"table":"sclad","events":["INSERT","UPDATE"],"check":""}
"заморозили акт"→{"table":"acts","events":["UPDATE"],"check":"frozen CLOSED"}
"нове надходження"→{"table":"incomes","events":["INSERT"],"check":""}
"змінили налаштування"→{"table":"settings","events":["UPDATE"],"check":""}

Повертай ТІЛЬКИ JSON!`;

async function generateSQLFromDescription(
  description: string,
): Promise<string> {
  const keys = await loadAIKeys();
  if (keys.length === 0) throw new Error("Немає AI ключів");

  for (const { key, settingId } of keys) {
    try {
      if (/^gsk_/i.test(key)) {
        const data = await callGroqPlanner(
          key,
          settingId,
          [
            { role: "system", content: SQL_SYSTEM_PROMPT },
            { role: "user", content: description },
          ],
          512,
        );
        const tokens = data.usage?.total_tokens ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.choices?.[0]?.message?.content || "").trim();
      } else if (/^sk-or-/i.test(key)) {
        const data = await callOpenRouterPlanner(
          key,
          settingId,
          [
            { role: "system", content: SQL_SYSTEM_PROMPT },
            { role: "user", content: description },
          ],
          512,
        );
        const tokens = data.usage?.total_tokens ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.choices?.[0]?.message?.content || "").trim();
      } else {
        // Gemini
        const resp = await fetch(`${GEMINI_URL}?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SQL_SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: description }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const tokens = data.usageMetadata?.totalTokenCount ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      }
    } catch {
      continue;
    }
  }
  throw new Error("Всі AI ключі не працюють");
}

// Генерація JSON-правила Realtime (замість SQL) для режиму "Контроль"
async function generateRealtimeRuleFromDescription(
  description: string,
): Promise<string> {
  const keys = await loadAIKeys();
  if (keys.length === 0) throw new Error("Немає AI ключів");

  for (const { key, settingId } of keys) {
    try {
      if (/^gsk_/i.test(key)) {
        const data = await callGroqPlanner(
          key,
          settingId,
          [
            { role: "system", content: REALTIME_RULE_PROMPT },
            { role: "user", content: description },
          ],
          256,
        );
        const tokens = data.usage?.total_tokens ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.choices?.[0]?.message?.content || "").trim();
      } else if (/^sk-or-/i.test(key)) {
        const data = await callOpenRouterPlanner(
          key,
          settingId,
          [
            { role: "system", content: REALTIME_RULE_PROMPT },
            { role: "user", content: description },
          ],
          256,
        );
        const tokens = data.usage?.total_tokens ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.choices?.[0]?.message?.content || "").trim();
      } else {
        const resp = await fetch(`${GEMINI_URL}?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: REALTIME_RULE_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: description }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const tokens = data.usageMetadata?.totalTokenCount ?? 0;
        if (tokens > 0) addTokensToDB(settingId, tokens);
        return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      }
    } catch {
      continue;
    }
  }
  throw new Error("Всі AI ключі не працюють");
}

// ── Типи ──

export interface Reminder {
  reminder_id: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  title: string;
  description: string | null;
  reminder_type: "once" | "recurring" | "conditional";
  trigger_at: string | null;
  schedule: ScheduleRule | null;
  condition_query: string | null;
  condition_check_interval: string;
  recipients: string | number[];
  channel: "app" | "telegram" | "both";
  priority: "low" | "normal" | "high" | "urgent";
  status: "active" | "paused" | "completed" | "cancelled";
  last_triggered_at: string | null;
  next_trigger_at: string | null;
  trigger_count: number;
  meta: Record<string, any>;
}

export interface ReminderFromRPC {
  reminder_id: number;
  created_by?: number | null;
  title: string;
  description: string | null;
  reminder_type: string;
  trigger_at: string | null;
  schedule: any;
  condition_query: string | null;
  recipients: any;
  channel: string;
  priority: string;
  status: string;
  created_at: string;
  next_trigger_at: string | null;
  last_triggered_at: string | null;
  trigger_count: number;
  creator_name: string;
  is_mine: boolean;
  meta: any;
}

interface ScheduleRule {
  type: "daily" | "weekly" | "monthly" | "interval" | "realtime";
  time?: string;
  days?: string[];
  day?: number;
  hours?: number;
  minutes?: number;
}

// ── Стан ──
let currentFilter: "all" | "active" | "paused" | "completed" = "all";
let reminders: ReminderFromRPC[] = [];
let editingReminderId: number | null = null;
let telegramLinked: boolean | null = null; // null = не перевірено
let telegramBotReady: boolean | null = null; // null = не перевірено
let telegramBotName = "";
let telegramUsers: { slyusar_id: number; name: string }[] = [];
let callbackLogs: Map<number, { message_text: string; sent_at: string; log_id?: number }> =
  new Map();
const readLatestCallbacks = createLatestCallbackReader(supabase);
const plannerCreatorNames = new Map<number, string>();
const plannerCountListeners = new Set<(count: number) => void>();
let plannerBadgeCount = 0;
const TELEGRAM_BOT_SETTING_ID = 19;

function emitPlannerReminderCount(): void {
  const count = reminders.length;
  plannerBadgeCount = count;
  plannerCountListeners.forEach((listener) => {
    try {
      listener(count);
    } catch {
      /* silent */
    }
  });
}

export function subscribePlannerReminderCount(
  listener: (count: number) => void,
): () => void {
  plannerCountListeners.add(listener);
  listener(plannerBadgeCount);
  return () => {
    plannerCountListeners.delete(listener);
  };
}

export async function refreshPlannerBadgeCount(): Promise<number> {
  const owner = currentPlannerOwner();
  const slyusarId = getCurrentSlyusarId();
  const admin = getCurrentUserRole() === "Адміністратор";
  if (!admin && !slyusarId) return 0;
  const countRows = async (active: boolean) => {
    let query = supabase.from("atlas_reminders").select("reminder_id", { count: "exact", head: true })
      .in("status", ["active", "paused", "completed", "cancelled"]);
    if (active) query = query.eq("status", "active");
    const { count, error } = await query;
    if (error || count === null) throw error || new Error("Не вдалося порахувати повідомлення");
    return count;
  };
  let total: number;
  if (admin) {
    total = await countRows(false);
  } else {
    // POST wrapper preserves get_my_reminders visibility for either its SETOF
    // or JSON-array return contract and does not assume a STABLE declaration.
    const { data, error } = await supabase.rpc("traffic_my_reminder_counts", { p_slyusar_id: slyusarId });
    if (error) throw error;
    if (!data || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.active) || data.active < 0) {
      throw new Error("Не вдалося порахувати повідомлення");
    }
    total = data.total;
  }
  if (owner !== currentPlannerOwner()) return plannerBadgeCount;
  plannerBadgeCount = total;
  plannerCountListeners.forEach(listener => { try { listener(total); } catch { /* UI listener. */ } });
  return total;
}

// ── Утиліти ──









function isTelegramDeliveryChannel(
  channel: string | null | undefined,
): boolean {
  return channel === "telegram" || channel === "both";
}

function createServerConditionSchedule(): ScheduleRule {
  return { type: "realtime" };
}

function isJsonRealtimeRule(value: string | null | undefined): boolean {
  return String(value || "")
    .trim()
    .startsWith("{");
}

function isRetryableSupabaseError(error: any): boolean {
  const status = Number(error?.status || error?.code || 0);
  if (status === 503 || status === 502 || status === 504 || status === 429) {
    return true;
  }
  const msg = String(error?.message || "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout") ||
    msg.includes("too many requests")
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectSlyusarsWithRetry(
  columns: string,
  apply?: (q: any) => any,
): Promise<{ data: any[] | null; error: any }> {
  const maxAttempts = 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let query = supabase.from("slyusars").select(columns);
    if (apply) query = apply(query);

    const { data, error } = await query;
    if (!error) {
      return { data: (data || []) as any[], error: null };
    }

    lastError = error;
    if (!isRetryableSupabaseError(error) || attempt === maxAttempts) {
      break;
    }

    await sleepMs(250 * attempt);
  }

  return { data: null, error: lastError };
}

function getCurrentSlyusarId(): number | null {
  try {
    const stored = localStorage.getItem("userAuthData");
    if (stored) {
      const data = JSON.parse(stored);
      return data?.slyusar_id ?? null;
    }
  } catch {
    /* */
  }
  return null;
}

function getCurrentUserRole(): string {
  try {
    const stored = localStorage.getItem("userAuthData");
    if (stored) {
      const data = JSON.parse(stored);
      return data?.["Доступ"] || "Невідомо";
    }
  } catch {
    /* */
  }
  return "Невідомо";
}

async function checkTelegramLink(): Promise<boolean> {
  const slyusarId = getCurrentSlyusarId();
  const owner = currentPlannerOwner();
  if (!slyusarId) return false;
  try {
    const { data } = await supabase
      .from("atlas_telegram_users")
      .select("is_active")
      .eq("slyusar_id", slyusarId)
      .single();
    if (owner !== currentPlannerOwner()) return false;
    telegramLinked = !!data?.is_active;
    return telegramLinked;
  } catch {
    if (owner === currentPlannerOwner()) telegramLinked = false;
    return false;
  }
}

async function loadTelegramBotToken(): Promise<string> {
  try {
    const { data } = await supabase
      .from("settings")
      .select('setting_id, "Загальні"')
      .eq("setting_id", TELEGRAM_BOT_SETTING_ID)
      .maybeSingle();
    return String((data as any)?.["Загальні"] || "").trim();
  } catch {
    return "";
  }
}

async function saveTelegramBotToken(token: string): Promise<void> {
  const cleanToken = token.trim();
  const { data: existingRow, error: selectError } = await supabase
    .from("settings")
    .select("setting_id")
    .eq("setting_id", TELEGRAM_BOT_SETTING_ID)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existingRow) {
    const { error } = await supabase
      .from("settings")
      .update({ Загальні: cleanToken || null })
      .eq("setting_id", TELEGRAM_BOT_SETTING_ID);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("settings").insert({
      setting_id: TELEGRAM_BOT_SETTING_ID,
      Загальні: cleanToken || null,
      data: false,
    });
    if (error) throw error;
  }
}

export async function checkTelegramBotReady(): Promise<boolean> {
  const token = await loadTelegramBotToken();
  if (!token) {
    telegramBotReady = false;
    telegramBotName = "";
    return false;
  }

  try {
    const resp = await supabase.functions.invoke("telegram-bot", {
      body: { action: "bot_status" },
    });
    if (resp.error) throw resp.error;
    const data = resp.data as any;
    const bot = data?.result || data?.bot;
    telegramBotReady = !!data?.ok;
    telegramBotName =
      bot?.username || bot?.first_name || (telegramBotReady ? "Bot" : "");
    return telegramBotReady;
  } catch {
    telegramBotReady = true;
    telegramBotName = "";
    return true;
  }
}

export function renderTelegramBotButton(): string {
  const ready = telegramBotReady === true;
  const text =
    ready && telegramBotName
      ? `@${escapeHtml(telegramBotName)}`
      : ready
        ? "Бот підключений"
        : "Telegram бот не підключений";
  const iconClass = ready
    ? "ai-settings-btn--telegram-ready"
    : "ai-settings-btn--telegram-missing";

  return `
    <button type="button"
      class="ai-settings-btn ai-settings-btn--telegram ${iconClass}"
      id="planner-telegram-bot-status"
      title="${ready ? "Змінити Telegram bot API" : "Підключити Telegram bot API"}">
      <span class="ai-settings-btn-icon">${ready ? "✓" : "✕"}</span>
      <span class="ai-settings-btn-text">${text}</span>
      <span class="ai-settings-btn-desc">Налаштування Telegram бота</span>
    </button>
  `;
}

export function updateTelegramBotButton(root: HTMLElement): void {
  const btn = root.querySelector("#planner-telegram-bot-status");
  if (!btn) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderTelegramBotButton().trim();
  btn.replaceWith(wrapper.firstElementChild as HTMLElement);
  root
    .querySelector("#planner-telegram-bot-status")
    ?.addEventListener("click", () => showTelegramBotModal(root));
}

async function loadTelegramUsers(): Promise<void> {
  const owner = currentPlannerOwner();
  try {
    const { data: tgUsers } = await supabase
      .from("atlas_telegram_users")
      .select("slyusar_id")
      .eq("is_active", true);

    if (owner !== currentPlannerOwner()) return;
    if (!tgUsers?.length) {
      telegramUsers = [];
      return;
    }

    const ids = tgUsers.map((u: any) => u.slyusar_id);
    let slyusars: any[] | null = null;

    {
      const { data } = await selectSlyusarsWithRetry("slyusar_id,name:data->>Name", (q) =>
        q.in("slyusar_id", ids),
      );
      slyusars = (data || []) as any[];
    }

    if (owner !== currentPlannerOwner()) return;
    telegramUsers = (slyusars || []).map((s: any) => ({
      slyusar_id: s.slyusar_id,
      name: s.name || `ID ${s.slyusar_id}`,
    }));
  } catch {
    if (owner === currentPlannerOwner()) telegramUsers = [];
  }
}

async function loadCallbackLogs(reminderIds: number[]): Promise<void> {
  if (!reminderIds.length) return;
  const generation = plannerGeneration;
  const owner = plannerOwner;
  const revision = plannerCallbackRevision;
  try {
    const data = await readLatestCallbacks(reminderIds);
    if (generation !== plannerGeneration || owner !== currentPlannerOwner()) return;
    // Callback events observed during a snapshot are queued for a bounded reread.
    if (revision !== plannerCallbackRevision) {
      for (const id of reminderIds) plannerCallbackDirty.add(id);
      schedulePlannerRefresh();
      return;
    }
    for (const id of reminderIds) { callbackLogs.delete(id); plannerCallbackDirty.delete(id); }
    for (const row of data) callbackLogs.set(Number(row.reminder_id), { message_text: row.message_text, sent_at: row.sent_at, log_id: row.log_id });
  } catch {
    // Keep the last confirmed response after a transient error.
  }
}

function getRecipientsLabel(recipients: any): string {
  if (!recipients || recipients === "self" || recipients === '"self"')
    return "👤 Тільки мені";
  if (recipients === "all" || recipients === '"all"') return "👥 Всім";
  if (recipients === "mechanics" || recipients === '"mechanics"')
    return "🔧 Слюсарям";
  if (Array.isArray(recipients) && recipients.length > 0) {
    const user = telegramUsers.find((u) => u.slyusar_id === recipients[0]);
    return user ? `✈️ ${user.name}` : "👤 Тільки мені";
  }
  return "👤 Тільки мені";
}

function getRecipientsValue(recipients: any): string {
  if (!recipients || recipients === "self" || recipients === '"self"')
    return "self";
  if (recipients === "all" || recipients === '"all"') return "all";
  if (recipients === "mechanics" || recipients === '"mechanics"')
    return "mechanics";
  if (Array.isArray(recipients) && recipients.length > 0)
    return `user_${recipients[0]}`;
  return "self";
}

// Telegram is configured per project through VITE_TELEGRAM_BOT_USERNAME.
// ── CRUD ──

export async function loadReminders(strict = false): Promise<ReminderFromRPC[]> {
  const slyusarId = getCurrentSlyusarId();
  const role = getCurrentUserRole();
  const owner = currentPlannerOwner();

  // Адміністратор бачить усі
  if (role === "Адміністратор") {
    const data: any[] = [];
    let before: { created_at: string; reminder_id: number } | null = null;
    for (;;) {
      let query = supabase.from("atlas_reminders").select(REMINDER_CHANGE_COLUMNS.join(","))
        .in("status", ["active", "paused", "completed", "cancelled"])
        .order("created_at", { ascending: false }).order("reminder_id", { ascending: false }).limit(200);
      if (before) query = query.or(`created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},reminder_id.lt.${before.reminder_id})`);
      const response = await query;
      if (response.error) { if (strict) throw response.error; return []; }
      if (owner !== currentPlannerOwner()) return [];
      const rows = (response.data || []) as unknown as ReminderFromRPC[];
      data.push(...rows);
      if (rows.length < 200) break;
      const last = rows[rows.length - 1];
      if (!last.created_at || !Number.isSafeInteger(Number(last.reminder_id))) throw new Error("Некоректна сторінка повідомлень");
      before = { created_at: last.created_at, reminder_id: Number(last.reminder_id) };
    }
    const creatorIds = [
      ...new Set((data || []).map((r: any) => r.created_by).filter(Boolean)),
    ];
    let creatorsMap: Map<number, string> = new Map();

    if (creatorIds.length > 0) {
      const { data: creators } = await supabase
        .from("slyusars")
        .select("slyusar_id,name:data->>Name")
        .in("slyusar_id", creatorIds);

      if (creators && owner === currentPlannerOwner()) {
        for (const c of creators) {
          creatorsMap.set(c.slyusar_id, c.name || "—");
          plannerCreatorNames.set(Number(c.slyusar_id), c.name || "—");
        }
      }
    }

    return (data || []).map((r: any) => ({
      ...r,
      creator_name: creatorsMap.get(r.created_by) || "—",
      is_mine: r.created_by === slyusarId,
    }));
  }

  // Інші — через RPC
  if (!slyusarId) return [];

  const { data, error } = await supabase.rpc("get_my_reminders", {
    p_slyusar_id: slyusarId,
  });

  if (error) { if (strict) throw error; return []; }

  return data || [];
}

export async function createReminder(
  reminder: Partial<Reminder>,
): Promise<boolean> {
  const slyusarId = getCurrentSlyusarId();

  const newReminder = {
    title: reminder.title || "Нове нагадування",
    description: reminder.description || null,
    reminder_type: reminder.reminder_type || "once",
    trigger_at: reminder.trigger_at || null,
    schedule: reminder.schedule || null,
    condition_query: reminder.condition_query || null,
    recipients: reminder.recipients || "self",
    channel: reminder.channel || "app",
    priority: reminder.priority || "normal",
    status: "active",
    created_by: slyusarId,
    next_trigger_at: reminder.trigger_at || null,
    meta: reminder.meta || {},
  };

  // Для recurring — обчислити next_trigger_at
  if (reminder.reminder_type === "recurring" && reminder.schedule) {
    newReminder.next_trigger_at = calculateNextTrigger(
      reminder.schedule as ScheduleRule,
    );
  }

  const { data, error } = await supabase
    .from("atlas_reminders")
    .insert([newReminder]).select(REMINDER_CHANGE_COLUMNS.join(",")).single();

  if (error || !data) return false;

  
  applyPlannerReminderEvent({ eventType: "INSERT", new: data }, true);
  emitPlannerReminderCount();
  schedulePlannerRefresh();
  return true;
}

export async function updateReminder(
  id: number,
  updates: Partial<Reminder>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("atlas_reminders")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("reminder_id", id).select(REMINDER_CHANGE_COLUMNS.join(",")).maybeSingle();

  if (error || !data) return false;

  
  applyPlannerReminderEvent({ eventType: "UPDATE", new: data }, true);
  emitPlannerReminderCount();
  schedulePlannerRefresh();

  return true;
}

export async function deleteReminder(id: number): Promise<boolean> {
  // Спочатку видаляємо логи нагадування
  await supabase.from("atlas_reminder_logs").delete().eq("reminder_id", id);

  const { error } = await supabase
    .from("atlas_reminders")
    .delete()
    .eq("reminder_id", id);

  if (error) return false;

  applyPlannerReminderEvent({ eventType: "DELETE", old: { reminder_id: id } });
  emitPlannerReminderCount();
  schedulePlannerRefresh();
  return true;
}

export async function togglePause(
  id: number,
  currentStatus: string,
): Promise<boolean> {
  const newStatus = currentStatus === "paused" ? "active" : "paused";
  return updateReminder(id, { status: newStatus } as any);
}

// ── Розрахунок наступного спрацювання ──

function calculateNextTrigger(schedule: ScheduleRule): string | null {
  const now = new Date();

  if (schedule.type === "daily") {
    const [h, m] = (schedule.time || "09:00").split(":").map(Number);
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (schedule.type === "weekly" && schedule.days?.length) {
    const dayMap: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };
    const [h, m] = (schedule.time || "09:00").split(":").map(Number);
    const targetDays = schedule.days.map((d) => dayMap[d] ?? 1);
    const currentDay = now.getDay();

    for (let offset = 0; offset <= 7; offset++) {
      const checkDay = (currentDay + offset) % 7;
      if (targetDays.includes(checkDay)) {
        const next = new Date(now);
        next.setDate(now.getDate() + offset);
        next.setHours(h, m, 0, 0);
        if (next > now) return next.toISOString();
      }
    }
    // Якщо все пройшло — наступний тиждень
    const next = new Date(now);
    next.setDate(now.getDate() + 7);
    next.setHours(h, m, 0, 0);
    return next.toISOString();
  }

  if (schedule.type === "monthly") {
    const day = schedule.day || 1;
    const [h, mm] = (schedule.time || "09:00").split(":").map(Number);
    const next = new Date(now.getFullYear(), now.getMonth(), day, h, mm, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next.toISOString();
  }

  if (schedule.type === "interval") {
    const hours = schedule.hours || 0;
    const minutes = schedule.minutes || 0;
    const totalMs = (hours * 60 + minutes) * 60 * 1000 || 60 * 60 * 1000;
    return new Date(now.getTime() + totalMs).toISOString();
  }

  return null;
}

// ═══════════════════════════════════════
// 🎨 РЕНДЕРИНГ
// ═══════════════════════════════════════

const PRIORITY_LABELS: Record<string, string> = {
  low: "🔹 Низький",
  normal: "🔷 Звичайний",
  high: "🔶 Високий",
  urgent: "🔴 Терміновий",
};

const TYPE_LABELS: Record<string, string> = {
  once: "⏰ Одноразове",
  recurring: "🔄 Повторюване",
  conditional: "📊 Умовне",
};

const CHANNEL_LABELS: Record<string, string> = {
  app: "📱 Додаток",
  telegram: "✈️ Telegram",
  both: "📱✈️ Обидва",
};

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  return date.toLocaleDateString("uk-UA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLocalDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCountdown(dateStr: string | null): string {
  if (!dateStr) return "";
  const now = new Date();
  const target = new Date(dateStr);
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0)
    return (
      '<span class="ai-planner-countdown" data-target="' +
      dateStr +
      '" style="color:#b71c1c;font-weight:600">⏱ вже час!</span>'
    );
  const totalMin = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  let text = "";
  if (days > 0) text += `${days}д `;
  if (h > 0) text += `${h}год `;
  text += `${minutes}хв`;
  return `<span class="ai-planner-countdown" data-target="${dateStr}" style="color:#b71c1c;font-weight:600">⏱ через ${text.trim()}</span>`;
}

// Живий таймер оновлення відліку
let countdownInterval: ReturnType<typeof setInterval> | null = null;

function startCountdownTimer(): void {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    document.querySelectorAll(".ai-planner-countdown").forEach((el) => {
      const target = (el as HTMLElement).dataset.target;
      if (!target) return;
      const diffMs = new Date(target).getTime() - Date.now();
      if (diffMs <= 0) {
        el.textContent = "⏱ вже час!";
        return;
      }
      const totalMin = Math.floor(diffMs / 60000);
      const hours = Math.floor(totalMin / 60);
      const minutes = totalMin % 60;
      const days = Math.floor(hours / 24);
      const h = hours % 24;
      let text = "";
      if (days > 0) text += `${days}д `;
      if (h > 0) text += `${h}год `;
      text += `${minutes}хв`;
      el.textContent = `⏱ через ${text.trim()}`;
    });
  }, 30000); // оновлювати кожні 30 секунд
}

function formatRecipients(recipients: any): string {
  if (recipients === "self" || recipients === '"self"') return "👤 Тільки я";
  if (recipients === "all" || recipients === '"all"') return "👥 Всі";
  if (recipients === "mechanics" || recipients === '"mechanics"')
    return "🔧 Слюсарі";
  if (Array.isArray(recipients) && recipients.length > 0) {
    const names = recipients.map((id: number) => {
      const user = telegramUsers.find((u) => u.slyusar_id === id);
      return user ? user.name : `#${id}`;
    });
    return `👥 ${names.join(", ")}`;
  }
  return "👤 Тільки я";
}

function formatSchedule(schedule: any): string {
  if (!schedule) return "";
  if (schedule.type === "realtime") return "🔴 Реал. час (Контроль змін)";
  if (schedule.type === "daily") return `Щодня о ${schedule.time || "09:00"}`;
  if (schedule.type === "weekly") {
    const dayNames: Record<string, string> = {
      mon: "Пн",
      tue: "Вт",
      wed: "Ср",
      thu: "Чт",
      fri: "Пт",
      sat: "Сб",
      sun: "Нд",
    };
    const days = (schedule.days || [])
      .map((d: string) => dayNames[d] || d)
      .join(", ");
    return `${days} о ${schedule.time || "09:00"}`;
  }
  if (schedule.type === "monthly")
    return `${schedule.day}-го числа о ${schedule.time || "09:00"}`;
  if (schedule.type === "interval") {
    const h = schedule.hours || 0;
    const m = schedule.minutes || 0;
    if (h > 0 && m > 0) return `Кожні ${h} год. ${m} хв.`;
    if (h > 0) return `Кожні ${h} год.`;
    return `Кожні ${m} хв.`;
  }
  return "";
}

// ── Головна функція рендерингу ──

export async function renderPlannerPanel(
  container: HTMLElement,
): Promise<void> {
  const filtered = filterReminders(reminders);

  container.innerHTML = `
    <div class="ai-planner">
      <!-- Фільтри -->
      <div class="ai-planner-filters">
        <button class="ai-planner-filter ${currentFilter === "all" ? "ai-planner-filter--active" : ""}" data-filter="all">
          Всі <span class="ai-planner-filter-badge">${reminders.length}</span>
        </button>
        <button class="ai-planner-filter ${currentFilter === "active" ? "ai-planner-filter--active" : ""}" data-filter="active">
          ⏳ Активні <span class="ai-planner-filter-badge">${reminders.filter((r) => r.status === "active").length}</span>
        </button>
        <button class="ai-planner-filter ${currentFilter === "paused" ? "ai-planner-filter--active" : ""}" data-filter="paused">
          ⏸️ Пауза <span class="ai-planner-filter-badge">${reminders.filter((r) => r.status === "paused").length}</span>
        </button>
        <button class="ai-planner-filter ${currentFilter === "completed" ? "ai-planner-filter--active" : ""}" data-filter="completed">
          ✅ Завершені <span class="ai-planner-filter-badge">${reminders.filter((r) => r.status === "completed" || r.status === "cancelled").length}</span>
        </button>
        <button class="ai-planner-add-btn" id="planner-add-btn">+</button>
      </div>

      <!-- Список -->
      <div class="ai-planner-list" id="planner-list">
        ${filtered.length === 0 ? renderEmptyState() : filtered.map(renderReminderCard).join("")}
      </div>
    </div>
  `;

  // Обробники
  initPlannerHandlers(container);
}

function filterReminders(list: ReminderFromRPC[]): ReminderFromRPC[] {
  if (currentFilter === "all") return list;
  if (currentFilter === "completed")
    return list.filter(
      (r) => r.status === "completed" || r.status === "cancelled",
    );
  return list.filter((r) => r.status === currentFilter);
}

function renderEmptyState(): string {
  return `
    <div class="ai-planner-empty">
      <div class="ai-planner-empty-icon">📋</div>
      <div class="ai-planner-empty-text">Нагадувань поки немає</div>
      <div class="ai-planner-empty-hint">Натисніть ➕ Створити або скажіть Атласу:<br>«Нагадай мені в середу...»</div>
    </div>
  `;
}

function renderReminderCard(r: ReminderFromRPC): string {
  const priorityClass = `ai-planner-card--${r.priority}`;
  const statusClass =
    r.status !== "active" ? `ai-planner-card--${r.status}` : "";

  let timeInfo = "❓";
  if (r.reminder_type === "once") {
    timeInfo = `🕐 ${formatDateTime(r.trigger_at || r.next_trigger_at)}`;
  } else if (r.reminder_type === "recurring") {
    timeInfo = `🔄 ${formatSchedule(r.schedule)}`;
  } else {
    timeInfo =
      (r.schedule as any)?.type === "realtime"
        ? "🔴 Контроль змін (реалтайм)"
        : "📊 Умовна перевірка";
  }

  const nextTrigger =
    r.next_trigger_at && r.status === "active"
      ? `⏭️ Наступне: ${formatDateTime(r.next_trigger_at)} ${formatCountdown(r.next_trigger_at)}`
      : "";

  return `
    <div class="ai-planner-card ${priorityClass} ${statusClass}" data-reminder-id="${r.reminder_id}">
      <div class="ai-planner-card-header">
        <div class="ai-planner-card-title">${escapeHtml(r.title)}</div>
        <div class="ai-planner-card-actions">
          ${
            r.status !== "completed" && r.status !== "cancelled"
              ? `
            <button class="ai-planner-card-action ai-planner-card-action--pause" data-action="pause" data-id="${r.reminder_id}" title="${r.status === "paused" ? "Відновити" : "Пауза"}">
              ${r.status === "paused" ? "▶️" : "⏸️"}
            </button>
          `
              : ""
          }
          <button class="ai-planner-card-action ai-planner-card-action--delete" data-action="delete" data-id="${r.reminder_id}" title="Видалити">🗑️</button>
        </div>
      </div>

      ${r.description ? `<div style="font-size:11px;color:#777;margin-bottom:4px">${escapeHtml(r.description)}</div>` : ""}

      <div class="ai-planner-card-meta">
        <span class="ai-planner-card-badge ai-planner-card-badge--type-${r.reminder_type}">${TYPE_LABELS[r.reminder_type] || r.reminder_type}</span>
        <span class="ai-planner-card-badge ai-planner-card-badge--channel-${r.channel}">${CHANNEL_LABELS[r.channel] || r.channel}</span>
        ${r.priority !== "normal" ? `<span class="ai-planner-card-badge ai-planner-card-badge--priority-${r.priority}">${PRIORITY_LABELS[r.priority]}</span>` : ""}
      </div>

      <div class="ai-planner-card-time">${timeInfo}</div>
      ${nextTrigger ? `<div class="ai-planner-card-time" style="margin-top:2px">${nextTrigger}</div>` : ""}

      <div class="ai-planner-card-footer">
        ${r.creator_name ? `<div class="ai-planner-card-creator">✍️ ${escapeHtml(r.creator_name)}</div>` : ""}
        <div class="ai-planner-card-recipients">${formatRecipients(r.recipients)}</div>
        ${r.trigger_count > 0 ? `<div class="ai-planner-card-trigger-count">🔔 ${r.trigger_count}×</div>` : ""}
      </div>

      ${renderCallbackResponse(r.reminder_id)}
    </div>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderCallbackResponse(reminderId: number): string {
  const log = callbackLogs.get(reminderId);
  if (!log) return "";

  const time = formatDateTime(log.sent_at);
  const text = log.message_text;

  let icon = "💬";
  let statusLabel = "Відповідь";
  let cssModifier = "";
  if (text.includes("✅")) {
    icon = "✅";
    statusLabel = "Виконано";
    cssModifier = "done";
  } else if (text.includes("📅")) {
    icon = "📅";
    statusLabel = "Заплановано";
    cssModifier = "snooze";
  } else if (text.includes("❌")) {
    icon = "❌";
    statusLabel = "Не планую";
    cssModifier = "skip";
  }

  // Витягуємо ім'я відповідача з тексту "(від Ім'я)"
  // Змінюємо regex на жадібний `.+` замість лінивого `.+?`, щоб захопити вкладені дужки
  const nameMatch = text.match(/\(від\s+(.+)\)/);
  const responder = nameMatch ? nameMatch[1] : "";

  return `
    <div class="ai-planner-card-callback ${cssModifier ? `ai-planner-card-callback--${cssModifier}` : ""}">
      <div class="ai-planner-card-callback__header">
        <span class="ai-planner-card-callback__icon">${icon}</span>
        <span class="ai-planner-card-callback__status">${statusLabel}</span>
      </div>
      <div class="ai-planner-card-callback__details">
        ${responder ? `<span class="ai-planner-card-callback__who">👤 ${escapeHtml(responder)}</span>` : ""}
        <span class="ai-planner-card-callback__when">🕐 ${time}</span>
      </div>
      <div class="ai-planner-card-callback__source">Telegram</div>
    </div>
  `;
}

// ═══════════════════════════════════════
// ⚙️ ОБРОБНИКИ
// ═══════════════════════════════════════

function initPlannerHandlers(container: HTMLElement): void {
  // Кнопка створити
  container.querySelector("#planner-add-btn")?.addEventListener("click", () => {
    editingReminderId = null;
    showReminderModal(container);
  });

  // Фільтри
  container.querySelectorAll(".ai-planner-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentFilter = (btn as HTMLElement).dataset.filter as any;
      renderPlannerPanel(container);
    });
  });

  // Дії на картках
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).dataset.action;
      const id = Number((btn as HTMLElement).dataset.id);
      if (!id) return;

      if (action === "delete") {
        const deleteBtn = btn as HTMLElement;
        const card = deleteBtn.closest(".ai-planner-card") as HTMLElement;
        const actionsEl = deleteBtn.closest(
          ".ai-planner-card-actions",
        ) as HTMLElement;
        if (!card) return;

        if (isDeleteCountdownActive(deleteBtn)) {
          cancelDeleteCountdown(deleteBtn, {
            countingClass: "ai-planner-card-action--counting",
            onCancel: () => {
              if (actionsEl)
                actionsEl.classList.remove("ai-planner-card-actions--counting");
            },
          });
          return;
        }

        startDeleteCountdown(deleteBtn, {
          countingClass: "ai-planner-card-action--counting",
          onStart: () => {
            if (actionsEl)
              actionsEl.classList.add("ai-planner-card-actions--counting");
          },
          onCancel: () => {
            if (actionsEl)
              actionsEl.classList.remove("ai-planner-card-actions--counting");
          },
          onConfirm: async () => {
            card.style.transition = "opacity 0.3s, transform 0.3s";
            card.style.opacity = "0";
            card.style.transform = "translateX(30px)";
            await new Promise((resolve) => setTimeout(resolve, 300));
            const ok = await deleteReminder(id);
            if (ok) {
              showToast("Видалено", "success");
              await refreshPlanner(container);
            } else {
              showToast("Помилка видалення", "error");
              card.style.opacity = "1";
              card.style.transform = "";
            }
          },
        });
      } else if (action === "pause") {
        const reminder = reminders.find((r) => r.reminder_id === id);
        if (reminder) {
          const ok = await togglePause(id, reminder.status);
          if (ok) {
            showToast(
              reminder.status === "paused" ? "Відновлено ▶️" : "На паузі ⏸️",
              "info",
            );
            await refreshPlanner(container);
          }
        }
      }
    });
  });

  // Клік на картку — перегляд
  container.querySelectorAll(".ai-planner-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      // Не відкривати перегляд при кліку на кнопки дій
      if ((e.target as HTMLElement).closest("[data-action]")) return;
      const id = Number((card as HTMLElement).dataset.reminderId);
      if (!id) return;
      const r = reminders.find((rm) => rm.reminder_id === id);
      if (r) showReminderViewModal(container, r);
    });
  });
}

// ── Оновити список ──

async function refreshPlanner(container: HTMLElement): Promise<void> {
  
  emitPlannerReminderCount();
  await renderPlannerPanel(container);
}

// ── Toast ──

function showToast(
  text: string,
  type: "success" | "error" | "info" = "info",
): void {
  const toast = document.createElement("div");
  toast.className = `ai-planner-toast ai-planner-toast--${type}`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ═══════════════════════════════════════
// 👁️ МОДАЛКА ПЕРЕГЛЯДУ
// ═══════════════════════════════════════

function showReminderViewModal(
  container: HTMLElement,
  r: ReminderFromRPC,
): void {
  container
    .closest(".ai-chat-window")
    ?.querySelector(".ai-planner-modal-overlay")
    ?.remove();

  let timeInfo = "❓";
  if (r.reminder_type === "once") {
    timeInfo = formatDateTime(r.trigger_at || r.next_trigger_at);
  } else if (r.reminder_type === "recurring") {
    timeInfo = formatSchedule(r.schedule);
  } else {
    timeInfo =
      (r.schedule as any)?.type === "realtime"
        ? "🔴 Контроль змін (реалтайм)"
        : "Умовна перевірка";
  }

  const nextTrigger =
    r.next_trigger_at && r.status === "active"
      ? `${formatDateTime(r.next_trigger_at)} ${formatCountdown(r.next_trigger_at)}`
      : null;

  const callbackHtml = renderCallbackResponse(r.reminder_id);

  const overlay = document.createElement("div");
  overlay.className = "ai-planner-modal-overlay";
  overlay.innerHTML = `
    <div class="ai-planner-modal ai-planner-modal--view">
      <div class="ai-planner-modal-header">
        <div class="ai-planner-modal-title">📋 Перегляд</div>
        <button class="ai-planner-modal-close" id="planner-view-close">✕</button>
      </div>
      <div class="ai-planner-modal-body ai-planner-view-body">

        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Назва</div>
          <div class="ai-planner-view-value ai-planner-view-value--title">${escapeHtml(r.title)}</div>
        </div>

        ${
          r.description
            ? `
        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Опис</div>
          <div class="ai-planner-view-value">${escapeHtml(r.description)}</div>
        </div>`
            : ""
        }

        <div class="ai-planner-view-row">
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Тип</div>
            <div class="ai-planner-view-value">${TYPE_LABELS[r.reminder_type] || r.reminder_type}</div>
          </div>
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Канал</div>
            <div class="ai-planner-view-value">${CHANNEL_LABELS[r.channel] || r.channel}</div>
          </div>
        </div>

        <div class="ai-planner-view-row">
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Пріоритет</div>
            <div class="ai-planner-view-value">${PRIORITY_LABELS[r.priority] || r.priority}</div>
          </div>
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Статус</div>
            <div class="ai-planner-view-value">${r.status === "active" ? "✅ Активне" : r.status === "paused" ? "⏸️ Пауза" : r.status === "completed" ? "✔️ Завершене" : "❌ Скасоване"}</div>
          </div>
        </div>

        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">${r.reminder_type === "once" ? "Коли" : "Розклад"}</div>
          <div class="ai-planner-view-value">🕐 ${timeInfo}</div>
        </div>

        ${
          nextTrigger
            ? `
        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Наступне</div>
          <div class="ai-planner-view-value">⏭️ ${nextTrigger}</div>
        </div>`
            : ""
        }

        <div class="ai-planner-view-row">
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Кому</div>
            <div class="ai-planner-view-value">${formatRecipients(r.recipients)}</div>
          </div>
          ${
            r.trigger_count > 0
              ? `
          <div class="ai-planner-view-field">
            <div class="ai-planner-view-label">Надіслано</div>
            <div class="ai-planner-view-value">🔔 ${r.trigger_count}×</div>
          </div>`
              : ""
          }
        </div>

        ${
          r.meta?.condition_description
            ? `
        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Умова</div>
          <div class="ai-planner-view-value">${escapeHtml(r.meta.condition_description)}</div>
        </div>`
            : ""
        }
        ${
          r.condition_query
            ? `
        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">SQL-запит</div>
          <div class="ai-planner-view-value ai-planner-view-value--code">${escapeHtml(r.condition_query)}</div>
        </div>`
            : ""
        }

        ${
          callbackHtml
            ? `
        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Відповідь з Telegram</div>
          ${callbackHtml}
        </div>`
            : ""
        }

        <div class="ai-planner-view-field">
          <div class="ai-planner-view-label">Створено</div>
          <div class="ai-planner-view-value" style="font-size:11px;color:#999">${formatDateTime(r.created_at)}${r.creator_name ? " — " + escapeHtml(r.creator_name) : ""}</div>
        </div>
      </div>

      <div class="ai-planner-modal-footer">
        <button class="ai-planner-btn ai-planner-btn--delete" id="planner-view-delete">🗑️ Видалити</button>
        <button class="ai-planner-btn ai-planner-btn--save" id="planner-view-edit">✏️ Редагувати</button>
      </div>
    </div>
  `;

  container.closest(".ai-chat-window")!.appendChild(overlay);

  // ── Обробники ──
  const close = () => overlay.remove();
  overlay
    .querySelector("#planner-view-close")
    ?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Редагувати
  overlay.querySelector("#planner-view-edit")?.addEventListener("click", () => {
    close();
    editingReminderId = r.reminder_id;
    showReminderModal(container, r);
  });

  // Видалити з відліком 5 секунд
  const deleteBtn = overlay.querySelector(
    "#planner-view-delete",
  ) as HTMLElement;
  deleteBtn?.addEventListener("click", () => {
    if (isDeleteCountdownActive(deleteBtn)) {
      cancelDeleteCountdown(deleteBtn, {
        countingClass: "ai-planner-btn--counting",
      });
      return;
    }

    startDeleteCountdown(deleteBtn, {
      countingClass: "ai-planner-btn--counting",
      onConfirm: async () => {
        const ok = await deleteReminder(r.reminder_id);
        if (ok) {
          showToast("Видалено", "success");
          close();
          await refreshPlanner(container);
        } else {
          showToast("Помилка видалення", "error");
        }
      },
    });
  });
}

// ═══════════════════════════════════════
// 🪟 МОДАЛКА СТВОРЕННЯ / РЕДАГУВАННЯ
// ═══════════════════════════════════════

function showReminderModal(
  container: HTMLElement,
  existing?: ReminderFromRPC,
): void {
  // Видаляємо попередній оверлей, якщо є
  container
    .closest(".ai-chat-window")
    ?.querySelector(".ai-planner-modal-overlay")
    ?.remove();

  const isEdit = !!existing;
  const r = existing || ({} as any);

  const overlay = document.createElement("div");
  overlay.className = "ai-planner-modal-overlay";
  overlay.innerHTML = `
    <div class="ai-planner-modal">
      <div class="ai-planner-modal-header">
        <div class="ai-planner-modal-header-main">
          <div class="ai-planner-modal-title">${isEdit ? "✏️ Редагувати" : "➕ Нове нагадування"}</div>
        </div>
        <button class="ai-planner-modal-close" id="planner-modal-close">✕</button>
      </div>
      <div class="ai-planner-modal-body">
        <!-- Назва -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Назва *</label>
          <input class="ai-planner-input" id="planner-title" type="text"
            placeholder="Нагадай розрахувати слюсарів..."
            value="${escapeHtml(r.title || "")}" />
        </div>

        <!-- Опис -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Опис</label>
          <textarea class="ai-planner-textarea" id="planner-desc"
            placeholder="Додатковий опис (необов'язково)">${escapeHtml(r.description || "")}</textarea>
        </div>

        <!-- Тип -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Тип</label>
          <div class="ai-planner-btn-group" id="planner-type-group">
            <button class="ai-planner-btn-option ${(r.reminder_type || "once") === "once" ? "ai-planner-btn-option--active" : ""}" data-value="once">⏰ Одноразове</button>
            <button class="ai-planner-btn-option ${r.reminder_type === "recurring" ? "ai-planner-btn-option--active" : ""}" data-value="recurring">🔄 Повторюване</button>
            <button class="ai-planner-btn-option ${r.reminder_type === "conditional" ? "ai-planner-btn-option--active" : ""}" data-value="conditional">📊 Умовне</button>
          </div>
        </div>

        <!-- Дата/час (для once та conditional) -->
        <div class="ai-planner-field" id="planner-once-fields" style="display:${(r.reminder_type || "once") === "once" || r.reminder_type === "conditional" ? "flex" : "none"}">
          <label class="ai-planner-label" id="planner-once-label">${r.reminder_type === "conditional" ? "Коли перевірити умову" : "Коли нагадати"}</label>
          <input class="ai-planner-input" id="planner-trigger-at" type="datetime-local"
            value="${r.trigger_at ? formatLocalDateTime(r.trigger_at) : r.next_trigger_at ? formatLocalDateTime(r.next_trigger_at) : ""}" />
        </div>

        <!-- Розклад (для recurring) -->
        <div id="planner-recurring-fields" style="display:${r.reminder_type === "recurring" ? "flex" : "none"};flex-direction:column;gap:10px">
          <div class="ai-planner-field">
            <label class="ai-planner-label">Частота</label>
            <select class="ai-planner-select" id="planner-schedule-type">
              <option value="daily" ${r.schedule?.type === "daily" ? "selected" : ""}>Щодня</option>
              <option value="weekly" ${r.schedule?.type === "weekly" ? "selected" : ""}>Щотижня</option>
              <option value="monthly" ${r.schedule?.type === "monthly" ? "selected" : ""}>Щомісяця</option>
              <option value="interval" ${r.schedule?.type === "interval" ? "selected" : ""}>Через N годин</option>
            </select>
          </div>
          <div class="ai-planner-row${r.schedule?.type === "interval" ? " ai-planner-row--interval" : ""}" id="planner-schedule-row">
            <div class="ai-planner-field" id="planner-time-field">
              <label class="ai-planner-label">Час</label>
              <input class="ai-planner-input" id="planner-schedule-time" type="time"
                value="${r.schedule?.time || (r.next_trigger_at ? new Date(r.next_trigger_at).toTimeString().slice(0, 5) : "09:00")}" />
            </div>
            <div class="ai-planner-field" id="planner-interval-field" style="display:${r.schedule?.type === "interval" ? "flex" : "none"}">
              <label class="ai-planner-label">Годин</label>
              <input class="ai-planner-input" id="planner-schedule-hours" type="number" min="0" max="100"
                value="${r.schedule?.hours || 0}" />
            </div>
            <div class="ai-planner-field" id="planner-interval-minutes-field" style="display:${r.schedule?.type === "interval" ? "flex" : "none"}">
              <label class="ai-planner-label">Хвилин</label>
              <input class="ai-planner-input" id="planner-schedule-minutes" type="number" min="0" max="59"
                value="${r.schedule?.minutes || 0}" />
            </div>
          </div>
          <div class="ai-planner-field" id="planner-days-field" style="display:${r.schedule?.type === "weekly" ? "block" : "none"}">
            <label class="ai-planner-label">Дні тижня</label>
            <div class="ai-planner-btn-group" id="planner-days-group">
              ${["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                .map((d) => {
                  const names: Record<string, string> = {
                    mon: "Пн",
                    tue: "Вт",
                    wed: "Ср",
                    thu: "Чт",
                    fri: "Пт",
                    sat: "Сб",
                    sun: "Нд",
                  };
                  const isActive = r.schedule?.days?.includes(d);
                  return `<button class="ai-planner-btn-option ${isActive ? "ai-planner-btn-option--active" : ""}" data-day="${d}">${names[d]}</button>`;
                })
                .join("")}
            </div>
          </div>
          <div class="ai-planner-field" id="planner-month-day-field" style="display:${r.schedule?.type === "monthly" ? "flex" : "none"}">
            <label class="ai-planner-label">День місяця</label>
            <input class="ai-planner-input" id="planner-schedule-day" type="number" min="1" max="31"
              value="${r.schedule?.day || 1}" />
          </div>
        </div>

        <!-- Умовний запит (для conditional) -->
        <div id="planner-conditional-fields" style="display:${r.reminder_type === "conditional" ? "flex" : "none"};flex-direction:column;gap:10px">
          <div class="ai-planner-field">
            <label class="ai-planner-label">Режим перевірки</label>
            <select class="ai-planner-select" id="planner-cond-freq">
              <option value="once" ${r.trigger_at || (!r.schedule && !(r.schedule as any)?.type) ? "selected" : ""}>Одноразово (за датою і часом)</option>
              <option value="recurring" ${r.schedule && (r.schedule as any)?.type !== "realtime" ? "selected" : ""}>За розкладом (щодня, щотижня...)</option>
              <option value="realtime" ${(r.schedule as any)?.type === "realtime" ? "selected" : ""}>🔴 Контроль (моніторинг змін)</option>
            </select>
          </div>
          <div class="ai-planner-field">
            <label class="ai-planner-label">Опишіть умову звичайною мовою</label>
            <textarea class="ai-planner-textarea" id="planner-condition-desc" style="min-height:70px"
              placeholder="Наприклад: Перевіряй всі акти відкриті більше 21 дня, і відправляй слюсару номер акту, ПІБ клієнта та які роботи треба зробити">${escapeHtml(r.meta?.condition_description || "")}</textarea>
          </div>
          <div class="ai-planner-field">
            <button type="button" class="ai-planner-btn ai-planner-btn--generate" id="planner-generate-sql" style="width:100%;padding:10px;font-size:14px;margin-bottom:6px">🤖 Згенерувати SQL-запит / Правило</button>
            <textarea class="ai-planner-textarea" id="planner-condition-query" style="min-height:60px;font-family:monospace;font-size:11px;color:#666;background:#f8f8fc"
              placeholder="Буде згенеровано автоматично...">${escapeHtml(r.condition_query || "")}</textarea>
          </div>
        </div>

        <!-- Пріоритет -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Пріоритет</label>
          <div class="ai-planner-btn-group" id="planner-priority-group">
            <button class="ai-planner-btn-option ${(r.priority || "normal") === "low" ? "ai-planner-btn-option--active" : ""}" data-value="low">🔹 Низький</button>
            <button class="ai-planner-btn-option ${(r.priority || "normal") === "normal" ? "ai-planner-btn-option--active" : ""}" data-value="normal">🔷 Звичайний</button>
            <button class="ai-planner-btn-option ${(r.priority || "normal") === "high" ? "ai-planner-btn-option--active" : ""}" data-value="high">🔶 Високий</button>
            <button class="ai-planner-btn-option ${(r.priority || "normal") === "urgent" ? "ai-planner-btn-option--active" : ""}" data-value="urgent">🔴 Терміновий</button>
          </div>
        </div>

        <!-- Канал -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Куди надіслати</label>
          <div class="ai-planner-btn-group" id="planner-channel-group">
            <button class="ai-planner-btn-option ${r.channel === "app" ? "ai-planner-btn-option--active" : ""}" data-value="app">📱 Додаток</button>
            <button class="ai-planner-btn-option ${(r.channel || "telegram") === "telegram" ? "ai-planner-btn-option--active" : ""}" data-value="telegram">✈️ Telegram</button>
            <button class="ai-planner-btn-option ${r.channel === "both" ? "ai-planner-btn-option--active" : ""}" data-value="both">📱✈️ Обидва</button>
          </div>
        </div>

        <!-- Адресати -->
        <div class="ai-planner-field">
          <label class="ai-planner-label">Кому</label>
          <div class="ai-planner-dropdown" id="planner-recipients-dropdown">
            <div class="ai-planner-dropdown-selected" id="planner-recipients-toggle">
              <span id="planner-recipients-label">${getRecipientsLabel(r.recipients)}</span>
              <svg class="ai-planner-dropdown-arrow" width="12" height="12" viewBox="0 0 20 20" fill="#999"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
            </div>
            <div class="ai-planner-dropdown-menu" id="planner-recipients-menu">
              <div class="ai-planner-dropdown-item ${!r.recipients || r.recipients === "self" || r.recipients === '"self"' ? "ai-planner-dropdown-item--active" : ""}" data-value="self">👤 Тільки мені</div>
              <div class="ai-planner-dropdown-item ${r.recipients === "all" || r.recipients === '"all"' ? "ai-planner-dropdown-item--active" : ""}" data-value="all">👥 Всім</div>
              <div class="ai-planner-dropdown-item ${r.recipients === "mechanics" || r.recipients === '"mechanics"' ? "ai-planner-dropdown-item--active" : ""}" data-value="mechanics">🔧 Слюсарям</div>
              ${telegramUsers.length > 0 ? '<div class="ai-planner-dropdown-divider"></div>' : ""}
              ${telegramUsers
                .map((u) => {
                  const isSelected =
                    Array.isArray(r.recipients) &&
                    r.recipients.includes(u.slyusar_id);
                  return `<div class="ai-planner-dropdown-item ${isSelected ? "ai-planner-dropdown-item--active" : ""}" data-value="user_${u.slyusar_id}">✈️ ${escapeHtml(u.name)}</div>`;
                })
                .join("")}
            </div>
            <input type="hidden" id="planner-recipients" value="${getRecipientsValue(r.recipients)}" />
          </div>
        </div>
      </div>

      <div class="ai-planner-modal-footer">
        ${isEdit ? `<button class="ai-planner-btn ai-planner-btn--delete" id="planner-modal-delete">🗑️ Видалити</button>` : ""}
        <button class="ai-planner-btn ai-planner-btn--cancel" id="planner-modal-cancel">↩️ Скасувати</button>
        <button class="ai-planner-btn ai-planner-btn--save" id="planner-modal-save">${isEdit ? "💾 Зберегти" : "➕ Створити"}</button>
      </div>
    </div>
  `;

  container.closest(".ai-chat-window")!.appendChild(overlay);

  // ── Обробники модалки ──
  initModalHandlers(overlay, container, isEdit, existing);
}

export async function showTelegramBotModal(root: HTMLElement): Promise<void> {
  const host = root.closest(".ai-chat-window") || root;
  host.querySelector(".ai-planner-telegram-modal-overlay")?.remove();

  const currentToken = await loadTelegramBotToken();
  const isReady = telegramBotReady === true;

  const overlay = document.createElement("div");
  overlay.className =
    "ai-planner-modal-overlay ai-planner-telegram-modal-overlay";
  overlay.innerHTML = `
    <div class="ai-planner-modal ai-planner-telegram-modal">
      <div class="ai-planner-modal-header">
        <div class="ai-planner-modal-title">${isReady ? "✓ Telegram бот" : "✕ Telegram бот"}</div>
        <button class="ai-planner-modal-close" id="telegram-bot-modal-close">✕</button>
      </div>
      <div class="ai-planner-modal-body">
        <div class="ai-planner-telegram-card ${isReady ? "ai-planner-telegram-card--ready" : "ai-planner-telegram-card--missing"}">
          <div class="ai-planner-telegram-card__mark">${isReady ? "✓" : "✕"}</div>
          <div>
            <div class="ai-planner-telegram-card__title">${isReady ? "Бот підключений" : "Бот не підключений"}</div>
            <div class="ai-planner-telegram-card__text">${isReady ? "Можна змінити API токен у будь-який момент." : "Вставте API токен від BotFather."}</div>
          </div>
        </div>

        <div class="ai-planner-field">
          <label class="ai-planner-label">Telegram Bot API</label>
          <input class="ai-planner-input" id="telegram-bot-token" type="password"
            autocomplete="off"
            placeholder="123456789:AA..."
            value="${escapeHtml(currentToken)}" />
        </div>
      </div>
      <div class="ai-planner-modal-footer">
        <button class="ai-planner-btn ai-planner-btn--cancel" id="telegram-bot-modal-cancel">↩️ Скасувати</button>
        <button class="ai-planner-btn ai-planner-btn--save" id="telegram-bot-modal-save">💾 Зберегти</button>
      </div>
    </div>
  `;

  host.appendChild(overlay);

  const close = () => overlay.remove();
  overlay
    .querySelector("#telegram-bot-modal-close")
    ?.addEventListener("click", close);
  overlay
    .querySelector("#telegram-bot-modal-cancel")
    ?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  overlay
    .querySelector("#telegram-bot-modal-save")
    ?.addEventListener("click", async () => {
      const input = overlay.querySelector(
        "#telegram-bot-token",
      ) as HTMLInputElement;
      const token = input.value.trim();

      if (!token) {
        showToast("Вставте API токен бота", "error");
        return;
      }

      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
        showToast("Схоже, токен Telegram некоректний", "error");
        return;
      }

      const saveBtn = overlay.querySelector(
        "#telegram-bot-modal-save",
      ) as HTMLButtonElement;
      saveBtn.disabled = true;
      saveBtn.textContent = "⏳ Перевіряю...";

      try {
        await saveTelegramBotToken(token);
        const statusResp = await supabase.functions.invoke("telegram-bot", {
          body: { action: "setup_webhook" },
        });
        if (statusResp.error) throw statusResp.error;

        await checkTelegramBotReady();
        updateTelegramBotButton(root);
        showToast("Telegram бот підключено ✅", "success");
        close();
      } catch (err: any) {
        telegramBotReady = false;
        updateTelegramBotButton(root);
        showToast(err?.message || "Не вдалося підключити бота", "error");
        saveBtn.disabled = false;
        saveBtn.textContent = "💾 Зберегти";
      }
    });
}

function initModalHandlers(
  overlay: HTMLElement,
  plannerContainer: HTMLElement,
  isEdit: boolean,
  existing?: ReminderFromRPC,
): void {
  // Закрити
  const close = () => overlay.remove();
  overlay
    .querySelector("#planner-modal-close")
    ?.addEventListener("click", close);
  overlay
    .querySelector("#planner-modal-cancel")
    ?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Кнопка «Згенерувати SQL / Правило»
  overlay
    .querySelector("#planner-generate-sql")
    ?.addEventListener("click", async () => {
      const descEl = overlay.querySelector(
        "#planner-condition-desc",
      ) as HTMLTextAreaElement;
      const sqlEl = overlay.querySelector(
        "#planner-condition-query",
      ) as HTMLTextAreaElement;
      const desc = descEl?.value.trim();
      if (!desc) {
        showToast("Опишіть умову!", "error");
        return;
      }
      const condFreqNow = (
        overlay.querySelector("#planner-cond-freq") as HTMLSelectElement
      )?.value;
      const genBtn = overlay.querySelector(
        "#planner-generate-sql",
      ) as HTMLButtonElement;
      genBtn.disabled = true;
      genBtn.textContent = "⏳ Генерую...";
      try {
        if (
          condFreqNow === "realtime" &&
          !isTelegramDeliveryChannel(selectedChannel)
        ) {
          let rule = await generateRealtimeRuleFromDescription(desc);
          const jsonMatch = rule.match(/\{[\s\S]*\}/);
          if (jsonMatch) rule = jsonMatch[0];
          sqlEl.value = rule;
          showToast("🔴 Правило Контролю згенеровано ✅", "success");
        } else {
          const sql = await generateSQLFromDescription(desc);
          sqlEl.value = sql;
          showToast(
            condFreqNow === "realtime"
              ? "Серверна SQL-перевірка згенерована ✅"
              : "SQL згенеровано ✅",
            "success",
          );
        }
      } catch {
        showToast("Помилка генерації", "error");
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = "🤖 Згенерувати";
      }
    });

  // Кастомний дропдаун «Кому»
  const dropdown = overlay.querySelector(
    "#planner-recipients-dropdown",
  ) as HTMLElement;
  const toggle = overlay.querySelector(
    "#planner-recipients-toggle",
  ) as HTMLElement;
  const menu = overlay.querySelector("#planner-recipients-menu") as HTMLElement;
  const hiddenInput = overlay.querySelector(
    "#planner-recipients",
  ) as HTMLInputElement;
  const label = overlay.querySelector(
    "#planner-recipients-label",
  ) as HTMLElement;

  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("ai-planner-dropdown--open");
  });

  menu?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(
      ".ai-planner-dropdown-item",
    ) as HTMLElement;
    if (!item) return;
    menu
      .querySelectorAll(".ai-planner-dropdown-item")
      .forEach((i) => i.classList.remove("ai-planner-dropdown-item--active"));
    item.classList.add("ai-planner-dropdown-item--active");
    hiddenInput.value = item.dataset.value || "self";
    label.textContent = item.textContent || "👤 Тільки мені";
    dropdown.classList.remove("ai-planner-dropdown--open");
  });

  overlay.addEventListener("click", () => {
    dropdown?.classList.remove("ai-planner-dropdown--open");
  });

  // Вибір типу
  let selectedType =
    (
      overlay.querySelector(
        "#planner-type-group .ai-planner-btn-option--active",
      ) as HTMLElement
    )?.dataset.value || "once";

  overlay
    .querySelector("#planner-type-group")
    ?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".ai-planner-btn-option",
      ) as HTMLElement;
      if (!btn) return;
      overlay
        .querySelectorAll("#planner-type-group .ai-planner-btn-option")
        .forEach((b) => b.classList.remove("ai-planner-btn-option--active"));
      btn.classList.add("ai-planner-btn-option--active");
      selectedType = btn.dataset.value || "once";

      // Показати/сховати поля
      const condFreqEl = overlay.querySelector(
        "#planner-cond-freq",
      ) as HTMLSelectElement;
      const condFreq = condFreqEl ? condFreqEl.value : "once";

      const showOnce =
        selectedType === "once" ||
        (selectedType === "conditional" && condFreq === "once");
      const showRecurring =
        selectedType === "recurring" ||
        (selectedType === "conditional" && condFreq === "recurring");
      // Для realtime — ховаємо всі часові поля

      (
        overlay.querySelector("#planner-once-fields") as HTMLElement
      ).style.display = showOnce ? "flex" : "none";

      const onceLabel = overlay.querySelector("#planner-once-label");
      if (onceLabel) {
        onceLabel.textContent =
          selectedType === "conditional"
            ? "Коли перевірити умову"
            : "Коли нагадати";
      }

      (
        overlay.querySelector("#planner-recurring-fields") as HTMLElement
      ).style.display = showRecurring ? "flex" : "none";
      (
        overlay.querySelector("#planner-conditional-fields") as HTMLElement
      ).style.display = selectedType === "conditional" ? "flex" : "none";
    });

  overlay
    .querySelector("#planner-cond-freq")
    ?.addEventListener("change", () => {
      const freq = (
        overlay.querySelector("#planner-cond-freq") as HTMLSelectElement
      ).value;
      (
        overlay.querySelector("#planner-once-fields") as HTMLElement
      ).style.display = freq === "once" ? "flex" : "none";
      (
        overlay.querySelector("#planner-recurring-fields") as HTMLElement
      ).style.display = freq === "recurring" ? "flex" : "none";
      // Показати підказку для realtime режиму
      let realtimeHint = overlay.querySelector(
        "#planner-realtime-hint",
      ) as HTMLElement;
      if (!realtimeHint) {
        realtimeHint = document.createElement("div");
        realtimeHint.id = "planner-realtime-hint";
        realtimeHint.style.cssText =
          "padding:10px 14px;background:#fff3e0;border-radius:8px;font-size:12px;color:#e65100;line-height:1.5;display:none";
        overlay
          .querySelector("#planner-conditional-fields")
          ?.appendChild(realtimeHint);
      }
      realtimeHint.innerHTML = isTelegramDeliveryChannel(selectedChannel)
        ? "✈️ <b>Telegram контроль</b> — сервер перевіряє SQL приблизно раз на хвилину навіть із закритим браузером і надсилає тільки коли результат змінився."
        : "🔴 <b>Режим контролю</b> — система моніторить зміни в базі даних у реальному часі, поки браузер відкритий.";
      realtimeHint.style.display = freq === "realtime" ? "block" : "none";
    });

  // Частота (для recurring)
  const scheduleType = overlay.querySelector(
    "#planner-schedule-type",
  ) as HTMLSelectElement;
  scheduleType?.addEventListener("change", () => {
    const v = scheduleType.value;
    (
      overlay.querySelector("#planner-days-field") as HTMLElement
    ).style.display = v === "weekly" ? "block" : "none";
    (
      overlay.querySelector("#planner-month-day-field") as HTMLElement
    ).style.display = v === "monthly" ? "flex" : "none";
    (
      overlay.querySelector("#planner-interval-field") as HTMLElement
    ).style.display = v === "interval" ? "flex" : "none";
    (
      overlay.querySelector("#planner-interval-minutes-field") as HTMLElement
    ).style.display = v === "interval" ? "flex" : "none";
    (
      overlay.querySelector("#planner-time-field") as HTMLElement
    ).style.display = v === "interval" ? "none" : "flex";
    const row = overlay.querySelector("#planner-schedule-row") as HTMLElement;
    if (row) {
      row.classList.toggle("ai-planner-row--interval", v === "interval");
    }
  });

  // Клік по datetime-local — одразу відкрити календар
  const triggerAtInput = overlay.querySelector(
    "#planner-trigger-at",
  ) as HTMLInputElement;
  triggerAtInput?.addEventListener("click", () => {
    try {
      triggerAtInput.showPicker();
    } catch (_) {
      /* unsupported */
    }
  });

  // Дні тижня — мультивибір
  overlay
    .querySelector("#planner-days-group")
    ?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".ai-planner-btn-option",
      ) as HTMLElement;
      if (!btn) return;
      btn.classList.toggle("ai-planner-btn-option--active");
    });

  // Пріоритет
  let selectedPriority =
    (
      overlay.querySelector(
        "#planner-priority-group .ai-planner-btn-option--active",
      ) as HTMLElement
    )?.dataset.value || "normal";
  overlay
    .querySelector("#planner-priority-group")
    ?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".ai-planner-btn-option",
      ) as HTMLElement;
      if (!btn) return;
      overlay
        .querySelectorAll("#planner-priority-group .ai-planner-btn-option")
        .forEach((b) => b.classList.remove("ai-planner-btn-option--active"));
      btn.classList.add("ai-planner-btn-option--active");
      selectedPriority = btn.dataset.value || "normal";
    });

  // Канал
  let selectedChannel =
    (
      overlay.querySelector(
        "#planner-channel-group .ai-planner-btn-option--active",
      ) as HTMLElement
    )?.dataset.value || "telegram";
  overlay
    .querySelector("#planner-channel-group")
    ?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".ai-planner-btn-option",
      ) as HTMLElement;
      if (!btn) return;
      overlay
        .querySelectorAll("#planner-channel-group .ai-planner-btn-option")
        .forEach((b) => b.classList.remove("ai-planner-btn-option--active"));
      btn.classList.add("ai-planner-btn-option--active");
      selectedChannel = btn.dataset.value || "telegram";
      const condFreqEl = overlay.querySelector(
        "#planner-cond-freq",
      ) as HTMLSelectElement | null;
      const realtimeHint = overlay.querySelector(
        "#planner-realtime-hint",
      ) as HTMLElement | null;
      if (realtimeHint && condFreqEl?.value === "realtime") {
        realtimeHint.innerHTML = isTelegramDeliveryChannel(selectedChannel)
          ? "✈️ <b>Telegram контроль</b> — працює на сервері навіть із закритим браузером. Перевірка приблизно раз на хвилину і автоматично вимикається, коли активних Telegram-нагадувань немає."
          : "🔴 <b>Режим контролю</b> — система моніторить зміни в базі даних у реальному часі, поки браузер відкритий.";
      }
    });

  // Видалити (тільки edit)
  overlay
    .querySelector("#planner-modal-delete")
    ?.addEventListener("click", () => {
      if (!editingReminderId) return;
      const reminderId = editingReminderId;

      const deleteBtn = overlay.querySelector(
        "#planner-modal-delete",
      ) as HTMLElement;
      if (!deleteBtn) return;

      if (isDeleteCountdownActive(deleteBtn)) {
        cancelDeleteCountdown(deleteBtn, {
          countingClass: "ai-planner-btn--counting",
        });
        return;
      }

      startDeleteCountdown(deleteBtn, {
        countingClass: "ai-planner-btn--counting",
        onConfirm: async () => {
          const ok = await deleteReminder(reminderId);
          if (ok) {
            showToast("Видалено", "success");
            close();
            await refreshPlanner(plannerContainer);
          } else {
            showToast("Помилка видалення", "error");
          }
        },
      });
    });

  // Зберегти
  overlay
    .querySelector("#planner-modal-save")
    ?.addEventListener("click", async () => {
      const title = (
        overlay.querySelector("#planner-title") as HTMLInputElement
      ).value.trim();
      if (!title) {
        showToast("Вкажіть назву!", "error");
        return;
      }

      const description =
        (
          overlay.querySelector("#planner-desc") as HTMLTextAreaElement
        ).value.trim() || null;
      const recipientsVal = (
        overlay.querySelector("#planner-recipients") as HTMLInputElement
      ).value;

      const parsedRecipients = recipientsVal.startsWith("user_")
        ? [Number(recipientsVal.replace("user_", ""))]
        : recipientsVal;

      const reminder: Partial<Reminder> = {
        title,
        description,
        reminder_type: selectedType as any,
        priority: selectedPriority as any,
        channel: selectedChannel as any,
        recipients: parsedRecipients as any,
      };

      // Тип-специфічні поля
      if (selectedType === "once") {
        const triggerAt = (
          overlay.querySelector("#planner-trigger-at") as HTMLInputElement
        ).value;
        if (!triggerAt) {
          showToast("Вкажіть дату/час!", "error");
          return;
        }
        const isoTrigger = new Date(triggerAt).toISOString();
        reminder.trigger_at = isoTrigger;
        // Синхронізуємо next_trigger_at — саме за ним працює get_due_reminders
        reminder.next_trigger_at = isoTrigger;
        // Якщо редагуємо завершене — повертаємо в active
        reminder.status = "active" as any;
      } else if (selectedType === "recurring") {
        const schedType = (
          overlay.querySelector("#planner-schedule-type") as HTMLSelectElement
        ).value;
        const schedule: any = { type: schedType };

        if (
          schedType === "daily" ||
          schedType === "weekly" ||
          schedType === "monthly"
        ) {
          schedule.time =
            (
              overlay.querySelector(
                "#planner-schedule-time",
              ) as HTMLInputElement
            ).value || "09:00";
        }

        if (schedType === "weekly") {
          schedule.days = Array.from(
            overlay.querySelectorAll(
              "#planner-days-group .ai-planner-btn-option--active",
            ),
          )
            .map((btn) => (btn as HTMLElement).dataset.day)
            .filter(Boolean);
          if (schedule.days.length === 0) {
            showToast("Оберіть хоча б один день!", "error");
            return;
          }
        }

        if (schedType === "monthly") {
          schedule.day =
            Number(
              (
                overlay.querySelector(
                  "#planner-schedule-day",
                ) as HTMLInputElement
              ).value,
            ) || 1;
        }

        if (schedType === "interval") {
          schedule.hours =
            Number(
              (
                overlay.querySelector(
                  "#planner-schedule-hours",
                ) as HTMLInputElement
              ).value,
            ) || 0;
          schedule.minutes =
            Number(
              (
                overlay.querySelector(
                  "#planner-schedule-minutes",
                ) as HTMLInputElement
              ).value,
            ) || 0;
          if (schedule.hours === 0 && schedule.minutes === 0) {
            showToast("Вкажіть хоча б 1 хвилину або 1 годину!", "error");
            return;
          }
        }

        reminder.schedule = schedule;
        // Перерахувати next_trigger_at тільки якщо розклад змінився або це нове нагадування
        if (isEdit && existing?.next_trigger_at) {
          const oldSchedule = existing.schedule;
          const scheduleChanged =
            !oldSchedule ||
            oldSchedule.type !== schedule.type ||
            oldSchedule.time !== schedule.time ||
            oldSchedule.hours !== schedule.hours ||
            oldSchedule.minutes !== schedule.minutes ||
            oldSchedule.day !== schedule.day ||
            JSON.stringify(oldSchedule.days || []) !==
              JSON.stringify(schedule.days || []);
          if (scheduleChanged) {
            reminder.next_trigger_at = calculateNextTrigger(schedule) as any;
          }
          // Якщо розклад не змінився — не чіпаємо next_trigger_at
        } else {
          reminder.next_trigger_at = calculateNextTrigger(schedule) as any;
        }
      } else if (selectedType === "conditional") {
        const condDesc = (
          overlay.querySelector(
            "#planner-condition-desc",
          ) as HTMLTextAreaElement
        ).value.trim();
        let condQuery = (
          overlay.querySelector(
            "#planner-condition-query",
          ) as HTMLTextAreaElement
        ).value.trim();

        if (!condDesc && !condQuery) {
          showToast("Опишіть умову!", "error");
          return;
        }

        // Якщо є опис але немає query — генеруємо через ШІ
        if (condDesc && !condQuery) {
          const condFreqEarly = (
            overlay.querySelector("#planner-cond-freq") as HTMLSelectElement
          ).value;
          try {
            if (
              condFreqEarly === "realtime" &&
              !isTelegramDeliveryChannel(selectedChannel)
            ) {
              showToast("🤖 Генерую правило Контролю...", "info");
              condQuery = await generateRealtimeRuleFromDescription(condDesc);
              // Витягуємо тільки JSON якщо ШІ повернув зайвий текст
              const jsonMatch = condQuery.match(/\{[\s\S]*\}/);
              if (jsonMatch) condQuery = jsonMatch[0];
            } else {
              showToast(
                condFreqEarly === "realtime"
                  ? "🤖 Генерую серверну SQL-перевірку..."
                  : "🤖 Генерую SQL...",
                "info",
              );
              condQuery = await generateSQLFromDescription(condDesc);
            }
            (
              overlay.querySelector(
                "#planner-condition-query",
              ) as HTMLTextAreaElement
            ).value = condQuery;
          } catch {
            showToast("Помилка генерації запиту", "error");
            return;
          }
        }

        const condFreq = (
          overlay.querySelector("#planner-cond-freq") as HTMLSelectElement
        ).value;
        const useServerTelegramControl =
          condFreq === "realtime" && isTelegramDeliveryChannel(selectedChannel);

        if (useServerTelegramControl && isJsonRealtimeRule(condQuery)) {
          if (!condDesc) {
            showToast(
              "Для Telegram контролю потрібен опис умови, щоб згенерувати SQL",
              "error",
            );
            return;
          }
          try {
            showToast(
              "🤖 Переводжу контроль у серверну SQL-перевірку...",
              "info",
            );
            condQuery = await generateSQLFromDescription(condDesc);
            (
              overlay.querySelector(
                "#planner-condition-query",
              ) as HTMLTextAreaElement
            ).value = condQuery;
          } catch {
            showToast("Не вдалося згенерувати серверну SQL-перевірку", "error");
            return;
          }
        }

        reminder.condition_query = condQuery;
        if (!reminder.meta) reminder.meta = {} as any;
        (reminder as any).meta = {
          ...(reminder as any).meta,
          condition_description: condDesc,
          condition_mode: useServerTelegramControl
            ? "server_realtime_sql"
            : condFreq === "realtime"
              ? "browser_realtime"
              : condFreq,
        };

        if (condFreq === "once") {
          const triggerAt = (
            overlay.querySelector("#planner-trigger-at") as HTMLInputElement
          ).value;
          if (!triggerAt) {
            showToast("Вкажіть коли перевірити умову!", "error");
            return;
          }
          const isoTrigger = new Date(triggerAt).toISOString();
          reminder.trigger_at = isoTrigger;
          reminder.next_trigger_at = isoTrigger as any;
        } else if (useServerTelegramControl) {
          const schedule = createServerConditionSchedule();
          reminder.schedule = schedule as any;
          reminder.trigger_at = null as any;
          reminder.next_trigger_at = null as any;
        } else if (condFreq === "realtime") {
          // Режим контролю — без часу, моніторинг змін у реальному часі
          reminder.schedule = { type: "realtime" } as any;
          reminder.trigger_at = null as any;
          reminder.next_trigger_at = null as any;
        } else {
          const schedType = (
            overlay.querySelector("#planner-schedule-type") as HTMLSelectElement
          ).value;
          const schedule: any = { type: schedType };

          if (
            schedType === "daily" ||
            schedType === "weekly" ||
            schedType === "monthly"
          ) {
            schedule.time =
              (
                overlay.querySelector(
                  "#planner-schedule-time",
                ) as HTMLInputElement
              ).value || "09:00";
          }

          if (schedType === "weekly") {
            schedule.days = Array.from(
              overlay.querySelectorAll(
                "#planner-days-group .ai-planner-btn-option--active",
              ),
            )
              .map((btn) => (btn as HTMLElement).dataset.day)
              .filter(Boolean);
            if (schedule.days.length === 0) {
              showToast("Оберіть хоча б один день!", "error");
              return;
            }
          }

          if (schedType === "monthly") {
            schedule.day =
              Number(
                (
                  overlay.querySelector(
                    "#planner-schedule-day",
                  ) as HTMLInputElement
                ).value,
              ) || 1;
          }

          if (schedType === "interval") {
            schedule.hours =
              Number(
                (
                  overlay.querySelector(
                    "#planner-schedule-hours",
                  ) as HTMLInputElement
                ).value,
              ) || 4;
          }

          reminder.schedule = schedule;
          reminder.next_trigger_at = calculateNextTrigger(schedule) as any;
        }

        reminder.status = "active" as any;
      }

      // Зберігаємо
      let ok: boolean;
      if (isEdit && editingReminderId) {
        ok = await updateReminder(editingReminderId, reminder as any);
      } else {
        ok = await createReminder(reminder);
      }

      if (ok) {
        showToast(isEdit ? "Збережено ✅" : "Створено ✅", "success");
        close();
        await refreshPlanner(plannerContainer);
      } else {
        showToast("Помилка збереження", "error");
      }
    });
}

let plannerSubscriptions: DatabaseSubscription[] = [];
let currentPlannerContainer: HTMLElement | null = null;
let plannerOwner = "";
let plannerGeneration = 0;
let plannerCallbackRevision = 0;
let plannerSnapshotLoading = false;
let plannerHasSnapshot = false;
let plannerSnapshotNeeded = false;
let plannerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let plannerRefreshRunning = false;
const plannerCallbackDirty = new Set<number>();
const plannerSnapshotEvents = new Map<number, any>();

function currentPlannerOwner(): string {
  try { return localStorage.getItem("userAuthData") || ""; } catch { return ""; }
}

function isPlannerVisible(): boolean {
  return !!currentPlannerContainer?.isConnected && !currentPlannerContainer.closest(".hidden") && !document.hidden;
}

function plannerRowVisible(row: any, existing?: ReminderFromRPC): boolean | null {
  if (getCurrentUserRole() === "Адміністратор") return true;
  const user = getCurrentSlyusarId();
  if (!user) return false;
  // Existing rows retain the authorization granted by get_my_reminders.
  // Changed recipient rules/new rows require that RPC to resolve its exact access semantics.
  if (existing && JSON.stringify(existing.recipients) === JSON.stringify(row.recipients)
      && (row.created_by == null || existing.created_by == null || row.created_by === existing.created_by)) return true;
  return null;
}

function applyPlannerReminderEvent(payload: any, locallySaved = false): void {
  const id = Number(payload.new?.reminder_id || payload.old?.reminder_id);
  if (!id) return;
  const index = reminders.findIndex(row => row.reminder_id === id);
  if (payload.eventType === "DELETE") {
    if (index >= 0) reminders.splice(index, 1);
    callbackLogs.delete(id);
    return;
  }
  const row = payload.new;
  const existing = index >= 0 ? reminders[index] : undefined;
  const visible = locallySaved ? true : plannerRowVisible(row, existing);
  if (visible === null) { plannerSnapshotNeeded = true; return; }
  if (!visible) { if (index >= 0) reminders.splice(index, 1); return; }
  const next = { ...existing, ...row,
    creator_name: plannerCreatorNames.get(Number(row.created_by)) || existing?.creator_name || "—",
    is_mine: row.created_by == null ? existing?.is_mine === true : Number(row.created_by) === getCurrentSlyusarId(),
  } as ReminderFromRPC;
  if (index >= 0) reminders[index] = next;
  else { reminders.unshift(next); plannerCallbackDirty.add(id); }
  reminders.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function schedulePlannerRefresh(): void {
  if (!isPlannerVisible() || plannerRefreshTimer) return;
  plannerRefreshTimer = setTimeout(() => {
    plannerRefreshTimer = null;
    void flushPlannerRefresh();
  }, 150);
}

async function loadMissingPlannerCreatorNames(): Promise<void> {
  const ids = [...new Set(reminders.map(row => Number(row.created_by)).filter(id => id > 0 && !plannerCreatorNames.has(id)))];
  if (!ids.length) return;
  const generation = plannerGeneration;
  const owner = plannerOwner;
  const { data, error } = await supabase.from("slyusars").select("slyusar_id,name:data->>Name").in("slyusar_id", ids);
  if (error || generation !== plannerGeneration || owner !== currentPlannerOwner()) return;
  for (const id of ids) plannerCreatorNames.set(id, "—");
  for (const row of data || []) plannerCreatorNames.set(Number(row.slyusar_id), row.name || "—");
  for (const row of reminders) row.creator_name = plannerCreatorNames.get(Number(row.created_by)) || row.creator_name;
}

async function flushPlannerRefresh(): Promise<void> {
  if (plannerRefreshRunning || plannerSnapshotLoading || !isPlannerVisible()) return;
  if (plannerOwner !== currentPlannerOwner()) { suspendPlannerTab(); return; }
  plannerRefreshRunning = true;
  const generation = plannerGeneration;
  try {
    if (plannerSnapshotNeeded) await synchronizePlannerSnapshot();
    const ids = [...plannerCallbackDirty];
    plannerCallbackDirty.clear();
    if (ids.length) await loadCallbackLogs(ids);
    await loadMissingPlannerCreatorNames();
    if (generation !== plannerGeneration || !isPlannerVisible()) return;
    
    emitPlannerReminderCount();
    await renderPlannerPanel(currentPlannerContainer!);
  } finally {
    if (generation === plannerGeneration) {
      plannerRefreshRunning = false;
      if (plannerSnapshotNeeded || plannerCallbackDirty.size) schedulePlannerRefresh();
    }
  }
}

async function synchronizePlannerSnapshot(): Promise<void> {
  if (plannerSnapshotLoading) return;
  plannerSnapshotNeeded = false;
  plannerSnapshotLoading = true;
  plannerSnapshotEvents.clear();
  const generation = plannerGeneration;
  const owner = plannerOwner;
  try {
    const rows = await loadReminders(true);
    if (generation !== plannerGeneration || owner !== currentPlannerOwner()) return;
    reminders = rows;
    // HTTP responses may predate a change already delivered by the subscribed stream.
    for (const payload of plannerSnapshotEvents.values()) applyPlannerReminderEvent(payload);
    await loadCallbackLogs(reminders.map(row => row.reminder_id));
    if (generation !== plannerGeneration || owner !== currentPlannerOwner()) return;
    plannerHasSnapshot = true;
  } catch {
    if (generation === plannerGeneration && isPlannerVisible()) showToast("Не вдалося оновити повідомлення. Повторно відкрийте вкладку.", "error");
  } finally {
    if (generation === plannerGeneration) { plannerSnapshotLoading = false; plannerSnapshotEvents.clear(); }
  }
}

function ensurePlannerRealtimeSync(): void {
  if (plannerSubscriptions.length) return;
  let previouslySubscribed = false;
  plannerSubscriptions.push(databaseSubscriptions.subscribe(
    { table: "atlas_reminders", select: REMINDER_CHANGE_COLUMNS },
    payload => {
      if (!isPlannerVisible() || plannerOwner !== currentPlannerOwner()) return;
      const id = Number(payload.new?.reminder_id || payload.old?.reminder_id);
      if (!id) return;
      if (plannerSnapshotLoading) plannerSnapshotEvents.set(id, payload);
      applyPlannerReminderEvent(payload);
      schedulePlannerRefresh();
    },
    status => {
      if (status === "SUBSCRIBED") {
        // A first join may complete after the HTTP snapshot started. Reconcile that gap once too.
        if (previouslySubscribed || plannerHasSnapshot || plannerSnapshotLoading) { plannerSnapshotNeeded = true; schedulePlannerRefresh(); }
        previouslySubscribed = true;
      }
    }, plannerOwner,
  ));
  const callbackColumns = ["log_id", "reminder_id", "delivery_status", "message_text", "sent_at"];
  const callbackJoined = new Set<string>();
  const onCallbackStatus = (event: string, status: string) => {
    if (status !== "SUBSCRIBED") { callbackJoined.delete(event); return; }
    callbackJoined.add(event);
    if (callbackJoined.size !== 3) return;
    // Callback streams can join later than the reminder stream and the HTTP snapshot.
    plannerCallbackRevision++;
    for (const reminder of reminders) plannerCallbackDirty.add(reminder.reminder_id);
    schedulePlannerRefresh();
  };
  const onCallback = (payload: any) => {
    if (!isPlannerVisible() || plannerOwner !== currentPlannerOwner()) return;
    const row = payload.new;
    const id = Number(row?.reminder_id);
    if (row?.delivery_status !== "callback" || !reminders.some(reminder => reminder.reminder_id === id)) return;
    plannerCallbackRevision++;
    if (payload.eventType === "UPDATE") plannerCallbackDirty.add(id);
    else {
      const previous = callbackLogs.get(id);
      if (!previous || row.sent_at >= previous.sent_at) callbackLogs.set(id, row);
    }
    schedulePlannerRefresh();
  };
  for (const event of ["INSERT", "UPDATE"] as const) {
    plannerSubscriptions.push(databaseSubscriptions.subscribe(
      { table: "atlas_reminder_logs", event, filter: "delivery_status=eq.callback", select: callbackColumns },
      onCallback, status => onCallbackStatus(event, status), plannerOwner,
    ));
  }
  // DELETE cannot use a row filter reliably; only removal of a cached latest callback needs a read.
  plannerSubscriptions.push(databaseSubscriptions.subscribe(
    { table: "atlas_reminder_logs", event: "DELETE", select: ["log_id"] },
    payload => {
      if (!isPlannerVisible() || plannerOwner !== currentPlannerOwner()) return;
      const deleted = Number(payload.old?.log_id);
      const match = [...callbackLogs].find(([, row]) => Number((row as any).log_id) === deleted);
      if (!match) return;
      plannerCallbackRevision++;
      plannerCallbackDirty.add(match[0]);
      schedulePlannerRefresh();
    }, status => onCallbackStatus("DELETE", status), plannerOwner,
  ));
}

/** Release UI detail streams only; aiReminderChecker continues background delivery. */
export function suspendPlannerTab(): void {
  plannerGeneration++;
  for (const subscription of plannerSubscriptions) subscription.unsubscribe();
  plannerSubscriptions = [];
  if (plannerRefreshTimer) clearTimeout(plannerRefreshTimer);
  plannerRefreshTimer = null;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  plannerSnapshotLoading = false;
  plannerHasSnapshot = false;
  plannerSnapshotNeeded = false;
  plannerRefreshRunning = false;
  plannerSnapshotEvents.clear();
  plannerCallbackDirty.clear();
}

export async function initPlannerTab(container: HTMLElement): Promise<void> {
  currentPlannerContainer = container;
  if (!isPlannerVisible()) return;
  const owner = currentPlannerOwner();
  if (plannerSubscriptions.length && plannerOwner === owner) { schedulePlannerRefresh(); return; }
  suspendPlannerTab();
  if (plannerOwner !== owner) {
    reminders = [];
    callbackLogs.clear();
    plannerCreatorNames.clear();
    telegramUsers = [];
    telegramLinked = null;
    telegramBotReady = null;
  }
  plannerOwner = owner;
  const generation = plannerGeneration;
  container.innerHTML = '<div class="ai-planner-loading"><div class="ai-spinner"></div><span>Завантаження повідомлень...</span></div>';
  ensurePlannerRealtimeSync();
  await Promise.all([
    loadTelegramUsers(),
    telegramLinked === null ? checkTelegramLink() : Promise.resolve(),
    telegramBotReady === null ? checkTelegramBotReady() : Promise.resolve(),
    synchronizePlannerSnapshot(),
  ]);
  if (generation !== plannerGeneration || owner !== currentPlannerOwner() || !isPlannerVisible()) return;
  
  emitPlannerReminderCount();
  await renderPlannerPanel(container);
  startCountdownTimer();
  if (plannerSnapshotNeeded || plannerCallbackDirty.size) schedulePlannerRefresh();
}
/**
 * Примусово оновити вкладку "Повідомлення", якщо вона відкрита в чаті.
 * Використовується після function-calling create_reminder, коли модель може
 * не повернути фінальний текст через 429/500, але нагадування вже збережено.
 */
export async function refreshPlannerTabIfMounted(): Promise<void> {
  if (!currentPlannerContainer) return;
  if (!isPlannerVisible()) return;
  await refreshPlanner(currentPlannerContainer);
}

// ═══════════════════════════════════════
// 🔧 FUNCTION CALLING — Tool Declaration
// ═══════════════════════════════════════

/** Tool declaration для Gemini/Groq Function Calling */
export function getReminderToolDeclaration() {
  return {
    name: "create_reminder",
    description:
      'Створити нагадування/задачу/повідомлення тільки коли користувач ЯВНО просить це зробити: "нагадай", "заплануй", "не забудь", "створи нагадування", "відправ повідомлення", "надішли повідомлення". ' +
      "НЕ викликай цей інструмент для звичайних питань, пошуку, звітів, списків актів або аналізу фото. " +
      'ВАЖЛИВО: якщо вказано час ("о 21:30") → заповни trigger_at як ISO. ' +
      'Якщо відносний час ("через годину","через 30 хвилин","через пів години") → заповни delay_hours/delay_minutes. ' +
      'Якщо вказано кому ("браславчу","івану") → заповни recipient_name. ' +
      'Якщо є фраза "відправ повідомлення"/"надішли повідомлення" → channel=telegram.',
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Коротка назва нагадування",
        },
        description: {
          type: "string",
          description:
            "Детальний опис (необов'язково). Текст повідомлення якщо вказано.",
        },
        reminder_type: {
          type: "string",
          enum: ["once", "recurring", "conditional"],
          description:
            "once=одноразове, recurring=повторюване, conditional=умовне SQL. Для Telegram умов використовуй SQL-перевірку, не realtime JSON.",
        },
        trigger_at: {
          type: "string",
          description:
            'ISO дата/час для once. Приклади: "о 21:30" → сьогодні 21:30 ISO, "в середу" → найближча середа. Формат: YYYY-MM-DDTHH:mm:ss. НЕ використовуй для відносного часу (через X) — для цього використай delay_hours/delay_minutes.',
        },
        delay_hours: {
          type: "number",
          description:
            'Відносний час в годинах від зараз. "через годину"/"через час" → 1, "через 2 години" → 2, "через пів години"/"півчаса" → 0.5',
        },
        delay_minutes: {
          type: "number",
          description:
            'Відносний час в хвилинах від зараз. "через 30 хвилин" → 30, "через 15 хв" → 15, "через 5 хвилин" → 5. Може комбінуватися з delay_hours.',
        },
        schedule_type: {
          type: "string",
          enum: ["daily", "weekly", "monthly", "interval"],
          description: "Тип розкладу для recurring",
        },
        schedule_time: {
          type: "string",
          description: "Час HH:MM. За замовч '09:00'",
        },
        schedule_days: {
          type: "array",
          items: {
            type: "string",
            enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          },
          description: "Дні тижня для weekly",
        },
        schedule_day: {
          type: "number",
          description: "День місяця для monthly (1-31)",
        },
        schedule_hours: {
          type: "number",
          description:
            "Кількість годин для interval (наприклад 1 = кожну годину)",
        },
        schedule_minutes: {
          type: "number",
          description:
            "Кількість хвилин для interval (наприклад 30 = кожні 30 хв). Використовується разом або замість schedule_hours",
        },
        recipients: {
          type: "string",
          description:
            "self=тільки мені, all=всім, mechanics=слюсарам. За замовч 'self'. Якщо вказано конкретну людину → використай recipient_name замість цього поля.",
        },
        recipient_name: {
          type: "string",
          description:
            'Ім\'я/прізвище конкретного одержувача. Приклад: "браславчу" → "Браславець", "івану" → "Іван". Система знайде користувача автоматично.',
        },
        channel: {
          type: "string",
          enum: ["app", "telegram", "both"],
          description:
            'Канал доставки. "відправ повідомлення"/"надішли" → telegram. "нагадай" → app. За замовч: якщо є recipient_name → telegram, інакше app.',
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "За замовч 'normal'",
        },
        condition_query: {
          type: "string",
          description:
            "SQL SELECT для conditional. Спрацьовує якщо є рядки. Для Telegram/Обидва не передавай JSON realtime-правило.",
        },
      },
      required: ["title", "reminder_type"],
    },
  };
}

/**
 * Додає локальний часовий пояс до ISO-рядка, якщо його немає.
 * AI генерує '2026-03-09T09:00:00' (без TZ) — Supabase трактує як UTC.
 * Додаємо зсув браузера, щоб час зберігався правильно.
 */
function ensureTimezone(isoString: string): string {
  // Вже має часовий пояс (Z, +03:00, -05:00 тощо)
  if (/[Zz]$/.test(isoString) || /[+-]\d{2}:\d{2}$/.test(isoString)) {
    return isoString;
  }
  // Додаємо локальний зсув
  const offset = new Date().getTimezoneOffset(); // хвилин від UTC (від'ємне = схід)
  const sign = offset <= 0 ? "+" : "-";
  const absH = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const absM = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${isoString}${sign}${absH}:${absM}`;
}

/**
 * Fallback: витягнути абсолютний час із тексту ("на 17:00", "о 21:30", "в 9:00").
 * Повертає рядок "HH:MM" або null.
 */
function extractAbsoluteTimeFromText(text: string): string | null {
  const t = (text || "").toLowerCase();
  // "на 17:00", "о 21:30", "в 9:00", "до 14:00"
  const m = t.match(/(?:на|о|об|в|до)\s+(\d{1,2})[:\s](\d{2})\b/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Fallback: витягти відносний час з натуральної фрази, якщо модель не передала delay_*.
 * Підтримує також часті помилки розпізнавання типу "півногиди".
 */
function extractRelativeDelayFromText(text: string): {
  delayHours?: number;
  delayMinutes?: number;
} {
  const t = (text || "").toLowerCase();
  if (!t) return {};

  // "через пів години" / "через півгодини" / помилки типу "півногиди"
  if (/через\s+пів[\w'’\-\s]*год/i.test(t) || /через\s+півногид/i.test(t)) {
    return { delayMinutes: 30 };
  }

  // "через 30 хв", "через 15 хвилин"
  const minMatch = t.match(/через\s+(\d{1,3})\s*(хв|хвилин|хвилини|хвилину)/i);
  if (minMatch) {
    return { delayMinutes: Number(minMatch[1]) || 0 };
  }

  // "через 1 год", "через 2 години", "через годину"
  const hrNumMatch = t.match(
    /через\s+(\d{1,3})\s*(год|години|годину|г|hours?)/i,
  );
  if (hrNumMatch) {
    return { delayHours: Number(hrNumMatch[1]) || 0 };
  }
  if (/через\s+годин[ауи]?/i.test(t) || /через\s+год\b/i.test(t)) {
    return { delayHours: 1 };
  }

  return {};
}

/**
 * Fallback: витягти ймовірного одержувача з фрази, якщо модель не передала recipient_name.
 */
function extractRecipientNameFromText(text: string): string | null {
  const src = (text || "").trim();
  if (!src) return null;

  // Приклади: "Заплануй Шелест О. Г повідомлення ...", "надішли Бондару повідомлення ..."
  const m = src.match(
    /(?:заплануй|запланувати|нагадай|створи\s+нагадування|надішли(?:\s+.+?)?\s+повідомлення|відправ(?:ити)?(?:\s+.+?)?\s+повідомлення)\s+(.+?)(?:\s+повідомлення|\s+нагадування|\s+через\b|\s+о\s+\d|\s+на\s+\d|$)/i,
  );
  if (!m) return null;

  const candidate = m[1]
    .replace(/[,:;]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!candidate || candidate.length < 2) return null;
  return candidate;
}

function hasExplicitReminderIntent(text: string): boolean {
  const src = (text || "").trim().toLowerCase();
  if (!src) return false;

  return /(?:нагадай|нагадування|не забудь|заплануй|запланувати|створи нагадування|постав нагадування|відправ повідомлення|відправити повідомлення|надішли повідомлення|повідом мені|повідом мене|сповісти)/i.test(
    src,
  );
}

/** Виконує створення нагадування через Function Calling */
export async function executeCreateReminder(
  args: Record<string, any>,
): Promise<string> {
  try {
    const sourceText = [
      args.__source_user_message,
      args.user_message,
      args.original_query,
      args.query,
      args.prompt,
    ]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" ")
      .trim();

    // Fallback-джерело природного тексту, якщо модель повернула неповні аргументи.
    const rawText = [sourceText, args.title, args.description]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" ")
      .trim();

    if (!hasExplicitReminderIntent(sourceText)) {
      return JSON.stringify({
        success: false,
        error:
          "create_reminder скасовано: у запиті немає явного прохання створити нагадування або повідомлення.",
      });
    }

    if (!args.title || typeof args.title !== "string" || !args.title.trim()) {
      return JSON.stringify({
        success: false,
        error:
          "create_reminder скасовано: модель не передала назву нагадування.",
      });
    }

    // Якщо recipient_name не прийшов — пробуємо витягнути з тексту
    if (!args.recipient_name && rawText) {
      const fallbackRecipient = extractRecipientNameFromText(rawText);
      if (fallbackRecipient) {
        args.recipient_name = fallbackRecipient;
      }
    }

    // Якщо delay_* не прийшли — пробуємо витягнути "через ..." з тексту
    if (
      args.trigger_at == null &&
      args.delay_hours == null &&
      args.delay_minutes == null &&
      rawText
    ) {
      const delay = extractRelativeDelayFromText(rawText);
      if (typeof delay.delayHours === "number")
        args.delay_hours = delay.delayHours;
      if (typeof delay.delayMinutes === "number")
        args.delay_minutes = delay.delayMinutes;
    }

    // Якщо trigger_at і delay досі порожні — пробуємо витягнути абсолютний час "на 17:00" / "о 21:30"
    if (
      args.trigger_at == null &&
      args.delay_hours == null &&
      args.delay_minutes == null &&
      rawText
    ) {
      const absTime = extractAbsoluteTimeFromText(rawText);
      if (absTime) {
        args.trigger_at = absTime;
      }
    }

    // Визначити канал: якщо є recipient_name і канал не вказано → telegram
    const channel = args.channel || (args.recipient_name ? "telegram" : "app");

    const reminder: Partial<Reminder> = {
      title: args.title,
      description: args.description || null,
      reminder_type: args.reminder_type || "once",
      priority: (args.priority || "normal") as any,
      channel: channel as any,
      recipients: (args.recipients || "self") as any,
    };

    // Якщо вказано конкретного одержувача по імені — знайти його в БД
    if (args.recipient_name) {
      const recipientIds = await lookupRecipientByName(args.recipient_name);
      if (recipientIds.length > 0) {
        reminder.recipients = recipientIds as any;
      }
    }

    // Одноразове (використовуємо resolved тип, бо AI може не передати reminder_type)
    const resolvedType = args.reminder_type || "once";
    if (resolvedType === "once") {
      let triggerAt = args.trigger_at;

      // Якщо є delay_days ("завтра"/"після завтра") — обчислити trigger_at
      if (args.delay_days != null && args.delay_days > 0) {
        const target = new Date();
        target.setDate(target.getDate() + args.delay_days);
        // Якщо є trigger_time ("о 9:40") — встановити годину/хвилину
        if (args.trigger_time) {
          const [h, m] = args.trigger_time.split(":").map(Number);
          target.setHours(h || 0, m || 0, 0, 0);
        } else {
          target.setHours(9, 0, 0, 0); // за замовчуванням 09:00
        }
        triggerAt = target.toISOString();
      }

      // Якщо є delay_hours або delay_minutes — обчислити trigger_at від поточного часу
      if (
        !triggerAt &&
        (args.delay_hours != null || args.delay_minutes != null)
      ) {
        const delayMs =
          ((args.delay_hours || 0) * 60 + (args.delay_minutes || 0)) *
          60 *
          1000;
        if (delayMs > 0) {
          triggerAt = new Date(Date.now() + delayMs).toISOString();
        }
      }

      // Якщо AI передав тільки час (HH:MM або HH:MM:SS) — прив'язати до сьогоднішньої дати
      if (triggerAt && /^\d{1,2}:\d{2}(:\d{2})?$/.test(triggerAt.trim())) {
        const now = new Date();
        const [h, m] = triggerAt.trim().split(":").map(Number);
        now.setHours(h, m, 0, 0);
        // Якщо час вже минув сьогодні — ставимо на завтра
        if (now.getTime() <= Date.now()) {
          now.setDate(now.getDate() + 1);
        }
        triggerAt = now.toISOString();
      }

      if (triggerAt) {
        // AI генерує час без часового поясу — додаємо локальний зсув
        reminder.trigger_at = ensureTimezone(triggerAt);
      }
    }

    // Повторюване
    if (resolvedType === "recurring") {
      const schedule: any = {
        type: args.schedule_type || "daily",
      };
      if (args.schedule_time) schedule.time = args.schedule_time;
      else schedule.time = "09:00";

      if (args.schedule_type === "weekly" && args.schedule_days) {
        schedule.days = args.schedule_days;
      }
      if (args.schedule_type === "monthly" && args.schedule_day) {
        schedule.day = args.schedule_day;
      }
      if (args.schedule_type === "interval") {
        schedule.hours = args.schedule_hours || 0;
        schedule.minutes = args.schedule_minutes || 0;
        // Якщо обидва 0 — мінімум 1 година
        if (schedule.hours === 0 && schedule.minutes === 0) {
          schedule.hours = 1;
        }
      }
      reminder.schedule = schedule;
    }

    // Умовне
    if (resolvedType === "conditional") {
      let conditionQuery = String(args.condition_query || "").trim();
      const telegramCondition = isTelegramDeliveryChannel(channel);

      if (
        telegramCondition &&
        (!conditionQuery || isJsonRealtimeRule(conditionQuery))
      ) {
        try {
          conditionQuery = await generateSQLFromDescription(rawText);
        } catch {
          return JSON.stringify({
            success: false,
            error:
              "Не вдалося згенерувати серверну SQL-перевірку для Telegram-нагадування",
          });
        }
      }

      if (conditionQuery) {
        reminder.condition_query = conditionQuery;
      }

      if (telegramCondition) {
        const schedule = createServerConditionSchedule();
        reminder.schedule = schedule as any;
        reminder.trigger_at = null;
        reminder.next_trigger_at = null;
        reminder.meta = {
          ...(reminder.meta || {}),
          condition_mode: "server_realtime_sql",
          condition_description: rawText || args.title,
        };
      }
    }

    const ok = await createReminder(reminder);

    if (ok) {
      return JSON.stringify({
        success: true,
        message: `✅ Нагадування "${args.title}" створено!`,
        reminder_type: args.reminder_type,
        trigger_at: reminder.trigger_at || null,
        schedule: reminder.schedule || null,
        recipients: args.recipient_name || args.recipients || "self",
        channel: channel,
        priority: args.priority || "normal",
      });
    } else {
      return JSON.stringify({
        success: false,
        error: "Помилка створення нагадування",
      });
    }
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      error: `Помилка: ${err.message}`,
    });
  }
}

/**
 * Нормалізація ПІБ для нечіткого порівняння (включно з відмінками: "Шелесту" -> "шелест").
 */
function normalizeNameForMatch(value: string): string {
  const src = String(value || "")
    .toLowerCase()
    .replace(/[`'’".,:;!?()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!src) return "";

  const words = src
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      // Відкидаємо короткі ініціали типу "о", "г", "о."
      if (w.length <= 1) return "";
      // Грубе стемінг-послаблення для укр. відмінків прізвищ/імен
      return w.replace(
        /(ами|ями|ові|еві|ому|ему|ого|ути|угу|яти|ять|йти|йтеся|ьми|ник|ек|льськ|ський|ецьк|ська|ський|ньк|нках|ною|ньый|ньй|ного|ному|ніх|них|ного|ного|ному|ною|них|ник|ніч|енн|йни|яни|ани|ин|хм|мім|мою|мої|му|мом|ме|мом|мі|моїм|міст|міст|мім|мій|мою|мої|мім|мій|ця|ець|цю|ці|ці|цею|цями|ахів|ав|ив|ев|ов|ув|ям|ам|ем|ім|ом|ум|аль|льн|ьн|иль|иньк|ічешк|не|ня|ни|ным|иче|яче|юче|уче|раш|ращ|ращ|ати|ить|ять|яти|нии|ни|буте|бунут|рало|бло|чь|рь|ть|ь|жу|жа|жи|жы|чь|шь|щь|хь|ў|ў|"а|я|у|ю|і|и|е|o|y|ь|ій|ій|ій|ий|ій|ий|ой|ый|ій|ий|й)$/u,
        "",
      );
    })
    .filter(Boolean);

  return words.join(" ").trim();
}

/** Знаходить користувача за ім'ям/прізвищем у таблиці slyusars */
async function lookupRecipientByName(name: string): Promise<number[]> {
  try {
    const searchName = name.trim();
    if (!searchName) return [];

    let data: any[] | null = null;
    {
      const q = await selectSlyusarsWithRetry("slyusar_id, data");
      if (q.error || !q.data) return [];
      data = q.data as any[];
    }

    if (!data || data.length === 0) return [];

    const searchNorm = normalizeNameForMatch(searchName);
    if (!searchNorm) return [];
    const searchWords = searchNorm.split(" ").filter(Boolean);

    const matched = data.filter((row: any) => {
      const rawName = typeof row?.data?.Name === "string" ? row.data.Name : "";
      const rowNorm = normalizeNameForMatch(rawName);
      if (!rowNorm) return false;

      // Спочатку спробуємо exakten матч (всі слова)
      if (searchWords.every((sw) => rowNorm.includes(sw))) return true;

      // Якщо exakten не пройшов — спробуємо частковий матч (хоча б одне слово)
      return searchWords.some(
        (sw) => rowNorm.startsWith(sw) || rowNorm.includes(" " + sw),
      );
    });

    return matched.map((s: { slyusar_id: number }) => s.slyusar_id);
  } catch {
    return [];
  }
}
