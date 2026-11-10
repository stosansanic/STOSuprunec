// ===== ФАЙЛ: src/ts/roboha/tablucya/povidomlennya_tablucya.ts =====

import {
  markNotificationAsDeleted,
  loadUnseenNotificationsPage,
  readUnreadNotificationIds,
  getNotificationAccessScope,
} from "./mark_notification_deleted";
import { userAccessLevel } from "./users";
import { notify } from "../../utils/appDialogs";
import { showModal } from "../zakaz_naraudy/modalMain";

export interface ActNotificationPayload {
  act_id: number; // номер акту (обов'язковий)
  notification_id?: number; // pk з таблиці act_changes_notifications
  id?: number; // запасне поле, якщо прийде під іменем id
  changed_by_surname: string; // хто змінив
  item_name: string; // що змінено (робота/деталь)
  dodav_vudaluv: boolean; // true = додано, false = видалено
  created_at?: string; // timestamp з БД
  data?: string; // запасне поле, якщо час прийде сюди
  pib?: string; // ✅ ПІБ клієнта з акту
  auto?: string; // ✅ Дані автомобіля з акту
  pruimalnyk?: string; // ✅ Для кого адресовано повідомлення
}

function isMainPage(): boolean {
  return window.location.pathname.endsWith("/main.html");
}

// Keep only displayed cards and revision markers; no act/customer histories are cached here.
const displayedNotifications = new Map<number, ActNotificationPayload>();
const notificationRevisions = new Map<number, number>();
const locallyDismissed = new Set<number>();
let notificationRevision = 0;
let notificationScope = "";
let nextNotificationBefore: number | null = null;
let notificationsInitialized = false;
let notificationPagePending: Promise<void> | null = null;
let notificationReconcilePending: Promise<void> | null = null;
let notificationReconcileQueued = false;
let notificationPageGeneration = 0;
let olderSentinel: HTMLElement | null = null;

function ensureNotificationScope(): string {
  const key = getNotificationAccessScope()?.key || "";
  if (key !== notificationScope) {
    notificationScope = key;
    displayedNotifications.clear(); notificationRevisions.clear(); locallyDismissed.clear();
    nextNotificationBefore = null; notificationsInitialized = false;
    notificationPagePending = null; notificationReconcilePending = null; notificationReconcileQueued = false;
    notificationPageGeneration++;
    document.querySelectorAll("#act-realtime-container .act-notification-toast").forEach(node => node.remove());
    if (olderSentinel) olderSentinel.hidden = true;
  }
  return key;
}

function dispatchNotificationRemoval(actId: number, id: number): void {
  window.dispatchEvent(new CustomEvent("sto:act-notifications-removed", { detail: { actId, notificationIds: [id] } }));
}

function updateOlderSentinel(): void {
  if (!olderSentinel) return;
  olderSentinel.hidden = !isStackExpanded || nextNotificationBefore === null;
  olderSentinel.textContent = notificationPagePending ? "Завантаження повідомлень…" : "Попередні повідомлення";
}

function maybeLoadOlderNotifications(): void {
  if (!isStackExpanded || Date.now() < stackExpansionReadyAt || notificationPagePending || nextNotificationBefore === null || !olderSentinel) return;
  const container = olderSentinel.parentElement;
  if (!container) return;
  const card = olderSentinel.getBoundingClientRect(), viewport = container.getBoundingClientRect();
  if (card.bottom >= viewport.top - 120 && card.top <= viewport.bottom + 120) {
    void loadOlderNotifications().catch(() => notify("Не вдалося підвантажити повідомлення. Прокрутіть список, щоб повторити.", "error"));
  }
}

async function loadOlderNotifications(): Promise<void> {
  if (document.visibilityState === "hidden") return;
  if (notificationPagePending) return notificationPagePending;
  const scope = ensureNotificationScope();
  if (!scope || nextNotificationBefore === null) return;
  const before = nextNotificationBefore, revision = notificationRevision, generation = notificationPageGeneration;
  const pending = (async () => {
    const page = await loadUnseenNotificationsPage(before);
    if (scope !== ensureNotificationScope() || generation !== notificationPageGeneration) return;
    for (const item of page.items) {
      const id = Number(item.notification_id);
      if ((notificationRevisions.get(id) || 0) <= revision) showRealtimeActNotification(item, { silent: true, snapshot: true });
    }
    nextNotificationBefore = page.nextBefore;
  })();
  notificationPagePending = pending; updateOlderSentinel();
  try { await pending; } finally {
    if (notificationPagePending === pending) notificationPagePending = null;
    updateOlderSentinel();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" && !displayedNotifications.size && nextNotificationBefore !== null) {
    void loadOlderNotifications().catch(() => notify("Не вдалося підвантажити повідомлення.", "error"));
  }
});

