import { notify as showAppMessage } from "../../utils/appDialogs";
import { supabase } from "../../vxid/supabaseClient";
import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";
import { SETTINGS_REALTIME_COLUMNS } from "../../utils/settingsUiChanges";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { resetPercentCache } from "../zakaz_naraudy/inhi/kastomna_tabluca";
import {
  invalidateGlobalDataCache,
  globalCache,
  saveGeneralSettingsToLocalStorage,
  applyWallpapers,
  applyFontSizes,
} from "../zakaz_naraudy/globalCache";
import { resetAISettingsCache } from "../ai/aiService";
import { initAIChatButton, resetGeminiKeysCache } from "../ai/aiChat";
import { userAccessLevel } from "../tablucya/users";
import { openDatabaseExport } from "./export/ui";
import {
  applyNovaPoshtaVisibility,
  hasNovaPoshtaSetting,
  readNovaPoshtaSetting,
  saveNovaPoshtaSetting,
  syncNovaPoshtaSetting,
  invalidateNovaPoshtaSettingCache,
} from "../../utils/novaPoshtaMenu";

const SETTINGS = {
  1: { id: "toggle-shop", label: "ПІБ _ Магазин", class: "_shop" },
  2: { id: "toggle-receiver", label: "Каталог", class: "_receiver" },
  3: { id: "toggle-zarplata", label: "Зарплата", class: "_zarplata" },
  4: {
    id: "percentage-value",
    label: "Націнка на запчастина",
    class: "_percentage",
  },
  5: { id: "toggle-sms", label: "SMS", class: "_sms" },
  6: { id: "toggle-print", label: "Шапка акту в кольорі", class: "_print" },
  7: { id: "toggle-ai", label: "🤖 ШІ підказки", class: "_ai" },
  8: { id: "toggle-phone-admin", label: "📞 Телефон", class: "_phone" },
  9: {
    id: "toggle-ai-pro",
    label:
      '<span class="ai-pro-emoji-btn" title="Налаштування API ключів">🤖</span> ШІ Атлас',
    class: "_ai_pro",
  },
  10: {
    id: "toggle-voice-input",
    label: "🎙️ Голосове введення",
    class: "_voice",
  },
};

const ROLES = [
  "Адміністратор",
  "Приймальник",
  "Слюсар",
  "Запчастист",
  "Складовщик",
  "Загальні",
];

function closeSettingsModal(modal: HTMLElement): void {
  modal.classList.add("hidden");
}

const ROLE_COLORS = {
  Адміністратор: {
    button: "linear-gradient(135deg, #4caf50 0%, #45a049 100%)",
    buttonHover: "linear-gradient(135deg, #45a049 0%, #3d8b40 100%)",
    border: "#4caf50",
    "modal-window": "#4caf50",
  },
  Приймальник: {
    button: "linear-gradient(135deg, #2196F3 0%, #1976D2 100%)",
    buttonHover: "linear-gradient(135deg, #1976D2 0%, #1565C0 100%)",
    border: "#2196F3",
    "modal-window": "#2196F3",
  },
  Слюсар: {
    button: "linear-gradient(135deg, #FF9800 0%, #F57C00 100%)",
    buttonHover: "linear-gradient(135deg, #F57C00 0%, #E65100 100%)",
    border: "#FF9800",
    "modal-window": "#FF9800",
  },
  Запчастист: {
    button: "linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%)",
    buttonHover: "linear-gradient(135deg, #7B1FA2 0%, #6A1B9A 100%)",
    border: "#9C27B0",
    "modal-window": "#9C27B0",
  },
  Складовщик: {
    button: "linear-gradient(135deg, #F44336 0%, #D32F2F 100%)",
    buttonHover: "linear-gradient(135deg, #D32F2F 0%, #C62828 100%)",
    border: "#F44336",
    "modal-window": "#F44336",
  },
  Загальні: {
    button: "linear-gradient(135deg, #607D8B 0%, #455A64 100%)",
    buttonHover: "linear-gradient(135deg, #455A64 0%, #37474F 100%)",
    border: "#607D8B",
    "modal-window": "#607D8B",
  },
};

const ROLE_SETTINGS = {
  Приймальник: [
    { id: 1, label: "Налаштування" },
    { divider: true },
    { id: 2, label: "Додати" },
    { id: 3, label: "Додати Співробітники" },
    { divider: true },
    { id: 4, label: "Бухгалтерія" },
    { id: 5, label: "Бухгалтерія 🏪 Склад" },
    { id: 6, label: "Бухгалтерія 🏪 Склад розраховувати💲" },
    { id: 7, label: "Бухгалтерія 🏪 Склад відміна розраховувати 💰" },
    { id: 8, label: "Бухгалтерія 🏪 Склад ↩️ повертати в магазин ⬅️🚚" },
    {
      id: 9,
      label: "Бухгалтерія 🏪 Склад ↩️ відміна повернення в магазин 🚚➡️",
    },
    //{ id: 10, label: "Бухгалтерія 👨‍🔧 Зарплата" },
    //{ id: 11, label: "Бухгалтерія 👨‍🔧 Зарплата розраховувати💲" },
    //{ id: 12, label: "Бухгалтерія 👨‍🔧 Зарплата відміна розраховувати 💰" },
    { id: 13, label: "Бухгалтерія ⚙️ Деталі" },
    { divider: true },
    { id: 14, label: "📋 Акт Зарплата 💲" },
    { id: 15, label: "📋 Акт Ціна та Сума" },
    { id: 16, label: "📋 Акт Закриття акту із зауваженнями ⚠️" },
    { id: 17, label: "📋 Акт Відкриття акту 🔒" },
    { id: 18, label: "📋 Акт Створити Рахунок і Акт виконаних робіт 🗂️" },
    { id: 19, label: "📋 Акт Створити PDF Акту 🖨️" },
    { id: 20, label: "📋 Акт SMS ✉️" },
    { id: 23, label: "📋 Акт 🎙️ Голосове введення", class: "_voice" },
    { id: 24, label: "🤖 ШІ Атлас", class: "_ai_pro" },
    { divider: true },
    { id: 21, label: "Планування" },
    { divider: true },
    { id: 22, label: "Акти Телефон 📞" },
  ],
  Слюсар: [
    { id: 1, label: "📋 Акт Зарплата 💲" },
    { id: 2, label: "📋 Акт Ціна та Сума" },
    { id: 3, label: "📋 Акт Завершення робіт 🗝️" },
    { id: 8, label: "📋 Акт 🎙️ Голосове введення", class: "_voice" },
    { id: 9, label: "🤖 ШІ Атлас", class: "_ai_pro" },
    { divider: true },
    { id: 6, label: "Планування" },
    { divider: true },
    { id: 7, label: "Акти Телефон 📞" },
  ],
  Запчастист: [
    { id: 1, label: "Додати" },
    { divider: true },
    { id: 2, label: "Бухгалтерія" },
    //{ id: 3, label: "Бухгалтерія 👨‍🔧 Зарплата" },
    //{ id: 4, label: "Бухгалтерія 👨‍🔧 Зарплата розраховувати💲" },
    //{ id: 5, label: "Бухгалтерія 👨‍🔧 Зарплата відміна розраховувати 💰" },
    { id: 6, label: "Бухгалтерія 🏪 Склад" },
    { id: 7, label: "Бухгалтерія 🏪 Склад розраховувати💲" },
    { id: 8, label: "Бухгалтерія 🏪 Склад відміна розраховувати 💰" },
    { id: 9, label: "Бухгалтерія 🏪 Склад ↩️ повертати в магазин ⬅️🚚" },
    {
      id: 10,
      label: "Бухгалтерія 🏪 Склад відміна ↩️ повернення в магазин 🚚➡️",
    },
    { id: 11, label: "Бухгалтерія ⚙️ Деталі" },
    { divider: true },
    { id: 12, label: "Відображати всі Акти 📋" },
    { id: 13, label: "Відображати Акт 📋" },
    { divider: true },
    { id: 14, label: "📋 Акт Зарплата" },
    { id: 15, label: "📋 Акт Ціна та Сума" },
    { id: 16, label: "📋 Акт Зариття акту 🗝️" },
    { id: 17, label: "📋 Акт Закриття акту із зауваженнями ⚠️" },
    { id: 18, label: "📋 Акт Відкриття акту 🔒" },
    { id: 19, label: "📋 Акт Створити Рахунок і Акт виконаних робіт 🗂️" },
    { id: 20, label: "📋 Акт Створити PDF Акту 🖨️" },
    { id: 21, label: "📋 Акт SMS ✉️" },
    { id: 22, label: "📋 Акт ➕ Додати рядок 💾 Зберегти зміни 🗑️ Видалити" },
    { id: 25, label: "📋 Акт 🎙️ Голосове введення", class: "_voice" },
    { id: 26, label: "🤖 ШІ Атлас", class: "_ai_pro" },
    { divider: true },
    { id: 23, label: "Планування" },
    { divider: true },
    { id: 24, label: "Акти Телефон 📞" },
  ],
  Складовщик: [
    { id: 1, label: "Додати" },
    { id: 2, label: "Додати Співробітники" },
    { divider: true },
    //{ id: 3, label: "Бухгалтерія 🏪 Склад" },
    { id: 4, label: "Бухгалтерія 🏪 Склад розраховувати💲" },
    { id: 5, label: "Бухгалтерія 🏪 Склад відміна розраховувати 💰" },
    { id: 6, label: "Бухгалтерія 🏪 Склад ↩️ повертати в магазин ⬅️🚚" },
    {
      id: 7,
      label: "Бухгалтерія 🏪 Склад ↩️ відміна повернення в магазин 🚚➡️",
    },
    { id: 8, label: "Бухгалтерія ⚙️ Деталі" },
    { divider: true },
    { id: 9, label: "Відображати всі Акти" },
    { id: 10, label: "Відображати Акт" },
    { divider: true },
    { id: 11, label: "📋 Акт Зарплата 💲" },
    { id: 12, label: "📋 Акт Ціна та Сума" },
    { id: 13, label: "📋 Акт Закриття акту 🗝️" },
    { id: 14, label: "📋 Акт Закриття акту із зауваженнями ⚠️" },
    { id: 15, label: "📋 Акт Відкриття акту 🔒" },
    { id: 16, label: "📋 Акт Створити Рахунок і Акт виконаних робіт 🗂️" },
    { id: 17, label: "📋 Акт Створити PDF Акту 🖨️" },
    { id: 18, label: "📋 Акт SMS ✉️" },
    { id: 19, label: "📋 Акт ➕ Додати рядок 💾 Зберегти зміни 🗑️ Видалити" },
    { id: 22, label: "📋 Акт 🎙️ Голосове введення", class: "_voice" },
    { id: 23, label: "🤖 ШІ Атлас", class: "_ai_pro" },
    { divider: true },
    { id: 20, label: "Планування" },
    { divider: true },
    { id: 21, label: "Акти Телефон 📞" },
  ],
};

// 📞 Конфігурація setting_id для налаштування "Телефон" по ролям
const PHONE_SETTINGS_MAP: Record<
  string,
  { settingId: number; toggleId: number }
> = {
  Адміністратор: { settingId: 8, toggleId: 8 },
  Приймальник: { settingId: 22, toggleId: 22 },
  Слюсар: { settingId: 7, toggleId: 7 },
  Запчастист: { settingId: 24, toggleId: 24 },
  Складовщик: { settingId: 21, toggleId: 21 },
};

// 🎙️ Конфігурація setting_id для налаштування "Голосове введення" по ролям
const VOICE_SETTINGS_MAP: Record<
  string,
  { settingId: number; toggleId: number }
> = {
  Адміністратор: { settingId: 10, toggleId: 10 },
  Приймальник: { settingId: 23, toggleId: 23 },
  Слюсар: { settingId: 8, toggleId: 8 },
  Запчастист: { settingId: 25, toggleId: 25 },
  Складовщик: { settingId: 22, toggleId: 22 },
};

// 🤖 Конфігурація setting_id для налаштування "ШІ Атлас" по ролям
const AI_PRO_SETTINGS_MAP: Record<
  string,
  { settingId: number; toggleId: number }
> = {
  Адміністратор: { settingId: 9, toggleId: 9 },
  Приймальник: { settingId: 24, toggleId: 24 },
  Слюсар: { settingId: 9, toggleId: 9 },
  Запчастист: { settingId: 26, toggleId: 26 },
  Складовщик: { settingId: 23, toggleId: 23 },
};

