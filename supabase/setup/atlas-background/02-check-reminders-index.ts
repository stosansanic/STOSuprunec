// Generated from maintained source. Paste the ENTIRE file into check-reminders/index.ts.
// All local dependencies included; no keys or passwords embedded.
// supabase/functions/check-reminders/index.ts
// ═══════════════════════════════════════════════════════
// 🔔 Check Reminders — спільне планування Telegram та повідомлень у програмі.
// Cron перевіряє строки всередині БД; HTTP викликається лише коли є робота.
// App-повідомлення очікують адресата в черзі, незалежно від доставки Telegram.
// Атомарні leases для обчислення та незалежних доставок адресатам/каналам.
// ═══════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.98.0";
// BEGIN INLINED: supabase/functions/_shared/operationalLog.ts
/** Small, payload-free operational events. Never pass provider bodies or credentials. */
type Counters = Partial<Record<"status" | "processed" | "sent" | "skipped" | "durationMs", number>>;
type Level = "debug" | "info" | "warn" | "error";

export function operationalLog(level: Level, event: string, counters: Counters = {}): void {
  // Diagnostics expire without a redeploy. Normal success events stay quiet.
  if (level === "debug") {
    const until = Date.parse(Deno.env.get("OPERATIONAL_DEBUG_UNTIL") || "");
    if (!Number.isFinite(until) || Date.now() >= until) return;
  }
  const numeric: Counters = {};
  for (const key of ["status", "processed", "sent", "skipped", "durationMs"] as const) {
    const value = counters[key];
    if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
  }
  const entry = JSON.stringify({ level, event: event.slice(0, 80), ...numeric });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

// END INLINED: supabase/functions/_shared/operationalLog.ts

// BEGIN INLINED: supabase/functions/_shared/reminderDelivery.ts
/** One delivery is a recipient + channel + occurrence, never the whole reminder. */
export type DeliveryOutcome = "delivered" | "failed" | "unknown";
export interface ReminderDeliveryRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ReminderOccurrence {
  reminder_id: number;
  trigger_count: number;
  condition_query: string | null;
  schedule: unknown;
  recipients: unknown;
  channel: string;
}
export function occurrenceArgs(reminder: ReminderOccurrence, generation?: string) {
  return {
    p_reminder_id: reminder.reminder_id,
    p_generation: generation || `scheduled:${reminder.trigger_count || 0}`,
    p_expected_trigger: reminder.trigger_count || 0,
    p_rule: { condition_query: reminder.condition_query, schedule: reminder.schedule,
      recipients: reminder.recipients, channel: reminder.channel },
  };
}
/** Only the winner sends. Missing RPC/error fails closed; no legacy duplicate-send fallback.
 * A process lost before start can recover its lease. Once sending started, loss of a
 * response is unknown and must be reconciled by an operator, not blindly retried. */
export async function deliverReminderOnce(
  db: ReminderDeliveryRpc, reminder: ReminderOccurrence, recipientId: number,
  channel: "app" | "telegram", send: () => Promise<DeliveryOutcome>, generation?: string, messageText?: string,
): Promise<DeliveryOutcome | "skipped"> {
  const args = { ...occurrenceArgs(reminder, generation), p_recipient_id: recipientId, p_channel: channel };
  const claim = await db.rpc("claim_reminder_delivery", args);
  if (claim.error) throw claim.error;
  const ticket = claim.data as { token?: string } | null;
  if (!ticket?.token) return "skipped";
  const tokenArgs = { p_reminder_id: reminder.reminder_id, p_token: ticket.token };
  const start = await db.rpc("start_reminder_delivery", tokenArgs);
  if (start.error) throw start.error;
  if (start.data !== true) return "skipped";
  let outcome: DeliveryOutcome;
  try { outcome = await send(); } catch { outcome = "unknown"; }
  const finish = await db.rpc("finish_reminder_delivery", { ...tokenArgs, p_outcome: outcome, p_message: messageText ?? null });
  if (finish.error) throw finish.error;
  if (finish.data !== true) throw new Error("Reminder delivery completion was not acknowledged");
  return outcome;
}

export async function eventGeneration(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return `event:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

// END INLINED: supabase/functions/_shared/reminderDelivery.ts

// BEGIN INLINED: supabase/functions/check-reminders/resultDigest.ts
/** Keep the legacy serialization for occurrence identity while storing only a digest.
 * An interrupted delivery created by the previous worker must retain its generation.
 */
export async function reminderResultDigest(serialized: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return `sha256:v1:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function matchesReminderResult(previous: unknown, digest: string): Promise<boolean> {
  if (typeof previous !== "string" || !previous) return false;
  if (previous.startsWith("sha256:v1:")) return previous === digest;
  // Old rows contain JSON.stringify(result), not a cryptographic hash.
  return await reminderResultDigest(previous) === digest;
}

// END INLINED: supabase/functions/check-reminders/resultDigest.ts

type DbTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
};

type JsonObject = Record<string, unknown>;

type Database = {
  public: {
    Tables: {
      settings: DbTable;
      atlas_reminders: DbTable;
      atlas_reminder_logs: DbTable;
      atlas_telegram_users: DbTable;
      slyusars: DbTable;
    };
    Views: Record<string, never>;
    Functions: {
      traffic_reminder_complete: { Args: {p_reminder_id:number;p_token:string;p_expected_trigger:number;p_rule:JsonObject;p_patch:JsonObject}; Returns:boolean };
      traffic_reminder_convert_rule: { Args: {p_reminder_id:number;p_token:string;p_rule:JsonObject;p_query:string}; Returns:boolean };
      traffic_reminder_condition: { Args: {p_query:string;p_previous_hash:string|null}; Returns: {unchanged:boolean;hash:string;rows?:unknown[]} };
      traffic_reminder_checkpoint: { Args: {p_reminder_id:number;p_token:string;p_rule:JsonObject;p_patch:JsonObject}; Returns:boolean };
      traffic_reminder_queue_app: { Args: {p_reminder_id:number;p_token:string;p_generation:string;p_expected_trigger:number;p_rule:JsonObject;p_result_text:string|null}; Returns:number };
      traffic_reminder_candidates: { Args: { p_after: number | null; p_at: string }; Returns: { items: DueReminder[]; has_more: boolean; next_cursor: number | null } };
      claim_reminder_evaluation: { Args: {p_reminder_id:number;p_expected_trigger:number}; Returns:string|null };
      finish_reminder_evaluation: { Args: {p_reminder_id:number;p_token:string;p_success:boolean}; Returns:boolean };
      get_due_reminders: {
        Args: Record<string, never>;
        Returns: DueReminder[];
      };
      execute_condition_query: {
        Args: { query_text: string };
        Returns: unknown[];
      };
      trigger_reminder_generation: {
        Args: { p_reminder_id: number; p_expected_trigger: number };
        Returns: boolean;
      };
      trigger_reminder: {
        Args: { p_reminder_id: number };
        Returns: null;
      };
    };
  };
};

type DbClient = SupabaseClient<Database>;

// 🔐 CORS: обмежені домени замість wildcard
function getCorsHeaders(req: Request): Record<string, string> {
  const allowedRaw = Deno.env.get("ALLOWED_ORIGINS") || "";
  const allowedOrigins = allowedRaw
    .split(",")
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  const origin = req.headers.get("origin") || "";
  const isAllowed = allowedOrigins.length === 0 || allowedOrigins.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowedOrigins[0] || "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// ── Типи ──

interface DueReminder {
  reminder_id: number;
  title: string;
  description: string | null;
  reminder_type: string;
  recipients: unknown;
  channel: string;
  priority: string;
  condition_query: string | null;
  schedule: unknown;
  trigger_count: number;
  created_by: number | null;
  creator_name: string;
  meta: JsonObject | null;
  next_trigger_at?: string | null;
}

interface TelegramUser {
  slyusar_id: number;
  telegram_chat_id: number;
}

const TELEGRAM_BOT_SETTING_ID = 19;
const SERVER_WATCH_LIMIT = 20;

type DirectColumnType = "text" | "number" | "date" | "boolean" | "json";

interface WatchFieldRef {
  expr: string;
  alias: string;
  column?: string;
  type: DirectColumnType;
}

interface WatchTableConfig {
  idColumn: string;
  jsonColumn?: string;
  directColumns: Record<string, DirectColumnType>;
  aliases?: Record<string, { column?: string; json?: string; alias?: string }>;
  defaults: string[];
  orderBy: string[];
}

interface RealtimeWatchRule {
  table?: unknown;
  events?: unknown;
  check?: unknown;
  show_fields?: unknown;
}

const SERVER_WATCH_TABLES: Record<string, WatchTableConfig> = {
  acts: {
    idColumn: "act_id",
    jsonColumn: "data",
    directColumns: {
      act_id: "number",
      date_on: "date",
      date_off: "date",
      client_id: "number",
      cars_id: "number",
      rosraxovano: "date",
      avans: "number",
      sms: "date",
      faktura_id: "number",
      faktura_id_akt: "number",
      xto_vbpbsav: "text",
      slusarsOn: "boolean",
      pruimalnyk: "text",
      tupOplatu: "text",
      photo_url: "text",
      frozen: "boolean",
    },
    aliases: {
      "Акт №": { column: "act_id" },
      "Дата відкриття": { column: "date_on" },
      "Дата закриття": { column: "date_off" },
      "Приймальник": { column: "pruimalnyk" },
      "Заморожено": { column: "frozen" },
      "Клієнт": { json: "ПІБ" },
      "Телефон": { json: "Телефон" },
      "Слюсар": { json: "Слюсар" },
      "Сума": { json: "Загальна сума" },
      "Загальна сума": { json: "Загальна сума" },
      "Роботи": { json: "Роботи" },
      "Деталі": { json: "Деталі" },
    },
    defaults: [
      "act_id",
      "date_on",
      "date_off",
      "Клієнт",
      "Слюсар",
      "Загальна сума",
    ],
    orderBy: ["date_off", "date_on", "act_id"],
  },
  clients: {
    idColumn: "client_id",
    jsonColumn: "data",
    directColumns: { client_id: "number", data: "json" },
    aliases: {
      "Клієнт": { json: "ПІБ" },
      "ПІБ": { json: "ПІБ" },
      "Телефон": { json: "Телефон" },
    },
    defaults: ["client_id", "ПІБ", "Телефон"],
    orderBy: ["client_id"],
  },
  cars: {
    idColumn: "cars_id",
    jsonColumn: "data",
    directColumns: {
      cars_id: "number",
      client_id: "number",
      data: "json",
      is_deleted: "boolean",
    },
    aliases: {
      "Авто": { json: "Марка" },
      "Марка": { json: "Марка" },
      "Модель": { json: "Модель" },
      "Номер": { json: "Держ номер" },
      "Держ номер": { json: "Держ номер" },
      VIN: { json: "VIN" },
    },
    defaults: ["cars_id", "client_id", "Держ номер", "Марка", "Модель"],
    orderBy: ["cars_id"],
  },
  slyusars: {
    idColumn: "slyusar_id",
    jsonColumn: "data",
    directColumns: {
      slyusar_id: "number",
      data: "json",
      post_sluysar: "text",
      namber: "number",
    },
    aliases: {
      "Працівник": { json: "ПІБ" },
      "ПІБ": { json: "ПІБ" },
      "Посада": { json: "Посада" },
      "Пароль": { json: "Пароль" },
      "Телефон": { json: "Телефон" },
    },
    defaults: ["slyusar_id", "ПІБ", "Посада", "post_sluysar"],
    orderBy: ["slyusar_id"],
  },
  sclad: {
    idColumn: "sclad_id",
    directColumns: {
      sclad_id: "number",
      time_on: "date",
      shops: "text",
      akt: "number",
      time_off: "date",
      receivers: "text",
      rahunok: "text",
      unit_measurement: "text",
      part_number: "text",
      kilkist_on: "number",
      kilkist_off: "number",
      price: "number",
      name: "text",
      rosraxovano: "date",
      povernennya: "date",
      xto_povernyv: "text",
      scladNomer: "number",
      xto_zamovuv: "number",
      statys: "text",
      prumitka: "text",
    },
    aliases: {
      "Деталь": { column: "name" },
      "Назва": { column: "name" },
      "Артикул": { column: "part_number" },
      "Статус": { column: "statys" },
      "Кількість": { column: "kilkist_on" },
      "Ціна": { column: "price" },
    },
    defaults: [
      "sclad_id",
      "time_on",
      "name",
      "part_number",
      "kilkist_on",
      "kilkist_off",
      "statys",
    ],
    orderBy: ["time_on", "sclad_id"],
  },
  vutratu: {
    idColumn: "vutratu_id",
    directColumns: {
      vutratu_id: "number",
      dataOnn: "date",
      kategoria: "text",
      sposob_oplaty: "text",
      suma: "number",
      opys_vytraty: "text",
      prymitky: "text",
      dataOff: "date",
      act: "number",
      xto_zapusav: "text",
    },
    aliases: {
      "Дата": { column: "dataOnn" },
      "Категорія": { column: "kategoria" },
      "Сума": { column: "suma" },
      "Опис": { column: "opys_vytraty" },
    },
    defaults: ["vutratu_id", "dataOnn", "kategoria", "suma", "opys_vytraty"],
    orderBy: ["dataOnn", "vutratu_id"],
  },
  faktura: {
    idColumn: "faktura_id",
    directColumns: {
      faktura_id: "number",
      data: "date",
      prumitka: "text",
      name: "text",
      oderjyvach: "text",
      namber: "number",
    },
    aliases: {
      "Дата": { column: "data" },
      "Назва": { column: "name" },
      "Отримувач": { column: "oderjyvach" },
      "Номер": { column: "namber" },
    },
    defaults: ["faktura_id", "data", "name", "oderjyvach", "namber"],
    orderBy: ["data", "faktura_id"],
  },
  post_arxiv: {
    idColumn: "post_arxiv_id",
    directColumns: {
      post_arxiv_id: "number",
      data_on: "date",
      client_id: "text",
      name_post: "number",
      komentar: "text",
      cars_id: "text",
      status: "text",
      data_off: "date",
      slyusar_id: "number",
      act_id: "number",
      xto_zapusav: "text",
    },
    aliases: {
      "Дата": { column: "data_on" },
      "Дата закриття": { column: "data_off" },
      "Статус": { column: "status" },
      "Коментар": { column: "komentar" },
      "Акт №": { column: "act_id" },
    },
    defaults: [
      "post_arxiv_id",
      "data_on",
      "data_off",
      "status",
      "client_id",
      "cars_id",
      "act_id",
    ],
    orderBy: ["data_on", "post_arxiv_id"],
  },
  incomes: {
    idColumn: "income_id",
    jsonColumn: "data",
    directColumns: { income_id: "number", data: "json" },
    aliases: {
      "Сума": { json: "Сума" },
      "Дата": { json: "Дата" },
      "Опис": { json: "Опис" },
    },
    defaults: ["income_id", "Сума", "Дата", "Опис"],
    orderBy: ["income_id"],
  },
  settings: {
    idColumn: "setting_id",
    directColumns: {
      setting_id: "number",
      data: "boolean",
      procent: "number",
      "Приймальник": "boolean",
      "Слюсар": "boolean",
      "Запчастист": "boolean",
      "Складовщик": "boolean",
      API: "boolean",
      date: "date",
    },
    defaults: [
      "setting_id",
      "date",
      "data",
      "API",
      "Приймальник",
      "Слюсар",
      "Запчастист",
      "Складовщик",
    ],
    orderBy: ["date", "setting_id"],
  },
};

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
      const token = String(data?.["Загальні"] || "").trim();
      if (token) return token;
    }
  } catch (e) {
    console.error("loadTelegramBotToken DB error:", e);
  }

  return "";
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlTextLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function stripFieldQuotes(value: string): string {
  return value
    .trim()
    .replace(/\\"/g, '"')
    .replace(/^["'`]+|["'`]+$/g, "");
}

function columnLabel(column: string): string {
  const labels: Record<string, string> = {
    act_id: "Акт №",
    client_id: "Клієнт ID",
    cars_id: "Авто ID",
    slyusar_id: "Працівник ID",
    sclad_id: "Склад ID",
    vutratu_id: "Витрата ID",
    faktura_id: "Рахунок ID",
    post_arxiv_id: "Бронювання ID",
    income_id: "Дохід ID",
    setting_id: "Налаштування ID",
    date_on: "Дата відкриття",
    date_off: "Дата закриття",
    data_on: "Дата початку",
    data_off: "Дата кінця",
    dataOnn: "Дата",
    dataOff: "Дата кінця",
    time_on: "Дата",
    time_off: "Дата закриття",
    status: "Статус",
    statys: "Статус",
    name: "Назва",
    part_number: "Артикул",
    kilkist_on: "Кількість",
    kilkist_off: "Списано",
    price: "Ціна",
    suma: "Сума",
    opys_vytraty: "Опис",
    kategoria: "Категорія",
    pruimalnyk: "Приймальник",
    frozen: "Заморожено",
  };
  return labels[column] || column;
}

function parseRealtimeWatchRule(ruleText: string): RealtimeWatchRule | null {
  try {
    const parsed: unknown = JSON.parse(ruleText);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as RealtimeWatchRule;
    }
  } catch {
    /* old realtime rule is not valid JSON */
  }
  return null;
}

function parseWatchEvents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((event) => String(event || "").trim().toUpperCase())
    .filter((event) =>
      event === "INSERT" || event === "UPDATE" || event === "DELETE"
    );
}

function parseShowFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((field) => String(field || "").trim())
    .filter((field) => field.length > 0)
    .slice(0, 8);
}

