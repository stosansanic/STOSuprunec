import { notify as showAppMessage } from "../../utils/appDialogs";
import { databaseSubscriptions } from "../../utils/databaseSubscriptions";
import { actPresenceHub } from "../zakaz_naraudy/actPresenceHub";
import { normalizeActRealtimeChange } from "../zakaz_naraudy/actRealtimeState";
// ===== ФАЙЛ: src/ts/roboha/tablucya/tablucya.ts =====

import { supabase } from "../../vxid/supabaseClient";
import { clearActSearchPages, readActSearchPage, serializeActSearch, type ActSearchInput, type ActSearchPage, type ActSearchSort } from "./actSearchRead";
import { patchActData } from "../../utils/actSafeWrite";
import { isActFrozen } from "../../utils/actFrozenState";
import { hideActCounters, refreshActCounters, updateActSearchSummary } from "./actCounters";
import { showModal } from "../zakaz_naraudy/modalMain";
import {
  globalCache,
  loadGeneralSettingsFromDB,
  loadGeneralSettingsFromLocalStorage,
  isGeneralSettingsLoadedThisSession,
  markGeneralSettingsAsLoaded,
} from "../zakaz_naraudy/globalCache";
import {
  showLoginModalBeforeTable,
  isUserAuthenticated,
  userAccessLevel,
  userName as currentUserName,
  logoutFromSystemAndRedirect,
  canUserViewActs,
  canUserOpenActs,
  getSavedUserDataFromLocalStorage, // ✅ Додано для фільтрації по приймальнику
  canUserSeePriceColumns, // ✅ Додано для приховування стовпця "Сума"
} from "./users";

// 👇 ІМПОРТ НОВОЇ ФУНКЦІЇ ПОВІДОМЛЕНЬ
import {
  showRealtimeActNotification,
  removeNotificationsForAct,
  removeRealtimeNotification,
  loadAndShowExistingNotifications,
} from "./povidomlennya_tablucya";

// 📞 ІМПОРТ ФУНКЦІЇ ЗАСТОСУВАННЯ НАЛАШТУВАННЯ ТЕЛЕФОНУ, ГОЛОСУ ТА REALTIME ПІДПИСКИ
import {
  loadAndApplyPhoneIndicatorSetting,
  loadAndApplyVoiceInputSetting,
  loadAndApplyAiProSetting,
  loadAndApplyFavicon,
  subscribeToSettingsRealtime,
} from "../nalachtuvannay/nalachtuvannay";
import { initAIChatButton } from "../ai/aiChat";

// 🔍 РОЗУМНИЙ ПОШУК
import {
  parseSmartSearch,
  applySmartFilters,
  getSmartSearchHint,
} from "./smartSearch";

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && target.closest("#logout-link")) {
    e.preventDefault();
    logoutFromSystemAndRedirect();
  }
});

// 📞 Глобальний обробник кліків на індикатор дзвінка
document.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  // Перевіряємо чи клік на індикатор або hover-зону
  const callIndicator = target.closest(
    ".call-indicator, .call-indicator-zone",
  ) as HTMLElement | null;
  if (!callIndicator) return;

  e.stopPropagation(); // Не відкривати модалку акту
  e.preventDefault();

  const actId = callIndicator.dataset.actId;
  if (!actId) return;

  await handleCallIndicatorClick(Number(actId), callIndicator);
});

/**
 * 📞 Форматує поточний час та дату для дзвінка (для збереження в БД)
 * Формат: HH:MM DD.MM.YY
 */
function formatCallDateTime(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const year = now.getFullYear().toString().slice(-2);
  return `${hours}:${minutes} ${day}.${month}.${year}`;
}

/**
 * 📞 Форматує збережене значення дзвінка в HTML зі стилями
 * Вхід: "📞 10:33 18.02.26" або "📵 10:33 18.02.26"
 * Вихід: HTML з синім часом та сірою датою
 */
function getCallStatus(callValue: string): "reached" | "missed" | "pending" {
  if (callValue.startsWith("📞")) return "reached";
  if (callValue.startsWith("📵")) return "missed";
  return "pending";
}

function formatCallDisplayHtml(callValue: string): string {
  // Парсимо: "📞 10:33 18.02.26" -> icon="📞", time="10:33", date="18.02.26"
  const match = callValue.match(
    /^([📞📵])\uFE0F?\s*(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{2})$/u,
  );
  if (!match) {
    const text = document.createElement("span");
    text.textContent = callValue;
    return text.innerHTML;
  }
  const status = getCallStatus(callValue);
  const label = status === "reached" ? "Дозвонилися" : "Не дозвонилися";
  const icon = `<svg class="call-status-icon call-status-icon--${status}" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}" focusable="false"><title>${label}</title><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.79a2 2 0 0 1-.45 2.11L8.08 9.89a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.33 1.83.56 2.79.69A2 2 0 0 1 22 16.92Z"/>${status === "missed" ? '<path d="m3 3 18 18"/>' : ""}</svg>`;
  const time = match[2];
  const date = match[3];
  return `${icon}<span class="call-dt-info"> <span style="color: #0400ff; font-weight: bold;">${time}</span> / <span style="color: #555;">${date}</span></span>`;
}

/**
 * 📞 Обробник кліку на індикатор дзвінка
 * ⏳ -> 📞 (дозвонилися) -> 📵 (не взяв) -> ⏳ (очікуємо) -> ...
 */
async function handleCallIndicatorClick(
  actId: number,
  indicator: HTMLElement,
): Promise<void> {
  // SVG не містить емодзі: стан зберігаємо окремо від вигляду іконки.
  const currentStatus = indicator.dataset.callStatus ??
    getCallStatus(indicator.textContent?.trim() || "");
  let newCallValue = "";
  let shouldDelete = false;

  if (currentStatus === "pending") {
    // ⏳ → 📞 (дозвонилися)
    newCallValue = `📞 ${formatCallDateTime()}`;
  } else if (currentStatus === "reached") {
    // 📞 → 📵 (не взяв)
    newCallValue = `📵 ${formatCallDateTime()}`;
  } else if (currentStatus === "missed") {
    // 📵 → ⏳ (очікуємо - видаляємо з бази)
    newCallValue = "⏳";
    shouldDelete = true;
  } else {
    // Щось інше - ставимо 📞
    newCallValue = `📞 ${formatCallDateTime()}`;
  }

  // Показуємо новий статус лише після підтвердженого запису.
  try {
    await saveCallToDatabase(actId, shouldDelete ? null : newCallValue);
  } catch {
    showAppMessage("Не вдалося зберегти дзвінок. Статус не змінено, спробуйте ще раз.");
    return;
  }
  // Оновлюємо UI
  if (shouldDelete) {
    // Повертаємо hover-зону
    const newSpan = document.createElement("span");
    newSpan.className = "call-indicator-zone";
    newSpan.setAttribute("data-act-id", String(actId));
    newSpan.dataset.callStatus = "pending";
    newSpan.innerHTML = `<span class="call-indicator-icon">⏳</span>`;
    indicator.replaceWith(newSpan);
  } else if (indicator.classList.contains("call-indicator-zone")) {
    const newSpan = document.createElement("span");
    newSpan.className = "call-indicator call-indicator-result";
    newSpan.setAttribute("data-act-id", String(actId));
    newSpan.dataset.callStatus = getCallStatus(newCallValue);
    newSpan.innerHTML = formatCallDisplayHtml(newCallValue);
    indicator.replaceWith(newSpan);
  } else {
    // Показуємо нове значення одразу
    indicator.dataset.callStatus = getCallStatus(newCallValue);
    indicator.innerHTML = formatCallDisplayHtml(newCallValue);
    indicator.classList.remove("call-indicator-hover");
    indicator.classList.add("call-indicator-result");
  }

}

/**
 * 📞 Зберігає запис про дзвінок в базу даних (в поле data акту)
 * Якщо callValue = null - видаляє поле "Дзвінок"
 */
async function saveCallToDatabase(
  actId: number,
  callValue: string | null,
): Promise<void> {
  await patchActData(actId, (actData) => {
    if (callValue === null) {
      delete actData["Дзвінок"];
    } else {
      actData["Дзвінок"] = callValue;
    }

  }, { allowClosed: true, allowFrozen: true });
  clearActSearchPages();
}

// =============================================================================
// ГЛОБАЛЬНІ ЗМІННІ
// =============================================================================

let actsGlobal: any[] = [];
let clientsGlobal: any[] = [];
let carsGlobal: any[] = [];
// Зберігаємо ID змінених актів
let modifiedActIdsGlobal: Set<number> = new Set();
// Зберігаємо кількість повідомлень для кожного акту
let actNotificationCounts: Map<number, number> = new Map();
let sortByDateStep = 0;
// 📅 Стан сортування по даті закриття: 0 = звичайний, 1 = закриті від нових до старих по date_off
let sortByClosingDateStep = 0;

// ✏️ Глобальна мапа: actId -> ПІБ редактора (для показу хто редагує акт)
let actEditorsMap: Map<number, string> = new Map();
// Канал для відстеження присутності в актах
let releaseGlobalPresenceObserver: (() => void) | null = null;
let globalPresenceObserverEnabled = false;

// ⏰ Максимальний час "життя" присутності (30 хвилин - повинен співпадати з actPresence.ts)
// Heartbeat в actPresence.ts оновлює присутність кожні 5 хвилин
const PRESENCE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 🧹 Перевіряє чи присутність "застаріла" (старше PRESENCE_MAX_AGE_MS)
 */
function isPresenceStale(openedAt: string): boolean {
  const openedTime = new Date(openedAt).getTime();
  const now = Date.now();
  return now - openedTime > PRESENCE_MAX_AGE_MS;
}

/**
 * ✏️ Отримує ім'я редактора для акту з глобальної мапи присутності
 * @param actId - ID акту
 * @returns Ім'я редактора або null якщо ніхто не редагує
 */
export function getActEditorFromPresence(actId: number): string | null {
  return actEditorsMap.get(actId) || null;
}

// =============================================================================
// УТИЛІТИ
// =============================================================================

function safeParseJSON(data: any): any {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data;
}

function normalizeRecordId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function getTextValue(data: any, keys: string[]): string {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function getCarDisplayName(carData: any): string {
  const directName = getTextValue(carData, [
    "Авто",
    "Автомобіль",
    "auto",
    "car",
    "name",
  ]);
  if (directName) return directName;

  const brand = getTextValue(carData, ["Марка", "brand", "make"]);
  const model = getTextValue(carData, ["Модель", "model"]);
  return [brand, model].filter(Boolean).join(" ");
}

function formatDate(date: Date): string {
  return `${date.getDate().toString().padStart(2, "0")}.${(date.getMonth() + 1)
    .toString()
    .padStart(2, "0")}.${date.getFullYear().toString().slice(-2)}`;
}

function formatDateTime(date: Date): { date: string; time: string } {
  const dateStr = formatDate(date);
  const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
  return { date: dateStr, time: timeStr };
}

function convertISOtoShortDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  try {
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return null;
    const day = date.getDate().toString().padStart(2, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const year = date.getFullYear().toString().slice(-2);
    return `${day}.${month}.${year}`;
  } catch {
    return null;
  }
}

function validateDateFormat(dateStr: string): boolean {
  const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
  if (!dateRegex.test(dateStr)) return false;
  const [d, m, y] = dateStr.split(".");
  const day = parseInt(d);
  const month = parseInt(m);
  const year = parseInt(y);
  return (
    day >= 1 &&
    day <= 31 &&
    month >= 1 &&
    month <= 12 &&
    year >= 2000 &&
    year <= 2100
  );
}

// =============================================================================
// ЛОГІКА REALTIME ТА СПОВІЩЕНЬ
// =============================================================================

/**
 * 1. Завантажує існуючі сповіщення при старті (щоб підсвітити те, що вже є)
 */
/**
 * Завантажує кількість повідомлень для кожного акту
 */
let notificationCountRevision = 0;
const notificationActRevisions = new Map<number, number>();
async function fetchActNotificationCounts(actIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (!actIds.length || !["Адміністратор","Приймальник"].includes(userAccessLevel ?? "")) return counts;
  const reception = userAccessLevel === "Приймальник" ? getSavedUserDataFromLocalStorage?.()?.name : null;
  if (userAccessLevel === "Приймальник" && !reception) return counts;
  const revision = notificationCountRevision;
  const { data, error } = await supabase.rpc("traffic_act_notification_counts", { p_ids: actIds, p_reception: reception });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("Некоректні лічильники сповіщень.");
  for (const row of data) counts.set(Number(row.act_id),Number(row.count));
  if (revision !== notificationCountRevision) refreshNotificationCountsForActs(actIds);
  return counts;
}

/**
 * 2. Підписується на нові сповіщення (PUSH) без перезавантаження таблиці
 */
const notificationEventRows = new Map<number, { actId: number; deleted: boolean }>();
const pendingNotificationCounts = new Set<number>();
let allVisibleNotificationCountsDirty = false;
let notificationCountTimer: ReturnType<typeof setTimeout> | null = null;
let notificationCountsPending = false;

/** Reconcile only badge numbers, once per event burst; never reload acts/customer data. */
export function refreshNotificationCountsForActs(actIds?: number[]): void {
  if (!actIds || actIds.length) {
    notificationCountRevision++;
    for (const id of actIds || actsGlobal.map(act => Number(act.act_id))) notificationActRevisions.set(id, notificationCountRevision);
  }
  if (actIds) actIds.forEach(id => { if (Number.isSafeInteger(id) && id > 0) pendingNotificationCounts.add(id); });
  else allVisibleNotificationCountsDirty = true;
  if (notificationCountTimer || notificationCountsPending || document.visibilityState === "hidden") return;
  notificationCountTimer = setTimeout(() => { notificationCountTimer = null; void flushNotificationCounts(); }, 250);
}

async function flushNotificationCounts(): Promise<void> {
  if (notificationCountsPending || document.visibilityState === "hidden") return;
  const visible = new Set(actsGlobal.map(act => Number(act.act_id)));
  const ids = allVisibleNotificationCountsDirty ? [...visible] : [...pendingNotificationCounts].filter(id => visible.has(id));
  pendingNotificationCounts.clear(); allVisibleNotificationCountsDirty = false;
  if (!ids.length) return;
  notificationCountsPending = true;
  const revisions = new Map(ids.map(id => [id, notificationActRevisions.get(id) || 0]));
  const owner = localStorage.getItem("userAuthData"), generation = tableLoadGeneration;
  try {
    const counts = await fetchActNotificationCounts(ids);
    if (owner !== localStorage.getItem("userAuthData") || generation !== tableLoadGeneration) return;
    for (const id of ids) {
      if ((notificationActRevisions.get(id) || 0) !== revisions.get(id)) continue;
      const count = counts.get(id) || 0;
      actNotificationCounts.set(id, count);
      updateNotificationBadgeInDom(id, count);
      if (count) { modifiedActIdsGlobal.add(id); highlightRowInDom(id); }
      else await clearNotificationVisualOnly(id);
    }
  } catch { /* Keep prior badges on a transient read failure; reconnect retries. */ }
  finally {
    notificationCountsPending = false;
    if (pendingNotificationCounts.size || allVisibleNotificationCountsDirty) refreshNotificationCountsForActs([]);
  }
}

let unreadRecoveryNeeded = false;
let completionRecoveryNeeded = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    releaseGlobalPresenceObserver?.(); releaseGlobalPresenceObserver = null;
    return;
  }
  if (globalPresenceObserverEnabled) subscribeToGlobalActPresence();
  if (unreadRecoveryNeeded) {
    unreadRecoveryNeeded = false;
    void loadAndShowExistingNotifications(true).catch(() => { unreadRecoveryNeeded = true; });
  }
  if (pendingNotificationCounts.size || allVisibleNotificationCountsDirty) refreshNotificationCountsForActs([]);
  if (completionRecoveryNeeded) { completionRecoveryNeeded = false; void reconcileVisibleCompletionStates(); }
});