const ROLE_TO_COLUMN = {
  Адміністратор: "data",
  Приймальник: "Приймальник",
  Слюсар: "Слюсар",
  Запчастист: "Запчастист",
  Складовщик: "Складовщик",
  Загальні: "Загальні",
};

// 🔹 Зберігає початковий стан налаштувань при відкритті модалки
let initialSettingsState: Map<number | string, boolean | number | string> =
  new Map();
const initialAiProKeys = new WeakMap<HTMLElement, string>();

// 🔹 Масив ID складів, які потрібно видалити (procent → null) при збереженні
let pendingDeletedWarehouseIds: Set<number> = new Set();

// 🔹 Масив ID складів, які потрібно заморозити (procent → -1) при збереженні
let pendingFrozenWarehouseIds: Set<number> = new Set();

// 🔹 Масив ID складів, які потрібно активувати (procent → значення з input) при збереженні
let pendingUnfrozenWarehouseIds: Set<number> = new Set();

// Константа за замовчуванням для кольорів
const DEFAULT_COLOR = "#164D25";

/** Застосовує favicon у браузері (замінює або створює <link rel="icon">) */
function applyFavicon(_url: string): void {
  const url = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E";
  let link = document.querySelector(
    'link[rel="icon"]',
  ) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = url;
}

/** Завантажує favicon з БД і застосовує при старті сторінки */
export async function loadAndApplyFavicon(): Promise<void> {
  applyFavicon("");
}

/**
 * 📞 Завантажує та застосовує налаштування відображення індикатора дзвінків
 * Викликати при завантаженні сторінки після авторизації
 */
export async function loadAndApplyPhoneIndicatorSetting(): Promise<void> {
  try {
    // Отримуємо роль користувача з localStorage
    const USER_DATA_KEY = "userAuthData";
    const storedData = localStorage.getItem(USER_DATA_KEY);
    if (!storedData) return;

    const userData = JSON.parse(storedData);
    const role = userData?.["Доступ"] as string;

    if (!role || !PHONE_SETTINGS_MAP[role]) {
      // Якщо роль невідома, показуємо індикатори за замовчуванням
      applyPhoneIndicatorVisibility(true);
      return;
    }

    const { settingId } = PHONE_SETTINGS_MAP[role];
    const column = ROLE_TO_COLUMN[role as keyof typeof ROLE_TO_COLUMN];

    if (!column) {
      applyPhoneIndicatorVisibility(true);
      return;
    }

    // Завантажуємо налаштування з БД
    const { data, error } = await supabase
      .from("settings")
      .select(`"${column}"`)
      .eq("setting_id", settingId)
      .single();

    if (error && error.code !== "PGRST116") {
      // console.warn("Помилка завантаження налаштування телефону:", error);
      applyPhoneIndicatorVisibility(true);
      return;
    }

    // Якщо запису немає або значення true - показуємо індикатори
    const showIndicators = data ? !!data[column] : true;
    applyPhoneIndicatorVisibility(showIndicators);
  } catch (err) {
    // console.error("Помилка застосування налаштування телефону:", err);
    applyPhoneIndicatorVisibility(true);
  }
}

/**
 * Застосовує видимість індикаторів дзвінків через CSS клас на body
 */
function applyPhoneIndicatorVisibility(show: boolean): void {
  if (show) {
    document.body.classList.remove("hide-call-indicators");
  } else {
    document.body.classList.add("hide-call-indicators");
  }
}

/**
 * 🎙️ Завантажує та застосовує налаштування відображення кнопки голосового введення
 * Викликати при завантаженні сторінки після авторизації
 */
export async function loadAndApplyVoiceInputSetting(): Promise<void> {
  try {
    const USER_DATA_KEY = "userAuthData";
    const storedData = localStorage.getItem(USER_DATA_KEY);
    if (!storedData) return;

    const userData = JSON.parse(storedData);
    const role = userData?.["Доступ"] as string;

    if (!role || !VOICE_SETTINGS_MAP[role]) {
      // Якщо роль невідома — приховуємо кнопку голосу за замовчуванням
      applyVoiceInputVisibility(false);
      return;
    }

    const { settingId } = VOICE_SETTINGS_MAP[role];
    const column = ROLE_TO_COLUMN[role as keyof typeof ROLE_TO_COLUMN];

    if (!column) {
      applyVoiceInputVisibility(false);
      return;
    }

    const { data, error } = await supabase
      .from("settings")
      .select(`"${column}"`)
      .eq("setting_id", settingId)
      .single();

    if (error && error.code !== "PGRST116") {
      applyVoiceInputVisibility(false);
      return;
    }

    const showVoice = data ? !!data[column] : false;
    globalCache.generalSettings.voiceInputEnabled = showVoice;
    saveGeneralSettingsToLocalStorage();
    applyVoiceInputVisibility(showVoice);
  } catch (err) {
    applyVoiceInputVisibility(false);
  }
}

/**
 * Застосовує видимість кнопки голосового введення
 */
/**
 * 🤖 Завантажує та застосовує налаштування ШІ Атлас для поточної ролі
 */
export async function loadAndApplyAiProSetting(): Promise<void> {
  try {
    const USER_DATA_KEY = "userAuthData";
    const storedData = localStorage.getItem(USER_DATA_KEY);
    if (!storedData) return;

    const userData = JSON.parse(storedData);
    const role = userData?.["Доступ"] as string;

    if (!role || !AI_PRO_SETTINGS_MAP[role]) {
      return;
    }

    // Адміністратор — його toggle зберігається в data, вже обробляється в globalCache
    if (role === "Адміністратор") return;

    const { settingId } = AI_PRO_SETTINGS_MAP[role];
    const column = ROLE_TO_COLUMN[role as keyof typeof ROLE_TO_COLUMN];

    if (!column) return;

    const { data, error } = await supabase
      .from("settings")
      .select(`"${column}"`)
      .eq("setting_id", settingId)
      .single();

    if (error && error.code !== "PGRST116") return;

    const enabled = data ? !!data[column] : false;
    globalCache.generalSettings.aiChatEnabled = enabled;
    saveGeneralSettingsToLocalStorage();
    if (enabled) {
      initAIChatButton();
    } else {
      const chatBtn = document.getElementById("ai-chat-menu-btn");
      if (chatBtn) chatBtn.closest("li")?.remove();
      const chatModal = document.getElementById("ai-chat-modal");
      if (chatModal) chatModal.classList.add("hidden");
    }
  } catch (_) {
    /* ігноруємо */
  }
}

function applyVoiceInputVisibility(show: boolean): void {
  // Кнопка мікрофона в актах
  const voiceBtn = document.getElementById("voice-input-button");
  if (voiceBtn) {
    voiceBtn.style.display = show ? "" : "none";
  }
  // Кнопка мікрофона в ШІ Атлас
  const voiceBtnAI = document.getElementById("ai-chat-voice-btn");
  if (voiceBtnAI) {
    voiceBtnAI.style.display = show ? "" : "none";
  }
  // Кнопка мікрофона в запчастинах (Excel імпорт)
  const voiceBtnExcel = document.getElementById("voice-input-btn-Excel");
  if (voiceBtnExcel) {
    voiceBtnExcel.style.display = show ? "" : "none";
  }

  // Кнопка мікрофона в планувальнику
  const plannerVoiceBtn = document.getElementById("postVoiceBtn");
  if (plannerVoiceBtn) {
    plannerVoiceBtn.toggleAttribute("hidden", !show);
    plannerVoiceBtn.style.display = show ? "" : "none";
  }
}

// ============================================================
// 🔄 REALTIME СИНХРОНІЗАЦІЯ НАЛАШТУВАНЬ
// ============================================================

let settingsRealtimeChannel: DatabaseSubscription | null = null;
let settingsProjectionScope = "";
const settingsProjections = new Map<number, string>();

function hasGeneralSettingsChange(
  payload: { new?: Record<string, unknown>; old?: Record<string, unknown> },
  scope: string,
): boolean {
  if (scope !== settingsProjectionScope) {
    settingsProjectionScope = scope;
    settingsProjections.clear();
  }
  const record = payload.new;
  const id = Number(record?.setting_id);
  if (!record || !Number.isSafeInteger(id) || id < 1) return false;
  // Technical NP counters and AI token/date fields must not reset UI caches.
  const columns = ["data", "Загальні", "procent", ...Object.values(ROLE_TO_COLUMN)];
  const project = (row: Record<string, unknown>) => Object.fromEntries(
    columns.filter(key => Object.prototype.hasOwnProperty.call(row, key)).map(key => [key, row[key]]),
  );
  const next = project(record);
  if (!Object.keys(next).length) return false;
  const value = JSON.stringify(next);
  let previous = settingsProjections.get(id);
  if (previous === undefined && payload.old && Object.keys(next).every(key => Object.prototype.hasOwnProperty.call(payload.old, key))) {
    previous = JSON.stringify(project(payload.old));
  }
  settingsProjections.set(id, value);
  return previous !== value;
}

/**
 * Підписка на Realtime зміни в таблиці settings
 * Викликати один раз при ініціалізації системи
 */
export function subscribeToSettingsRealtime(): void {
  // Якщо вже підписані — не підписуємося повторно
  if (settingsRealtimeChannel) return;

  settingsRealtimeChannel = databaseSubscriptions.subscribe(
    { event: "*", schema: "public", table: "settings", select: SETTINGS_REALTIME_COLUMNS },
    handleSettingsRealtimeChange,
    status => {
      if (["CLOSED", "TIMED_OUT", "CHANNEL_ERROR"].includes(status)) {
        settingsProjections.clear();
        invalidateNovaPoshtaSettingCache();
      }
    },
    // Both UI consumers use the same Supabase client/JWT, including before login.
    "settings-ui",
  );
}

/**
 * Відписка від Realtime каналу settings
 * Викликати при logout
 */
export function unsubscribeFromSettingsRealtime(): void {
  if (settingsRealtimeChannel) {
    settingsRealtimeChannel.unsubscribe();
    settingsRealtimeChannel = null;
    settingsProjections.clear();
    invalidateNovaPoshtaSettingCache();
    // console.log("📡 Realtime: відписка від settings");
  }
}

/**
 * Обробник Realtime змін в таблиці settings
 */
function handleSettingsRealtimeChange(payload: any): void {
  const { eventType, new: newRecord, old: _oldRecord } = payload;
  void _oldRecord; // Suppress unused variable warning

  if (eventType === "DELETE") {
    settingsProjections.delete(_oldRecord?.setting_id);
    invalidateNovaPoshtaSettingCache();
    return;
  }

  // Отримуємо роль поточного користувача
  const USER_DATA_KEY = "userAuthData";
  const storedData = localStorage.getItem(USER_DATA_KEY);
  if (!storedData) return;

  const userData = JSON.parse(storedData);
  const currentRole = userData?.["Доступ"] as string;
  if (!currentRole) return;

  if (!hasGeneralSettingsChange(payload, storedData)) return;
  syncNovaPoshtaSetting(newRecord);

  const settingId = newRecord?.setting_id;
  if (!settingId) return;

  // Визначаємо колонку для поточної ролі
  const column = ROLE_TO_COLUMN[currentRole as keyof typeof ROLE_TO_COLUMN];
  if (!column) return;

  // console.log(
  // `📡 Realtime settings: ${eventType} setting_id=${settingId}`,
  // newRecord,
  // );

  // === ОБРОБКА НАЛАШТУВАНЬ АДМІНІСТРАТОРА (колонка "data") ===
  if (currentRole === "Адміністратор") {
    handleAdminSettingsChange(settingId, newRecord);
  }

  // === ОБРОБКА НАЛАШТУВАНЬ ІНШИХ РОЛЕЙ ===
  handleRoleSettingsChange(currentRole, column, settingId, newRecord);

  // === ОБРОБКА ЗАГАЛЬНИХ НАЛАШТУВАНЬ (колонка "Загальні") ===
  handleGeneralSettingsChange(settingId, newRecord);
}

/**
 * Обробка змін налаштувань для Адміністратора
 */