function findDirectColumn(
  config: WatchTableConfig,
  field: string,
): string | null {
  if (config.directColumns[field]) return field;
  const lower = field.toLowerCase();
  return Object.keys(config.directColumns).find((column) =>
    column.toLowerCase() === lower
  ) || null;
}

function directFieldRef(
  config: WatchTableConfig,
  column: string,
  alias?: string,
): WatchFieldRef | null {
  const type = config.directColumns[column];
  if (!type) return null;
  return {
    expr: quoteIdent(column),
    alias: alias || columnLabel(column),
    column,
    type,
  };
}

function jsonFieldRef(
  config: WatchTableConfig,
  jsonField: string,
  alias?: string,
): WatchFieldRef | null {
  if (!config.jsonColumn) return null;
  const clean = stripFieldQuotes(jsonField);
  if (!clean) return null;
  return {
    expr: `${quoteIdent(config.jsonColumn)}->>${sqlTextLiteral(clean)}`,
    alias: alias || clean,
    type: "text",
  };
}

function watchFieldRef(
  config: WatchTableConfig,
  rawField: string,
): WatchFieldRef | null {
  const field = stripFieldQuotes(rawField);
  if (!field) return null;

  const dataMatch = field.match(/^data\.(.+)$/i);
  if (dataMatch?.[1]) {
    return jsonFieldRef(config, dataMatch[1]);
  }

  const alias = config.aliases?.[field];
  if (alias?.column) return directFieldRef(config, alias.column, alias.alias || field);
  if (alias?.json) return jsonFieldRef(config, alias.json, alias.alias || field);

  const directColumn = findDirectColumn(config, field);
  if (directColumn) return directFieldRef(config, directColumn);

  return config.jsonColumn ? jsonFieldRef(config, field) : null;
}

