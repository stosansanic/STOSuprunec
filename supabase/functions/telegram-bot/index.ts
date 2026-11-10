// supabase/functions/telegram-bot/index.ts
// ═══════════════════════════════════════════════════════
// 🤖 Telegram Bot Webhook — Атлас
// Обробляє вхідні повідомлення від Telegram Bot API:
//   /start         — інструкція прив'язки (Name + Пароль)
//   Name\nПароль   — прив'язка Telegram до акаунту слюсаря
//   /stop          — відв'язка
//   /status        — перевірка прив'язки
// ═══════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { operationalLog } from "../_shared/operationalLog.ts";

type DbTable<Row extends Record<string, unknown>> = {
  Row: Row;
  Insert: Partial<Row> & Record<string, unknown>;
  Update: Partial<Row> & Record<string, unknown>;
  Relationships: [];
};

type SettingsRow = {
  setting_id: number;
  "Загальні": string | null;
} & Record<string, unknown>;

type AtlasReminderRow = {
  reminder_id: number;
  status: string | null;
  updated_at: string | null;
} & Record<string, unknown>;

type AtlasReminderLogRow = {
  reminder_id: number;
  channel: string;
  message_text: string;
  delivery_status: string;
} & Record<string, unknown>;

type AtlasTelegramUserRow = {
  slyusar_id: number;
  telegram_chat_id: number;
  telegram_username: string | null;
  linked_at: string;
  is_active: boolean;
} & Record<string, unknown>;

type SlyusarRow = {
  slyusar_id: number;
  data: string | Record<string, unknown> | null;
} & Record<string, unknown>;

interface VerifySlyusarPasswordRow {
  is_valid: boolean;
  slyusar_id: number;
  user_name: string | null;
}

type Database = {
  public: {
    Tables: {
      settings: DbTable<SettingsRow>;
      atlas_reminders: DbTable<AtlasReminderRow>;
      atlas_reminder_logs: DbTable<AtlasReminderLogRow>;
      atlas_telegram_users: DbTable<AtlasTelegramUserRow>;
      slyusars: DbTable<SlyusarRow>;
    };
    Views: Record<string, never>;
    Functions: {
      verify_slyusar_password: {
        Args: { input_name: string; input_password: string };
        Returns: VerifySlyusarPasswordRow[];
      };
    };
  };
};

type DbClient = SupabaseClient<Database>;

interface TelegramUser {
  username?: string | null;
  first_name?: string | null;
}

interface TelegramChat {
  id?: number;
}

interface TelegramMessage {
  text?: string;
  message_id?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
}

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: TelegramMessage;
  from?: TelegramUser;
}

interface TelegramUpdate {
  action?: string;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 🔐 CORS: обмежені домени замість wildcard
function getCorsHeaders(req: Request): Record<string, string> {
  const allowedRaw = Deno.env.get("ALLOWED_ORIGINS") || "";
  const allowedOrigins = allowedRaw
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  const origin = req.headers.get("origin") || "";
  const isAllowed =
    allowedOrigins.length === 0 || allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0] || "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    Vary: "Origin",
  };
}