function handleAdminSettingsChange(settingId: number, newRecord: any): void {
  const value = newRecord?.data;

  switch (settingId) {
    case 6: // toggle-print
      globalCache.generalSettings.printColorMode = !!value;
      saveGeneralSettingsToLocalStorage();
      break;
    case 7: // toggle-ai
      globalCache.generalSettings.aiEnabled = !!value;
      saveGeneralSettingsToLocalStorage();
      resetAISettingsCache();
      break;
    case 8: // toggle-phone-admin
      applyPhoneIndicatorVisibility(!!value);
      break;
    case 9: // toggle-ai-pro
      globalCache.generalSettings.aiChatEnabled = !!value;
      saveGeneralSettingsToLocalStorage();
      // Одразу показати/приховати кнопку ШІ Атлас в меню
      if (!!value) {
        initAIChatButton();
      } else {
        const chatBtn = document.getElementById("ai-chat-menu-btn");
        if (chatBtn) chatBtn.closest("li")?.remove();
        const chatModal = document.getElementById("ai-chat-modal");
        if (chatModal) chatModal.classList.add("hidden");
      }
      break;
    case 10: // toggle-voice-input
      globalCache.generalSettings.voiceInputEnabled = !!value;
      saveGeneralSettingsToLocalStorage();
      applyVoiceInputVisibility(!!value);
      break;
  }

  // Обробка зміни процентів націнки
  if (newRecord?.procent !== undefined) {
    resetPercentCache();
  }
}

/**
 * Обробка змін налаштувань для конкретної ролі
 */
function handleRoleSettingsChange(
  currentRole: string,
  column: string,
  settingId: number,
  newRecord: any,
): void {
  // Перевіряємо чи ця зміна стосується налаштування "Телефон" для поточної ролі
  const phoneConfig = PHONE_SETTINGS_MAP[currentRole];
  if (phoneConfig && settingId === phoneConfig.settingId) {
    const value = newRecord?.[column];
    if (value !== undefined) {
      applyPhoneIndicatorVisibility(!!value);
      // console.log(
      // `📞 Realtime: оновлено відображення телефону для ${currentRole}: ${!!value}`,
      // );
    }
  }

  // Тут можна додати обробку інших налаштувань ролі при потребі
  // Наприклад, оновлення кешу прав доступу

  // 🎙️ Перевіряємо чи ця зміна стосується налаштування "Голосове введення" для поточної ролі
  const voiceConfig = VOICE_SETTINGS_MAP[currentRole];
  if (voiceConfig && settingId === voiceConfig.settingId) {
    const value = newRecord?.[column];
    if (value !== undefined) {
      globalCache.generalSettings.voiceInputEnabled = !!value;
      saveGeneralSettingsToLocalStorage();
      applyVoiceInputVisibility(!!value);
    }
  }

  // 🤖 Перевіряємо чи ця зміна стосується налаштування "ШІ Атлас" для поточної ролі
  const aiProConfig = AI_PRO_SETTINGS_MAP[currentRole];
  if (
    aiProConfig &&
    settingId === aiProConfig.settingId &&
    currentRole !== "Адміністратор"
  ) {
    const value = newRecord?.[column];
    if (value !== undefined) {
      globalCache.generalSettings.aiChatEnabled = !!value;
      saveGeneralSettingsToLocalStorage();
      if (!!value) {
        initAIChatButton();
      } else {
        const chatBtn = document.getElementById("ai-chat-menu-btn");
        if (chatBtn) chatBtn.closest("li")?.remove();
        const chatModal = document.getElementById("ai-chat-modal");
        if (chatModal) chatModal.classList.add("hidden");
      }
    }
  }
}

/**
 * Обробка змін загальних налаштувань (Загальні)
 */
function handleGeneralSettingsChange(settingId: number, newRecord: any): void {
  const value = newRecord?.["Загальні"];
  if (value === undefined) return;

  switch (settingId) {
    case 1: // Назва СТО
      globalCache.generalSettings.stoName = value || "";
      break;
    case 2: // Адреса
      globalCache.generalSettings.address = value || "";
      break;
    case 3: // Телефон
      globalCache.generalSettings.phone = value || "";
      break;
    case 4: // Колір шапки акту
      globalCache.generalSettings.headerColor = value || DEFAULT_COLOR;
      break;
    case 5: // Колір таблиці актів
      globalCache.generalSettings.tableColor = value || DEFAULT_COLOR;
      break;
    case 7: // Шпалери основні
      globalCache.generalSettings.wallpaperMain = value || "";
      applyWallpapers();
      break;
    case 8: // SMS текст перед сумою
      globalCache.generalSettings.smsTextBefore =
        value || "Ваше замовлення виконане. Сума:";
      break;
    case 9: // SMS текст після суми
      globalCache.generalSettings.smsTextAfter =
        value || "грн. Дякуємо за довіру!";
      break;
  }

  // Зберігаємо оновлені налаштування в localStorage
  if ([1, 2, 3, 4, 5, 7, 8, 9].includes(settingId)) {
    saveGeneralSettingsToLocalStorage();
  }
}

// Генерує HTML для секції "Загальні"
function createGeneralSettingsHTML(): string {
  return `
    <div class="general-settings-container">
      <div class="general-input-group">
        <label class="general-label" for="general-sto-name">
          <span class="general-label-text">🏢 Назва СТО</span>
          <input type="text" id="general-sto-name" class="general-input" placeholder="Введіть назву СТО" />
        </label>
      </div>
      
      <div class="general-input-group">
        <label class="general-label" for="general-address">
          <span class="general-label-text">📍 Адреса</span>
          <input type="text" id="general-address" class="general-input" placeholder="Введіть адресу" />
        </label>
      </div>
      
      <div class="general-input-group">
        <label class="general-label" for="general-phone">
          <span class="general-label-text">📞 Телефон</span>
          <input type="text" id="general-phone" class="general-input" placeholder="Введіть телефон" />
        </label>
      </div>
      
      <div class="settings-divider"></div>
      
      <div class="general-color-group">
        <label class="general-label color-label" for="general-header-color">
          <span class="general-label-text">🎨 Колір шапки акту</span>
          <div class="color-picker-wrapper">
            <input type="color" id="general-header-color" class="color-picker" value="${DEFAULT_COLOR}" />
            <span class="color-value" id="header-color-value">${DEFAULT_COLOR}</span>
          </div>
        </label>
      </div>
      
      <div class="general-color-group">
        <label class="general-label color-label" for="general-table-color">
          <span class="general-label-text">🎨 Колір таблиці актів</span>
          <div class="color-picker-wrapper">
            <input type="color" id="general-table-color" class="color-picker" value="${DEFAULT_COLOR}" />
            <span class="color-value" id="table-color-value">${DEFAULT_COLOR}</span>
          </div>
        </label>
      </div>
      
      <div class="settings-divider"></div>
      
      <div class="general-input-group">
        <label class="general-label" for="general-wallpaper-main">
          <span class="general-label-text">🖼️ Шпалери основні (URL)</span>
          <input type="text" id="general-wallpaper-main" class="general-input" placeholder="Введіть URL зображення для основної сторінки" />
        </label>
      </div>

      <div class="general-input-group">
        <label class="general-label" for="general-logo-url">
          <span class="general-label-text">🖼️ Логотип компанії</span>
          <div class="logo-input-wrapper">
            <input type="text" id="general-logo-url" class="general-input logo-url-input" placeholder="Вставте URL або натисніть 📎 для завантаження" />
            <input type="file" id="general-logo-file" accept="image/*" style="display: none;" />
            <button type="button" id="general-logo-upload-btn" class="logo-upload-icon" title="Завантажити файл">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>
          </div>
        </label>
      </div>

      <div class="general-input-group">
        <label class="general-label" for="general-favicon-url">
          <span class="general-label-text">🌐 Іконка браузера (favicon)</span>
          <div class="logo-input-wrapper">
            <input type="text" id="general-favicon-url" class="general-input logo-url-input" placeholder="Вставте URL або натисніть 📎 для завантаження" />
            <input type="file" id="general-favicon-file" accept="image/*" style="display: none;" />
            <button type="button" id="general-favicon-upload-btn" class="logo-upload-icon" title="Завантажити файл">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>
          </div>
        </label>
      </div>

     <div class="general-input-group font-size-group font-size-group--offset" style="flex-direction: column; align-items: stretch; gap: 15px;">
        <div>
          <label class="general-label" style="margin-bottom: 8px; display: block;">
            <span class="general-label-text">🔡 Розмір тексту в акті (+/- до базових)</span>
          </label>
          <div class="font-size-slider-wrapper">
            <input type="range" id="act-text-offset-slider" class="font-size-slider font-size-slider--offset" min="-5" max="15" value="0" step="1" />
            <div class="font-size-bubble font-size-bubble--offset" id="act-text-offset-bubble">0</div>
          </div>
        </div>

        <div class="settings-divider" style="margin: 0; border-color: rgba(255, 140, 0, 0.2);"></div>

        <div>
          <label class="general-label" style="margin-bottom: 8px; display: block;">
            <span class="general-label-text">📏 Товщина та колір меж таблиці</span>
          </label>
          <div class="font-size-slider-wrapper" style="gap: 15px; margin-top: 5px;">
            <input type="range" id="table-border-width-slider" class="font-size-slider font-size-slider--offset" min="0" max="5" value="1" step="1" />
            <div class="font-size-bubble font-size-bubble--offset" id="table-border-width-bubble">1px</div>
            <input type="color" id="table-border-color" class="color-picker" value="#cccccc" title="Обрати колір межі" style="width: 52px; height: 38px; padding: 0; cursor: pointer; border: 2px solid rgba(255, 140, 0, 0.5); border-radius: 8px; background: #fff;" />
          </div>
        </div>
      </div>
      
      <div class="reset-colors-wrapper">
        <button type="button" id="reset-colors-btn" class="reset-colors-btn">
          🔄 Скинути кольори за замовчуванням
        </button>
      </div>

      
      <div class="settings-divider"></div>
      
      <div class="general-input-group sms-text-group">
        <label class="general-label sms-group-label">
          <span class="general-label-text">📱 Текст SMS повідомлення</span>
          <span class="sms-char-counter" id="sms-char-counter">0 симв.</span>
        </label>
        <div class="sms-preview">
          <span class="sms-text-before-preview" contenteditable="true"></span>
          <span class="sms-sum-example">11 500</span>
          <span class="sms-text-after-preview" contenteditable="true"></span>
        </div>
      </div>


    </div>
  `;
}

