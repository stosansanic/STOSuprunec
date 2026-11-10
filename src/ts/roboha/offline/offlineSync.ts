// src/ts/roboha/offline/offlineSync.ts
// 📵 Автосинхронізація offline-змін при відновленні зʼєднання
// Черга відкладених операцій (queue-based sync)

import { ACT_REVISION_KEY, ActWriteConflict, readActJson, readActSnapshot, stableActJson, writeActSnapshotWithStock } from "../../utils/actSafeWrite";
import { supabase } from "../../vxid/supabaseClient";
import {
  getSyncQueue,
  removeSyncQueueItem,
  addToSyncQueue,
  getSyncQueueCount,
  refreshOfflineCache,
  updateCachedAct,
  getCachedAct,
  type SyncQueueItem,
} from "./offlineDB";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { offlineScope, assertOfflineScope, OfflineOwnerChanged } from "./offlineOwner";

// ===================== СТАН =====================

let isSyncing = false;
let isOnline = navigator.onLine;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let initialRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let warmSnapshot = true;

interface OfflineSyncOptions {
  /** Keep queue replay active even when this page does not need a full snapshot. */
  warmSnapshot?: boolean;
}

type StatusChangeListener = (online: boolean, pendingCount: number) => void;
const statusListeners: StatusChangeListener[] = [];

// ===================== ІНІЦІАЛІЗАЦІЯ =====================

/**
 * Запуск моніторингу мережі та автосинхронізації.
 * Викликати 1 раз при старті додатку.
 */
export function initOfflineSync(options: OfflineSyncOptions = {}): void {
  if (syncIntervalId) return;
  isOnline = navigator.onLine;
  warmSnapshot = options.warmSnapshot ?? true;

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);

  // Періодична перевірка + синхронізація (кожні 30с)
  syncIntervalId = setInterval(async () => {
    if (navigator.onLine && !isSyncing) {
      await processQueue();
    }
    notifyStatusListeners();
  }, 30_000);

  // Перша синхронізація кешу при старті (якщо онлайн)
  if (isOnline && warmSnapshot) {
    initialRefreshTimer = setTimeout(() => {
      initialRefreshTimer = null;
      refreshOfflineCache(supabase).catch(() => {});
    }, 5_000);
  }

  notifyStatusListeners();
}

export function destroyOfflineSync(): void {
  if (initialRefreshTimer) clearTimeout(initialRefreshTimer);
  initialRefreshTimer = null;
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
}

// ===================== МЕРЕЖЕВІ ПОДІЇ =====================

async function handleOnline(): Promise<void> {
  isOnline = true;
  notifyStatusListeners();

  const pendingCount = await getSyncQueueCount();
  if (pendingCount > 0) {
    showNotification(
      `📶 Зʼєднання відновлено! Синхронізація ${pendingCount} змін...`,
      "info",
    );
    await processQueue();
  } else {
    showNotification("📶 Зʼєднання відновлено", "success", 2000);
  }

  // Оновити кеш при поверненні в онлайн
  if (warmSnapshot) refreshOfflineCache(supabase).catch(() => {});
}

function handleOffline(): void {
  isOnline = false;
  notifyStatusListeners();
  showNotification(
    "📵 Немає зʼєднання. Зміни зберігатимуться локально.",
    "warning",
    4000,
  );
}

// ===================== ЧЕРГА ОПЕРАЦІЙ =====================

/**
 * Додає операцію оновлення акту в офлайн-чергу.
 * Також оновлює кеш в IndexedDB.
 */
export async function enqueueActUpdate(
  actId: number,
  updatedData: any,
  avansValue?: number,
  expectedData?: any,
): Promise<void> {
  const scope = offlineScope();
  assertOfflineScope(scope);
  // Зберігаємо в чергу
  await addToSyncQueue({
    timestamp: Date.now(),
    operation: "update_act",
    table: "acts",
    recordId: actId,
    payload: { data: updatedData, avans: avansValue, expectedData },
    retries: 0,
  });

  // Оновлюємо локальний кеш акту
  assertOfflineScope(scope);
  const cached = await getCachedAct(actId);
  assertOfflineScope(scope);
  if (cached) {
    cached.data = updatedData;
    if (avansValue !== undefined) cached.avans = avansValue;
    await updateCachedAct(cached);
  }

  notifyStatusListeners();
}

/**
 * Додає довільне оновлення поля акту в чергу
 */
export async function enqueueActFieldUpdate(
  actId: number,
  fieldUpdates: Record<string, any>,
): Promise<void> {
  await addToSyncQueue({
    timestamp: Date.now(),
    operation: "update_act_field",
    table: "acts",
    recordId: actId,
    payload: fieldUpdates,
    retries: 0,
  });

  notifyStatusListeners();
}

// ===================== ОБРОБКА ЧЕРГИ =====================

const MAX_RETRIES = 5;

