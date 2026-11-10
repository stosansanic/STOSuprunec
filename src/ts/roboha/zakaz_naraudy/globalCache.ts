import { readEditorCatalogIds, readEditorStockNameIds, readEditorReferences, invalidateEditorReferences, type EditorReferenceQuery } from "./editorReferenceRead";
import { databaseSubscriptions, type DatabaseSubscription } from "../../utils/databaseSubscriptions";
// src/ts/roboha/zakaz_naraudy/globalCache.ts
import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "./inhi/vspluvauhe_povidomlenna";
import { safeParseJSON } from "./inhi/ctvorennia_papku_googleDrive.";
import { invalidateActStaffHistory, readActStaffHistory } from "./actStaffHistory";

/* ========= helpers: robust JSON unwrapping & name extraction ========= */

/** Розпаковує значення, якщо воно може бути JSON або "JSON у рядку".
 *  Пробуємо до 2-х рівнів: рядок → JSON, а якщо вийшов знову рядок з JSON — ще раз.
 */
function unwrapPossiblyDoubleEncodedJSON<T = any>(input: unknown): T | null {
  if (input == null) return null as any;

  let v: unknown = input;
  for (let i = 0; i < 2; i++) {
    if (typeof v === "string") {
      const t = v.trim();
      const looksLikeJson =
        (t.startsWith("{") && t.endsWith("}")) ||
        (t.startsWith("[") && t.endsWith("]"));
      if (looksLikeJson) {
        try {
          v = JSON.parse(t);
          continue; // спробуємо ще раз, якщо знову рядок з JSON
        } catch {
          // якщо не розпарсився — виходимо
        }
      }
    }
    break;
  }
  return v as T;
}

/** Дістає назву магазину з будь-якої форми: об’єкт {Name}, рядок з JSON, або просто рядок. */
function extractShopNameFromAny(raw: unknown): string | null {
  if (raw == null) return null;

  // 1) спершу розпакуємо можливий подвійнозакодований JSON
  const unwrapped = unwrapPossiblyDoubleEncodedJSON<any>(raw);

  // 2) якщо після розпаковки маємо об'єкт з Name — беремо його
  if (unwrapped && typeof unwrapped === "object" && "Name" in unwrapped) {
    const nm = String((unwrapped as any).Name ?? "").trim();
    return nm || null;
  }

  // 3) якщо це рядок — або це вже чиста назва, або «сирий» рядок
  if (typeof unwrapped === "string") {
    const s = unwrapped.trim();
    if (!s) return null;

    // раптом це ще один рівень JSON з Name
    const maybeObj = unwrapPossiblyDoubleEncodedJSON<any>(s);
    if (maybeObj && typeof maybeObj === "object" && "Name" in maybeObj) {
      const nm = String(maybeObj.Name ?? "").trim();
      return nm || null;
    }

    // інакше вважаємо, що це готова назва
    return s;
  }

  return null;
}

/* ===================== інтерфейси ===================== */

export interface SkladLiteRow {
  sclad_id: number;
  part_number: string;
  kilkist_on: number;
  kilkist_off: number;
  diff: number; // kilkist_off - kilkist_on
}

// Інтерфейс для загальних налаштувань
export interface GeneralSettings {
  stoName: string; // Назва СТО (setting_id: 1)
  address: string; // Адреса (setting_id: 2)
  phone: string; // Телефон (setting_id: 3)
  headerColor: string; // Колір шапки акту (setting_id: 4)
  tableColor: string; // Колір таблиці актів (setting_id: 5)
  printColorMode: boolean; // Режим друку: true = кольоровий, false = чорнобілий (setting_id: 6, data)
  wallpaperMain: string; // Шпалери основні (setting_id: 7, Загальні)
  aiEnabled: boolean; // ШІ підказки (setting_id: 7, data)
  aiChatEnabled: boolean; // ШІ Атлас - чат асистент (setting_id: 9, data)
  voiceInputEnabled: boolean; // 🎙️ Голосове введення (setting_id: 10, data)
  smsTextBefore: string; // SMS текст перед сумою (setting_id: 8)
  smsTextAfter: string; // SMS текст після суми (setting_id: 9)
  actTextOffset: number; // Глобальний зсув шрифту (-5..+15) (setting_id: 11)
  tableBorderWidth: number; // Товщина меж таблиці акту (setting_id: 12)
  tableBorderColor: string; // Колір меж таблиці акту (setting_id: 13)
  logoUrl: string; // Логотип компанії (setting_id: 14)
}

export interface ActItem {
  type: "detail" | "work";
  name: string;
  catalog: string;
  quantity: number;
  price: number;
  sum: number;
  person_or_store: string;
  sclad_id?: number | null;
  slyusar_id?: number | null;
  slyusarSum?: number; // ✅ Додано для зарплати слюсаря
  recordId?: string; // ✅ Унікальний ID запису для точного пошуку в історії слюсаря
  detail_id?: number | null; // ✅ ID деталі без складу
  work_id?: string | null; // ✅ ID роботи
}

export interface GlobalDataCache {
  works: string[];
  worksWithId: Array<{ work_id: string; name: string }>;
  details: string[];
  detailsWithId: Array<{ detail_id: number; name: string }>;
  slyusars: Array<{ Name: string; [k: string]: any }>;
  shops: Array<{ Name: string; [k: string]: any }>;
  settings: {
    showPibMagazin: boolean;
    showCatalog: boolean;
    showZarplata: boolean; // ← ДОДАНО
    showSMS: boolean; // ← ДОДАНО
    preferredLanguage: "uk" | "en"; // ← ДОДАНО: мова інтерфейсу
    saveMargins: boolean; // ← ДОДАНО: чи зберігати маржу та зарплати (row 6)
  };
  isActClosed: boolean;
  currentActId: number | null;
  carId: number | null; // ← ДОДАНО
  currentActDateOn: string | null;
  skladParts: Array<{
    sclad_id: number;
    part_number: string;
    name: string;
    price: number;
    kilkist_on: number;
    kilkist_off: number;
    quantity: number;
    unit?: string | null;
    shop?: string | null;
    time_on?: string | null;
    scladNomer?: number | null;
    statys?: string | null;
  }>;
  skladLite: SkladLiteRow[];
  oldNumbers: Map<number, number>;
  initialActItems: ActItem[];
  generalSettings: GeneralSettings; // Загальні налаштування СТО
}

