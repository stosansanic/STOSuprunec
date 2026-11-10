// src/ts/roboha/zakaz_naraudy/inhi/settings_subscription.ts
/**
 * Real-time підписка на зміни в таблиці settings
 * Автоматично оновлює інтерфейс при зміні налаштувань адміністратором
 * для ВСІХ ролей: Адміністратор, Приймальник, Слюсар, Запчастист, Складовщик
 */

import { supabase } from "../../../vxid/supabaseClient";
import { globalCache } from "../globalCache";
import { showNotification } from "./vspluvauhe_povidomlenna";
import {
  userAccessLevel,
  updateUIBasedOnAccess,
  clearSettingsCache,
  loadRoleSettingsToCache,
  canUserSeeZarplataColumn,
  canUserSeePriceColumns,
  getCachedSettingForRole,
  getCachedRoleSettingsSnapshot,
} from "../../tablucya/users";
import { databaseSubscriptions, type DatabaseSubscription } from "../../../utils/databaseSubscriptions";
import { refreshActsTable } from "../../tablucya/tablucya";
import { createSettingsUiChangeTracker, SETTINGS_REALTIME_COLUMNS } from "../../../utils/settingsUiChanges";
import { invalidateNovaPoshtaSettingCache } from "../../../utils/novaPoshtaMenu";

let settingsChannel: DatabaseSubscription | null = null;
let settingsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let settingsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let settingsGeneration = 0;
let settingsRefreshPending: Promise<void> | null = null;
let settingsRefreshQueued = false;
let settingsNotifyQueued = false;
let settingsRecoveryNeeded = false;
let settingsRecoveryRetryUsed = false;
let settingsRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let settingsRecoveryNextAllowedAt = 0;
const SETTINGS_RECOVERY_RETRY_MS = 2_000;
const SETTINGS_RECOVERY_COOLDOWN_MS = 30_000;
let settingsTrackerRole: string | null | undefined;
let settingsTracker = createSettingsUiChangeTracker(null);

function seedRoleSettingsBaseline(): void {
  const cached = getCachedRoleSettingsSnapshot();
  if (!cached) return;
  for (const [key, value] of Object.entries(cached)) {
    const separator = key.indexOf(":");
    if (separator < 0) continue;
    settingsTracker.seed({
      setting_id: Number(key.slice(0, separator)),
      [key.slice(separator + 1)]: value,
    });
  }
}

function currentSettingsTracker() {
  if (settingsTrackerRole !== userAccessLevel) {
    settingsTrackerRole = userAccessLevel;
    settingsTracker = createSettingsUiChangeTracker(userAccessLevel);
    seedRoleSettingsBaseline();
  }
  return settingsTracker;
}

function resetSettingsRefreshRecovery(): void {
  if (settingsRecoveryTimer) clearTimeout(settingsRecoveryTimer);
  settingsRecoveryTimer = null;
  settingsRecoveryNeeded = false;
  settingsRecoveryRetryUsed = false;
  settingsRecoveryNextAllowedAt = 0;
}

function planSettingsRefreshRecovery(generation: number): void {
  if (generation !== settingsGeneration) return;
  settingsRecoveryNeeded = true;
  settingsRefreshQueued = false;
  settingsNotifyQueued = false;
  settingsRecoveryNextAllowedAt = Date.now() + (
    settingsRecoveryRetryUsed ? SETTINGS_RECOVERY_COOLDOWN_MS : SETTINGS_RECOVERY_RETRY_MS
  );
  if (settingsRecoveryRetryUsed) return;
  settingsRecoveryRetryUsed = true;
  // One automatic retry per failure episode. Continued outages only retry on
  // a later event, at most once per cooldown, rather than starting a poll loop.
  settingsRecoveryTimer = setTimeout(() => {
    settingsRecoveryTimer = null;
    if (generation === settingsGeneration && settingsChannel && settingsRecoveryNeeded) {
      scheduleSettingsRefresh(false);
    }
  }, SETTINGS_RECOVERY_RETRY_MS);
}