window.addEventListener("sto:act-notifications-removed", (event: Event) => {
  const { actId, notificationIds } = (event as CustomEvent).detail || {};
  let changed = false;
  for (const rawId of notificationIds || []) {
    const id = Number(rawId), previous = notificationEventRows.get(id);
    if (!Number.isSafeInteger(id)) continue;
    removeRealtimeNotification(id);
    if (!previous?.deleted) changed = true;
    notificationEventRows.set(id, { actId: Number(actId || previous?.actId), deleted: true });
  }
  if (changed && Number(actId)) refreshNotificationCountsForActs([Number(actId)]);
});

let actNotificationsSubscription: { unsubscribe(): void } | null = null;
let actNotificationsScope = "";
export function unsubscribeActNotificationRealtime(): void {
  actNotificationsSubscription?.unsubscribe(); actNotificationsSubscription = null; actNotificationsScope = "";
}
export function subscribeToActNotifications() {
  const scope = localStorage.getItem("userAuthData") || "";
  if (actNotificationsSubscription && actNotificationsScope === scope) return;
  actNotificationsScope = scope;
  actNotificationsSubscription?.unsubscribe(); actNotificationsSubscription = null;
  notificationEventRows.clear();
  if (!["Адміністратор", "Приймальник"].includes(userAccessLevel || "")) return;
  const reception = userAccessLevel === "Приймальник" ? getSavedUserDataFromLocalStorage()?.name : null;
  if (userAccessLevel === "Приймальник" && !reception) return;
  const owner = localStorage.getItem("userAuthData");
  let disconnected = false;
  actNotificationsSubscription = databaseSubscriptions.subscribe(
    { schema: "public", table: "act_changes_notifications", ...(reception ? { filter: `pruimalnyk=eq.${reception}` } : {}) },
    payload => {
      if (owner !== localStorage.getItem("userAuthData")) return;
      const row = payload.eventType === "DELETE" ? payload.old : payload.new;
      const id = Number(row?.notification_id ?? row?.id);
      if (!Number.isSafeInteger(id)) { refreshNotificationCountsForActs(); return; }
      const previous = notificationEventRows.get(id);
      const actId = Number(row?.act_id || previous?.actId);
      const deleted = payload.eventType === "DELETE" || row?.delit === true;
      if (payload.eventType !== "DELETE" && reception && row?.pruimalnyk !== reception) return;
      notificationEventRows.set(id, { actId, deleted });
      if (deleted) {
        removeRealtimeNotification(id);
        if (!previous?.deleted) refreshNotificationCountsForActs(actId ? [actId] : undefined);
        return;
      }
      if ((payload.eventType === "INSERT" && !previous) || previous?.deleted) {
        showRealtimeActNotification({ ...row, notification_id: id, act_id: actId, created_at: row.data || row.created_at });
      }
      if (!previous || previous.deleted !== deleted || previous.actId !== actId) {
        refreshNotificationCountsForActs(actId ? [actId] : undefined);
      }
    },
    status => {
      if (owner !== localStorage.getItem("userAuthData")) return;
      if (status === "SUBSCRIBED") {
        if (disconnected) {
          refreshNotificationCountsForActs();
          if (document.visibilityState === "hidden") unreadRecoveryNeeded = true;
          else void loadAndShowExistingNotifications(true).catch(() => { unreadRecoveryNeeded = true; });
        }
        disconnected = false;
      } else if (["CLOSED", "TIMED_OUT", "CHANNEL_ERROR"].includes(status)) disconnected = true;
    },
  );
}

// Realtime and the confirmed local write receipt share the same status reducer.
const observedCompletionStates = new Map<number, boolean>();
const completionRevisions = new Map<number, number>();
let completionRevision = 0;
let completionOwner = "";
function applySlusarCompletionRecord(updatedAct: any, previousAct?: any, announce = true): void {
  const owner = localStorage.getItem("userAuthData") || "";
  if (owner !== completionOwner) { observedCompletionStates.clear(); completionRevisions.clear(); completionOwner = owner; }
  const actId = Number(updatedAct?.act_id);
  if (!Number.isSafeInteger(actId) || !Object.prototype.hasOwnProperty.call(updatedAct, "slusarsOn")) return;
  const knownAct = actsGlobal.find(act => Number(act.act_id) === actId);
  const previous = observedCompletionStates.get(actId) ??
    (Object.prototype.hasOwnProperty.call(previousAct || {}, "slusarsOn") ? previousAct.slusarsOn === true :
      knownAct ? knownAct.slusarsOn === true : undefined);
  const state = updatedAct.slusarsOn === true;
  completionRevisions.set(actId, ++completionRevision);
  observedCompletionStates.set(actId, state);
  if (observedCompletionStates.size > 5000) {
    const oldest = observedCompletionStates.keys().next().value!;
    observedCompletionStates.delete(oldest); completionRevisions.delete(oldest);
  }
  const reception = updatedAct.pruimalnyk ?? knownAct?.pruimalnyk;
  const isClosed = !!(Object.prototype.hasOwnProperty.call(updatedAct, "date_off") ? updatedAct.date_off : knownAct?.date_off);
  const merged = { ...knownAct, ...updatedAct };
  const newFrozen = isActFrozen(merged);
  if (knownAct) {
    knownAct.slusarsOn = state;
    if (Object.prototype.hasOwnProperty.call(updatedAct, "date_off")) knownAct.date_off = updatedAct.date_off;
    if (reception !== undefined) knownAct.pruimalnyk = reception;
  }
  const relevant = userAccessLevel !== "Приймальник" || reception === getSavedUserDataFromLocalStorage()?.name;
  if (!relevant) return;
  updateFrozenRowInDom(actId, newFrozen, isClosed);
  updateSlusarsOnRowInDom(actId, state, isClosed, reception, newFrozen);
  // An unloaded act has no baseline when replica identity returns only its PK.
  // Announce its first observed completed state once, then suppress repeated true updates.
  if (announce && previous !== true && state && !isClosed && !newFrozen && ["Адміністратор", "Приймальник"].includes(userAccessLevel || "")) {
    showAppMessage(`✅ Роботи завершено в акті №${actId}`, "success", 3000);
  }
}

export function applySlusarCompletionToTable(actId: number, state: boolean, reception?: string, dateOff: string | null = null): void {
  applySlusarCompletionRecord({ act_id: actId, slusarsOn: state, pruimalnyk: reception, date_off: dateOff });
}
window.addEventListener("sto:act-completion-changed", (event: Event) => {
  applySlusarCompletionRecord((event as CustomEvent).detail);
});

let slusarsOnRealtimeChannel: { unsubscribe(): void } | null = null;
function subscribeToSlusarNotifications() {
  slusarsOnRealtimeChannel?.unsubscribe(); slusarsOnRealtimeChannel = null;
  if (!["Адміністратор", "Приймальник", "Слюсар"].includes(userAccessLevel || "")) return;
  const reception = userAccessLevel === "Приймальник" ? getSavedUserDataFromLocalStorage()?.name : null;
  if (userAccessLevel === "Приймальник" && !reception) return;
  const owner = localStorage.getItem("userAuthData");
  // The initial HTTP page may predate the first Realtime handshake.
  let disconnected = true;
  slusarsOnRealtimeChannel = databaseSubscriptions.subscribe(
    { event: "UPDATE", schema: "public", table: "acts",
      select: "act_id,date_on,date_off,client_id,cars_id,pruimalnyk,slusarsOn,avans,sms,contrAgent_act,contrAgent_act_data,traffic_state".split(","),
      ...(reception ? { filter: `pruimalnyk=eq.${reception}` } : {}) },
    payload => {
      if (owner !== localStorage.getItem("userAuthData")) return;
      // Compare status before the completion reducer mutates the cached date_off.
      const { current, previous } = normalizeActRealtimeChange(payload);
      applyActStatusRecord(current, previous);
      applySlusarCompletionRecord(current, previous);
    },
    status => {
      if (owner !== localStorage.getItem("userAuthData")) return;
      if (status === "SUBSCRIBED") {
        if (disconnected) void reconcileVisibleCompletionStates();
        disconnected = false;
      } else if (["CLOSED", "TIMED_OUT", "CHANNEL_ERROR"].includes(status)) disconnected = true;
    },
  );
}

let completionRecoveryPending: Promise<void> | null = null;
let completionRecoveryQueued = false;
function reconcileVisibleCompletionStates(): Promise<void> {
  if (document.visibilityState === "hidden") { completionRecoveryNeeded = true; return Promise.resolve(); }
  if (completionRecoveryPending) { completionRecoveryQueued = true; return completionRecoveryPending; }
  const ids = actsGlobal.map(act => Number(act.act_id));
  if (!ids.length) return Promise.resolve();
  const owner = localStorage.getItem("userAuthData");
  const revision = completionRevision;
  const pending = (async () => {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const { data, error } = await supabase.from("acts")
        .select('act_id,slusarsOn,date_off,pruimalnyk,frozen:data->"Заморожений"')
        .in("act_id", ids.slice(offset, offset + 200));
      if (error || owner !== localStorage.getItem("userAuthData")) return;
      for (const row of data || []) {
        if ((completionRevisions.get(Number(row.act_id)) || 0) <= revision) {
          // A null JSON projection may come from legacy JSON encoded as a string.
          // Preserve the known frozen state unless the database returned a boolean.
          const data = typeof row.frozen === "boolean" ? { data: { Заморожений: row.frozen } } : {};
          applyActStatusRecord({ ...row, ...data });
          applySlusarCompletionRecord({ ...row, ...data }, undefined, false);
        }
      }
    }
  })();
  completionRecoveryPending = pending;
  void pending.finally(() => {
    if (completionRecoveryPending === pending) completionRecoveryPending = null;
    if (completionRecoveryQueued) {
      completionRecoveryQueued = false;
      void reconcileVisibleCompletionStates().catch(() => { completionRecoveryNeeded = true; });
    }
  }).catch(() => { completionRecoveryNeeded = true; });
  return pending;
}

/**
 * ✏️ Підписка на глобальний канал присутності для відстеження хто редагує які акти
 * Показує ПІБ редактора в комірці клієнта
 */
function subscribeToGlobalActPresence() {
  globalPresenceObserverEnabled = true;
  if (releaseGlobalPresenceObserver || document.visibilityState === "hidden") return;
  releaseGlobalPresenceObserver = actPresenceHub.observe(state => {

    // Очищаємо попередню мапу редакторів
    const newEditorsMap = new Map<number, string>();

    // Перебираємо всіх користувачів у стані
    Object.keys(state).forEach((key) => {
      const presences = state[key] as any[];
      if (presences && presences.length > 0) {
        presences.forEach((p) => {
          if (p.actId && p.userName) {
            // 🧹 Ігноруємо "застарілі" присутності (старше 8 годин)
            if (p.openedAt && isPresenceStale(p.openedAt)) {
              return;
            }
            // Зберігаємо тільки якщо це НЕ поточний користувач
            if (p.userName !== currentUserName) {
              newEditorsMap.set(p.actId, p.userName);
            }
          }
        });
      }
    });

    // Порівнюємо зі старою мапою та оновлюємо DOM
    const allActIds = new Set([
      ...actEditorsMap.keys(),
      ...newEditorsMap.keys(),
    ]);

    allActIds.forEach((actId) => {
      const oldEditor = actEditorsMap.get(actId);
      const newEditor = newEditorsMap.get(actId);

      if (oldEditor !== newEditor) {
        // Оновлюємо DOM для цього акту
        updateEditorInfoInDom(actId, newEditor || null);
      }
    });

    // Оновлюємо глобальну мапу
    actEditorsMap = newEditorsMap;
  });
}