export const globalCache: GlobalDataCache = {
  works: [],
  worksWithId: [],
  details: [],
  detailsWithId: [],
  slyusars: [],
  shops: [],
  settings: {
    showPibMagazin: true,
    showCatalog: true,
    showZarplata: true, // ← ДОДАНО
    showSMS: false, // ← ДОДАНО
    preferredLanguage: "uk", // ← ДОДАНО: типово українська
    saveMargins: true, // ← ДОДАНО: типово зберігаємо
  },
  isActClosed: false,
  currentActId: null,
  carId: null, // ← ДОДАНО
  currentActDateOn: null,
  skladParts: [],
  skladLite: [],
  oldNumbers: new Map<number, number>(),
  initialActItems: [],
  generalSettings: {
    stoName: "",
    address: "",
    phone: "",
    headerColor: "#164D25",
    tableColor: "#164D25",
    printColorMode: true, // За замовчуванням кольоровий друк
    wallpaperMain: "",
    aiEnabled: false, // За замовчуванням ШІ вимкнено
    aiChatEnabled: false, // За замовчуванням ШІ Атлас вимкнено
    voiceInputEnabled: false, // За замовчуванням голосове введення вимкнено
    smsTextBefore: "Ваше замовлення виконане. Сума:", // SMS текст перед сумою
    smsTextAfter: "грн. Дякуємо за довіру!", // SMS текст після суми
    actTextOffset: 0, // Глобальний зсув шрифту (дефолт 0)
    tableBorderWidth: 1, // Товщина меж таблиці (дефолт 1px)
    tableBorderColor: "#cccccc", // Колір меж таблиці (дефолт сірий)
    logoUrl: "", // Логотип компанії
  },
};

export const ZAKAZ_NARAYD_MODAL_ID = "zakaz_narayd-custom-modal";
export const ZAKAZ_NARAYD_BODY_ID = "zakaz_narayd-body";
export const ZAKAZ_NARAYD_CLOSE_BTN_ID = "zakaz_narayd-close";
export const ZAKAZ_NARAYD_SAVE_BTN_ID = "save-act-data";
export const EDITABLE_PROBIG_ID = "editable-probig";
export const EDITABLE_REASON_ID = "editable-reason";
export const EDITABLE_RECOMMENDATIONS_ID = "editable-recommendations";
export const EDITABLE_NOTES_ID = "editable-notes";

// 🔹 Ключ для збереження загальних налаштувань в localStorage
const GENERAL_SETTINGS_STORAGE_KEY = "sto_general_settings";
// 🔹 Ключ для прапора сесії (чи вже завантажено налаштування з БД в цій сесії)
const GENERAL_SETTINGS_SESSION_KEY = "sto_general_settings_loaded";

// 🔹 Перевіряє чи налаштування вже завантажено в цій сесії
export function isGeneralSettingsLoadedThisSession(): boolean {
  return sessionStorage.getItem(GENERAL_SETTINGS_SESSION_KEY) === "true";
}

// 🔹 Позначає що налаштування завантажено в цій сесії
export function markGeneralSettingsAsLoaded(): void {
  sessionStorage.setItem(GENERAL_SETTINGS_SESSION_KEY, "true");
}

// 🔹 Завантажує загальні налаштування з localStorage
export function loadGeneralSettingsFromLocalStorage(): boolean {
  try {
    const stored = localStorage.getItem(GENERAL_SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as GeneralSettings;
      globalCache.generalSettings = {
        stoName: parsed.stoName || "",
        address: parsed.address || "",
        phone: parsed.phone || "",
        headerColor: parsed.headerColor || "#164D25",
        tableColor: parsed.tableColor || "#164D25",
        printColorMode:
          parsed.printColorMode !== undefined ? parsed.printColorMode : true,
        wallpaperMain: parsed.wallpaperMain || "",
        aiEnabled: parsed.aiEnabled !== undefined ? parsed.aiEnabled : false,
        aiChatEnabled:
          parsed.aiChatEnabled !== undefined ? parsed.aiChatEnabled : false,
        voiceInputEnabled:
          parsed.voiceInputEnabled !== undefined
            ? parsed.voiceInputEnabled
            : false,
        smsTextBefore:
          parsed.smsTextBefore || "Ваше замовлення виконане. Сума:",
        smsTextAfter: parsed.smsTextAfter || "грн. Дякуємо за довіру!",
        actTextOffset:
          parsed.actTextOffset !== undefined ? parsed.actTextOffset : 0,
        tableBorderWidth:
          parsed.tableBorderWidth !== undefined ? parsed.tableBorderWidth : 1,
        tableBorderColor: parsed.tableBorderColor || "#cccccc",
        logoUrl: parsed.logoUrl || "",
      };
      // Застосовуємо шпалери після завантаження
      applyWallpapers();
      // Застосовуємо розміри шрифтів після завантаження
      applyFontSizes();
      // Застосовуємо межі таблиці після завантаження
      applyTableBorders();
      return true;
    }
  } catch (e) {
    // console.warn("⚠️ Помилка читання загальних налаштувань з localStorage:", e);
  }
  return false;
}

// 🔹 Зберігає загальні налаштування в localStorage
export function saveGeneralSettingsToLocalStorage(): void {
  try {
    localStorage.setItem(
      GENERAL_SETTINGS_STORAGE_KEY,
      JSON.stringify(globalCache.generalSettings),
    );
  } catch (e) {
    // console.warn(
    // "⚠️ Помилка збереження загальних налаштувань в localStorage:",
    // e,
    // );
  }
}