// Завантажує дані для секції "Загальні"
async function loadGeneralSettings(modal: HTMLElement): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("setting_id, Загальні, data")
      .in("setting_id", [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15])
      .order("setting_id");

    if (error) throw error;

    // Очищуємо попередній стан
    initialSettingsState.clear();

    data?.forEach((row: any) => {
      const value = row["Загальні"] || "";
      initialSettingsState.set(`general_${row.setting_id}`, value);

      switch (row.setting_id) {
        case 1: // Назва СТО
          const nameInput = modal.querySelector(
            "#general-sto-name",
          ) as HTMLInputElement;
          if (nameInput) nameInput.value = value;
          break;
        case 2: // Адреса
          const addressInput = modal.querySelector(
            "#general-address",
          ) as HTMLInputElement;
          if (addressInput) addressInput.value = value;
          break;
        case 3: // Телефон
          const phoneInput = modal.querySelector(
            "#general-phone",
          ) as HTMLInputElement;
          if (phoneInput) phoneInput.value = value;
          break;
        case 4: // Колір шапки акту
          const headerColor = modal.querySelector(
            "#general-header-color",
          ) as HTMLInputElement;
          const headerColorValue = modal.querySelector(
            "#header-color-value",
          ) as HTMLElement;
          const colorValue4 = value || DEFAULT_COLOR;
          if (headerColor) headerColor.value = colorValue4;
          if (headerColorValue) headerColorValue.textContent = colorValue4;
          break;
        case 5: // Колір таблиці актів
          const tableColor = modal.querySelector(
            "#general-table-color",
          ) as HTMLInputElement;
          const tableColorValue = modal.querySelector(
            "#table-color-value",
          ) as HTMLElement;
          const colorValue5 = value || DEFAULT_COLOR;
          if (tableColor) tableColor.value = colorValue5;
          if (tableColorValue) tableColorValue.textContent = colorValue5;
          break;
        case 7: // Шпалери основні
          const wallpaperMainInput = modal.querySelector(
            "#general-wallpaper-main",
          ) as HTMLInputElement;
          if (wallpaperMainInput) wallpaperMainInput.value = value;
          break;
        case 8: // SMS текст перед сумою
          const smsBeforePreview = modal.querySelector(
            ".sms-text-before-preview",
          ) as HTMLElement;
          const smsBeforeValue = value || "Ваше замовлення виконане. Сума:";
          if (smsBeforePreview) smsBeforePreview.textContent = smsBeforeValue;
          break;
        case 9: // SMS текст після суми
          const smsAfterPreview = modal.querySelector(
            ".sms-text-after-preview",
          ) as HTMLElement;
          const smsAfterValue = value || "грн. Дякуємо за довіру!";
          if (smsAfterPreview) smsAfterPreview.textContent = smsAfterValue;
          break;
        case 11: // Глобальний зсув шрифту
          const actOffsetSliderLoad = modal.querySelector(
            "#act-text-offset-slider",
          ) as HTMLInputElement;
          const actOffsetBubbleLoad = modal.querySelector(
            "#act-text-offset-bubble",
          ) as HTMLElement;
          const actOffsetVal = parseInt(value);
          const actSafeOffset = isNaN(actOffsetVal) ? 0 : actOffsetVal;
          if (actOffsetSliderLoad)
            actOffsetSliderLoad.value = String(actSafeOffset);
          if (actOffsetBubbleLoad)
            actOffsetBubbleLoad.textContent =
              actSafeOffset > 0 ? `+${actSafeOffset}` : String(actSafeOffset);
          break;
        case 12: // Товщина меж таблиці
          const borderWidthSlider = modal.querySelector(
            "#table-border-width-slider",
          ) as HTMLInputElement;
          const borderWidthBubble = modal.querySelector(
            "#table-border-width-bubble",
          ) as HTMLElement;
          const borderWidthVal = parseInt(value);
          const safeBorderWidth = isNaN(borderWidthVal) ? 1 : borderWidthVal;
          if (borderWidthSlider)
            borderWidthSlider.value = String(safeBorderWidth);
          if (borderWidthBubble)
            borderWidthBubble.textContent = `${safeBorderWidth}px`;
          break;
        case 13: // Колір меж таблиці
          const borderColorPicker = modal.querySelector(
            "#table-border-color",
          ) as HTMLInputElement;
          if (borderColorPicker) borderColorPicker.value = value || "#cccccc";
          break;
        case 14: // Логотип компанії
          const logoUrlInputLoad = modal.querySelector(
            "#general-logo-url",
          ) as HTMLInputElement;
          if (logoUrlInputLoad) logoUrlInputLoad.value = value;
          break;
        case 15: // Favicon (іконка браузера)
          const faviconUrlInputLoad = modal.querySelector(
            "#general-favicon-url",
          ) as HTMLInputElement;
          if (faviconUrlInputLoad) faviconUrlInputLoad.value = value;
          if (value) applyFavicon(value);
          break;
      }
    });

    // Оновлюємо лічильник символів SMS після завантаження даних
    updateSmsCharCounter(modal);
  } catch (err) {
    // console.error(err);
    showNotification(
      "Помилка завантаження загальних налаштувань",
      "error",
      2000,
    );
  }
}

// Зберігає дані для секції "Загальні"
type SettingPatch = { id: number; column: string; value: boolean | number | string | null; insertData?: boolean; insertIfMissing?: boolean };

// Preserve the existing table grants/RLS and UPDATE-only semantics for existing
// rows. One ID read replaces one existence request per changed field.
async function saveSettingPatches(changes: SettingPatch[]): Promise<void> {
  if (!changes.length) return;
  const ids = [...new Set(changes.map(change => change.id))];
  if (ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Некоректний пакет налаштувань");
  const { data, error } = await supabase.from("settings").select("setting_id").in("setting_id", ids);
  if (error) throw error;
  const existing = new Set((data || []).map(row => Number(row.setting_id)));
  const updates = new Map<string, { column: string; value: SettingPatch["value"]; ids: number[] }>();
  const inserts = new Map<number, Record<string, unknown>>();
  for (const change of changes) {
    if (existing.has(change.id)) {
      const key = JSON.stringify([change.column, change.value]);
      const group = updates.get(key) || { column: change.column, value: change.value, ids: [] };
      group.ids.push(change.id); updates.set(key, group);
    } else if (change.insertIfMissing !== false) {
      const row = inserts.get(change.id) || { setting_id: change.id };
      if (change.insertData !== undefined && row.data === undefined) row.data = change.insertData;
      row[change.column] = change.value; inserts.set(change.id, row);
    }
  }
  for (const group of updates.values()) {
    const { error: updateError } = await supabase.from("settings").update({ [group.column]: group.value }).in("setting_id", group.ids);
    if (updateError) throw updateError;
  }
  // Plain INSERT retains the former conflict behavior if another tab creates a
  // missing row during the save; it cannot reset another column on that row.
  const byColumns = new Map<string, Record<string, unknown>[]>();
  for (const row of inserts.values()) {
    const key = Object.keys(row).sort().join("|");
    const group = byColumns.get(key) || []; group.push(row); byColumns.set(key, group);
  }
  for (const rows of byColumns.values()) {
    const { error: insertError } = await supabase.from("settings").insert(rows);
    if (insertError) throw insertError;
  }
}

async function saveGeneralSettings(modal: HTMLElement): Promise<number> {
  let changesCount = 0;

  const nameInput = modal.querySelector(
    "#general-sto-name",
  ) as HTMLInputElement;
  const addressInput = modal.querySelector(
    "#general-address",
  ) as HTMLInputElement;
  const phoneInput = modal.querySelector("#general-phone") as HTMLInputElement;
  const headerColor = modal.querySelector(
    "#general-header-color",
  ) as HTMLInputElement;
  const tableColor = modal.querySelector(
    "#general-table-color",
  ) as HTMLInputElement;
  const wallpaperMainInput = modal.querySelector(
    "#general-wallpaper-main",
  ) as HTMLInputElement;
  const smsBeforePreview = modal.querySelector(
    ".sms-text-before-preview",
  ) as HTMLElement;
  const smsAfterPreview = modal.querySelector(
    ".sms-text-after-preview",
  ) as HTMLElement;
  const actTextOffsetSliderSave = modal.querySelector(
    "#act-text-offset-slider",
  ) as HTMLInputElement;
  const borderWidthSliderSave = modal.querySelector(
    "#table-border-width-slider",
  ) as HTMLInputElement;
  const borderColorPickerSave = modal.querySelector(
    "#table-border-color",
  ) as HTMLInputElement;
  const logoUrlInputSave = modal.querySelector(
    "#general-logo-url",
  ) as HTMLInputElement;
  const faviconUrlInputSave = modal.querySelector(
    "#general-favicon-url",
  ) as HTMLInputElement;

  const newValues = [
    { id: 1, value: nameInput?.value || "" },
    { id: 2, value: addressInput?.value || "" },
    { id: 3, value: phoneInput?.value || "" },
    { id: 4, value: headerColor?.value || DEFAULT_COLOR },
    { id: 5, value: tableColor?.value || DEFAULT_COLOR },
    { id: 7, value: wallpaperMainInput?.value || "" },
    {
      id: 8,
      value:
        smsBeforePreview?.textContent?.trim() ||
        "Ваше замовлення виконане. Сума:",
    },
    {
      id: 9,
      value: smsAfterPreview?.textContent?.trim() || "грн. Дякуємо за довіру!",
    },
    {
      id: 11,
      value: actTextOffsetSliderSave?.value || "0",
    },
    {
      id: 12,
      value: borderWidthSliderSave?.value || "1",
    },
    {
      id: 13,
      value: borderColorPickerSave?.value || "#cccccc",
    },
    {
      id: 14,
      value: logoUrlInputSave?.value || "",
    },
    {
      id: 15,
      value: faviconUrlInputSave?.value || "",
    },
  ];

  const changes = newValues.filter(({ id, value }) => initialSettingsState.get(`general_${id}`) !== value)
    .map(({ id, value }) => ({ id, column: "Загальні", value, insertData: false }));
  await saveSettingPatches(changes);
  changesCount = changes.length;

  // Оновлюємо globalCache та localStorage, якщо були зміни
  if (changesCount > 0) {
    // Оновлюємо globalCache
    globalCache.generalSettings.stoName = nameInput?.value || "";
    globalCache.generalSettings.address = addressInput?.value || "";
    globalCache.generalSettings.phone = phoneInput?.value || "";
    globalCache.generalSettings.headerColor =
      headerColor?.value || DEFAULT_COLOR;
    globalCache.generalSettings.tableColor = tableColor?.value || DEFAULT_COLOR;
    globalCache.generalSettings.wallpaperMain = wallpaperMainInput?.value || "";
    globalCache.generalSettings.smsTextBefore =
      smsBeforePreview?.textContent?.trim() ||
      "Ваше замовлення виконане. Сума:";
    globalCache.generalSettings.smsTextAfter =
      smsAfterPreview?.textContent?.trim() || "грн. Дякуємо за довіру!";
    globalCache.generalSettings.actTextOffset =
      parseInt(actTextOffsetSliderSave?.value) || 0;
    globalCache.generalSettings.tableBorderWidth =
      parseInt(borderWidthSliderSave?.value) || 1;
    globalCache.generalSettings.tableBorderColor =
      borderColorPickerSave?.value || "#cccccc";
    globalCache.generalSettings.logoUrl = logoUrlInputSave?.value || "";

    // Зберігаємо в localStorage
    saveGeneralSettingsToLocalStorage();

    // Застосовуємо шпалери одразу після збереження
    applyWallpapers();

    // Застосовуємо розміри шрифтів одразу після збереження
    applyFontSizes();

    // Інвалідуємо кеш глобальних даних
    invalidateGlobalDataCache();
  }

  return changesCount;
}

// Функція для підрахунку та оновлення лічильника символів SMS
function updateSmsCharCounter(modal: HTMLElement): void {
  const smsBeforePreview = modal.querySelector(
    ".sms-text-before-preview",
  ) as HTMLElement;
  const smsAfterPreview = modal.querySelector(
    ".sms-text-after-preview",
  ) as HTMLElement;
  const sumExample = modal.querySelector(".sms-sum-example") as HTMLElement;
  const charCounter = modal.querySelector("#sms-char-counter") as HTMLElement;

  if (!charCounter) return;

  const beforeText = smsBeforePreview?.textContent || "";
  const sumText = sumExample?.textContent || "";
  const afterText = smsAfterPreview?.textContent || "";

  const totalChars = beforeText.length + sumText.length + afterText.length;
  charCounter.textContent = `${totalChars} симв.`;

  // Змінюємо колір в залежності від кількості символів
  if (totalChars > 160) {
    charCounter.classList.add("warning");
    charCounter.classList.remove("ok");
  } else {
    charCounter.classList.add("ok");
    charCounter.classList.remove("warning");
  }
}

// Ініціалізує обробники для секції "Загальні"
function initGeneralSettingsHandlers(modal: HTMLElement): void {
  // Color pickers
  const headerColor = modal.querySelector(
    "#general-header-color",
  ) as HTMLInputElement;
  const tableColor = modal.querySelector(
    "#general-table-color",
  ) as HTMLInputElement;
  const headerColorValue = modal.querySelector(
    "#header-color-value",
  ) as HTMLElement;
  const tableColorValue = modal.querySelector(
    "#table-color-value",
  ) as HTMLElement;

  if (headerColor && headerColorValue) {
    headerColor.addEventListener("input", () => {
      headerColorValue.textContent = headerColor.value;
    });
  }

  if (tableColor && tableColorValue) {
    tableColor.addEventListener("input", () => {
      tableColorValue.textContent = tableColor.value;
    });
  }

  // Кнопка скидання кольорів та шпалер
  const resetBtn = modal.querySelector(
    "#reset-colors-btn",
  ) as HTMLButtonElement;
  const wallpaperMainInput = modal.querySelector(
    "#general-wallpaper-main",
  ) as HTMLInputElement;
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (headerColor) {
        headerColor.value = DEFAULT_COLOR;
        if (headerColorValue) headerColorValue.textContent = DEFAULT_COLOR;
      }
      if (tableColor) {
        tableColor.value = DEFAULT_COLOR;
        if (tableColorValue) tableColorValue.textContent = DEFAULT_COLOR;
      }
      // Очищаємо поле шпалер
      if (wallpaperMainInput) {
        wallpaperMainInput.value = "";
      }
      // Скидаємо повзунок глобального зсуву шрифту до 0
      const actOffsetSliderReset = modal.querySelector(
        "#act-text-offset-slider",
      ) as HTMLInputElement;
      const actOffsetBubbleReset = modal.querySelector(
        "#act-text-offset-bubble",
      ) as HTMLElement;
      if (actOffsetSliderReset) actOffsetSliderReset.value = "0";
      if (actOffsetBubbleReset) actOffsetBubbleReset.textContent = "0";

      // Скидаємо повзунок товщини меж таблиці до 1px
      const borderWidthSliderReset = modal.querySelector(
        "#table-border-width-slider",
      ) as HTMLInputElement;
      const borderWidthBubbleReset = modal.querySelector(
        "#table-border-width-bubble",
      ) as HTMLElement;
      if (borderWidthSliderReset) borderWidthSliderReset.value = "1";
      if (borderWidthBubbleReset) borderWidthBubbleReset.textContent = "1px";

      // Скидаємо колір меж таблиці до сірого
      const borderColorPickerReset = modal.querySelector(
        "#table-border-color",
      ) as HTMLInputElement;
      if (borderColorPickerReset) borderColorPickerReset.value = "#cccccc";

      // Очищаємо поле логотипу
      const logoUrlInputReset = modal.querySelector(
        "#general-logo-url",
      ) as HTMLInputElement;
      if (logoUrlInputReset) {
        logoUrlInputReset.value = "";
      }

      showNotification(
        "Налаштування скинуто до значень за замовчуванням",
        "info",
        1500,
      );
    });
  }

  // Обробники для логотипу
  const logoUploadBtn = modal.querySelector(
    "#general-logo-upload-btn",
  ) as HTMLButtonElement;
  const logoFileInput = modal.querySelector(
    "#general-logo-file",
  ) as HTMLInputElement;
  const logoUrlInput = modal.querySelector(
    "#general-logo-url",
  ) as HTMLInputElement;

  if (logoUploadBtn && logoFileInput && logoUrlInput) {
    logoUploadBtn.addEventListener("click", () => {
      logoFileInput.click();
    });

    logoFileInput.addEventListener("change", async (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.files || target.files.length === 0) return;

      const file = target.files[0];
      try {
        logoUploadBtn.classList.add("logo-upload-icon--loading");
        logoUploadBtn.disabled = true;

        const fileExt = file.name.split(".").pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `a1/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("ai-photos")
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data } = supabase.storage
          .from("ai-photos")
          .getPublicUrl(filePath);

        if (data && data.publicUrl) {
          logoUrlInput.value = data.publicUrl;
          logoUrlInput.classList.add("logo-url-input--success");
          setTimeout(
            () => logoUrlInput.classList.remove("logo-url-input--success"),
            1500,
          );
        }
      } catch (err: any) {
        // console.error(err);
        showNotification("Помилка завантаження логотипу", "error", 2000);
      } finally {
        logoUploadBtn.classList.remove("logo-upload-icon--loading");
        logoUploadBtn.disabled = false;
        logoFileInput.value = "";
      }
    });
  }

  // Обробники для favicon (іконка браузера)
  const faviconUploadBtn = modal.querySelector(
    "#general-favicon-upload-btn",
  ) as HTMLButtonElement;
  const faviconFileInput = modal.querySelector(
    "#general-favicon-file",
  ) as HTMLInputElement;
  const faviconUrlInput = modal.querySelector(
    "#general-favicon-url",
  ) as HTMLInputElement;

  if (faviconUploadBtn && faviconFileInput && faviconUrlInput) {
    faviconUploadBtn.addEventListener("click", () => {
      faviconFileInput.click();
    });

    faviconFileInput.addEventListener("change", async (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.files || target.files.length === 0) return;

      const file = target.files[0];
      try {
        faviconUploadBtn.classList.add("logo-upload-icon--loading");
        faviconUploadBtn.disabled = true;

        const fileExt = file.name.split(".").pop();
        const fileName = `favicon_${Date.now()}.${fileExt}`;
        const filePath = `a1/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("ai-photos")
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data } = supabase.storage
          .from("ai-photos")
          .getPublicUrl(filePath);

        if (data && data.publicUrl) {
          faviconUrlInput.value = data.publicUrl;
          faviconUrlInput.classList.add("logo-url-input--success");
          setTimeout(
            () => faviconUrlInput.classList.remove("logo-url-input--success"),
            1500,
          );
          // Одразу застосовуємо favicon у браузері
          applyFavicon(data.publicUrl);
        }
      } catch (err: any) {
        showNotification("Помилка завантаження іконки", "error", 2000);
      } finally {
        faviconUploadBtn.classList.remove("logo-upload-icon--loading");
        faviconUploadBtn.disabled = false;
        faviconFileInput.value = "";
      }
    });
  }

  // Обробники для підрахунку символів SMS
  const smsBeforePreview = modal.querySelector(
    ".sms-text-before-preview",
  ) as HTMLElement;
  const smsAfterPreview = modal.querySelector(
    ".sms-text-after-preview",
  ) as HTMLElement;

  // Початковий підрахунок
  updateSmsCharCounter(modal);

  // Оновлюємо лічильник при зміні тексту
  if (smsBeforePreview) {
    smsBeforePreview.addEventListener("input", () =>
      updateSmsCharCounter(modal),
    );
  }
  if (smsAfterPreview) {
    smsAfterPreview.addEventListener("input", () =>
      updateSmsCharCounter(modal),
    );
  }

  // Обробник для глобального повзунка зсуву шрифту
  const actOffsetSlider = modal.querySelector(
    "#act-text-offset-slider",
  ) as HTMLInputElement;
  const actOffsetBubble = modal.querySelector(
    "#act-text-offset-bubble",
  ) as HTMLElement;
  if (actOffsetSlider && actOffsetBubble) {
    actOffsetSlider.addEventListener("input", () => {
      const val = parseInt(actOffsetSlider.value);
      actOffsetBubble.textContent = val > 0 ? `+${val}` : String(val);
    });
  }

  // Обробник для повзунка товщини меж таблиці
  const borderWidthSlider = modal.querySelector(
    "#table-border-width-slider",
  ) as HTMLInputElement;
  const borderWidthBubble = modal.querySelector(
    "#table-border-width-bubble",
  ) as HTMLElement;
  if (borderWidthSlider && borderWidthBubble) {
    borderWidthSlider.addEventListener("input", () => {
      borderWidthBubble.textContent = `${borderWidthSlider.value}px`;
    });
  }
}

