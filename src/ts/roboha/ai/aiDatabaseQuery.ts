// src/ts/roboha/ai/aiDatabaseQuery.ts
// 🗄️ Модуль динамічних SELECT-запитів до БД для AI Атлас
// Дозволяє AI виконувати запити до Supabase через function calling

import { supabase } from "../../vxid/supabaseClient";

// ============================================================
// ТИПИ
// ============================================================

/** Дозволені таблиці для запитів AI */
export const AI_ALLOWED_TABLES = [
  "acts",
  "clients",
  "cars",
  "slyusars",
  "sclad",
  "post_category",
  "post_name",
  "post_arxiv",
  "works",
  "details",
  "shops",
  "vutratu",
  "faktura",
  "incomes",
  "settings",
  "act_changes_notifications",
  "slusar_complete_notifications",
  "atlas_reminders",
  "atlas_reminder_logs",
  "atlas_telegram_users",
  "ai_skills",
  "audit_logs",
] as const;

/** Дозволені RPC-функції для виклику через AI */
export const AI_ALLOWED_RPC = [
  "get_db_size",
  "get_due_reminders",
  "get_my_reminders",
  "trigger_reminder",
  "execute_condition_query",
  "get_telegram_link_status",
] as const;

export type AllowedRPC = (typeof AI_ALLOWED_RPC)[number];

export type AllowedTable = (typeof AI_ALLOWED_TABLES)[number];

/** Фільтр для запиту */
export interface QueryFilter {
  column: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "like"
    | "ilike"
    | "is"
    | "in"
    | "not";
  value: string | number | boolean | null | string[] | number[];
}

/** Параметри запиту від AI */
export interface AIQueryParams {
  table: string;
  select?: string; // Колонки (default "*")
  filters?: QueryFilter[];
  order_by?: string;
  order_direction?: "asc" | "desc";
  limit?: number; // Max 500
  offset?: number;
}

/** Результат запиту */
export interface AIQueryResult {
  success: boolean;
  data?: any[];
  count?: number;
  error?: string;
  table?: string;
  query_description?: string;
  returnedRows?: number;
  hasMore?: boolean;
  fetchedAt?: string;
  scope?: { filters: QueryFilter[]; offset: number; limit: number };
}

// ============================================================
// ЗАХИЩЕНІ КОЛОНКИ (не повертати паролі та чутливі дані)
// ============================================================

const FORBIDDEN_COLUMNS: Record<string, string[]> = {
  slyusars: ["Пароль", "password", "pass", "pwd"],
  settings: ["Пароль", "password"],
};

/** Таблиці, доступні лише адміну */
const ADMIN_ONLY_TABLES = ["ai_skills", "audit_logs", "settings"] as const;

/** Broad searches return candidate cards. An explicit primary-key equality can
 * still request the complete record, including its history, when needed. */
const AI_SEARCH_PROJECTIONS: Record<string, { id: string; columns: string; fields: Record<string, string> }> = {
  acts: { id: "act_id", columns: "act_id,client_id,cars_id,date_on,date_off", fields: {
    atlas_name: "ПІБ", atlas_phone: "Телефон", atlas_brand: "Марка", atlas_model: "Модель", atlas_car: "Авто",
    atlas_plate: "Держ. номер", atlas_vin: "VIN", atlas_total: "Загальна сума", atlas_staff: "Слюсар",
  } },
  clients: { id: "client_id", columns: "client_id", fields: { atlas_name: "ПІБ", atlas_phone: "Телефон" } },
  cars: { id: "cars_id", columns: "cars_id,client_id,is_deleted", fields: {
    atlas_brand: "Марка", atlas_model: "Модель", atlas_plate: "Номер авто", atlas_vin: "Vincode", atlas_vin_alt: "VIN",
  } },
  slyusars: { id: "slyusar_id", columns: "slyusar_id", fields: {
    atlas_name: "Name", atlas_position: "Посада", atlas_specialization: "Спеціалізація", atlas_rating: "Рейтинг",
  } },
};