// ==========================
//     ЗВУКОВІ ЕФЕКТИ
// ==========================

let globalAudioContext: AudioContext | null = null;
let _povidUserGesture = false;
// Відмічаємо що був жест, але AudioContext створюємо лише при потребі
document.addEventListener(
  "click",
  () => {
    _povidUserGesture = true;
    if (globalAudioContext && globalAudioContext.state === "suspended") {
      globalAudioContext.resume().catch(() => {});
    }
  },
  { once: true },
);

function getAudioContext(): AudioContext | null {
  if (!_povidUserGesture) return null;
  try {
    if (!globalAudioContext) {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (Ctx) globalAudioContext = new Ctx();
    }
    if (globalAudioContext && globalAudioContext.state === "suspended") {
      globalAudioContext.resume().catch(() => {});
    }
  } catch {
    /* silent */
  }
  return globalAudioContext;
}

function playNotificationSound(isAdded: boolean) {
  try {
    const audioCtx = getAudioContext();
    if (!audioCtx) return;

    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      isAdded ? 880 : 440,
      audioCtx.currentTime,
    );

    gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.001,
      audioCtx.currentTime + 0.1,
    );

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.1);
  } catch (_e) {
    // ігноруємо
  }
}

// ==========================
//   ГРУПУВАННЯ ЗВУКІВ (DEBOUNCE)
// ==========================

let soundBurstTimeout: number | null = null;
let lastBurstIsAdded: boolean | null = null;

// за який час вважаємо, що це "одна пачка"
const SOUND_BURST_DELAY = 200; // мс

function scheduleNotificationSound(isAdded: boolean) {
  // запам'ятовуємо тип останньої нотифікації (додано / видалено)
  lastBurstIsAdded = isAdded;

  // якщо таймер уже був – скасовуємо, бо прилетіло ще одне
  if (soundBurstTimeout !== null) {
    window.clearTimeout(soundBurstTimeout);
  }

  // ставимо новий таймер – якщо за 200мс більше нічого не прийде,
  // граємо звук саме для останнього isAdded
  soundBurstTimeout = window.setTimeout(() => {
    if (lastBurstIsAdded !== null) {
      playNotificationSound(lastBurstIsAdded);
    }
    soundBurstTimeout = null;
    lastBurstIsAdded = null;
  }, SOUND_BURST_DELAY);
}

function playCloseSound() {
  try {
    const audioCtx = getAudioContext();
    if (!audioCtx) return;

    const t = audioCtx.currentTime;
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(600, t);
    oscillator.frequency.exponentialRampToValueAtTime(300, t + 0.15);

    gainNode.gain.setValueAtTime(0, t);
    gainNode.gain.linearRampToValueAtTime(0.1, t + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

    oscillator.start(t);
    oscillator.stop(t + 0.15);
  } catch (_e) {
    // ігноруємо
  }
}

// ==========================
//      ХЕЛПЕРИ ДЛЯ DOM
// ==========================

function formatTimeOnly(dateStr?: string): string {
  const date = dateStr ? new Date(dateStr) : new Date();

  // час: години та хвилини
  const timePart = date.toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
  });

  // дата: число та місяць
  const datePart = date.toLocaleDateString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
  });

  // формат: 15:07 / 05.12
  return `${timePart} / ${datePart}`;
}

function reindexBadges() {
  const container = document.getElementById("act-realtime-container");
  if (!container) return;

  const toasts = Array.from(
    container.querySelectorAll(".act-notification-toast:not(.closing)"),
  );

  // 1 - найстаріше, більше число - найновіше (через column-reverse візуально зверху вниз)
  toasts.reverse().forEach((toast, index) => {
    const badge = toast.querySelector(
      ".notification-count-badge",
    ) as HTMLElement | null;
    if (badge) badge.textContent = (index + 1).toString();
  });
}

// ==========================
//    ЛОГІКА ХОВЕРА СТЕКА
// ==========================

let hoverAnimationInitialized = false;
let hoverTimeouts: number[] = [];
let isStackExpanded = false;
let stackExpansionReadyAt = 0;

function clearHoverTimeouts() {
  hoverTimeouts.forEach((id) => window.clearTimeout(id));
  hoverTimeouts = [];
}