/**
 * ✏️ Оновлює інформацію про редактора в DOM для конкретного акту
 */
function updateEditorInfoInDom(actId: number, editorName: string | null): void {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) return;

  const rows = findActRowsInTable(table, actId);

  rows.forEach((row) => {
    // Знаходимо комірку клієнта (3-я комірка)
    const clientCell = row.querySelectorAll("td")[2];
    if (!clientCell) return;

    // Знаходимо span для редактора
    let editorSpan = clientCell.querySelector(
      ".act-editor-info",
    ) as HTMLElement;

    if (editorName) {
      // Показуємо інформацію про редактора
      if (editorSpan) {
        editorSpan.innerHTML = `✏️ ${editorName}`;
        editorSpan.style.display = "inline";
      }
    } else {
      // Приховуємо інформацію про редактора
      if (editorSpan) {
        editorSpan.style.display = "none";
      }
    }
  });
}

/**
 * 🎨 Миттєво оновлює жовте фарбування рядка в таблиці
 */
/**
 * ❄️ Оновлює frozen-стилі рядка та іконку замка в реальному часі
 */
function updateFrozenRowInDom(
  actId: number,
  isFrozen: boolean,
  isClosed: boolean,
): void {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) return;

  const rows = findActRowsInTable(table, actId);

  rows.forEach((row) => {
    // Оновлюємо клас row-frozen
    if (isFrozen) {
      row.classList.add("row-frozen");
      row.classList.remove("row-slusar-on");
      row.setAttribute("title", "Розморозити акт?");
    } else {
      row.classList.remove("row-frozen");
      row.removeAttribute("title");
    }

    // Оновлюємо іконку замка в першій комірці
    const firstCell = row.querySelector("td");
    if (firstCell) {
      const contentDiv = firstCell.querySelector<HTMLElement>(
        ".act-number-main",
      ) || firstCell.querySelector<HTMLElement>(
        "div:not(.notification-count-badge)",
      );
      const targetEl = contentDiv || firstCell;
      const text = targetEl.textContent || "";
      const newIcon = isFrozen ? "❄️" : isClosed ? "🔒" : "🗝️";
      targetEl.textContent = text.replace(/[❄️🔒🗝️☀️]+\s*/, newIcon + " ");
    }
  });
}

function updateSlusarsOnRowInDom(
  actId: number,
  slusarsOn: boolean,
  isClosed: boolean,
  pruimalnyk?: string,
  isFrozen?: boolean,
): void {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) {
    // Таблиця може бути недоступна (модальне вікно відкрито, сторінка у процесі завантаження)
    // Це нормально - просто пропускаємо оновлення
    return;
  }

  const userData = getSavedUserDataFromLocalStorage?.();
  const currentUserName = userData?.name;

  const rows = findActRowsInTable(table, actId);

  rows.forEach((row) => {
    applyClassToRow(
      row,
      slusarsOn,
      isClosed,
      pruimalnyk,
      currentUserName,
      actId,
      isFrozen,
    );
  });

  // Якщо рядок не знайдено - це нормально, просто пропускаємо
  // (таблиця може бути в процесі оновлення)
}

/**
 * Застосовує клас до рядка
 */
function applyClassToRow(
  row: Element,
  slusarsOn: boolean,
  isClosed: boolean,
  pruimalnyk: string | undefined,
  currentUserName: string | undefined,
  _actId: number,
  isFrozen?: boolean,
): void {
  const shouldShowSlusarsOn =
    slusarsOn &&
    !isClosed &&
    !isFrozen &&
    (userAccessLevel === "Адміністратор" ||
      userAccessLevel === "Слюсар" ||
      (userAccessLevel === "Приймальник" && pruimalnyk === currentUserName));

  if (shouldShowSlusarsOn) {
    row.classList.add("row-slusar-on");
  } else {
    row.classList.remove("row-slusar-on");
  }
}

/**
 * Знаходить рядок в таблиці і додає клас підсвітки (Синя ручка)
 */
/**
 * Отримує ID акту з комірки, надійно ігноруючи бейдж
 */
function getActIdFromCell(cell: HTMLElement): number {
  const dataActId = cell.getAttribute("data-act-id");
  if (dataActId) return parseInt(dataActId);

  const mainNumber = cell.querySelector<HTMLElement>(".act-number-main");
  const mainNumberActId = mainNumber?.getAttribute("data-act-id");
  if (mainNumberActId) return parseInt(mainNumberActId);
  if (mainNumber?.textContent) {
    const match = mainNumber.textContent.match(/\d+/);
    if (match) return parseInt(match[0]);
  }

  // Спробуємо знайти div, який НЕ є бейджем (це зазвичай div з номером і ключем)
  const contentDiv = cell.querySelector("div:not(.notification-count-badge)");

  if (contentDiv && contentDiv.textContent) {
    return parseInt(contentDiv.textContent.replace(/\D/g, ""));
  }

  // Резервний варіант: клонування і очищення (якщо структура інша)
  const clone = cell.cloneNode(true) as HTMLElement;
  const badge = clone.querySelector(".notification-count-badge");
  if (badge) badge.remove();

  const cellText = clone.textContent || "";
  return parseInt(cellText.replace(/\D/g, ""));
}

function findActRowsInTable(
  table: Element,
  actId: number,
): HTMLTableRowElement[] {
  const directRow = table.querySelector<HTMLTableRowElement>(
    `tbody tr[data-act-id="${actId}"]`,
  );
  if (directRow) return [directRow];

  return Array.from(
    table.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ).filter((row) => {
    const rowActId = row.getAttribute("data-act-id");
    if (rowActId) return parseInt(rowActId) === actId;

    const firstCell = row.querySelector<HTMLElement>("td");
    return firstCell ? getActIdFromCell(firstCell) === actId : false;
  });
}

/**
 * Знаходить рядок в таблиці і додає клас підсвітки (Синя ручка)
 */
function highlightRowInDom(actId: number) {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) {
    // console.warn(`⚠️ [highlightRowInDom] Таблиця не знайдена`);
    return;
  }

  const rows = findActRowsInTable(table, actId);

  let found = false;
  rows.forEach((row) => {
    row.classList.add("act-modified-blue-pen");
    found = true;
  });

  if (!found) {
    // console.warn(`❌ [highlightRowInDom] Рядок для акту #${actId} НЕ ЗНАЙДЕНО`);
  }
}

/**
 * Оновлює бейдж з кількістю повідомлень в комірці з номером акту
 */
export function updateNotificationBadgeInDom(actId: number, count: number) {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) {
    // console.warn(`⚠️ [updateBadge] Таблиця не знайдена`);
    return;
  }

  const rows = findActRowsInTable(table, actId);
  let found = false;

  rows.forEach((row) => {
    const firstCell = row.querySelector("td") as HTMLTableCellElement;
    if (firstCell) {
      found = true;

      // Шукаємо існуючий бейдж
      let badge = firstCell.querySelector(
        ".notification-count-badge",
      ) as HTMLElement;

      if (count > 0) {
        // Якщо бейджа немає - створюємо
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "notification-count-badge";
          firstCell.style.position = "relative";
          firstCell.appendChild(badge);
        }
        badge.textContent = count.toString();
        badge.style.display = "flex";
      } else {
        // Якщо кількість 0 - ховаємо бейдж
        if (badge) {
          badge.style.display = "none";
        }
      }
    }
  });

  if (!found) {
    // console.warn(`❌ [updateBadge] Рядок для акту #${actId} НЕ ЗНАЙДЕНО`);
  }
}

/**
 * Зменшує лічильник повідомлень для акту на 1
 */
export function decrementNotificationCount(actId: number) {
  const currentCount = actNotificationCounts.get(actId) || 0;
  const newCount = Math.max(0, currentCount - 1);
  actNotificationCounts.set(actId, newCount);
  updateNotificationBadgeInDom(actId, newCount);
}

/**
 * 3. Очищає ВІЗУАЛЬНУ підсвітку в таблиці, АЛЕ НЕ ВИДАЛЯЄ З БАЗИ.
 * @param actId - ID акту
 * @param removeToasts - чи видаляти тости (за замовчуванням false)
 */
export async function clearNotificationVisualOnly(
  actId: number,
  removeToasts: boolean = false,
) {
  // ✅ Працює для Адміністратора та Приймальника
  if (userAccessLevel !== "Адміністратор" && userAccessLevel !== "Приймальник")
    return;

  // Видаляємо з сету (якщо є)
  modifiedActIdsGlobal.delete(actId);

  // Скидаємо лічильник повідомлень (ЗАВЖДИ, навіть якщо не було в сеті)
  actNotificationCounts.set(actId, 0);
  updateNotificationBadgeInDom(actId, 0);

  // Знімаємо синю підсвітку (ЗАВЖДИ)
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (table) {
    const rows = findActRowsInTable(table, actId);
    rows.forEach((row) => {
      row.classList.remove("act-modified-blue-pen");
    });
  }

  // Видаляємо повідомлення з UI тільки якщо явно вказано
  if (removeToasts) {
    removeNotificationsForAct(actId);
  }
}

// =============================================================================
// ОБРОБКА ДАНИХ АКТІВ
// =============================================================================

function getClientInfo(
  act: any,
  clients: any[],
): { pib: string; phone: string } {
  const client = clients?.find((c) => c.client_id === act.client_id);
  const clientData = safeParseJSON(client?.data);
  const pib = clientData?.["ПІБ"] || "Невідомо";
  let phone = clientData?.["Телефон"] || "";
  phone = phone.replace(/[\(\)\-\s]/g, "");
  return { pib, phone };
}

function getCarInfo(act: any, cars: any[]): { number: string; name: string } {
  const actCarId = normalizeRecordId(act.cars_id);
  const car = cars?.find((c) => normalizeRecordId(c.cars_id) === actCarId);
  const carData = safeParseJSON(car?.data);
  const actData = safeParseJSON(act.info || act.data || act.details);
  const number =
    getTextValue(carData, ["Номер авто", "Держ. номер", "plate", "number"]) ||
    getTextValue(actData, ["Номер авто", "Держ. номер"]);
  const name =
    getCarDisplayName(carData) ||
    getTextValue(actData, ["Автомобіль", "Авто", "Марка"]);
  return { number, name };
}

function getActAmount(act: any): number {
  const actData = safeParseJSON(act.info || act.data || act.details);
  const rawAmount =
    actData?.["Загальна сума"] ||
    actData?.["total"] ||
    actData?.["amount"] ||
    act.total ||
    act.amount;
  const num = Number(rawAmount);
  return isNaN(num) ? 0 : num;
}

// Отримуємо відсоток знижки з акту
function getActDiscount(act: any): number {
  const actData = safeParseJSON(act.info || act.data || act.details);
  const discount = Number(actData?.["Знижка"]) || 0;
  return discount;
}

// Отримуємо повну суму ДО знижки (За деталі + За роботу)
function getActFullAmount(act: any): number {
  const actData = safeParseJSON(act.info || act.data || act.details);
  const detailsSum = Number(actData?.["За деталі"]) || 0;
  const workSum = Number(actData?.["За роботу"]) || 0;
  return detailsSum + workSum;
}

function getActDateAsDate(act: any): Date | null {
  if (!act.date_on) return null;
  return new Date(act.date_on);
}

function isActClosed(act: any): boolean {
  return act.date_off && !isNaN(Date.parse(act.date_off));
}

// =============================================================================
// РЕНДЕРИНГ ТАБЛИЦІ (СТВОРЕННЯ КОМІРОК)
// =============================================================================

