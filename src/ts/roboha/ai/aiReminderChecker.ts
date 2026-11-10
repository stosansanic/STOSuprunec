// 🔔 aiReminderChecker.ts — Перевірка нагадувань (основний обробник)
// Сервер планує строки, браузер читає власну чергу за подіями.
// Немає періодичних HTTP-запитів з кожної відкритої вкладки.
// Realtime: event-based моніторинг БД (без SQL!)
// Сервер/браузер використовують атомарний claim для кожного адресата і каналу.
// ═══════════════════════════════════════════════════════

import { createReminderInbox } from "./reminderInbox";
import { supabase } from "../../vxid/supabaseClient";
import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";
import { buildReminderWatchGroups, createReminderWatchRegistry, REMINDER_CHANGE_COLUMNS } from "./reminderRealtime";
import { deliverReminderOnce, eventGeneration } from "../../../../supabase/functions/_shared/reminderDelivery";

// ── Конфігурація ──

const TOAST_DISPLAY_MS = 12_000; // Час показу toast (12 сек)
const TOAST_STACK_GAP = 12; // Відстань між toast-ами в стеку
const MAX_TOASTS_VISIBLE = 5; // Макс. кількість одночасних toast
const SOUND_ENABLED = true; // Звуковий сигнал

// ── Стан ──

let isServerChecking = false;
let toastContainer: HTMLElement | null = null;
let activeToasts: HTMLElement[] = [];
let currentSlyusarId: number | null = null;
let notificationPermissionAsked = false;
let onRemindersTriggered: (() => void) | null = null;

let isTabVisible = !document.hidden;
let inboxChannel: DatabaseSubscription | null = null;
let inbox: ReturnType<typeof createReminderInbox<InboxItem>> | null = null;
interface InboxItem { log_id: number; delivery_generation: string; app_payload: DueReminder }