function scheduleSettingsRefresh(notify = false): void {
  if (settingsRecoveryNeeded) {
    if (Date.now() < settingsRecoveryNextAllowedAt) return;
    notify = false;
  }
  settingsRefreshQueued = true;
  settingsNotifyQueued ||= notify;
  if(settingsRefreshTimer || settingsRefreshPending) return;
  const generation = settingsGeneration;
  settingsRefreshTimer = setTimeout(() => {
    settingsRefreshTimer = null;
    const refresh = (async () => {
      do {
        settingsRefreshQueued = false;
        const shouldNotify = settingsNotifyQueued;
        settingsNotifyQueued = false;
        const refreshed = await refreshSettingsCache();
        if(generation !== settingsGeneration) return;
        if (!refreshed) {
          planSettingsRefreshRecovery(generation);
          return;
        }
        try {
          await updateUIBasedOnSettings();
        } catch {
          planSettingsRefreshRecovery(generation);
          return;
        }
        if(generation !== settingsGeneration) return;
        resetSettingsRefreshRecovery();
        if (shouldNotify) showSettingsNotification();
      } while(settingsRefreshQueued);
    })();
    settingsRefreshPending = refresh;
    void refresh.finally(() => {
      if(settingsRefreshPending === refresh) settingsRefreshPending = null;
      if(settingsRefreshQueued && settingsChannel) scheduleSettingsRefresh();
    }).catch(()=>{});
  },100);
}

// Дебаунс для повідомлення — щоб не спамило при множинніх змінах
let _notifDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function showSettingsNotification(): void {
  if (_notifDebounceTimer) clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = setTimeout(() => {
    _notifDebounceTimer = null;
    showNotification("⚙️ Налаштування оновлено", "info", 3500);
  }, 800);
}

async function refreshSettingsCache(): Promise<boolean> {
  const generation = settingsGeneration;
  const tracker = currentSettingsTracker();
  const revision = tracker.revision;
  const role = userAccessLevel;
  try {
    // Оновлюємо localStorage кеш ролі
    clearSettingsCache();
    await loadRoleSettingsToCache();

    const generalIds = [1, 2, 3, 5];
    const roleSnapshot = getCachedRoleSettingsSnapshot();
    // loadRoleSettingsToCache deliberately absorbs HTTP errors. After clearing
    // its old value, a missing snapshot means rights were NOT refreshed.
    if (role && role !== "Адміністратор" && !roleSnapshot) return false;
    let settingsRows: Array<{ setting_id: number; data: unknown }>;
    if (role && role !== "Адміністратор" && roleSnapshot && generalIds.every(id => Object.prototype.hasOwnProperty.call(roleSnapshot, `${id}:data`))) {
      // The fresh role response already contains these four values.
      settingsRows = generalIds.map(id => ({ setting_id: id, data: roleSnapshot[`${id}:data`] }));
    } else {
      const { data, error } = await supabase
        .from("settings")
        .select("setting_id, data")
        .in("setting_id", generalIds);
      if (error) return false;
      settingsRows = data || [];
    }
    if (generation !== settingsGeneration || role !== userAccessLevel) return false;
    const settingShop = settingsRows?.find((s: any) => s.setting_id === 1);
    const settingCatalog = settingsRows?.find((s: any) => s.setting_id === 2);
    const settingZarplata = settingsRows?.find((s: any) => s.setting_id === 3);
    const settingSMS = settingsRows?.find((s: any) => s.setting_id === 5);
    globalCache.settings = {
      showPibMagazin: !!settingShop?.data,
      showCatalog: !!settingCatalog?.data,
      showZarplata: !!settingZarplata?.data,
      showSMS: !!settingSMS?.data,
      preferredLanguage: globalCache.settings.preferredLanguage,
      saveMargins: globalCache.settings.saveMargins,
    };
    // Do not overwrite a newer Realtime value with an older in-flight snapshot.
    if (settingsTracker === tracker && tracker.revision === revision) {
      seedRoleSettingsBaseline();
      for (const row of settingsRows || []) tracker.seed(row);
    }
    return true;
  } catch (error) {
    // console.error("❌ Помилка оновлення settings:", error);
    return false;
  }
}