function initHoverAnimation(container: HTMLElement) {
  if (hoverAnimationInitialized) return;
  hoverAnimationInitialized = true;

  container.addEventListener("mouseenter", () => {
    expandStack(container);
    stackExpansionReadyAt = Date.now() + 500;
    updateOlderSentinel();
    window.setTimeout(maybeLoadOlderNotifications, 500);
  });

  container.addEventListener("scroll", maybeLoadOlderNotifications, { passive: true });
  container.addEventListener("mouseleave", () => {
    collapseStack(container);
    updateOlderSentinel();
  });
}

// Розгортання: спочатку перший тост (0.7 → 1.0), потім інші по одному знизу вгору
function expandStack(container: HTMLElement) {
  if (isStackExpanded) return;
  isStackExpanded = true;
  clearHoverTimeouts();

  const toasts = Array.from(
    container.querySelectorAll(".act-notification-toast"),
  ) as HTMLElement[];

  if (!toasts.length) return;

  const first = toasts[0]; // перший у DOM (внизу візуально через column-reverse)
  const FIRST_DURATION = 40; // скільки розкривається перший
  const STEP_DELAY = 15; // затримка між появою наступних

  // 1. перший – збільшуємо
  first.classList.add("toast-expanded");

  // 2. після його розкриття показуємо інші по одному
  const startOthersId = window.setTimeout(() => {
    for (let i = 1; i < toasts.length; i++) {
      const toast = toasts[i];
      const id = window.setTimeout(
        () => {
          toast.classList.add("stack-visible");
        },
        STEP_DELAY * (i - 1),
      );
      hoverTimeouts.push(id);
    }
  }, FIRST_DURATION);

  hoverTimeouts.push(startOthersId);
}

// Згортання: спочатку інші зверху вниз, потім перший (1.0 → 0.7)
function collapseStack(container: HTMLElement) {
  if (!isStackExpanded) return;
  isStackExpanded = false;
  clearHoverTimeouts();

  const toasts = Array.from(
    container.querySelectorAll(".act-notification-toast"),
  ) as HTMLElement[];

  if (!toasts.length) return;

  const first = toasts[0];
  const STEP_DELAY = 15;
  const HIDE_DURATION = 40;

  // 1. ховаємо всі, крім першого, зверху вниз (візуально: останній у DOM → перший)
  let order = 0;
  for (let i = toasts.length - 1; i >= 1; i--, order++) {
    const toast = toasts[i];
    const id = window.setTimeout(() => {
      toast.classList.add("stack-hiding");
      toast.classList.remove("stack-visible");

      const endId = window.setTimeout(() => {
        toast.classList.remove("stack-hiding");
        // після цього лишається базовий стан: display:none для не-першого
      }, HIDE_DURATION);

      hoverTimeouts.push(endId);
    }, STEP_DELAY * order);
    hoverTimeouts.push(id);
  }

  // 2. після того, як всі інші сховалися – повертаємо перший у режим мініатюри
  const totalDelay =
    STEP_DELAY * Math.max(0, toasts.length - 1) + HIDE_DURATION;

  const firstId = window.setTimeout(() => {
    first.classList.remove("toast-expanded");
    first.classList.remove("stack-visible");
    first.classList.remove("stack-hiding");
  }, totalDelay);

  hoverTimeouts.push(firstId);
}

// ==========================
//   КОНТЕЙНЕР НОТИФІКАЦІЙ
// ==========================

function getOrCreateContainer(): HTMLElement {
  if (!isMainPage()) {
    throw new Error("act-realtime-container is available only on main.html");
  }

  let container = document.getElementById("act-realtime-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "act-realtime-container";
    document.body.appendChild(container);
  }

  if (!olderSentinel || !olderSentinel.isConnected) {
    olderSentinel = document.createElement("div");
    olderSentinel.className = "act-notifications-older";
    olderSentinel.style.cssText = "flex-shrink:0;width:100%;padding:8px;color:#566;font-size:12px;text-align:center";
    olderSentinel.hidden = true;
    container.appendChild(olderSentinel);
  }

  // ініціалізація логіки ховера (один раз)
  initHoverAnimation(container);

  return container;
}

// ==========================
//      ГОЛОВНІ ФУНКЦІЇ
// ==========================