function createClientCell(
  clientInfo: { pib: string; phone: string },
  actId: number,
  act: any,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.style.position = "relative"; // Для позиціонування індикатора примітки
  const phones = clientInfo.phone ? [clientInfo.phone] : [];
  let pibOnly = clientInfo.pib;

  // 📞 Отримуємо дані про попередні дзвінки
  const actData = safeParseJSON(act.info || act.data || act.details);
  const callData = actData?.["Дзвінок"] || "";

  // Визначаємо HTML для індикатора дзвінка - завжди додаємо hover-зону
  let callIndicatorHtml = "";
  if (callData) {
    // Якщо є запис дзвінка - показуємо його зі стилями
    callIndicatorHtml = `<span class="call-indicator call-indicator-result" data-act-id="${actId}" data-call-status="${getCallStatus(callData)}">${formatCallDisplayHtml(callData)}</span>`;
  } else {
    // Якщо дзвінка ще не було - показуємо ⏳ при наведенні на hover-зону
    callIndicatorHtml = `<span class="call-indicator-zone" data-act-id="${actId}" data-call-status="pending"><span class="call-indicator-icon">⏳</span></span>`;
  }

  // Додаємо ПІБ з індикатором дзвінка
  td.innerHTML = `<div class="client-pib-wrapper"><div>${pibOnly}</div>${callIndicatorHtml}</div>`;

  //  Отримуємо примітки акту (actData вже оголошена вище)
  const actNotes = actData?.["Примітки"];
  if (actNotes && actNotes !== "—" && actNotes.trim() !== "") {
    td.innerHTML += `<div class="act-note-indicator">${actNotes}</div>`;
  }

  let smsHtml = "";
  // Формуємо HTML для SMS, якщо є
  if (act && act.sms) {
    try {
      const dateString = String(act.sms).replace(" ", "T");
      const smsDate = new Date(dateString);

      if (!isNaN(smsDate.getTime())) {
        const { date, time } = formatDateTime(smsDate);
        // Колір #0400ff
        const timeHtml = `<span style="color: #0400ff; font-size: 0.85em; font-weight: bold;">${time}</span>`;
        const dateHtml = `<span style="font-size: 0.85em; color: #555;">${date}</span>`;

        smsHtml = `<div class="sms-sent-indicator" title="SMS надіслано ${time} / ${date}"><svg class="sms-sent-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="SMS надіслано" focusable="false"><path d="M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><path d="m16 18 2 2 4-4"/></svg><span class="sms-dt-info">${timeHtml} / ${dateHtml}</span></div>`;
      }
    } catch (e) {
      // console.warn(`Error parsing SMS date for act ${actId}:`, e);
    }
  }

  // ✏️ Отримуємо інформацію про редактора
  const editorName = actEditorsMap.get(actId);
  const editorHtml = editorName
    ? `<span class="act-editor-info">✏️ ${editorName}</span>`
    : `<span class="act-editor-info" style="display: none;"></span>`;

  // Виводимо телефони і SMS
  if (phones.length > 0) {
    phones.forEach((p) => {
      if (smsHtml) {
        // Для збереження центрування телефону використовуємо position: relative
        td.innerHTML += `
           <div style="position: relative; width: 100%; margin-top: 4px; min-height: 1.2em;">
             <div style="position: absolute; left: 0; top: 0; white-space: nowrap;">${smsHtml}</div>
             <div class="phone-blue-italic" style="text-align: center; width: 100%;">${p}</div>
           </div>`;
        // Очищаємо smsHtml щоб не дублювати
        smsHtml = "";
      } else {
        // ✏️ Телефон і редактор на одній лінії
        td.innerHTML += `<div class="phone-editor-row"><span class="phone-blue-italic">${p}</span>${editorHtml}</div>`;
      }
    });
  } else if (smsHtml) {
    // Якщо телефонів немає, але є SMS
    td.innerHTML += `<div style="margin-top: 4px; text-align: left;">${smsHtml}</div>`;
  }

  td.addEventListener("click", async (e) => {
    // 📞 Якщо клік на індикаторі дзвінка - не відкриваємо акт
    const target = e.target as HTMLElement;
    if (target.closest(".call-indicator, .call-indicator-zone")) {
      return; // Обробляється глобальним обробником
    }

    const canOpen = await canUserOpenActs();
    if (canOpen) {
      showModal(actId, "client");
    } else {
      showNoAccessNotification();
    }
  });

  return td;
}

function createCarCell(
  carInfo: { number: string; name: string },
  actId: number,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.innerHTML = `<div style="word-wrap: break-word; word-break: break-word; white-space: normal;">${carInfo.name}</div>`;
  if (carInfo.number) {
    td.innerHTML += `<div style="color: #ff8800; font-size: 0.9em; word-wrap: break-word; word-break: break-word; white-space: normal;">${carInfo.number}</div>`;
  }

  td.addEventListener("dblclick", async () => {
    const canOpen = await canUserOpenActs();
    if (canOpen) {
      showModal(actId, "other");
    } else {
      showNoAccessNotification();
    }
  });

  return td;
}

function formatShortDateTime(
  date: Date,
  shortYear: boolean = false,
): { date: string; time: string } {
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = shortYear
    ? date.getFullYear().toString().slice(-2)
    : date.getFullYear();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return { date: `${day}.${month}.${year}`, time: `${hours}:${minutes}` };
}

function createDateCell(act: any, actId: number): HTMLTableCellElement {
  const td = document.createElement("td");
  const actDateOn = act.date_on ? new Date(act.date_on) : null;
  const actDateOff = act.date_off ? new Date(act.date_off) : null;

  if (actDateOn && actDateOff) {
    // Обидві дати: date_on / date_off - короткий рік (26)
    const on = formatShortDateTime(actDateOn, true);
    const off = formatShortDateTime(actDateOff, true);
    td.innerHTML = `
      <div style="display: flex; justify-content: space-around; align-items: center; gap: 4px;">
        <div style="text-align: center;">
          <div style="font-size: 0.9em;">${on.date}</div>
          <div style="color: #0400ff; font-size: 0.75em;">${on.time}</div>
        </div>
        <div style="font-size: 0.85em; color: #666;">/</div>
        <div style="text-align: center;">
          <div style="font-size: 0.9em;">${off.date}</div>
          <div style="color: #8B0000; font-size: 0.75em;">${off.time}</div>
        </div>
      </div>`;
  } else if (actDateOn) {
    // Тільки date_on - повний рік (2026)
    const on = formatShortDateTime(actDateOn, false);
    td.innerHTML = `<div>${on.date}</div><div style="color: #0400ff; font-size: 0.85em;">${on.time}</div>`;
  } else {
    td.innerHTML = `<div>-</div>`;
  }

  td.addEventListener("dblclick", async () => {
    const canOpen = await canUserOpenActs();
    if (canOpen) {
      showModal(actId, "other");
    } else {
      showNoAccessNotification();
    }
  });

  return td;
}

// Створюємо комірку для суми з відображенням знижки
function createSumCell(act: any, actId: number): HTMLTableCellElement {
  const td = document.createElement("td");
  td.classList.add("act-table-cell", "act-sum-cell");

  const discountPercent = getActDiscount(act); // Відсоток знижки
  const fullAmount = getActFullAmount(act); // Повна сума ДО знижки (За деталі + За роботу)

  if (discountPercent > 0 && fullAmount > 0) {
    // Обчислюємо суму після знижки: 315 - 10% = 284
    const discountedAmount = Math.round(
      fullAmount * (1 - discountPercent / 100),
    );

    // Є знижка - показуємо в два рядки
    // Верхній: повна сума (315) з відсотком (-10%)
    // Нижній: сума після знижки (284 грн)
    td.innerHTML = `
      <div class="sum-full-price">
        ${fullAmount.toLocaleString("uk-UA")}<sup class="discount-percent">-${discountPercent}%</sup>
      </div>
      <div class="sum-discounted-price">${discountedAmount.toLocaleString("uk-UA")} грн</div>
    `;
  } else {
    // Без знижки - звичайний вивід
    td.innerHTML = `${fullAmount.toLocaleString("uk-UA")} грн`;
  }

  td.addEventListener("dblclick", async () => {
    const canOpen = await canUserOpenActs();
    if (canOpen) {
      showModal(actId, "other");
    } else {
      showNoAccessNotification();
    }
  });

  return td;
}

function createStandardCell(
  content: string,
  act: any,
  actId: number,
  isActNumberCell: boolean = false,
): HTMLTableCellElement {
  const td = document.createElement("td");
  td.classList.add("act-table-cell");
  td.setAttribute("data-act-id", String(actId));

  if (isActNumberCell) {
    // Робимо комірку позиціонованою для абсолютного позиціонування бейджа
    td.style.position = "relative";

    // 1. ЗВЕРХУ: ОУ-123 / 01.12.24 малим темно-помаранчевим
    if (act.contrAgent_act && act.contrAgent_act_data) {
      const actNum = act.contrAgent_act;
      const actDateFormatted = convertISOtoShortDate(act.contrAgent_act_data);

      if (actDateFormatted) {
        const actLabel = document.createElement("div");
        actLabel.classList.add("act-label-small");
        actLabel.textContent = `ОУ-${actNum} / ${actDateFormatted}`;
        td.appendChild(actLabel);
      }
    }

    // 2. ПОСЕРЕДИНІ: 🗝️ 1234 нормальним розміром
    const mainNumber = document.createElement("div");
    mainNumber.classList.add("act-number-main");
    mainNumber.setAttribute("data-act-id", String(actId));
    mainNumber.innerHTML = content;
    td.appendChild(mainNumber);

    // 3. ЗНИЗУ: СФ-123 / 15.12.24 малим темно-помаранчевим
    if (act.contrAgent_raxunok && act.contrAgent_raxunok_data) {
      const raxunokNum = act.contrAgent_raxunok;
      const raxunokDateFormatted = convertISOtoShortDate(
        act.contrAgent_raxunok_data,
      );

      if (raxunokDateFormatted) {
        const raxunokLabel = document.createElement("div");
        raxunokLabel.classList.add("raxunok-label-small");
        raxunokLabel.textContent = `СФ-${raxunokNum} / ${raxunokDateFormatted}`;
        td.appendChild(raxunokLabel);
      }
    }

    // 4. БЕЙДЖ З КІЛЬКІСТЮ ПОВІДОМЛЕНЬ (правий верхній кут)
    const notificationCount = actNotificationCounts.get(actId) || 0;
    if (notificationCount > 0) {
      const badge = document.createElement("div");
      badge.className = "notification-count-badge";
      badge.textContent = notificationCount.toString();
      td.appendChild(badge);
    }
  } else {
    td.innerHTML = content;
  }

  td.addEventListener("dblclick", async () => {
    const canOpen = await canUserOpenActs();
    if (canOpen) {
      showModal(actId, "other");
    } else {
      showNoAccessNotification();
    }
  });

  return td;
}

function showNoAccessNotification(): void {
  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #ff5722;
    color: white;
    padding: 15px 25px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10001;
    font-size: 16px;
    animation: slideIn 0.3s ease;
  `;
  notification.textContent = "🔒 У вас немає доступу до перегляду актів";
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

// =============================================================================
// РЕНДЕРИНГ РЯДКІВ
// =============================================================================

/**
 * 🦴 Рендерить скелетон-рядки для імітації завантаження
 */
function renderSkeletonRows(
  tbody: HTMLTableSectionElement,
  count: number = 12,
  showSuma: boolean = true,
): void {
  tbody.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const row = document.createElement("tr");
    row.className = "skeleton-row";

    const cols = showSuma ? 5 : 4;
    for (let j = 0; j < cols; j++) {
      const td = document.createElement("td");
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton-cell";

      // Різна ширина для реалістичності
      if (j === 0) skeleton.style.width = "40px"; // №
      if (j === 1) skeleton.style.width = "80px"; // Дата
      if (j === 2) skeleton.style.width = "70%"; // Клієнт
      if (j === 3) skeleton.style.width = "60%"; // Авто

      td.appendChild(skeleton);
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
}

function createActTableRow(
  act: any,
  index: number,
  clients: any[],
  cars: any[],
  modifiedActIds: Set<number>,
  showSumaColumn: boolean = true,
): HTMLTableRowElement {
  const isClosed = isActClosed(act);
  const isFrozen = isActFrozen(act);
  const lockIcon = isFrozen ? "❄️" : isClosed ? "🔒" : "🗝️";
  const clientInfo = getClientInfo(act, clients);
  const carInfo = getCarInfo(act, cars);
  const row = document.createElement("tr");
  row.setAttribute("data-act-id", String(act.act_id));

  // ✨ Ефект появи рядків (тільки для перших 40, щоб не навантажувати)
  row.classList.add("fade-in-row");
  if (index < 40) {
    row.style.animationDelay = `${index * 0.03}s`;
  }

  row.classList.add(isClosed ? "row-closed" : "row-open");

  // ❄️ Frozen row styling
  if (isFrozen) {
    row.classList.add("row-frozen");
    row.title = "Розморозити акт?";
  }

  // 💛 ПЕРЕВІРКА slusarsOn ДЛЯ ЗОЛОТИСТОГО ФАРБУВАННЯ (ТІЛЬКИ ДЛЯ ВІДКРИТИХ АКТІВ)
  // ✨ Для Приймальника показувати тільки якщо pruimalnyk === currentUserName
  const shouldShowSlusarsOn =
    act.slusarsOn === true &&
    !isClosed &&
    !isFrozen &&
    (userAccessLevel === "Адміністратор" ||
      userAccessLevel === "Слюсар" ||
      (userAccessLevel === "Приймальник" &&
        act.pruimalnyk === currentUserName));

  if (shouldShowSlusarsOn) {
    row.classList.add("row-slusar-on");
  }

  // ПЕРЕВІРКА ПІДСВІТКИ (СИНЯ РУЧКА)
  if (act.act_id && modifiedActIds.has(Number(act.act_id))) {
    row.classList.add("act-modified-blue-pen");
  }

  // Комірка № акту
  row.appendChild(
    createStandardCell(
      `${lockIcon} ${act.act_id?.toString() || "N/A"}`,
      act,
      act.act_id,
      true,
    ),
  );
  row.appendChild(createDateCell(act, act.act_id));
  row.appendChild(createClientCell(clientInfo, act.act_id, act));
  row.appendChild(createCarCell(carInfo, act.act_id));

  // ✅ Показуємо "Сума" тільки якщо showSumaColumn = true
  if (showSumaColumn) {
    row.appendChild(createSumCell(act, act.act_id));
  }

  return row;
}

function renderActsRows(
  acts: any[],
  clients: any[],
  cars: any[],
  tbody: HTMLTableSectionElement,
  _accessLevel: string | null,
  modifiedActIds: Set<number>,
  showSumaColumn: boolean = true,
): void {
  tbody.innerHTML = "";

  acts.forEach((act, index) => {
    tbody.appendChild(
      createActTableRow(
        act,
        index,
        clients,
        cars,
        modifiedActIds,
        showSumaColumn,
      ),
    );
  });
}

// =============================================================================
// СОРТУВАННЯ ТА ФІЛЬТРАЦІЯ
// =============================================================================

function sortActs(): void {
  if (activeActPage) {
    activeActSort = sortByDateStep === 0 ? "open" : "created";sortByDateStep = sortByDateStep === 0 ? 1 : 0;
    const { input } = activeActPage;void loadActsTable(input.from,input.to,input.mode,input.query,false);return;
  }
  if (sortByDateStep === 0) {
    actsGlobal.sort((a, b) => {
      const aOpen = !isActClosed(a);
      const bOpen = !isActClosed(b);
      if (aOpen && !bOpen) return -1;
      if (!aOpen && bOpen) return 1;
      return 0;
    });
    sortByDateStep = 1;
  } else {
    actsGlobal.sort(
      (a, b) =>
        (getActDateAsDate(b)?.getTime() || 0) -
        (getActDateAsDate(a)?.getTime() || 0),
    );
    sortByDateStep = 0;
  }
}

/**
 * 📅 Сортування закритих актів по даті закриття (date_off) від нових до старих
 */
function sortActsByClosingDate(): void {
  if (activeActPage) {
    activeActSort = sortByClosingDateStep === 0 ? "closed" : "created";sortByClosingDateStep = sortByClosingDateStep === 0 ? 1 : 0;
    const { input } = activeActPage;void loadActsTable(input.from,input.to,input.mode,input.query,false);return;
  }
  if (sortByClosingDateStep === 0) {
    // Спочатку закриті, потім відкриті; закриті сортуємо по date_off від нових до старих
    actsGlobal.sort((a, b) => {
      const aClosed = isActClosed(a);
      const bClosed = isActClosed(b);

      // Закриті акти йдуть першими
      if (aClosed && !bClosed) return -1;
      if (!aClosed && bClosed) return 1;

      // Якщо обидва закриті - сортуємо по date_off від нових до старих
      if (aClosed && bClosed) {
        const aDateOff = a.date_off ? new Date(a.date_off).getTime() : 0;
        const bDateOff = b.date_off ? new Date(b.date_off).getTime() : 0;
        return bDateOff - aDateOff; // Нові першими
      }

      // Якщо обидва відкриті - сортуємо по date_on від нових до старих
      const aDateOn = a.date_on ? new Date(a.date_on).getTime() : 0;
      const bDateOn = b.date_on ? new Date(b.date_on).getTime() : 0;
      return bDateOn - aDateOn;
    });
    sortByClosingDateStep = 1;
  } else {
    // Повертаємо до звичайного сортування (по date_on від нових до старих)
    actsGlobal.sort(
      (a, b) =>
        (getActDateAsDate(b)?.getTime() || 0) -
        (getActDateAsDate(a)?.getTime() || 0),
    );
    sortByClosingDateStep = 0;
  }
}

function getDefaultDateRange(): string {
  const today = new Date();
  const lastMonth = new Date(
    today.getFullYear(),
    today.getMonth() - 1,
    today.getDate(),
  );
  return `${formatDate(lastMonth)} - ${formatDate(today)}`;
}

function getDateRange(): { dateFrom: string; dateTo: string } | null {
  const input = document.getElementById("dateRangePicker") as HTMLInputElement;
  const dateRangeValue = input?.value?.trim();
  if (!dateRangeValue) {
    input.value = getDefaultDateRange();
  }
  const currentValue = input.value.trim();
  if (
    currentValue === "Відкриті" ||
    currentValue === "Закриті" ||
    currentValue.includes("Заморожені")
  )
    return null;
  if (!currentValue.includes(" - ")) return null;

  const [startStr, endStr] = currentValue.split(" - ");
  if (!validateDateFormat(startStr) || !validateDateFormat(endStr)) return null;

  try {
    const [dateFrom, dateTo] = [startStr, endStr].map((str, i) => {
      const [d, m, y] = str.split(".");
      const fullYear = y.length === 2 ? `20${y}` : y;
      const full = `${fullYear}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      return i === 0 ? `${full} 00:00:00` : `${full} 23:59:59`;
    });
    return { dateFrom, dateTo };
  } catch {
    return null;
  }
}