// 🔐 Rate limiting для спроб входу
const loginAttempts = new Map<number, { count: number; lastAttempt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 хвилин
const TELEGRAM_BOT_SETTING_ID = 19;

function isRateLimited(chatId: number): boolean {
  const entry = loginAttempts.get(chatId);
  if (!entry) return false;
  if (Date.now() - entry.lastAttempt > LOCKOUT_DURATION_MS) {
    loginAttempts.delete(chatId);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginAttempt(chatId: number, success: boolean): void {
  if (success) {
    loginAttempts.delete(chatId);
    return;
  }
  const entry = loginAttempts.get(chatId) || { count: 0, lastAttempt: 0 };
  entry.count += 1;
  entry.lastAttempt = Date.now();
  loginAttempts.set(chatId, entry);
}

async function loadTelegramBotToken(
  supabase: DbClient,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select('"Загальні"')
      .eq("setting_id", TELEGRAM_BOT_SETTING_ID)
      .maybeSingle();

    if (!error && data) {
      const token = String(data["Загальні"] || "").trim();
      if (token) return token;
    }
  } catch (e) {
    console.error("loadTelegramBotToken DB error:", e);
  }

  return "";
}

async function getTelegramBotInfo(token: string): Promise<Response> {
  const tgResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const tgText = await tgResp.text();
  return new Response(tgText, {
    status: tgResp.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

async function setupTelegramWebhook(
  token: string,
  supabaseUrl: string,
): Promise<Response> {
  const webhookUrl = `${supabaseUrl}/functions/v1/telegram-bot`;
  const tgResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
    }),
  });
  const tgResult = await tgResp.text();
  operationalLog(tgResp.ok ? "debug" : "error", "telegram.webhook.response", { status: tgResp.status });
  return new Response(tgResult, {
    status: tgResp.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error(
        "Missing env vars: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      );
      return new Response("OK", { status: 200 });
    }

    const supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE);
    const BOT_TOKEN = await loadTelegramBotToken(supabase);

    let update: TelegramUpdate = {};
    if (req.method !== "GET") {
      try {
        const payload: unknown = await req.json();
        update = isRecord(payload) ? (payload as TelegramUpdate) : {};
      } catch {
        update = {};
      }
    }

    if (!BOT_TOKEN) {
      if (update?.action === "bot_status" || update?.action === "setup_webhook") {
        return new Response(
          JSON.stringify({ ok: false, error: "Telegram bot token not configured" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      console.error("Telegram bot token not configured");
      return new Response("OK", { status: 200 });
    }

    // ────────────────────────────────
    // Встановлення webhook (одноразово)
    // GET ?setup_webhook=1
    // ────────────────────────────────
    const url = new URL(req.url);
    if (url.searchParams.get("setup_webhook") === "1" || update?.action === "setup_webhook") {
      const resp = await setupTelegramWebhook(BOT_TOKEN, SUPABASE_URL);
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ────────────────────────────────
    // Інформація про webhook
    // GET ?webhook_info=1
    // ────────────────────────────────
    if (url.searchParams.get("webhook_info") === "1") {
      const tgResp = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`,
      );
      const tgResult = await tgResp.text();
      return new Response(tgResult, {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (update?.action === "bot_status") {
      const resp = await getTelegramBotInfo(BOT_TOKEN);
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ────────────────────────────────
    // Callback Query (кнопки під повідомленням)
    // ────────────────────────────────
    const callbackQuery = update?.callback_query;
    if (callbackQuery) {
      const cbData = callbackQuery.data || "";
      const cbChatId = callbackQuery.message?.chat?.id;
      const cbMessageId = callbackQuery.message?.message_id;
      const cbUsername =
        callbackQuery.from?.first_name ||
        callbackQuery.from?.username ||
        "Користувач";

      // Формат: rem_done_123, rem_snooze_123, rem_skip_123
      const match = cbData.match(/^rem_(done|snooze|skip)_(\d+)$/);
      if (match && cbChatId) {
        const action = match[1];
        const reminderId = parseInt(match[2], 10);

        const actionLabels: Record<string, string> = {
          done: "✅ Виконано",
          snooze: "📅 Заплановано",
          skip: "❌ Не планую",
        };

        // Оновити статус нагадування в БД
        if (action === "done") {
          await supabase
            .from("atlas_reminders")
            .update({
              status: "completed",
              updated_at: new Date().toISOString(),
            })
            .eq("reminder_id", reminderId);
        } else if (action === "skip") {
          await supabase
            .from("atlas_reminders")
            .update({
              status: "cancelled",
              updated_at: new Date().toISOString(),
            })
            .eq("reminder_id", reminderId);
        }
        // snooze — нічого не міняємо, залишаємо active

        let realName = cbUsername;

        try {
          // Отримуємо прив'язаного співробітника за telegram_chat_id
          const { data: link } = await supabase
            .from("atlas_telegram_users")
            .select("slyusar_id")
            .eq("telegram_chat_id", cbChatId)
            .single();

          if (link?.slyusar_id) {
            const { data: slyusar } = await supabase
              .from("slyusars")
              .select("data")
              .eq("slyusar_id", link.slyusar_id)
              .single();

            if (slyusar?.data) {
              const d: unknown =
                typeof slyusar.data === "string"
                  ? JSON.parse(slyusar.data)
                  : slyusar.data;
              const name = isRecord(d) ? d["Name"] : undefined;
              if (typeof name === "string" && name.trim()) {
                realName = `${cbUsername} (${name})`;
              }
            }
          }
        } catch (e) {
          console.error("Error fetching real user name:", e);
        }

        // Записати лог
        await supabase.from("atlas_reminder_logs").insert({
          reminder_id: reminderId,
          channel: "telegram",
          message_text: `Відповідь: ${actionLabels[action]} (від ${realName})`,
          delivery_status: "callback",
        });

        // Відповісти на callback (попап)
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: callbackQuery.id,
              text: actionLabels[action],
            }),
          },
        );

        // Оновити повідомлення — прибрати кнопки, додати відмітку
        const originalText = callbackQuery.message?.text || "";
        const updatedText = `${originalText}\n\n─────────────\n${actionLabels[action]} — ${realName}`;

        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: cbChatId,
              message_id: cbMessageId,
              text: updatedText,
            }),
          },
        );
      }

      return new Response("OK", { status: 200 });
    }

    // Telegram надсилає об'єкт Update
    const message = update.message;
    const messageText = message?.text;
    const chatId = message?.chat?.id;
    if (!messageText || typeof chatId !== "number") {
      return new Response("OK", { status: 200 });
    }

    const text = messageText.trim();
    const username = message.from?.username || null;

    // ────────────────────────────────
    // /start — прив'язка через Name + Пароль
    // ────────────────────────────────
    if (text.startsWith("/start")) {
      const parts = text.split(" ");
      const linkCode = parts[1]?.trim();

      // Якщо є старий формат /start <id> — ігноруємо, просимо Name+Пароль
      if (linkCode) {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "⚠️ Формат змінився.\n\n" +
            "Для прив'язки надішліть ваше *ім'я* та *пароль* — кожне на окремому рядку.\n\n" +
            "Наприклад:\n" +
            "`Шевченко Т.Г.`\n" +
            "`11111`",
        );
        return new Response("OK", { status: 200 });
      }

      await sendTelegramMessage(
        BOT_TOKEN,
        chatId,
        "👋 Привіт! Я — *Атлас*, бот СТО\n\n" +
          "Для прив'язки Telegram надішліть *ім'я* та *пароль* — кожне на окремому рядку.\n\n" +
          "Наприклад:\n" +
          "`Шевченко Т.Г.`\n" +
          "`11111`",
      );
      return new Response("OK", { status: 200 });
    }

    // ────────────────────────────────
    // /stop — відв'язка
    // ────────────────────────────────
    if (text === "/stop") {
      const { error } = await supabase
        .from("atlas_telegram_users")
        .update({ is_active: false })
        .eq("telegram_chat_id", chatId);

      if (error) {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "❌ Помилка. Спробуйте пізніше.",
        );
      } else {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "🔕 Сповіщення вимкнено.\nЩоб увімкнути знову — зайдіть у Повідомлення та прив'яжіть Telegram повторно.",
        );
      }
      return new Response("OK", { status: 200 });
    }

    // ────────────────────────────────
    // /status — перевірка
    // ────────────────────────────────
    if (text === "/status") {
      const { data: link } = await supabase
        .from("atlas_telegram_users")
        .select("slyusar_id, is_active, linked_at")
        .eq("telegram_chat_id", chatId)
        .single();

      if (!link) {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "❌ Ваш Telegram не прив'язаний до жодного акаунту СТО.",
        );
      } else {
        const status = link.is_active ? "✅ Активний" : "🔕 Вимкнений";
        const linkedDate = new Date(link.linked_at).toLocaleDateString("uk-UA");
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          `📊 *Статус:* ${status}\n🆔 ID працівника: ${link.slyusar_id}\n📅 Прив'язано: ${linkedDate}`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    // ────────────────────────────────
    // Будь-яке інше повідомлення → спроба прив'язки через Name + Пароль
    // ────────────────────────────────

    // Перевіряємо чи це 2 рядки (Name + Пароль)
    const lines = text
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);

    if (lines.length === 2) {
      const inputName = lines[0];
      const inputPass = lines[1];

      // 🔐 Rate limiting check
      if (isRateLimited(chatId)) {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "⛔ *Забагато спроб.*\nСпробуйте через 15 хвилин.",
        );
        return new Response("OK", { status: 200 });
      }

      // 🔐 Верифікація через серверний RPC
      const { data: verifyResult, error: verifyErr } = await supabase.rpc(
        "verify_slyusar_password",
        { input_name: inputName, input_password: inputPass },
      );

      if (
        verifyErr ||
        !verifyResult ||
        verifyResult.length === 0 ||
        !verifyResult[0].is_valid
      ) {
        recordLoginAttempt(chatId, false);
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "❌ *Невірне ім'я або пароль.*\n\n" +
            "Перевірте дані та спробуйте ще раз.\n" +
            "Формат — кожне на окремому рядку:\n" +
            "`Ім'я`\n" +
            "`Пароль`",
        );
        return new Response("OK", { status: 200 });
      }

      const foundSlyusarId = verifyResult[0].slyusar_id;
      const slyusarName = verifyResult[0].user_name || inputName;

      // 🔐 Валідація chatId та slyusar_id
      if (!foundSlyusarId || typeof chatId !== "number" || chatId <= 0) {
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "❌ Невірні дані для прив'язки.",
        );
        return new Response("OK", { status: 200 });
      }

      recordLoginAttempt(chatId, true);

      const { error: upsertErr } = await supabase
        .from("atlas_telegram_users")
        .upsert(
          {
            slyusar_id: foundSlyusarId,
            telegram_chat_id: chatId,
            telegram_username: username,
            linked_at: new Date().toISOString(),
            is_active: true,
          },
          { onConflict: "slyusar_id" },
        );

      if (upsertErr) {
        console.error("Upsert error:", upsertErr);
        await sendTelegramMessage(
          BOT_TOKEN,
          chatId,
          "❌ Помилка прив'язки. Спробуйте пізніше.",
        );
        return new Response("OK", { status: 200 });
      }

      await sendTelegramMessage(
        BOT_TOKEN,
        chatId,
        `✅ *Прив'язано!*\n\n` +
          `👤 Працівник: *${slyusarName}*\n\n` +
          `Тепер ви будете отримувати нагадування від Атласа тут.\n` +
          `Для відключення — /stop`,
      );
      return new Response("OK", { status: 200 });
    }

    // Якщо не 2 рядки — показуємо допомогу
    // Перевіримо, чи вже прив'язаний
    const { data: existingLink } = await supabase
      .from("atlas_telegram_users")
      .select("slyusar_id, is_active")
      .eq("telegram_chat_id", chatId)
      .single();

    if (existingLink && existingLink.is_active) {
      await sendTelegramMessage(
        BOT_TOKEN,
        chatId,
        "🤖 Я — *Атлас*, бот нагадувань\n\n" +
          "✅ Ваш Telegram прив'язано.\n\n" +
          "Доступні команди:\n" +
          "/status — перевірити прив'язку\n" +
          "/stop — вимкнути сповіщення",
      );
    } else {
      await sendTelegramMessage(
        BOT_TOKEN,
        chatId,
        "🤖 Я — *Атлас*, бот нагадувань\n\n" +
          "Для прив'язки надішліть *ім'я* та *пароль* — кожне на окремому рядку.\n\n" +
          "Наприклад:\n" +
          "`Шевченко Т.Г.`\n" +
          "`11111`\n\n" +
          "Доступні команди:\n" +
          "/status — перевірити прив'язку\n" +
          "/stop — вимкнути сповіщення",
      );
    }

    return new Response("OK", { status: 200 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("telegram-bot error:", msg);
    // Завжди повертаємо 200, щоб Telegram не повторював запит
    return new Response("OK", { status: 200 });
  }
});

// ── Відправити повідомлення через Telegram Bot API ──

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("sendTelegramMessage error:", err);
  }
}