function findElementsByText(selector: string, text: string): HTMLElement[] {
  const elements = document.querySelectorAll(selector);
  const found: HTMLElement[] = [];
  elements.forEach((el) => {
    if (el.textContent?.includes(text)) found.push(el as HTMLElement);
  });
  return found;
}

function updatePibMagazinVisibility(): void {
  const show = globalCache.settings.showPibMagazin;
  const headers = findElementsByText("th", "ПІБ _ Магазин");
  const cells = document.querySelectorAll(
    'td.pib-magazin-cell, td[data-name="pib_magazin"]',
  );
  headers.forEach((h) => (h.style.display = show ? "" : "none"));
  cells.forEach((c) => ((c as HTMLElement).style.display = show ? "" : "none"));
}

function updateCatalogVisibility(): void {
  const show = globalCache.settings.showCatalog;
  const headers = findElementsByText("th", "Каталог");
  const cells = document.querySelectorAll(
    'td.catalog-cell, td[data-name="catalog"]',
  );
  headers.forEach((h) => (h.style.display = show ? "" : "none"));
  cells.forEach((c) => ((c as HTMLElement).style.display = show ? "" : "none"));
}

async function updateZarplataVisibility(): Promise<void> {
  // Визначаємо видимість по ролі (з кешу)
  const show = await canUserSeeZarplataColumn();
  globalCache.settings.showZarplata = show;
  const headers = findElementsByText("th", "Зар-та");
  const cells = document.querySelectorAll(
    'td.slyusar-sum-cell, td[data-name="slyusar_sum"]',
  );
  headers.forEach((h) => (h.style.display = show ? "" : "none"));
  cells.forEach((c) => ((c as HTMLElement).style.display = show ? "" : "none"));
}

function updateSMSButtonVisibility(): void {
  // SMS кнопки в актах тепер контролюються через ролеві налаштування (20, 21, 18)
  // і оновлюються через updateActButtonsVisibility()
  // Тут залишаємо тільки для глобальних SMS кнопок (якщо є)
  const show = globalCache.settings.showSMS;
  const btns = document.querySelectorAll(
    '[data-action="send-sms"]:not(#sms-btn), .sms-button:not(#sms-btn)',
  );
  btns.forEach((b) => ((b as HTMLElement).style.display = show ? "" : "none"));
}

async function updateMenuVisibility(): Promise<void> {
  try {
    // Кеш вже оновлений у refreshSettingsCache(), тут тільки оновлюємо UI
    await updateUIBasedOnAccess(userAccessLevel);
  } catch (error) {
    // console.error("❌ Помилка оновлення меню:", error);
  }
}

/**
 * Оновлює видимість кнопок і колонок в акті на основі налаштувань ролі (з кешу)
 */