function createToggle(id: string, label: string, cls: string): string {
  return `
    <label class="toggle-switch ${cls}">
      <input type="checkbox" id="${id}" />
      <span class="slider"></span>
      <span class="label-text">${label}</span>
    </label>
  `;
}

function createRoleToggles(role: string): string {
  const settings = ROLE_SETTINGS[role as keyof typeof ROLE_SETTINGS];
  if (!settings) return "";
  return settings
    .map((s: any) => {
      if (s.divider) {
        return `<div class="settings-divider"></div>`;
      }
      return createToggle(`role-toggle-${s.id}`, s.label, `_role_${s.id}`);
    })
    .join("");
}

// Функція для додавання нового рядка відсотків
function addPercentageRow(
  modal: HTMLElement,
  initialValue: number = 0,
  settingId?: number,
  isFrozen: boolean = false,
): void {
  const wrapper = modal.querySelector(".percentage-rows-wrapper");
  const container = modal.querySelector("#additional-percentage-rows");

  if (!container) return;

  // Визначаємо наступний номер рядка
  const allRows = wrapper?.querySelectorAll(".percentage-row") || [];
  let nextRowNum = settingId;

  if (!nextRowNum) {
    // Знаходимо максимальний номер і додаємо 1
    let maxNum = 1;
    allRows.forEach((row) => {
      const num = parseInt(row.getAttribute("data-setting-id") || "1");
      if (num > maxNum) maxNum = num;
    });
    nextRowNum = maxNum + 1;
  }

  // Максимум 500 рядків (розширений діапазон)
  if (nextRowNum > 500) return;

  // Перевіряємо чи вже існує цей рядок
  if (modal.querySelector(`#percentage-slider-${nextRowNum}`)) {
    // Просто оновлюємо значення
    const slider = modal.querySelector(
      `#percentage-slider-${nextRowNum}`,
    ) as HTMLInputElement;
    const input = modal.querySelector(
      `#percentage-input-${nextRowNum}`,
    ) as HTMLInputElement;
    if (slider) slider.value = String(initialValue);
    if (input) input.value = String(initialValue);
    return;
  }

  // Кнопка плюсика завжди видима (можна додавати багато складів)
  const frozenClass = isFrozen ? " frozen" : "";
  const disabledAttr = isFrozen ? " disabled" : "";

  const rowHtml = `
    <div class="percentage-row${frozenClass}" data-setting-id="${nextRowNum}">
      <span class="percentage-number">${nextRowNum}</span>
      <div class="percentage-input-wrapper">
        <input type="range" id="percentage-slider-${nextRowNum}" class="percentage-slider" min="0" max="100" value="${isFrozen ? 0 : initialValue}" step="1"${disabledAttr} />
        <div class="percentage-value-display">
          <input type="number" id="percentage-input-${nextRowNum}" class="percentage-input" min="0" max="100" value="${isFrozen ? 0 : initialValue}"${disabledAttr} />
          <span class="percent-sign">${isFrozen ? "." : "%"}</span>
        </div>
      </div>
      ${
        isFrozen
          ? `<div class="percentage-buttons-container">
            <button type="button" class="delete-percentage-btn" id="delete-percentage-row-${nextRowNum}" title="Видалити склад повністю">×</button>
            <button type="button" class="unfreeze-percentage-btn" id="unfreeze-percentage-row-${nextRowNum}" title="Активувати склад">↻</button>
          </div>`
          : `<button type="button" class="remove-percentage-btn" id="remove-percentage-row-${nextRowNum}" title="Заморозити склад">−</button>`
      }
    </div>
  `;

  container.insertAdjacentHTML("beforeend", rowHtml);

  // Додаємо обробники для нового рядка
  const slider = modal.querySelector(
    `#percentage-slider-${nextRowNum}`,
  ) as HTMLInputElement;
  const input = modal.querySelector(
    `#percentage-input-${nextRowNum}`,
  ) as HTMLInputElement;
  const removeBtn = modal.querySelector(`#remove-percentage-row-${nextRowNum}`);
  const unfreezeBtn = modal.querySelector(
    `#unfreeze-percentage-row-${nextRowNum}`,
  );
  const deleteBtn = modal.querySelector(`#delete-percentage-row-${nextRowNum}`);

  if (slider && input && !isFrozen) {
    slider.addEventListener("input", () => {
      input.value = slider.value;
    });

    input.addEventListener("input", () => {
      const numValue = parseInt(input.value) || 0;
      if (numValue >= 0 && numValue <= 100) {
        slider.value = String(numValue);
      } else {
        input.value = slider.value;
      }
    });
  }

  // Обробник для повного видалення рядка (тільки UI, збереження при "ОК")
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      // Додаємо ID до списку видалених
      pendingDeletedWarehouseIds.add(nextRowNum!);
      pendingFrozenWarehouseIds.delete(nextRowNum!);
      pendingUnfrozenWarehouseIds.delete(nextRowNum!);

      // Видаляємо рядок з UI
      const row = modal.querySelector(
        `.percentage-row[data-setting-id="${nextRowNum}"]`,
      );
      if (row) {
        row.remove();
      }
    });
  }

  // Обробник для заморожування рядка (тільки UI, збереження при "ОК")
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      // Додаємо ID до списку заморожених
      pendingFrozenWarehouseIds.add(nextRowNum!);
      pendingUnfrozenWarehouseIds.delete(nextRowNum!);
      pendingDeletedWarehouseIds.delete(nextRowNum!);

      // Оновлюємо UI
      const row = modal.querySelector(
        `.percentage-row[data-setting-id="${nextRowNum}"]`,
      );
      if (row) {
        row.classList.add("frozen");
        const sliderEl = row.querySelector(
          ".percentage-slider",
        ) as HTMLInputElement;
        const inputEl = row.querySelector(
          ".percentage-input",
        ) as HTMLInputElement;
        const percentSign = row.querySelector(".percent-sign");
        if (sliderEl) sliderEl.disabled = true;
        if (inputEl) inputEl.disabled = true;
        if (percentSign) percentSign.textContent = ".";

        // Замінюємо кнопку на контейнер з двома кнопками
        removeBtn.outerHTML = `<div class="percentage-buttons-container">
          <button type="button" class="delete-percentage-btn" id="delete-percentage-row-${nextRowNum}" title="Видалити склад повністю">×</button>
          <button type="button" class="unfreeze-percentage-btn" id="unfreeze-percentage-row-${nextRowNum}" title="Активувати склад">↻</button>
        </div>`;

        // Додаємо обробники для нових кнопок
        const newUnfreezeBtn = modal.querySelector(
          `#unfreeze-percentage-row-${nextRowNum}`,
        );
        const newDeleteBtn = modal.querySelector(
          `#delete-percentage-row-${nextRowNum}`,
        );

        if (newUnfreezeBtn) {
          newUnfreezeBtn.addEventListener("click", () =>
            unfreezeRow(modal, nextRowNum!),
          );
        }

        if (newDeleteBtn) {
          newDeleteBtn.addEventListener("click", () => {
            // Додаємо ID до списку видалених
            pendingDeletedWarehouseIds.add(nextRowNum!);
            pendingFrozenWarehouseIds.delete(nextRowNum!);
            pendingUnfrozenWarehouseIds.delete(nextRowNum!);
            row.remove();
          });
        }
      }
    });
  }

  // Обробник для розморожування рядка
  if (unfreezeBtn) {
    unfreezeBtn.addEventListener("click", () =>
      unfreezeRow(modal, nextRowNum!),
    );
  }
}