function filterActs(
  acts: any[],
  searchTerm: string,
  clients: any[],
  cars: any[],
): any[] {
  if (!searchTerm) {
    updateSmartSearchHint("");
    return acts;
  }

  // 🔍 Спочатку пробуємо розумний пошук
  const smartFilters = parseSmartSearch(searchTerm);

  if (smartFilters.length > 0) {
    // Показуємо підказку що розпізнано
    const hint = getSmartSearchHint(smartFilters);
    updateSmartSearchHint(hint);

    return applySmartFilters(acts, smartFilters, clients, cars, {
      safeParseJSON,
      getClientInfo,
      getCarInfo,
      getActAmount,
      getActDateAsDate,
      isActClosed,
      getActDiscount,
    });
  }

  // Fallback: старий key:value парсер
  updateSmartSearchHint("");
  const filters = parseSearchTerm(searchTerm);

  return acts.filter((act) => {
    const clientInfo = getClientInfo(act, clients);
    const carInfo = getCarInfo(act, cars);
    const actDate = getActDateAsDate(act);
    const formattedDate = actDate ? formatDate(actDate) : "";
    const amount = getActAmount(act);
    const raxunokNum = act.contrAgent_raxunok || "";
    const actNum = act.contrAgent_act || "";

    return filters.every((filter) => {
      const searchValue = filter.value.toUpperCase();
      if (searchValue.startsWith("СФ-")) {
        const numPart = searchValue.replace("СФ-", "").trim();
        return !numPart ? raxunokNum : raxunokNum.toString().includes(numPart);
      }
      if (searchValue.startsWith("ОУ-")) {
        const numPart = searchValue.replace("ОУ-", "").trim();
        return !numPart ? actNum : actNum.toString().includes(numPart);
      }
      switch (filter.key.toLowerCase()) {
        case "акт":
          return act.act_id?.toString().includes(filter.value);
        case "сума":
          return amount >= parseFloat(filter.value);
        case "дата":
          return formattedDate.includes(filter.value);
        case "тел":
        case "телефон":
          return clientInfo.phone.includes(filter.value);
        case "піб":
          return clientInfo.pib
            .toLowerCase()
            .includes(filter.value.toLowerCase());
        case "машина":
          return carInfo.name
            .toLowerCase()
            .includes(filter.value.toLowerCase());
        case "номер":
          return carInfo.number.includes(filter.value);
        default: {
          const val = filter.value.toLowerCase();
          // Основні поля
          if (
            clientInfo.pib.toLowerCase().includes(val) ||
            clientInfo.phone.includes(filter.value) ||
            carInfo.number.includes(filter.value) ||
            carInfo.name.toLowerCase().includes(val) ||
            act.act_id?.toString().includes(filter.value) ||
            formattedDate.includes(filter.value) ||
            amount.toString().includes(filter.value) ||
            raxunokNum.toString().includes(filter.value) ||
            actNum.toString().includes(filter.value)
          )
            return true;
          // Роботи, деталі, рекомендації, причина звернення
          const actData = safeParseJSON(act.info || act.data || act.details);
          const works = Array.isArray(actData?.["Роботи"])
            ? actData["Роботи"]
            : [];
          const details = Array.isArray(actData?.["Деталі"])
            ? actData["Деталі"]
            : [];
          if (
            works.some((w: any) =>
              (w["Робота"] || w["Назва"] || "").toLowerCase().includes(val),
            )
          )
            return true;
          if (
            details.some((d: any) =>
              (d["Деталь"] || d["Назва"] || "").toLowerCase().includes(val),
            )
          )
            return true;
          if ((actData?.["Рекомендації"] || "").toLowerCase().includes(val))
            return true;
          if (
            (actData?.["Причина звернення"] || "").toLowerCase().includes(val)
          )
            return true;
          if ((actData?.["Примітки"] || "").toLowerCase().includes(val))
            return true;
          // Слюсар (в кожній роботі)
          if (
            works.some((w: any) =>
              (w["Слюсар"] || "").toLowerCase().includes(val),
            )
          )
            return true;
          // Приймальник
          if ((act.pruimalnyk || "").toLowerCase().includes(val)) return true;
          return false;
        }
      }
    });
  });
}

/** 🔍 Оновлює підказку розумного пошуку під полем вводу */
function updateSmartSearchHint(hint: string): void {
  let hintEl = document.getElementById("smart-search-hint");

  if (!hint) {
    if (hintEl) hintEl.style.display = "none";
    return;
  }

  if (!hintEl) {
    hintEl = document.createElement("div");
    hintEl.id = "smart-search-hint";
    hintEl.className = "smart-search-hint";
    // Вставляємо після searchInput
    const searchInput = document.getElementById("searchInput");
    if (searchInput?.parentElement) {
      searchInput.parentElement.style.position = "relative";
      searchInput.parentElement.appendChild(hintEl);
    } else {
      return;
    }
  }

  hintEl.textContent = `🔍 ${hint}`;
  hintEl.style.display = "block";
}

function parseSearchTerm(searchTerm: string): { key: string; value: string }[] {
  const filters: { key: string; value: string }[] = [];
  const parts = searchTerm.split(" ").filter((p) => p);
  parts.forEach((part) => {
    const [key, value] = part.split(":");
    if (key && value) filters.push({ key, value });
    else filters.push({ key: "", value: part });
  });
  return filters;
}

// =============================================================================
// ЗАВАНТАЖЕННЯ ДАНИХ
// =============================================================================

let tableLoadGeneration = 0;
let activeActPage: { input: ActSearchInput; page: ActSearchPage } | null = null;
let activeActSort: ActSearchSort = "id";
let stopActLazyLoading: (() => void) | null = null;

function renderActPageNavigation(container: HTMLElement, showSumaColumn = true): void {
  stopActLazyLoading?.();
  if (!activeActPage) return;
  const generation = tableLoadGeneration;
  let current = activeActPage;
  let busy = false;
  let stopped = false;
  const nav = document.createElement("div");
  nav.className = "act-lazy-loading";
  nav.style.cssText = "text-align:center;padding:16px;min-height:48px";
  nav.setAttribute("role", "status");
  const label = () => {
    nav.textContent = `Показано ${actsGlobal.length} із ${current.page.matched}`;
  };
  container.append(nav);
  label();
  const alive = () => !stopped && generation === tableLoadGeneration && nav.isConnected && isUserAuthenticated();
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void appendNext();
  });
  const observeThreshold = () => {
    const rows = container.querySelectorAll<HTMLTableRowElement>(":scope > table > tbody > tr[data-act-id]");
    // Row 45 of 50, then row 50 of 55: five rows remain before fetching five more.
    const threshold = rows[Math.max(0, rows.length - 6)];
    // Status changes can remove the last loaded row while more server rows
    // still match. Keep the existing five-row reader reachable in that case.
    observer.observe(threshold || nav);
  };
  const appendNext = async () => {
    if (!alive() || busy || !current.page.has_more || current.page.next_offset === null) return;
    busy = true;
    observer.disconnect();
    nav.textContent = "Завантаження актів…";
    try {
      const input: ActSearchInput = { ...current.input, offset: current.page.next_offset, limit: 5 };
      const page = await readActSearchPage(input, false);
      if (!alive()) return;
      const known = new Set(actsGlobal.map(act => Number(act.act_id)));
      const additions = page.items.filter(act => !known.has(Number(act.act_id)));
      const counts = await fetchActNotificationCounts(additions.map(act => Number(act.act_id)));
      if (!alive()) return;
      const tbody = container.querySelector("table > tbody");
      if (!tbody) return;
      const merge = (old: any[], fresh: any[], key: string) =>
        [...new Map([...old, ...fresh].map(row => [String(row[key]), row])).values()];
      clientsGlobal = merge(clientsGlobal, page.clients, "client_id");
      carsGlobal = merge(carsGlobal, page.cars, "cars_id");
      counts.forEach((count, id) => { actNotificationCounts.set(id, count); modifiedActIdsGlobal.add(id); });
      const firstIndex = actsGlobal.length;
      actsGlobal.push(...additions);
      additions.forEach((act, index) => tbody.appendChild(createActTableRow(
        act, firstIndex + index, clientsGlobal, carsGlobal, modifiedActIdsGlobal, showSumaColumn,
      )));
      current = { input, page };
      activeActPage = current;
      container.dataset.actTotal = String(page.matched);
      updateActSearchSummary(input.query, page.matched, page.total);
      refreshActCounters();
      label();
      if (page.has_more) observeThreshold();
    } catch (error) {
      if (!alive()) return;
      nav.textContent = "Не вдалося підвантажити акти. ";
      const retry = document.createElement("button");
      retry.type = "button"; retry.textContent = "Повторити";
      retry.onclick = () => void appendNext();
      nav.append(retry);
      console.error("Act lazy loading failed", error);
    } finally { busy = false; }
  };
  stopActLazyLoading = () => { stopped = true; observer.disconnect(); nav.remove(); };
  if (current.page.has_more) observeThreshold();
}

function mergeCarsIntoGlobal(cars: any[]): void {
  for (const car of cars) {
    const carId = normalizeRecordId(car?.cars_id);
    if (carId === null) continue;

    const existingIndex = carsGlobal.findIndex(
      (existingCar) => normalizeRecordId(existingCar?.cars_id) === carId,
    );

    if (existingIndex >= 0) {
      carsGlobal[existingIndex] = car;
    } else {
      carsGlobal.push(car);
    }
  }
}

// =============================================================================
// СТВОРЕННЯ ТАБЛИЦІ
// =============================================================================