let remindersStateChannel: DatabaseSubscription | null = null;
let stateSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncTime = 0; // Час останньої синхронізації (тротлінг 10с)
const reminderStateRows = new Map<number, any>();
const reminderStatePending = new Map<number, any>();
const reminderCreatorNames = new Map<number, string>();
const reminderCreatorPending = new Map<number, Promise<void>>();
let reminderOwner = "";
let reminderStateGeneration = 0;
let reminderStateLoading = false;
let reminderStateResync = false;
let monitoringGeneration = 0;
let visibilityListenerBound = false;
function currentReminderOwner(): string {
  try { return localStorage.getItem("userAuthData") || ""; } catch { return ""; }
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





function applyReminderStateEvent(payload: any): void {
  const id = Number(payload.new?.reminder_id || payload.old?.reminder_id);
  if (!id) return;
  if (payload.eventType === "DELETE" || payload.new?.status !== "active" || !currentSlyusarId || !isReminderForUser(payload.new, currentSlyusarId)) reminderStateRows.delete(id);
  else reminderStateRows.set(id, { ...reminderStateRows.get(id), ...payload.new });
}

async function syncReminderCapabilities(force = false): Promise<void> {
  if (!currentSlyusarId) return;
  if (reminderStateLoading) { reminderStateResync ||= force; return; }
  const now = Date.now();
  if (!force && now - lastSyncTime < 10_000) {
    if (stateSyncDebounceTimer) clearTimeout(stateSyncDebounceTimer);
    stateSyncDebounceTimer = setTimeout(() => void syncReminderCapabilities(), 10_000 - (now - lastSyncTime));
    return;
  }
  lastSyncTime = now;
  const generation = reminderStateGeneration;
  const owner = reminderOwner;
  reminderStateLoading = true;
  reminderStatePending.clear();
  try {
    const data: any[] = [];
    let after: number | null = null;
    for (;;) {
      const response: { data: any; error: any } = await supabase.rpc("traffic_reminder_watch_page", { p_recipient_id: currentSlyusarId, p_after: after });
      if (response.error) throw response.error;
      if (generation !== reminderStateGeneration || owner !== currentReminderOwner()) return;
      const page: { items: any[]; has_more: boolean; next_cursor: number | null } = response.data;
      if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("Invalid active reminders page");
      data.push(...page.items);
      if (!page.has_more) break;
      const next: number = Number(page.next_cursor);
      if (!page.items.length || !Number.isSafeInteger(next) || next <= (after ?? 0)) throw new Error("Invalid reminder cursor");
      after = next;
    }
    reminderStateRows.clear();
    for (const row of (data || []) as any[]) reminderStateRows.set(Number(row.reminder_id), row);
    // Changes delivered during the HTTP snapshot always win over the snapshot.
    for (const payload of reminderStatePending.values()) applyReminderStateEvent(payload);
    await reconcileReminderMonitoring();
  } catch { /* Existing channels remain usable after a transient read error. */ }
  finally {
    if (generation === reminderStateGeneration) {
      reminderStateLoading = false;
      reminderStatePending.clear();
      if (reminderStateResync) { reminderStateResync = false; void syncReminderCapabilities(true); }
    }
  }
}

async function reconcileReminderMonitoring(): Promise<void> {
  if (!currentSlyusarId || reminderOwner !== currentReminderOwner()) return;
  const generation = ++monitoringGeneration;
  const owner = reminderOwner;
  const myReminders = [...reminderStateRows.values()].filter(row => isReminderForUser(row, currentSlyusarId!));
  const groups = buildReminderWatchGroups<DueReminder>(myReminders, () => true);
  // Publish rule changes immediately. A slow name lookup must not keep a paused rule subscribed.
  reminderWatchRegistry.replace(groups);
  const missingCreators = [...new Set([...groups.values()].flatMap(group => group.entries.map(({ rem }) => Number(rem.created_by))))]
    .filter(id => id > 0 && !reminderCreatorNames.has(id));
  const unreadCreators = missingCreators.filter(id => !reminderCreatorPending.has(id));
  if (unreadCreators.length) {
    const read = (async () => {
      const { data, error } = await supabase.from("slyusars")
        .select('slyusar_id,name:data->>Name,alternate_name:data->>"Ім\'я"').in("slyusar_id", unreadCreators);
      if (owner !== currentReminderOwner() || error) return;
      for (const creator of data || []) reminderCreatorNames.set(Number(creator.slyusar_id), creator.name || creator.alternate_name || "Невідомий");
    })().catch(() => {}).finally(() => {
      for (const id of unreadCreators) if (reminderCreatorPending.get(id) === read) reminderCreatorPending.delete(id);
    });
    for (const id of unreadCreators) reminderCreatorPending.set(id, read);
  }
  await Promise.all(missingCreators.map(id => reminderCreatorPending.get(id)));
  if (generation !== monitoringGeneration || owner !== currentReminderOwner()) return;
  for (const group of groups.values()) for (const { rem } of group.entries) {
    rem.creator_name = reminderCreatorNames.get(Number(rem.created_by)) || "Невідомий";
  }
}

function initRemindersStateListener(): void {
  if (remindersStateChannel) return;
  remindersStateChannel = databaseSubscriptions.subscribe(
    { table: "atlas_reminders", select: REMINDER_CHANGE_COLUMNS },
    (payload: any) => {
      if (reminderOwner !== currentReminderOwner()) { initReminderChecker(); return; }
      const id = Number(payload.new?.reminder_id || payload.old?.reminder_id);
      if (!id) return;
      if (reminderStateLoading) reminderStatePending.set(id, payload);
      applyReminderStateEvent(payload);
      // Local reconciliation costs no list query and updates captured rules/recipients.
      void reconcileReminderMonitoring();
    },
    status => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") void syncReminderCapabilities(true);
    },
    reminderOwner,
  );
}
function initAppInbox(): void {
  if (inbox || !currentSlyusarId) return;
  const recipient = currentSlyusarId;
  const owner = reminderOwner;
  const active = () => owner === currentReminderOwner() && owner === reminderOwner && isTabVisible;
  inbox = createReminderInbox<InboxItem>({
    isActive: active,
    async read(after) {
      const { data, error } = await supabase.rpc("traffic_reminder_app_inbox", { p_recipient_id: recipient, p_after: after });
      if (error) throw error;
      return data;
    },
    async deliver(item) {
      while (activeToasts.length >= MAX_TOASTS_VISIBLE && active()) await sleepMs(1_000);
      if (!active()) return;
      await deliverReminderOnce(supabase, item.app_payload, recipient, "app", async () => {
        if (owner !== currentReminderOwner()) return "failed";
        showReminderToast(item.app_payload);
        return "delivered";
      }, item.delivery_generation);
    },
    onError(error) { console.error("Atlas app inbox:", error); },
  });
  inboxChannel = databaseSubscriptions.subscribe(
    { table: "atlas_reminder_logs", event: "INSERT", filter: "recipient_id=eq." + recipient, select: ["log_id", "recipient_id", "channel", "delivery_phase"] },
    payload => { if (payload.new?.channel === "app" && payload.new?.delivery_phase === "queued") inbox?.wake(); },
    status => { if (status === "SUBSCRIBED") inbox?.wake(); },
    owner,
  );
  inbox.wake();
}

// ── Ініціалізація ──

export function initReminderChecker(): void {
  const owner = currentReminderOwner();
  if (reminderOwner !== owner) stopReminderChecker();
  reminderOwner = owner;
  currentSlyusarId = getSlyusarId();
  initVisibilityListener();
  if (!currentSlyusarId) {
    return;
  }

  // Створити контейнер для toast-ів
  ensureToastContainer();

  // Замість ручного запуску всіх процесів, активуємо Смарт-Менеджер,
  // який сам проаналізує БД і увімкне необхідні системи ТІЛЬКИ якщо є АКТИВНІ нагадування
  initRemindersStateListener();
  initVisibilityListener();
  initAppInbox();
}

// ── Visibility API: управління polling при приховуванні/показі вкладки ──

function initVisibilityListener(): void {
  if (visibilityListenerBound) return;
  visibilityListenerBound = true;
  document.addEventListener("visibilitychange", handleReminderVisibility);
  window.addEventListener("storage", handleReminderStorage);
  window.addEventListener("focus", handleReminderVisibility);
}

function handleReminderStorage(event: StorageEvent): void {
  if (event.key === "userAuthData" || !event.key) initReminderChecker();
}

function handleReminderVisibility(): void {
  if (reminderOwner !== currentReminderOwner()) { initReminderChecker(); return; }
  isTabVisible = !document.hidden;
  if (isTabVisible) inbox?.wake();
}