// Функція для розморожування рядка
// Функція для розморожування рядка (тільки UI, збереження при "ОК")
function unfreezeRow(modal: HTMLElement, settingId: number): void {
  // Додаємо ID до списку активованих
  pendingUnfrozenWarehouseIds.add(settingId);
  pendingFrozenWarehouseIds.delete(settingId);
  pendingDeletedWarehouseIds.delete(settingId);

  // Оновлюємо UI
  const row = modal.querySelector(
    `.percentage-row[data-setting-id="${settingId}"]`,
  );
  if (row) {
    row.classList.remove("frozen");
    const sliderEl = row.querySelector(
      ".percentage-slider",
    ) as HTMLInputElement;
    const inputEl = row.querySelector(".percentage-input") as HTMLInputElement;
    const percentSign = row.querySelector(".percent-sign");
    if (sliderEl) {
      sliderEl.disabled = false;
      sliderEl.value = "0";
    }
    if (inputEl) {
      inputEl.disabled = false;
      inputEl.value = "0";
    }
    if (percentSign) percentSign.textContent = "%";

    // Видаляємо контейнер з кнопками і додаємо просту кнопку заморозки
    const buttonsContainer = row.querySelector(".percentage-buttons-container");
    if (buttonsContainer) {
      buttonsContainer.outerHTML = `<button type="button" class="remove-percentage-btn" id="remove-percentage-row-${settingId}" title="Заморозити склад">−</button>`;
    }

    // Додаємо обробник для нової кнопки заморозки (тільки UI)
    const newRemoveBtn = modal.querySelector(
      `#remove-percentage-row-${settingId}`,
    );
    if (newRemoveBtn) {
      newRemoveBtn.addEventListener("click", () => {
        // Додаємо ID до списку заморожених
        pendingFrozenWarehouseIds.add(settingId);
        pendingUnfrozenWarehouseIds.delete(settingId);
        pendingDeletedWarehouseIds.delete(settingId);

        // Заморожуємо рядок
        row.classList.add("frozen");
        if (sliderEl) sliderEl.disabled = true;
        if (inputEl) inputEl.disabled = true;
        if (percentSign) percentSign.textContent = ".";

        // Замінюємо кнопку на контейнер з двома кнопками
        newRemoveBtn.outerHTML = `<div class="percentage-buttons-container">
          <button type="button" class="delete-percentage-btn" id="delete-percentage-row-${settingId}" title="Видалити склад повністю">×</button>
          <button type="button" class="unfreeze-percentage-btn" id="unfreeze-percentage-row-${settingId}" title="Активувати склад">↻</button>
        </div>`;

        const newerUnfreezeBtn = modal.querySelector(
          `#unfreeze-percentage-row-${settingId}`,
        );
        const newerDeleteBtn = modal.querySelector(
          `#delete-percentage-row-${settingId}`,
        );

        if (newerUnfreezeBtn) {
          newerUnfreezeBtn.addEventListener("click", () =>
            unfreezeRow(modal, settingId),
          );
        }

        if (newerDeleteBtn) {
          newerDeleteBtn.addEventListener("click", () => {
            // Додаємо ID до списку видалених
            pendingDeletedWarehouseIds.add(settingId);
            pendingFrozenWarehouseIds.delete(settingId);
            pendingUnfrozenWarehouseIds.delete(settingId);
            row.remove();
          });
        }
      });
    }

    // Додаємо обробники для слайдера і інпута
    if (sliderEl && inputEl) {
      sliderEl.addEventListener("input", () => {
        inputEl.value = sliderEl.value;
      });

      inputEl.addEventListener("input", () => {
        const numValue = parseInt(inputEl.value) || 0;
        if (numValue >= 0 && numValue <= 100) {
          sliderEl.value = String(numValue);
        } else {
          inputEl.value = sliderEl.value;
        }
      });
    }
  }
}

async function loadSettings(modal: HTMLElement): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("setting_id, data, procent")
      .order("setting_id");

    if (error) throw error;

    // 🔹 Очищуємо попередній стан
    initialSettingsState.clear();

    // 🔹 Очищуємо списки відкладених змін складів
    pendingDeletedWarehouseIds.clear();
    pendingFrozenWarehouseIds.clear();
    pendingUnfrozenWarehouseIds.clear();

    // Очищаємо додаткові рядки відсотків
    const additionalRows = modal.querySelector("#additional-percentage-rows");
    if (additionalRows) additionalRows.innerHTML = "";

    // Показуємо кнопку плюсика
    const addBtn = modal.querySelector(
      "#add-percentage-row",
    ) as HTMLButtonElement;
    if (addBtn) addBtn.style.display = "";

    Object.values(SETTINGS).forEach((s) => {
      const el = modal.querySelector(`#${s.id}`) as HTMLInputElement;
      if (el?.type === "checkbox") el.checked = false;
    });

    // Збираємо дані про відсотки (всі setting_id)
    const procentMap = new Map<number, number | null>();

    data?.forEach((row: any) => {
      const setting = SETTINGS[row.setting_id as keyof typeof SETTINGS];

      // Зберігаємо всі procent значення (setting_id >= 1)
      if (row.setting_id >= 1) {
        procentMap.set(row.setting_id, row.procent);
      }

      // Обробка чекбоксів
      if (setting && setting.id !== "percentage-value") {
        const checkbox = modal.querySelector(
          `#${setting.id}`,
        ) as HTMLInputElement;
        if (checkbox) checkbox.checked = !!row.data;
        initialSettingsState.set(`checkbox_${row.setting_id}`, !!row.data);
      }
    });

    // Для відсутніх записів по ключових адмін-перемикачах — виставляємо дефолт false у початковому стані
    [1, 2, 3, 5, 6, 7, 8, 9].forEach((id) => {
      if (!initialSettingsState.has(`checkbox_${id}`)) {
        const setting = SETTINGS[id as keyof typeof SETTINGS];
        if (setting) {
          const el = modal.querySelector(`#${setting.id}`) as HTMLInputElement;
          const def = !!el?.checked; // як правило false
          initialSettingsState.set(`checkbox_${id}`, def);
        }
      }
    });

    // Рендеримо лише заповнені рядки (включаючи заморожені -1), без заповнення прогалин
    const filledIds = Array.from(procentMap.entries())
      .filter(([_, val]) => val !== null && val !== undefined)
      .map(([id, _]) => id)
      .sort((a, b) => a - b);

    if (filledIds.length) {
      for (const id of filledIds) {
        const value = procentMap.get(id);
        const isFrozen = value === -1; // -1 означає заморожений склад
        const displayValue = isFrozen ? 0 : (value ?? 0);

        if (id === 1) {
          // Перший рядок вже існує в HTML
          const slider1 = modal.querySelector(
            "#percentage-slider-1",
          ) as HTMLInputElement;
          const input1 = modal.querySelector(
            "#percentage-input-1",
          ) as HTMLInputElement;
          const row1 = modal.querySelector(
            ".percentage-row[data-setting-id='1']",
          );
          const percentSign1 = row1?.querySelector(".percent-sign");

          // Скидаємо стан перед застосуванням
          if (row1) row1.classList.remove("frozen");
          if (percentSign1) percentSign1.textContent = "%";
          if (slider1) slider1.disabled = false;
          if (input1) input1.disabled = false;

          if (isFrozen) {
            if (slider1) {
              slider1.value = "0";
              slider1.disabled = true;
            }
            if (input1) {
              input1.value = "0";
              input1.disabled = true;
            }
            if (row1) row1.classList.add("frozen");
            if (percentSign1) percentSign1.textContent = ".";
          } else {
            if (slider1) slider1.value = String(displayValue);
            if (input1) input1.value = String(displayValue);
          }
          initialSettingsState.set(`procent_${id}`, value ?? 0);
        } else {
          // Додаткові рядки створюємо динамічно тільки для існуючих ID
          addPercentageRow(modal, displayValue, id, isFrozen);
          initialSettingsState.set(`procent_${id}`, value ?? 0);
        }
      }
    } else {
      // Якщо немає жодного заповненого відсотка, встановлюємо 0 для першого
      const slider1 = modal.querySelector(
        "#percentage-slider-1",
      ) as HTMLInputElement;
      const input1 = modal.querySelector(
        "#percentage-input-1",
      ) as HTMLInputElement;
      if (slider1) slider1.value = "0";
      if (input1) input1.value = "0";
      initialSettingsState.set(`procent_1`, 0);
    }

    modal
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((cb) => {
        cb.closest(".toggle-switch")?.classList.toggle("active", cb.checked);
      });
  } catch (err) {
    // console.error(err);
    showNotification("Помилка завантаження налаштувань", "error", 2000);
  }
}

async function loadRoleSettings(
  modal: HTMLElement,
  role: string,
): Promise<void> {
  const column = ROLE_TO_COLUMN[role as keyof typeof ROLE_TO_COLUMN];

  if (!column) return;

  try {
    // 🔹 Очищуємо попередній стан
    initialSettingsState.clear();

    // Охоплюємо повний діапазон id 1..26
    const settingIds = Array.from({ length: 26 }, (_, i) => i + 1);

    const { data, error } = await supabase
      .from("settings")
      .select(`setting_id, "${column}"`)
      .in("setting_id", settingIds)
      .order("setting_id");

    if (error) throw error;

    // Скидаємо чекбокси поточної розмітки (тільки ті, що відображені)
    modal
      .querySelectorAll<HTMLInputElement>('[id^="role-toggle-"]')
      .forEach((el) => {
        if (el.type === "checkbox") el.checked = false;
      });

    const presentIds = new Set<number>();
    data?.forEach((row: any) => {
      const checkbox = modal.querySelector(
        `#role-toggle-${row.setting_id}`,
      ) as HTMLInputElement;
      const value = !!row[column];
      if (checkbox) checkbox.checked = value;
      // 🔹 Зберігаємо початкове значення з префіксом role_
      initialSettingsState.set(`role_${row.setting_id}`, value);
      presentIds.add(row.setting_id);
    });

    // Для всіх id 1..26, де немає записів у БД — фіксуємо дефолт (стан чекбокса або false)
    settingIds.forEach((id: number) => {
      if (!presentIds.has(id)) {
        const checkbox = modal.querySelector(
          `#role-toggle-${id}`,
        ) as HTMLInputElement;
        const value = !!checkbox?.checked; // за замовчуванням false
        initialSettingsState.set(`role_${id}`, value);
      }
    });

    modal
      .querySelectorAll<HTMLInputElement>('[id^="role-toggle-"]')
      .forEach((cb) => {
        cb.closest(".toggle-switch")?.classList.toggle("active", cb.checked);
      });
  } catch (err) {
    // console.error(err);
    showNotification(
      `Помилка завантаження налаштувань для ролі ${role}`,
      "error",
      2000,
    );
  }
}