function notEmptySql(ref: WatchFieldRef): string {
  if (ref.type === "boolean") return `${ref.expr} IS TRUE`;
  if (ref.type === "date" || ref.type === "number" || ref.type === "json") {
    return `${ref.expr} IS NOT NULL`;
  }
  return `(${ref.expr} IS NOT NULL AND btrim(${ref.expr}) <> '')`;
}

function emptySql(ref: WatchFieldRef): string {
  if (ref.type === "boolean") return `${ref.expr} IS NOT TRUE`;
  if (ref.type === "date" || ref.type === "number" || ref.type === "json") {
    return `${ref.expr} IS NULL`;
  }
  return `(${ref.expr} IS NULL OR btrim(${ref.expr}) = '')`;
}

function parseWatchCondition(
  config: WatchTableConfig,
  checkText: string,
): { where: string | null; field: WatchFieldRef | null; needsBroadHash: boolean } {
  const check = checkText.trim();
  if (!check) return { where: null, field: null, needsBroadHash: true };

  const match = check.match(
    /^(.*?)\s+(IS\s+NOT\s+NULL|IS\s+NULL|CLOSED|OPENED|CHANGED)$/i,
  );
  if (!match) return { where: null, field: null, needsBroadHash: true };

  const field = watchFieldRef(config, match[1] || "");
  if (!field) return { where: null, field: null, needsBroadHash: true };

  const operator = (match[2] || "").toUpperCase().replace(/\s+/g, " ");
  if (operator === "CHANGED") {
    return { where: null, field, needsBroadHash: false };
  }
  if (operator === "IS NOT NULL" || operator === "CLOSED") {
    return { where: notEmptySql(field), field, needsBroadHash: false };
  }
  if (operator === "IS NULL" || operator === "OPENED") {
    return { where: emptySql(field), field, needsBroadHash: false };
  }

  return { where: null, field, needsBroadHash: true };
}

