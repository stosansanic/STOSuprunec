// src/ts/roboha/zakaz_naraudy/actPresence.ts
// 🔐 Серверний lock на акт через БД (acquire_act_lock / release_act_lock)
// + Realtime підписка на таблицю act_locks для миттєвого реагування
import { supabase } from "../../vxid/supabaseClient";
import { userName as currentUserName } from "../tablucya/users";
import { showNotification } from "./inhi/vspluvauhe_povidomlenna";
import { refreshActTableSilently } from "./modalMain";
import { globalCache } from "./globalCache";
import { actPresenceHub } from "./actPresenceHub";

// ═══════════════════════════════════════════════════════
// Стан модуля
// ═══════════════════════════════════════════════════════
let currentActId: number | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let realtimeChannel: any = null;
let broadcastChannel: any = null;

// TTL серверного lock-а (секунди). Heartbeat оновлює кожні 30 с.
const LOCK_TTL_SECONDS = 90;
// Heartbeat: кожні 30 секунд відправляємо acquire (оновлює heartbeat_at)
const HEARTBEAT_MS = 30_000;
// Realtime handles release immediately; bounded polling recovers missed events/expired leases.
const POLL_MIN_MS = 10_000;
const POLL_MAX_MS = 30_000;
let pollDelay = POLL_MIN_MS;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let waitingForLock = false;
let waitingAcquire: Promise<void> | null = null;
let pageSuspended = false;
// Колбек при розблокуванні
let onUnlockCallback: (() => Promise<void> | void) | null = null;

// ═══════════════════════════════════════════════════════
// RPC виклики до Supabase
// ═══════════════════════════════════════════════════════
type LockResult = { acquired: boolean; locked_by: string; opened_at: string };
const pendingAcquires = new Map<string, Promise<LockResult>>();
let presenceGeneration = 0;

async function rpcAcquire(
  actId: number,
  userName: string,
): Promise<LockResult> {
  const key = JSON.stringify([actId, userName]);
  const existing = pendingAcquires.get(key);
  if (existing) return existing;
  const pending = performAcquire(actId, userName);
  pendingAcquires.set(key, pending);
  try { return await pending; } finally {
    if (pendingAcquires.get(key) === pending) pendingAcquires.delete(key);
  }
}

async function performAcquire(actId: number, userName: string): Promise<LockResult> {
  const { data, error } = await supabase.rpc("acquire_act_lock", {
    p_act_id: actId,
    p_user_name: userName,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (error) throw error;
  return data as { acquired: boolean; locked_by: string; opened_at: string };
}

async function rpcRelease(actId: number, userName: string): Promise<void> {
  await supabase.rpc("release_act_lock", {
    p_act_id: actId,
    p_user_name: userName,
  });
}

// ═══════════════════════════════════════════════════════
// Heartbeat (власник lock-а оновлює heartbeat_at кожні 30 с)
// ═══════════════════════════════════════════════════════
function startOwnerHeartbeat(actId: number): void {
  stopOwnerHeartbeat();
  const generation = presenceGeneration;
  heartbeatTimer = setInterval(async () => {
    try {
      const result = await rpcAcquire(actId, currentUserName || "Unknown");
      if (currentActId !== actId || generation !== presenceGeneration) return;
      if (!result.acquired) {
        waitingForLock = true;
        void untrackGlobalActPresence();
        stopOwnerHeartbeat();
        lockActInterface(result.locked_by);
        startLockPolling(actId);
      }
    } catch {
      /* silent */
    }
  }, HEARTBEAT_MS);
}

function stopOwnerHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ═══════════════════════════════════════════════════════
// Polling для заблокованого юзера (перевірка чи lock звільнився)
// ═══════════════════════════════════════════════════════
function startLockPolling(actId: number, resetDelay = true): void {
  stopLockPolling();
  if (resetDelay) pollDelay = POLL_MIN_MS;
  if (!waitingForLock || currentActId !== actId || document.visibilityState === "hidden") return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await tryWaitingLock(actId);
    if (waitingForLock && currentActId === actId) {
      pollDelay = Math.min(POLL_MAX_MS, pollDelay * 1.5);
      startLockPolling(actId, false);
    }
  }, pollDelay);
}

