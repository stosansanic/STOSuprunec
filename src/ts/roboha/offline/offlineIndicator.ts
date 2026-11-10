// src/ts/roboha/offline/offlineIndicator.ts
// 📵 UI-індикатор стану мережі + кількість незбережених змін

import {
  onOfflineStatusChange,
  isAppOnline,
  getPendingCount,
  forceSyncNow,
} from "./offlineSync";
import { canExportOfflineRecovery, listOfflineRecoveryStores, exportOfflineRecoveryStore } from "./offlineDB";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

let indicatorEl: HTMLDivElement | null = null;

/**
 * Створює та додає індикатор офлайн-статусу в DOM.
 * Відображається: 📵 при відсутності мережі + бейдж з кількістю в черзі.
 */
export function initOfflineIndicator(): void {
  if (indicatorEl) return;

  indicatorEl = document.createElement("div");
  indicatorEl.className = "offline-indicator";
  indicatorEl.id = "offline-indicator";
  indicatorEl.title = "Стан зʼєднання";
  indicatorEl.innerHTML = `
    <span class="offline-icon" id="offline-icon">📶</span>
    <span class="offline-badge" id="offline-badge" style="display:none;">0</span>
  `;

  document.body.appendChild(indicatorEl);
  const recovery = document.createElement("button");
  recovery.type = "button";
  recovery.textContent = "Експорт офлайн-чернеток";
  recovery.title = "Для адміністратора: зберегти чернетки цього пристрою у файл для ручної перевірки";
  recovery.hidden = !canExportOfflineRecovery();
  const refreshRecoveryAccess = () => { recovery.hidden = !canExportOfflineRecovery(); };
  window.addEventListener("focus", refreshRecoveryAccess);
  window.addEventListener("storage", refreshRecoveryAccess);
  recovery.addEventListener("click", async event => {
    event.stopPropagation();
    recovery.disabled = true;
    const actor = localStorage.getItem("userAuthData");
    try {
      const archives = [];
      for (const name of await listOfflineRecoveryStores()) {
        const archive = await exportOfflineRecoveryStore(name);
        if (archive.stores.syncQueue?.length) archives.push(archive);
      }
      if (!canExportOfflineRecovery() || localStorage.getItem("userAuthData") !== actor) throw new Error("Користувач змінився");
      if (!archives.length) { showNotification("Збережених офлайн-чернеток немає", "info"); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),archives},null,2)],{type:"application/json"}));
      const link = document.createElement("a");
      link.href = url; link.download = "sto-offline-drafts-" + new Date().toISOString().slice(0,10) + ".json";
      link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch(error) { showNotification(error instanceof Error ? error.message : "Не вдалося експортувати чернетки", "warning"); }
    finally { recovery.disabled = false; }
  });
  indicatorEl.appendChild(recovery);

  // Клік — примусова синхронізація
  indicatorEl.addEventListener("click", async () => {
    if (!isAppOnline()) return;
    const count = await getPendingCount();
    if (count > 0) {
      indicatorEl!.classList.add("offline-syncing");
      await forceSyncNow();
      indicatorEl!.classList.remove("offline-syncing");
    }
  });

  // Підписка на зміну статусу
  onOfflineStatusChange((online, pendingCount) => {
    recovery.hidden = !canExportOfflineRecovery();
    updateIndicator(online, pendingCount);
  });

  // Початковий стан
  getPendingCount()
    .then((count) => updateIndicator(navigator.onLine, count))
    .catch(() => updateIndicator(navigator.onLine, 0));
}

function updateIndicator(online: boolean, pendingCount: number): void {
  if (!indicatorEl) return;

  const icon = indicatorEl.querySelector("#offline-icon") as HTMLElement;
  const badge = indicatorEl.querySelector("#offline-badge") as HTMLElement;

  if (!online) {
    icon.textContent = "📵";
    indicatorEl.classList.add("offline-disconnected");
    indicatorEl.classList.remove("offline-connected", "offline-pending");
    indicatorEl.title = "Немає зʼєднання — зміни зберігаються локально";
  } else if (pendingCount > 0) {
    icon.textContent = "🔄";
    indicatorEl.classList.add("offline-pending");
    indicatorEl.classList.remove("offline-disconnected", "offline-connected");
    indicatorEl.title = `${pendingCount} змін очікують синхронізації (натисніть)`;
  } else {
    icon.textContent = "📶";
    indicatorEl.classList.add("offline-connected");
    indicatorEl.classList.remove("offline-disconnected", "offline-pending");
    indicatorEl.title = "Онлайн";
  }

  if (pendingCount > 0) {
    badge.textContent = String(pendingCount);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}