// 🔹 Завантажує загальні налаштування з БД і зберігає в localStorage
export async function loadGeneralSettingsFromDB(): Promise<void> {
  try {
    const { data: generalSettingsRows, error: settingsReadError } = (await supabase
      .from("settings")
      .select("setting_id, Загальні, data")
      .in("setting_id", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      .order("setting_id")) as {
      error?: unknown;
      data: Array<{
        setting_id: number;
        Загальні: string | null;
        data: boolean | null;
      }> | null;
    };

    if (settingsReadError) throw settingsReadError;
    if (generalSettingsRows) {
      for (const row of generalSettingsRows) {
        const value = (row as any)["Загальні"] || "";
        switch (row.setting_id) {
          case 1:
            globalCache.generalSettings.stoName = value || "";
            break;
          case 2:
            globalCache.generalSettings.address = value || "";
            break;
          case 3:
            globalCache.generalSettings.phone = value || "";
            break;
          case 4:
            globalCache.generalSettings.headerColor = value || "#164D25";
            break;
          case 5:
            globalCache.generalSettings.tableColor = value || "#164D25";
            break;
          case 6:
            globalCache.generalSettings.printColorMode =
              (row as any).data !== false; // true якщо data не false
            break;
          case 7:
            globalCache.generalSettings.wallpaperMain = value || "";
            globalCache.generalSettings.aiEnabled =
              (row as any).data === true || (row as any).data === "true"; // ШІ підказки
            break;
          case 8:
            globalCache.generalSettings.smsTextBefore =
              value || "Ваше замовлення виконане. Сума:";
            break;
          case 9:
            globalCache.generalSettings.smsTextAfter =
              value || "грн. Дякуємо за довіру!";
            // ШІ Атлас - записується в setting_id=9 data
            globalCache.generalSettings.aiChatEnabled =
              (row as any).data === true || (row as any).data === "true";
            break;
          case 10:
            // 🎙️ Голосове введення — записується в setting_id=10 data
            globalCache.generalSettings.voiceInputEnabled =
              (row as any).data === true || (row as any).data === "true";
            break;
          case 11:
            // 🔡 Глобальний зсув шрифту — записується в Загальні
            globalCache.generalSettings.actTextOffset = parseInt(value) || 0;
            break;
          case 12:
            // 📏 Товщина меж таблиці — записується в Загальні
            globalCache.generalSettings.tableBorderWidth = parseInt(value) || 1;
            break;
          case 13:
            // 🎨 Колір меж таблиці — записується в Загальні
            globalCache.generalSettings.tableBorderColor = value || "#cccccc";
            break;
          case 14:
            // Логотип компанії
            globalCache.generalSettings.logoUrl = value || "";
            break;
        }
      }
      // Зберігаємо в localStorage
      saveGeneralSettingsToLocalStorage();
      // Застосовуємо шпалери
      applyWallpapers();
      // Застосовуємо розміри шрифтів
      applyFontSizes();
      // Застосовуємо межі таблиці
      applyTableBorders();
    }
  } catch (e) {
    throw e;
  }
}

// 🔹 Застосовує глобальний зсув шрифту (через CSS змінну)
export function applyFontSizes(): void {
  const { actTextOffset } = globalCache.generalSettings;
  const root = document.documentElement;
  root.style.setProperty("--act-text-offset", `${actTextOffset ?? 0}`);
}

// 🔹 Застосовує товщину та колір меж таблиці (через CSS змінні)
export function applyTableBorders(): void {
  const { tableBorderWidth, tableBorderColor } = globalCache.generalSettings;
  const root = document.documentElement;
  root.style.setProperty("--table-border-width", `${tableBorderWidth ?? 1}px`);
  root.style.setProperty("--table-border-color", tableBorderColor || "#cccccc");
}

// 🔹 Застосовує шпалери до body.page-2
export function applyWallpapers(): void {
  const { wallpaperMain } = globalCache.generalSettings;

  // Застосовуємо шпалери для основної сторінки (body.page-2)
  if (wallpaperMain) {
    const styleId = "dynamic-wallpaper-main";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `body.page-2 { background-image: url("${wallpaperMain}") !important; }`;
  }
}

export const OPEN_GOOGLE_DRIVE_FOLDER_ID = "open-google-drive-folder";
export const ACT_ITEMS_TABLE_CONTAINER_ID = "act-items-table-container";

// ✅ Кешування глобальних даних з TTL (5 хвилин)
const GLOBAL_DATA_CACHE_TTL = 5 * 60 * 1000; // 5 хвилин
let lastGlobalDataLoadTime: number = 0;
let globalDataLoaded: boolean = false;
let globalDataPending: Promise<void> | null = null;
let dataGeneration = 0;
let staffRequestGeneration = 0;
let staffRequestedActId: number | null | undefined;
let skladLoaded = false;
let stockRevision = 0;
let stockEpoch = 0;
const stockRowRevisions = new Map<number, number>();
let fullStockLoadedAt = 0;
const stockLoadedAt = new Map<number, number>();
const pendingStockIds = new Map<string, Promise<void>>();
const pendingTableReads = new Map<string, Promise<any[]>>();
let editorStockActive = false;
let stockCatalogSubscription: DatabaseSubscription | null = null;
const stockSubscriptions = new Map<string, DatabaseSubscription>();
const watchedStockIds = new Set<number>();
const stockCatalogNames = new Map<number, string>();
let worksSubscription: DatabaseSubscription | null = null;
let detailsSubscription: DatabaseSubscription | null = null;

/** Примусово оновити кеш (наприклад, після додавання нових робіт/деталей) */
export function invalidateGlobalDataCache(): void {
  invalidateEditorReferences();
  dataGeneration++;
  skladLoaded = false;
  stockRevision++;
  stockEpoch++;
  stockRowRevisions.clear();
  stockLoadedAt.clear();
  globalDataLoaded = false;
  lastGlobalDataLoadTime = 0;
  // Очищаємо складові частини, щоб ensureSkladLoaded() перезавантажив їх
  globalCache.skladParts = [];
}

/** A confirmed quantity/status write does not invalidate names, settings or unrelated stock. */
export function invalidateEditorStockRows(values: readonly number[]): void {
  const ids = [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return;
  skladLoaded = false;
  stockRevision++;
  for (const id of ids) {
    stockLoadedAt.delete(id);
    stockRowRevisions.set(id, (stockRowRevisions.get(id) || 0) + 1);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:stock-updated", { detail: { id, revision: stockRevision } }));
  }
}

/* ===================== утиліти ===================== */

export function formatNumberWithSpaces(
  value: number | string | undefined | null,
  minimumFractionDigits: number = 0,
  maximumFractionDigits: number = 2,
): string {
  if (value === undefined || value === null || String(value).trim() === "")
    return "";
  const num = parseFloat(String(value).replace(",", "."));
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat("uk-UA", {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(num);
}

function dedupeSklad<
  T extends { sclad_id: number; part_number: string; price: number; quantity: number },
>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = String(r.sclad_id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ===================== завантаження кеша ===================== */

/**
 * Завантажує всі дані з таблиці з пагінацією (обхід ліміту 1000 записів Supabase)
 */
async function fetchAllWithPagination<T>(
  tableName: string,
  selectFields: string,
  orderBy?: string,
): Promise<T[]> {
  const key = JSON.stringify([dataGeneration, tableName, selectFields, orderBy]);
  const existing = pendingTableReads.get(key);
  if (existing) return existing as Promise<T[]>;
  const pending = fetchTablePages<T>(tableName, selectFields, orderBy);
  pendingTableReads.set(key, pending);
  try { return await pending; } finally {
    if (pendingTableReads.get(key) === pending) pendingTableReads.delete(key);
  }
}

async function fetchTablePages<T>(tableName: string, selectFields: string, orderBy?: string): Promise<T[]> {
  const allData: T[] = [];
  let from = 0;
  const step = 1000;
  let keepFetching = true;

  while (keepFetching) {
    let query = supabase
      .from(tableName)
      .select(selectFields)
      .range(from, from + step - 1);

    if (orderBy) {
      query = query.order(orderBy, { ascending: true });
    }

    const { data, error } = await query;

    if (error) {
      // console.error(`❌ Помилка завантаження ${tableName}:`, error.message);
      throw error;
    }

    if (data && data.length > 0) {
      allData.push(...(data as T[]));
      if (data.length < step) {
        keepFetching = false;
      } else {
        from += step;
      }
    } else {
      keepFetching = false;
    }
  }

  return allData;
}

export async function loadGlobalData(
  forceReload: boolean = false,
  actId: number | null = globalCache.currentActId,
): Promise<void> {
  ensureEditorReferenceScope();
  if (actId) initScladRealtimeSubscription();
  if (staffRequestedActId !== actId || forceReload) {
    staffRequestedActId = actId;
    staffRequestGeneration++;
  }
  const staffGeneration = staffRequestGeneration;
  if (!globalDataPending) globalDataPending = loadGlobalDataOnce(forceReload);
  const pending = globalDataPending;
  try { await pending; } finally {
    if (globalDataPending === pending) globalDataPending = null;
  }
  if (staffGeneration !== staffRequestGeneration) return;
  await loadStaffForAct(actId, forceReload, staffGeneration);
}

async function loadGlobalDataOnce(forceReload: boolean): Promise<void> {
  const generation = dataGeneration;
  // ✅ Кешування: якщо дані вже завантажені і TTL не вийшов - не перезавантажуємо
  const now = Date.now();
  if (
    !forceReload &&
    globalDataLoaded &&
    now - lastGlobalDataLoadTime < GLOBAL_DATA_CACHE_TTL
  ) {
    return;
  }

  try {
    // 🔹 Завантажуємо загальні налаштування:
    // - Якщо вже завантажено в цій сесії → просто беремо з localStorage
    // - Інакше (перезавантаження/новий вхід) → завантажуємо з БД і позначаємо прапором
    if (isGeneralSettingsLoadedThisSession()) {
      // Дані вже актуальні в цій сесії - просто читаємо з localStorage
      loadGeneralSettingsFromLocalStorage();
    } else {
      // Новий вхід або перезавантаження - завантажуємо з БД
      await loadGeneralSettingsFromDB();
      markGeneralSettingsAsLoaded();
    }

    const { data: settingsRows, error: settingsError } = await supabase
      .from("settings")
      .select("setting_id, data")
      .in("setting_id", [1, 2, 3, 5]);
    if (settingsError) throw settingsError;
    // A mutation invalidated this download; do not mark the older result fresh.
    if (generation !== dataGeneration) return loadGlobalDataOnce(true);
    const settingShop = settingsRows?.find((s: any) => s.setting_id === 1);
    const settingCatalog = settingsRows?.find((s: any) => s.setting_id === 2);
    const settingZarplata = settingsRows?.find((s: any) => s.setting_id === 3);
    const settingSMS = settingsRows?.find((s: any) => s.setting_id === 5);

    globalCache.settings = {
      showPibMagazin: !!settingShop?.data,
      showCatalog: !!settingCatalog?.data,
      showZarplata: !!settingZarplata?.data,
      showSMS: !!settingSMS?.data,
      preferredLanguage: "uk", // Типово українська
      saveMargins: true, // ✅ Завжди TRUE (більше не залежить від setting_id=6)
    };

    // ✅ Оновлюємо час кешу після успішного завантаження
    lastGlobalDataLoadTime = Date.now();
    globalDataLoaded = true;


  } catch (error) {
    // console.error("❌ Помилка завантаження глобальних даних:", error);
    showNotification("Помилка завантаження базових даних", "error");
    throw error;
  }
}

/**
 * ✅ Перезавантажує тільки слюсарів з бази даних
 * Використовується при отриманні broadcast про збереження акту іншим користувачем
 * щоб отримати актуальні дані з історії слюсарів (зарплати, тощо)
 */
async function loadStaffForAct(actId: number | null, force: boolean, request: number): Promise<void> {
  const generation = dataGeneration;
  const rows = await readActStaffHistory(actId, generation, force);
  if (request !== staffRequestGeneration) return;
  if (generation !== dataGeneration) return loadStaffForAct(actId, true, request);
  globalCache.slyusars = rows.map(row => safeParseJSON(row.data)).filter(data => data?.Name);
}

export async function reloadSlyusarsOnly(): Promise<void> {
  staffRequestedActId = globalCache.currentActId;
  await loadStaffForAct(globalCache.currentActId, true, ++staffRequestGeneration);
}

/** Invalidate one act after its payroll is archived/restored, without an RPC. */
export function invalidateEditorActStaffHistory(actId: number): void {
  if (!Number.isSafeInteger(actId) || actId <= 0) return;
  invalidateActStaffHistory(actId);
  if (staffRequestedActId === actId) staffRequestGeneration++;
  if (globalCache.currentActId !== actId) return;
  globalCache.slyusars = globalCache.slyusars.map(employee => {
    const history = employee["Історія"];
    if (!history || typeof history !== "object" || Array.isArray(history)) return employee;
    let nextHistory: Record<string, any> | undefined;
    for (const [day, entries] of Object.entries(history)) {
      if (!Array.isArray(entries)) continue;
      const retained = entries.filter(entry => Number(entry?.["Акт"]) !== actId);
      if (retained.length === entries.length) continue;
      const updatedHistory: Record<string, any> = nextHistory ?? { ...history };
      if (retained.length) updatedHistory[day] = retained;
      else delete updatedHistory[day];
      nextHistory = updatedHistory;
    }
    // Keep names, rates and other acts; never mutate a shared read snapshot.
    return nextHistory ? { ...employee, "Історія": nextHistory } : employee;
  });
}

export async function loadSkladLite(): Promise<void> {
  try {
    // ✅ ВИПРАВЛЕНО: Використовуємо пагінацію для завантаження ВСІХ записів
    const data = await fetchAllWithPagination<{
      sclad_id: number;
      part_number: string;
      kilkist_on: number;
      kilkist_off: number;
    }>("sclad", "sclad_id, part_number, kilkist_on, kilkist_off", "sclad_id");

    globalCache.skladLite = data.map((r: any): SkladLiteRow => {
      const on = Number(r.kilkist_on ?? 0);
      const off = Number(r.kilkist_off ?? 0);
      return {
        sclad_id: Number(r.sclad_id ?? 0),
        part_number: String(r.part_number || "").trim(),
        kilkist_on: on,
        kilkist_off: off,
        diff: off - on,
      };
    });
  } catch (e) {
    // console.error("💥 loadSkladLite(): критична помилка:", e);
    globalCache.skladLite = [];
  }
}

/* ===================== пошук у складі ===================== */

/**
 * Нормалізує каталожний номер для пошуку.
 * Пробіли, дефіси, крапки, коми, слеші та інші розділові знаки
 * не впливають на збіг: "AB-12.34" === "ab1234".
 */
export function normalizeCatalogSearchKey(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase("uk-UA")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function findScladItemByPart(part: string) {
  const pn = normalizeCatalogSearchKey(part);
  if (!pn) return null;
  return (
    globalCache.skladParts.find(
      (x) => normalizeCatalogSearchKey(x.part_number) === pn,
    ) ||
    null
  );
}

/** Resolve the first stable ID using the editor's legacy NFKD catalogue rules. */
export async function resolveScladItemByPart(part: string) {
  if (!normalizeCatalogSearchKey(part)) return null;
  const { data, error } = await supabase.rpc("traffic_editor_catalog_id", { p_catalog: part });
  if (error) throw error;
  if (data == null) return null;
  const id = Number(data);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Некоректний ID складської позиції");
  await ensureSkladIdsLoaded([id]);
  return globalCache.skladParts.find(row => row.sclad_id === id) || null;
}

export async function searchSkladNames(query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  ensureEditorReferenceScope();
  initStockCatalogSubscription();
  const ids = await readEditorStockNameIds(q, new Map(globalCache.skladParts.map(row => [row.sclad_id, [row.name, row.part_number]])));
  await ensureSkladIdsLoaded(ids);
  const byId = new Map(globalCache.skladParts.map(row => [row.sclad_id, row]));
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
}

export async function searchSkladCatalog(query: string, byName = false) {
  const raw = query.trim().toLocaleLowerCase("uk-UA");
  if (!raw) return [];
  const actor = ensureEditorReferenceScope();
  initStockCatalogSubscription();
  const ids = await readEditorCatalogIds(raw, byName);
  if (actor !== ensureEditorReferenceScope()) throw new Error("Користувач змінився під час пошуку складу");
  await ensureSkladIdsLoaded(ids);
  if (actor !== ensureEditorReferenceScope()) throw new Error("Користувач змінився під час пошуку складу");
  const byId = new Map(globalCache.skladParts.map(row => [row.sclad_id, row]));
  return ids.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
}

export function findScladItemsByName(name: string) {
  const q = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!q) return [];
  const tokens = q.split(" ").filter(Boolean);
  return globalCache.skladParts.filter((x) => {
    const nm = (x.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!nm) return false;
    if (nm.includes(q)) return true;
    return tokens.every((t) => nm.includes(t));
  });
}

/** Read only the stock rows needed by the current act. Partial cache never marks the entire stock loaded. */
export async function ensureSkladIdsLoaded(values: readonly number[]): Promise<void> {
  const ids = [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].sort((a,b) => a-b);
  if (editorStockActive) {
    ids.forEach(id => watchedStockIds.add(id));
    syncStockSubscriptions();
  }
  const now = Date.now();
  const candidates = ids.filter(id => now - (stockLoadedAt.get(id) ?? 0) >= GLOBAL_DATA_CACHE_TTL);
  if (!candidates.length) return;
  const generation = dataGeneration;
  const epoch = stockEpoch;
  const versions = new Map(ids.map(id => [id, stockRowRevisions.get(id) || 0]));
  const keyFor=(id:number)=>JSON.stringify([generation,epoch,versions.get(id),id]);
  const waits=[...new Set(candidates.map(id=>pendingStockIds.get(keyFor(id))).filter((p):p is Promise<void>=>!!p))];
  const missing=candidates.filter(id=>!pendingStockIds.has(keyFor(id)));
  if(!missing.length){await Promise.all(waits);return ensureSkladIdsLoaded(ids);}
  const pending = (async () => {
    const rows: any[] = [];
    for (let start = 0; start < missing.length; start += 100) {
      const { data, error } = await supabase.from("sclad")
        .select("sclad_id, part_number, name, price, kilkist_on, kilkist_off, unit_measurement, shops, time_on, scladNomer, statys")
        .in("sclad_id", missing.slice(start, start + 100));
      if (error) throw error;
      rows.push(...(data || []));
    }
    if (generation !== dataGeneration || epoch !== stockEpoch) return ensureSkladIdsLoaded(ids);
    // An event for another stock ID cannot invalidate this batch. A newer event
    // for a requested ID already supplied its current value (including deletion).
    const requested = new Set(missing.filter(id => versions.get(id) === (stockRowRevisions.get(id) || 0)));
    // A deleted row must not survive in the partial cache.
    globalCache.skladParts = globalCache.skladParts.filter(row => !requested.has(row.sclad_id));
    globalCache.skladParts.push(...rows.filter(row => requested.has(Number(row.sclad_id))).map(mapScladRecord));
    rows.forEach(row => { if (requested.has(Number(row.sclad_id))) stockCatalogNames.set(Number(row.sclad_id), stockCatalogKey(row)); });
    const loadedAt = Date.now();
    for (const id of requested) stockLoadedAt.set(id, loadedAt);
  })();
  for(const id of missing) pendingStockIds.set(keyFor(id),pending);
  try { await Promise.all([...waits,pending]); } finally {
    for(const id of missing) if(pendingStockIds.get(keyFor(id))===pending)pendingStockIds.delete(keyFor(id));
  }
  // Local confirmed writes expire rows without a Realtime payload. Do not let
  // an older in-flight read satisfy callers after that targeted invalidation.
  if (ids.some(id => Date.now() - (stockLoadedAt.get(id) ?? 0) >= GLOBAL_DATA_CACHE_TTL)) await ensureSkladIdsLoaded(ids);
}

export function isSkladFullyLoaded(): boolean {
  return skladLoaded && Date.now() - fullStockLoadedAt < GLOBAL_DATA_CACHE_TTL;
}

export async function ensureSkladLoaded(): Promise<void> {
  if (skladLoaded && Date.now() - fullStockLoadedAt < GLOBAL_DATA_CACHE_TTL) return;
  const generation = dataGeneration;
  const revision = stockRevision;

  // ✅ ВИПРАВЛЕНО: використовуємо пагінацію — більше не обрізаємо на 1000 записах
  const data = await fetchAllWithPagination<{
    sclad_id: number;
    part_number: string;
    name: string;
    price: number;
    kilkist_on: number;
    kilkist_off: number;
    unit_measurement: string | null;
    shops: any;
    time_on: string | null;
    scladNomer: number | null;
    statys: string | null;
  }>(
    "sclad",
    "sclad_id, part_number, name, price, kilkist_on, kilkist_off, unit_measurement, shops, time_on, scladNomer, statys",
    "sclad_id",
  );

  if (generation !== dataGeneration || revision !== stockRevision) return ensureSkladLoaded();
  const mapped = data.map((r: any) => {
    const on = Number(r.kilkist_on ?? 0);
    const off = Number(r.kilkist_off ?? 0);
    const shopName = extractShopNameFromAny(r.shops);
    return {
      sclad_id: Number(r.sclad_id ?? 0),
      part_number: String(r.part_number || "").trim(),
      name: String(r.name || "").trim(),
      price: Number(r.price ?? 0),
      kilkist_on: on,
      kilkist_off: off,
      quantity: on - off,
      unit: r.unit_measurement ?? null,
      shop: shopName,
      time_on: r.time_on ?? null,
      scladNomer: r.scladNomer ?? null,
      statys: r.statys ?? null,
    };
  });

  globalCache.skladParts = dedupeSklad(mapped);
  skladLoaded = true;
  fullStockLoadedAt = Date.now();
  for (const row of data) stockLoadedAt.set(row.sclad_id, fullStockLoadedAt);
}

/* ===================== REALTIME SUBSCRIPTION (SCLAD) ===================== */

/**
 * Ініціалізує Pro Realtime підписку на таблицю sclad.
 * Слухає INSERT, UPDATE, DELETE і синхронізує globalCache.skladParts.
 */
export function initScladRealtimeSubscription() {
  editorStockActive = true;
  syncStockSubscriptions();
}

function syncStockSubscriptions(): void {
  if (!editorStockActive) return;
  const ids = [...watchedStockIds].sort((a,b) => a-b), keys = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const group = ids.slice(offset, offset + 100), key = group.join(","); keys.add(key);
    if (stockSubscriptions.has(key)) continue;
    let connected = false;
    stockSubscriptions.set(key, databaseSubscriptions.subscribe({ table: "sclad", filter: `sclad_id=in.(${key})`,
      select: "sclad_id,part_number,name,price,kilkist_on,kilkist_off,unit_measurement,shops,time_on,scladNomer,statys".split(",") },
    payload => {
      const id = Number(payload.new?.sclad_id ?? payload.old?.sclad_id);
      if (!id && payload.eventType === "DELETE") {
        // Some legacy DELETE payloads lack row identity. Recheck this bounded
        // group instead of guessing which cached row vanished.
        stockEpoch++; group.forEach(value => stockLoadedAt.delete(value));
        if (typeof window !== "undefined") group.forEach(value => window.dispatchEvent(new CustomEvent("sto:stock-updated", { detail: { id: value } })));
        return;
      }
      if (group.includes(id) && watchedStockIds.has(id)) handleScladChange(payload);
    }, status => {
      if (status === "SUBSCRIBED") {
        // A read may have completed before the first subscription handshake.
        // Reconcile only those watched IDs, not every cached catalogue.
        stockEpoch++;
        if (connected || group.some(id => stockLoadedAt.has(id))) {
          group.forEach(id => stockLoadedAt.delete(id)); skladLoaded = false;
          if (typeof window !== "undefined") group.forEach(id => window.dispatchEvent(new CustomEvent("sto:stock-updated", { detail: { id } })));
        }
        connected = true;
      }
    }));
  }
  for (const [key, subscription] of stockSubscriptions) if (!keys.has(key)) { subscription.unsubscribe(); stockSubscriptions.delete(key); }
}

function stockCatalogKey(row: any): string { return JSON.stringify([row?.name ?? "", row?.part_number ?? ""]); }
function initStockCatalogSubscription(): void {
  if (!editorStockActive || stockCatalogSubscription) return;
  // The first lookup may finish before the asynchronous subscription joins.
  // Expire that snapshot once at first join as well as after reconnects.
  let disconnected = true;
  stockCatalogSubscription = databaseSubscriptions.subscribe({ table: "sclad", select: ["sclad_id", "name", "part_number"] }, payload => {
    const row = payload.new, old = payload.old, id = Number(row?.sclad_id ?? old?.sclad_id);
    if (!id) {
      if (payload.eventType === "DELETE" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:stock-catalog-updated"));
      return;
    }
    const previous = old && Object.prototype.hasOwnProperty.call(old, "name") ? stockCatalogKey(old) : stockCatalogNames.get(id);
    const next = payload.eventType === "DELETE" ? undefined : stockCatalogKey(row);
    if (next === undefined) stockCatalogNames.delete(id); else stockCatalogNames.set(id, next);
    if (stockCatalogNames.size > 2000) stockCatalogNames.delete(stockCatalogNames.keys().next().value!);
    if (payload.eventType === "UPDATE" && previous === next) return;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:stock-catalog-updated", { detail: { id } }));
  }, status => {
    if (status === "SUBSCRIBED") {
      if (disconnected && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:stock-catalog-updated"));
      disconnected = false;
    } else if (["CLOSED", "TIMED_OUT", "CHANNEL_ERROR"].includes(status)) disconnected = true;
  });
}

export function releaseEditorStockSubscription(): void {
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("sto:editor-scope-reset"));
  worksSubscription?.unsubscribe();worksSubscription=null;
  detailsSubscription?.unsubscribe();detailsSubscription=null;
  stockCatalogSubscription?.unsubscribe(); stockCatalogSubscription = null;
  for (const subscription of stockSubscriptions.values()) subscription.unsubscribe();
  stockSubscriptions.clear(); watchedStockIds.clear(); stockCatalogNames.clear(); stockRowRevisions.clear();
  editorStockActive = false;
  stockEpoch++; stockRevision++; stockLoadedAt.clear(); skladLoaded = false;
}

function handleScladChange(payload: any) {
  const { eventType, new: newRecord, old: oldRecord } = payload;
  const changedId = Number(newRecord?.sclad_id ?? oldRecord?.sclad_id);
  if (!changedId) return;
  const existing = globalCache.skladParts.find(row => row.sclad_id === changedId);
  if (eventType !== "DELETE" && existing && JSON.stringify(existing) === JSON.stringify(mapScladRecord(newRecord))) return;
  stockRevision++;
  stockRowRevisions.set(changedId, (stockRowRevisions.get(changedId) || 0) + 1);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:stock-updated", {detail:{id:changedId, revision:stockRevision}}));
  if (changedId) stockLoadedAt.set(changedId, Date.now());

  if (eventType === "DELETE") {
    // 🗑️ Видалення запису
    if (oldRecord && oldRecord.sclad_id) {
      globalCache.skladParts = globalCache.skladParts.filter(
        (p) => p.sclad_id !== oldRecord.sclad_id,
      );
    }
  } else if (eventType === "INSERT") {
    // ➕ Додавання запису
    if (newRecord) {
      const mapped = mapScladRecord(newRecord);
      // Додаємо в початок або кінець? В ensureSkladLoaded order desc, але тут можна просто push,
      // бо автодоповнення все одно фільтрує.
      if (!globalCache.skladParts.some(row => row.sclad_id === mapped.sclad_id)) globalCache.skladParts.push(mapped);
    }
  } else if (eventType === "UPDATE") {
    // 🔄 Оновлення запису
    if (newRecord) {
      const updated = mapScladRecord(newRecord);
      const index = globalCache.skladParts.findIndex(
        (p) => p.sclad_id === newRecord.sclad_id,
      );

      if (index !== -1) {
        globalCache.skladParts[index] = updated;
      } else {
        // Якщо раптом немає в кеші (наприклад, було додано поки ми були офлайн?), додаємо
        globalCache.skladParts.push(updated);
      }
    }
  }
}

/** Допоміжна функція для мапінгу "сирого" запису з Realtime у формат globalCache */
function mapScladRecord(r: any) {
  const on = Number(r.kilkist_on ?? 0);
  const off = Number(r.kilkist_off ?? 0);
  const shopName = extractShopNameFromAny(r.shops);
  return {
    sclad_id: Number(r.sclad_id ?? 0),
    part_number: String(r.part_number || "").trim(),
    name: String(r.name || "").trim(),
    price: Number(r.price ?? 0),
    kilkist_on: on,
    kilkist_off: off,
    quantity: on - off,
    unit: r.unit_measurement ?? null,
    shop: shopName,
    time_on: r.time_on ?? null,
    scladNomer: r.scladNomer ?? null,
    statys: r.statys ?? null,
  };
}

/* ===================== REALTIME SUBSCRIPTION (WORKS) ===================== */

/**
 * Ініціалізує Realtime підписку на таблицю works.
 * Слухає INSERT, UPDATE, DELETE і синхронізує globalCache.works та globalCache.worksWithId.
 */
export function initWorksRealtimeSubscription() {
  if (worksSubscription) return;
  worksSubscription=databaseSubscriptions.subscribe({table:"works",select:["work_id","data"]}, payload=>{invalidateEditorReferences();handleWorksChange(payload)});
}

function handleWorksChange(payload: any) {
  const { eventType, new: newRecord, old: oldRecord } = payload;

  if (eventType === "DELETE") {
    // 🗑️ Видалення роботи
    if (oldRecord && oldRecord.work_id) {
      const workIdStr = String(oldRecord.work_id);
      const index = globalCache.worksWithId.findIndex(
        (w) => w.work_id === workIdStr,
      );
      if (index !== -1) {
        globalCache.worksWithId.splice(index, 1);
        // Оновлюємо масив works
        globalCache.works = globalCache.worksWithId
          .map((w) => w.name)
          .filter(Boolean);
      }
    }
  } else if (eventType === "INSERT") {
    // ➕ Додавання роботи
    if (newRecord) {
      const mapped = {
        work_id: String(newRecord.work_id || ""),
        name: String(newRecord.data || "").trim(),
      };
      if (mapped.name) {
        globalCache.worksWithId.push(mapped);
        globalCache.works = globalCache.worksWithId
          .map((w) => w.name)
          .filter(Boolean);
      }
    }
  } else if (eventType === "UPDATE") {
    // 🔄 Оновлення роботи
    if (newRecord) {
      const workIdStr = String(newRecord.work_id);
      const index = globalCache.worksWithId.findIndex(
        (w) => w.work_id === workIdStr,
      );
      const updatedName = String(newRecord.data || "").trim();

      if (index !== -1) {
        globalCache.worksWithId[index].name = updatedName;
        globalCache.works = globalCache.worksWithId
          .map((w) => w.name)
          .filter(Boolean);
      } else if (updatedName) {
        // Якщо немає в кеші — додаємо
        globalCache.worksWithId.push({ work_id: workIdStr, name: updatedName });
        globalCache.works = globalCache.worksWithId
          .map((w) => w.name)
          .filter(Boolean);
      }
    }
  }
}

/* ===================== REALTIME SUBSCRIPTION (DETAILS) ===================== */

/**
 * Ініціалізує Realtime підписку на таблицю details.
 * Слухає INSERT, UPDATE, DELETE і синхронізує globalCache.details та globalCache.detailsWithId.
 */
export function initDetailsRealtimeSubscription() {
  if (detailsSubscription) return;
  detailsSubscription=databaseSubscriptions.subscribe({table:"details",select:["detail_id","data"]}, payload=>{invalidateEditorReferences();handleDetailsChange(payload)});
}

function handleDetailsChange(payload: any) {
  const { eventType, new: newRecord, old: oldRecord } = payload;

  if (eventType === "DELETE") {
    // 🗑️ Видалення деталі
    if (oldRecord && oldRecord.detail_id) {
      const detailId = Number(oldRecord.detail_id);
      const index = globalCache.detailsWithId.findIndex(
        (d) => d.detail_id === detailId,
      );
      if (index !== -1) {
        globalCache.detailsWithId.splice(index, 1);
        // Оновлюємо масив details
        globalCache.details = globalCache.detailsWithId.map((d) => d.name);
      }
    }
  } else if (eventType === "INSERT") {
    // ➕ Додавання деталі
    if (newRecord) {
      const mapped = {
        detail_id: Number(newRecord.detail_id || 0),
        name: String(newRecord.data || "").trim(),
      };
      if (mapped.name && mapped.detail_id) {
        globalCache.detailsWithId.push(mapped);
        globalCache.details = globalCache.detailsWithId.map((d) => d.name);
      }
    }
  } else if (eventType === "UPDATE") {
    // 🔄 Оновлення деталі
    if (newRecord) {
      const detailId = Number(newRecord.detail_id);
      const index = globalCache.detailsWithId.findIndex(
        (d) => d.detail_id === detailId,
      );
      const updatedName = String(newRecord.data || "").trim();

      if (index !== -1) {
        globalCache.detailsWithId[index].name = updatedName;
        globalCache.details = globalCache.detailsWithId.map((d) => d.name);
      } else if (updatedName && detailId) {
        // Якщо немає в кеші — додаємо
        globalCache.detailsWithId.push({
          detail_id: detailId,
          name: updatedName,
        });
        globalCache.details = globalCache.detailsWithId.map((d) => d.name);
      }
    }
  }
}

/** Partial, ID keyed reference cache. Consumers search remotely before using these candidates. */
let editorReferenceOwner: string | undefined;
function editorReferenceScope(): string {
  return typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
}
export function ensureEditorReferenceScope(): string {
  const actor = editorReferenceScope();
  if (actor !== editorReferenceOwner) {
    editorReferenceOwner = actor;
    releaseEditorStockSubscription();
    invalidateGlobalDataCache();
    globalCache.works=[];globalCache.worksWithId=[];
    globalCache.details=[];globalCache.detailsWithId=[];globalCache.shops=[];globalCache.slyusars=[];
  }
  return actor;
}
export async function loadEditorReferences(input: EditorReferenceQuery): Promise<void> {
  const actor=ensureEditorReferenceScope();
  // Activate catalog streams only once the editor actually uses the dictionaries.
  if (input.query || input.names?.length || input.workIds?.length) initWorksRealtimeSubscription();
  if (input.query || input.names?.length || input.detailIds?.length) initDetailsRealtimeSubscription();
  if (input.voice) initStockCatalogSubscription();
  const rows=await readEditorReferences(input);
  if(actor!==ensureEditorReferenceScope())throw new Error("Користувач змінився під час завантаження довідника");
  for(const row of rows){
    if(row.kind==="work"){
      const previous=globalCache.worksWithId.find(x=>x.work_id===row.id);
      if(previous) previous.name=row.name; else globalCache.worksWithId.push({work_id:row.id,name:row.name});
    } else if(row.kind==="shop") {
      if(row.name&&!globalCache.shops.some(x=>x.Name===row.name))globalCache.shops.push({Name:row.name});
    } else if(row.kind==="detail") {
      const previous=globalCache.detailsWithId.find(x=>x.detail_id===Number(row.id));
      if(previous)previous.name=row.name;else globalCache.detailsWithId.push({detail_id:Number(row.id),name:row.name});
    }
  }
  globalCache.works=globalCache.worksWithId.map(x=>x.name);
  globalCache.details=globalCache.detailsWithId.map(x=>x.name);
  await ensureSkladIdsLoaded(rows.filter(x=>x.kind==="stock").map(x=>Number(x.id)));
  if(actor!==ensureEditorReferenceScope())throw new Error("Користувач змінився під час завантаження довідника");
}
export async function loadActEditorReferences(data: any): Promise<void> {
  const actor=ensureEditorReferenceScope();
  const works=Array.isArray(data?.Роботи)?data.Роботи:[],details=Array.isArray(data?.Деталі)?data.Деталі:[];
  const names=[...new Set([...works.map((x:any)=>String(x.Робота||x.Назва||"")),...details.map((x:any)=>String(x.Деталь||x.Назва||"")),...details.map((x:any)=>String(x.Магазин||""))].filter(Boolean))];
  const workIds=[...new Set<string>(works.map((x:any)=>String(x.work_id||"")).filter(Boolean))];
  const detailIds=[...new Set<number>(details.map((x:any)=>Number(x.detail_id)).filter((id:number)=>Number.isSafeInteger(id)&&id>0))];
  const count=Math.max(names.length,workIds.length,detailIds.length);
  for(let i=0;i<count;i+=200) await loadEditorReferences({names:names.slice(i,i+200),workIds:workIds.slice(i,i+200),detailIds:detailIds.slice(i,i+200)});
  if(actor!==ensureEditorReferenceScope())throw new Error("Користувач змінився під час завантаження акту");
  // Preserve historical names too: shortened rendering must not depend on a renamed/deleted dictionary row.
  for(const row of works){const name=String(row.Робота||row.Назва||"");if(name&&!globalCache.works.includes(name))globalCache.works.push(name)}
  for(const row of details){const name=String(row.Деталь||row.Назва||"");if(name&&!globalCache.details.includes(name))globalCache.details.push(name)}
}
/** Saving pasted/typed rows must not infer absence from the partial suggestion cache. */
export async function prepareEditorRowReferences(body: HTMLElement): Promise<void> {
  const names = [...new Set(Array.from(body.querySelectorAll<HTMLElement>('[data-name="name"]'), cell =>
    (cell.getAttribute("data-full-name") || cell.textContent || "").trim()).filter(Boolean))];
  for (let start = 0; start < names.length; start += 200) await loadEditorReferences({ names: names.slice(start, start + 200) });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {if(!event.key||event.key==="userAuthData")ensureEditorReferenceScope();});
  supabase.auth.onAuthStateChange(event => {
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
    editorReferenceOwner=undefined;
    releaseEditorStockSubscription();invalidateGlobalDataCache();
    globalCache.works=[];globalCache.worksWithId=[];globalCache.details=[];globalCache.detailsWithId=[];globalCache.shops=[];globalCache.slyusars=[];
  });
}