function tryWaitingLock(actId: number): Promise<void> {
  if (!waitingForLock || currentActId !== actId) return Promise.resolve();
  if (waitingAcquire) return waitingAcquire;
  const generation = presenceGeneration;
  const pending = (async () => {
    try {
      const result = await rpcAcquire(actId, currentUserName || "Unknown");
      if (generation !== presenceGeneration || currentActId !== actId || !waitingForLock || !result.acquired) return;
      waitingForLock = false;
      stopLockPolling();
      unlockActInterface();
      startOwnerHeartbeat(actId);
      await trackGlobalActPresence(actId);
      if (generation === presenceGeneration && currentActId === actId) await onUnlockCallback?.();
    } catch { /* The next bounded poll or visibility recovery retries. */ }
  })();
  waitingAcquire = pending;
  void pending.finally(() => { if (waitingAcquire === pending) waitingAcquire = null; });
  return pending;
}

function stopLockPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ═══════════════════════════════════════════════════════
// Realtime підписка на таблицю act_locks (DELETE → миттєва реакція)
// ═══════════════════════════════════════════════════════
function subscribeToActLocksRealtime(actId: number): void {
  unsubscribeFromActLocksRealtime();

  realtimeChannel = supabase
    .channel(`act_locks_watch_${actId}`)
    .on(
      "postgres_changes" as any,
      {
        event: "DELETE",
        schema: "public",
        table: "act_locks",
        filter: `act_id=eq.${actId}`,
      },
      async (payload: any) => {
        // DELETE filtering depends on server/replica identity; never trust it alone.
        if (Number(payload.old?.act_id) !== actId || !waitingForLock) return;
        await tryWaitingLock(actId);
      },
    )
    .subscribe();
}

function unsubscribeFromActLocksRealtime(): void {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// ═══════════════════════════════════════════════════════
// Broadcast канал для "тихого" оновлення (act_saved)
// ═══════════════════════════════════════════════════════
function subscribeToBroadcast(actId: number): void {
  unsubscribeFromBroadcast();
  broadcastChannel = supabase.channel(`act_broadcast_${actId}`);
  broadcastChannel
    .on("broadcast", { event: "act_saved" }, async (payload: any) => {
      const header = document.querySelector(
        ".zakaz_narayd-header",
      ) as HTMLElement;
      const isLocked = header && header.hasAttribute("data-locked");
      if (isLocked) {
        try {
          const receivedActId =
            payload?.payload?.actId || payload?.actId || actId;
          if (Number(receivedActId) !== actId || currentActId !== actId) return;
          await refreshActTableSilently(receivedActId, {
            revision: payload?.payload?.revision,
            staffChanged: payload?.payload?.staffChanged,
          });
        } catch {
          /* silent */
        }
      }
    })
    .subscribe();
}

function unsubscribeFromBroadcast(): void {
  if (broadcastChannel) {
    supabase.removeChannel(broadcastChannel);
    broadcastChannel = null;
  }
}

// ═══════════════════════════════════════════════════════
// Глобальний Presence канал (для відображення ✏️ в таблиці)
// ═══════════════════════════════════════════════════════
async function trackGlobalActPresence(actId: number): Promise<void> {
  if (currentActId === actId && !waitingForLock) await actPresenceHub.setEditor(actId, currentUserName || "Unknown");
}

async function untrackGlobalActPresence(): Promise<void> {
  await actPresenceHub.clearEditor();
}

function resetLockUiState(): void {
  const header = document.querySelector(".zakaz_narayd-header") as HTMLElement;
  if (header) {
    header.style.backgroundColor = globalCache.generalSettings.headerColor;
    header.removeAttribute("data-locked");
    header.removeAttribute("data-locked-by");
  }

  removeLockOverlay();
}

// ═══════════════════════════════════════════════════════
// Обробники закриття сторінки / visibility
// ═══════════════════════════════════════════════════════
function handlePageUnload(): void {
  if (pageSuspended) return;
  pageSuspended = true;
  waitingForLock = false;
  presenceGeneration++;
  stopOwnerHeartbeat();
  stopLockPolling();
  if (currentActId) {
    // Fire-and-forget release. Якщо не встигне — TTL (90с) очистить lock.
    rpcRelease(currentActId, currentUserName || "Unknown").catch(() => {});
  }
  unsubscribeFromActLocksRealtime();
  unsubscribeFromBroadcast();
  void untrackGlobalActPresence();
}

window.addEventListener("beforeunload", handlePageUnload);
window.addEventListener("pagehide", handlePageUnload);
window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  pageSuspended = false;
  if (currentActId) void subscribeToActPresence(currentActId, onUnlockCallback || undefined).catch(() => {});
});