function fallbackExpression(filters: QueryFilter[]): string | null {
  const expressions: string[] = [];
  for (const filter of filters) {
    // Only the same field/operator grammar accepted by the ordinary builder.
    if (!/^[\p{L}\p{N}_][\p{L}\p{N}_\s.>\-"'ʼ]*$/u.test(filter.column)) return null;
    const literal = (value: unknown) => value === null ? "null" : typeof value === "string" ? JSON.stringify(value) : String(value);
    if (filter.operator === "in") {
      if (!Array.isArray(filter.value)) return null;
      expressions.push(`${filter.column}.in.(${filter.value.map(literal).join(",")})`);
    } else if (filter.operator === "is" || filter.operator === "not") {
      // Gemini supplies SQL null as either null or the string "null". The
      // PostgREST is operator requires an unquoted keyword inside an OR tree.
      const value = String(filter.value).toLowerCase();
      if (!["null", "true", "false", "unknown"].includes(value)) return null;
      expressions.push(`${filter.column}.${filter.operator === "not" ? "not.is" : "is"}.${value}`);
    }
    else expressions.push(`${filter.column}.${filter.operator}.${literal(filter.value)}`);
  }
  return `and(${expressions.join(",")})`;
}

const HUMAN_ENTITY_WORDS = new Set([
  "клієнт",
  "клієнта",
  "клієнту",
  "клієнтом",
  "клієнти",
  "користувач",
  "користувача",
  "користувачу",
  "користувачем",
  "людина",
  "людину",
  "людини",
  "власник",
  "власника",
  "власнику",
  "піб",
  "прізвище",
  "прізвищем",
  "імя",
  "ім'я",
  "машина",
  "машини",
  "машину",
  "авто",
  "автівка",
  "автівку",
  "номер",
  "номером",
  "vin",
  "він",
  "вінкод",
  "винкод",
]);

const VEHICLE_CHAR_MAP: Record<string, string> = {
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  І: "I",
  Ї: "I",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  Т: "T",
  У: "Y",
  Х: "X",
};

function stripLikeMarkers(value: string): string {
  return value.replace(/[%_*]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeVehicleToken(value: string): string {
  return value
    .toUpperCase()
    .split("")
    .map((char) => VEHICLE_CHAR_MAP[char] || char)
    .join("")
    .replace(/[^A-Z0-9]/g, "");
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

function isHumanColumn(column: string): boolean {
  return /(піб|name|слюсар|приймальник|changed_by_surname|pib)/i.test(column);
}

function isPhoneColumn(column: string): boolean {
  return /(телефон|phone)/i.test(column);
}

function isPlateColumn(column: string): boolean {
  return /(номер авто|держ\.?\s*номер|plate|number)/i.test(column);
}

function isVinColumn(column: string): boolean {
  return /(vincode|vin)/i.test(column);
}

function cleanHumanSearchValue(value: string): string {
  const tokens = stripLikeMarkers(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .filter((token) => !HUMAN_ENTITY_WORDS.has(token.toLowerCase()));

  if (tokens.length === 0) {
    return normalizeWhitespace(stripLikeMarkers(value));
  }

  return tokens.join(" ");
}

function buildPersonPatterns(value: string): string[] {
  const cleaned = cleanHumanSearchValue(value);
  const variants = new Set<string>();

  if (!cleaned) return [];

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  variants.add(`%${cleaned}%`);

  for (const token of tokens) {
    variants.add(`%${token}%`);
    if (token.length >= 5) variants.add(`%${token.slice(0, -1)}%`);
    if (token.length >= 6) variants.add(`%${token.slice(0, -2)}%`);
  }

  return [...variants].slice(0, 6);
}

function buildPhonePatterns(value: string): string[] {
  const digits = digitsOnly(value);
  if (digits.length < 5) return [];

  const variants = new Set<string>([`%${digits}%`]);
  const local = digits.length >= 10 ? digits.slice(-10) : digits;

  variants.add(`%${local}%`);

  // Українські телефони часто зберігаються як +380(50)337-88-75,
  // тому суцільні цифри 0503378875 не завжди збігаються через дужки/дефіси.
  if (local.length === 10) {
    const withoutLeadingZero = local.startsWith("0") ? local.slice(1) : local;
    variants.add(
      `%${withoutLeadingZero.slice(0, 2)}%${withoutLeadingZero.slice(2, 5)}%${withoutLeadingZero.slice(5, 7)}%${withoutLeadingZero.slice(7)}%`,
    );
    variants.add(
      `%${local.slice(0, 3)}%${local.slice(3, 6)}%${local.slice(6, 8)}%${local.slice(8)}%`,
    );
  }

  return [...variants].slice(0, 5);
}

function buildPlatePatterns(value: string): string[] {
  const normalized = normalizeVehicleToken(value);
  if (normalized.length < 4) return [];

  const variants = new Set<string>([`%${normalized}%`]);
  const groups = normalized.match(/^([A-Z]{1,3})(\d{1,4})([A-Z]{0,3})$/);

  if (groups) {
    const [, left, middle, right] = groups;
    variants.add(`%${left}%${middle}%${right}%`);
  }

  if (normalized.length >= 6) {
    variants.add(`%${normalized.slice(0, 2)}%${normalized.slice(2)}%`);
  }

  return [...variants].slice(0, 4);
}

function buildVinPatterns(value: string): string[] {
  const normalized = normalizeVehicleToken(value);
  if (normalized.length < 6) return [];

  const variants = new Set<string>([`%${normalized}%`]);
  const chunks = normalized.match(/.{1,4}/g);

  if (chunks && chunks.length > 1) {
    variants.add(`%${chunks.join("%")}%`);
  }

  return [...variants].slice(0, 4);
}

function buildSmartFilterVariants(filter: QueryFilter): QueryFilter[] {
  if (typeof filter.value !== "string") {
    return [filter];
  }

  const baseValue = stripLikeMarkers(filter.value);
  if (!baseValue) {
    return [filter];
  }

  const variants = new Map<string, QueryFilter>();
  const push = (operator: QueryFilter["operator"], value: QueryFilter["value"]) => {
    const key = `${operator}:${String(value)}`;
    if (!variants.has(key)) {
      variants.set(key, { ...filter, operator, value });
    }
  };

  push(filter.operator, filter.value);

  let patterns: string[] = [];
  if (isHumanColumn(filter.column)) {
    patterns = buildPersonPatterns(baseValue);
  } else if (isPhoneColumn(filter.column)) {
    patterns = buildPhonePatterns(baseValue);
  } else if (isPlateColumn(filter.column)) {
    patterns = buildPlatePatterns(baseValue);
  } else if (isVinColumn(filter.column)) {
    patterns = buildVinPatterns(baseValue);
  }

  for (const pattern of patterns) {
    push("ilike", pattern);
  }

  return [...variants.values()].slice(0, 6);
}

function buildSmartFallbackFilterSets(filters: QueryFilter[]): QueryFilter[][] {
  if (!filters.length) return [];

  const optionLists = filters.map((filter) => buildSmartFilterVariants(filter));
  if (optionLists.every((options) => options.length <= 1)) {
    return [];
  }

  const originalKey = JSON.stringify(filters);
  const seen = new Set<string>();
  const combinations: QueryFilter[][] = [];

  const walk = (index: number, current: QueryFilter[]) => {
    if (combinations.length >= 8) return;

    if (index >= optionLists.length) {
      const key = JSON.stringify(current);
      if (key !== originalKey && !seen.has(key)) {
        seen.add(key);
        combinations.push(current.map((filter) => ({ ...filter })));
      }
      return;
    }

    for (const option of optionLists[index]) {
      walk(index + 1, [...current, option]);
      if (combinations.length >= 8) return;
    }
  };

  walk(0, []);
  return combinations;
}

/** Видаляє заборонені поля з результатів */
function sanitizeResults(table: string, data: any[]): any[] {
  const forbidden = FORBIDDEN_COLUMNS[table];
  if (!forbidden || forbidden.length === 0) return data;

  return data.map((row) => {
    const clean = { ...row };

    // Перевіряємо вкладені обʼєкти (data, JSONB поля)
    if (clean.data && typeof clean.data === "object") {
      const d = { ...clean.data };
      for (const key of forbidden) {
        delete d[key];
      }
      clean.data = d;
    }

    // Перевіряємо top-level поля
    for (const key of forbidden) {
      delete clean[key];
    }

    return clean;
  });
}

// ============================================================
// ВИКОНАННЯ ЗАПИТУ
// ============================================================

/**
 * Виконує безпечний SELECT-запит до Supabase.
 * Тільки читання — INSERT/UPDATE/DELETE заборонені.
 */
const pendingAIQueries = new Map<string, Promise<AIQueryResult>>();
function aiQueryOwner(): string {
  try { return localStorage.getItem("userAuthData") || ""; } catch { return ""; }
}
/** Coalesce simultaneous reads only: each later tool call rechecks current server access. */
export async function executeAIQuery(params: AIQueryParams, isAdmin?: boolean): Promise<AIQueryResult> {
  const owner = aiQueryOwner();
  const key = JSON.stringify([owner, !!isAdmin, params]);
  let request = pendingAIQueries.get(key);
  if (!request) {
    request = executeAIQueryOnce(params, isAdmin);
    pendingAIQueries.set(key, request);
    const active = request;
    void request.finally(() => { if (pendingAIQueries.get(key) === active) pendingAIQueries.delete(key); }).catch(() => {});
  }
  const result = await request;
  if (owner !== aiQueryOwner()) return { success: false, error: "Користувач змінився під час читання. Повторіть запит." };
  return structuredClone(result);
}

async function executeAIQueryOnce(
  params: AIQueryParams,
  isAdmin?: boolean,
): Promise<AIQueryResult> {
  // 1. Валідація таблиці
  const table = params.table?.toLowerCase().trim();
  if (!table || !AI_ALLOWED_TABLES.includes(table as AllowedTable)) {
    return {
      success: false,
      error: `🚫 Таблиця "${params.table}" не дозволена. Доступні: ${AI_ALLOWED_TABLES.join(", ")}`,
    };
  }

  // 1.1 🔒 Перевірка на admin-only таблиці
  if (!isAdmin && (ADMIN_ONLY_TABLES as readonly string[]).includes(table)) {
    return {
      success: false,
      error: `🔒 Таблиця "${table}" доступна лише адміністратору.`,
    };
  }

  // 2. Валідація ліміту
  const limit = Math.min(Math.max(params.limit || 50, 1), 500);
  const offset = Math.max(params.offset || 0, 0);

  // 3. Валідація select (захист від SQL injection через select)
  const requestedColumns = params.select?.trim() || "*";
  const projection = AI_SEARCH_PROJECTIONS[table];
  const singleRecord = projection && (params.filters || []).some(filter =>
    filter.column === projection.id && filter.operator === "eq" && /^\d+$/.test(String(filter.value)));
  const useSummary = !!projection && !singleRecord && (requestedColumns.includes("*") || requestedColumns.split(",").some(column => column.trim() === "data"));
  const selectColumns = useSummary
    ? [...new Set([...projection.columns.split(","), ...requestedColumns.split(",").map(column => column.trim()).filter(column => column !== "*" && column !== "data")]),
      ...Object.entries(projection.fields).map(([alias, field]) => `${alias}:data->>"${field}"`)].join(",")
    : requestedColumns;
  // Базова перевірка: букви (лат+кир), цифри, крапки, коми, зірочки, пробіли, підкреслення, дефіси, лапки, JSONB оператори
  if (!/^[\w\s,.*"'()[\]>:{}#\-/\\а-яіїєґА-ЯІЇЄҐ'ʼ]+$/i.test(selectColumns)) {
    return {
      success: false,
      error: `🚫 Некоректний формат select: "${selectColumns}"`,
    };
  }

  try {
    const applyFilters = (
      query: any,
      filters: QueryFilter[],
    ): any => {
      for (const filter of filters) {
        if (!filter.column || !filter.operator) continue;

        const op = filter.operator;
        const col = filter.column;
        let val = filter.value;

        // 🔄 Авто-каст: рядок → число для числових операторів
        if (
          ["gt", "gte", "lt", "lte"].includes(op) &&
          typeof val === "string" &&
          val !== "" &&
          !isNaN(Number(val))
        ) {
          val = Number(val);
        }

        switch (op) {
          case "eq":
            query = query.eq(col, val);
            break;
          case "neq":
            query = query.neq(col, val);
            break;
          case "gt":
            query = query.gt(col, val as string | number);
            break;
          case "gte":
            query = query.gte(col, val as string | number);
            break;
          case "lt":
            query = query.lt(col, val as string | number);
            break;
          case "lte":
            query = query.lte(col, val as string | number);
            break;
          case "like":
            query = query.like(col, val as string);
            break;
          case "ilike":
            query = query.ilike(col, val as string);
            break;
          case "is":
            query = query.is(col, val as null | boolean);
            break;
          case "in":
            if (Array.isArray(val)) {
              query = query.in(col, val);
            }
            break;
          case "not":
            query = query.not(col, "is", val as null);
            break;
          default:
            break;
        }
      }

      return query;
    };

    const runQuery = async (
      filters: QueryFilter[],
      descriptionSuffix = "",
      alternatives?: string[],
    ): Promise<AIQueryResult> => {
      let query = supabase.from(table).select(selectColumns, { count: "exact" });
      query = alternatives ? query.or(alternatives.join(",")) : applyFilters(query, filters);

      if (params.order_by) {
        query = query.order(params.order_by, {
          ascending: params.order_direction !== "desc",
        });
      }

      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;

      if (error) {
        return {
          success: false,
          error: `❌ Помилка запиту до "${table}": ${error.message}`,
          table,
        };
      }

      const rows = useSummary ? (data || []).map((row: any) => {
        const result = { ...row, data: {} as Record<string, unknown> };
        for (const [alias, field] of Object.entries(projection.fields)) {
          if (row[alias] !== null && row[alias] !== undefined) result.data[field] = row[alias];
          delete result[alias];
        }
        return result;
      }) : data || [];
      const sanitized = sanitizeResults(table, rows);

      return {
        success: true,
        data: sanitized,
        count: count ?? undefined,
        returnedRows: sanitized.length,
        hasMore: count == null ? sanitized.length === limit : offset + sanitized.length < count,
        fetchedAt: new Date().toISOString(),
        scope: { filters, offset, limit },
        table,
        query_description: `SELECT ${selectColumns} FROM ${table}${filters.length ? ` WHERE (${filters.length} filters)` : ""} LIMIT ${limit}${descriptionSuffix}${useSummary ? " [candidate summary; request full details by ID]" : ""}`,
      };
    };

    const initialFilters = Array.isArray(params.filters) ? params.filters : [];
    const initialResult = await runQuery(initialFilters);
    const initialCount = initialResult.count ?? initialResult.data?.length ?? 0;

    if (!initialResult.success || initialCount > 0 || initialFilters.length === 0) {
      return initialResult;
    }

    const fallbackFilterSets = buildSmartFallbackFilterSets(initialFilters);
    if (fallbackFilterSets.length) {
      const alternatives = fallbackFilterSets.map(fallbackExpression);
      if (alternatives.some(expression => expression === null)) {
        return { success: false, table, error: "Уточніть поля пошуку: розширений пошук не підтримує цей формат фільтра." };
      }
      // Preserve every existing spelling/phone/VIN variant in one OR query.
      return runQuery(initialFilters, " [smart-fallback union]", alternatives as string[]);
    }

    return initialResult;
  } catch (err: any) {
    return {
      success: false,
      error: `❌ Помилка: ${err.message || "Невідома помилка"}`,
      table,
    };
  }
}

/**
 * Виконує кілька запитів паралельно (для оптимізації).
 * Максимум 5 запитів одночасно.
 */
export async function executeMultipleAIQueries(
  queries: AIQueryParams[],
  isAdmin?: boolean,
): Promise<AIQueryResult[]> {
  const limited = queries.slice(0, 5);
  return Promise.all(limited.map((q) => executeAIQuery(q, isAdmin)));
}

// ============================================================
// RPC ВИКЛИКИ (серверні функції PostgreSQL)
// ============================================================

/** Параметри виклику RPC */
export interface AIRpcParams {
  function_name: string;
  args?: Record<string, any>;
}

/**
 * Викликає PostgreSQL RPC-функцію через Supabase.
 * Тільки дозволені функції (білий список).
 */
export async function executeAIRpc(
  params: AIRpcParams,
): Promise<AIQueryResult> {
  const fnName = params.function_name?.toLowerCase().trim();

  if (!fnName || !AI_ALLOWED_RPC.includes(fnName as AllowedRPC)) {
    return {
      success: false,
      error: `🚫 RPC-функція "${params.function_name}" не дозволена. Доступні: ${AI_ALLOWED_RPC.join(", ")}`,
    };
  }

  try {
    const pagedSql = fnName === "execute_condition_query";
    const args = params.args || {};
    const { data, error } = await supabase.rpc(pagedSql ? "traffic_ai_condition_page" : fnName, pagedSql ? {
      p_query: args.query_text, p_limit: Math.min(Math.max(Number(args.limit) || 50, 1), 100),
      p_offset: Math.max(Number(args.offset) || 0, 0),
    } : args);

    if (error) {
      return {
        success: false,
        error: `❌ Помилка RPC "${fnName}": ${error.message}`,
        table: fnName,
      };
    }

    if (pagedSql && (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean")) throw new Error("Некоректна сторінка SQL");
    const resultData = pagedSql ? data.items : Array.isArray(data) ? data : [data];

    return {
      success: true,
      data: resultData,
      count: pagedSql ? data.total : resultData.length,
      returnedRows: resultData.length,
      ...(pagedSql ? { hasMore: data.has_more, fetchedAt: data.as_of,
        scope: { filters: [], offset: Math.max(Number(args.offset) || 0, 0), limit: Math.min(Math.max(Number(args.limit) || 50, 1), 100) } } : {}),
      table: fnName,
      query_description: `RPC ${fnName}(${JSON.stringify(params.args || {})})`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `❌ Помилка RPC: ${err.message || "Невідома помилка"}`,
      table: fnName,
    };
  }
}

// ============================================================
// GEMINI FUNCTION DECLARATION ДЛЯ query_database
// ============================================================

/**
 * Повертає Gemini function declaration для інструменту query_database
 */
export function getQueryDatabaseToolDeclaration(): any {
  return {
    name: "query_database",
    description: `SELECT-запит до БД СТО. Таблиці: acts,clients,cars,slyusars,sclad,post_arxiv,vutratu,faktura,shops,works,details,settings,post_category,post_name,incomes,ai_skills,audit_logs. JSONB: data->>'ПІБ'. Тільки SELECT. Для перевірки чи існує клієнт/авто краще використовуй multi_query_database по clients + cars + acts.`,
    parameters: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Назва таблиці",
          enum: [...AI_ALLOWED_TABLES],
        },
        select: {
          type: "string",
          description: `Колонки. "*" за замовч.`,
        },
        filters: {
          type: "array",
          description: "Масив фільтрів WHERE",
          items: {
            type: "object",
            properties: {
              column: {
                type: "string",
                description:
                  "Назва колонки. Для JSONB: data->>'ПІБ', data->>'Телефон'",
              },
              operator: {
                type: "string",
                description: "eq/neq/gt/gte/lt/lte/like/ilike/is/in/not",
                enum: [
                  "eq",
                  "neq",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "like",
                  "ilike",
                  "is",
                  "in",
                  "not",
                ],
              },
              value: {
                type: "string",
                description:
                  'Значення (рядок). ilike:%шаблон%. is:"null". in:"v1,v2"',
              },
            },
            required: ["column", "operator", "value"],
          },
        },
        order_by: {
          type: "string",
          description: "Сортувати за колонкою",
        },
        order_direction: {
          type: "string",
          description: "Напрямок",
          enum: ["asc", "desc"],
        },
        limit: {
          type: "integer",
          description: "Макс рядків (1-500). Замовч 100",
        },
      },
      required: ["table"],
    },
  };
}

/**
 * Повертає Gemini function declaration для multi_query (кілька запитів одразу)
 */
export function getMultiQueryToolDeclaration(): any {
  return {
    name: "multi_query_database",
    description:
      "Кілька SELECT паралельно (до 5). Для зв'язування таблиць. Обов'язково використовуй для перевірки існування клієнта/авто: clients по ПІБ/телефону, cars по VIN/номеру, acts по ПІБ/телефону/VIN/номеру.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          description: "Масив запитів (макс 5)",
          items: {
            type: "object",
            properties: {
              table: { type: "string", enum: [...AI_ALLOWED_TABLES] },
              select: { type: "string" },
              filters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    operator: {
                      type: "string",
                      enum: [
                        "eq",
                        "neq",
                        "gt",
                        "gte",
                        "lt",
                        "lte",
                        "like",
                        "ilike",
                        "is",
                        "in",
                        "not",
                      ],
                    },
                    value: {
                      type: "string",
                      description: "Значення для порівняння (рядок)",
                    },
                  },
                  required: ["column", "operator", "value"],
                },
              },
              order_by: { type: "string" },
              order_direction: { type: "string", enum: ["asc", "desc"] },
              limit: { type: "integer" },
            },
            required: ["table"],
          },
        },
      },
      required: ["queries"],
    },
  };
}

/**
 * Повертає Gemini function declaration для виклику RPC-функцій
 */
export function getRpcToolDeclaration(): any {
  return {
    name: "call_rpc",
    description: `Виклик серверної RPC-функції PostgreSQL.
Доступні функції:
- get_db_size(): розмір бази даних (без аргументів)
- get_due_reminders(): нагадування що настали (без аргументів)
- get_my_reminders(p_slyusar_id): мої нагадування (id слюсаря)
- trigger_reminder(p_reminder_id): вручну запустити нагадування
- execute_condition_query(p_query): виконати SQL-умову (для перевірки правил)
- get_telegram_link_status(p_slyusar_id): чи привʼязаний Telegram (id слюсаря)`,
    parameters: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Назва RPC-функції",
          enum: [...AI_ALLOWED_RPC],
        },
        args: {
          type: "object",
          description: `Аргументи JSON. get_db_size/{}: пусто. get_my_reminders/{p_slyusar_id:число}. trigger_reminder/{p_reminder_id:число}. execute_condition_query/{p_query:текст}. get_telegram_link_status/{p_slyusar_id:число}.`,
          properties: {},
        },
      },
      required: ["function_name"],
    },
  };
}