async function updateActButtonsVisibility(): Promise<void> {
  if (userAccessLevel === "Адміністратор") return; // Адмін бачить все

  try {
    const roleColumn = userAccessLevel;
    if (!roleColumn) return;

    // Мапа: роль → setting_id → дія (селектор або функція)
    const roleActionMap: Record<
      string,
      Record<number, { type: "selector" | "column"; value: string }>
    > = {
      Слюсар: {
        1: { type: "column", value: "zarplata" }, // Зарплата колонка
        2: { type: "column", value: "price" }, // Ціна та Сума колонки
        3: { type: "selector", value: "#status-lock-btn" },
        4: { type: "selector", value: "#status-lock-btn" },
        5: { type: "selector", value: "#status-lock-btn" },
      },
      Приймальник: {
        14: { type: "column", value: "zarplata" }, // Зарплата колонка
        15: { type: "column", value: "price" }, // Ціна та Сума колонки
        16: { type: "selector", value: "#status-lock-btn" },
        17: { type: "selector", value: "#status-lock-btn" },
        18: { type: "selector", value: "#create-act-btn" },
        19: { type: "selector", value: "#print-act-button" },
        20: { type: "selector", value: "#sms-btn" },
      },
      Запчастист: {
        14: { type: "column", value: "zarplata" }, // Зарплата колонка
        15: { type: "column", value: "price" }, // Ціна та Сума колонки
        16: { type: "selector", value: "#status-lock-btn" },
        17: { type: "selector", value: "#status-lock-btn" },
        18: { type: "selector", value: "#status-lock-btn" },
        19: { type: "selector", value: "#create-act-btn" },
        20: { type: "selector", value: "#print-act-button" },
        21: { type: "selector", value: "#sms-btn" },
      },
      Складовщик: {
        11: { type: "column", value: "zarplata" }, // Зарплата колонка
        12: { type: "column", value: "price" }, // Ціна та Сума колонки
        13: { type: "selector", value: "#status-lock-btn" },
        14: { type: "selector", value: "#status-lock-btn" },
        15: { type: "selector", value: "#status-lock-btn" },
        16: { type: "selector", value: "#create-act-btn" },
        17: { type: "selector", value: "#print-act-button" },
        18: { type: "selector", value: "#sms-btn" },
      },
    };

    const actionMap = roleActionMap[roleColumn];
    if (!actionMap) return;

    // Оновлюємо видимість по кожному setting — читаємо з кешу (0 запитів до БД)
    for (const [sidStr, action] of Object.entries(actionMap)) {
      const settingId = Number(sidStr);

      if (action.type === "column") {
        // Колонки оновлюються через canUserSeeZarplataColumn / canUserSeePriceColumns
        // Вони вже оброблені в updateZarplataVisibility / togglePriceColumnsVisibility
        continue;
      }

      // Для кнопок — читаємо з кешу через canUserSeeZarplataColumn-подібний механізм
      const allowed = await getCachedSettingForRole(settingId, roleColumn);
      const buttons = document.querySelectorAll(action.value);
      buttons.forEach((btn) => {
        (btn as HTMLElement).style.display = allowed ? "" : "none";
      });
    }
  } catch (error) {
    // console.error("❌ Помилка оновлення кнопок актів:", error);
  }
}

/**
 * Приховує/показує колонки Ціна та Сума в таблиці акту
 */
function togglePriceColumnsVisibility(show: boolean): void {
  // Заголовки колонок
  const headers = document.querySelectorAll("th");
  headers.forEach((h) => {
    const text = h.textContent?.trim();
    if (text === "Ціна" || text === "Сума") {
      (h as HTMLElement).style.display = show ? "" : "none";
    }
  });

  // Комірки з даними ціни та суми
  const priceCells = document.querySelectorAll(
    'td[data-name="price"], td.price-cell',
  );
  const sumCells = document.querySelectorAll(
    'td[data-name="sum"], td.sum-cell',
  );

  priceCells.forEach((cell) => {
    (cell as HTMLElement).style.display = show ? "" : "none";
  });

  sumCells.forEach((cell) => {
    (cell as HTMLElement).style.display = show ? "" : "none";
  });

  // ✅ Також приховуємо/показуємо футер з сумами
  const sumsFooter = document.querySelector<HTMLElement>(
    ".zakaz_narayd-sums-footer",
  );
  if (sumsFooter) {
    sumsFooter.style.display = show ? "" : "none";
  }

  // ✅ Також оновлюємо стовпець "Сума" в таблиці списку актів
  toggleActsTableSumaColumn(show);
}

/**
 * Приховує/показує стовпець "Сума" в таблиці списку актів (без перезавантаження)
 */
function toggleActsTableSumaColumn(show: boolean): void {
  const actsTable = document.querySelector(
    "#table-container-modal-sakaz_narad table",
  );
  if (!actsTable) return;

  const displayValue = show ? "" : "none";

  // Знаходимо індекс стовпця "Сума" в заголовку
  const headers = actsTable.querySelectorAll("thead th");
  let sumaColumnIndex = -1;

  headers.forEach((th, index) => {
    if (th.textContent?.includes("Сума")) {
      sumaColumnIndex = index;
      (th as HTMLElement).style.display = displayValue;
    }
  });

  // Якщо стовпець "Сума" не існує і потрібно показати - перезавантажуємо таблицю
  if (sumaColumnIndex === -1 && show) {
    refreshActsTable().catch(() => {
      /* silent */
    });
    return;
  }

  // Якщо стовпець існує - приховуємо/показуємо комірки в рядках
  if (sumaColumnIndex !== -1) {
    const rows = actsTable.querySelectorAll("tbody tr");
    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      if (cells[sumaColumnIndex]) {
        (cells[sumaColumnIndex] as HTMLElement).style.display = displayValue;
      }
    });
  }
}