/** Колбек для оновлення UI планувальника після спрацювання */
export function setOnRemindersTriggered(cb: () => void): void {
  onRemindersTriggered = cb;
}

export function stopReminderChecker(): void {
  reminderStateGeneration++;
  monitoringGeneration++;
  remindersStateChannel?.unsubscribe();
  remindersStateChannel = null;
  reminderWatchRegistry.clear();
  if (stateSyncDebounceTimer) clearTimeout(stateSyncDebounceTimer);
  stateSyncDebounceTimer = null;
  reminderStateLoading = false;
  reminderStateResync = false;
  reminderStateRows.clear();
  reminderStatePending.clear();
  reminderCreatorNames.clear();
  reminderCreatorPending.clear();
  sentPayloadIds.clear();
  lastSyncTime = 0;
  currentSlyusarId = null;
  reminderOwner = "";
  if (visibilityListenerBound) {
    document.removeEventListener("visibilitychange", handleReminderVisibility);
    window.removeEventListener("storage", handleReminderStorage);
    window.removeEventListener("focus", handleReminderVisibility);
    visibilityListenerBound = false;
  }
  inbox?.dispose();
  inbox = null;
  inboxChannel?.unsubscribe();
  inboxChannel = null;
  for (const toast of activeToasts) { clearTimeout((toast as any)._autoHideTimer); toast.remove(); }
  activeToasts = [];
}





export async function runTelegramServerCheckNow(): Promise<void> {
  await runServerReminderCheck(true);
}

async function runServerReminderCheck(force = false): Promise<void> {
  if (isServerChecking) return;
  // The lock coordinates browser tabs only; server cron remains authoritative.
  if (navigator.locks) {
    await navigator.locks.request("sto-reminders-client-check", { ifAvailable: true }, async lock => {
      if (!lock) return;
      const key = "sto-reminders-last-client-success";
      try {
        if (!force && Date.now() - Number(localStorage.getItem(key) || 0) < 45_000) return;
      } catch { /* storage may be disabled */ }
      if (await performServerReminderCheck()) {
        try { localStorage.setItem(key, String(Date.now())); } catch { /* optional coordination */ }
      }
    });
    return;
  }
  await performServerReminderCheck();
}

async function performServerReminderCheck(): Promise<boolean> {
  if (isServerChecking) return false;
  isServerChecking = true;

  try {
    const { data, error } = await supabase.functions.invoke("check-reminders", {
      body: { source: "client" },
    });

    if (!error && data && (Number(data.sent) > 0 || Number(data.processed) > 0)) {
      if (onRemindersTriggered) onRemindersTriggered();
    }
    return !error && !Number(data?.failed);
  } catch {
    /* Edge недоступна: наступна серверна спроба повторить перевірку. */
    return false;
  } finally {
    isServerChecking = false;
  }
}

// ── Отримати slyusar_id ──