function createTableHeader(
  _accessLevel: string | null,
  showSumaColumn: boolean = true,
): HTMLTableSectionElement {
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  // 📋 Заголовки з емодзі для мобільного відображення
  const headerConfig: { text: string; emoji: string }[] = [
    { text: "№ акту", emoji: "📋" },
    { text: "Дата", emoji: "📅" },
    { text: "Клієнт", emoji: "👤" },
    { text: "Автомобіль", emoji: "🚗" },
  ];
  // ✅ Показуємо "Сума" тільки якщо showSumaColumn = true
  if (showSumaColumn) headerConfig.push({ text: "Сума", emoji: "💲" });

  // Колір шапки з налаштувань
  const tableColor = globalCache.generalSettings?.tableColor || "#177245";

  headerConfig.forEach(({ text, emoji }) => {
    const th = document.createElement("th");
    th.style.backgroundColor = tableColor;
    th.style.color = "#fff";

    // Емодзі (видимий на мобільних)
    const emojiSpan = document.createElement("span");
    emojiSpan.className = "th-emoji";
    emojiSpan.textContent = emoji;

    // Текст (ховається на мобільних)
    const textSpan = document.createElement("span");
    textSpan.className = "th-text";
    textSpan.textContent = text;

    th.appendChild(emojiSpan);
    th.appendChild(textSpan);

    if (text.includes("Клієнт")) {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        sortActs();
        if (!activeActPage) updateTableBody();
        // Оновлюємо індикатор в заголовку
        textSpan.textContent = sortByDateStep === 1 ? "Клієнт 🔽" : "Клієнт";
      });
    }
    // 📅 Фільтр по даті закриття - клік на заголовок "Дата"
    if (text === "Дата") {
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        sortActsByClosingDate();
        if (!activeActPage) updateTableBody();
        // Оновлюємо індикатор в заголовку
        textSpan.textContent =
          sortByClosingDateStep === 1 ? "Дата 🔽" : "Дата";
      });
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  return thead;
}

function updateTableBody(): void {
  const table = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!table) return;

  // ✅ Перевіряємо чи є стовпець "Сума" в заголовку таблиці
  const headers = table.querySelectorAll("thead th");
  const showSumaColumn = Array.from(headers).some((th) =>
    th.textContent?.includes("Сума"),
  );

  const newTbody = document.createElement("tbody");
  renderActsRows(
    actsGlobal,
    clientsGlobal,
    carsGlobal,
    newTbody,
    userAccessLevel,
    modifiedActIdsGlobal,
    showSumaColumn,
  );
  const oldTbody = table.querySelector("tbody");
  if (oldTbody) oldTbody.replaceWith(newTbody);
  refreshActCounters();
}

const rowRefreshVersions = new Map<number, number>();
let rowRefreshSerial = 0;

/** Local client/car receipts contain only confirmed form fields. Repaint the
 * affected visible labels without re-reading acts, wages, or the whole list. */
let labelWriteSerial = 0;
let labelWriteOwner = "";
const labelWrites = new Map<string, { version: number; patch: any }>();
let labelSearchRefreshQueued = false;
function preserveNewerLabelWrite(kind: "client" | "car", row: any, started: number): any {
  const saved = labelWrites.get(`${kind}:${row[kind === "client" ? "client_id" : "cars_id"]}`);
  return saved && saved.version > started ? { ...row, data: { ...safeParseJSON(row.data), ...saved.patch } } : row;
}
function refreshLabelDependentSearch(): void {
  const input = activeActPage?.input;
  if (!input?.query.trim() || labelSearchRefreshQueued) return;
  const predicates = parseSmartSearch(input.query);
  if (predicates.length && !predicates.some(filter => ["pib", "phone", "car", "carNumber", "text"].includes(filter.type))) return;
  const generation = tableLoadGeneration, owner = localStorage.getItem("userAuthData");
  labelSearchRefreshQueued = true;
  // Both client and car receipts from one save share one bounded search refresh.
  void Promise.resolve().then(async () => {
    labelSearchRefreshQueued = false;
    if (generation !== tableLoadGeneration || owner !== localStorage.getItem("userAuthData") || activeActPage?.input !== input) return;
    await loadActsTable(input.from, input.to, input.mode, input.query, false, 0);
  });
}
function applyClientCarLabels(kind: "client" | "car", detail: any, refreshSearch = true): void {
  if (!isUserAuthenticated()) return;
  const idKey = kind === "client" ? "client_id" : "cars_id";
  const id = normalizeRecordId(kind === "client" ? detail?.clientId : detail?.carId);
  if (id === null || !detail?.patch || typeof detail.patch !== "object") return;
  const owner = localStorage.getItem("userAuthData") || "";
  if (labelWriteOwner !== owner) { labelWrites.clear(); labelWriteOwner = owner; }
  const labelKey = `${kind}:${id}`;
  labelWrites.delete(labelKey);labelWrites.set(labelKey, { version: ++labelWriteSerial, patch: detail.patch });
  while (labelWrites.size > 1000) labelWrites.delete(labelWrites.keys().next().value!);
  const rows = kind === "client" ? clientsGlobal : carsGlobal;
  const existing = rows.find(row => normalizeRecordId(row[idKey]) === id);
  const previousData = safeParseJSON(existing?.data);
  const changed = !existing || Object.keys(detail.patch).some(key => JSON.stringify(previousData[key]) !== JSON.stringify(detail.patch[key]));
  if (existing) existing.data = { ...safeParseJSON(existing.data), ...detail.patch };
  else rows.push({ [idKey]: id, data: { ...detail.patch } });
  const table = document.querySelector("#table-container-modal-sakaz_narad table");
  if (!table) return;
  const showSuma = Array.from(table.querySelectorAll("thead th")).some(th => th.textContent?.includes("Сума"));
  actsGlobal.forEach((act, index) => {
    if (normalizeRecordId(act[idKey]) !== id) return;
    for (const row of findActRowsInTable(table, Number(act.act_id))) {
      const replacement = createActTableRow(act, index, clientsGlobal, carsGlobal, modifiedActIdsGlobal, showSuma);
      replacement.classList.remove("fade-in-row");
      row.replaceWith(replacement);
    }
  });
  if (refreshSearch && changed) refreshLabelDependentSearch();
}
window.addEventListener("sto:client-saved", event => applyClientCarLabels("client", (event as CustomEvent).detail));
window.addEventListener("sto:car-saved", event => applyClientCarLabels("car", (event as CustomEvent).detail));

const createdActReceipts = new Set<number>();
let createdActReceiptOwner = "";
/** A new act's write receipt already contains the full empty-act projection. */
async function applyCreatedActReceipt(detail: any): Promise<void> {
  const act = detail?.record;
  const id = normalizeRecordId(act?.act_id);
  if (!detail?.created || id === null || !isUserAuthenticated() || !activeActPage) return;
  const owner = localStorage.getItem("userAuthData") || "";
  if (createdActReceiptOwner !== owner) { createdActReceipts.clear(); createdActReceiptOwner = owner; }
  if (createdActReceipts.has(id) || actsGlobal.some(row => Number(row.act_id) === id)) return;
  const container = document.getElementById("table-container-modal-sakaz_narad");
  if (!container || statusPageOwner !== owner || statusPageGeneration !== tableLoadGeneration) return;
  const generation = tableLoadGeneration;
  stopActLazyLoading?.();
  createdActReceipts.add(id);
  while (createdActReceipts.size > 500) createdActReceipts.delete(createdActReceipts.values().next().value!);
  const client = detail.client;
  const car = detail.car;
  if (client?.data && Number(client.client_id) === Number(act.client_id)) {
    applyClientCarLabels("client", { clientId: client.client_id, patch: client.data }, false);
  }
  if (car?.data && Number(car.cars_id) === Number(act.cars_id)) {
    applyClientCarLabels("car", { carId: car.cars_id, patch: car.data }, false);
  }
  try {
    const labels = await loadStatusRowLabels(act);
    if (generation !== tableLoadGeneration || owner !== localStorage.getItem("userAuthData") || !activeActPage) return;
    clientsGlobal.push(...labels.clients);mergeCarsIntoGlobal(labels.cars);
    if (actsGlobal.some(row => Number(row.act_id) === id)) return;
    const { input, page } = activeActPage;
    const inRange = actMatchesPageRange(act, input);
    // A creation receipt includes the full initial work/detail arrays, so the
    // normal filter can evaluate it without downloading a broad report.
    const matches = inRange && filterActs([act], input.query, clientsGlobal, carsGlobal).length > 0;
    if (inRange) page.total++;
    if (matches) page.matched++;
    container.dataset.actTotal = String(page.matched);
    updateActSearchSummary(input.query, page.matched, page.total);
    const boundary = actsGlobal[actsGlobal.length - 1];
    if (matches && (!page.has_more || !boundary || compareActsInPage(act, boundary, input.sort) <= 0)) {
      // The initial load shares page.items and actsGlobal. Replace both arrays
      // independently so one confirmed creation is never appended twice.
      actsGlobal = [...actsGlobal, act].sort((a, b) => compareActsInPage(a, b, input.sort));
      page.items = [...page.items.filter(row => Number(row.act_id) !== id), act];
      if (page.next_offset !== null) page.next_offset++;
      const table = container.querySelector("table");
      const showSuma = table ? Array.from(table.querySelectorAll("thead th")).some(th => th.textContent?.includes("Сума")) : statusPageShowSuma;
      if (!table) { container.innerHTML = "";container.appendChild(createTable(userAccessLevel, showSuma)); }
      else {
        const index = actsGlobal.findIndex(row => Number(row.act_id) === id);
        const row = createActTableRow(act, index, clientsGlobal, carsGlobal, modifiedActIdsGlobal, showSuma);
        const following = actsGlobal[index + 1];
        table.querySelector("tbody")?.insertBefore(row, following ? findActRowsInTable(table, Number(following.act_id))[0] || null : null);
      }
      rememberStatusRecord(id, act, true);
    }
    renderActPageNavigation(container, statusPageShowSuma);
    refreshActCounters();
  } catch {
    createdActReceipts.delete(id);
    showAppMessage("Акт створено. Для оновлення його рядка повторіть пошук у таблиці.", "warning");
  }
}
window.addEventListener("sto:act-saved", event => { void applyCreatedActReceipt((event as CustomEvent).detail); });

export interface ActTableStatus {
  date_off: string | null;
  slusarsOn?: boolean;
  frozen?: boolean;
  data?: any;
  date_on?: string | null;
  pruimalnyk?: string | null;
}

let statusPageGeneration = -1;
let statusPageOwner = "";
let statusPageShowSuma = true;
const statusRecords = new Map<number, { record: any; nonStatusMatch?: boolean }>();
const pendingStatusRecords = new Map<number, { record: any; previous?: any }>();

/** Confirmed status writes reuse the displayed act and its client/car projections. */
export function applyActStatusToTable(actId: number, status: ActTableStatus): void {
  applyActStatusRecord({ ...status, act_id: actId });
}

function actMatchesPageRange(act: any, input: ActSearchInput): boolean {
  const closed = act.date_off !== null && act.date_off !== undefined;
  const frozen = isActFrozen(act);
  if (input.mode === "open") return !closed && !frozen;
  if (input.mode === "closed") return closed && !frozen;
  if (input.mode === "frozen") return frozen;
  const created = Date.parse(act.date_on);
  return !!input.from && !!input.to && Number.isFinite(created) &&
    created >= Date.parse(input.from) && created <= Date.parse(input.to);
}

function compareActsInPage(a: any, b: any, sort: ActSearchSort): number {
  const aClosed = a.date_off !== null && a.date_off !== undefined;
  const bClosed = b.date_off !== null && b.date_off !== undefined;
  if (sort === "open" && aClosed !== bClosed) return Number(aClosed) - Number(bClosed);
  if (sort === "closed" && aClosed !== bClosed) return Number(bClosed) - Number(aClosed);
  if (sort === "closed" || sort === "created") {
    const time = (act: any) => Date.parse((sort === "closed" ? act.date_off : null) || act.date_on || "1970-01-01") || 0;
    const difference = time(b) - time(a);
    if (difference) return difference;
  }
  return Number(b.act_id) - Number(a.act_id);
}

function statusSearchMatches(act: any, input: ActSearchInput, nonStatusMatch: boolean): boolean {
  // Work/detail/employee predicates already matched on the server. The compact
  // page deliberately omits those arrays, so never re-evaluate them on it.
  return nonStatusMatch && parseSmartSearch(input.query).every(filter =>
    filter.type !== "status" || !["open", "closed"].includes(filter.value) ||
    (filter.value === "closed" ? !!isActClosed(act) : !isActClosed(act)));
}

function rememberStatusRecord(actId: number, record: any, nonStatusMatch?: boolean): void {
  statusRecords.delete(actId);
  statusRecords.set(actId, { record, nonStatusMatch });
  while (statusRecords.size > 5000) statusRecords.delete(statusRecords.keys().next().value!);
}

function finishActStatusPageLoad(): void {
  const queued = [...pendingStatusRecords.values()];
  pendingStatusRecords.clear();
  for (const { record, previous } of queued) applyActStatusRecord(record, previous);
}

/** Only missing display labels for an entering row, never client/car history. */
async function loadStatusRowLabels(act: any): Promise<{ clients: any[]; cars: any[] }> {
  const clientId = act.client_id == null ? null : normalizeRecordId(act.client_id);
  const carId = act.cars_id == null ? null : normalizeRecordId(act.cars_id);
  const clientMissing = clientId !== null && !clientsGlobal.some(row => normalizeRecordId(row.client_id) === clientId);
  const carMissing = carId !== null && !carsGlobal.some(row => normalizeRecordId(row.cars_id) === carId);
  const carKeys = ["Номер авто", "Держ. номер", "plate", "number", "Авто", "Автомобіль", "auto", "car", "name", "Марка", "brand", "make", "Модель", "model"];
  const [clientResult, carResult] = await Promise.all([
    clientMissing ? supabase.from("clients").select('client_id,pib:data->>"ПІБ",phone:data->>"Телефон"').eq("client_id", clientId).maybeSingle() : null,
    carMissing ? supabase.from("cars").select(`cars_id,${carKeys.map((key, index) => `field_${index}:data->>"${key}"`).join(",")}`).eq("cars_id", carId).maybeSingle() : null,
  ]);
  if (clientResult?.error) throw clientResult.error;
  if (carResult?.error) throw carResult.error;
  const client = clientResult?.data as any;
  const car = carResult?.data as any;
  return {
    clients: client ? [{ client_id: client.client_id, data: { ПІБ: client.pib || "", Телефон: client.phone || "" } }] : [],
    cars: car ? [{ cars_id: car.cars_id, data: Object.fromEntries(carKeys.map((key, index) => [key, car[`field_${index}`]])) }] : [],
  };
}