async function saveSettings(modal: HTMLElement): Promise<boolean> {
  try {
    const roleButton = modal.querySelector<HTMLButtonElement>("#role-toggle-button");
    let role = (roleButton?.textContent || "Адміністратор").trim();
    if (!(role in ROLE_TO_COLUMN)) role = "Адміністратор";
    const column = ROLE_TO_COLUMN[role as keyof typeof ROLE_TO_COLUMN];
    const changes: SettingPatch[] = [];
    const effects: (() => void)[] = [];
    let changesCount = 0;
    const npControl = modal.querySelector<HTMLElement>(".nova-poshta-setting");
    const npToggle = modal.querySelector<HTMLInputElement>("#toggle-nova-poshta");
    const pendingNovaPoshta = hasNovaPoshtaSetting(role) && npControl?.dataset.role === role
      && npToggle && !npToggle.disabled && npControl.dataset.savedValue !== undefined
      && String(npToggle.checked) !== npControl.dataset.savedValue ? npToggle.checked : null;

    if (role === "Адміністратор") {
      const toggles: [number, string][] = [[1,"toggle-shop"],[2,"toggle-receiver"],[3,"toggle-zarplata"],
        [5,"toggle-sms"],[6,"toggle-print"],[7,"toggle-ai"],[8,"toggle-phone-admin"],[9,"toggle-ai-pro"],[10,"toggle-voice-input"]];
      for (const [id, selector] of toggles) {
        const value = modal.querySelector<HTMLInputElement>(`#${selector}`)?.checked ?? false;
        if (initialSettingsState.get(`checkbox_${id}`) === value) continue;
        changes.push({ id, column, value });
        if (id === 6) effects.push(() => { globalCache.generalSettings.printColorMode = value; saveGeneralSettingsToLocalStorage(); });
        if (id === 7) effects.push(() => { globalCache.generalSettings.aiEnabled = value; saveGeneralSettingsToLocalStorage(); resetAISettingsCache(); });
        if (id === 9) effects.push(() => {
          globalCache.generalSettings.aiChatEnabled = value; saveGeneralSettingsToLocalStorage();
          if (value) initAIChatButton();
          else {
            document.getElementById("ai-chat-menu-btn")?.closest("li")?.remove();
            document.getElementById("ai-chat-modal")?.classList.add("hidden");
          }
        });
        if (id === 10) effects.push(() => {
          globalCache.generalSettings.voiceInputEnabled = value; saveGeneralSettingsToLocalStorage();
          applyVoiceInputVisibility(value);
        });
      }
      for (const input of Array.from(modal.querySelectorAll<HTMLInputElement>(".percentage-input"))) {
        const match = input.id.match(/percentage-input-(\d+)/);
        if (!match) continue;
        const id = Number(match[1]);
        const row = modal.querySelector(`.percentage-row[data-setting-id="${id}"]`);
        const raw = Number(input.value ?? 0);
        const value = row?.classList.contains("frozen") || pendingFrozenWarehouseIds.has(id)
          ? -1 : Math.min(100, Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 0)));
        if (initialSettingsState.get(`procent_${id}`) !== value)
          changes.push({ id, column: "procent", value, insertData: false });
      }
      for (const id of pendingDeletedWarehouseIds) {
        const previous = initialSettingsState.get(`procent_${id}`);
        if (previous !== null && previous !== undefined) {
          // Deleted rows win if a pending input still exists in the modal.
          const pendingIndex = changes.findIndex(change => change.id === id && change.column === "procent");
          if (pendingIndex >= 0) changes.splice(pendingIndex, 1);
          changes.push({ id, column: "procent", value: null, insertIfMissing: false });
        }
      }
    } else if (role === "Загальні") {
      changesCount = await saveGeneralSettings(modal);
    } else {
      for (let id = 1; id <= 26; id++) {
        const checkbox = modal.querySelector<HTMLInputElement>(`#role-toggle-${id}`);
        if (!checkbox) continue;
        const value = checkbox.checked ?? false;
        if (((initialSettingsState.get(`role_${id}`) as boolean) ?? false) !== value)
          changes.push({ id, column, value, insertData: false });
      }
    }

    await saveSettingPatches(changes);
    changesCount += changes.length;
    effects.forEach(effect => effect());
    if (pendingNovaPoshta !== null) {
      await saveNovaPoshtaSetting(role, pendingNovaPoshta);
      applyNovaPoshtaVisibility(role, pendingNovaPoshta);
      if (npControl?.dataset.role === role) npControl.dataset.savedValue = String(pendingNovaPoshta);
      changesCount++;
    }
    if (changesCount === 0) showNotification("Змін не було", "info", 1500);
    else {
      resetPercentCache();
      showNotification(`Збережено ${changesCount} зміни(н)!`, "success", 1500);
      if (role === "Адміністратор") await loadSettings(modal);
      else if (role === "Загальні") await loadGeneralSettings(modal);
      else await loadRoleSettings(modal, role);
    }
    return true;
  } catch {
    showNotification("Помилка збереження", "error", 1500);
    return false;
  }
}

async function loadNovaPoshtaToggle(modal: HTMLElement, role: string): Promise<void> {
  const control = modal.querySelector<HTMLElement>(".nova-poshta-setting");
  const toggle = modal.querySelector<HTMLInputElement>("#toggle-nova-poshta");
  if (!control || !toggle) return;
  control.hidden = !hasNovaPoshtaSetting(role);
  control.dataset.role = role;
  delete control.dataset.savedValue;
  if (control.hidden) return;
  toggle.disabled = true;
  toggle.checked = false;
  toggle.closest(".toggle-switch")?.classList.remove("active");
  try {
    const enabled = await readNovaPoshtaSetting(role);
    if (control.dataset.role !== role) return;
    toggle.checked = enabled;
    control.dataset.savedValue = String(enabled);
    toggle.closest(".toggle-switch")?.classList.toggle("active", enabled);
    toggle.disabled = false;
  } catch {
    if (control.dataset.role === role) {
      showNotification("Не вдалося завантажити налаштування Нової пошти", "error", 2500);
    }
  }
}

function updateRoleTogglesVisibility(modal: HTMLElement, role: string): void {
  const sectionButton = modal.querySelector<HTMLElement>("#role-toggle-button");
  if (sectionButton) sectionButton.textContent = role;
  const novaPoshtaControl = modal.querySelector<HTMLElement>(".nova-poshta-setting");
  const mainToggles = modal.querySelector("#main-toggles-container");
  // Keep the existing toggle and its listener when rebuilding a role's list.
  if (novaPoshtaControl && mainToggles) mainToggles.appendChild(novaPoshtaControl);
  const exportControl = modal.querySelector<HTMLElement>(".database-export-control");
  if (exportControl) exportControl.hidden = userAccessLevel !== "Адміністратор";
  const container = modal.querySelector("#role-toggles-container");
  const adminScrollWrapper = modal.querySelector(".admin-scroll-wrapper");
  const modalWindow = modal.querySelector(".modal-window") as HTMLElement;
  const roleButton = modal.querySelector("#role-toggle-button") as HTMLElement;

  if (!container) return;

  const colors = ROLE_COLORS[role as keyof typeof ROLE_COLORS];
  if (colors && modalWindow) {
    modalWindow.style.border = `2px solid ${colors["modal-window"]}`;
  }
  if (colors && roleButton) {
    roleButton.style.background = colors.button;
    roleButton.onmouseenter = () => {
      roleButton.style.background = colors.buttonHover;
    };
    roleButton.onmouseleave = () => {
      roleButton.style.background = colors.button;
    };
  }

  if (role === "Адміністратор") {
    container.innerHTML = "";
    if (adminScrollWrapper)
      (adminScrollWrapper as HTMLElement).style.display = "";
    loadSettings(modal);
  } else if (role === "Загальні") {
    // Обробка секції "Загальні"
    if (adminScrollWrapper)
      (adminScrollWrapper as HTMLElement).style.display = "none";

    container.innerHTML = createGeneralSettingsHTML();
    initGeneralSettingsHandlers(modal);
    loadGeneralSettings(modal);
  } else {
    if (adminScrollWrapper)
      (adminScrollWrapper as HTMLElement).style.display = "none";

    const togglesHTML = createRoleToggles(role);
    container.innerHTML = togglesHTML;

    container
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((cb) => {
        cb.addEventListener("change", () => {
          cb.closest(".toggle-switch")?.classList.toggle("active", cb.checked);
        });
      });

    loadRoleSettings(modal, role);
    if (novaPoshtaControl && hasNovaPoshtaSetting(role)) {
      container.appendChild(novaPoshtaControl);
    }
  }
  void loadNovaPoshtaToggle(modal, role);
}

// ============================================================
// 🔑 AI PRO API KEYS MODAL
// ============================================================

async function loadAiProKeys(modal: HTMLElement): Promise<void> {
  try {
    // Шукаємо всі можливі setting_id починаючи з 20 (без обмеження)
    const { data, error } = await supabase
      .from("settings")
      .select('setting_id, "Загальні"')
      .gte("setting_id", 20)
      .not("Загальні", "is", null)
      .order("setting_id");

    if (error) throw error;

    const container = modal.querySelector(".ai-pro-keys-inputs") as HTMLElement;
    if (!container) return;

    // Зберігаємо кнопку +
    const addBtn = container.querySelector(".ai-pro-add-btn");

    // Очищаємо старі інпути
    container.querySelectorAll(".ai-pro-key-row").forEach((el) => el.remove());

    if (data && data.length > 0) {
      data.forEach((row: any) => {
        const keyNumber = row.setting_id - 19;
        const rowEl = createAiProKeyRow(
          keyNumber,
          row.setting_id,
          row["Загальні"] || "",
        );
        if (addBtn) {
          container.insertBefore(rowEl, addBtn);
        } else {
          container.appendChild(rowEl);
        }
      });
    } else {
      // Якщо ключів немає — показуємо один порожній
      const rowEl = createAiProKeyRow(1, 20, "");
      if (addBtn) {
        container.insertBefore(rowEl, addBtn);
      } else {
        container.appendChild(rowEl);
      }
    }
  } catch (err) {
    // console.error("Помилка завантаження API ключів:", err);
    showNotification("Помилка завантаження API ключів", "error", 2000);
  }
  // після завантаження — перевіряємо дублікати
  checkDuplicateAiKeys(modal);
}

function createAiProKeyRow(
  num: number,
  settingId: number,
  value: string,
): HTMLElement {
  const getProviderIcon = (key: string): string => {
    const normalized = key.trim();
    if (/^gsk_/i.test(normalized)) return "⚡";
    if (/^sk-or-/i.test(normalized)) return "🧭";
    return "💎";
  };

  const getProviderTitle = (key: string): string => {
    const normalized = key.trim();
    if (/^gsk_/i.test(normalized)) return "Groq";
    if (/^sk-or-/i.test(normalized)) return "OpenRouter";
    return "Gemini";
  };

  const row = document.createElement("div");
  row.className = "ai-pro-key-row";
  row.dataset.settingId = String(settingId);
  initialAiProKeys.set(row, value.trim());
  row.innerHTML = `
    <span class="ai-pro-key-num">${num}</span>
    <span class="ai-pro-key-provider" title="${getProviderTitle(value)}">${getProviderIcon(value)}</span>
    <input
      type="text"
      id="ai-pro-key-${num}"
      class="ai-pro-key-input"
      placeholder="AIza... / gsk_... / sk-or-v1-..."
      value="${value.replace(/"/g, "&quot;")}"
      autocomplete="off"
      spellcheck="false"
    />
    <button type="button" class="ai-pro-key-delete" title="Видалити ключ">✕</button>
  `;
  const deleteBtn = row.querySelector(
    ".ai-pro-key-delete",
  ) as HTMLButtonElement;
  deleteBtn.addEventListener("click", async () => {
    await supabase
      .from("settings")
      .update({ Загальні: null })
      .eq("setting_id", settingId);
    row.remove();
    renumberAiProKeyRows(row.closest(".ai-pro-keys-inputs") as HTMLElement);
    checkDuplicateAiKeys(row.closest(".ai-pro-keys-modal") as HTMLElement);
    resetGeminiKeysCache();
  });
  // Перевірка дублікатів при вводі
  const input = row.querySelector(".ai-pro-key-input") as HTMLInputElement;
  input.addEventListener("input", () => {
    const providerEl = row.querySelector(
      ".ai-pro-key-provider",
    ) as HTMLElement;
    if (providerEl) {
      providerEl.textContent = getProviderIcon(input.value);
      providerEl.title = getProviderTitle(input.value);
    }
    checkDuplicateAiKeys(row.closest(".ai-pro-keys-modal") as HTMLElement);
  });
  return row;
}