function addSelectRef(
  selects: string[],
  seen: Set<string>,
  ref: WatchFieldRef | null,
): void {
  if (!ref) return;
  const key = `${ref.expr}|${ref.alias}`;
  if (seen.has(key)) return;
  seen.add(key);
  selects.push(`${ref.expr} AS ${quoteIdent(ref.alias)}`);
}

function addSelectExpr(
  selects: string[],
  seen: Set<string>,
  expr: string,
  alias: string,
): void {
  const key = `${expr}|${alias}`;
  if (seen.has(key)) return;
  seen.add(key);
  selects.push(`${expr} AS ${quoteIdent(alias)}`);
}

function buildWatchOrderBy(
  config: WatchTableConfig,
  conditionField: WatchFieldRef | null,
): string {
  const orderParts: string[] = [];
  const seen = new Set<string>();

  if (
    conditionField?.column &&
    conditionField.type === "date"
  ) {
    seen.add(conditionField.column);
    orderParts.push(`${quoteIdent(conditionField.column)} DESC NULLS LAST`);
  }

  for (const column of config.orderBy) {
    if (seen.has(column) || !config.directColumns[column]) continue;
    seen.add(column);
    orderParts.push(`${quoteIdent(column)} DESC NULLS LAST`);
  }

  return orderParts.length > 0 ? ` ORDER BY ${orderParts.join(", ")}` : "";
}