function applyActStatusRecord(update: any, previousRecord?: any): void {
  const actId = Number(update?.act_id);
  if (!Number.isSafeInteger(actId) || !isUserAuthenticated()) return;
  const container = document.getElementById("table-container-modal-sakaz_narad");
  if (!container || !activeActPage) return;
  const owner = localStorage.getItem("userAuthData") || "";
  if (statusPageOwner !== owner) {
    statusRecords.clear(); pendingStatusRecords.clear(); return;
  }
  if (statusPageGeneration !== tableLoadGeneration) {
    pendingStatusRecords.set(actId, { record: update, previous: previousRecord });
    return;
  }
  const existingIndex = actsGlobal.findIndex(act => Number(act.act_id) === actId);
  const memo = statusRecords.get(actId);
  const existing = existingIndex >= 0 ? actsGlobal[existingIndex] : null;
  const hasOldStatus = previousRecord && Object.prototype.hasOwnProperty.call(previousRecord, "date_off") &&
    Object.prototype.hasOwnProperty.call(previousRecord, "data");
  const before = existing || memo?.record || (hasOldStatus ? previousRecord : null);
  const suppliedData = Object.prototype.hasOwnProperty.call(update, "data");
  const frozen = typeof update.frozen === "boolean" ? update.frozen : suppliedData ? isActFrozen(update) : isActFrozen(before);
  const next = { ...before, ...update, data: { ...safeParseJSON(before?.data), ...safeParseJSON(update.data), Заморожений: frozen } };
  // An UPDATE whose old record contains only its PK gives no evidence that an
  // unseen act entered or left this filter. Baseline it without inventing counts.
  if (!before) { rememberStatusRecord(actId, next); return; }
  const input = activeActPage.input;
  const nonStatusMatch = existing ? true : memo?.nonStatusMatch ?? (input.query.trim() ? undefined : true);
  const dateValue = (value: any) => value ? Date.parse(value) : null;
  if (dateValue(before.date_off) === dateValue(next.date_off) && isActFrozen(before) === frozen) {
    // Enrich an unseen/entering receipt from its full Realtime echo without
    // replacing its identity or cancelling a pending display-label request.
    if (!existing && memo) Object.assign(memo.record, next);
    return;
  }
  rememberStatusRecord(actId, next, nonStatusMatch);
  stopActLazyLoading?.();
  clearActSearchPages();
  // Invalidate a pending general row read which started before this receipt.
  rowRefreshVersions.set(actId, ++rowRefreshSerial);
  if (nonStatusMatch === undefined) { renderActPageNavigation(container, statusPageShowSuma); return; }
  const beforeRange = actMatchesPageRange(before, input);
  const nextRange = actMatchesPageRange(next, input);
  const beforeMatch = existing ? true : beforeRange && statusSearchMatches(before, input, nonStatusMatch);
  const nextMatch = nextRange && statusSearchMatches(next, input, nonStatusMatch);
  const page = activeActPage.page;
  page.total = Math.max(0, page.total + Number(nextRange) - Number(beforeRange));
  page.matched = Math.max(0, page.matched + Number(nextMatch) - Number(beforeMatch));
  page.total = Math.max(page.total, page.matched);
  container.dataset.actTotal = String(page.matched);
  updateActSearchSummary(input.query, page.matched, page.total);
  refreshActCounters();
  const boundary = actsGlobal[actsGlobal.length - 1];
  const shouldDisplay = nextMatch && (!page.has_more || !boundary || compareActsInPage(next, boundary, input.sort) <= 0);
  if (existingIndex < 0 && !shouldDisplay) { renderActPageNavigation(container, statusPageShowSuma); return; }
  const generation = tableLoadGeneration;
  const alive = () => generation === tableLoadGeneration && owner === localStorage.getItem("userAuthData") &&
    isUserAuthenticated() && statusRecords.get(actId)?.record === next;
  const render = () => {
    if (!alive()) return;
    stopActLazyLoading?.();
    const oldLength = actsGlobal.length;
    const table = container.querySelector("table");
    const oldRows = table ? findActRowsInTable(table, actId) : [];
    const hadFocus = oldRows.some(row => row.contains(document.activeElement));
    const retained = actsGlobal.filter(act => Number(act.act_id) !== actId);
    // Another append may have moved the loaded boundary while labels arrived.
    const latestBoundary = actsGlobal[actsGlobal.length - 1];
    const display = nextMatch && (!page.has_more || !latestBoundary || compareActsInPage(next, latestBoundary, input.sort) <= 0);
    if (display) retained.push(next);
    retained.sort((a, b) => compareActsInPage(a, b, input.sort));
    actsGlobal = retained;
    const offsetDelta = actsGlobal.length - oldLength;
    if (page.next_offset !== null) page.next_offset = Math.max(0, page.next_offset + offsetDelta);
    if (page.next_offset !== null && page.next_offset >= page.matched) { page.next_offset = null; page.has_more = false; }
    page.items = page.items.filter(act => Number(act.act_id) !== actId);
    if (display) page.items.push(next);
    oldRows.forEach(row => row.remove());
    const showSuma = table ? Array.from(table.querySelectorAll("thead th")).some(th => th.textContent?.includes("Сума")) : statusPageShowSuma;
    if (!table && display) {
      container.innerHTML = "";
      container.appendChild(createTable(userAccessLevel, showSuma));
    } else if (table && display) {
      const index = actsGlobal.findIndex(act => Number(act.act_id) === actId);
      const newRow = createActTableRow(next, index, clientsGlobal, carsGlobal, modifiedActIdsGlobal, showSuma);
      newRow.classList.remove("fade-in-row");
      const following = actsGlobal[index + 1];
      const anchor = following ? findActRowsInTable(table, Number(following.act_id))[0] : null;
      table.querySelector("tbody")?.insertBefore(newRow, anchor || null);
      if (hadFocus) { newRow.tabIndex = -1; newRow.focus({ preventScroll: true }); }
    }
    if (activeActPage) renderActPageNavigation(container, showSuma);
    refreshActCounters();
  };
  // A known row leaving and re-entering a filter retains its display labels.
  const needsLabels = shouldDisplay && (
    (next.client_id != null && normalizeRecordId(next.client_id) !== null && !clientsGlobal.some(row => normalizeRecordId(row.client_id) === normalizeRecordId(next.client_id))) ||
    (next.cars_id != null && normalizeRecordId(next.cars_id) !== null && !carsGlobal.some(row => normalizeRecordId(row.cars_id) === normalizeRecordId(next.cars_id))));
  if (!needsLabels) { render(); return; }
  void loadStatusRowLabels(next).then(labels => {
    if (!alive()) return;
    clientsGlobal.push(...labels.clients);
    mergeCarsIntoGlobal(labels.cars);
    render();
  }).catch(error => {
    // Keep the row and the paging boundary coherent even if a label is denied
    // or temporarily unavailable; its act ID/status remain usable.
    if (alive()) render();
    console.error("Не вдалося оновити назви для зміненого акта", actId, error);
  });
}

export async function refreshActRowInTable(actId: number): Promise<void> {
  clearActSearchPages();
  if (!isUserAuthenticated()) return;
  const container = document.getElementById("table-container-modal-sakaz_narad");
  const table = container?.querySelector("table");
  if (!container || !table || !findActRowsInTable(table, actId).length) return;
  const generation = tableLoadGeneration;
  const owner = localStorage.getItem("userAuthData");
  const labelsStarted = labelWriteSerial;
  const version = ++rowRefreshSerial;
  rowRefreshVersions.set(actId, version);
  const alive = () => generation === tableLoadGeneration && table.isConnected &&
    isUserAuthenticated() && owner === localStorage.getItem("userAuthData") && rowRefreshVersions.get(actId) === version;
  try {
    const input = activeActPage?.input;
    const query = input?.query ?? (document.getElementById("searchInput") as HTMLInputElement | null)?.value?.trim() ?? "";
    // Work/detail predicates stay on the server; this response contains no editor JSON.
    const { data: result, error } = await supabase.rpc("traffic_act_row", {
      p_act_id: actId, p_filters: serializeActSearch(query),
    });
    if (error) throw error;
    if (!result || !alive()) return;
    // A label edit may change membership even though the row response itself is compact.
    if (labelsStarted !== labelWriteSerial) { void refreshActRowInTable(actId); return; }
    if (Number(result.act?.act_id) !== actId || typeof result.matches !== "boolean" ||
        !Array.isArray(result.clients) || !Array.isArray(result.cars)) throw new Error("Некоректна відповідь оновлення акта.");
    const freshAct = result.act, freshClients = result.clients, freshCars = result.cars;
    const existingIndex = actsGlobal.findIndex(act => Number(act.act_id) === actId);
    const rows = findActRowsInTable(table, actId);
    if (existingIndex < 0 || !rows.length) return;
    for (const row of freshClients) {
      const client = preserveNewerLabelWrite("client", row, labelsStarted);
      const index = clientsGlobal.findIndex(row => normalizeRecordId(row.client_id) === normalizeRecordId(client.client_id));
      if (index < 0) clientsGlobal.push(client); else clientsGlobal[index] = client;
    }
    mergeCarsIntoGlobal(freshCars.map((row: any) => preserveNewerLabelWrite("car", row, labelsStarted)));
    const frozen = isActFrozen(freshAct);
    const closed = freshAct.date_off !== null && freshAct.date_off !== undefined;
    const created = Date.parse(freshAct.date_on);
    const matchesRange = !input ? true : input.mode === "open" ? !closed && !frozen :
      input.mode === "closed" ? closed && !frozen : input.mode === "frozen" ? frozen :
      !!input.from && !!input.to && Number.isFinite(created) && created >= Date.parse(input.from) && created <= Date.parse(input.to);
    const matches = matchesRange && result.matches;
    const showSumaColumn = Array.from(table.querySelectorAll("thead th")).some(th => th.textContent?.includes("Сума"));
    // Cancel any pending append before changing its offset or replacing its observed row.
    stopActLazyLoading?.();
    if (!matches) {
      actsGlobal.splice(existingIndex, 1);
      rows.forEach(row => row.remove());
      if (activeActPage) {
        const page = activeActPage.page;
        page.matched = Math.max(0, page.matched - 1);
        if (!matchesRange) page.total = Math.max(0, page.total - 1);
        if (page.next_offset !== null) page.next_offset = Math.max(0, page.next_offset - 1);
        page.items = page.items.filter(act => Number(act.act_id) !== actId);
        container.dataset.actTotal = String(page.matched);
        updateActSearchSummary(query, page.matched, page.total);
      }
    } else {
      actsGlobal[existingIndex] = freshAct;
      if (activeActPage) activeActPage.page.items = activeActPage.page.items.map(act => Number(act.act_id) === actId ? freshAct : act);
      rememberStatusRecord(actId, freshAct, true);
      const newRow = createActTableRow(freshAct, existingIndex, clientsGlobal, carsGlobal, modifiedActIdsGlobal, showSumaColumn);
      newRow.classList.remove("fade-in-row");
      const hadFocus = rows.some(row => row.contains(document.activeElement));
      rows[0].replaceWith(newRow);
      rows.slice(1).forEach(row => row.remove());
      if (hadFocus) { newRow.tabIndex = -1; newRow.focus({ preventScroll: true }); }
    }
    if (activeActPage) renderActPageNavigation(container, showSumaColumn);
    refreshActCounters();
  } catch (error) {
    console.error("Не вдалося оновити рядок акта", actId, error);
  } finally {
    if (rowRefreshVersions.get(actId) === version) rowRefreshVersions.delete(actId);
  }
}

function createTable(
  accessLevel: string | null,
  showSumaColumn: boolean = true,
): HTMLTableElement {
  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  const thead = createTableHeader(accessLevel, showSumaColumn);
  const tbody = document.createElement("tbody");
  renderActsRows(
    actsGlobal,
    clientsGlobal,
    carsGlobal,
    tbody,
    accessLevel,
    modifiedActIdsGlobal,
    showSumaColumn,
  );
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
}

function showNoDataMessage(message: string): void {
  const container = document.getElementById(
    "table-container-modal-sakaz_narad",
  );
  if (container) {
    container.innerHTML = `
      <div class="empty-state-container" style="text-align: center; padding: 60px 20px; color: #888; animation: postOverlayFadeIn 0.5s ease-out;">
        <div style="font-size: 80px; margin-bottom: 20px; opacity: 0.5;">🔍</div>
        <h3 style="margin-bottom: 10px; color: #555; font-size: 1.25rem; font-weight: 600;">Нічого не знайдено</h3>
        <p style="font-size: 14px; max-width: 300px; margin: 0 auto; line-height: 1.5;">${message}</p>
      </div>
    `;
  }
}

function showTableLoadError(message = "Не вдалося завантажити таблицю актів. Перевірте інтернет і оновіть сторінку."): void {
  hideActCounters();
  const container = document.getElementById(
    "table-container-modal-sakaz_narad",
  );
  if (!container) return;

  container.innerHTML = `<div style="text-align: center; padding: 56px 20px; color: #666;">
    <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
    <h3 style="margin: 0 0 10px; color: #444;">Таблиця не завантажилась</h3>
    <p style="font-size: 14px; max-width: 360px; margin: 0 auto 18px; line-height: 1.5;">${message}</p>
    <button id="actsLoadRetryBtn" style="background: #177245; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 16px;">Оновити</button>
  </div>`;

  document
    .getElementById("actsLoadRetryBtn")
    ?.addEventListener("click", () => initializeActsSystem());
}

