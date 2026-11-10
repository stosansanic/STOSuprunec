// ===== ФАЙЛ: src/ts/roboha/planyvannya/planyvannya_realtime.ts =====
// Realtime підписка на зміни в таблиці post_arxiv
// Автоматично оновлює календар планувальника для всіх підключених користувачів

import "../../../scss/robocha/planyvannya/_planyvannya_realtime.scss";
import { supabase } from "../../vxid/supabaseClient";
import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";
import { getPlannerRecord, publishPlannerChange, requestPlannerReconciliation } from "./plannerRecordStore";

let postArxivChannel: DatabaseSubscription | null = null;
let subscriptionWanted = false;
let subscriptionGeneration = 0;

// ── Toast-повідомлення про зміни ──

const TOAST_CONTAINER_ID = "planyvannya-realtime-toasts";
let toastAutoHideTimers: Map<string, number> = new Map();

function getOrCreateToastContainer(): HTMLElement {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = TOAST_CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Отримує ПІБ поточного користувача з localStorage
 */
function getCurrentUserName(): string | null {
  try {
    const stored = localStorage.getItem("userAuthData");
    if (!stored) return null;
    const data = JSON.parse(stored);
    return data.Name || null;
  } catch {
    return null;
  }
}

/**
 * Парсить ПІБ клієнта з поля client_id (формат: "ПІБ|||Телефон" або число)
 */
function parseClientName(clientId: string | number | null): string {
  if (!clientId) return "";
  const str = String(clientId);
  if (str.includes("|||")) return str.split("|||")[0] || "";
  return "";
}

/**
 * Парсить дані авто з поля cars_id (формат: "Модель|||Номер" або число)
 */
function parseCarInfo(carsId: string | number | null): string {
  if (!carsId) return "";
  const str = String(carsId);
  if (str.includes("|||")) {
    const parts = str.split("|||");
    return [parts[0], parts[1]].filter(Boolean).join(" ");
  }
  return "";
}

/**
 * Отримує ім'я слюсаря по ID з Supabase
 */
const staffNames = new Map<string, string>();
const staffPending = new Map<string, Promise<string>>();
let staffScope = "";

async function getSlyusarName(id: number | string): Promise<string> {
  const key = String(id || "");
  if (!/^\d+$/.test(key)) return "Невідомий";
  const scope = localStorage.getItem("userAuthData") || "";
  if (scope !== staffScope) { staffScope = scope; staffNames.clear(); staffPending.clear(); }
  const loadedName = (window as any).getPlannerStaffName?.(Number(key));
  if (typeof loadedName === "string" && loadedName.trim()) return loadedName.trim();
  // Both day and week row headers already contain the loaded name.
  const label = document.querySelector<HTMLElement>(
    '.post-unified-row[data-post-id="' + key + '"] .post-post-subtitle, .post-week-row[data-post-id="' + key + '"] .post-post-subtitle',
  )?.textContent?.replace(/^\s*👨‍🔧\s*/, "").trim();
  if (label) { staffNames.set(key, label); return label; }
  const known = staffNames.get(key);
  if (known) return known;
  const pending = staffPending.get(key);
  if (pending) return pending;
  const request = (async () => {
    try {
      const { data, error } = await supabase.from("slyusars")
        .select("name:data->>Name").eq("slyusar_id", key).maybeSingle();
      if (!error && data?.name && scope === (localStorage.getItem("userAuthData") || "")) {
        staffNames.set(key, data.name);
        while (staffNames.size > 500) staffNames.delete(staffNames.keys().next().value!);
        return data.name;
      }
    } catch { /* A label failure must not stop the calendar update. */ }
    return key;
  })();
  staffPending.set(key, request);
  try { return await request; }
  finally { if (staffPending.get(key) === request) staffPending.delete(key); }
}

const START_HOUR = 8;
function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60) + START_HOUR;
  const m = mins % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Показує toast-повідомлення про зміну в планувальнику
 */