function buildSqlFromRealtimeWatchRule(ruleText: string): string | null {
  const rule = parseRealtimeWatchRule(ruleText);
  const table = typeof rule?.table === "string" ? rule.table.trim() : "";
  const config = SERVER_WATCH_TABLES[table];
  if (!config) return null;

  const events = parseWatchEvents(rule?.events);
  if (events.length > 0 && events.every((event) => event === "DELETE")) {
    return null;
  }

  const checkText = typeof rule?.check === "string" ? rule.check : "";
  const condition = parseWatchCondition(config, checkText);
  const showFields = parseShowFields(rule?.show_fields);

  const selects: string[] = [];
  const seen = new Set<string>();

  addSelectRef(selects, seen, directFieldRef(config, config.idColumn));
  for (const field of config.defaults) {
    addSelectRef(selects, seen, watchFieldRef(config, field));
  }
  addSelectRef(selects, seen, condition.field);
  for (const field of showFields) {
    addSelectRef(selects, seen, watchFieldRef(config, field));
  }

  if (condition.needsBroadHash) {
    if (config.jsonColumn) {
      addSelectExpr(
        selects,
        seen,
        `${quoteIdent(config.jsonColumn)}::text`,
        "Дані",
      );
    } else {
      for (const column of Object.keys(config.directColumns)) {
        addSelectRef(selects, seen, directFieldRef(config, column));
      }
    }
  }

  if (selects.length === 0) return null;

  const where = condition.where ? ` WHERE ${condition.where}` : "";
  const orderBy = buildWatchOrderBy(config, condition.field);
  return `SELECT ${selects.join(", ")} FROM ${quoteIdent(table)}${where}${orderBy} LIMIT ${SERVER_WATCH_LIMIT}`;
}

async function convertRealtimeJsonReminderToSql(
  supabase: DbClient,
  reminder: DueReminder,
  token: string,
): Promise<string | null> {
  const originalRule = reminder.condition_query?.trim() || "";
  const convertedQuery = buildSqlFromRealtimeWatchRule(originalRule);
  if (!convertedQuery) {
    console.log(
      `🔴 Старе JSON realtime-правило не вдалося конвертувати (reminder_id=${reminder.reminder_id})`,
    );
    return null;
  }

  const nextMeta: JsonObject = {
    ...(reminder.meta || {}),
    condition_mode: "server_realtime_sql",
    converted_from_json_realtime: true,
    original_realtime_rule: originalRule,
  };

  const { data: converted, error } = await supabase.rpc("traffic_reminder_convert_rule", {
    p_reminder_id: reminder.reminder_id, p_token: token, p_rule: reminderRule(reminder), p_query: convertedQuery,
  });

  if (error) {
    console.error(
      `convert realtime JSON update error (reminder_id=${reminder.reminder_id}):`,
      error.message,
    );
  } else {
    console.log(
      `✅ Старе JSON realtime-правило замінено на SQL (reminder_id=${reminder.reminder_id})`,
    );
  }

  if (error) throw error;
  if (!converted) throw new Error("Reminder changed during SQL conversion");
  reminder.condition_query = convertedQuery;
  reminder.schedule = { type: "realtime" };
  reminder.meta = nextMeta;

  return convertedQuery;
}

// ── Головний обробник ──