function getSlyusarId(): number | null {
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

// ── Головна перевірка ──

// ── Відправка Telegram з клієнта (з дедуплікацією) ──

async function sendTelegramForReminder(reminder: DueReminder, generation?: string): Promise<void> {
  try {
    // Коли вкладка прихована — не відправляємо Telegram з клієнта.
    // Серверна функція check-reminders (pg_cron) відправить сама.
    if (!isTabVisible) {
      return;
    }

    const recipientIds = await resolveRecipientIds(reminder);
    if (recipientIds.length === 0) {
      return;
    }

    const { data: tgUsers, error } = await supabase
      .from("atlas_telegram_users")
      .select("slyusar_id, telegram_chat_id")
      .in("slyusar_id", recipientIds)
      .eq("is_active", true);

    if (error || !tgUsers?.length) {
      return;
    }

    const icon = getPriorityIcon(reminder.priority);
    const typeLabel = getTypeLabel(reminder.reminder_type);
    const priorityLabel = getPriorityLabel(reminder.priority);

    const messageText = [
      `${icon} <b>${escHtml(reminder.title)}</b>`,
      reminder.description ? `\n${escHtml(reminder.description)}` : "",
      reminder.meta?.condition_result_text
        ? `\n<b>📊 Результат перевірки:</b>\n${escHtml(reminder.meta.condition_result_text)}`
        : "",
      `\n${typeLabel} | Пріоритет: ${priorityLabel}`,
      `👤 Створив: ${escHtml(reminder.creator_name)}`,
    ]
      .filter(Boolean)
      .join("\n");

    const reply_markup = {
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
    };

    for (const tgUser of tgUsers) {
      await deliverReminderOnce(supabase, reminder, Number(tgUser.slyusar_id), "telegram", async () => {
        const response = await supabase.functions.invoke("send-telegram", {
          body: { chat_id: tgUser.telegram_chat_id, text: messageText, parse_mode: "HTML", reply_markup },
        });
        if (!response.error && response.data?.success === true && response.data?.result?.ok === true) return "delivered";
        // An Edge timeout/500 does not prove Telegram rejected the message.
        if (response.data?.result?.ok === false) return "failed";
        return "unknown";
      }, generation, messageText);
    }
  } catch (err) { throw err; }

}

async function resolveRecipientIds(reminder: DueReminder): Promise<number[]> {
  const recipients = reminder.recipients;

  if (recipients === "self" || recipients === '"self"') {
    return reminder.created_by ? [reminder.created_by] : [];
  }

  if (recipients === "all" || recipients === '"all"') {
    const { data } = await selectSlyusarsWithRetry("slyusar_id");
    return data?.map((s: { slyusar_id: number }) => s.slyusar_id) || [];
  }

  if (recipients === "mechanics" || recipients === '"mechanics"') {
    const { data } = await selectSlyusarsWithRetry("slyusar_id", (q) =>
      q.filter("data->>Посада", "eq", "Слюсар"),
    );
    return data?.map((s: { slyusar_id: number }) => s.slyusar_id) || [];
  }

  if (Array.isArray(recipients)) return recipients;

  if (typeof recipients === "string") {
    try {
      const raw = recipients.trim();
      // Парсимо лише JSON-масив, щоб не ловити помилки на plain-значеннях типу "self"
      if (raw.startsWith("[") && raw.endsWith("]")) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      /* */
    }
  }

  return reminder.created_by ? [reminder.created_by] : [];
}

function escHtml(text: string | null | undefined): string {
  if (!text) return "—";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

// ── Перевірка: чи нагадування для цього користувача ──

function isReminderForUser(reminder: DueReminder, slyusarId: number): boolean {
  const recipients = reminder.recipients;

  // "all" — для всіх
  if (recipients === "all" || recipients === '"all"') return true;

  // "self" — тільки для автора
  if (recipients === "self" || recipients === '"self"') {
    return reminder.created_by === slyusarId;
  }

  // "mechanics" — для слюсарів (перевірити роль)
  if (recipients === "mechanics" || recipients === '"mechanics"') {
    return isCurrentUserMechanic();
  }

  // Масив ID
  if (Array.isArray(recipients)) {
    return recipients.includes(slyusarId);
  }

  // JSON-рядок масиву
  if (typeof recipients === "string") {
    try {
      const raw = recipients.trim();
      // Парсимо лише JSON-масив, щоб не логувати зайві parse errors на plain-строках
      if (raw.startsWith("[") && raw.endsWith("]")) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.includes(slyusarId);
      }
    } catch {
      /* */
    }
  }

  // Автор завжди бачить
  return reminder.created_by === slyusarId;
}

function isCurrentUserMechanic(): boolean {
  try {
    const stored = localStorage.getItem("userAuthData");
    if (stored) {
      const data = JSON.parse(stored);
      const role = data?.Доступ || data?.Посада || data?.role || "";
      return role === "Слюсар";
    }
  } catch {
    /* */
  }
  return false;
}

// ── Перевірка умови (conditional) ──

// ── Realtime моніторинг змін у БД — ПОДІЄВИЙ (без SQL!) ──

// Структура правила спостереження:
// {
//   "table":  "acts",                          // таблиця для прослуховування
//   "events": ["INSERT","UPDATE","DELETE"],       // події
//   "check":  "date_off IS NOT NULL",            // необов’язковий фільтр на payload.new
//   "show_fields": ["act_id","ПІБ","Марка+Модель","Загальна сума","Приймальник"]
// }
//
// Або звичайний режим (старий SQL SELECT) — в ньому випадку
// condition_query починається з SELECT і виконується як раніше

// Перевірка умови check на об’єкті payload.new
function evalCheck(
  check: string | undefined,
  newRow: Record<string, any>,
  oldRow: Record<string, any>,
): boolean {
  if (!check) return true; // без фільтру — завжди тригер

  const c = check.trim().toLowerCase();
  const row = newRow;

  // Прості умови: поле IS NOT NULL (з підтримкою вкладених: data.Пароль IS NOT NULL)
  const isNotNull = c.match(/^([\w.]+)\s+is\s+not\s+null$/);
  if (isNotNull) {
    const field = isNotNull[1];
    const [, newVal] = getNestedValues(field, oldRow, row);
    return newVal != null && newVal !== "";
  }

  // Прості умови: поле IS NULL
  const isNull = c.match(/^([\w.]+)\s+is\s+null$/);
  if (isNull) {
    const field = isNull[1];
    const [, newVal] = getNestedValues(field, oldRow, row);
    return newVal == null || newVal === "";
  }

  // Зміна поля: field CHANGED (підтримка вкладених полів: data.Пароль CHANGED)
  const changed = c.match(/^([\w.]+)\s+changed$/);
  if (changed) {
    const field = changed[1];
    const [oldVal, newVal] = getNestedValues(field, oldRow, row);
    // Якщо old рядок не містить поле (REPLICA IDENTITY не FULL — old містить лише PK),
    // ми не можемо підтвердити, що значення НЕ змінилось → тригеримо завжди
    if (oldVal === undefined && newVal !== undefined) return true;
    return String(oldVal ?? "") !== String(newVal ?? "");
  }

  // Зміна з null на NOT NULL: field CLOSED
  const closed = c.match(/^([\w.]+)\s+closed$/);
  if (closed) {
    const field = closed[1];
    const [oldVal, newVal] = getNestedValues(field, oldRow, row);
    // Якщо old не містить поле (REPLICA IDENTITY не FULL) — перевіряємо лише new
    if (oldVal === undefined) return newVal != null && newVal !== "";
    return (oldVal == null || oldVal === "") && newVal != null && newVal !== "";
  }

  // Зміна з NOT NULL на null: field OPENED (очищення комірки)
  const opened = c.match(/^([\w.]+)\s+opened$/);
  if (opened) {
    const field = opened[1];
    const [oldVal, newVal] = getNestedValues(field, oldRow, row);
    // Якщо old не містить поле (REPLICA IDENTITY не FULL) — тригеримо якщо new порожнє
    if (oldVal === undefined) return newVal == null || newVal === "";
    return oldVal != null && oldVal !== "" && (newVal == null || newVal === "");
  }

  // Будь-яка зміна (без фільтру)
  if (c === "any" || c === "*" || c === "true") return true;

  return true; // за замовчуванням — тригер
}

// Отримати значення вкладеного поля (напр. data.Пароль) з old і new рядків
function getNestedValues(
  fieldPath: string,
  oldRow: Record<string, any>,
  newRow: Record<string, any>,
): [any, any] {
  if (!fieldPath.includes(".")) {
    return [oldRow?.[fieldPath], newRow?.[fieldPath]];
  }
  const parts = fieldPath.split(".");
  const resolve = (obj: any): any => {
    let val = obj;
    for (const part of parts) {
      if (val == null) return undefined;
      if (typeof val === "object") {
        // Якщо поле — рядок JSON (JSONB при трансмісії може бути серіалізований)
        if (typeof val[part] === "string" && part === parts[0]) {
          try {
            val = JSON.parse(val[part]);
          } catch {
            val = val[part];
          }
        } else {
          val = val[part];
        }
      } else {
        return undefined;
      }
    }
    return val;
  };
  return [resolve(oldRow), resolve(newRow)];
}

// Людський формат для значення JSONB (масиви, об'єкти, примітиви)
function fmtVal(v: any): string {
  if (v == null) return "—";
  if (Array.isArray(v)) {
    if (v.length === 0) return "(порожньо)";
    return v
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          return (
            item["Найменування"] ||
            item.Робота ||
            item.Деталь ||
            item.Назва ||
            item.Name ||
            JSON.stringify(item)
          );
        }
        return String(item);
      })
      .join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Детальний diff масивів об'єктів (Роботи / Деталі)