async function updateUIBasedOnSettings(): Promise<void> {
  updatePibMagazinVisibility();
  updateCatalogVisibility();
  await updateZarplataVisibility();
  updateSMSButtonVisibility();

  // Оновлюємо Ціна/Сума по ролі (з кешу)
  const canSeePriceCols = await canUserSeePriceColumns();
  togglePriceColumnsVisibility(canSeePriceCols);

  await updateActButtonsVisibility();
  await updateMenuVisibility();
}

async function handleSettingsChange(payload: any): Promise<void> {
  const change = currentSettingsTracker().inspect(payload);
  if (change !== "ignore") scheduleSettingsRefresh(change === "changed");
  else if (settingsRecoveryNeeded && !settingsRefreshTimer && !settingsRefreshPending) {
    // The projection may already contain the last received permission while
    // HTTP refresh failed. An identical later event can resume recovery.
    scheduleSettingsRefresh(false);
  }
}

let settingsErrorLogged = false;
let settingsRetryCount = 0;
const MAX_SETTINGS_RETRIES = 5;

export function initializeSettingsSubscription(reconcile = true): void {
  disconnectSettingsSubscription();
  let needsReconciliation = reconcile;
  settingsErrorLogged = false;
  settingsRetryCount = 0;

  try {
    settingsChannel = databaseSubscriptions.subscribe(
        { event: "*", schema: "public", table: "settings", select: SETTINGS_REALTIME_COLUMNS },
        handleSettingsChange,
      (status) => {
        if (status === "SUBSCRIBED") {
          if(needsReconciliation) {
            invalidateNovaPoshtaSettingCache();
            scheduleSettingsRefresh(false);
          }
          needsReconciliation = false;
          settingsErrorLogged = false;
          settingsRetryCount = 0;
        } else if (status === "TIMED_OUT" || status === "CLOSED") {
          needsReconciliation = true;
        } else if (status === "CHANNEL_ERROR") {
          needsReconciliation = true;
          settingsRetryCount++;
          if (!settingsErrorLogged) {
            settingsErrorLogged = true;
          }
          if (settingsRetryCount >= MAX_SETTINGS_RETRIES) {
            settingsChannel?.unsubscribe();
            settingsChannel = null;
            // Перепідключення з exponential backoff
            const delay = Math.min(
              5000 * Math.pow(2, settingsRetryCount - MAX_SETTINGS_RETRIES),
              60000,
            );
            settingsRetryTimer = setTimeout(() => {
              settingsRetryTimer = null;
              initializeSettingsSubscription(true);
            }, delay);
          }
        }
      }, "settings-ui");
    // Reconcile after readiness (including its replay for a shared channel),
    // so changes during the capability probe/initial join are not missed.
  } catch (error) {
    // console.error("❌ Помилка ініціалізації:", error);
  }
}

export function disconnectSettingsSubscription(): void {
  settingsGeneration++;
  resetSettingsRefreshRecovery();
  if(settingsRetryTimer) clearTimeout(settingsRetryTimer);
  settingsRetryTimer = null;
  if(settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = null;
  if(_notifDebounceTimer) clearTimeout(_notifDebounceTimer);
  _notifDebounceTimer = null;
  settingsRefreshQueued = false;
  settingsNotifyQueued = false;
  if (settingsChannel) {
    settingsChannel.unsubscribe();
    settingsChannel = null;
  }
}

export function isSettingsSubscriptionActive(): boolean {
  return settingsChannel !== null;
}

/**
 * Експортуємо функції для використання в інших модулях
 */
export { updateActButtonsVisibility, updateUIBasedOnSettings };