Deno.serve(async (req: Request): Promise<Response> => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 🔐 Перевірка: приймаємо лише запити з apikey або authorization header
  // pg_cron через supabase.functions.invoke() передає service_role apikey
  const authHeader = req.headers.get("authorization") || "";
  const apiKey = req.headers.get("apikey") || "";
  const atlasCron = req.headers.get("x-atlas-cron") || "";
  if (!authHeader && !apiKey && atlasCron !== "check-reminders") {
    return new Response(
      JSON.stringify({ error: "Unauthorized", sent: 0 }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("Missing env vars");
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE);

  try {
    // One bounded candidate stream replaces counts, the due-list limit and the
    // unfiltered conditional list. Per-rule/per-recipient leases still decide sends.
    const allReminders: DueReminder[] = [];
    const checkedAt = new Date().toISOString();
    let after: number | null = null;
    for (;;) {
      const response = await supabase.rpc("traffic_reminder_candidates", { p_after: after, p_at: checkedAt });
      if (response.error) throw response.error;
      const page = response.data;
      if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("Invalid reminder candidate page");
      allReminders.push(...page.items);
      if (!page.has_more) break;
      const next = Number(page.next_cursor);
      if (!page.items.length || !Number.isSafeInteger(next) || (after !== null && next <= after)) throw new Error("Invalid reminder candidate cursor");
      after = next;
    }
    const priorities: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    allReminders.sort((a, b) => {
      const aDue = a.next_trigger_at ? Date.parse(a.next_trigger_at) : Infinity;
      const bDue = b.next_trigger_at ? Date.parse(b.next_trigger_at) : Infinity;
      // Preserve scheduled-before-realtime processing and priority within due work.
      return Number(!Number.isFinite(aDue)) - Number(!Number.isFinite(bDue)) ||
        (priorities[a.priority] ?? 4) - (priorities[b.priority] ?? 4) ||
        (Number.isFinite(aDue) && Number.isFinite(bDue) ? aDue - bDue : 0) || a.reminder_id - b.reminder_id;
    });

    if (!allReminders || allReminders.length === 0) {
      return jsonResp(corsHeaders, { message: "Немає нагадувань", sent: 0 });
    }

    // App-only work does not read Telegram settings or require a bot token.
    let botToken: string | null = null;

    let totalSent = 0;
    let skipped = 0;
    let failed = 0;

    for (const reminder of allReminders) {
      // Перевіряємо, чи це Realtime
      let isRealtimeNull = false;
      try {
        const schedule =
          typeof reminder.schedule === "string"
            ? JSON.parse(reminder.schedule)
            : reminder.schedule;
        isRealtimeNull = schedule?.type === "realtime";
      } catch {
        /* */
      }

      const evaluation = await supabase.rpc("claim_reminder_evaluation", {
        p_reminder_id: reminder.reminder_id, p_expected_trigger: reminder.trigger_count || 0,
      });
      if (evaluation.error) throw evaluation.error;
      if (!evaluation.data) continue;
      let evaluationSucceeded = true;
      try {

      // Для умовних — виконати condition_query і перевірити результат
      let conditionResultText: string | null = null;
      let conditionResultHash: string | null = null;
      let conditionResultIdentity: string | null = null;
      if (
        reminder.reminder_type === "conditional" &&
        reminder.condition_query
      ) {
        let executableConditionQuery = reminder.condition_query;
        const trimmedCQ = executableConditionQuery.trim();
        if (trimmedCQ.startsWith("{")) {
          const convertedQuery = await convertRealtimeJsonReminderToSql(
            supabase,
            reminder,
            evaluation.data,
          );
          if (!convertedQuery) continue;
          executableConditionQuery = convertedQuery;
        }

        const condOk = await executeConditionQuery(
          supabase,
          executableConditionQuery,
          isRealtimeNull ? String(reminder.meta?.last_result_hash || "") : null,
        );

        if (condOk?.unchanged) { skipped++; continue; }

        if (condOk === null) {
          // Умова не виконана (0 рядків) → пропустити, але оновити trigger
          skipped++;
          if (!isRealtimeNull) {
            const advance = await supabase.rpc("traffic_reminder_complete", {
              p_reminder_id: reminder.reminder_id, p_token: evaluation.data, p_expected_trigger: reminder.trigger_count || 0,
              p_rule: reminderRule(reminder), p_patch: {},
            });
            if (advance.error) throw advance.error;
          }
          continue;
        }

        // Перевіряємо хеш, якщо це Контроль (реалтайм)
        try {
          const schedule =
            typeof reminder.schedule === "string"
              ? JSON.parse(reminder.schedule)
              : reminder.schedule;
          const conditionMode = String(reminder.meta?.condition_mode || "");
          if (
            (schedule?.type === "realtime" ||
              conditionMode === "server_realtime_sql" ||
              conditionMode === "server_polling") &&
            await matchesReminderResult(reminder.meta?.last_result_hash, condOk.legacyHash)
          ) {
            // Upgrade the comparison baseline without advancing any occurrence.
            if (reminder.meta?.last_result_hash !== condOk.hash) {
              await checkpointReminder(supabase, reminder, evaluation.data, { last_result_hash: condOk.hash });
            }
            skipped++;
            continue;
          }
        } catch (error) { throw error; }

        conditionResultText = condOk.text;
        conditionResultHash = condOk.hash;
        conditionResultIdentity = condOk.identity;
      }

      // Chain completed result generations, not trigger_count: a crash after
      // one recipient must resume the same fan-out even if its count advanced.
      const deliveryGeneration = isRealtimeNull
        ? await eventGeneration([reminder.meta?.last_delivery_generation || null, conditionResultIdentity])
        : undefined;
      // Persist every app recipient BEFORE advancing the occurrence. Closed tabs
      // catch up later without rerunning SQL or blocking Telegram. Existing claims
      // make retrying this staging operation idempotent.
      if (reminder.channel === "app" || reminder.channel === "both") {
        const queued = await supabase.rpc("traffic_reminder_queue_app", {
          p_reminder_id: reminder.reminder_id, p_token: evaluation.data,
          p_generation: deliveryGeneration || `scheduled:${reminder.trigger_count || 0}`,
          p_expected_trigger: reminder.trigger_count || 0, p_rule: reminderRule(reminder),
          p_result_text: conditionResultText,
        });
        if (queued.error) throw queued.error;
      }
      // Telegram або both — незалежна доставка кожному одержувачу
      if (reminder.channel === "telegram" || reminder.channel === "both") {
        botToken ||= await loadTelegramBotToken(supabase);
        if (!botToken) throw new Error("Telegram bot token not configured");
        const sent = await sendTelegramReminder(
          supabase,
          botToken,
          reminder,
          conditionResultText,
          deliveryGeneration,
        );
        totalSent += sent;
      }

      const completion = await supabase.rpc("traffic_reminder_complete", {
        p_reminder_id: reminder.reminder_id, p_token: evaluation.data,
        p_expected_trigger: reminder.trigger_count || 0, p_rule: reminderRule(reminder),
        p_patch: conditionResultHash ? {
          last_result_hash: conditionResultHash,
          ...(isRealtimeNull ? { last_delivery_generation: deliveryGeneration } : {}),
        } : {},
      });
      if (completion.error) throw completion.error;


      } catch (error) {
        evaluationSucceeded = false;
        failed++;
        // One bad SQL rule/provider must not starve unrelated reminders.
        console.error(`Reminder ${reminder.reminder_id} failed`, error instanceof Error ? error.message : String(error));
      } finally {
        const finished = await supabase.rpc("finish_reminder_evaluation", {
          p_reminder_id: reminder.reminder_id, p_token: evaluation.data, p_success: evaluationSucceeded,
        });
        if (finished.error) console.error("Reminder evaluation completion failed", finished.error.message);
      }
    }

    operationalLog(totalSent > 0 ? "info" : "debug", "reminders.completed", {
      processed: allReminders.length, sent: totalSent, skipped, failed,
    });
    return jsonResp(corsHeaders, {
      message: failed ? "Some reminders need retry" : "OK",
      processed: allReminders.length,
      sent: totalSent,
      failed,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("check-reminders error:", msg);
    return jsonResp(corsHeaders, { error: msg, sent: 0 }, 500);
  }
});

function reminderRule(reminder: DueReminder): JsonObject {
  return { condition_query: reminder.condition_query, schedule: reminder.schedule, recipients: reminder.recipients, channel: reminder.channel };
}
async function checkpointReminder(client: DbClient, reminder: DueReminder, token: string, patch: JsonObject): Promise<void> {
  const result = await client.rpc("traffic_reminder_checkpoint", {
    p_reminder_id: reminder.reminder_id, p_token: token, p_rule: reminderRule(reminder), p_patch: patch,
  });
  if (result.error) throw result.error;
}

// ── Виконання condition_query та форматування результату ──

async function executeConditionQuery(
  supabase: DbClient,
  conditionQuery: string,
  previousHash: string | null = null,
): Promise<{ text: string; hash: string; identity: string; legacyHash: string; unchanged?: boolean } | null> {
  try {
    const { data: result, error } = await supabase.rpc("traffic_reminder_condition", {
      p_query: conditionQuery, p_previous_hash: previousHash,
    });

    if (error) {
      console.error("execute_condition_query error:", error.message);
      throw error;
    }

    if (!result || typeof result.unchanged !== "boolean" || typeof result.hash !== "string") throw new Error("Invalid condition response");
    if (result.unchanged) return { text: "", hash: result.hash, identity: "", legacyHash: "", unchanged: true };
    const data = result.rows;

    // Перевіряємо чи є результати
    const isEmpty =
      data === null ||
      data === undefined ||
      (Array.isArray(data) && data.length === 0) ||
      (typeof data === "number" && data === 0);

    if (isEmpty) return null;

    // Форматуємо текст для Telegram
    const fieldLabels: Record<string, string> = {
      act_id: "Акт №",
      date_on: "Відкритий",
      date_off: "Закритий",
      total_amount: "Сума",
      status: "Статус",
      client_name: "Клієнт",
      client_phone: "Телефон",
      slusar: "Слюсар",
      car: "Авто",
      vin: "VIN",
      description: "Опис",
      count: "Кількість",
    };
    const formatFieldName = (key: string): string => fieldLabels[key] || key;
    const formatValue = (v: unknown): string => {
      if (v === null || v === undefined) return "—";
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        return new Date(v).toLocaleString("uk-UA", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      return String(v);
    };

    let resultText = "";

    if (Array.isArray(data)) {
      resultText = data
        .map((row: unknown, i: number) => {
          if (typeof row === "object" && row !== null) {
            return (
              `${i + 1}. ` +
              Object.entries(row)
                .map(
                  ([k, v]) =>
                    `<b>${escHtml(formatFieldName(k))}</b>: ${escHtml(formatValue(v))}`,
                )
                .join(" | ")
            );
          }
          return `${i + 1}. ${escHtml(String(row))}`;
        })
        .join("\n");

      resultText = `📋 <b>Знайдено: ${data.length} записів</b>\n\n${resultText}`;
    } else if (typeof data === "number") {
      resultText = `📋 <b>Знайдено: ${data} записів</b>`;
    } else {
      resultText = escHtml(String(data));
    }

    const identity = JSON.stringify(data);
    return { text: resultText, hash: result.hash, legacyHash: await reminderResultDigest(identity), identity };
  } catch (err) {
    console.error("executeConditionQuery exception:", err);
    throw err;
  }
}

// ── Відправка в Telegram ──

async function sendTelegramReminder(
  supabase: DbClient,
  botToken: string,
  reminder: DueReminder,
  conditionResultText: string | null = null,
  generation?: string,
): Promise<number> {
  // Визначити адресатів
  const recipientIds = await resolveRecipientIds(supabase, reminder);
  if (recipientIds.length === 0) return 0;

  // Отримати telegram_chat_id для кожного
  const { data: tgUsers, error } = await supabase
    .from("atlas_telegram_users")
    .select("slyusar_id, telegram_chat_id")
    .in("slyusar_id", recipientIds)
    .eq("is_active", true);

  if (error || !tgUsers?.length) return 0;

  // Сформувати повідомлення
  const icon = getPriorityIcon(reminder.priority);
  const typeLabel = getTypeLabel(reminder.reminder_type);
  const priorityLabel = getPriorityLabel(reminder.priority);

  const messageParts = [
    `${icon} <b>${escHtml(reminder.title)}</b>`,
    reminder.description ? `\n${escHtml(reminder.description)}` : "",
    conditionResultText ? `\n\n${conditionResultText}` : "",
    `\n${typeLabel} | Пріоритет: ${priorityLabel}`,
    `👤 Створив: ${escHtml(reminder.creator_name)}`,
  ];

  const messageText = messageParts.filter(Boolean).join("\n");

  let sentCount = 0;

  for (const tgUser of tgUsers as TelegramUser[]) {
    try {
      const outcome = await deliverReminderOnce(supabase as unknown as ReminderDeliveryRpc, reminder, tgUser.slyusar_id, "telegram", async () => {
      const tgResp = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: tgUser.telegram_chat_id,
            text: messageText,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Виконано",
                    callback_data: `rem_done_${reminder.reminder_id}`,
                  },
                  {
                    text: "📅 Заплановано",
                    callback_data: `rem_snooze_${reminder.reminder_id}`,
                  },
                  {
                    text: "❌ Не планую",
                    callback_data: `rem_skip_${reminder.reminder_id}`,
                  },
                ],
              ],
            },
          }),
        },
      );

      const body = await tgResp.json().catch(() => null);
      if (tgResp.ok && body?.ok === true) return "delivered";
      if (body?.ok === false) return "failed";
      return "unknown";
      }, generation, messageText);
      if (outcome === "delivered") sentCount++;
    } catch (err) {
      console.error(
        `Telegram send error (chat_id=${tgUser.telegram_chat_id}):`,
        err,
      );
      throw err;
    }
  }

  return sentCount;
}