function diffArrays(key: string, oldArr: any[], newArr: any[]): string {
  const nameOf = (item: any): string => {
    if (typeof item !== "object" || item === null) return String(item);
    return (
      item["Найменування"] ||
      item.Робота ||
      item.Деталь ||
      item.Назва ||
      item.Name ||
      JSON.stringify(item)
    );
  };
  const detailOf = (item: any): string => {
    if (typeof item !== "object" || item === null) return "";
    const parts: string[] = [];
    const qty = item["Кількість"] ?? item["К-ть"];
    const price = item.Ціна;
    const sum = item.Сума;
    const salary = item.Зарплата ?? item["Зар-та"];
    if (qty != null) parts.push(`${qty} шт`);
    if (price != null) parts.push(`${price} грн`);
    if (sum != null && sum !== price) parts.push(`сума ${sum}`);
    if (salary != null) parts.push(`зп ${salary}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };

  const oldNames = oldArr.map(nameOf);
  const newNames = newArr.map(nameOf);
  const added = newArr.filter((_, i) => !oldNames.includes(newNames[i]));
  const removed = oldArr.filter((_, i) => !newNames.includes(oldNames[i]));
  const lines: string[] = [];
  for (const a of added) lines.push(`  ➕ ${nameOf(a)}${detailOf(a)}`);
  for (const r of removed) lines.push(`  ➖ ${nameOf(r)}${detailOf(r)}`);
  if (lines.length === 0) {
    return `${key}: ${oldArr.length} → ${newArr.length} записів`;
  }
  return `${key}:\n${lines.join("\n")}`;
}

// Форматування повідомлення з payload
function formatPayloadMessage(
  payload: {
    eventType: string;
    table: string;
    new: Record<string, any>;
    old: Record<string, any>;
  },
  _rule: { show_fields?: string[]; check?: string } | null,
): string {
  const row = payload.eventType === "DELETE" ? payload.old : payload.new;
  const data = row?.data || {};
  const jsonData =
    typeof data === "string"
      ? (() => {
          try {
            return JSON.parse(data);
          } catch {
            return {};
          }
        })()
      : data;

  const formatTs = (v: any) => {
    if (!v) return "—";
    try {
      return new Date(v).toLocaleString("uk-UA", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(v);
    }
  };

  // Визначаємо розумну назву дії
  const checkStr = (_rule?.check || "").trim().toLowerCase();
  let action = "";

  // Розумне визначення статусу для date_off
  if (payload.eventType === "UPDATE" && checkStr.includes("date_off")) {
    const oldDateOff = payload.old?.date_off;
    const newDateOff = payload.new?.date_off;
    if (
      (oldDateOff == null || oldDateOff === "") &&
      newDateOff != null &&
      newDateOff !== ""
    ) {
      action = "🔴 Акт закрито";
    } else if (
      oldDateOff != null &&
      oldDateOff !== "" &&
      (newDateOff == null || newDateOff === "")
    ) {
      action = "🟢 Акт відкрито (повернено)";
    } else {
      action = "✏️ Дату закриття змінено";
    }
  } else {
    const eventLabels: Record<string, string> = {
      INSERT: "🟢 Додано",
      UPDATE: "✏️ Оновлено",
      DELETE: "🔴 Видалено",
    };
    action =
      (eventLabels[payload.eventType] || payload.eventType) +
      " • " +
      payload.table;
  }

  const lines: string[] = [];

  // Id
  const id =
    row?.act_id ||
    row?.client_id ||
    row?.slyusar_id ||
    row?.sclad_id ||
    row?.id;
  if (id) lines.push(`🔢 № ${id}`);

  // Карта полів для виводу
  const fieldMap: Record<string, string> = {
    ПІБ: "👤 Клієнт",
    Клієнт: "👤 Клієнт",
    Name: "👤 Ім'я",
    Назва: "📌 Назва",
    Телефон: "📞 Тел",
    Авто: "🚗 Авто",
    Марка: "🚗",
    Модель: "",
    "Держ. номер": "📍",
    Приймальник: "👷‍♂️",
    Слюсар: "🔧 Слюсар",
    "Загальна сума": "💰 Сума",
    "За роботу": "🔧 За роботу",
    "За деталі": "📦 За деталі",
    Посада: "💼 Посада",
    Кількість: "📊 Кількість",
    Ціна: "💰 Ціна",
  };

  // Якщо rule має show_fields — показуємо ТІЛЬКИ вказані поля
  // Якщо ні — показуємо всі з fieldMap
  const showFields = _rule?.show_fields;
  const fieldsToShow = showFields || Object.keys(fieldMap);

  for (const field of fieldsToShow) {
    const label = fieldMap[field] || field;
    const val =
      jsonData[field] ?? row?.[field.toLowerCase().replace(/ /g, "_")];
    if (val != null && String(val).trim() !== "") {
      if (Array.isArray(val)) continue; // масиви — тільки в diff
      lines.push(`${label}: ${val}`);
    }
  }

  // Хто виконав дію (Приймальник) — завжди для acts, якщо не в show_fields
  const performer = jsonData["Приймальник"];
  if (
    performer &&
    !fieldsToShow.includes("Приймальник") &&
    payload.table === "acts"
  ) {
    lines.push(`👷‍♂️ Виконав: ${performer}`);
  }

  // Дати — тільки якщо НЕ обмежено show_fields
  if (!showFields) {
    if (row?.date_off && !checkStr.includes("date_off"))
      lines.push(`📅 Закритий: ${formatTs(row.date_off)}`);
    if (row?.date_on) lines.push(`📅 Відкритий: ${formatTs(row.date_on)}`);
    if (row?.created_at && !row?.date_on && !row?.date_off)
      lines.push(`📅 ${formatTs(row.created_at)}`);
  }

  // Зміни (UPDATE)
  if (payload.eventType === "UPDATE" && payload.old) {
    const changedParts: string[] = [];
    for (const key of Object.keys(payload.new)) {
      const oldVal = payload.old[key],
        newVal = payload.new[key];
      if (
        JSON.stringify(oldVal) !== JSON.stringify(newVal) &&
        key !== "updated_at" &&
        key !== "data"
      ) {
        // date_off вже показано як статус
        if (key === "date_off" && checkStr.includes("date_off")) continue;
        const ts = (v: any) =>
          typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
            ? formatTs(v)
            : String(v ?? "—");
        changedParts.push(`${key}: ${ts(oldVal)} → ${ts(newVal)}`);
      }
    }
    // Зміни в JSONB data
    if (payload.new.data && payload.old.data) {
      const dOld =
        typeof payload.old.data === "string"
          ? JSON.parse(payload.old.data)
          : payload.old.data;
      const dNew =
        typeof payload.new.data === "string"
          ? JSON.parse(payload.new.data)
          : payload.new.data;
      const allKeys = new Set([
        ...Object.keys(dOld || {}),
        ...Object.keys(dNew || {}),
      ]);
      for (const key of allKeys) {
        if (JSON.stringify(dOld?.[key]) !== JSON.stringify(dNew?.[key])) {
          const ov = dOld?.[key];
          const nv = dNew?.[key];
          if (Array.isArray(ov) && Array.isArray(nv)) {
            changedParts.push(diffArrays(key, ov, nv));
          } else if (Array.isArray(nv) && ov == null) {
            changedParts.push(diffArrays(key, [], nv));
          } else if (Array.isArray(ov) && nv == null) {
            changedParts.push(diffArrays(key, ov, []));
          } else {
            changedParts.push(`${key}: «${fmtVal(ov)}» → «${fmtVal(nv)}»`);
          }
        }
      }
    }
    if (changedParts.length > 0)
      lines.push(`\n📝 Зміни:\n${changedParts.join("\n")}`);
  }

  return `${action}\n${lines.join("\n") || "—"}`;
}

// Дедуплікація: пам’ять останніх унікальних ідентифікаторів payload
const sentPayloadIds = new Set<string>();

const reminderWatchRegistry = createReminderWatchRegistry<DueReminder>(
  (table, event, receive) => databaseSubscriptions.subscribe({ table, event }, receive),
  async (payload, currentEntries) => {
    const owner = reminderOwner;
    if (owner !== currentReminderOwner()) { initReminderChecker(); return; }
    const generation = await eventGeneration([payload.commit_timestamp, payload.eventType, payload.table, payload.new, payload.old]);
    if (!currentEntries().length || owner !== currentReminderOwner() || sentPayloadIds.has(generation)) return;
    sentPayloadIds.add(generation);
    setTimeout(() => sentPayloadIds.delete(generation), 10_000);
    for (const entry of currentEntries()) {
      const { rem, rule, eventsUpper } = entry;
      const ruleIdentity = (value: DueReminder) => JSON.stringify([value.condition_query, value.schedule, value.recipients, value.channel]);
      const stillActive = () => currentEntries().some(candidate => candidate.rem.reminder_id === rem.reminder_id && ruleIdentity(candidate.rem) === ruleIdentity(rem));
      // A newer rule edit/pause or an account change invalidates this in-flight callback.
      if (owner !== currentReminderOwner() || !currentSlyusarId) return;
      if (!stillActive()) continue;
      if (!isReminderForUser(rem, currentSlyusarId)) continue;
      if (eventsUpper && !eventsUpper.includes(payload.eventType)) continue;
      if (!evalCheck(rule?.check, payload.new || {}, payload.old || {})) continue;
      try {
        const delivery = { ...rem, meta: { ...rem.meta, condition_result_text: formatPayloadMessage(payload, rule) } };
        if (rem.channel === "app" || rem.channel === "both") {
          await deliverReminderOnce(supabase, delivery, currentSlyusarId, "app", async () => {
            if (owner !== currentReminderOwner()) return "failed";
            showReminderToast(delivery);
            return "delivered";
          }, generation);
        }
        if (owner !== currentReminderOwner()) return;
        if (!stillActive()) continue;
        if (rem.channel === "telegram" || rem.channel === "both") await sendTelegramForReminder(delivery, generation);
      } catch { /* Delivery claims preserve retry/unknown semantics. */ }
    }
  },
);
// ═══════════════════════════════════════════════════════
// 🎨 TOAST UI
// ═══════════════════════════════════════════════════════

interface DueReminder {
  reminder_id: number;
  title: string;
  description: string | null;
  reminder_type: string;
  recipients: any;
  channel: string;
  priority: string;
  condition_query: string | null;
  schedule: any;
  trigger_count: number;
  created_by: number | null;
  creator_name: string;
  meta: any;
}

function ensureToastContainer(): void {
  if (toastContainer && document.body.contains(toastContainer)) return;

  toastContainer = document.createElement("div");
  toastContainer.id = "atlas-reminder-toasts";
  toastContainer.className = "atlas-reminder-toasts";
  document.body.appendChild(toastContainer);
}

function showReminderToast(reminder: DueReminder): void {
  ensureToastContainer();

  // Обмеження кількості видимих toast
  if (activeToasts.length >= MAX_TOASTS_VISIBLE) {
    const oldest = activeToasts.shift();
    oldest?.remove();
  }

  const toast = document.createElement("div");
  toast.className = `atlas-reminder-toast atlas-reminder-toast--${reminder.priority}`;
  toast.setAttribute("data-reminder-id", String(reminder.reminder_id));

  const icon = getPriorityIcon(reminder.priority);
  const typeLabel = getTypeLabel(reminder.reminder_type);
  const timeStr = new Date().toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });

  toast.innerHTML = `
    <div class="atlas-reminder-toast__header">
      <span class="atlas-reminder-toast__icon">${icon}</span>
      <span class="atlas-reminder-toast__title">${escapeHtml(reminder.title)}</span>
      <button class="atlas-reminder-toast__close" title="Закрити">&times;</button>
    </div>
    ${
      reminder.description
        ? `<div class="atlas-reminder-toast__body">${escapeHtml(reminder.description)}</div>`
        : ""
    }
    <div class="atlas-reminder-toast__footer">
      <span class="atlas-reminder-toast__type">${typeLabel}</span>
      <span class="atlas-reminder-toast__time">${timeStr}</span>
      <span class="atlas-reminder-toast__author">від ${escapeHtml(reminder.creator_name)}</span>
    </div>
  `;

  // Кнопка закриття
  const closeBtn = toast.querySelector(".atlas-reminder-toast__close");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    dismissToast(toast);
  });

  // Пауза анімації при hover
  toast.addEventListener("mouseenter", () => {
    toast.classList.add("atlas-reminder-toast--hovered");
  });
  toast.addEventListener("mouseleave", () => {
    toast.classList.remove("atlas-reminder-toast--hovered");
  });

  // Клік → відкрити планувальник
  toast.addEventListener("click", () => {
    openPlannerTab();
    dismissToast(toast);
  });

  // Додати в контейнер
  toastContainer!.appendChild(toast);
  activeToasts.push(toast);

  // Звуковий сигнал
  if (SOUND_ENABLED) {
    playNotificationSound(reminder.priority);
  }

  // Запитати дозвіл на браузерні сповіщення (один раз)
  requestBrowserNotification(reminder);

  // Анімація появи
  requestAnimationFrame(() => {
    toast.classList.add("atlas-reminder-toast--visible");
  });

  // Перерахувати позиції
  repositionToasts();

  // Авто-зникнення (якщо не hovered)
  const autoHideTimer = setTimeout(() => {
    if (!toast.classList.contains("atlas-reminder-toast--hovered")) {
      dismissToast(toast);
    } else {
      // Якщо hover — чекаємо ще
      const waitForLeave = () => {
        toast.removeEventListener("mouseleave", waitForLeave);
        setTimeout(() => dismissToast(toast), 2000);
      };
      toast.addEventListener("mouseleave", waitForLeave);
    }
  }, TOAST_DISPLAY_MS);

  // Зберегти timer щоб можна було скасувати
  (toast as any)._autoHideTimer = autoHideTimer;
}

function dismissToast(toast: HTMLElement): void {
  toast.classList.remove("atlas-reminder-toast--visible");
  toast.classList.add("atlas-reminder-toast--hiding");

  const timer = (toast as any)._autoHideTimer;
  if (timer) clearTimeout(timer);

  setTimeout(() => {
    const idx = activeToasts.indexOf(toast);
    if (idx !== -1) activeToasts.splice(idx, 1);
    toast.remove();
    repositionToasts();
  }, 400);
}

function repositionToasts(): void {
  let offset = 0;
  for (const toast of activeToasts) {
    toast.style.transform = `translateY(${offset}px)`;
    offset += toast.offsetHeight + TOAST_STACK_GAP;
  }
}

// ── Утиліти ──

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

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Звук сповіщення ──

let _reminderAudioCtx: AudioContext | null = null;
let _reminderUserGesture = false;
document.addEventListener(
  "click",
  () => {
    _reminderUserGesture = true;
    if (_reminderAudioCtx && _reminderAudioCtx.state === "suspended") {
      _reminderAudioCtx.resume().catch(() => {});
    }
  },
  { once: true },
);

function playNotificationSound(priority: string): void {
  try {
    if (!_reminderUserGesture) return;
    // Ліниве створення AudioContext
    if (!_reminderAudioCtx) {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) _reminderAudioCtx = new Ctx();
    }
    if (!_reminderAudioCtx) return;
    if (_reminderAudioCtx.state === "suspended") {
      _reminderAudioCtx.resume().catch(() => {});
    }
    const ctx = _reminderAudioCtx;
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Різні звуки для різних пріоритетів
    if (priority === "urgent") {
      // Три швидкі біпи
      oscillator.frequency.value = 880;
      gainNode.gain.value = 0.15;
      oscillator.start(ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      oscillator.stop(ctx.currentTime + 0.15);

      // Другий біп
      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1100;
        gain2.gain.value = 0.15;
        osc2.start(ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc2.stop(ctx.currentTime + 0.15);
      }, 200);

      // Третій біп
      setTimeout(() => {
        const osc3 = ctx.createOscillator();
        const gain3 = ctx.createGain();
        osc3.connect(gain3);
        gain3.connect(ctx.destination);
        osc3.frequency.value = 1320;
        gain3.gain.value = 0.15;
        osc3.start(ctx.currentTime);
        gain3.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc3.stop(ctx.currentTime + 0.15);
      }, 400);
    } else if (priority === "high") {
      // Два біпи
      oscillator.frequency.value = 660;
      gainNode.gain.value = 0.12;
      oscillator.start(ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      oscillator.stop(ctx.currentTime + 0.2);

      setTimeout(() => {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 880;
        gain2.gain.value = 0.12;
        osc2.start(ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc2.stop(ctx.currentTime + 0.2);
      }, 250);
    } else {
      // Один м'який біп
      oscillator.frequency.value = 523;
      oscillator.type = "sine";
      gainNode.gain.value = 0.08;
      oscillator.start(ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      oscillator.stop(ctx.currentTime + 0.3);
    }
  } catch {
    // AudioContext може бути заблокований
  }
}

// ── Браузерне сповіщення (як бонус) ──

function requestBrowserNotification(reminder: DueReminder): void {
  if (notificationPermissionAsked) return;
  notificationPermissionAsked = true;

  if (!("Notification" in window)) return;

  if (Notification.permission === "granted") {
    showBrowserNotification(reminder);
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        showBrowserNotification(reminder);
      }
    });
  }
}

function showBrowserNotification(reminder: DueReminder): void {
  try {
    const icon = getPriorityIcon(reminder.priority);
    new Notification(`${icon} ${reminder.title}`, {
      body: reminder.description || "Нагадування від Атласа",
      icon: "/src/ikons/atlas-icon.png",
      tag: `reminder-${reminder.reminder_id}`,
      requireInteraction: reminder.priority === "urgent",
    });
  } catch {
    // Не критично
  }
}

// ── Відкрити планувальник ──

function openPlannerTab(): void {
  // Відкрити AI-чат якщо закритий
  const chatWindow = document.querySelector(
    ".ai-chat-window",
  ) as HTMLElement | null;
  if (chatWindow && chatWindow.classList.contains("hidden")) {
    const chatBtn = document.getElementById(
      "ai-chat-open-btn",
    ) as HTMLElement | null;
    chatBtn?.click();
  }

  // Переключити на вкладку "Планувальник"
  setTimeout(() => {
    const plannerTab = document.querySelector(
      '[data-tab="planner"]',
    ) as HTMLElement | null;
    plannerTab?.click();
  }, 300);
}