export function showRealtimeActNotification(
  payload: ActNotificationPayload,
  options: { silent?: boolean; snapshot?: boolean } = {},
): void {
  if (!isMainPage() || !ensureNotificationScope()) return;
  const scope = getNotificationAccessScope();
  if (scope?.reception && payload.pruimalnyk !== scope.reception) return;

  const container = getOrCreateContainer();

  // унікальний ID для HTML (беремо з БД, якщо є)
  const dbId =
    payload.notification_id || payload.id || Date.now() + Math.random();

  if (typeof dbId === "number") {
    if (!options.snapshot) notificationRevisions.set(dbId, ++notificationRevision);
    if (locallyDismissed.has(dbId) || displayedNotifications.has(dbId)) return;
    displayedNotifications.set(dbId, payload);
  }

  // якщо така нотифікація вже є – не дублюємо
  if (container.querySelector(`[data-id="${dbId}"]`)) return;

  const isAdded = payload.dodav_vudaluv;
  const icon = isAdded ? "✅" : "❌";
  const actionText = isAdded ? "Додано" : "Видалено";
  const typeClass = isAdded ? "type-added" : "type-deleted";
  const timeString = formatTimeOnly(payload.created_at || payload.data);

  const toast = document.createElement("div");
  // додаємо службовий клас incoming для анімації "прильоту"
  toast.className = `act-notification-toast incoming ${typeClass}`;

  // зберігаємо id та act_id у data-атрибути
  toast.setAttribute("data-id", String(dbId));
  toast.setAttribute("data-act-id", String(payload.act_id));

  // ✅ Формуємо рядки для клієнта та автомобіля (якщо є)
  const pibLine = payload.pib
    ? `<div class="toast-client-row"><span class="client-label">👤</span><span class="client-value">${payload.pib}</span></div>`
    : "";
  const autoLine = payload.auto
    ? `<div class="toast-auto-row"><span class="auto-label">🚗</span><span class="auto-value">${payload.auto}</span></div>`
    : "";

  toast.innerHTML = `
    <div class="toast-header-row">
      <div class="header-left">
        <span class="act-id">Акт №${payload.act_id}</span>
        <span class="status-text">${actionText}</span>
        ${payload.pruimalnyk ? `<span class="receiver-name">→ ${payload.pruimalnyk}</span>` : ""}
      </div>
      <div class="notification-count-badge">...</div>
    </div>
    ${pibLine}
    ${autoLine}
    <div class="toast-meta-row">
      <span class="meta-time-oval">${timeString}</span>
      <span class="user-surname">${
        payload.changed_by_surname || "Користувач"
      }</span>
    </div>
    <div class="toast-body-row">
      <span class="item-icon">${icon}</span>
      <span class="item-name">${payload.item_name}</span>
    </div>
  `;

  // додаємо на початок DOM (через column-reverse – буде найнижче візуально)
  const nextCard = Array.from(container.querySelectorAll<HTMLElement>(".act-notification-toast")).find(card => Number(card.dataset.id) < Number(dbId));
  container.insertBefore(toast, nextCard || olderSentinel);
  if (isStackExpanded) { toast.classList.add("toast-expanded", "stack-visible"); }
  if (!options.silent) scheduleNotificationSound(isAdded);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // перший елемент завжди маленький, решта – сховані (через SCSS)
      toast.classList.add("show");
      reindexBadges();

      // після завершення "прильоту" прибираємо службовий клас
      window.setTimeout(() => {
        toast.classList.remove("incoming");
      }, 700);

      // при ховері скролимо так, щоб нове було видно
      if (!options.snapshot && container.matches(":hover")) {
        toast.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    });
  });

  // Обробник кліку на номер акту для його відкриття
  const actIdElement = toast.querySelector(".act-id");
  if (actIdElement) {
    actIdElement.addEventListener("click", async (e) => {
      e.stopPropagation(); // Запобігаємо закриттю toast

      // Відкриваємо акт в режимі 'client' (всі стовпці)
      await showModal(payload.act_id, "client");
    });
  }

  // клік по картці – закрити її та позначити як видалене в БД
  toast.addEventListener("click", async (e) => {
    e.stopPropagation();

    // Перевіряємо чи цей тост вже закривається
    if (toast.classList.contains("closing")) return;

    if (toast.dataset.acknowledging === "true") return;
    const id = Number(dbId);
    if (userAccessLevel === "Адміністратор") {
      locallyDismissed.add(id); displayedNotifications.delete(id);
      playCloseSound(); removeToastElement(toast);
      return; // Local dismissal never changes the receiver's authoritative count.
    }
    const scope = ensureNotificationScope();
    toast.dataset.acknowledging = "true";
    const saved = await markNotificationAsDeleted(id);
    delete toast.dataset.acknowledging;
    if (scope !== ensureNotificationScope()) return;
    if (!saved) {
      if (!displayedNotifications.has(id)) return;
      notify("Не вдалося позначити повідомлення переглянутим. Спробуйте ще раз.", "error");
      return;
    }
    playCloseSound();
    removeRealtimeNotification(id);
    dispatchNotificationRemoval(payload.act_id, id);
  });
}