function showAuthRequiredMessage(): void {
  hideActCounters();
  const container = document.getElementById(
    "table-container-modal-sakaz_narad",
  );
  if (container) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: #666;">
      <div style="font-size: 48px; margin-bottom: 20px;">🔐</div>
      <h3>Доступ обмежено</h3>
      <p>Для перегляду таблиці актів потрібна автентифікація</p>
      <button id="authRetryBtn" style="background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 16px; margin-top: 15px;">Увійти</button>
    </div>`;
    const retryBtn = document.getElementById("authRetryBtn");
    if (retryBtn)
      retryBtn.addEventListener("click", () => initializeActsSystem());
  }
}

function showNoViewAccessMessage(): void {
  hideActCounters();
  const container = document.getElementById(
    "table-container-modal-sakaz_narad",
  );
  if (container) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: #666;">
      <div style="font-size: 48px; margin-bottom: 20px;">🚫</div>
      <h3>Доступ заборонено</h3>
      <p>У вас немає прав на перегляд актів</p>
    </div>`;
  }
}

// Функція applyVerticalScrollbarCompensation видалена, оскільки вирівнювання тепер контролюється CSS (sticky header)

// =============================================================================
// ОСНОВНІ ФУНКЦІОНАЛЬНІ
// =============================================================================

export async function loadActsTable(
  dateFrom: string | null = null,
  dateTo: string | null = null,
  filterType: "open" | "closed" | "frozen" | null = null,
  searchTerm: string | null = null,
  reuseSearchSnapshot = false,
  pageOffset = 0,
): Promise<void> {
  // Shared act/client forms also call this on planner/accounting pages. Their
  // save must not download a main-page act list which has nowhere to render.
  const container = document.getElementById("table-container-modal-sakaz_narad");
  if (!container) return;
  const generation = ++tableLoadGeneration;
  stopActLazyLoading?.();
  stopActLazyLoading = null;
  if (!isUserAuthenticated()) {
    const accessLevel = await showLoginModalBeforeTable();
    if (!accessLevel) {
      showAuthRequiredMessage();
      return;
    }
  }

  const canView = await canUserViewActs();
  if (generation !== tableLoadGeneration) return;
  if (!canView) {
    showNoViewAccessMessage();
    return;
  }

  try {
    let finalDateFrom: string | null = null;
    hideActCounters();
    let finalDateTo: string | null = null;
    let finalFilterType: "open" | "closed" | "frozen" | null =
      filterType || null;
    const dateRangePicker = document.getElementById(
      "dateRangePicker",
    ) as HTMLInputElement;

    if (
      finalFilterType === "open" ||
      finalFilterType === "closed" ||
      finalFilterType === "frozen"
    ) {
      finalDateFrom = null;
      finalDateTo = null;
    } else {
      if (dateFrom && dateTo) {
        finalDateFrom = dateFrom;
        finalDateTo = dateTo;
      } else {
        const fallback = getDateRange();
        if (fallback) {
          finalDateFrom = fallback.dateFrom;
          finalDateTo = fallback.dateTo;
        } else {
          const currentValue = dateRangePicker?.value?.trim();
          if (currentValue === "Відкриті") finalFilterType = "open";
          else if (currentValue === "Закриті") finalFilterType = "closed";
          else {
            const defaultRange = getDefaultDateRange();
            const [startStr, endStr] = defaultRange.split(" - ");
            const [d1, m1, y1] = startStr.split(".");
            const [d2, m2, y2] = endStr.split(".");
            const fy1 = y1.length === 2 ? `20${y1}` : y1;
            const fy2 = y2.length === 2 ? `20${y2}` : y2;
            finalDateFrom = `${fy1}-${m1.padStart(2, "0")}-${d1.padStart(
              2,
              "0",
            )} 00:00:00`;
            finalDateTo = `${fy2}-${m2.padStart(2, "0")}-${d2.padStart(
              2,
              "0",
            )} 23:59:59`;
            if (dateRangePicker) dateRangePicker.value = defaultRange;
          }
        }
      }
    }

    // 🦴 Показуємо скелетон поки йде завантаження з БД
    const showSumaColumn = await canUserSeePriceColumns();
    if (generation !== tableLoadGeneration) return;
    if (container) {
      const skeletonTable = createTable(userAccessLevel, showSumaColumn);
      const skeletonTbody = skeletonTable.querySelector("tbody");
      if (skeletonTbody) renderSkeletonRows(skeletonTbody, 12, showSumaColumn);
      container.innerHTML = "";
      container.appendChild(skeletonTable);
    }

    const input: ActSearchInput = { from: finalDateFrom, to: finalDateTo, mode: finalFilterType,
      query: searchTerm ?? "", offset: pageOffset, sort: activeActSort };
    const page = await readActSearchPage(input,reuseSearchSnapshot);
    if (generation !== tableLoadGeneration || !isUserAuthenticated()) return;
    // A deletion can empty the old last page: return to the preceding existing page.
    if (pageOffset > 0 && !page.items.length && page.matched > 0) {
      await loadActsTable(finalDateFrom,finalDateTo,finalFilterType,searchTerm,false,Math.floor((page.matched-1)/50)*50);return;
    }
    const notificationCounts = await fetchActNotificationCounts(page.items.map(act => Number(act.act_id)));
    if (generation !== tableLoadGeneration || !isUserAuthenticated()) return;
    activeActPage = { input, page };
    statusRecords.clear();
    statusPageOwner = localStorage.getItem("userAuthData") || "";
    statusPageGeneration = generation;
    statusPageShowSuma = showSumaColumn;
    // These client/car projections must never replace full offline snapshots.
    clientsGlobal = page.clients;carsGlobal = page.cars;
    modifiedActIdsGlobal = new Set(notificationCounts.keys());actNotificationCounts = notificationCounts;
    actsGlobal = page.items;
    updateSmartSearchHint(getSmartSearchHint(parseSmartSearch(searchTerm ?? "")));
    updateActSearchSummary(searchTerm ?? "",page.matched,page.total);
    if (container) container.dataset.actTotal = String(page.matched);

    if (actsGlobal.length === 0) {
      showNoDataMessage("Немає актів у вказаному діапазоні.");
      refreshActCounters();
      finishActStatusPageLoad();
      return;
    }

    // ✅ Перевіряємо налаштування для приховування стовпця "Сума"
    const table = createTable(userAccessLevel, showSumaColumn);
    if (!container) return;

    // 🎬 Просто замінюємо skeleton на реальну таблицю з fade-in
    container.innerHTML = "";
    table.classList.add("table-fadein");
    container.appendChild(table);
    renderActPageNavigation(container, showSumaColumn);
    refreshActCounters();
    finishActStatusPageLoad();
  } catch (error) {
    console.error("💥 Критична помилка завантаження таблиці:", error);
    if (generation !== tableLoadGeneration) return;
    showTableLoadError();
  }
}

export async function refreshActsTable(): Promise<void> {
  if (!isUserAuthenticated()) return;
  const searchInput = document.getElementById(
    "searchInput",
  ) as HTMLInputElement;
  const currentSearchTerm = searchInput?.value?.trim() || "";
  const dateRangePicker = document.getElementById(
    "dateRangePicker",
  ) as HTMLInputElement;
  const currentValue = dateRangePicker?.value?.trim() || "";

  let currentFilterType: "open" | "closed" | "frozen" | null = null;
  let currentDateFrom: string | null = null;
  let currentDateTo: string | null = null;

  if (currentValue === "Відкриті") currentFilterType = "open";
  else if (currentValue === "Закриті") currentFilterType = "closed";
  else if (currentValue === "Заморожені ❄️") currentFilterType = "frozen";
  else {
    const dates = getDateRange();
    if (dates) {
      currentDateFrom = dates.dateFrom;
      currentDateTo = dates.dateTo;
    }
  }
  loadActsTable(
    currentDateFrom,
    currentDateTo,
    currentFilterType,
    currentSearchTerm,
  );
}

function resizeInput(input: HTMLInputElement): void {
  const tempSpan = document.createElement("span");
  tempSpan.style.visibility = "hidden";
  tempSpan.style.position = "absolute";
  tempSpan.style.whiteSpace = "pre";

  const computedStyle = window.getComputedStyle(input);
  tempSpan.style.font = computedStyle.font;
  tempSpan.style.fontSize = computedStyle.fontSize;
  tempSpan.style.fontWeight = computedStyle.fontWeight;
  tempSpan.style.fontFamily = computedStyle.fontFamily;
  tempSpan.style.letterSpacing = computedStyle.letterSpacing;

  tempSpan.textContent = input.value || input.placeholder || " ";
  document.body.appendChild(tempSpan);

  const width = tempSpan.offsetWidth;
  document.body.removeChild(tempSpan);

  input.style.width = `${width + 30}px`;
}

function watchDateRangeChanges(): void {
  const dateRangePicker = document.getElementById(
    "dateRangePicker",
  ) as HTMLInputElement;
  if (!dateRangePicker) return;

  // Початкове налаштування ширини
  resizeInput(dateRangePicker);

  let lastValue = dateRangePicker.value;
  const observer = new MutationObserver(() => {
    const currentValue = dateRangePicker.value;
    if (currentValue !== lastValue) {
      lastValue = currentValue;

      // Оновлюємо лише ширину при зміні значення (loadActsTable викликається явно в обробниках)
      resizeInput(dateRangePicker);
    }
  });

  observer.observe(dateRangePicker, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  // Додаткові слухачі подій для кращої реактивності
  dateRangePicker.addEventListener("input", () => resizeInput(dateRangePicker));
  dateRangePicker.addEventListener("change", () =>
    resizeInput(dateRangePicker),
  );

  window.addEventListener("beforeunload", () => observer.disconnect());
}

export async function initializeActsSystem(): Promise<void> {
  try {
    // 📦 Завантажуємо загальні налаштування:
    // - Якщо вже завантажено в цій сесії → просто беремо з localStorage
    // - Інакше (перезавантаження/новий вхід) → завантажуємо з БД і позначаємо прапором
    if (isGeneralSettingsLoadedThisSession()) {
      loadGeneralSettingsFromLocalStorage();
    } else {
      await loadGeneralSettingsFromDB();
      markGeneralSettingsAsLoaded();
    }

    const accessLevel = await showLoginModalBeforeTable();
    if (!accessLevel) {
      showAuthRequiredMessage();
      return;
    }
    const canView = await canUserViewActs();
    if (!canView) {
      showNoViewAccessMessage();
      return;
    }

    await loadActsTable(null, null, "open");

    // ✅ АКТИВУЄМО REALTIME ПІДПИСКУ
    subscribeToActNotifications();
    subscribeToSlusarNotifications();

    // ✏️ ПІДПИСКА НА ГЛОБАЛЬНУ ПРИСУТНІСТЬ (хто редагує акти)
    subscribeToGlobalActPresence();

    // 📥 ЗАВАНТАЖУЄМО ІСНУЮЧІ ПОВІДОМЛЕННЯ З БД
    if (accessLevel === "Адміністратор" || accessLevel === "Приймальник") {
      await loadAndShowExistingNotifications().catch(() => {
        unreadRecoveryNeeded = true;
        showAppMessage("Не вдалося завантажити повідомлення. Їх буде звірено після відновлення зв’язку.", "warning");
      });
    } else {
    }

    // 📞 ЗАСТОСОВУЄМО НАЛАШТУВАННЯ ВІДОБРАЖЕННЯ ТЕЛЕФОНУ
    await loadAndApplyPhoneIndicatorSetting();

    // 🎙️ ЗАСТОСОВУЄМО НАЛАШТУВАННЯ ГОЛОСОВОГО ВВЕДЕННЯ
    await loadAndApplyVoiceInputSetting();

    // 🤖 ЗАСТОСОВУЄМО НАЛАШТУВАННЯ ШІ АТЛАС
    await loadAndApplyAiProSetting();

    // 🌐 ЗАВАНТАЖУЄМО FAVICON
    await loadAndApplyFavicon();

    // 📱 ВІДКРИТТЯ АКТУ ПО QR-КОДУ (act_id або qr_token в URL)
    const urlParams = new URLSearchParams(window.location.search);
    const actIdFromUrl = urlParams.get("act_id");
    const qrTokenFromUrl = urlParams.get("qr_token");

    if (actIdFromUrl) {
      const actId = Number(actIdFromUrl);
      if (!isNaN(actId)) {
        setTimeout(() => {
          showModal(actId, "client");
        }, 800);
      }
    } else if (qrTokenFromUrl) {
      // 🔍 Пошук акту за qr_token у базі
      setTimeout(async () => {
        const { data: acts, error } = await supabase
          .from("acts")
          .select("act_id, data")
          .filter("data->>qr_token", "eq", qrTokenFromUrl);

        if (!error && acts && acts.length > 0) {
          showModal(acts[0].act_id, "client");
        }
      }, 800);
    }

    // 🤖 Гарантовано ініціалізуємо кнопку після завантаження налаштувань
    initAIChatButton();

    // ⚙️ REALTIME ПІДПИСКА НА ЗМІНИ НАЛАШТУВАНЬ
    subscribeToSettingsRealtime();

    watchDateRangeChanges();
  } catch (error) {
    // console.error("💥 Помилка ініціалізації:", error);
    showNoDataMessage("❌ Помилка");
  }
}

export { logoutFromSystemAndRedirect, isUserAuthenticated } from "./users";