/**
 * Обробляє всю чергу відкладених змін.
 * Виконується при поверненні онлайн + по таймеру.
 */
async function processQueue(): Promise<void> {
  if (isSyncing || !navigator.onLine) return;
  const scope = offlineScope();
  if (!scope) return;
  isSyncing = true;

  try {
    const queue = await getSyncQueue();
    assertOfflineScope(scope);
    if (queue.length === 0) {
      isSyncing = false;
      return;
    }

    // Сортуємо по timestamp (FIFO)
    queue.sort((a, b) => a.timestamp - b.timestamp);

    let successCount = 0;
    let failCount = 0;

    for (const item of queue) {
      if (offlineScope() !== scope) break;
      if (item.blockedReason) continue;
      try {
        await processSingleItem(item, scope);
        assertOfflineScope(scope);
        await removeSyncQueueItem(item.id!, item.owner);
        successCount++;
      } catch (error) {
        if (error instanceof OfflineOwnerChanged || offlineScope() !== scope) break;
        // Збільшуємо лічильник спроб
        if (error instanceof ActWriteConflict || item.retries >= MAX_RETRIES) {
          // Конфлікт — це дані користувача, а не сміття. Залишаємо для розбору.
          const blockedReason = error instanceof Error ? error.message : "Не вдалося синхронізувати";
          await addToSyncQueue({ ...item, blockedReason });
          showNotification(`Акт №${item.recordId}: локальні зміни збережені, але не синхронізовані. ${blockedReason}`, "warning", 8000);
          failCount++;
        } else {
          // Оновлюємо retries (re-add з оновленим лічильником)
          await addToSyncQueue({
            ...item,
            retries: item.retries + 1,
          } as Omit<SyncQueueItem, "id">);
        }
      }
    }

    if (successCount > 0) {
      showNotification(
        `✅ Синхронізовано ${successCount} змін${failCount > 0 ? ` (${failCount} помилок)` : ""}`,
        failCount > 0 ? "warning" : "success",
      );
    }

    notifyStatusListeners();
  } catch (error) {
    if (!(error instanceof OfflineOwnerChanged)) throw error;
  } finally {
    isSyncing = false;
  }
}

async function processSingleItem(item: SyncQueueItem, scope: string): Promise<void> {
  assertOfflineScope(scope);
  if (!item.owner) throw new OfflineOwnerChanged();
  switch (item.operation) {
    case "update_act": {
      const { data: actPayload, avans, expectedData } = item.payload;
      if (expectedData === undefined) throw new ActWriteConflict("Стара офлайн-копія без контрольної версії. Потрібна ручна перевірка.");
      const fresh = await readActSnapshot(item.recordId);
      assertOfflineScope(scope);
      const withoutRevision = (data: any) => {
        const copy = { ...readActJson(data) };
        delete copy[ACT_REVISION_KEY];
        return copy;
      };
      // A lost HTTP response may mean the previous request already committed.
      if (stableActJson(withoutRevision(fresh.data)) === stableActJson(withoutRevision(actPayload)) &&
        (avans === undefined || Number(fresh.avans ?? 0) === Number(avans))) break;
      await writeActSnapshotWithStock(item.recordId, expectedData, actPayload, { avans });
      break;
    }

    case "update_act_field": {
      // No current caller needs automatic field replay. Legacy operations have
      // no baseline and can include a whole data object or reopen a closed act.
      throw new ActWriteConflict("Відкладена зміна полів потребує ручної перевірки.");
    }

    default:
      throw new ActWriteConflict("Невідома офлайн-операція. Чернетка збережена для ручної перевірки.");
  }
}

// ===================== ПЕРЕВІРКИ СТАНУ =====================

/**
 * Чи є зараз інтернет-зʼєднання
 */
export function isAppOnline(): boolean {
  return navigator.onLine;
}

/**
 * Чи є залишені в черзі зміни
 */
export async function hasPendingChanges(): Promise<boolean> {
  return (await getSyncQueueCount()) > 0;
}

/**
 * Кількість змін в черзі
 */
export async function getPendingCount(): Promise<number> {
  return getSyncQueueCount();
}

/**
 * Примусова синхронізація
 */
export async function forceSyncNow(): Promise<void> {
  if (!navigator.onLine) {
    showNotification("📵 Немає зʼєднання для синхронізації", "warning");
    return;
  }
  await processQueue();
}

// ===================== СЛУХАЧІ СТАТУСУ =====================

export function onOfflineStatusChange(
  listener: StatusChangeListener,
): () => void {
  statusListeners.push(listener);
  // Повернути функцію відписки
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx >= 0) statusListeners.splice(idx, 1);
  };
}

async function notifyStatusListeners(): Promise<void> {
  const count = await getSyncQueueCount().catch(() => 0);
  for (const listener of statusListeners) {
    try {
      listener(navigator.onLine, count);
    } catch {
      // ігноруємо помилки слухачів
    }
  }
}