async function showRealtimeToast(
  type: "insert" | "update" | "delete",
  record: any,
  oldRecord?: any,
): Promise<void> {
  const generation = subscriptionGeneration;
  const container = getOrCreateToastContainer();
  const toastId = `prt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  const icons: Record<string, string> = {
    insert: "📌",
    update: "✏️",
    delete: "🗑️",
  };
  const labels: Record<string, string> = {
    insert: "Нове бронювання",
    update: "Змінено бронювання",
    delete: "Видалено бронювання",
  };
  const colors: Record<string, string> = {
    insert: "#10b981",
    update: "#f59e0b",
    delete: "#ef4444",
  };

  const statusColors: Record<string, string> = {
    Запланований: "#e6a700",
    "В роботі": "#2e7d32",
    Відремонтований: "#757575",
    "Не приїхав": "#e53935",
  };

  let slyusarHtml = "";
  let timeHtml = "";
  let statusHtml = "";

  // Отримуємо поточні (нові) значення
  const newSlyusarId = String(record.slyusar_id);
  const newName = await getSlyusarName(newSlyusarId);

  const dateOn = new Date(record.data_on);
  const dateOff = new Date(record.data_off);
  const newStartMins =
    (dateOn.getUTCHours() - START_HOUR) * 60 + dateOn.getUTCMinutes();
  const newEndMins =
    (dateOff.getUTCHours() - START_HOUR) * 60 + dateOff.getUTCMinutes();
  const newTimeStr = `${minutesToTime(newStartMins)} - ${minutesToTime(newEndMins)}`;
  const newStatus = record.status || "Запланований";

  // Default display values
  slyusarHtml = `<span class="prt-value">${newName}</span>`;
  timeHtml = `<span class="prt-value">${newTimeStr}</span>`;
  statusHtml = `<span class="prt-value">${newStatus}</span>`;

  // 🕵️‍♂️ Логіка порівняння для UPDATE (визначаємо чи були зміни)
  if (type === "update") {
    const block = document.querySelector(
      `.post-reservation-block[data-post-arxiv-id="${Number(record.post_arxiv_id)}"], .post-week-block[data-post-arxiv-id="${Number(record.post_arxiv_id)}"]`,
    ) as HTMLElement;

    if (block || oldRecord) {
      // --- Перевірка зміни СЛЮСАРЯ ---
      const oldSlyusarId = oldRecord?.slyusar_id ? String(oldRecord.slyusar_id) : block?.dataset.slyusarId;
      if (oldSlyusarId && oldSlyusarId !== newSlyusarId) {
        const oldName = await getSlyusarName(oldSlyusarId);
        slyusarHtml = `<span class="prt-value">Заміна <span style="color: #ef4444; font-weight: bold;">${oldName}</span> ➝ <span style="color: #10b981; font-weight: bold;">${newName}</span></span>`;
      }

      // --- Перевірка зміни ЧАСУ ---
      const oldOn = oldRecord?.data_on ? new Date(oldRecord.data_on) : null;
      const oldOff = oldRecord?.data_off ? new Date(oldRecord.data_off) : null;
      const oldStartMins = oldOn ? (oldOn.getUTCHours() - START_HOUR) * 60 + oldOn.getUTCMinutes() : parseInt(block?.dataset.start || "0");
      const oldEndMins = oldOff ? (oldOff.getUTCHours() - START_HOUR) * 60 + oldOff.getUTCMinutes() : parseInt(block?.dataset.end || "0");

      if (
        Math.abs(oldStartMins - newStartMins) > 1 ||
        Math.abs(oldEndMins - newEndMins) > 1
      ) {
        const oldTimeStr = `${minutesToTime(oldStartMins)} - ${minutesToTime(oldEndMins)}`;
        timeHtml = `<span class="prt-value">Заміна <span style="color: #ef4444; font-weight: bold;">${oldTimeStr}</span> ➝ <span style="color: #10b981; font-weight: bold;">${newTimeStr}</span></span>`;
      }

      // --- Перевірка зміни СТАТУСУ ---
      const oldStatus = oldRecord?.status || block?.dataset.status || "Запланований";
      if (oldStatus !== newStatus) {
        const oldColor = statusColors[oldStatus] || "#ccc";
        const newColor = statusColors[newStatus] || "#ccc";

        statusHtml = `<span class="prt-value">Заміна <span style="background-color: ${oldColor}; color: white; padding: 2px 8px; border-radius: 50px; font-weight: bold;">${oldStatus}</span> ➝ <span style="background-color: ${newColor}; color: white; padding: 2px 8px; border-radius: 50px; font-weight: bold;">${newStatus}</span></span>`;
      }
    }
  }

  const clientName = parseClientName(record.client_id) || record.client_data?.["ПІБ"] || "";
  const carInfo = parseCarInfo(record.cars_id) || [record.car_data?.["Авто"], record.car_data?.["Номер авто"]].filter(Boolean).join(" ");

  const changedBy = record.xto_zapusav || "Невідомо";

  const toast = document.createElement("div");
  toast.className = "planyvannya-realtime-toast";
  toast.id = toastId;
  toast.style.borderLeftColor = colors[type];

  toast.innerHTML = `
    <div class="prt-header">
      <span class="prt-icon">${icons[type]}</span>
      <span class="prt-label" style="color: ${colors[type]}">${labels[type]}</span>
      <button class="prt-close" title="Закрити">&times;</button>
    </div>
    ${clientName ? `<div class="prt-row"><span class="prt-emoji">👤</span><span class="prt-value">${clientName}</span></div>` : ""}
    ${carInfo ? `<div class="prt-row"><span class="prt-emoji">🚗</span><span class="prt-value">${carInfo}</span></div>` : ""}
    <div class="prt-row" style="margin-top: 4px;"><span class="prt-emoji">👨‍🔧</span>${slyusarHtml}</div>
    <div class="prt-row" style="margin-top: 4px;"><span class="prt-emoji">🕐</span>${timeHtml}</div>
    <div class="prt-row" style="margin-top: 4px;"><span class="prt-emoji">📋</span>${statusHtml}</div>
    <div class="prt-footer">
      <span class="prt-who">${changedBy}</span>
    </div>
  `;

  // Закриття по кнопці
  toast.querySelector(".prt-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    removeToast(toast, toastId);
  });

  if (generation !== subscriptionGeneration || !postArxivChannel || document.hidden) return;
  container.appendChild(toast);

  // Анімація появи
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("prt-show");
    });
  });

  // Автоматичне зникнення через 8 секунд
  const timer = window.setTimeout(() => {
    removeToast(toast, toastId);
  }, 8000);
  toastAutoHideTimers.set(toastId, timer);

  // Зупиняємо таймер при hover
  toast.addEventListener("mouseenter", () => {
    const t = toastAutoHideTimers.get(toastId);
    if (t) {
      window.clearTimeout(t);
      toastAutoHideTimers.delete(toastId);
    }
  });

  // Відновлюємо таймер після mouseleave
  toast.addEventListener("mouseleave", () => {
    const newTimer = window.setTimeout(() => {
      removeToast(toast, toastId);
    }, 4000);
    toastAutoHideTimers.set(toastId, newTimer);
  });

  // Звук нотифікації
  playRealtimeSound(type);
}

function removeToast(toast: HTMLElement, toastId: string): void {
  if (toast.classList.contains("prt-removing")) return;
  toast.classList.add("prt-removing");
  toast.classList.remove("prt-show");

  const timer = toastAutoHideTimers.get(toastId);
  if (timer) {
    window.clearTimeout(timer);
    toastAutoHideTimers.delete(toastId);
  }

  setTimeout(() => {
    toast.remove();
  }, 400);
}

/**
 * Простий звук нотифікації
 */
let _realtimeAudioCtx: AudioContext | null = null;
let _realtimeUserGesture = false;
// AudioContext створюємо лише при потребі, не при кліку
document.addEventListener(
  "click",
  () => {
    _realtimeUserGesture = true;
    if (_realtimeAudioCtx && _realtimeAudioCtx.state === "suspended") {
      _realtimeAudioCtx.resume().catch(() => {});
    }
  },
  { once: true },
);

function playRealtimeSound(type: "insert" | "update" | "delete"): void {
  try {
    if (!_realtimeUserGesture) return;
    // Ліниве створення AudioContext
    if (!_realtimeAudioCtx) {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) _realtimeAudioCtx = new Ctx();
    }
    if (!_realtimeAudioCtx) return;
    if (_realtimeAudioCtx.state === "suspended") {
      _realtimeAudioCtx.resume().catch(() => {
        /* silent */
      });
      return;
    }
    const ctx = _realtimeAudioCtx;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    const freqs: Record<string, number> = {
      insert: 880,
      update: 660,
      delete: 440,
    };
    osc.frequency.setValueAtTime(freqs[type] || 660, ctx.currentTime);

    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // ігноруємо
  }
}

// Індикатори оновлюються через refreshPlannerCalendar -> refreshOccupancyIndicators

// ── Головна функція підписки ──

/**
 * Ініціалізація Realtime підписки на зміни в post_arxiv.
 * Слухає INSERT / UPDATE / DELETE і автоматично оновлює
 * календар планувальника для ВСІХ користувачів.
 */
export function initPostArxivRealtimeSubscription(): void {
  (window as any).restartRealtime = initPostArxivRealtimeSubscription;
  if (!document.getElementById("postSchedulerWrapper")) return;
  subscriptionWanted = true;
  disconnectPostArxivRealtime();
  if (document.hidden) return;
  const generation = subscriptionGeneration;
  // Initial reads may have raced with joining; reconnects need the same check.
  let needsReconciliation = true;
  postArxivChannel = databaseSubscriptions.subscribe({ table: "post_arxiv", select: [
    "post_arxiv_id", "slyusar_id", "name_post", "client_id", "cars_id", "status",
    "data_on", "data_off", "komentar", "act_id", "xto_zapusav", "traffic_previous",
  ] }, payload => {
    if (payload.eventType === "INSERT") {
      if (generation !== subscriptionGeneration) return;
      const record = payload.new as any;
      const previous = getPlannerRecord(record.post_arxiv_id);
      publishPlannerChange("INSERT", record, previous);
      const currentUser = getCurrentUserName();
      if (!document.hidden && (!currentUser || record.xto_zapusav !== currentUser)) {
        void showRealtimeToast("insert", record).catch(() => {});
      }
    } else if (payload.eventType === "UPDATE") {
      if (generation !== subscriptionGeneration) return;
      const record = payload.new as any;
      // DEFAULT replica identity sends only the primary key in payload.old.
      const previous = getPlannerRecord(record.post_arxiv_id)
        || ((payload.old as any)?.data_on ? payload.old : record.traffic_previous?.data_on ? { ...record.traffic_previous, post_arxiv_id: record.post_arxiv_id } : undefined);
      publishPlannerChange("UPDATE", record, previous);
      const currentUser = getCurrentUserName();
      if (!document.hidden && (!currentUser || record.xto_zapusav !== currentUser)) {
        void showRealtimeToast("update", record, previous).catch(() => {});
      }
    } else if (payload.eventType === "DELETE") {
      if (generation !== subscriptionGeneration) return;
      const old = payload.old as any;
      const previous = getPlannerRecord(old?.post_arxiv_id);
      const record = { ...previous, ...old };
      const selector = '[data-post-arxiv-id="' + Number(old?.post_arxiv_id) + '"]';
      const visible = document.querySelector(".post-reservation-block" + selector + ", .post-week-block" + selector);
      publishPlannerChange("DELETE", record, previous);
      if (!document.hidden && visible && record.data_on) {
        void showRealtimeToast("delete", record).catch(() => {});
      }
    }
  }, status => {
      if (generation !== subscriptionGeneration) return;
      if (status === "SUBSCRIBED") {
        if (needsReconciliation) requestPlannerReconciliation();
        needsReconciliation = false;
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        needsReconciliation = true;
      }
    });
}

export function unsubscribeFromPostArxivRealtime(): void {
  subscriptionWanted = false;
  disconnectPostArxivRealtime();
}

function disconnectPostArxivRealtime(): void {
  subscriptionGeneration++;
  for (const timer of toastAutoHideTimers.values()) window.clearTimeout(timer);
  toastAutoHideTimers.clear();
  document.getElementById(TOAST_CONTAINER_ID)?.remove();
  if (postArxivChannel) {
    postArxivChannel.unsubscribe();
    postArxivChannel = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnectPostArxivRealtime();
  else if (subscriptionWanted && !postArxivChannel) initPostArxivRealtimeSubscription();
});
window.addEventListener("pagehide", disconnectPostArxivRealtime);
window.addEventListener("pageshow", event => {
  if (event.persisted && subscriptionWanted && !document.hidden) initPostArxivRealtimeSubscription();
});