document.addEventListener("visibilitychange", async () => {
  // Перемикання вкладки та сон не зберігають і не закривають чернетку.
  // Зміни записуються лише кнопкою збереження або підтвердженням закриття акта.
  if (document.visibilityState === "hidden") { stopLockPolling(); return; }
  if (document.visibilityState === "visible" && currentActId) {
    if (waitingForLock) {
      await tryWaitingLock(currentActId);
      if (waitingForLock && currentActId) startLockPolling(currentActId);
      return;
    }
    // Перевіряємо lock (міг протухнути якщо heartbeat був throttled)
    try {
      const actId = currentActId;
      const generation = presenceGeneration;
      const res = await rpcAcquire(actId, currentUserName || "Unknown");
      if (currentActId !== actId || generation !== presenceGeneration) return;
      if (res.acquired) {
        waitingForLock = false;
        stopLockPolling();
        unlockActInterface();
        startOwnerHeartbeat(currentActId);
        await trackGlobalActPresence(currentActId);
      } else {
        waitingForLock = true;
        void untrackGlobalActPresence();
        stopOwnerHeartbeat();
        lockActInterface(res.locked_by);
        startLockPolling(currentActId);
      }
    } catch {
      /* silent */
    }
  }
});

// ═══════════════════════════════════════════════════════
// ГОЛОВНА ФУНКЦІЯ: підписка на lock акту
// ═══════════════════════════════════════════════════════
export async function subscribeToActPresence(
  actId: number,
  onUnlock?: () => Promise<void> | void,
): Promise<{ isLocked: boolean; lockedBy: string | null }> {
  const generation = ++presenceGeneration;
  waitingForLock = false;
  waitingAcquire = null;
  resetLockUiState();

  // 🔐 Зберігаємо старий actId для примусового release (навіть якщо close не встиг)
  const oldActId = currentActId;

  // Зупиняємо все від попереднього акту
  stopOwnerHeartbeat();
  stopLockPolling();
  unsubscribeFromActLocksRealtime();
  unsubscribeFromBroadcast();

  // Примусово release старого lock-а (якщо був)
  if (oldActId && oldActId !== actId) {
    try {
      await rpcRelease(oldActId, currentUserName || "Unknown");
    } catch {
      /* silent */
    }
    await untrackGlobalActPresence();
  }

  if (generation !== presenceGeneration) return { isLocked: true, lockedBy: null };
  currentActId = actId;
  onUnlockCallback = onUnlock || null;

  // 1) Пробуємо захопити серверний lock
  const res = await rpcAcquire(actId, currentUserName || "Unknown");
  if (generation !== presenceGeneration || currentActId !== actId) {
    // A delayed open must not recreate timers/channels after close or act switch.
    // Do not release the same act if a newer editor has already opened it.
    if (res.acquired && currentActId !== actId) {
      try { await rpcRelease(actId, currentUserName || "Unknown"); } catch { /* lease expires */ }
    }
    return { isLocked: true, lockedBy: null };
  }

  // 2) Підписуємося на Realtime та Broadcast
  subscribeToActLocksRealtime(actId);
  subscribeToBroadcast(actId);

  if (res.acquired) {
    // Ми — власник lock-а
    resetLockUiState();
    startOwnerHeartbeat(actId);
    await trackGlobalActPresence(actId);
    return { isLocked: false, lockedBy: null };
  } else {
    // Акт заблоковано іншим користувачем
    lockActInterface(res.locked_by);
    waitingForLock = true;
    startLockPolling(actId);
    return { isLocked: true, lockedBy: res.locked_by };
  }
}