/**
 * Видалити ВСІ нотифікації по конкретному act_id
 * (викликається при DELETE з Realtime або при відкритті акту)
 */
export function removeNotificationsForAct(actId: number): void {
  for (const [id, payload] of displayedNotifications) {
    if (Number(payload.act_id) === actId) removeRealtimeNotification(id);
  }
  const container = document.getElementById("act-realtime-container");
  if (!container) return;

  const toasts = container.querySelectorAll<HTMLElement>(
    `.act-notification-toast[data-act-id="${actId}"]`,
  );

  if (toasts.length > 0) {
    toasts.forEach((toast) => {
      if (!toast.classList.contains("closing")) {
        removeToastElement(toast);
      }
    });
  }
}

/**
 * Видалити конкретну нотифікацію по її notification_id
 */
export function removeRealtimeNotification(dbId: number): void {
  ensureNotificationScope();
  notificationRevisions.set(Number(dbId), ++notificationRevision);
  displayedNotifications.delete(Number(dbId));
  const container = document.getElementById("act-realtime-container");
  if (!container) return;

  const toast = container.querySelector<HTMLElement>(
    `.act-notification-toast[data-id="${dbId}"]`,
  );
  // Перевіряємо чи тост існує і чи він ще не в процесі закриття
  if (toast && !toast.classList.contains("closing")) {
    removeToastElement(toast);
  }
}

// ==========================
//     ДОПОМІЖНЕ ВИДАЛЕННЯ
// ==========================

function removeToastElement(toast: HTMLElement) {
  toast.classList.add("closing");

  requestAnimationFrame(() => reindexBadges());

  // даємо часу спочатку поїхати вправо, потім плавно "опустити" стек
  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
      requestAnimationFrame(() => reindexBadges());
      if (!displayedNotifications.size && nextNotificationBefore !== null) {
        void loadOlderNotifications().catch(() => notify("Не вдалося підвантажити повідомлення.", "error"));
      }
    }
  }, 400);
}

// ==========================
//  ЗАВАНТАЖЕННЯ ІСНУЮЧИХ ПОВІДОМЛЕНЬ
// ==========================

/**
 * Завантажує та відображає всі невидалені повідомлення з БД
 * Викликається при ініціалізації сторінки або поверненні з іншої сторінки
 */
export async function loadAndShowExistingNotifications(reconcile = false): Promise<void> {
  if (!isMainPage()) return;
  const scope = ensureNotificationScope();
  if (!scope || (notificationsInitialized && !reconcile)) return;
  if (notificationReconcilePending) {
    if (reconcile) notificationReconcileQueued = true;
    return notificationReconcilePending;
  }
  notificationPageGeneration++;
  const revision = notificationRevision;
  const knownIds = Array.from(displayedNotifications.keys());
  const pending = (async () => {
    const [page, alive] = await Promise.all([
      loadUnseenNotificationsPage(),
      reconcile && knownIds.length ? readUnreadNotificationIds(knownIds) : Promise.resolve(null),
    ]);
    if (scope !== ensureNotificationScope()) return;
    if (alive) for (const id of knownIds) {
      if (!alive.has(id) && (notificationRevisions.get(id) || 0) <= revision) removeRealtimeNotification(id);
    }
    for (const item of page.items) {
      const id = Number(item.notification_id);
      if ((notificationRevisions.get(id) || 0) <= revision) showRealtimeActNotification(item, { silent: true, snapshot: true });
    }
    // Restart at the new head after reconnect so a gap larger than one page is not skipped.
    // Existing cards stay cached and are deduplicated when those pages are reached.
    nextNotificationBefore = page.nextBefore;
    notificationsInitialized = true;
    updateOlderSentinel();
  })();
  notificationReconcilePending = pending;
  try { await pending; } finally {
    if (notificationReconcilePending === pending) notificationReconcilePending = null;
    if (notificationReconcileQueued && scope === ensureNotificationScope()) {
      notificationReconcileQueued = false;
      void loadAndShowExistingNotifications(true).catch(() => notify("Не вдалося звірити повідомлення після відновлення зв’язку.", "warning"));
    }
  }
}
