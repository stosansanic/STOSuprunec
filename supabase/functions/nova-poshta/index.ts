import { createClient } from "npm:@supabase/supabase-js@2.98.0";
import { normalizePhone, normalizeTTN, npDate, trackingPatch, documentDetails, plannedDelivery } from "../_shared/nova-poshta-domain.ts";

function createAdmin(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
let admin: ReturnType<typeof createAdmin>;
function initializeAdmin(): void {
  if (admin) return;
  const url = Deno.env.get("SUPABASE_URL")?.trim() || "";
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim()
    || Deno.env.get("SUPABASE_SECRET_KEY")?.trim() || "";
  if (!key) {
    try {
      const keys: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        const values = keys as Record<string, unknown>;
        const candidate = values.default ?? Object.values(values).find(value => typeof value === "string" && value.trim());
        if (typeof candidate === "string") key = candidate.trim();
      }
    } catch { /* Report a configuration error with CORS headers below. */ }
  }
  if (!url || !key) throw new Failure("У серверній функції відсутній SUPABASE_URL або серверний ключ Supabase. Перевірте Secrets цього проєкту.", 503, "SERVER_CONFIG");
  try {
    admin = createAdmin(url, key);
  } catch {
    throw new Failure("Некоректні серверні налаштування Supabase. Перевірте URL і серверний ключ у Secrets.", 503, "SERVER_CONFIG");
  }
}
class Failure extends Error { constructor(message: string, public status = 400, public code = "INVALID") { super(message); } }
function checked<T>(result: { data: T; error: unknown }): T {
  if (result.error) {
    const issue = result.error as { code?: string; message?: string };
    // Log only the database error code/message. Never log query arguments or rows.
    console.error("Nova Poshta database operation failed", {
      code: issue.code || "UNKNOWN",
      message: (issue.message || "Database request failed").slice(0, 240),
    });
    throw new Failure("Не вдалося виконати операцію в базі. Перевірте встановлення модуля.", 500, "DATABASE");
  }
  return result.data;
}
const text = (value: unknown, max = 2000) => String(value ?? "").trim().slice(0, max);
async function cipher(value: string, decrypt = false): Promise<string> {
  const secret = Deno.env.get("NP_ENCRYPTION_KEY") || "";
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Failure("Серверний ключ шифрування НП ще не налаштований.", 503, "SETUP");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(secret.match(/../g)!.map(h => parseInt(h, 16))), "AES-GCM", false, ["encrypt", "decrypt"]);
  if (decrypt) {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...iv, ...bytes));
}
async function np(key: string, model: string, method: string, properties: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch("https://api.novaposhta.ua/v2.0/json/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key, modelName: model, calledMethod: method, methodProperties: properties }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
      throw new Failure("Нова пошта тимчасово недоступна. Спробуйте оновити ще раз.", 503, "NP_UNAVAILABLE");
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await new Promise(r => setTimeout(r, 700 * 2 ** attempt)); continue;
    }
    if (!response.ok) throw new Failure("Нова пошта відхилила запит. Спробуйте пізніше.", 503, "NP_UNAVAILABLE");
    const result = await response.json();
    if (!result.success) {
      const invalidKey = /api.?key|авторизац|authentication/i.test(JSON.stringify(result.errors || []));
      throw new Failure(invalidKey ? "Перевірте або замініть API-ключ Нової пошти." : "Нова пошта не виконала запит. Перевірте дані та доступ акаунта.", 400, invalidKey ? "NP_KEY" : "NP_REJECTED");
    }
    if (!Array.isArray(result.data) || result.data.some((row: unknown) => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Failure("Нова пошта повернула неочікуваний формат даних. Імпорт не завершено.", 502, "NP_RESPONSE");
    }
    if (["getIncomingDocumentsByPhone", "getOutgoingDocumentsByPhone"].includes(method)) {
      const rows = result.data;
      if (rows.length === 0) return [];
      if (rows.length !== 1 || !Array.isArray(rows[0].result) || rows[0].result.some((row: unknown) => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new Failure("Нова пошта повернула неочікуваний формат списку посилок. Імпорт не завершено.", 502, "NP_RESPONSE");
      }
      return rows[0].result;
    }
    return result.data;
  }
  return [];
}
type Config = { name?: string; phone?: string; login?: string; password_encrypted?: string; api_key_encrypted?: string; enabled?: boolean; access?: Record<string, boolean> };
type Actor = { id: number; name: string; role: string };
async function saveConfig(patch: Record<string, unknown>) {
  checked(await admin.rpc("np_online_settings", { p_patch: patch }));
}
async function rate(bucket: string, limit: number, seconds: number) {
  if (!checked(await admin.rpc("np_online_rate", { p_bucket: bucket, p_limit: limit, p_seconds: seconds })))
    throw new Failure("Забагато спроб. Зачекайте та повторіть.", 429, "RATE_LIMIT");
}
async function actor(req: Request, body: Record<string, unknown>): Promise<{ actor: Actor; token?: string; visible?: boolean; config: Config }> {
  const accessToken = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) throw new Failure("Увійдіть у програму повторно.", 401, "LOGIN");
  const { data: { user }, error } = await admin.auth.getUser(accessToken);
  if (error || !user) throw new Failure("Увійдіть у програму повторно.", 401, "LOGIN");
  const mode = body.action === "discover" ? "discover" : body.action === "authenticate" ? "authenticate" : "session";
  let employeeId: number | null = null;
  if (mode === "session") {
    let session;
    try { session = JSON.parse(await cipher(text(body.session, 2048), true)); }
    catch { throw new Failure("Підтвердіть вхід працівника.", 401, "EMPLOYEE_LOGIN"); }
    if (session.purpose !== "np-online-session" || session.uid !== user.id || !(session.expires > Date.now())
      || !Number.isSafeInteger(session.employee) || session.employee < 1)
      throw new Failure("Підтвердіть вхід працівника.", 401, "EMPLOYEE_LOGIN");
    employeeId = session.employee;
  } else if (mode === "discover") {
    const candidate = Number(body.employee_id);
    employeeId = Number.isSafeInteger(candidate) ? candidate : null;
  }
  const result = await admin.rpc("traffic_np_request_context", { p_uid: user.id, p_email: user.email || "", p_mode: mode,
    p_employee: employeeId, p_name: mode === "authenticate" ? text(body.name, 200) : "", p_password: mode === "authenticate" ? text(body.password, 300) : "" });
  if (result.error && ["PGRST202", "42883"].includes(result.error.code))
    throw new Failure("Оновіть SQL модуля Нової пошти: відсутня функція traffic_np_request_context.", 503, "SETUP");
  const context = checked(result);
  if (context?.error === "RATE_LIMIT") throw new Failure("Забагато спроб. Зачекайте та повторіть.", 429, "RATE_LIMIT");
  if (context?.error === "CREDENTIALS") throw new Failure("Неправильне ім’я або пароль працівника.", 403, "CREDENTIALS");
  if (context?.error === "FORBIDDEN") throw new Failure("Немає доступу до цього СТО.", 403, "FORBIDDEN");
  if (context?.error === "EMPLOYEE_FORBIDDEN") throw new Failure("Немає доступу до Нової пошти.", 403, "FORBIDDEN");
  if (mode === "discover") return { actor: { id: 0, name: "", role: "" }, visible: context?.visible === true, config: {} };
  const who = context?.actor as Actor | undefined;
  if (!who || !Number.isSafeInteger(who.id) || who.id < 1 || typeof who.role !== "string" || !context?.config)
    throw new Failure("Некоректний контекст доступу Нової пошти. Оновіть SQL модуля.", 503, "SETUP");
  if (mode === "authenticate") {
    // Authenticated encryption binds the short-lived session to the Supabase user.
    const token = await cipher(JSON.stringify({ purpose: "np-online-session", uid: user.id, employee: who.id, expires: Date.now() + 3600000 }));
    return { actor: who, token, config: context.config };
  }
  return { actor: who, config: context.config };
}
function requireAdmin(who: Actor) { if (who.role !== "Адміністратор") throw new Failure("Дія доступна адміністратору.", 403, "FORBIDDEN"); }
async function providerKey(getConfig: () => Promise<Config>) {
  const config = await getConfig();
  if (!config.enabled || !config.api_key_encrypted) throw new Failure("Підключіть Нову пошту в налаштуваннях.", 409, "NP_KEY_MISSING");
  return { config, key: await cipher(config.api_key_encrypted, true) };
}
function shipment(row: Record<string, unknown>, direction = "unknown") {
  const ttn = normalizeTTN(row.Number);
  return { id: ttn, ttn, direction, description: "", provider_description: text(row.CargoDescription),
    origin: text(row.CitySenderDescription), destination: text(row.CityRecipientDescription), warehouse: text(row.RecipientAddressDescription),
    document_date: npDate(row.DateTime), estimated_date: npDate(plannedDelivery(row)), arrived_date: null, received_date: null,
    sent_date: null, checked_at: new Date().toISOString(), sync_error: null, responsible_id: null, version: 0, links: [],
    created_at: "", updated_at: new Date().toISOString(), ...trackingPatch(row), provider_details: documentDetails(row) };
}
function archiveEntry(row: Record<string, unknown>, source: string, direction?: string) {
  const ttn = normalizeTTN(row.Number);
  const statusCode = String(row.StatusCode ?? "").trim();
  // Unavailable provider records must never replace the saved shipment, from either source.
  if (["0", "3"].includes(statusCode) || (source === "tracking" && !statusCode)) return false;
  const data: Record<string, unknown> = source === "document" ? shipment(row, direction) : { ...trackingPatch(row), provider_details: documentDetails(row) };
  if (source === "document") {
    if (!row.StatusCode) { delete data.state; delete data.raw_status; delete data.raw_code; }
    if (!direction || direction === "unknown") delete data.direction;
    delete data.checked_at; delete data.updated_at; delete data.version;
  }
  return { ttn, data, raw: row, source };
}
function archiveView(row: any) {
  return { state: "unknown", direction: "unknown", ...row.data, id: row.ttn, ttn: row.ttn, checked_at: row.last_seen_at,
    raw_document: row.raw_document, raw_tracking: row.raw_tracking, history: row.history };
}
function defaultPeriod() {
  const to = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(to + "T00:00:00Z"); start.setUTCDate(start.getUTCDate() - 13);
  return { from: start.toISOString().slice(0, 10), to };
}
async function dispatch(req: Request, b: Record<string, unknown>) {
  const identity = await actor(req, b); const who = identity.actor;
  // This configuration lives only for this request and must never enter an HTTP response.
  const getConfig = async (): Promise<Config> => identity.config;
  if (["discover", "authenticate"].includes(String(b.action))) {
    const { config: _config, ...response } = identity;
    return response;
  }
  if (b.action === "logout") return {};
  if (b.action === "act_detail") {
    const actId = Number(b.act_id);
    if (!Number.isSafeInteger(actId) || actId < 1) throw new Failure("Вкажіть номер акта.");
    const result = await admin.rpc("np_archive_act_read", { p_employee: who.id, p_act: actId, p_ttn: normalizeTTN(b.id), p_full: b.full === true });
    if (result.error?.message.includes("ACT_FORBIDDEN")) throw new Failure("Немає доступу до ТТН цього акта.", 403, "ACT_FORBIDDEN");
    if (result.error?.message.includes("TTN_NOT_SAVED")) throw new Failure("ТТН ще немає в історії. Натисніть «Оновити з Нової пошти».");
    return { shipment: checked(result) };
  }
  if (b.action === "act_list" || b.action === "act_link") {
    const actId = Number(b.act_id);
    if (!Number.isSafeInteger(actId) || actId < 1) throw new Failure("Вкажіть номер акта.");
    const result = await admin.rpc(b.action === "act_list" ? "np_archive_act_read" : "np_online_act", {
      p_employee: who.id, p_act: actId,
      ...(b.action === "act_link" ? { p_ttn: normalizeTTN(b.ttn), p_remove: b.remove === true,
        p_note: text(b.note), p_direction: ["incoming", "outgoing"].includes(String(b.direction)) ? b.direction : "unknown" } : {}),
    });
    if (result.error?.message.includes("TTN_NOT_SAVED")) throw new Failure("Спочатку завантажте цю ТТН кнопкою «Оновити з Нової пошти».");
    if (result.error?.message.includes("ACT_FORBIDDEN")) throw new Failure("Немає доступу до прив’язки ТТН до цього акта.", 403, "ACT_FORBIDDEN");
    const saved = checked(result);
    return { ...saved, items: saved.items.map((item: unknown) => typeof item === "string" ? { ttn: item, direction: "unknown", note: "" } : item) };
  }
  if (b.action === "overview") {
    const c = await getConfig();
    return { actor: who, ready: 0, events: [], connection: Object.keys(c).length ? {
      name: c.name || "Нова пошта", enabled: !!c.enabled, last_sync: null, last_error: null, incoming_capability: "online",
      ...(who.role === "Адміністратор" ? { phone: c.phone || "", login: c.login || "", has_key: !!c.api_key_encrypted, has_password: !!c.password_encrypted } : {})
    } : null };
  }
  if (["connect", "save_settings", "disconnect", "resume", "forget_key"].includes(String(b.action))) {
    requireAdmin(who); await rate(`connection:${who.id}`, 10, 300);
    const c = await getConfig();
    if (b.action === "disconnect") { await saveConfig({ enabled: false }); return {}; }
    if (b.action === "forget_key") { await saveConfig({ api_key_encrypted: null, enabled: false }); return {}; }
    if (b.action === "resume") {
      if (!c.api_key_encrypted) throw new Failure("Спочатку введіть API-ключ.");
      await np(await cipher(c.api_key_encrypted, true), "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });
      await saveConfig({ enabled: true }); return { message: "Підключення відновлено." };
    }
    const phone = normalizePhone(b.phone); if (!phone) throw new Failure("Вкажіть телефон акаунта НП.");
    const patch: Record<string, unknown> = { name: text(b.name, 100) || "Нова пошта", phone, login: text(b.login, 200), schema_version: 2 };
    if (text(b.account_password, 1000)) patch.password_encrypted = await cipher(text(b.account_password, 1000));
    if (b.clear_password === true) patch.password_encrypted = null;
    if (b.action === "connect") {
      const key = text(b.key, 200); if (!/^[a-z0-9-]{20,200}$/i.test(key)) throw new Failure("Вкажіть коректний API-ключ.");
      await np(key, "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });
      patch.api_key_encrypted = await cipher(key); patch.enabled = true;
    }
    await saveConfig(patch); return { message: "Налаштування збережено." };
  }
  if (b.action === "detail") {
    const row = checked(await admin.from("novaposhta").select(b.full === true ? "ttn,data,last_seen_at,raw_document,raw_tracking,history" : "ttn,data,last_seen_at").eq("ttn", normalizeTTN(b.id)).maybeSingle());
    if (!row) throw new Failure("ТТН ще немає в історії. Натисніть «Оновити з Нової пошти».");
    return { shipment: archiveView(row) };
  }
  if (b.action === "link_options") {
    const kind = b.kind ?? "all";
    const input = String(b.query ?? "").trim();
    const query = kind === "act" ? input : input.replace(/[\s-]/g, "");
    const page = b.page == null ? 1 : Number(b.page);
    if (typeof kind !== "string" || !["all", "ttn", "act"].includes(kind) || query.length > 120
      || (kind !== "act" && !/^\d{0,16}$/.test(query))
      || !Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new Failure("Введіть цифри номера та коректну сторінку пошуку.");
    const result = await admin.rpc("np_archive_link_options", { p_employee: who.id, p_kind: kind, p_query: query, p_page: page });
    if (result.error?.code === "PGRST202" || result.error?.code === "42883") {
      throw new Failure("Для списків ТТН і актів виконайте оновлений 01-update-existing.sql у Supabase → SQL Editor.", 503, "LINK_OPTIONS_SETUP");
    }
    return checked(result);
  }
  if (b.action === "list") {
    const page = Math.max(1, Math.floor(Number(b.page) || 1));
    const actId = b.act_id ? Number(b.act_id) : null;
    if (actId !== null && (!Number.isSafeInteger(actId) || actId < 1)) throw new Failure("Вкажіть коректний номер акта.");
    if (b.offset !== undefined) {
      const offset = Number(b.offset), limit = Number(b.limit);
      if (!Number.isSafeInteger(offset) || offset < 0 || ![5,10,50].includes(limit)) throw new Failure("Некоректні параметри підвантаження.");
      return checked(await admin.rpc("np_archive_list_v2", { p_employee: who.id, p_offset: offset, p_limit: limit,
        p_from: actId ? null : npDate(b.from), p_to: actId ? null : npDate(b.to),
        p_direction: ["incoming","outgoing"].includes(String(b.direction)) ? b.direction : null, p_act: actId,
        p_query: String(b.query || "").slice(0,200), p_state: b.state ? String(b.state) : null }));
    }
    return checked(await admin.rpc("np_archive_list", { p_employee: who.id, p_page: page,
      p_from: actId ? null : npDate(b.from), p_to: actId ? null : npDate(b.to), p_direction: ["incoming","outgoing"].includes(String(b.direction)) ? b.direction : null, p_act: actId }));
  }
  if (b.action === "sync_ttn") {
    const { key, config } = await providerKey(getConfig);
    const numbers = [normalizeTTN(b.id)];
    const rows = await np(key,"TrackingDocument","getStatusDocuments",{Documents:numbers.map(ttn=>({DocumentNumber:ttn,Phone:config.phone}))});
    const entries = rows.filter(row => numbers.includes(String(row.Number))).map(row => archiveEntry(row,"tracking")).filter(Boolean);
    const updated = entries.length ? checked(await admin.rpc("np_archive_save_batch", { p_entries: entries })) : 0;
    return { updated,
      message: updated ? `Оновлено ТТН: ${updated}.` : "НП не повернула актуальних даних. Збережена історія залишилася без змін." };
  }
  if (b.action === "sync_page") {
    const defaults = !b.from && !b.to ? defaultPeriod() : null;
    const from = npDate(b.from) || defaults?.from; const to = npDate(b.to) || defaults?.to;
    if (!from || !to) throw new Failure("Оберіть «Створено від» і «Створено до» для оновлення з Нової пошти.");
    if (from>to) throw new Failure("Перевірте період оновлення.");
    const { key } = await providerKey(getConfig);
    const page = Math.max(1,Math.floor(Number(b.page)||1));
    const properties = { DateFrom:`${from.split('-').reverse().join('.')} 00:00:00`, DateTo:`${to.split('-').reverse().join('.')} 23:59:59`,Page:page,Limit:20,SearchByCounterparties:null,iCounterparties:null };
    const directions = Array.isArray(b.directions) ? ["incoming","outgoing"].filter(d => (b.directions as unknown[]).includes(d)) : ["incoming","outgoing"];
    const groups = await Promise.all(directions.map(async direction=>({ direction,rows:await np(key,"InternetDocument",direction==="incoming"?"getIncomingDocumentsByPhone":"getOutgoingDocumentsByPhone",properties) })));
    const entries = groups.flatMap(group => group.rows.map(row => archiveEntry(row,"document",group.direction))).filter(Boolean);
    const updated = entries.length ? checked(await admin.rpc("np_archive_save_batch", { p_entries: entries })) : 0;
    const nextDirections = groups.filter(g=>g.rows.length>=20).map(g=>g.direction);
    return { updated, has_more:nextDirections.length>0, next_directions: nextDirections, page };
  }
  throw new Failure("Невідома дія Нової пошти.");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map(s => s.trim()).filter(Boolean);
  const headers = { "Access-Control-Allow-Origin": allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : origin || "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  let action = req.method;
  try {
    // Initialize inside the handler so a configuration error cannot prevent
    // OPTIONS from working or hide its cause behind a gateway BOOT_ERROR.
    initializeAdmin();
    if (req.method === "GET") {
      // Public readiness only; no credentials, employee or shipment data.
      const schema = await admin.from("settings").select("novaposhta").limit(0);
      if (schema.error) {
        console.error("Nova Poshta readiness failed", { code: schema.error.code });
        if (["42703", "42P01", "PGRST204", "PGRST205"].includes(schema.error.code)) {
          throw new Failure("Не знайдено settings.novaposhta. Виконайте 01-database.sql із комплекту Нової пошти в SQL Editor цього Supabase-проєкту, потім натисніть «Повторити».", 503, "ONLINE_SETUP");
        }
        throw new Failure("Функція НП не може прочитати налаштування Supabase. Перевірте серверний ключ та Logs функції nova-poshta.", 503, "SETTINGS_UNAVAILABLE");
      }
      const archive = await admin.from("novaposhta").select("ttn").limit(0);
      if (archive.error) throw new Failure("Виконайте оновлений 01-database.sql: потрібна таблиця novaposhta для історії посилок.", 503, "ARCHIVE_SETUP");
      return new Response(JSON.stringify({ ok: true, service: "nova-poshta", version: "archive-v3" }), { headers });
    }
    if (req.method !== "POST") throw new Failure("Method not allowed", 405);
    const raw = await req.text(); if (raw.length > 16000) throw new Failure("Запит завеликий.", 413);
    const body = JSON.parse(raw);
    action = typeof body?.action === "string" ? body.action : "unknown";
    const result = await dispatch(req, body);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers });
  } catch (error) {
    // Never log request bodies, provider responses, passwords or keys.
    if (!(error instanceof Failure)) {
      console.error("Nova Poshta internal error", {
        action,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      });
    }
    const problem = error instanceof Failure ? error : new Failure("Не вдалося виконати запит. Спробуйте ще раз.", 500, "SERVER");
    return new Response(JSON.stringify({ ok: false, error: problem.message, code: problem.code }), { status: problem.status, headers });
  }
});