// ── Визначити адресатів ──

async function resolveRecipientIds(
  supabase: DbClient,
  reminder: DueReminder,
): Promise<number[]> {
  const recipients = reminder.recipients;

  // "self" → автор
  if (recipients === "self" || recipients === '"self"') {
    return reminder.created_by ? [reminder.created_by] : [];
  }

  // "all" → всі
  if (recipients === "all" || recipients === '"all"') {
    const { data } = await supabase.from("slyusars").select("slyusar_id");
    return (data || [])
      .map((s) => Number(s.slyusar_id))
      .filter((id) => Number.isFinite(id));
  }

  // "mechanics" → слюсарі
  if (recipients === "mechanics" || recipients === '"mechanics"') {
    const { data } = await supabase
      .from("slyusars")
      .select("slyusar_id")
      .filter("data->>Посада", "eq", "Слюсар");
    return (data || [])
      .map((s) => Number(s.slyusar_id))
      .filter((id) => Number.isFinite(id));
  }

  // Масив ID
  if (Array.isArray(recipients)) {
    return recipients;
  }

  // JSON-рядок масиву
  if (typeof recipients === "string") {
    try {
      const parsed = JSON.parse(recipients);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* */
    }
  }

  return reminder.created_by ? [reminder.created_by] : [];
}

// ── Утиліти ──

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getPriorityIcon(priority: string): string {
  switch (priority) {
    case "urgent":
      return "🚨";
    case "high":
      return "🔴";
    case "normal":
      return "🔔";
    case "low":
      return "💤";
    default:
      return "🔔";
  }
}

function getPriorityLabel(priority: string): string {
  switch (priority) {
    case "urgent":
      return "Терміновий";
    case "high":
      return "Високий";
    case "normal":
      return "Звичайний";
    case "low":
      return "Низький";
    default:
      return priority;
  }
}

function getTypeLabel(type: string): string {
  switch (type) {
    case "once":
      return "⏰ Одноразове";
    case "recurring":
      return "🔄 Повторюване";
    case "conditional":
      return "📊 За умовою";
    default:
      return type;
  }
}

function jsonResp(
  corsHeaders: Record<string, string>,
  data: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