// ═══════════════════════════════════════════════════════
// Відписка (при закритті модалки)
// ═══════════════════════════════════════════════════════
export async function unsubscribeFromActPresence(): Promise<void> {
  presenceGeneration++;
  waitingForLock = false;
  waitingAcquire = null;
  // 🔐 Захоплюємо actId синхронно, щоб не було race condition
  const actIdToRelease = currentActId;
  currentActId = null;
  onUnlockCallback = null;

  stopOwnerHeartbeat();
  stopLockPolling();
  unsubscribeFromActLocksRealtime();
  unsubscribeFromBroadcast();

  if (actIdToRelease) {
    try {
      await rpcRelease(actIdToRelease, currentUserName || "Unknown");
    } catch {
      /* silent */
    }
  }

  await untrackGlobalActPresence();
}

// ═══════════════════════════════════════════════════════
// Broadcast: сповіщення, що акт збережено
// ═══════════════════════════════════════════════════════
export async function notifyActSaved(actId: number, change?: { revision?: string; staffChanged?: boolean }): Promise<void> {
  if (broadcastChannel) {
    await broadcastChannel.send({
      type: "broadcast",
      event: "act_saved",
      payload: { actId, ...change },
    });
  }
}

// ═══════════════════════════════════════════════════════
// LOCK UI: блокування всієї модалки
// ═══════════════════════════════════════════════════════
const LOCK_OVERLAY_ID = "act-lock-overlay";

export function lockActInterface(lockedByUser: string): void {
  const header = document.querySelector(".zakaz_narayd-header") as HTMLElement;
  if (header && header.getAttribute("data-locked-by") === lockedByUser) return;

  // Показуємо повідомлення
  showNotification(
    `⚠️ Акт редагується: ${lockedByUser}. Режим перегляду.`,
    "warning",
    5000,
  );

  // Червоний header
  if (header) {
    header.style.backgroundColor = "#dc3545";
    header.setAttribute("data-locked", "true");
    header.setAttribute("data-locked-by", lockedByUser);
  }

  // Створюємо overlay поверх всього контенту модалки
  createLockOverlay(lockedByUser);
}

function unlockActInterface(): void {
  const header = document.querySelector(".zakaz_narayd-header") as HTMLElement;
  if (header && !header.hasAttribute("data-locked")) return;

  showNotification("✅ Акт тепер доступний для редагування", "success", 3000);

  if (header) {
    header.style.backgroundColor = globalCache.generalSettings.headerColor;
    header.removeAttribute("data-locked");
    header.removeAttribute("data-locked-by");
  }

  removeLockOverlay();
}

// ═══════════════════════════════════════════════════════
// 🔒 Overlay: повністю блокує модалку
// ═══════════════════════════════════════════════════════
function createLockOverlay(lockedByUser: string): void {
  removeLockOverlay();

  const modalContent = document.querySelector(
    ".zakaz_narayd-modal-content",
  ) as HTMLElement;
  if (!modalContent) return;

  const overlay = document.createElement("div");
  overlay.id = LOCK_OVERLAY_ID;
  overlay.innerHTML = `<div class="act-lock-overlay-text">🔒 Акт редагується: <strong>${lockedByUser}</strong></div>`;

  // Блокуємо всі кліки, скрол, та інші дії
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  overlay.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  overlay.addEventListener("touchstart", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
      e.preventDefault();
    },
    { passive: false },
  );
  overlay.addEventListener("contextmenu", (e) => {
    e.stopPropagation();
    e.preventDefault();
  });

  modalContent.appendChild(overlay);
}

function removeLockOverlay(): void {
  const overlay = document.getElementById(LOCK_OVERLAY_ID);
  if (overlay) overlay.remove();
}