/** Підсвічує інпути дублікатних ключів світло-червоним фоном */
function checkDuplicateAiKeys(modal: HTMLElement | null): void {
  if (!modal) return;
  const inputs = modal.querySelectorAll<HTMLInputElement>(".ai-pro-key-input");
  const seen = new Map<string, HTMLInputElement[]>();
  // Групуємо по значенню
  inputs.forEach((inp) => {
    const val = inp.value.trim();
    if (!val) return;
    if (!seen.has(val)) seen.set(val, []);
    seen.get(val)!.push(inp);
  });
  // Знімаємо старе підсвічування
  inputs.forEach((inp) => inp.classList.remove("ai-pro-key-duplicate"));
  // Ставимо нове — тільки там де є дублі
  seen.forEach((group) => {
    if (group.length > 1) {
      group.forEach((inp) => inp.classList.add("ai-pro-key-duplicate"));
    }
  });
}

function renumberAiProKeyRows(container: HTMLElement | null): void {
  if (!container) return;
  const rows = container.querySelectorAll(".ai-pro-key-row");
  rows.forEach((row, i) => {
    const numEl = row.querySelector(".ai-pro-key-num");
    if (numEl) numEl.textContent = String(i + 1);
  });
}

async function saveAiProKeys(modal: HTMLElement): Promise<void> {
  try {
    const rows = modal.querySelectorAll(".ai-pro-key-row");
    // Перевіряємо дублікати перед збереженням
    checkDuplicateAiKeys(modal);
    const hasDuplicates = modal.querySelector(".ai-pro-key-duplicate") !== null;
    if (hasDuplicates) {
      showNotification(
        "Знайдено однакові ключі (підсвічено червоним). Видаліть дублікати!",
        "error",
        3000,
      );
      return;
    }

    const changes: SettingPatch[] = [];
    const savedValues: [HTMLElement, string][] = [];
    for (const row of Array.from(rows)) {
      const element = row as HTMLElement;
      const settingId = Number(element.dataset.settingId || "0");
      const input = row.querySelector<HTMLInputElement>(".ai-pro-key-input");
      const value = input?.value?.trim() || "";
      if (!settingId || value === initialAiProKeys.get(element)) continue;
      changes.push({ id: settingId, column: "Загальні", value: value || null, insertData: false, insertIfMissing: !!value });
      savedValues.push([element, value]);
    }
    await saveSettingPatches(changes);
    savedValues.forEach(([row, value]) => initialAiProKeys.set(row, value));

    // Одне повідомлення після всіх збережень
    showNotification(
      `✅ API ключі збережено (${rows.length})`,
      "success",
      1500,
    );
    resetGeminiKeysCache();
  } catch (err) {
    // console.error("Помилка збереження API ключів:", err);
    showNotification("Помилка збереження API ключів", "error", 2000);
  }
}

export async function openAiProKeysModal(): Promise<void> {
  let keysModal = document.getElementById("ai-pro-keys-modal");

  if (keysModal) {
    keysModal.classList.remove("hidden");
    await loadAiProKeys(keysModal);
    return;
  }

  keysModal = document.createElement("div");
  keysModal.id = "ai-pro-keys-modal";
  keysModal.className = "ai-pro-keys-modal";

  keysModal.innerHTML = `
    <div class="ai-pro-keys-window">
      <div class="ai-pro-keys-header">
        <span class="ai-pro-keys-icon">🔑</span>
        <h3 class="ai-pro-keys-title">API Ключі Gemini / Groq / OpenRouter</h3>
      </div>

      <a href="https://aistudio.google.com/app/api-keys" target="_blank" rel="noopener noreferrer" class="ai-pro-keys-link">
        <span class="ai-pro-keys-link-icon">🔗</span>
        Отримати API ключ на aistudio.google.com
      </a>

      <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" class="ai-pro-keys-link">
        <span class="ai-pro-keys-link-icon">⚡</span>
        Отримати Groq API ключ
      </a>

      <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener noreferrer" class="ai-pro-keys-link">
        <span class="ai-pro-keys-link-icon">🧭</span>
        Отримати OpenRouter API ключ
      </a>

      <div class="ai-pro-keys-inputs">
        <button type="button" class="ai-pro-add-btn" id="ai-pro-add-key">
          <span class="ai-pro-add-icon">＋</span>
          Додати ключ
        </button>
      </div>

      <div class="ai-pro-keys-actions">
        <button type="button" id="ai-pro-keys-cancel">✕ Скасувати</button>
        <button type="button" id="ai-pro-keys-ok">💾 Зберегти</button>
      </div>
    </div>
  `;

  document.body.appendChild(keysModal);

  await loadAiProKeys(keysModal);

  // Кнопка + додати новий ключ
  keysModal
    .querySelector("#ai-pro-add-key")
    ?.addEventListener("click", async () => {
      const container = keysModal!.querySelector(
        ".ai-pro-keys-inputs",
      ) as HTMLElement;
      const addBtn = container.querySelector(".ai-pro-add-btn");

      // Знаходимо найбільший setting_id серед наявних рядків
      const rows = container.querySelectorAll(".ai-pro-key-row");
      let maxSettingId = 19;
      rows.forEach((r) => {
        const sid = parseInt((r as HTMLElement).dataset.settingId || "0");
        if (sid > maxSettingId) maxSettingId = sid;
      });
      const nextSettingId = maxSettingId + 1;
      const nextNum = rows.length + 1;

      const newRow = createAiProKeyRow(nextNum, nextSettingId, "");
      if (addBtn) {
        container.insertBefore(newRow, addBtn);
      } else {
        container.appendChild(newRow);
      }
      // Фокусуємо новий інпут
      (newRow.querySelector(".ai-pro-key-input") as HTMLInputElement)?.focus();
    });

  keysModal
    .querySelector("#ai-pro-keys-ok")
    ?.addEventListener("click", async () => {
      await saveAiProKeys(keysModal!);
      keysModal!.classList.add("hidden");
    });

  keysModal
    .querySelector("#ai-pro-keys-cancel")
    ?.addEventListener("click", () => {
      keysModal!.classList.add("hidden");
    });

  keysModal.addEventListener("click", (e) => {
    if (e.target === keysModal) keysModal!.classList.add("hidden");
  });
}

export async function createSettingsModal(): Promise<void> {
  if (document.getElementById("modal-settings")) return;

  const modal = document.createElement("div");
  modal.id = "modal-settings";
  modal.className = "modal-settings hidden";

  const toggles = Object.values(SETTINGS)
    .filter((s) => s.id !== "percentage-value")
    .map((s) => createToggle(s.id, s.label, s.class))
    .join("");

  const initialRole = ROLES[0]; // "Адміністратор"
  const colors = ROLE_COLORS[initialRole as keyof typeof ROLE_COLORS];

  modal.innerHTML = `
    <div class="modal-window" style="background-color: #ffffff; border: 2px solid ${colors["modal-window"]}">
      <button id="role-toggle-button" type="button" class="role-toggle-button" style="background: ${colors.button}">
        ${initialRole}
      </button>

      <div id="role-toggles-container"></div>

      <div class="admin-scroll-wrapper">
        <div id="main-toggles-container">
          ${toggles}
          <div class="nova-poshta-setting" hidden>
            ${createToggle("toggle-nova-poshta", `<img src="${import.meta.env.BASE_URL}nova-poshta.png" width="24" height="24" alt="" /> Нова пошта`, "_nova_poshta")}
          </div>
        </div>

        <div class="percentage-control">
          <label class="percentage-label">
            <span class="percentage-title">Націнка на запчастини</span>
            <div class="percentage-rows-wrapper">
              <div class="percentage-row" data-setting-id="1">
                <span class="percentage-number">1</span>
                <div class="percentage-input-wrapper">
                  <input type="range" id="percentage-slider-1" class="percentage-slider" min="0" max="100" value="0" step="1" />
                  <div class="percentage-value-display">
                    <input type="number" id="percentage-input-1" class="percentage-input" min="0" max="100" value="0" />
                    <span class="percent-sign">%</span>
                  </div>
                </div>
                <button type="button" class="add-percentage-btn" id="add-percentage-row" title="Додати ще один склад">+</button>
              </div>
              <div id="additional-percentage-rows"></div>
            </div>
          </label>
        </div>
        <div class="database-export-control" hidden>
          <button id="export-database-button" type="button">💾 Вивантажити таблиці Supabase</button>
          <p>Обрати папку · кожна таблиця окремим .jsonb · без зміни бази</p>
        </div>
      </div>

      <div class="modal-actions">
        <button id="modal-cancel-button" type="button">Вийти</button>
        <button id="modal-ok-button" type="button">ОК</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector("#export-database-button")?.addEventListener("click", openDatabaseExport);

  // ✅ одразу ініціалізуємо стан під поточну роль і підтягуємо значення
  updateRoleTogglesVisibility(modal, initialRole);

  // Обробник для AI toggle
  const aiToggle = modal.querySelector("#toggle-ai") as HTMLInputElement;
  if (aiToggle) {
    aiToggle.addEventListener("change", () => {
      resetAISettingsCache();
    });
  }

  // AI PRO toggle — зміни застосовуються тільки при натисканні ОК (збереження)
  // Немає обробника change, бо toggle зберігається через кнопку ОК

  // Обробник для кнопки додавання нового рядка відсотків
  const addPercentageBtn = modal.querySelector("#add-percentage-row");
  if (addPercentageBtn) {
    addPercentageBtn.addEventListener("click", () => {
      addPercentageRow(modal);
    });
  }

  const roleButton = modal.querySelector(
    "#role-toggle-button",
  ) as HTMLButtonElement;

  if (roleButton) {
    roleButton.addEventListener("click", (e: MouseEvent) => {
      const buttonRect = roleButton.getBoundingClientRect();
      const clickX = e.clientX - buttonRect.left;
      const buttonWidth = buttonRect.width;

      // Ліва зона 40% ширини - для перемикання назад
      // Права зона 60% ширини - для перемикання вперед
      const leftZoneWidth = buttonWidth * 0.4;

      let currentRoleIndex = Math.max(0, ROLES.indexOf(roleButton.textContent?.trim() || ROLES[0]));

      if (clickX < leftZoneWidth) {
        // Клік на ліву частину (40%) - назад
        currentRoleIndex = (currentRoleIndex - 1 + ROLES.length) % ROLES.length;
      } else {
        // Клік на праву частину (60%) - вперед
        currentRoleIndex = (currentRoleIndex + 1) % ROLES.length;
      }

      const newRole = ROLES[currentRoleIndex];
      roleButton.textContent = newRole;
      updateRoleTogglesVisibility(modal, newRole);
    });
  }

  const slider = modal.querySelector(
    "#percentage-slider-1",
  ) as HTMLInputElement;
  const input = modal.querySelector("#percentage-input-1") as HTMLInputElement;

  const updateInputFromSlider = () => {
    if (input && slider) {
      input.value = slider.value;
    }
  };

  if (slider) {
    slider.addEventListener("input", updateInputFromSlider);
  }

  if (input) {
    input.addEventListener("input", () => {
      if (slider) {
        const numValue = parseInt(input.value) || 0;
        if (numValue >= 0 && numValue <= 100) {
          slider.value = String(numValue);
          updateInputFromSlider();
        } else {
          input.value = slider.value;
        }
      }
    });
  }

  modal
    .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => {
      cb.addEventListener("change", () => {
        cb.closest(".toggle-switch")?.classList.toggle("active", cb.checked);
      });
    });

  // початкове завантаження вже викликане через updateRoleTogglesVisibility

  modal
    .querySelector("#modal-ok-button")
    ?.addEventListener("click", async () => {
      if (await saveSettings(modal)) {
        // modal.classList.add("hidden");
      }
    });

  modal.querySelector("#modal-cancel-button")?.addEventListener("click", () => {
    closeSettingsModal(modal);
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeSettingsModal(modal);
  });
}

export async function openSettingsModal(): Promise<void> {
  const modal = document.getElementById("modal-settings");
  if (modal) {
    const roleButton = modal.querySelector(
      "#role-toggle-button",
    ) as HTMLButtonElement;
    const role = roleButton?.textContent?.trim() || ROLES[0];
    updateRoleTogglesVisibility(modal, role);
    modal.classList.remove("hidden");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.querySelector('[data-action="openSettings"]');
  btn?.addEventListener("click", async (e: Event) => {
    e.preventDefault();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      showAppMessage("⛔ Доступ заблоковано, Ви не авторизовані");
      return;
    }
    if (!document.getElementById("modal-settings")) {
      await createSettingsModal();
    }
    await openSettingsModal();
  });
});
