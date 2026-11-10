import { invalidateBatchLookupCaches } from "./batchLookup";
import { readBatchLookup, readBatchActValidity, readBatchReferenceValidity, type BatchLookupKind } from "./batchLookup";
import { invalidateStockReads } from "./stockReadRevision";
import { readStockPage } from "./stockPageRead";
// src\ts\roboha\dodatu_inchi_bazu\inhi\batchImportSclad.ts
// Updated: 2026-01-15 19:18
// === Guards for single init / single upload ===
let batchInitDone = false; // щоб не ініціалізувати слухачі повторно
let isUploading = false; // щоб не запустити upload кілька разів
let batchSessionVersion = 0;
let batchReadVersion = 0;
let batchNextCursor: number | null = null;
let batchPageLoading = false;
let batchPageFilter = "";
const emptyRowSnapshots = new WeakMap<object, Record<string, any>>();

import { collectStockDrafts, mergeStockDrafts } from "./stockDraftState";
import { CRUD, updateCRUD } from "../dodatu_inchi_bazu_danux";
import { readStockDirectory } from "./referenceLookup";
import {
  shopEditState,
  detailEditState,
  resetShopState,
  resetDetailState,
} from "./scladMagasunDetal";
import { resolveStockReferences, type ReferenceInput } from "./referenceWrite";
import { handleScladCrud, deleteScladSnapshot } from "../db_sclad";
import { showNotification } from "../../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { supabase } from "../../../vxid/supabaseClient";
import { userName as currentUserName } from "../../tablucya/users";
import { initCustomDatePicker } from "./customDatePicker";
import { initVoiceInputExcel } from "./voiceInputExcel";
import { STOCK_UNIT_OPTIONS } from "./batchUnitOptions";
import { assertInvoiceOriginsNotPresent } from "../../workshop/invoicePersistence";
import { globalCache } from "../../zakaz_naraudy/globalCache";
import { logAction } from "../../../utils/auditLogger";
const batchModalId = "batch-import-modal-Excel";
const batchCatalogSearchInputId = "batch-catalog-search-Excel";
const confirmModalId = "batch-confirm-modal-Excel";
let parsedDataGlobal: any[] = [];
let shopsListCache: string[] = [];
let detailsListCache: string[] = [];
let actsListCache: string[] = [];
const actOptionLabels = new Map<string,string>();
let actsDateOffMap: Map<number, string | null> = new Map();
let scladIdsMap: Map<string, string> = new Map();
let warehouseListCache: string[] = []; // Кеш активних складів (номери)
let warehouseProcentMap: Map<string, number> = new Map(); // Кеш відсотків складів: warehouse_id -> procent
let usersListCache: string[] = []; // Кеш користувачів (не Слюсарів)

// ===== Снапшот оригінальних даних для відстеження змін =====
// Ключ — _scladId, значення — оригінальні поля рядка при завантаженні
let originalSnapshotMap: Map<string | number, Record<string, any>> = new Map();

// Кеш даних актів, щоб не перезавантажувати один і той самий акт

// ===== Людські назви полів (для повідомлень про зміни) =====
const fieldLabelsUk: Record<string, string> = {
  date: "Дата",
  shop: "Магазин",
  catno: "Номер деталі",
  detail: "Деталь",
  qty: "Кількість",
  price: "Ціна",
  clientPrice: "Ціна клієнта",
  warehouse: "Склад",
  invoice: "Рахунок",
  actNo: "Акт",
  unit: "Од. виміру",
  orderStatus: "Статус",
  createdBy: "Замовник",
  notes: "Примітка",
  action: "Дія",
};

/** Побудувати опис змін для рядка (порівняння зі снапшотом) */
function buildRowChangesDescription(row: any): string[] {
  const snapshot = originalSnapshotMap.get(row._scladId);
  if (!snapshot) return [];
  const changes: string[] = [];
  const fieldsToCompare = [
    "date",
    "shop",
    "catno",
    "detail",
    "qty",
    "price",
    "clientPrice",
    "warehouse",
    "invoice",
    "actNo",
    "unit",
    "orderStatus",
    "createdBy",
    "notes",
    "action",
  ];
  for (const key of fieldsToCompare) {
    const oldVal = String(snapshot[key] ?? "").trim();
    const newVal = String(row[key] ?? "").trim();
    if (oldVal !== newVal) {
      const label = fieldLabelsUk[key] || key;
      changes.push(`${label}: «${oldVal || "—"}» → «${newVal || "—"}»`);
    }
  }
  return changes;
}

/** Побудувати короткий опис для нового рядка */
function buildRowAddedDescription(row: any): string {
  const parts: string[] = [];
  if (row.detail) parts.push(row.detail);
  if (row.catno) parts.push(`№${row.catno}`);
  if (row.shop) parts.push(row.shop);
  return parts.join(", ");
}

/** Короткий ідентифікатор рядка: деталь + номер */
function rowIdentifier(row: any): string {
  const parts: string[] = [];
  if (row.detail) parts.push(row.detail);
  if (row.catno) parts.push(`№${row.catno}`);
  return parts.join(" ") || "—";
}

/** Зберегти снапшот оригінальних значень рядка */
function saveRowSnapshot(row: any): void {
  if (!row._scladId) return;
  originalSnapshotMap.set(row._scladId, {
    _db: row._dbSnapshot ? structuredClone(row._dbSnapshot) : undefined,
    date: row.date,
    shop: row.shop,
    catno: row.catno,
    detail: row.detail,
    qty: row.qty,
    price: row.price,
    clientPrice: row.clientPrice,
    clientPriceManual: !!row.clientPriceManual,
    warehouse: row.warehouse,
    invoice: row.invoice,
    actNo: row.actNo,
    unit: row.unit,
    orderStatus: row.orderStatus,
    createdBy: row.createdBy,
    notes: row.notes,
    action: row.action,
  });
}

/** Отримати тільки змінені поля для sclad update (порівняння з снапшотом) */
function getChangedScladFields(
  row: any,
  dbDate: string,
  slyusarIdForRow: number | null,
): Record<string, any> | null {
  const snapshot = originalSnapshotMap.get(row._scladId);

  // Маппінг: поле рядка → поле БД + перетворення
  const fieldMap: Array<{
    rowKey: string;
    dbKey: string;
    transform: (v: any) => any;
    snapshotKey?: string;
  }> = [
    { rowKey: "date", dbKey: "time_on", transform: () => dbDate || null },
    { rowKey: "shop", dbKey: "shops", transform: (v: any) => v || null },
    { rowKey: "catno", dbKey: "part_number", transform: (v: any) => v || null },
    { rowKey: "detail", dbKey: "name", transform: (v: any) => v || null },
    {
      rowKey: "qty",
      dbKey: "kilkist_on",
      transform: (v: any) => parseLocalizedNumber(v),
    },
    {
      rowKey: "price",
      dbKey: "price",
      transform: (v: any) => parseLocalizedNumber(v),
    },
    {
      rowKey: "clientPrice",
      dbKey: "client_price",
      transform: (_v: any) =>
        row.clientPriceManual ? parseLocalizedNumber(row.clientPrice) || 0 : null,
      snapshotKey: "clientPrice",
    },
    { rowKey: "invoice", dbKey: "rahunok", transform: (v: any) => v || null },
    {
      rowKey: "unit",
      dbKey: "unit_measurement",
      transform: (v: any) => v || null,
    },
    { rowKey: "actNo", dbKey: "akt", transform: (v: any) => v || null },
    {
      rowKey: "warehouse",
      dbKey: "scladNomer",
      transform: (v: any) => (v ? parseLocalizedNumber(v) : null),
    },
    {
      rowKey: "orderStatus",
      dbKey: "statys",
      transform: (v: any) => (v === "Прибула" ? null : v || null),
    },
    { rowKey: "notes", dbKey: "prumitka", transform: (v: any) => v || null },
    {
      rowKey: "createdBy",
      dbKey: "xto_zamovuv",
      transform: () => slyusarIdForRow || null,
    },
  ];

  if (!snapshot) throw new Error("Немає початкових значень рядка. Оновіть склад перед редагуванням.");

  const changed: Record<string, any> = {};
  let hasChanges = false;

  for (const { rowKey, dbKey, transform } of fieldMap) {
    const oldVal = String(snapshot[rowKey] ?? "");
    const newVal = String(row[rowKey] ?? "");
    const manualChanged =
      rowKey === "clientPrice" &&
      !!snapshot.clientPriceManual !== !!row.clientPriceManual;
    if (oldVal !== newVal || manualChanged) {
      changed[dbKey] = transform(row[rowKey]);
      hasChanges = true;
    }
  }

  return hasChanges ? changed : null;
}

// ===== Стан сортування таблиці =====
let sortColumn: string | null = null; // Поточна колонка сортування
let sortDirection: "asc" | "desc" = "desc"; // Напрямок сортування

// Тип колонки: date, number, text
function getColumnSortType(col: string): "date" | "number" | "text" {
  if (col === "date") return "date";
  if (
    ["qty", "price", "clientPrice", "warehouse", "invoice", "actNo"].includes(
      col,
    )
  )
    return "number";
  return "text";
}

// Парсинг дати dd.mm.yy або yyyy-mm-dd → timestamp для порівняння
function parseDateForSort(dateStr: string): number {
  if (!dateStr) return 0;
  // Формат ISO: yyyy-mm-dd
  if (dateStr.includes("-")) {
    const t = new Date(dateStr).getTime();
    return isNaN(t) ? 0 : t;
  }
  // Формат: dd.mm.yy
  const parts = dateStr.split(".");
  if (parts.length !== 3) return 0;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  return new Date(year, month, day).getTime();
}

// Сортування parsedDataGlobal та повторний рендер
function sortTableByColumn(col: string) {
  if (sortColumn === col) {
    // Той самий стовпець — міняємо напрямок
    sortDirection = sortDirection === "desc" ? "asc" : "desc";
  } else {
    // Новий стовпець
    sortColumn = col;
    // Для дати: перший клік = desc (від нової до старої)
    // Для чисел: перший клік = desc (від більшого до меншого)
    // Для тексту: перший клік = asc (А→Я)
    const type = getColumnSortType(col);
    sortDirection = type === "text" ? "asc" : "desc";
  }

  const type = getColumnSortType(col);

  parsedDataGlobal.sort((a: any, b: any) => {
    let valA = a[col];
    let valB = b[col];

    let cmp = 0;
    if (type === "date") {
      const tA = parseDateForSort(String(valA || ""));
      const tB = parseDateForSort(String(valB || ""));
      cmp = tA - tB;
    } else if (type === "number") {
      const nA = parseLocalizedNumber(valA);
      const nB = parseLocalizedNumber(valB);
      cmp = nA - nB;
    } else {
      // text — алфавітний порядок
      const sA = String(valA || "").toLowerCase();
      const sB = String(valB || "").toLowerCase();
      cmp = sA.localeCompare(sB, "uk");
    }

    return sortDirection === "asc" ? cmp : -cmp;
  });

  renderBatchTable(parsedDataGlobal);
}

// Оригінальні назви заголовків колонок (щоб не накопичувались індикатори)
const columnHeaderNames: Record<string, string> = {
  rowNum: "№",
  date: "Дата",
  shop: "Магазин",
  catno: "Каталог номер",
  detail: "Деталь",
  qty: "К-ть",
  price: "Ціна",
  clientPrice: "Клієнта",
  warehouse: "Склад",
  invoice: "Рах. №",
  actNo: "Акт №",
  unit: "О-ця",
  orderStatus: "Статус",
  createdBy: "Замовив",
  notes: "Примітка",
  action: "Дія",
  status: "Г-ть",
};

// Оновлення індикаторів сортування в шапці
function updateSortIndicators() {
  const thead = document.querySelector("#batch-table-Excel thead tr");
  if (!thead) return;
  thead.querySelectorAll("th").forEach((th) => {
    const col = (th as HTMLElement).dataset.col;
    if (!col) return;
    const baseText = columnHeaderNames[col] || col;
    if (col === sortColumn) {
      const arrow = sortDirection === "desc" ? "&#9660;" : "&#9650;";
      th.innerHTML = `${baseText} <span style="color:#2196f3;font-size:8px;vertical-align:middle;">${arrow}</span>`;
    } else {
      th.textContent = baseText;
    }
  });
}
let activeFilter: string = "Замовити+Замовлено"; // Поточний активний фільтр статусу
let batchCatalogSearchReloadTimer: number | null = null;
let partNumbersCache: string[] = []; // Кеш каталог номерів з бази sclad
let partNumberNameMap: Map<string, string[]> = new Map(); // Каталог номер → унікальні назви деталей
let usersIdMap: Map<string, number | null> = new Map(); // null — неоднозначний ПІБ
let usersIdReverseMap: Map<number, string> = new Map(); // Кеш slyusar_id → ПІБ (зворотній)
let usersCacheActor: string | null = null;

function clearBatchUsers(): void {
  usersListCache = [];
  usersIdMap.clear();
  usersIdReverseMap.clear();
  usersCacheActor = null;
}
const UNIT_OPTIONS = STOCK_UNIT_OPTIONS;
const VALID_UNITS = UNIT_OPTIONS.map((o) => o.value);

// Опції для статусу деталі (Прибула/Замовлено/Замовити)
const ORDER_STATUS_OPTIONS = [
  { value: "Замовити", label: "Замовити", color: "#f87171" },
  { value: "Замовлено", label: "Замовлено", color: "#3b82f6" },
  { value: "Прибула", label: "Прибула", color: "#2D7244" },
];

// Опції для дії (Записати/Видалити)
const ACTION_OPTIONS = [
  { value: "Записати", label: "Записати", color: "#2D7244" },
  { value: "Видалити", label: "Видалити", color: "#ef4444" },
];
// ===== Допоміжні функції =====


// Нормалізація назви для порівняння (без врахування регістру і зайвих пробілів)
function normalizeNameForCompare(s: string): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCatalogSearch(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function sanitizeCatalogInputValue(value: string): string {
  return normalizeCatalogSearch(value);
}

function catalogMatchesSearch(
  catalog: string | null | undefined,
  query: string,
): boolean {
  const rawCatalog = String(catalog || "").toLowerCase();
  const rawQuery = query.toLowerCase().trim();
  if (!rawQuery) return true;
  if (rawCatalog.includes(rawQuery)) return true;

  const normalizedCatalog = normalizeCatalogSearch(catalog);
  const normalizedQuery = normalizeCatalogSearch(query);
  return !!normalizedQuery && normalizedCatalog.includes(normalizedQuery);
}

function getBatchCatalogSearchInput(): HTMLInputElement | null {
  return document.getElementById(
    batchCatalogSearchInputId,
  ) as HTMLInputElement | null;
}

function getBatchCatalogSearchValue(): string {
  return getBatchCatalogSearchInput()?.value?.trim() || "";
}

function clearBatchCatalogSearchInput(): void {
  const input = getBatchCatalogSearchInput();
  if (input) input.value = "";
}

let detailsListCacheNormalized: string[] = [];
let shopsListCacheNormalized: string[] = [];

// Перевірка чи назва існує в кеші (нормалізоване порівняння)
function detailExistsInCache(name: string): boolean {
  const normalized = normalizeNameForCompare(name);
  return detailsListCacheNormalized.includes(normalized);
}
function shopExistsInCache(name: string): boolean {
  const normalized = normalizeNameForCompare(name);
  return shopsListCacheNormalized.includes(normalized);
}



function uniqAndSort(list: string[]): string[] {
  const uniq = Array.from(new Set(list));
  const collator = new Intl.Collator(["uk", "ru", "en"], {
    sensitivity: "base",
  });
  return uniq.sort((a, b) => collator.compare(a, b));
}
function toIsoDate(dateStr: string): string {
  if (!dateStr?.trim()) return "";
  let cleanDate = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) return cleanDate;

  // Підтримка dd.mm.yyyy
  const match4 = cleanDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match4) {
    const [, dd, mm, yyyy] = match4;
    const d = parseInt(dd, 10);
    const m = parseInt(mm, 10);
    const y = parseInt(yyyy, 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      return `${y}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
    }
  }

  // Підтримка dd.mm.yy
  const match2 = cleanDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (match2) {
    const [, dd, mm, yy] = match2;
    const d = parseInt(dd, 10);
    const m = parseInt(mm, 10);
    const y2 = parseInt(yy, 10);
    const yyyy = y2 >= 50 ? 1900 + y2 : 2000 + y2;
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${yyyy}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
    }
  }

  return "";
}
/** Завантаження списку активних складів з таблиці settings */
async function loadWarehouseList(): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("setting_id, procent")
      .gte("setting_id", 1)
      .lte("setting_id", 500)
      .not("procent", "is", null)
      .gte("procent", 0)
      .order("setting_id", { ascending: true });

    if (error || !Array.isArray(data)) {
      // console.error("Error loading warehouses:", error);
      return [];
    }

    // Заповнюємо карту відсотків для кожного складу
    warehouseProcentMap.clear();
    data.forEach((row: { setting_id: number; procent: number }) => {
      warehouseProcentMap.set(String(row.setting_id), row.procent);
    });

    // Активні склади - повертаємо номери як рядки
    return data.map((row: { setting_id: number }) => String(row.setting_id));
  } catch (e) {
    // console.error("Error loading warehouse list:", e);
    return [];
  }
}

/** Завантаження списку користувачів (не Слюсарів) з таблиці slyusars */
async function loadUsersList(): Promise<{
  names: string[];
  byName: Map<string, number | null>;
  byId: Map<number, string>;
}> {
  let data: Array<{ slyusar_id: number; data: unknown }> | undefined;
  try {
    data = await readStockDirectory<{ slyusar_id: number; data: unknown }>("staff");
  } catch {
    throw new Error("Не вдалося завантажити імена замовників. Перевірте з’єднання та відкрийте вікно деталей повторно.");
  }
  if (!data) {
    throw new Error("Для списку замовників встановіть SQL-функцію traffic_stock_directory з міграцій проєкту та відкрийте вікно деталей повторно.");
  }

  const names: string[] = [];
  const byName = new Map<string, number | null>();
  const byId = new Map<number, string>();
  for (const row of data) {
    const d = row?.data;
    const slyusarId = Number(row?.slyusar_id);
    let parsed: any = d;
    if (typeof d === "string") {
      try {
        parsed = JSON.parse(d);
      } catch {
        continue;
      }
    }
    if (!parsed || typeof parsed !== "object") continue;

    // Пропускаємо Слюсарів
    const access = parsed["Доступ"] || parsed["доступ"] || "";
    if (access === "Слюсар") continue;

    // Отримуємо ім'я
    const name = parsed["Name"] || parsed["name"] || parsed["Ім'я"] || "";
    if (typeof name === "string" && name.trim()) {
      if (!Number.isSafeInteger(slyusarId) || slyusarId <= 0) {
        throw new Error("Некоректний ID замовника. Перевірте довідник співробітників і відкрийте вікно деталей повторно.");
      }
      const trimmedName = name.trim();
      names.push(trimmedName);
      // Зберігаємо відповідність ПІБ → slyusar_id та зворотню
      const duplicate = byName.has(trimmedName) && byName.get(trimmedName) !== slyusarId;
      byName.set(trimmedName, duplicate ? null : slyusarId);
      byId.set(slyusarId, trimmedName);
    }
  }
  return { names: uniqAndSort(names), byName, byId };
}

// Повертає id магазину або null, якщо не знайдено

// Повертає id деталі або null, якщо не знайдено
// Підтримує як JSON формат (data->>Name), так і plain text формат (data)

/** Батч-оновлення акта: завантажує акт 1 раз, додає/оновлює всі деталі, зберігає 1 раз */
async function batchUpdateActWithDetails(
  actNo: string,
  detailsArray: any[],
  assertActor: () => void,
): Promise<boolean> {
  try {
    const actId = parseInt(actNo, 10);
    const toAmount = (value: any): number => {
      const amount = Number(value);
      return Number.isFinite(amount) ? amount : 0;
    };
    const applyDetailsDelta = (delta: number): void => {
      if (delta === 0) return;
      actJsonData["За деталі"] = toAmount(actJsonData["За деталі"]) + delta;
      if (actJsonData["Загальна сума"] !== undefined) {
        actJsonData["Загальна сума"] =
          toAmount(actJsonData["Загальна сума"]) + delta;
      }
    };

    assertActor();
    const { data: actData, error: readError } = await supabase.rpc("traffic_batch_act_details", { p_act_id: actId });
    assertActor();
    if (readError) throw readError;
    if (!actData || Number(actData.act_id) !== actId || !actData.data || typeof actData.data !== "object" ||
        Array.isArray(actData.data) || !/^[a-f0-9]{32}$/.test(actData.checksum || "")) throw new Error("Некоректний знімок деталей акту.");
    const actJsonData = structuredClone(actData.data);

    if (!Array.isArray(actJsonData["Деталі"])) {
      actJsonData["Деталі"] = [];
    }
    if (!actJsonData["За деталі"]) {
      actJsonData["За деталі"] = 0;
    }

    // Обробляємо всі деталі з масиву
    for (const detailData of detailsArray) {
      const shouldUpdateExisting = detailData._updateExisting !== false;
      const detailForAct = { ...detailData };
      delete detailForAct._updateExisting;
      let existingIndex = -1;

      if (detailForAct.sclad_id) {
        existingIndex = actJsonData["Деталі"].findIndex(
          (d: any) => d.sclad_id && d.sclad_id === detailForAct.sclad_id,
        );
      }

      if (existingIndex === -1 && detailForAct["Каталог"]) {
        const newCatNo = String(detailForAct["Каталог"]).trim().toLowerCase();
        const newDetailName = String(detailForAct["Деталь"] || "")
          .trim()
          .toLowerCase();
        if (newCatNo && newCatNo !== "?") {
          existingIndex = actJsonData["Деталі"].findIndex((d: any) => {
            const existingCatNo = String(d["Каталог"] || "")
              .trim()
              .toLowerCase();
            const existingDetailName = String(d["Деталь"] || "")
              .trim()
              .toLowerCase();
            return (
              !d.sclad_id && existingCatNo === newCatNo && existingDetailName === newDetailName
            );
          });
        }
      }

      const detailSum = toAmount(detailForAct["Сума"]);

      if (existingIndex !== -1) {
        if (!shouldUpdateExisting) continue;
        const oldDetail = actJsonData["Деталі"][existingIndex];
        const oldDetailSum = toAmount(oldDetail["Сума"]);
        actJsonData["Деталі"][existingIndex] = {
          ...oldDetail,
          Деталь: detailForAct["Деталь"] || oldDetail["Деталь"],
          Каталог: detailForAct["Каталог"] || oldDetail["Каталог"],
          Магазин: detailForAct["Магазин"] || oldDetail["Магазин"],
          Кількість:
            detailForAct["Кількість"] ?? oldDetail["Кількість"] ?? 0,
          Ціна: detailForAct["Ціна"] ?? oldDetail["Ціна"] ?? 0,
          Сума: detailForAct["Сума"] ?? oldDetail["Сума"] ?? 0,
          sclad_id: detailForAct.sclad_id || oldDetail.sclad_id,
        };
        applyDetailsDelta(detailSum - oldDetailSum);
      } else {
        actJsonData["Деталі"].push(detailForAct);
        applyDetailsDelta(detailSum);
      }
    }

    // Один запит на оновлення акта (замість N запитів на кожну деталь)
    const revision = crypto.randomUUID();
    assertActor();
    const { data: receipt, error: writeError } = await supabase.rpc("write_batch_act_details", {
      p_act_id: actId, p_checksum: actData.checksum, p_projection: actJsonData, p_revision: revision,
    });
    assertActor();
    if (writeError) throw writeError;
    if (Number(receipt?.act_id) !== actId || receipt?.revision !== revision || receipt?.status !== "updated") throw new Error("Не отримано підтвердження запису деталей.");
    window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId, revision,
      affectedCarIds: receipt.cars_id ? [Number(receipt.cars_id)] : undefined } }));

    // Оновлюємо кеш
    return true;
  } catch (err) {
    console.error(`Помилка при роботі з актом №${actNo}:`, err);
    return false;
  }
}
// ===== Модалки =====
function createConfirmModal() {
  const modal = document.createElement("div");
  modal.id = confirmModalId;
  modal.className = "modal-overlay-all_other_bases hidden-all_other_bases";
  modal.innerHTML = `
    <div class="modal-all_other_bases confirm-modal-Excel">
      <div class="confirm-content-Excel">
        <div class="confirm-icon-Excel">💾</div>
        <h3 class="confirm-title-Excel">Підтвердження завантаження</h3>
        <p class="confirm-message-Excel"></p>
        <div class="confirm-buttons-Excel">
          <button id="confirm-yes-Excel" class="confirm-btn-Excel yes-Excel">✅ Так, завантажити</button>
          <button id="confirm-no-Excel" class="confirm-btn-Excel no-Excel">❌ Скасувати</button>
        </div>
      </div>
    </div>
  `;
  return modal;
}
function showConfirmModal(count: number, totalCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById(confirmModalId);
    if (!modal) return resolve(false);
    const message = modal.querySelector(".confirm-message-Excel");
    if (message) {
      const isFull = count === totalCount;
      const colorStyle = isFull ? "color: #10b981;" : "color: #ef4444;"; // green-500 : red-500
      message.innerHTML = `Завантажити <strong style="${colorStyle}">${count}</strong> із <strong style="${colorStyle}">${totalCount}</strong> записів в базу даних?`;
    }
    modal.classList.remove("hidden-all_other_bases");
    const yesBtn = document.getElementById("confirm-yes-Excel");
    const noBtn = document.getElementById("confirm-no-Excel");
    const cleanup = () => {
      modal.classList.add("hidden-all_other_bases");
      yesBtn?.removeEventListener("click", onYes);
      noBtn?.removeEventListener("click", onNo);
    };
    const onYes = () => {
      cleanup();
      resolve(true);
    };
    const onNo = () => {
      cleanup();
      showNotification("Завантаження скасовано", "warning");
      resolve(false);
    };
    yesBtn?.addEventListener("click", onYes);
    noBtn?.addEventListener("click", onNo);
  });
}
function createBatchImportModal() {
  const modal = document.createElement("div");
  modal.id = batchModalId;
  modal.className = "modal-overlay-all_other_bases hidden-all_other_bases";
  modal.innerHTML = `
    <style>
      .batch-table-container-Excel {
        overflow-y: auto;
        position: relative;
      }
      .batch-table-Excel {
        border-collapse: separate; 
        border-spacing: 0;
        width: 100%;
      }
      .batch-table-Excel thead th {
        position: sticky !important;
        top: 0 !important;
        z-index: 100;
      }
      .excel-dropdown-list {
        z-index: 99999 !important;
      }
      #${batchCatalogSearchInputId} {
        width: 260px;
        min-width: 220px;
        max-width: 100%;
        height: 38px;
        padding: 8px;
        font-size: 14px;
        border: 2px solid rgb(224, 224, 224);
        box-sizing: border-box;
      }
      @media (max-width: 1024px) {
        #${batchCatalogSearchInputId} {
          width: 100%;
          min-width: 0;
          grid-column: 1 / -1;
        }
      }
    </style>
    <div class="modal-all_other_bases batch-modal-Excel">
      <button class="modal-close-all_other_bases">×</button>
      <div class="modal-content-Excel">
        <div class="batch-filter-bar-Excel">
          <h3 class="batch-title-Excel">Записати деталі</h3>
          <div class="batch-filter-buttons-Excel">
            <button id="filter-zamovyty-btn" class="batch-filter-btn-Excel filter-red-Excel" data-filter="Замовити" title="Показати записи зі статусом Замовити">Замовити</button>
            <button id="filter-zamovleno-btn" class="batch-filter-btn-Excel filter-blue-Excel" data-filter="Замовлено" title="Показати записи зі статусом Замовлено">Замовлено</button>
            <button id="filter-prybuly-btn" class="batch-filter-btn-Excel filter-white-Excel" data-filter="Прибула" title="Показати записи зі статусом Прибула">Прибула</button>
            <button id="filter-zamovyty-zamovleno-btn" class="batch-filter-btn-Excel filter-gradient-Excel active-filter-Excel" data-filter="Замовити+Замовлено" title="Показати Замовити та Замовлено">Замовити + Замовлено</button>
            <button id="batch-clear-and-add-btn-Excel" class="batch-filter-btn-Excel filter-orange-Excel" title="Очистити таблицю та додати новий запис">Додати</button>
            <input type="text" class="Bukhhalter-field-input cell-input-combo-Excel batch-catalog-search-Excel" id="${batchCatalogSearchInputId}" placeholder="Введіть або оберіть Каталог номер..." style="border-radius: 8px; border-color: rgb(224, 224, 224);" autocomplete="off">
          </div>
          <div class="batch-filter-dates-Excel">
            <label class="batch-filter-date-label-Excel">Від <input type="date" id="filter-date-from-Excel" class="batch-filter-date-input-Excel cell-input-Excel"></label>
            <label class="batch-filter-date-label-Excel">До <input type="date" id="filter-date-to-Excel" class="batch-filter-date-input-Excel cell-input-Excel"></label>
          </div>
        </div>
        <div id="batch-skeleton-loader" class="batch-skeleton-loader-Excel" style="display:none;">
          <div class="batch-skeleton-row-Excel">
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:10%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:15%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
          </div>
          <div class="batch-skeleton-row-Excel">
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:10%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:15%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
          </div>
          <div class="batch-skeleton-row-Excel">
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:10%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:15%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
          </div>
          <div class="batch-skeleton-row-Excel">
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:10%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:15%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
          </div>
          <div class="batch-skeleton-row-Excel">
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:10%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:15%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:5%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:6%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:7%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
            <div class="batch-skeleton-cell-Excel skeleton-pulse" style="width:8%;"></div>
          </div>
        </div>
        <p class="batch-instructions-Excel">
          Вставте дані з Excel (Ctrl+V) у форматі:<br>
          <strong>Дата прихід ┃ Магазин ┃ Каталог номер ┃ Деталь ┃ Кількість надходження ┃ Ціна ┃ Ціна клієнта ┃ Склад ┃ Рахунок № ┃ Акт № ┃ Одиниця виміру</strong><br>
        </p>
        <textarea id="batch-textarea-Excel" class="batch-textarea-Excel" placeholder="Вставте дані з Excel сюди (з табуляцією між колонками)..." autocomplete="off"></textarea>
        <div id="batch-table-container-Excel" class="batch-table-container-Excel hidden-all_other_bases">
          <table id="batch-table-Excel" class="batch-table-Excel">
            <thead>
              <tr>
                <th data-col="rowNum" style="width:2%;text-align:center;">№</th>
                <th data-col="date">Дата</th>
                <th data-col="shop">Магазин</th>
                <th data-col="catno">Каталог номер</th>
                <th data-col="detail">Деталь</th>
                <th data-col="qty">К-ть</th>
                <th data-col="price">Ціна</th>
                <th data-col="clientPrice">Клієнта</th>
                <th data-col="warehouse">Склад</th>
                <th data-col="invoice">Рах. №</th>
                <th data-col="actNo">Акт №</th>
                <th data-col="unit">О-ця</th>
                <th data-col="orderStatus">Статус</th>
                <th data-col="createdBy">Замовив</th>
                <th data-col="notes">Примітка</th>
                <th data-col="action">Дія</th>
                <th data-col="status">Г-ть</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="batch-buttons-Excel">
          <button id="batch-parse-btn-Excel" class="batch-btn-Excel parse-Excel">📋 Розпарсити</button>
          <button id="batch-add-row-btn-Excel" class="batch-btn-Excel add-row-Excel">➕ Додати рядок</button>
          <button id="batch-invoice-ocr-btn" type="button" class="batch-btn-Excel">📷 Накладна з фото / PDF</button>
          <button id="voice-input-btn-Excel" class="ai-chat-voice-btn voice-btn-Excel" type="button" title="Голосове введення">🎙️</button>
          <button id="batch-upload-btn-Excel" class="batch-btn-Excel upload-Excel hidden-all_other_bases">✅ Записати</button>
        </div>
      </div>
    </div>
  `;
  return modal;
}
// ===== Парсинг =====
function parseBatchData(text: string) {
  const lines = text
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  const data: any[] = [];
  lines.forEach((line, index) => {
    if (index === 0 && (line.includes("Дата") || line.includes("Магазин")))
      return;

    // Спробуємо розділити по табуляції (найбільш надійний метод з Excel)
    let parts = line.split("\t");

    // Якщо табуляція не працює (менше 6 полів), спробуємо розділити по пробілам
    if (parts.length < 6) {
      // Розділяємо по пробілам - це крайній випадок
      const tokens = line.split(/\s+/);

      if (tokens.length >= 8) {
        // Стратегія: беремо перші 3 токена як дату, магазин, каталог
        // Потім шукаємо останні числові поля
        // Все що посередині - це деталь

        // Останні 7 полів мають бути: Кількість, Ціна, Ціна клієнта, Склад, Рахунок, Акт, Одиниця
        const detailEndIdx = tokens.length - 7;
        parts = [
          tokens[0], // Дата
          tokens[1], // Магазин
          tokens[2], // Каталог номер
          tokens.slice(3, detailEndIdx).join(" "), // Деталь
          tokens[tokens.length - 7], // Кількість
          tokens[tokens.length - 6], // Ціна
          tokens[tokens.length - 5], // Ціна клієнта
          tokens[tokens.length - 4], // Склад
          tokens[tokens.length - 3], // Рахунок №
          tokens[tokens.length - 2], // Акт №
          tokens[tokens.length - 1], // Одиниця
        ];
      } else {
        parts = tokens;
      }
    }

    // Розірвемо пусті поля в кінці і доповнимо до 11 полів
    // Спочатку видалимо пусті поля з кінця
    while (parts.length > 0 && parts[parts.length - 1].trim() === "") {
      parts.pop();
    }

    // Потім доповнимо до 11 полів пустими строками
    while (parts.length < 11) {
      parts.push("");
    }

    // Trim each part, but keep empty strings
    parts = parts.map((part) => part.trim());
    // Take only first 11 parts
    parts = parts.slice(0, 11);

    // No longer filter out empties - we want all 11 fields, even empty
    if (parts.length < 11) {
      // console.warn("⚠️ Пропущено рядок (недостатньо даних):", line);
      return;
    }
    const row = {
      date: parts[0],
      shop: parts[1],
      catno: parts[2],
      detail: parts[3],
      qty: parseLocalizedNumber(parts[4]),
      price: parseLocalizedNumber(parts[5]),
      clientPrice: parseLocalizedNumber(parts[6]),
      clientPriceManual: !!parts[6]?.trim(),
      warehouse: parts[7], // Нове поле Склад
      invoice: parts[8],
      actNo: parts[9],
      unit: parts[10],
      status: "Готовий",
      unitValid: true,
      shopValid: true,
      detailValid: true,
      actValid: true,
      actClosed: false,
      warehouseValid: true, // Нова валідація для складу
      qtyValid: true, // Нова валідація для Кількості
      priceValid: true, // Нова валідація для Ціни
    };
    try {
      if (row.date.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
        // dd.mm.yyyy -> dd.mm.yy
        const parts4 = row.date.split(".");
        row.date = `${parts4[0]}.${parts4[1]}.${parts4[2].slice(-2)}`;
      } else if (row.date.match(/^\d{2}\.\d{2}\.\d{2}$/)) {
        // dd.mm.yy - OK
      } else if (row.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [yyyy, mm, dd] = row.date.split("-");
        row.date = `${dd}.${mm}.${yyyy.slice(-2)}`;
      } else {
        throw new Error("Невірний формат дати");
      }
    } catch {
      row.status = "Помилка формату дати";
    }
    // Перевірка одиниці виміру
    if (!VALID_UNITS.includes(row.unit)) {
      row.unitValid = false;
    }

    // Магазин: якщо порожній - невалідний, якщо заповнений - завжди валідний (створимо якщо немає)
    if (!row.shop || !row.shop.trim()) {
      row.shopValid = false;
    } else {
      // Перевіряємо чи є в списку (для підсвічування), але завжди валідний
      const existsInCache = shopExistsInCache(row.shop);
      row.shopValid = true; // завжди валідний, якщо заповнений
      // Зберігаємо інфо чи існує (для кольору)
      (row as any).shopExists = existsInCache;
    }

    // Деталь: якщо порожня - невалідна, якщо заповнена - завжди валідна (створимо якщо немає)
    if (!row.detail || !row.detail.trim()) {
      row.detailValid = false;
    } else {
      // Перевіряємо чи є в списку (для підсвічування), але завжди валідна
      const existsInCache = detailExistsInCache(row.detail);
      row.detailValid = true; // завжди валідна, якщо заповнена
      // Зберігаємо інфо чи існує (для кольору)
      (row as any).detailExists = existsInCache;
    }

    // Акт: порожній - валідний (необов'язкове поле), заповнений - перевіряємо
    if (row.actNo && row.actNo.trim()) {
      const trimmedActNo = row.actNo.trim();
      row.actValid = actsListCache.includes(trimmedActNo);
      if (row.actValid) {
        const actIdNum = parseInt(trimmedActNo, 10);
        if (actsDateOffMap.has(actIdNum)) {
          row.actClosed = actsDateOffMap.get(actIdNum) !== null;
        }
      }
    }

    // Кількість: обов'язкове поле, повинна бути > 0
    if (isNaN(row.qty) || row.qty <= 0) {
      row.qtyValid = false;
    } else {
      row.qtyValid = true;
    }

    // Ціна: обов'язкове поле, повинна бути > 0
    if (isNaN(row.price) || row.price <= 0) {
      row.priceValid = false;
    } else {
      row.priceValid = true;
    }

    // Склад: обов'язкове поле, перевіряємо чи є в списку активних складів
    if (!row.warehouse || !row.warehouse.trim()) {
      row.warehouseValid = false;
    } else {
      // Перевіряємо чи номер складу є в списку активних
      row.warehouseValid = warehouseListCache.includes(row.warehouse.trim());
    }

    // Фінальна перевірка: тільки обов'язкові поля та їх валідність
    // Обов'язкові: Дата, Магазин, Каталог номер, Деталь, Кількість, Ціна, Одиниця, Склад
    // Необов'язкові: Рахунок №, Ціна клієнта, Акт №
    if (
      !row.qtyValid ||
      !row.priceValid ||
      !row.date ||
      !row.catno ||
      !row.detail ||
      !row.unit ||
      !row.shop ||
      !row.unitValid ||
      !row.warehouseValid
    ) {
      row.status = "Помилка";
    }
    data.push(row);
  });
  return data;
}
// ===== ДИНАМІЧНИЙ РОЗРАХУНОК ШИРИНИ КОЛОНОК =====
function calculateDynamicWidths(data: any[]): Map<string, number> {
  const columns = [
    "date",
    "shop",
    "catno",
    "detail",
    "qty",
    "price",
    "clientPrice",
    "warehouse",
    "invoice",
    "actNo",
    "unit",
    "orderStatus",
    "createdBy",
    "notes",
    "action",
    "status",
  ];
  const headers = [
    "Дата",
    "Магазин",
    "Каталог номер",
    "Деталь",
    "К-ть",
    "Ціна",
    "Клієнта",
    "Склад",
    "Рах. №",
    "Акт №",
    "О-ця",
    "Статус",
    "Замовив",
    "Примітка",
    "Дія",
    "Г-ть",
  ];
  const widths = new Map<string, number>();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return widths;
  ctx.font = "11px Arial";

  // Мінімальні ширини для колонок (у відсотках від загальної ширини)
  const minWidths: Record<string, number> = {
    date: 5,
    shop: 6,
    catno: 6,
    detail: 12,
    qty: 4,
    price: 4,
    clientPrice: 5,
    warehouse: 3,
    invoice: 5,
    actNo: 4,
    unit: 4,
    orderStatus: 6,
    createdBy: 6,
    notes: 8,
    action: 8,
    status: 2,
  };

  // Розрахунок ідеальної ширини на основі контенту
  const contentWidths = new Map<string, number>();
  let totalContentWidth = 0;

  columns.forEach((col, i) => {
    let maxWidth = ctx.measureText(headers[i]).width + 20;
    data.forEach((row) => {
      const value = String(row[col] ?? "");
      const textWidth = ctx.measureText(value).width + 20;
      if (textWidth > maxWidth) maxWidth = textWidth;
    });
    contentWidths.set(col, maxWidth);
    totalContentWidth += maxWidth;
  });

  // Перетворюємо в відсотки (пропорційно контенту)
  columns.forEach((col) => {
    const contentW = contentWidths.get(col) || 50;
    let percent = (contentW / totalContentWidth) * 100;

    // Застосовуємо мінімальну ширину
    const minW = minWidths[col] || 3;
    percent = Math.max(percent, minW);

    widths.set(col, percent);
  });

  // Нормалізуємо до 100%
  let total = 0;
  widths.forEach((v) => (total += v));
  if (total !== 100) {
    const scale = 100 / total;
    columns.forEach((col) => {
      widths.set(col, Math.round((widths.get(col) || 0) * scale * 100) / 100);
    });
  }

  return widths;
}
function applyColumnWidths(widths: Map<string, number>) {
  const thead = document.querySelector("#batch-table-Excel thead tr");
  if (!thead) return;
  thead.querySelectorAll("th").forEach((th) => {
    const col = (th as HTMLElement).dataset.col;
    if (col && widths.has(col)) {
      const percent = widths.get(col)!;
      (th as HTMLElement).style.width = `${percent}%`;
    }
  });
}
// ===== Dropdown =====
let currentDropdownInput: HTMLElement | null = null;
let currentDropdownList: HTMLElement | null = null;
function closeDropdownList() {
  currentDropdownList?.remove();
  currentDropdownList = null;
  currentDropdownInput?.classList.remove("dropdown-open");
  currentDropdownInput = null;
}
function positionDropdown(input: HTMLElement, list: HTMLElement) {
  const rect = input.getBoundingClientRect();
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;

  // Оптимізація: розраховуємо ширину ТІЛЬКИ якщо вона ще не задана
  if (!list.style.width) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let maxContentWidth = rect.width;
    if (ctx) {
      ctx.font = "14px Arial";
      list.querySelectorAll("li").forEach((li) => {
        const text = (li as HTMLElement).textContent || "";
        const textWidth = ctx.measureText(text).width + 50;
        if (textWidth > maxContentWidth) maxContentWidth = textWidth;
      });
    }
    const finalWidth = Math.min(
      Math.max(maxContentWidth, rect.width, 200),
      500,
    );
    list.style.width = `${finalWidth}px`;
  }

  const firstItem = list.querySelector("li") as HTMLElement | null;
  const itemHeight = firstItem?.offsetHeight || 30;
  const totalItems = list.children.length;
  const gap = 4;
  const padding = 16;
  const availableAbove = rect.top + scrollY - gap;
  const availableBelow = window.innerHeight - rect.bottom - gap;
  const useAbove = availableAbove >= availableBelow;
  const availableSpace = useAbove ? availableAbove : availableBelow;
  const maxItemsFromSpace = Math.floor((availableSpace - padding) / itemHeight);
  const effectiveMaxVisible = Math.min(8, Math.max(3, maxItemsFromSpace));
  const visibleItems = Math.min(effectiveMaxVisible, totalItems);
  const listHeight = visibleItems * itemHeight + padding;

  list.style.maxHeight = `${listHeight}px`;

  list.style.top = `${
    useAbove
      ? scrollY + rect.top - listHeight - gap
      : scrollY + rect.bottom + gap
  }px`;
  list.style.left = `${scrollX + rect.left}px`;
}
function showDropdownList(input: HTMLElement, options: string[]) {
  closeDropdownList();
  if (!options?.length) return;
  const list = document.createElement("ul");
  list.className = "excel-dropdown-list";
  // показуємо всі варіанти, без обрізання
  options.forEach((option) => {
    const li = document.createElement("li");
    li.className = "excel-dropdown-item";
    li.textContent = input.getAttribute('data-field')==='actNo' ? actOptionLabels.get(option)||option : option;
    li.tabIndex = 0;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (input.id === batchCatalogSearchInputId) {
        (input as HTMLInputElement).value = option;
        closeDropdownList();
        clearTimeout(catalogSuggestionTimer); catalogSuggestionVersion++;
        applyBatchCatalogSearchNow();
        return;
      }

      const index = parseInt(input.getAttribute("data-index") || "0");
      const field = input.getAttribute("data-field") || "";
      (input as HTMLInputElement).value = option;
      parsedDataGlobal[index][field] = option;
      const td = input.closest("td");
      if (td) {
        td.classList.remove(
          "invalid-shop",
          "invalid-detail",
          "invalid-unit",
          "invalid-act",
          "invalid-warehouse",
          "closed-act",
        );
      }
      if (field === "unit") {
        parsedDataGlobal[index].unitValid = true;
      } else if (field === "shop") {
        parsedDataGlobal[index].shopValid = true;
        (parsedDataGlobal[index] as any).shopExists = true; // вибрано зі списку = існує
      } else if (field === "detail") {
        parsedDataGlobal[index].detailValid = true;
        (parsedDataGlobal[index] as any).detailExists = true; // вибрано зі списку = існує
      } else if (field === "actNo") {
        parsedDataGlobal[index].actValid = true;
        const actIdNum = parseInt(option, 10);
        parsedDataGlobal[index].actClosed =
          actsDateOffMap.has(actIdNum) && actsDateOffMap.get(actIdNum) !== null;
        if (parsedDataGlobal[index].actClosed) {
          if (td) td.classList.add("closed-act");
        }
      } else if (field === "warehouse") {
        parsedDataGlobal[index].warehouseValid = true;
      }

      recalculateAndApplyWidths();
      revalidateRow(index);

      // Додатково: якщо всі поля валідні, явно встановлюємо статус (дублюємо логіку з updateDropdownList)
      const row = parsedDataGlobal[index];
      if (row.status === "Помилка" || row.status === "Помилка") {
        // Перевіряємо чи всі обов'язкові поля заповнені
        const allFilled =
          row.date &&
          row.shop &&
          row.catno &&
          row.detail &&
          row.unit &&
          row.warehouse;
        const numbersValid = !isNaN(row.qty) && !isNaN(row.price);
        // Примітка: unitValid і warehouseValid перевіряються вище
        if (allFilled && numbersValid && row.unitValid && row.warehouseValid) {
          // Ще раз викликаємо revalidateRow, щоб вона точно схопила нові дані
          // (іноді дані можуть не встигнути оновитися перед першим викликом)
          revalidateRow(index);
        }
      }

      closeDropdownList();
      if (field === "catno") autofillDetailByCatalog(index);
    });
    list.appendChild(li);
  });
  document.body.appendChild(list);
  currentDropdownList = list;
  currentDropdownInput = input;
  input.classList.add("dropdown-open");
  positionDropdown(input, list);
}
// ===== ФУНКЦІЯ ПЕРЕРАХУНКУ ШИРИНИ =====
function getCatalogDetailNames(index: number): string[] {
  return partNumberNameMap.get(String(parsedDataGlobal[index]?.catno || "").trim()) || [];
}

function getDetailOptions(index: number): string[] {
  const names = getCatalogDetailNames(index);
  return names.length ? names : detailsListCache;
}

function autofillDetailByCatalog(index: number) {
  const names = getCatalogDetailNames(index);
  if (!names.length) return;
  const detailInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#batch-table-Excel [data-field="detail"][data-index="${index}"]`,
  );
  if (names.length === 1) {
    const name = names[0];
    const row = parsedDataGlobal[index];
    row.detail = name;
    row.detailValid = true;
    (row as any).detailExists = true;
    if (detailInput) {
      detailInput.value = name;
      detailInput.closest("td")?.classList.remove("invalid-detail");
      detailInput.style.height = "auto";
      detailInput.style.height = detailInput.scrollHeight + "px";
    }
    recalculateAndApplyWidths();
    revalidateRow(index);
  } else if (detailInput) {
    // Не обираємо довільну назву, якщо одному номеру відповідає кілька деталей.
    showDropdownList(detailInput, names);
  }
}

function recalculateAndApplyWidths() {
  const widths = calculateDynamicWidths(parsedDataGlobal);
  applyColumnWidths(widths);
  // З table-layout: fixed ширина автоматично застосовується з th до td
}
// ===== Рендеринг таблиці =====
// Отримати світлий фоновий колір для комірки td статусу
function getOrderStatusCellBackground(status: string): string {
  switch (status) {
    case "Прибула":
      return "#dcfce7"; // світло-зелений
    case "Замовлено":
      return "#dbeafe"; // світло-синій
    case "Замовити":
    default:
      return "#fee2e2"; // світло-червоний
  }
}

// Отримати колір тексту для статусу
function getOrderStatusTextColor(status: string): string {
  switch (status) {
    case "Прибула":
      return "#2D7244"; // зелений
    case "Замовлено":
      return "#2563eb"; // синій
    case "Замовити":
    default:
      return "#dc2626"; // червоний
  }
}

function parseLocalizedNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  const normalized = String(value).trim().replace(",", ".");
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasStoredClientPrice(value: any): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Перерахунок ціни клієнта на основі ціни та відсотка складу
function recalculateClientPrice(index: number, force = false): void {
  const row = parsedDataGlobal[index];
  if (!row) return;
  if (!force && row.clientPriceManual) return;

  const price = parseLocalizedNumber(row.price);
  const warehouseId = String(row.warehouse || "").trim();
  const procent = warehouseProcentMap.get(warehouseId) ?? 0;

  // Формула: clientPrice = price + (price * procent / 100)
  const clientPrice = price + (price * procent) / 100;
  row.clientPrice = Math.round(clientPrice * 100) / 100; // Округлення до 2 знаків
  row.clientPriceManual = false;

  // Оновити input в DOM — якщо 0, показуємо порожнє (placeholder покаже 0)
  const clientPriceInput = document.querySelector(
    `#batch-table-Excel tbody tr:nth-child(${index + 1}) [data-field="clientPrice"]`,
  ) as HTMLInputElement | null;
  if (clientPriceInput) {
    clientPriceInput.value =
      row.clientPrice === 0 ? "" : String(row.clientPrice);
  }
}

function escapeBatchValue(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function createInput(
  type: string,
  value: string,
  field: string,
  index: number,
  className: string = "",
): string {
  // Для числових полів qty/price/clientPrice: якщо значення = 0, показуємо порожнє + placeholder
  const isZeroPlaceholder =
    field === "qty" || field === "price" || field === "clientPrice";
  // Для invoice: якщо порожнє - показуємо placeholder "0"
  const isInvoicePlaceholder = field === "invoice";
  const numVal = parseLocalizedNumber(value);
  const displayValue =
    isZeroPlaceholder && (numVal === 0 || value === "" || value === "0")
      ? ""
      : isInvoicePlaceholder && (!value || value.trim() === "")
        ? ""
        : value;
  const placeholderAttr =
    isZeroPlaceholder || isInvoicePlaceholder ? 'placeholder="0"' : "";
  return `<input
    type="${type}"
    class="cell-input-Excel ${className}"
    value="${escapeBatchValue(displayValue)}"
    data-field="${field}"
    data-index="${index}"
    ${type === "number" ? 'step="0.01"' : ""}
    ${field === "unit" ? "readonly" : ""}
    ${placeholderAttr}
    autocomplete="off"
  >`;
}
function renderBatchTable(data: any[]) {
  const tbody = document.querySelector(
    "#batch-table-Excel tbody",
  ) as HTMLTableSectionElement;
  if (!tbody) return;
  const widths = calculateDynamicWidths(data);
  applyColumnWidths(widths);
  tbody.innerHTML = "";
  data.forEach((row, index) => {
    const tr = document.createElement("tr");
    // Магазин: жовтий якщо не існує в базі (буде створено)
    const shopTdClass =
      row.shop && !(row as any).shopExists ? "invalid-shop" : "";
    // Деталь: жовтий якщо не існує в базі (буде створено)
    const detailTdClass =
      row.detail && !(row as any).detailExists ? "invalid-detail" : "";
    const unitTdClass = !row.unitValid ? "invalid-unit" : "";
    const actTdClass =
      row.actNo && !row.actValid
        ? "invalid-act"
        : row.actClosed
          ? "closed-act"
          : "";
    // Склад: червоний якщо невалідний
    const warehouseTdClass = !row.warehouseValid ? "invalid-warehouse" : "";
    // Кількість: червоний якщо невалідна
    const qtyTdClass = !row.qtyValid ? "invalid-qty" : "";
    // Ціна: червоний якщо невалідна
    const priceTdClass = !row.priceValid ? "invalid-price" : "";
    // Рах. №: червоний якщо порожній
    const invoiceTdClass =
      !row.invoice || String(row.invoice).trim() === ""
        ? "invalid-invoice"
        : "";
    // Конвертуємо дату в ISO формат для input type="date"
    const isoDateForInput = toIsoDate(row.date) || row.date;
    tr.innerHTML = `
      <td class="row-num-cell-Excel" style="text-align:center;font-weight:bold;color:#888;user-select:none;">
        <span class="row-num-Excel">${index + 1}</span>
      </td>
      <td>
        ${createInput("date", isoDateForInput, "date", index)}
      </td>
      <td class="${shopTdClass}">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel shop-input-Excel"
          value="${escapeBatchValue(row.shop)}"
          data-field="shop"
          data-index="${index}"
          autocomplete="off"
        >
      </td>
      <td>
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel catno-input-Excel"
          value="${escapeBatchValue(row.catno)}"
          data-field="catno"
          data-index="${index}"
          autocomplete="off"
        >
      </td>
      <td class="${detailTdClass}">
        <textarea
          class="cell-input-Excel cell-input-combo-Excel detail-input-Excel"
          data-field="detail"
          data-index="${index}"
          autocomplete="off"
          rows="1"
          style="overflow:hidden; resize:none; min-height:30px; width:100%; box-sizing:border-box; white-space: pre-wrap; line-height: 1.3; padding-top: 6px;"
        >${escapeBatchValue(row.detail)}</textarea>
      </td>
      <td class="${qtyTdClass}">
        ${createInput("number", row.qty, "qty", index)}
      </td>
      <td class="${priceTdClass}">
        ${createInput("number", row.price, "price", index)}
      </td>
      <td>
        ${createInput("number", row.clientPrice, "clientPrice", index)}
      </td>
      <td class="${warehouseTdClass}">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel warehouse-input-Excel"
          value="${escapeBatchValue(row.warehouse)}"
          data-field="warehouse"
          data-index="${index}"
          autocomplete="off"
          style="text-align: center;"
        >
      </td>
      <td class="${invoiceTdClass}">
        ${createInput("text", row.invoice, "invoice", index, "invoice-input-Excel")}
      </td>
      <td class="${actTdClass}">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel act-input-Excel"
          value="${escapeBatchValue(row.actNo)}"
          data-field="actNo"
          data-index="${index}"
          autocomplete="off"
        >
      </td>
      <td class="${unitTdClass}">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel unit-input-Excel"
          value="${escapeBatchValue(row.unit)}"
          data-field="unit"
          data-index="${index}"
          readonly
          autocomplete="off"
        >
      </td>
      <td class="orderStatus-cell-Excel" style="background-color: ${getOrderStatusCellBackground(row.orderStatus || "Замовити")}">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel orderStatus-input-Excel"
          value="${escapeBatchValue(row.orderStatus || "Замовити")}"
          data-field="orderStatus"
          data-index="${index}"
          readonly
          autocomplete="off"
          style="background: transparent; color: ${getOrderStatusTextColor(row.orderStatus || "Замовити")}; font-weight: bold; cursor: pointer;"
        >
      </td>
      <td>
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel createdBy-input-Excel"
          value="${escapeBatchValue(row.createdBy)}"
          data-field="createdBy"
          data-index="${index}"
          autocomplete="off"
        >
      </td>
      <td>
        <input
          type="text"
          class="cell-input-Excel"
          value="${escapeBatchValue(row.notes)}"
          data-field="notes"
          data-index="${index}"
          autocomplete="off"
          placeholder="Примітка..."
        >
      </td>
      <td class="action-cell-Excel">
        <input
          type="text"
          class="cell-input-Excel cell-input-combo-Excel action-input-Excel"
          value="${escapeBatchValue(row.action || "Записати")}"
          data-field="action"
          data-index="${index}"
          readonly
          autocomplete="off"
          style="color: ${row.action === "Видалити" ? "#ef4444" : "#2D7244"}; font-weight: bold; cursor: pointer; background: transparent;"
        >
      </td>
      <td class="status-cell-Excel ${
        row.status === "Готовий"
          ? "ready-Excel"
          : row.status?.includes("Помилка")
            ? "error-Excel"
            : row.status?.includes("Успішно")
              ? "success-Excel"
              : "error-Excel"
      }">
        <span class="status-text-Excel" style="display:none;">${escapeBatchValue(row.status || "Помилка")}</span>
        <button class="delete-row-btn-Excel" data-index="${index}" title="${escapeBatchValue(row.status || "Помилка")}">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  attachInputHandlers(tbody);
  // Ініціалізуємо кастомний DatePicker для всіх полів дати
  initCustomDatePicker(tbody);
  // Навішуємо обробники сортування на шапку
  attachSortHandlers();
}

// ===== Навішування обробників сортування на th =====
function attachSortHandlers() {
  const thead = document.querySelector("#batch-table-Excel thead tr");
  if (!thead) return;
  thead.querySelectorAll("th").forEach((th) => {
    const col = (th as HTMLElement).dataset.col;
    if (!col || col === "status" || col === "rowNum") return; // Г-ть і № не сортуємо
    // Видаляємо попередні обробники (якщо є)
    const newTh = th.cloneNode(true) as HTMLElement;
    th.parentNode?.replaceChild(newTh, th);
    newTh.style.cursor = "pointer";
    newTh.style.userSelect = "none";
    newTh.addEventListener("click", () => {
      sortTableByColumn(col);
    });
  });
  // Оновити індикатори після навішування
  updateSortIndicators();
}
// ===== Валідація рядка при редагуванні =====
function revalidateRow(index: number) {
  const row = parsedDataGlobal[index];
  if (!row) return;

  // Якщо статус був "Успішно" або "Збережено", не чіпаємо
  if (
    row.status === "✅ Успішно" ||
    row.status === "⚠️ Збережено (акт не оновлено)"
  ) {
    return;
  }

  // Перевірка на заповненість обов'язкових полів
  // Обов'язкові: Дата, Магазин, Каталог номер, Деталь, Кількість, Ціна, Одиниця, Склад, Рах. №
  // Необов'язкові: Ціна клієнта, Акт №

  const isFilled =
    row.date &&
    String(row.date).trim() &&
    row.shop &&
    String(row.shop).trim() &&
    row.catno &&
    String(row.catno).trim() &&
    row.detail &&
    String(row.detail).trim() &&
    row.unit &&
    String(row.unit).trim() &&
    row.warehouse &&
    String(row.warehouse).trim() &&
    row.invoice &&
    String(row.invoice).trim();

  // Перевірка чисел (ціна клієнта необов'язкова)
  const areNumbersValid = !isNaN(row.qty) && !isNaN(row.price);

  // Перевірка валідності
  // shopValid і detailValid тепер завжди true якщо заповнені
  // Перевіряємо unitValid і warehouseValid
  // Акт взагалі не перевіряємо - він необов'язковий

  const isValid =
    isFilled &&
    areNumbersValid &&
    row.unitValid &&
    row.warehouseValid &&
    row.qtyValid &&
    row.priceValid;

  const statusCell = document.querySelector(
    `#batch-table-Excel tbody tr:nth-child(${index + 1}) .status-cell-Excel`,
  );
  if (!statusCell) return;
  const statusTextEl = statusCell.querySelector(".status-text-Excel");

  if (isValid) {
    row.status = "Готовий";
    statusCell.className = "status-cell-Excel ready-Excel";
    if (statusTextEl) statusTextEl.textContent = "Готовий";
  } else {
    // Якщо не валідно - ставимо помилку
    row.status = "Помилка";
    statusCell.className = "status-cell-Excel error-Excel";
    if (statusTextEl) statusTextEl.textContent = "Помилка";
  }
}

function attachInputHandlers(tbody: HTMLTableSectionElement) {
  tbody.querySelectorAll('input[data-field="date"]').forEach((input) => {
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      parsedDataGlobal[index]["date"] = target.value;
      recalculateAndApplyWidths();
      revalidateRow(index);
    });
    input.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      parsedDataGlobal[index]["date"] = target.value;
      recalculateAndApplyWidths();
      revalidateRow(index);
    });
  });
  tbody
    .querySelectorAll(
      ".cell-input-Excel:not(.cell-input-combo-Excel):not([data-field='date'])",
    )
    .forEach((input) => {
      input.addEventListener("input", (e) => {
        const target = e.target as HTMLInputElement;
        const index = parseInt(target.dataset.index || "0");
        const field = target.dataset.field || "";
        if (field === "qty" || field === "price" || field === "clientPrice") {
          parsedDataGlobal[index][field] = parseLocalizedNumber(target.value);
          if (field === "clientPrice") {
            parsedDataGlobal[index].clientPriceManual =
              target.value.trim() !== "";
          }
        } else {
          parsedDataGlobal[index][field] = target.value;
        }

        // Видалити клас invalid при редагуванні для qty та price та invoice
        const td = target.closest("td");
        if (td) {
          if (field === "qty") {
            td.classList.remove("invalid-qty");
          } else if (field === "price") {
            td.classList.remove("invalid-price");
          } else if (field === "invoice") {
            td.classList.remove("invalid-invoice");
          }
        }

        // Авторозрахунок ціни клієнта при зміні ціни
        if (field === "price") {
          recalculateClientPrice(index);
        }

        recalculateAndApplyWidths();
        revalidateRow(index);
      });

      // === Плейсхолдер для нулів: при фокусі очищаємо "0", при blur повертаємо ===
      const fieldName = (input as HTMLInputElement).dataset.field || "";
      if (
        fieldName === "qty" ||
        fieldName === "price" ||
        fieldName === "clientPrice"
      ) {
        input.addEventListener("focus", (e) => {
          const target = e.target as HTMLInputElement;
          // Якщо значення 0 або порожнє — очистити для зручності вводу
          if (target.value === "0" || target.value === "") {
            target.value = "";
          }
        });
        input.addEventListener("blur", (e) => {
          const target = e.target as HTMLInputElement;
          const index = parseInt(target.dataset.index || "0");
          const field = target.dataset.field || "";
          const val = parseLocalizedNumber(target.value);
          if (isNaN(val) || val === 0) {
            // Зберігаємо 0 в дані, але показуємо порожнє (placeholder покаже 0)
            parsedDataGlobal[index][field] = 0;
            target.value = "";
            if (field === "clientPrice") {
              parsedDataGlobal[index].clientPriceManual = false;
              recalculateClientPrice(index, true);
            }
          }
        });
      }
    });

  // Рах. № (invoice) — обов'язкове поле
  tbody.querySelectorAll(".invoice-input-Excel").forEach((input) => {
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value.trim();
      const td = target.closest("td");

      if (!value) {
        if (td) td.classList.add("invalid-invoice");
      } else {
        if (td) td.classList.remove("invalid-invoice");
      }
      revalidateRow(index);
    });
  });

  // Акт № з live-фільтром
  // показуємо список відкритих актів при кліку
  tbody.querySelectorAll(".act-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, actsListCache); // <-- тут наш кеш
    });

    // live-фільтр по відкритих актах
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["actNo"] = value;

      const td = target.closest("td");
      if (td) td.classList.remove("invalid-act", "closed-act");

      const filter = value.toLowerCase();
      const filteredOptions = filter
        ? actsListCache.filter((opt) => opt.toLowerCase().includes(filter))
        : actsListCache;

      if (currentDropdownInput === target && currentDropdownList) {
        updateDropdownList(filteredOptions, target, index, "actNo");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }

      recalculateAndApplyWidths();
      revalidateRow(index);
    });

    // валідація: або порожньо, або існує серед ВІДКРИТИХ
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value.trim();
      const td = target.closest("td");

      parsedDataGlobal[index].actValid =
        !value || actsListCache.includes(value);
      parsedDataGlobal[index].actClosed = false; // бо в кеші тільки відкриті

      if (!parsedDataGlobal[index].actValid && value) {
        td?.classList.add("invalid-act");
      } else {
        td?.classList.remove("invalid-act", "closed-act");
      }
      revalidateRow(index);
    });
  });

  // Одиниці
  tbody.querySelectorAll(".unit-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, VALID_UNITS);
    });
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      const td = target.closest("td");
      if (!VALID_UNITS.includes(value)) {
        if (td) {
          td.classList.add("invalid-unit");
        }
        parsedDataGlobal[index].unitValid = false;
      } else {
        if (td) {
          td.classList.remove("invalid-unit");
        }
        parsedDataGlobal[index].unitValid = true;
      }
      revalidateRow(index);
    });
  });
  // Магазин з live-фільтром
  tbody.querySelectorAll(".shop-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, shopsListCache);
    });
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["shop"] = value;
      const td = target.closest("td");
      if (td) {
        td.classList.remove("invalid-shop");
      }
      const filter = value.toLowerCase();
      const filteredOptions = filter
        ? shopsListCache.filter((opt) => opt.toLowerCase().includes(filter))
        : shopsListCache;
      if (currentDropdownInput === target && currentDropdownList) {
        updateDropdownList(filteredOptions, target, index, "shop");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }
      recalculateAndApplyWidths();
      revalidateRow(index);
    });
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value.trim();
      const td = target.closest("td");

      if (!value) {
        // Порожній - невалідний
        parsedDataGlobal[index].shopValid = false;
        (parsedDataGlobal[index] as any).shopExists = false;
      } else {
        // Заповнений - завжди валідний, але перевіряємо чи існує
        const existsInCache = shopExistsInCache(value);
        parsedDataGlobal[index].shopValid = true;
        (parsedDataGlobal[index] as any).shopExists = existsInCache;

        // Колір: жовтий якщо не існує
        if (!existsInCache) {
          if (td) td.classList.add("invalid-shop");
        } else {
          if (td) td.classList.remove("invalid-shop");
        }
      }
      revalidateRow(index);
    });
  });
  // Деталь з live-фільтром
  tbody.querySelectorAll(".detail-input-Excel").forEach((el) => {
    const input = el as HTMLInputElement | HTMLTextAreaElement;

    // Авто-розширення висоти
    const autoResize = () => {
      input.style.height = "auto";
      input.style.height = input.scrollHeight + "px";
    };
    // Ініціалізація висоти
    setTimeout(autoResize, 0);

    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, getDetailOptions(Number(input.dataset.index || "0")));
    });
    input.addEventListener("input", (e) => {
      autoResize(); // Авто-ресайз при введенні
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["detail"] = value;
      const td = target.closest("td");
      if (td) {
        td.classList.remove("invalid-detail");
      }
      const filter = value.toLowerCase();
      const detailOptions = getDetailOptions(index);
      const filteredOptions = filter
        ? detailOptions.filter((opt) => opt.toLowerCase().includes(filter))
        : detailOptions;

      // Якщо dropdown ще не відкритий - відкриваємо з фільтрованими опціями
      if (!currentDropdownList || currentDropdownInput !== target) {
        if (filteredOptions.length > 0) {
          showDropdownList(target, filteredOptions);
        }
      } else {
        // Якщо вже відкритий - оновлюємо
        updateDropdownList(filteredOptions, target, index, "detail");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }
      recalculateAndApplyWidths();
      revalidateRow(index);
    });
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value.trim();
      const td = target.closest("td");

      if (!value) {
        // Порожня - невалідна
        parsedDataGlobal[index].detailValid = false;
        (parsedDataGlobal[index] as any).detailExists = false;
      } else {
        // Заповнена - завжди валідна, але перевіряємо чи існує
        const existsInCache = detailExistsInCache(value);
        parsedDataGlobal[index].detailValid = true;
        (parsedDataGlobal[index] as any).detailExists = existsInCache;

        // Колір: жовтий якщо не існує
        if (!existsInCache) {
          if (td) td.classList.add("invalid-detail");
        } else {
          if (td) td.classList.remove("invalid-detail");
        }
      }
      revalidateRow(index);
    });
  });

  // === Каталог номер (catno) з live-фільтром по part_number з бази sclad ===
  tbody.querySelectorAll(".catno-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      if (partNumbersCache.length > 0) {
        showDropdownList(e.target as HTMLElement, partNumbersCache);
      }
    });
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["catno"] = value;

      const filter = value.toLowerCase();
      const filteredOptions = filter
        ? partNumbersCache.filter((opt) => catalogMatchesSearch(opt, value))
        : partNumbersCache;

      // Якщо dropdown ще не відкритий — відкриваємо з фільтрованими опціями
      if (!currentDropdownList || currentDropdownInput !== target) {
        if (filteredOptions.length > 0) {
          showDropdownList(target, filteredOptions);
        }
      } else {
        // Якщо вже відкритий — оновлюємо
        updateDropdownList(filteredOptions, target, index, "catno");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }
      recalculateAndApplyWidths();
      revalidateRow(index);
      autofillDetailByCatalog(index);
    });
  });

  // Склад з live-фільтром
  tbody.querySelectorAll(".warehouse-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, warehouseListCache);
    });
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["warehouse"] = value;
      const td = target.closest("td");
      if (td) {
        td.classList.remove("invalid-warehouse");
      }
      const filter = value.toLowerCase();
      const filteredOptions = filter
        ? warehouseListCache.filter((opt) => opt.toLowerCase().includes(filter))
        : warehouseListCache;
      if (currentDropdownInput === target && currentDropdownList) {
        updateDropdownList(filteredOptions, target, index, "warehouse");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }
      recalculateAndApplyWidths();
      revalidateRow(index);
    });
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value.trim();
      const td = target.closest("td");

      if (!value) {
        // Порожній - невалідний
        parsedDataGlobal[index].warehouseValid = false;
        if (td) td.classList.add("invalid-warehouse");
      } else {
        // Перевіряємо чи є в списку активних складів
        const existsInCache = warehouseListCache.includes(value);
        parsedDataGlobal[index].warehouseValid = existsInCache;

        // Колір: червоний якщо не існує
        if (!existsInCache) {
          if (td) td.classList.add("invalid-warehouse");
        } else {
          if (td) td.classList.remove("invalid-warehouse");
        }
      }

      // Перерахунок ціни клієнта при зміні складу
      recalculateClientPrice(index);

      revalidateRow(index);
    });
  });

  // Кількість (qty) з валідацією > 0
  tbody.querySelectorAll('[data-field="qty"]').forEach((input) => {
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = parseLocalizedNumber(target.value);
      const td = target.closest("td");

      parsedDataGlobal[index].qtyValid = value > 0;

      if (value <= 0) {
        if (td) td.classList.add("invalid-qty");
      } else {
        if (td) td.classList.remove("invalid-qty");
      }
      revalidateRow(index);
    });
  });

  // Ціна (price) з валідацією > 0
  tbody.querySelectorAll('[data-field="price"]').forEach((input) => {
    input.addEventListener("blur", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = parseLocalizedNumber(target.value);
      const td = target.closest("td");

      parsedDataGlobal[index].priceValid = value > 0;

      if (value <= 0) {
        if (td) td.classList.add("invalid-price");
      } else {
        if (td) td.classList.remove("invalid-price");
      }
      revalidateRow(index);
    });
  });

  // Статус замовлення (orderStatus) з випадаючим списком
  tbody.querySelectorAll(".orderStatus-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      showOrderStatusDropdown(target, index);
    });
  });

  // Хто створив (createdBy) з випадаючим списком користувачів
  tbody.querySelectorAll(".createdBy-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      showDropdownList(e.target as HTMLElement, usersListCache);
    });
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      const value = target.value;
      parsedDataGlobal[index]["createdBy"] = value;

      const filter = value.toLowerCase();
      const filteredOptions = filter
        ? usersListCache.filter((opt) => opt.toLowerCase().includes(filter))
        : usersListCache;
      if (currentDropdownInput === target && currentDropdownList) {
        updateDropdownList(filteredOptions, target, index, "createdBy");
        if (filteredOptions.length)
          positionDropdown(target, currentDropdownList);
        else closeDropdownList();
      }
      recalculateAndApplyWidths();
    });
  });

  // Дія (action) з випадаючим списком
  tbody.querySelectorAll(".action-input-Excel").forEach((input) => {
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      showActionDropdown(target, index);
    });
  });

  // Примітка (notes)
  tbody.querySelectorAll('[data-field="notes"]').forEach((input) => {
    input.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      const index = parseInt(target.dataset.index || "0");
      parsedDataGlobal[index]["notes"] = target.value;
      recalculateAndApplyWidths();
    });
  });

  wireBatchRemoteSuggestions(tbody);

  // Видалення рядка
  tbody.querySelectorAll(".delete-row-btn-Excel").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt(
        (e.target as HTMLButtonElement).dataset.index || "0",
      );
      parsedDataGlobal.splice(index, 1);
      renderBatchTable(parsedDataGlobal);
      showNotification(`Рядок ${index + 1} видалено`, "success", 2000);
      if (parsedDataGlobal.length === 0) {
        resetModalState();
      }
    });
  });
}

function wireBatchRemoteSuggestions(container: HTMLElement): void {
  container.querySelectorAll<HTMLInputElement>('input[data-field="shop"],input[data-field="detail"],input[data-field="catno"],input[data-field="actNo"]').forEach(input => {
    const field=input.dataset.field!;
    const kind: BatchLookupKind = field==='shop'?'shops':field==='detail'?'details':field==='catno'?'catalogs':'acts';
    let version=0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show=async(offset=0,previous:string[]=[])=>{
      clearTimeout(timer);
      const request=++version, query=input.value, session=batchSessionVersion;
      try {
        const page=await readBatchLookup(kind,query,offset);
        if(request!==version || session!==batchSessionVersion || !input.isConnected || input.value!==query || document.activeElement!==input) return;
        const values=[...new Set([...previous,...page.items.map(row=>row.value)])];
        if(kind==='acts') for(const row of page.items) { if(row.label) actOptionLabels.set(row.value,row.label); if(!actsListCache.includes(row.value)) actsListCache.push(row.value); actsDateOffMap.set(Number(row.value),null); }
        if(kind==='shops') { shopsListCache=[...new Set([...shopsListCache,...values])]; shopsListCacheNormalized=shopsListCache.map(normalizeNameForCompare); }
        if(kind==='details') { detailsListCache=[...new Set([...detailsListCache,...values])]; detailsListCacheNormalized=detailsListCache.map(normalizeNameForCompare); }
        if(kind==='catalogs') for(const row of page.items) if(row.name) partNumberNameMap.set(row.value,[...new Set([...(partNumberNameMap.get(row.value)||[]),row.name])]);
        showDropdownList(input,values);
        if(page.has_more && currentDropdownList) {
          const more=document.createElement('button');more.type='button';more.textContent='Ще…';
          more.onmousedown=event=>event.preventDefault();
          more.onclick=event=>{event.stopPropagation();void show(offset+20,values);};currentDropdownList.append(more);
        }
      } catch { if(request===version && input.isConnected) showNotification('Не вдалося завантажити підказки складу. Повторіть натискання поля.','error',2500); }
    };
    input.addEventListener('focus',()=>void show());
    input.addEventListener('click',()=>void show());
    input.addEventListener('input',()=>{version++;clearTimeout(timer);timer=setTimeout(()=>void show(),300);});
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){version++;clearTimeout(timer);closeDropdownList();}});
    input.addEventListener('blur',()=>{version++;clearTimeout(timer);});
  });
}

async function hydrateEnteredReferences(rows: Array<{shop?:string;detail?:string}>): Promise<void> {
  const items=rows.flatMap(row=>[{kind:'shops' as const,name:row.shop||''},{kind:'details' as const,name:row.detail||''}]);
  const found=await readBatchReferenceValidity(items);
  for(const row of found) {
    if(row.kind==='shops') {shopsListCache=shopsListCache.filter(name=>normalizeNameForCompare(name)!==normalizeNameForCompare(row.name));if(row.id!==null)shopsListCache.push(row.name);}
    else {detailsListCache=detailsListCache.filter(name=>normalizeNameForCompare(name)!==normalizeNameForCompare(row.name));if(row.id!==null)detailsListCache.push(row.name);}
  }
  shopsListCacheNormalized=shopsListCache.map(normalizeNameForCompare);detailsListCacheNormalized=detailsListCache.map(normalizeNameForCompare);
}

/** Validate only entered act IDs, including acts outside the suggestion page. */
async function refreshEnteredActValidity(rows: any[], force=false): Promise<void> {
  const values=[...new Set(rows.map(row=>String(row.actNo||'').trim()).filter(Boolean))];
  const records=await readBatchActValidity(values,force);
  for(const value of values) {actsListCache=actsListCache.filter(id=>id!==value);actsDateOffMap.delete(Number(value));}
  for(const row of records) {actsDateOffMap.set(Number(row.act_id),row.date_off);if(row.date_off===null) actsListCache.push(String(row.act_id));}
}

function updateDropdownList(
  options: string[],
  target: HTMLInputElement,
  index: number,
  field: string,
) {
  if (!currentDropdownList) return;
  currentDropdownList.innerHTML = "";
  // теж без обрізання
  options.forEach((option) => {
    const li = document.createElement("li");
    li.className = "excel-dropdown-item";
    li.textContent = field==='actNo' ? actOptionLabels.get(option)||option : option;
    li.tabIndex = 0;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      target.value = option;
      parsedDataGlobal[index][field] = option;
      const td = target.closest("td");
      if (td) {
        td.classList.remove(
          "invalid-shop",
          "invalid-detail",
          "invalid-unit",
          "invalid-act",
          "invalid-warehouse",
          "closed-act",
        );
      }
      if (field === "unit") {
        parsedDataGlobal[index].unitValid = true;
      } else if (field === "shop") {
        parsedDataGlobal[index].shop = option; // явно оновлюємо
        parsedDataGlobal[index].shopValid = true;
        (parsedDataGlobal[index] as any).shopExists = true; // вибрано зі списку = існує
      } else if (field === "detail") {
        parsedDataGlobal[index].detail = option; // явно оновлюємо
        parsedDataGlobal[index].detailValid = true;
        (parsedDataGlobal[index] as any).detailExists = true; // вибрано зі списку = існує
      } else if (field === "actNo") {
        parsedDataGlobal[index].actNo = option; // явно оновлюємо
        parsedDataGlobal[index].actValid = true;
        const actIdNum = parseInt(option, 10);
        parsedDataGlobal[index].actClosed =
          actsDateOffMap.has(actIdNum) && actsDateOffMap.get(actIdNum) !== null;
        if (parsedDataGlobal[index].actClosed) {
          if (td) td.classList.add("closed-act");
        }
      } else if (field === "warehouse") {
        parsedDataGlobal[index].warehouse = option; // явно оновлюємо
        parsedDataGlobal[index].warehouseValid = true;
        // Перерахунок ціни клієнта при виборі складу
        recalculateClientPrice(index);
      }

      // Примусово оновлюємо статус
      recalculateAndApplyWidths();
      revalidateRow(index);

      // Додатково: якщо всі поля валідні, явно встановлюємо статус
      const row = parsedDataGlobal[index];
      if (row.status === "Помилка" || row.status === "Помилка") {
        // Перевіряємо чи всі обов'язкові поля заповнені
        const allFilled =
          row.date &&
          row.shop &&
          row.catno &&
          row.detail &&
          row.unit &&
          row.warehouse;
        const numbersValid = !isNaN(row.qty) && !isNaN(row.price);
        if (allFilled && numbersValid && row.unitValid && row.warehouseValid) {
          row.status = "Готовий";
          const statusCell = document.querySelector(
            `#batch-table-Excel tbody tr:nth-child(${index + 1}) .status-cell-Excel`,
          );
          if (statusCell) {
            statusCell.className = "status-cell-Excel ready-Excel";
            const statusText = statusCell.querySelector(".status-text-Excel");
            if (statusText) statusText.textContent = "Готовий";
          }
        }
      }

      closeDropdownList();
      if (field === "catno") autofillDetailByCatalog(index);
    });
    currentDropdownList!.appendChild(li);
  });
}
// Показати випадаючий список для статусу замовлення
function showOrderStatusDropdown(input: HTMLInputElement, index: number) {
  closeDropdownList();
  const list = document.createElement("ul");
  list.className = "excel-dropdown-list";

  ORDER_STATUS_OPTIONS.forEach((opt) => {
    const li = document.createElement("li");
    li.className = "excel-dropdown-item";
    li.textContent = opt.label;
    li.style.color = opt.color;
    li.style.fontWeight = "bold";
    li.tabIndex = 0;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = opt.value;
      parsedDataGlobal[index]["orderStatus"] = opt.value;

      // Оновлюємо фоновий колір комірки td
      const td = input.closest("td");
      if (td) {
        td.style.backgroundColor = getOrderStatusCellBackground(opt.value);
      }

      // Оновлюємо колір тексту
      input.style.color = getOrderStatusTextColor(opt.value);

      closeDropdownList();
    });
    list.appendChild(li);
  });

  currentDropdownInput = input;
  currentDropdownList = list;
  input.classList.add("dropdown-open");
  document.body.appendChild(list);
  positionDropdown(input, list);
}

// Показати випадаючий список для дії
function showActionDropdown(input: HTMLInputElement, index: number) {
  closeDropdownList();
  const list = document.createElement("ul");
  list.className = "excel-dropdown-list";

  ACTION_OPTIONS.forEach((opt) => {
    const li = document.createElement("li");
    li.className = "excel-dropdown-item";
    li.textContent = opt.label;
    li.style.color = opt.color;
    li.style.fontWeight = "bold";
    li.tabIndex = 0;
    li.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.value = opt.value;
      parsedDataGlobal[index]["action"] = opt.value;

      // Оновлюємо колір тексту
      input.style.color = opt.color;

      closeDropdownList();
    });
    list.appendChild(li);
  });

  currentDropdownInput = input;
  currentDropdownList = list;
  input.classList.add("dropdown-open");
  document.body.appendChild(list);
  positionDropdown(input, list);
}

// Створення порожнього рядка даних з дефолтними значеннями
function createEmptyRow(): any {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`; // ISO формат для input type="date"

  const row = {
    date: todayStr,
    shop: "",
    catno: "",
    detail: "",
    qty: 0,
    price: 0,
    clientPrice: 0,
    clientPriceManual: false,
    warehouse: warehouseListCache.length > 0 ? warehouseListCache[0] : "",
    invoice: "",
    actNo: "",
    unit: "штук",
    orderStatus: "Замовити",
    createdBy: currentUserName || "",
    notes: "",
    action: "Записати",
    status: "Помилка",
    shopValid: false,
    detailValid: false,
    unitValid: true,
    actValid: true,
    actClosed: false,
    warehouseValid: warehouseListCache.length > 0,
    qtyValid: false,
    priceValid: false,
    shopExists: false,
    detailExists: false,
  };
  emptyRowSnapshots.set(row, { ...row });
  return row;
}

function scheduleBatchCatalogSearchReload(): void {
  if (batchCatalogSearchReloadTimer !== null) {
    window.clearTimeout(batchCatalogSearchReloadTimer);
  }

  batchCatalogSearchReloadTimer = window.setTimeout(() => {
    batchCatalogSearchReloadTimer = null;
    void applyFilterAndReload();
  }, 300);
}

function applyBatchCatalogSearchNow(): void {
  if (batchCatalogSearchReloadTimer !== null) {
    window.clearTimeout(batchCatalogSearchReloadTimer);
    batchCatalogSearchReloadTimer = null;
  }
  void applyFilterAndReload();
}

let catalogSuggestionVersion=0;
let catalogSuggestionTimer: ReturnType<typeof setTimeout> | undefined;
async function updateBatchCatalogSearchDropdown(input: HTMLInputElement): Promise<void> {
  const version=++catalogSuggestionVersion, query=input.value;
  try {
    const page=await readBatchLookup('catalogs',query);
    if(version!==catalogSuggestionVersion || input.value!==query || !input.isConnected || document.activeElement!==input) return;
    showDropdownList(input,[...new Set(page.items.map(row=>row.value))]);
  } catch { if(version===catalogSuggestionVersion) closeDropdownList(); }
}

function bindBatchCatalogSearchInput(): void {
  const input = getBatchCatalogSearchInput();
  if (!input) return;

  input.onclick = (e) => {
    e.stopPropagation();
    updateBatchCatalogSearchDropdown(input);
  };

  input.onfocus = () => {
    updateBatchCatalogSearchDropdown(input);
  };

  input.oninput = () => {
    const sanitized = sanitizeCatalogInputValue(input.value);
    if (input.value !== sanitized) {
      input.value = sanitized;
    }

    catalogSuggestionVersion++; clearTimeout(catalogSuggestionTimer);
    catalogSuggestionTimer=setTimeout(()=>void updateBatchCatalogSearchDropdown(input),300);
    scheduleBatchCatalogSearchReload();
  };

  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      clearTimeout(catalogSuggestionTimer); catalogSuggestionVersion++;
      e.preventDefault();
      closeDropdownList();
      applyBatchCatalogSearchNow();
    } else if (e.key === "Escape") {
      clearTimeout(catalogSuggestionTimer); catalogSuggestionVersion++;
      closeDropdownList();
    }
  };
}

/* Завантаження записів з sclad за фільтром статусу та датами */
async function loadScladFilteredRecords(
  statusFilter?: string,
  dateFrom?: string,
  dateTo?: string,
  before: number | null = null,
  onPage?: (next: number | null) => void,
): Promise<any[]> {
  const filter = statusFilter || activeFilter;
  const catalogSearch = getBatchCatalogSearchValue();
  try {
    let data: any[];
    const { data: page, error: pageError } = await readStockPage({
      p_status: filter, p_from: dateFrom || null, p_to: dateTo || null,
      p_query: catalogSearch, p_before: before, p_limit: before === null ? 20 : 5,
    }, JSON.stringify([localStorage.getItem("userAuthData")]));
    if (!pageError) {
      if (!page || !Array.isArray(page.items) || page.items.length > (before === null ? 20 : 5) || typeof page.has_more !== "boolean" ||
        (page.has_more && page.items.length !== (before === null ? 20 : 5)) ||
        (page.has_more && (!Number.isFinite(page.next_cursor) || (before !== null && page.next_cursor >= before)))) {
        throw new Error("Некоректна сторінка складу");
      }
      data = page.items;
      onPage?.(page.has_more ? page.next_cursor : null);
    } else {
      if (["PGRST202", "42883"].includes(pageError.code)) throw new Error("Встановіть міграцію traffic_stock_lazy_page для підвантаження складу.");
      throw pageError;
    }

    if (data.length === 0) return [];

    await refreshEnteredActValidity(data.map(rec => ({ actNo: rec.akt })));
    await hydrateEnteredReferences(data.map(rec=>({shop:String(rec.shops||""),detail:String(rec.name||"")})));
    // Конвертуємо записи sclad у формат рядка таблиці batch
    return data.map((rec: any) => {
      const dateRaw = String(rec.time_on || "").trim();
      // Конвертуємо дату в ISO формат для input type="date"
      const isoDate = toIsoDate(dateRaw) || dateRaw;

      const shop = String(rec.shops || "").trim();
      const catno = String(rec.part_number || "").trim();
      const detail = String(rec.name || "").trim();
      const qty = parseLocalizedNumber(rec.kilkist_on);
      const price = parseLocalizedNumber(rec.price);
      const warehouse = String(rec.scladNomer ?? "").trim();
      const invoice = String(rec.rahunok || "").trim();
      const actNo = rec.akt ? String(rec.akt).trim() : "";
      const unit = String(rec.unit_measurement || "штук").trim();
      const orderStatus = rec.statys ? String(rec.statys).trim() : "Прибула";
      const notes = String(rec.prumitka || "").trim();

      // Визначаємо ПІБ замовника за slyusar_id
      let createdBy = "";
      if (rec.xto_zamovuv) {
        createdBy = usersIdReverseMap.get(Number(rec.xto_zamovuv)) || "";
      }

      // Якщо ручна ціна клієнта збережена в sclad.client_price — беремо її.
      // Якщо поле порожнє — працює старий автоматичний розрахунок від складу.
      const clientPriceManual = hasStoredClientPrice(rec.client_price);
      const procent = warehouseProcentMap.get(warehouse) ?? 0;
      const autoClientPrice =
        Math.round((price + (price * procent) / 100) * 100) / 100;
      const clientPrice = clientPriceManual
        ? parseLocalizedNumber(rec.client_price)
        : autoClientPrice;

      // Валідація полів
      const shopValid = !!shop;
      const shopExists = shop ? shopExistsInCache(shop) : false;
      const detailValid = !!detail;
      const detailExists = detail ? detailExistsInCache(detail) : false;
      const unitValid = VALID_UNITS.includes(unit);
      const warehouseValid = warehouse
        ? warehouseListCache.includes(warehouse)
        : false;
      const qtyValid = qty > 0;
      const priceValid = price > 0;
      const actValid = !actNo || actsListCache.includes(actNo);
      const actClosed = actNo
        ? actsDateOffMap.has(parseInt(actNo)) &&
          actsDateOffMap.get(parseInt(actNo)) !== null
        : false;

      const allValid =
        shopValid &&
        detailValid &&
        unitValid &&
        warehouseValid &&
        qtyValid &&
        priceValid &&
        !!isoDate &&
        !!catno &&
        actValid;

      const rowObj = {
        date: isoDate,
        shop,
        catno,
        detail,
        qty,
        price,
        clientPrice,
        clientPriceManual,
        warehouse,
        invoice,
        actNo,
        unit,
        orderStatus,
        createdBy,
        notes,
        action: "Записати",
        status: allValid ? "Готовий" : "Помилка",
        shopValid,
        detailValid,
        unitValid,
        actValid,
        actClosed,
        warehouseValid,
        qtyValid,
        priceValid,
        shopExists,
        detailExists,
        _scladId: rec.sclad_id, // Зберігаємо sclad_id для можливого оновлення
        _dbSnapshot: structuredClone(rec),
      };
      // Snapshots are published only by the current request.
      return rowObj;
    });
  } catch (e) {
    throw e;
  }
}

/** Застосувати фільтр кнопок + дат та перезавантажити таблицю */
async function applyFilterAndReload(append = false): Promise<void> {
  if (append && batchPageLoading) return;
  if (isUploading) {
    showNotification("Зачекайте завершення запису таблиці.", "info", 2500);
    return;
  }
  const request = ++batchReadVersion;
  const session = batchSessionVersion;
  const dateFrom =
    (document.getElementById("filter-date-from-Excel") as HTMLInputElement)
      ?.value || "";
  const dateTo =
    (document.getElementById("filter-date-to-Excel") as HTMLInputElement)
      ?.value || "";

  const pageFilter = JSON.stringify([activeFilter, dateFrom, dateTo, getBatchCatalogSearchValue()]);
  if (append && (batchNextCursor === null || pageFilter !== batchPageFilter)) return;
  batchPageLoading = true;
  const before = append ? batchNextCursor : null;
  let next: number | null = null;
  // Skeleton
  const skeleton = document.getElementById("batch-skeleton-loader");
  const tableContainer = document.getElementById("batch-table-container-Excel");
  const previousScroll = tableContainer?.scrollTop || 0;
  if (!append && skeleton) skeleton.style.display = "block";
  if (!append && tableContainer) tableContainer.classList.add("hidden-all_other_bases");

  try {
    const records = await loadScladFilteredRecords(activeFilter, dateFrom, dateTo, before, cursor => { next = cursor; });
    if (request !== batchReadVersion || session !== batchSessionVersion) return;
    const drafts = collectStockDrafts(parsedDataGlobal, originalSnapshotMap, emptyRowSnapshots);
    const draftIds = new Set(drafts.filter(row => row._scladId).map(row => String(row._scladId)));
    for (const row of records) {
      if (!draftIds.has(String(row._scladId))) saveRowSnapshot(row);
    }
    const previous = append ? parsedDataGlobal.filter(row => row._scladId && !draftIds.has(String(row._scladId))) : [];
    const unique = new Map([...previous, ...records].map(row => [String(row._scladId), row]));
    parsedDataGlobal = mergeStockDrafts([...unique.values()], drafts);
    batchNextCursor = next;
    batchPageFilter = pageFilter;
    updateBatchMoreButton();
    if (!parsedDataGlobal.length) parsedDataGlobal = [createEmptyRow()];
    renderBatchTable(parsedDataGlobal);
    if (tableContainer) tableContainer.scrollTop = append ? previousScroll : 0;
    if (drafts.length) showNotification("Незбережені рядки залишено на початку таблиці, навіть якщо вони не відповідають фільтру.", "info", 4500);
  } catch (error) {
    if (request !== batchReadVersion || session !== batchSessionVersion) return;
    showNotification(error instanceof Error ? error.message : "Не вдалося завантажити склад. Поточні рядки збережено у вікні.", "error", 4000);
  }
  if (request !== batchReadVersion || session !== batchSessionVersion) return;

  batchPageLoading = false;
  if (skeleton) skeleton.style.display = "none";
  if (tableContainer) tableContainer.classList.remove("hidden-all_other_bases");
  document
    .getElementById("batch-upload-btn-Excel")
    ?.classList.remove("hidden-all_other_bases");

  // Скидаємо стан кнопки "Записати"
  const uploadBtn = document.getElementById(
    "batch-upload-btn-Excel",
  ) as HTMLButtonElement | null;
  if (uploadBtn) {
    uploadBtn.removeAttribute("disabled");
    uploadBtn.style.backgroundColor = "";
    uploadBtn.style.cursor = "";
    uploadBtn.textContent = "✅ Записати";
  }

  updateFilterButtonsActive();
}

function updateBatchMoreButton(): void {
  document.getElementById("batch-load-more-Excel")?.remove();
  const container = document.getElementById("batch-table-container-Excel");
  if (!container || container.dataset.lazyStock === "true") return;
  container.dataset.lazyStock = "true";
  container.addEventListener("scroll", () => {
    if (!batchPageLoading && batchNextCursor !== null && container.scrollHeight - container.scrollTop - container.clientHeight < 160) {
      void applyFilterAndReload(true);
    }
  }, { passive: true });
}

/** Оновити візуальний стан активної кнопки фільтра */
function updateFilterButtonsActive(): void {
  const buttons = document.querySelectorAll(".batch-filter-btn-Excel");
  buttons.forEach((btn) => {
    const el = btn as HTMLElement;
    if (el.dataset.filter === activeFilter) {
      el.classList.add("active-filter-Excel");
    } else {
      el.classList.remove("active-filter-Excel");
    }
  });
}

/** Open the same blank entry view as «Додати», without requesting stock rows. */
function showBatchAddMode(): void {
  if (isUploading) return;
  ++batchReadVersion;
  batchPageLoading = false;
  batchNextCursor = null;
  batchPageFilter = "";
  if (batchCatalogSearchReloadTimer !== null) {
    window.clearTimeout(batchCatalogSearchReloadTimer);
    batchCatalogSearchReloadTimer = null;
  }
  clearTimeout(catalogSuggestionTimer);
  catalogSuggestionVersion++;
  closeDropdownList();
  clearBatchCatalogSearchInput();
  updateBatchMoreButton();

  // An untouched blank row is replaced, while actual unsaved edits survive.
  parsedDataGlobal = [
    ...collectStockDrafts(parsedDataGlobal, originalSnapshotMap, emptyRowSnapshots),
    createEmptyRow(),
  ];
  activeFilter = "Замовити+Замовлено";
  document.querySelectorAll(".batch-filter-btn-Excel").forEach(button => {
    button.classList.toggle("active-filter-Excel", button.id === "batch-clear-and-add-btn-Excel");
  });
  const skeleton = document.getElementById("batch-skeleton-loader");
  if (skeleton) skeleton.style.display = "none";
  const textarea = document.getElementById("batch-textarea-Excel") as HTMLTextAreaElement | null;
  if (textarea) { textarea.value = ""; textarea.style.display = "none"; }
  const instructions = document.querySelector<HTMLElement>(".batch-instructions-Excel");
  if (instructions) instructions.style.display = "none";
  const parseButton = document.getElementById("batch-parse-btn-Excel");
  if (parseButton) parseButton.style.display = "none";

  renderBatchTable(parsedDataGlobal);
  const table = document.getElementById("batch-table-container-Excel");
  if (table) {
    table.classList.remove("hidden-all_other_bases");
    table.scrollTop = 0;
  }
  const uploadButton = document.getElementById("batch-upload-btn-Excel") as HTMLButtonElement | null;
  if (uploadButton) {
    uploadButton.classList.remove("hidden-all_other_bases");
    uploadButton.disabled = false;
    uploadButton.style.backgroundColor = "";
    uploadButton.style.cursor = "";
    uploadButton.textContent = "✅ Записати";
  }
}

async function resetModalState() {
  batchSessionVersion++;
  batchPageLoading = false;
  // Preserve draft snapshots when reopening the modal.

  const textarea = document.getElementById(
    "batch-textarea-Excel",
  ) as HTMLTextAreaElement;
  const instructions = document.querySelector(
    ".batch-instructions-Excel",
  ) as HTMLElement;
  const parseBtn = document.getElementById(
    "batch-parse-btn-Excel",
  ) as HTMLButtonElement;

  // Ховаємо textarea та instructions
  if (textarea) {
    textarea.style.display = "none";
    textarea.value = "";
  }
  if (instructions) instructions.style.display = "none";

  // Ховаємо кнопку "Розпарсити"
  if (parseBtn) parseBtn.style.display = "none";

  clearBatchCatalogSearchInput();

  // 1. Встановлюємо дефолтний фільтр
  activeFilter = "Замовити+Замовлено";
  updateFilterButtonsActive();

  await applyFilterAndReload();
}
// ===== Завантаження даних у БД =====
/** A row write borrows the single-position controls without leaving stale inputs after a failure. */
async function insertBatchStockRow(
  row: any,
  dbDate: string,
  employeeId: number | null,
): Promise<{ success: boolean; id: string | number | null }> {
  const originalCRUD = CRUD;
  const originalShop = { ...shopEditState };
  const originalDetail = { ...detailEditState };
  const temporaryElements: HTMLElement[] = [];
  const restoredFields: Array<{ element: HTMLInputElement | HTMLSelectElement; value: string }> = [];
  const fields: Record<string, string> = {
    sclad_date: dbDate,
    sclad_detail_catno: String(row.catno ?? ""),
    sclad_detail: String(row.detail ?? ""),
    sclad_qty_in: String(row.qty ?? ""),
    sclad_price: String(row.price ?? ""),
    sclad_invoice_no: String(row.invoice ?? ""),
    sclad_unit: String(row.unit ?? ""),
    sclad_shop: String(row.shop ?? ""),
    sclad_procent: String(row.warehouse ?? ""),
    sclad_akt: String(row.actNo ?? ""),
    sclad_kilkist_off: "0",
    sclad_statys: row.orderStatus === "Прибула" ? "" : row.orderStatus || "Замовити",
    // An explicitly empty owner must remain null, never fall back to the actor/main form.
    sclad_xto_zamovuv: employeeId == null ? "" : String(employeeId),
    sclad_prumitka: String(row.notes ?? ""),
    sclad_client_price: row.clientPriceManual ? String(row.clientPrice ?? "") : "",
  };
  let insertedId: string | number | null = null;
  try {
    for (const [id, value] of Object.entries(fields)) {
      let element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (element) {
        restoredFields.push({ element, value: element.value });
        // Legacy units/inactive warehouses may be absent from the current main-form options.
        if (element.tagName === "SELECT" && !Array.from((element as HTMLSelectElement).options).some(option => option.value === value)) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          element.appendChild(option);
          temporaryElements.push(option);
        }
      } else {
        const input = document.createElement("input");
        input.id = id;
        input.type = "hidden";
        document.body.appendChild(input);
        temporaryElements.push(input);
        element = input;
      }
      element.value = value;
    }
    resetShopState();
    resetDetailState();
    shopEditState.currentName = row.shop;
    detailEditState.currentName = row.detail;
    updateCRUD("Додати");
    const success = await handleScladCrud({
      skipAuditLog: true,
      referencesResolved: true,
      onInserted: (id: string | number, snapshot?: Record<string, any>) => {
        insertedId = id;
        if (snapshot) row._dbSnapshot = structuredClone(snapshot);
      },
    });
    return { success, id: insertedId };
  } finally {
    updateCRUD(originalCRUD);
    for (const element of temporaryElements) element.remove();
    for (const field of restoredFields) field.element.value = field.value;
    Object.assign(shopEditState, originalShop);
    Object.assign(detailEditState, originalDetail);
  }
}

async function deleteBatchStockRow(row: any): Promise<void> {
  const baseline = originalSnapshotMap.get(row._scladId)?._db;
  if (!baseline || String(baseline.sclad_id) !== String(row._scladId)) {
    throw new Error("Оновіть склад і повторно оберіть позицію: відсутні початкові дані для видалення.");
  }
  await deleteScladSnapshot(baseline);
}

function batchRowError(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/** Completed deletions keep their IDs for the audit but must never be sent again on retry. */
function isCompletedBatchDeletion(row: any): boolean {
  return row.action === "Видалити" && (row.status === "🗑️ Видалено" || row.status === "🗑️ Пропущено");
}

/** Batch only independent existing IDs. Each result retains the original per-cell CAS outcome. */
async function prewriteBatchStockCells(
  rows: any[], userIds: Map<string, number | null>, assertActor: () => void,
): Promise<Map<any, { error?: unknown }>> {
  const receipts = new Map<any, { error?: unknown }>();
  const occurrences = new Map<string, number>();
  for (const row of rows) if (row._scladId) {
    const id = String(row._scladId); occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  const items: Array<{ row: any; key: string; id: number; changes: Record<string, any>; expected: Record<string, any> }> = [];
  for (const [index, row] of rows.entries()) {
    if (!row._scladId || row.action === "Видалити" || occurrences.get(String(row._scladId)) !== 1) continue;
    try {
      let date = row.date;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(date)) { const [dd, mm, yyyy] = date.split("."); date = `${yyyy}-${mm}-${dd}`; }
      const employee = row.createdBy ? userIds.get(String(row.createdBy).trim()) ?? null : null;
      const changes = getChangedScladFields(row, date, employee);
      if (!changes) continue;
      const baseline = originalSnapshotMap.get(row._scladId)?._db;
      if (!baseline) throw new Error("Оновіть склад: відсутні початкові значення комірок.");
      const expected: Record<string, any> = {};
      for (const field of Object.keys(changes)) {
        if (!Object.prototype.hasOwnProperty.call(baseline, field)) throw new Error("Неповний знімок комірки складу.");
        expected[field] = baseline[field];
      }
      const id = Number(row._scladId);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Некоректний номер складської позиції.");
      items.push({ row, key: String(index), id, changes, expected });
    } catch (error) { receipts.set(row, { error }); }
  }
  for (let offset = 0; offset < items.length; offset += 100) {
    assertActor();
    const chunk = items.slice(offset, offset + 100);
    const { data, error } = await supabase.rpc("write_batch_stock_cells", {
      p_items: chunk.map(({ key, id, changes, expected }) => ({ key, id, changes, expected })),
    });
    assertActor();
    if (error) { for (const item of chunk) receipts.set(item.row, { error }); continue; }
    const valid = Array.isArray(data) && data.length === chunk.length &&
      new Set(data.map((result: any) => result.key)).size === chunk.length &&
      data.every((result: any) => chunk.some(item => item.key === result.key && item.id === Number(result.id)) && ["updated", "error"].includes(result.status));
    if (!valid) {
      for (const item of chunk) receipts.set(item.row, { error: new Error("Не отримано повних квитанцій змінених комірок. Оновіть склад перед повтором.") });
      continue;
    }
    const byKey = new Map<string, any>(data.map((result: any) => [result.key, result]));
    for (const item of chunk) {
      const result = byKey.get(item.key);
      receipts.set(item.row, result.status === "updated" ? {} : { error: new Error(result.message || "Не вдалося записати комірки.") });
    }
  }
  return receipts;
}

async function uploadBatchData(data: any[]) {
  // 🔒 анти-дублювання: якщо вже йде аплоад — ігноруємо повторний виклик
  if (isUploading) return;
  const uploadActor = localStorage.getItem("userAuthData") || "";
  const assertActor = () => {
    if (uploadActor !== (localStorage.getItem("userAuthData") || "")) throw new Error("Користувач змінився під час імпорту. Відкрийте склад повторно.");
  };
  // Keep row assignments stable even if the modal is closed while saving.
  const uploadUserIds = new Map(usersIdMap);
  const actorMatches = usersCacheActor === (localStorage.getItem("userAuthData") || "");
  for (const row of data) {
    if (row.action === "Видалити") continue;
    const name = String(row.createdBy || "").trim();
    const snapshot = row._scladId ? originalSnapshotMap.get(row._scladId) : undefined;
    const changed = !row._scladId || String(snapshot?.createdBy ?? "") !== String(row.createdBy ?? "");
    if (!name || !changed) continue;
    if (!actorMatches || !uploadUserIds.has(name)) {
      showNotification(`Замовника «${name}» не знайдено. Виберіть ПІБ зі списку; якщо користувач змінився, відкрийте вікно деталей повторно.`, "error", 5000);
      return;
    }
    if (uploadUserIds.get(name) === null) {
      showNotification(`ПІБ «${name}» належить кільком співробітникам. Уточніть їхні імена в довіднику та відкрийте вікно деталей повторно. Запис скасовано.`, "error", 5000);
      return;
    }
  }
  ++batchReadVersion;
  isUploading = true;

  const uploadBtn = document.getElementById("batch-upload-btn-Excel");
  uploadBtn?.classList.add("loading-Excel");
  uploadBtn?.setAttribute("disabled", "true");

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  scladIdsMap.clear();

  // ===== Збір деталізації змін для повідомлення =====
  const changeDetails: Array<{
    type: "add" | "edit" | "delete";
    desc: string;
  }> = [];


  try {
    // 1) Унікальні назви
    const uniqueShops = [
      ...new Set(data.filter(row=>row.action!=="Видалити").map((row) => (row.shop ?? "").trim()).filter(Boolean)),
    ];
    const uniqueDetails = [
      ...new Set(data.filter(row=>row.action!=="Видалити").map((row) => (row.detail ?? "").trim()).filter(Boolean)),
    ];

    const references: ReferenceInput[] = [
      ...uniqueShops.map((name,index)=>({key:'shop:'+index,kind:'shops' as const,name})),
      ...uniqueDetails.map((name,index)=>({key:'detail:'+index,kind:'details' as const,name})),
    ];
    for(let offset=0;offset<references.length;offset+=100) {
      assertActor();
      if(uploadBtn) uploadBtn.textContent='Назви: '+offset+' / '+references.length;
      try { await resolveStockReferences(references.slice(offset,offset+100)); }
      catch(error) { throw new Error('Не вдалося визначити назви. Завершено '+offset+' із '+references.length+'. Складські рядки ще не записані. Повтор безпечний: створені назви будуть використані повторно. '+(error instanceof Error?error.message:'')); }
    }

    // 5) Обробка кожного рядка — зі smart diff (тільки змінені поля)
    // Збираємо дані для батч-оновлення актів
    const actUpdatesMap: Map<
      string,
      Array<{ rowIndex: number; row: any; scladIdWeb: string | null; detailForAct: any }>
    > = new Map();

    const cellReceipts = await prewriteBatchStockCells(data, uploadUserIds, assertActor);

    for (let i = 0; i < data.length; i++) {
      assertActor();
      const row = data[i];
      if (isCompletedBatchDeletion(row)) {
        successCount++;
        skippedCount++;
        continue;
      }

      // дата для БД (yyyy-mm-dd)
      let dbDate = row.date;
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(row.date)) {
        const [dd, mm, yyyy] = row.date.split(".");
        dbDate = `${yyyy}-${mm}-${dd}`;
      }

      // Отримуємо slyusar_id за ПІБ з кешу
      const slyusarIdForRow = row.createdBy
        ? uploadUserIds.get(String(row.createdBy).trim()) ?? null
        : null;

      // === Якщо дія = "Видалити" — видаляємо запис з бази ===
      if (row.action === "Видалити") {
        if (row._scladId) {
          try {
            await deleteBatchStockRow(row);
            const delDomIdx = (row.rowNumber || i + 1) - 1;
            successCount++;
            row.status = "🗑️ Видалено";
            updateRowStatus(delDomIdx, true, row.status);
            if (parsedDataGlobal[delDomIdx]) parsedDataGlobal[delDomIdx].status = "🗑️ Видалено";
            changeDetails.push({
              type: "delete",
              desc: `🗑️ Видалено: ${rowIdentifier(row)}${row.shop ? `, ${row.shop}` : ""}`,
            });
          } catch (err) {
            const delDomIdx2 = (row.rowNumber || i + 1) - 1;
            console.error(`Помилка видалення sclad_id=${row._scladId}:`, err);
            errorCount++;
            const message = "❌ " + batchRowError(err, "Не вдалося видалити складську позицію.");
            updateRowStatus(delDomIdx2, false, message);
            if (parsedDataGlobal[delDomIdx2]) parsedDataGlobal[delDomIdx2].status = message;
          }
        } else {
          // Новий рядок з дією "Видалити" — просто пропускаємо
          const skipDomIdx = (row.rowNumber || i + 1) - 1;
          successCount++;
          row.status = "🗑️ Пропущено";
          updateRowStatus(skipDomIdx, true, row.status);
          if (parsedDataGlobal[skipDomIdx])
            parsedDataGlobal[skipDomIdx].status = "🗑️ Пропущено";
        }
        continue;
      }

      // === Якщо рядок завантажений з бази (має _scladId) — UPDATE, інакше перевіряємо на дублікат ===
      const isExistingRecord = !!row._scladId;

      let scladSuccess = false;
      let stockError = "Не вдалося зберегти складську позицію.";
      let insertedStockId: string | number | null = null;
      let rowSkipped = false; // true якщо рядок без змін — пропущений
      let rowHasScladChanges = !isExistingRecord;

      if (isExistingRecord) {
        try {
        // === SMART DIFF: порівнюємо зі снапшотом, оновлюємо тільки змінені поля ===
        const changedFields = getChangedScladFields(
          row,
          dbDate,
          slyusarIdForRow,
        );
        rowHasScladChanges = changedFields !== null;

        if (changedFields === null) {
          // Нічого не змінилось — пропускаємо запис у sclad
          scladSuccess = true;
          rowSkipped = true;
          skippedCount++;
        } else {
          // Є зміни — оновлюємо тільки змінені поля
          try {
            const baseline = originalSnapshotMap.get(row._scladId)?._db;
            if (!baseline) throw new Error("Оновіть склад: відсутні початкові значення комірок.");
            let updateError: unknown = cellReceipts.get(row)?.error;
            if (!cellReceipts.has(row)) {
              // Repeated IDs can depend on earlier rows: preserve their sequential behavior.
              let update = supabase.from("sclad").update(changedFields).eq("sclad_id", row._scladId);
              for (const key of Object.keys(changedFields)) {
                if (!Object.prototype.hasOwnProperty.call(baseline, key)) throw new Error("Неповний знімок комірки складу.");
                update = baseline[key] == null ? update.is(key, null) : update.eq(key, baseline[key]);
              }
              const response = await update.select("sclad_id");
              assertActor();
              updateError = response.error;
              if (!updateError && response.data?.length !== 1) throw new Error("Комірки вже змінено іншим користувачем. Оновіть склад і повторіть редагування.");
            }
            if (!updateError) row._dbSnapshot = { ...baseline, ...changedFields };

            scladSuccess = !updateError;
            if (updateError) {
              stockError = batchRowError(updateError, stockError);
              console.error(
                `Помилка оновлення sclad_id=${row._scladId}:`,
                updateError,
              );
            } else {
              // Збираємо деталізацію змін
              const rowChanges = buildRowChangesDescription(row);
              if (rowChanges.length > 0) {
                changeDetails.push({
                  type: "edit",
                  desc: `✏️ ${rowIdentifier(row)}: ${rowChanges.join("; ")}`,
                });
              }
            }
          } catch (err) {
            scladSuccess = false;
            stockError = batchRowError(err, "Не вдалося записати змінені комірки.");
          }
        }
        } catch (error) {
          scladSuccess = false;
          stockError = batchRowError(error, "Не вдалося записати змінені комірки.");
        }
      } else {
        try {
          const inserted = await insertBatchStockRow(row, dbDate, slyusarIdForRow);
          scladSuccess = inserted.success;
          insertedStockId = inserted.id;
          if (scladSuccess) {
            const addDesc = buildRowAddedDescription(row);
            if (addDesc) changeDetails.push({ type: "add", desc: `➕ ${addDesc}` });
          }
        } catch (err) {
          stockError = batchRowError(err, stockError);
          // Keep the row and its values editable; a failed row must not abort the remaining batch.
          console.error("Помилка додавання складської позиції:", err);
        }
      }

      if (!scladSuccess) {
        const errDomIdx = (row.rowNumber || i + 1) - 1;
        errorCount++;
        const message = "❌ " + stockError;
        updateRowStatus(errDomIdx, false, message);
        if (parsedDataGlobal[errDomIdx]) parsedDataGlobal[errDomIdx].status = message;
        continue;
      }

      // отримати sclad_id запису
      let scladIdWeb: string | null = null;
      if (row._scladId) {
        // Для існуючих записів (або тих, що знайшли дублікат) — вже маємо sclad_id
        scladIdWeb = String(row._scladId);
        const key = `${dbDate}|${row.catno}|${row.detail}`;
        scladIdsMap.set(key, scladIdWeb);
      } else {
        // Для нових записів — отримуємо sclad_id щойно створеного запису
        try {
          // Repeated catalogue/name rows in an invoice are distinct positions.
          scladIdWeb = insertedStockId == null ? null : String(insertedStockId);
          if (scladIdWeb) {
            const key = `${dbDate}|${row.catno}|${row.detail}`;
            scladIdsMap.set(key, scladIdWeb);
          }
        } catch (err) {
          // console.error("Помилка отримання sclad_id:", err);
        }
      }

      // Збираємо деталі для батч-оновлення актів
      // Рядок з actNo завжди перевіряємо в акті:
      // відсутню деталь додаємо, існуючу оновлюємо тільки якщо рядок/акт змінився.
      const domRowIndex = (row.rowNumber || i + 1) - 1;
      if (!scladIdWeb) {
        errorCount++;
        updateRowStatus(domRowIndex, false, "Запис відправлено, але ID не отримано. Перевірте склад перед повторенням.");
        if (parsedDataGlobal[domRowIndex]) parsedDataGlobal[domRowIndex].status = "⚠️ Перевірте склад";
        continue;
      }
      if (!isExistingRecord && scladIdWeb && parsedDataGlobal[domRowIndex]) {
        row._scladId = scladIdWeb;
        parsedDataGlobal[domRowIndex]._scladId = scladIdWeb;
        saveRowSnapshot(row);
      }
      const originalActNo = isExistingRecord
        ? String(originalSnapshotMap.get(row._scladId)?.actNo ?? "").trim()
        : "";
      const currentActNo = (row.actNo ?? "").trim();
      const actNoChanged = currentActNo !== originalActNo;
      if (currentActNo) {
        const actNo = currentActNo;
        const detailSum = (row.clientPrice || 0) * (row.qty || 0);
        const detailForAct = {
          sclad_id: scladIdWeb ? Number(scladIdWeb) : null,
          Сума: detailSum,
          Ціна: row.clientPrice || 0,
          Деталь: row.detail,
          Каталог: row.catno,
          Магазин: row.shop,
          Кількість: row.qty || 0,
          _updateExisting: !!row._actSyncPending || (!rowSkipped && (actNoChanged || rowHasScladChanges)),
        };
        if (!actUpdatesMap.has(actNo)) {
          actUpdatesMap.set(actNo, []);
        }
        actUpdatesMap
          .get(actNo)!
          .push({ rowIndex: domRowIndex, row, scladIdWeb, detailForAct });
      }

      // The stock write is committed. Retain its latest baseline independently of act-sync success.
      if (scladSuccess) {
        if (!row._dbSnapshot) row._dbSnapshot = originalSnapshotMap.get(row._scladId)?._db;
        saveRowSnapshot(row);
        if (parsedDataGlobal[domRowIndex]) parsedDataGlobal[domRowIndex]._dbSnapshot = row._dbSnapshot;
        if (parsedDataGlobal[domRowIndex]) emptyRowSnapshots.set(parsedDataGlobal[domRowIndex], { ...row });
        successCount++;
        if (rowSkipped) {
          updateRowStatus(domRowIndex, true, "⏭️ Без змін");
          if (parsedDataGlobal[domRowIndex])
            parsedDataGlobal[domRowIndex].status = "⏭️ Без змін";
        } else {
          updateRowStatus(domRowIndex, true, "✅ Успішно");
          if (parsedDataGlobal[domRowIndex])
            parsedDataGlobal[domRowIndex].status = "✅ Успішно";
        }
      } else {
        errorCount++;
        updateRowStatus(domRowIndex, false, "❌ Помилка");
        if (parsedDataGlobal[domRowIndex])
          parsedDataGlobal[domRowIndex].status = "❌ Помилка";
      }

      // Пауза кожні 10 рядків
      if (i % 10 === 9) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // 6) Батч-оновлення актів — кожен акт завантажуємо/зберігаємо лише раз
    for (const [actNo, details] of actUpdatesMap) {
      assertActor();
      const actSuccess = await batchUpdateActWithDetails(
        actNo,
        details.map((d) => d.detailForAct),
        assertActor,
      );
      if (!actSuccess) {
        errorCount += details.length;
        for (const { rowIndex, row } of details) {
          row._actSyncPending = true;
          updateRowStatus(rowIndex, true, "⚠️ Збережено (акт не оновлено)");
          if (parsedDataGlobal[rowIndex]) {
            parsedDataGlobal[rowIndex]._actSyncPending = true;
            parsedDataGlobal[rowIndex].status = "⚠️ Збережено (акт не оновлено)";
          }
        }
      } else {
        for (const { rowIndex, row } of details) {
          delete row._actSyncPending;
          if (parsedDataGlobal[rowIndex]) delete parsedDataGlobal[rowIndex]._actSyncPending;
        }
      }
    }
  } finally {
    invalidateStockReads(); // Also invalidate after partially successful writes.
    // знімаємо лоадінг
    uploadBtn?.classList.remove("loading-Excel");
    isUploading = false;
  }

  if (errorCount === 0) {
    // Все успішно - залишаємо кнопку заблокованою
    if (uploadBtn) {
      uploadBtn.setAttribute("disabled", "true");
      uploadBtn.style.backgroundColor = "#9ca3af";
      uploadBtn.style.cursor = "not-allowed";
      uploadBtn.textContent = "✅ Записано";
    }
    const totalMsg =
      skippedCount > 0
        ? `Успішно: ${successCount} (${skippedCount} без змін — пропущено)`
        : `Успішно завантажено ${successCount} ${
            successCount === 1
              ? "запис"
              : successCount < 5
                ? "записи"
                : "записів"
          }`;

    // Деталізоване повідомлення
    if (changeDetails.length > 0) {
      const maxLines = 8;
      const lines = changeDetails.slice(0, maxLines).map((d) => d.desc);
      if (changeDetails.length > maxLines) {
        lines.push(`…і ще ${changeDetails.length - maxLines}`);
      }
      const detailHtml = lines
        .map(
          (l) =>
            `<div style="font-size:13px;line-height:1.4;margin-top:2px">${l}</div>`,
        )
        .join("");
      showNotification(
        `${totalMsg}<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.3);padding-top:6px">${detailHtml}</div>`,
        "success",
        changeDetails.length > 3 ? 8000 : 5000,
      );
    } else {
      showNotification(totalMsg, "success", 4000);
    }

    await logAction(
      "warehouse_excel_import",
      null,
      {
        success: successCount,
        skipped: skippedCount,
        total: successCount + skippedCount,
        changes: changeDetails.map((d) => d.desc),
      },
      "warehouse",
    );
  } else {
    // Є помилки - розблоковуємо кнопку для повторної спроби
    uploadBtn?.removeAttribute("disabled");

    // Деталізоване повідомлення з помилками
    const errMsg = `Завантажено: ${successCount}, Помилок: ${errorCount}`;
    if (changeDetails.length > 0) {
      const maxLines = 8;
      const lines = changeDetails.slice(0, maxLines).map((d) => d.desc);
      if (changeDetails.length > maxLines) {
        lines.push(`…і ще ${changeDetails.length - maxLines}`);
      }
      const detailHtml = lines
        .map(
          (l) =>
            `<div style="font-size:13px;line-height:1.4;margin-top:2px">${l}</div>`,
        )
        .join("");
      showNotification(
        `${errMsg}<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.3);padding-top:6px">${detailHtml}</div>`,
        "warning",
        8000,
      );
    } else {
      showNotification(errMsg, "warning", 5000);
    }

    await logAction(
      "warehouse_excel_import",
      null,
      {
        success: successCount,
        errors: errorCount,
        total: successCount + errorCount,
        changes: changeDetails.map((d) => d.desc),
      },
      "warehouse",
    );
  }
}

// Функція для оновлення статусу рядка
function updateRowStatus(
  rowIndex: number,
  success: boolean,
  statusText: string,
) {
  const row = document.querySelector(
    `#batch-table-Excel tbody tr:nth-child(${rowIndex + 1})`,
  );

  if (!row) return;

  const statusCell = row.querySelector(".status-cell-Excel");

  if (statusCell) {
    const statusTextEl = statusCell.querySelector(".status-text-Excel");
    if (statusTextEl) statusTextEl.textContent = statusText;
    (statusCell as HTMLElement).className = success
      ? "status-cell-Excel success-Excel"
      : "status-cell-Excel error-Excel";
    if (success) {
      const deleteBtn = statusCell.querySelector(".delete-row-btn-Excel");
      deleteBtn?.remove();

      // Додаємо зелену галочку ✅ замість кнопки
      const checkmark = document.createElement("span");
      checkmark.textContent = "✅";
      checkmark.style.fontSize = "18px";
      checkmark.style.display = "flex";
      checkmark.style.justifyContent = "center";
      checkmark.style.alignItems = "center";
      checkmark.title = statusText;
      statusCell.appendChild(checkmark);

      // 🔒 Блокуємо АБСОЛЮТНО ВСІ інпути (включно з dropdown)
      const inputs =
        row.querySelectorAll<HTMLInputElement>(".cell-input-Excel");
      inputs.forEach((input) => {
        input.readOnly = true;
        input.disabled = true; // Для надійності
        input.style.backgroundColor = "#f5f5f5";
        input.style.cursor = "not-allowed";
        input.style.color = "#666";
        input.style.pointerEvents = "none"; // Забороняємо кліки (щоб dropdown не відкривався)
      });
    }
  }
}
// ===== Ініціалізація =====
export function initBatchImport() {
  // 🔒 не ініціалізувати вдруге (щоб слухачі не множилися)
  if (batchInitDone) return;
  batchInitDone = true;

  // Ensure модалки створені один раз
  const existingModal = document.getElementById(batchModalId);
  if (!existingModal) {
    document.body.appendChild(createBatchImportModal());
  }
  document.addEventListener("sto:other-bases-closed", () => {
    if (!document.getElementById(batchModalId)?.classList.contains("hidden-all_other_bases")) return;
    clearBatchUsers();
    ++batchSessionVersion;
    ++batchReadVersion;
  });
  bindBatchCatalogSearchInput();

  // 🎙️ Перевірка видимості кнопки голосового введення
  if (!globalCache.generalSettings.voiceInputEnabled) {
    const voiceBtnExcel = document.getElementById("voice-input-btn-Excel");
    if (voiceBtnExcel) voiceBtnExcel.style.display = "none";
  }

  const existingConfirmModal = document.getElementById(confirmModalId);
  if (!existingConfirmModal) {
    document.body.appendChild(createConfirmModal());
  }

  // Слухач скролу для "прилипання" дропдауну до інпута
  const tableContainer = document.getElementById("batch-table-container-Excel");
  if (tableContainer) {
    tableContainer.addEventListener("scroll", () => {
      if (currentDropdownInput && currentDropdownList) {
        positionDropdown(currentDropdownInput, currentDropdownList);
      }
    });
  }

  // Глобальний клік для закриття дропдаунів — призначаємо 1 раз
  document.onclick = (e) => {
    const target = e.target as HTMLElement;
    if (
      !target.closest(".excel-dropdown-list") &&
      !target.closest(".cell-input-combo-Excel")
    ) {
      closeDropdownList();
    }
  };

  // === КНОПКИ: призначаємо через onclick, щоб НЕ накопичувалось ===
  const importBtn = document.getElementById(
    "import-excel-btn",
  ) as HTMLButtonElement | null;
  if (importBtn) {
    importBtn.onclick = async () => {
      const modal = document.getElementById(batchModalId);
      if (!modal || isUploading || !modal.classList.contains("hidden-all_other_bases")) return;

      const opening = ++batchSessionVersion;
      const openingActor = localStorage.getItem("userAuthData") || "";
      clearBatchUsers();
      // 1. Одразу відкриваємо модалку
      modal.classList.remove("hidden-all_other_bases");

      // 2. Показуємо skeleton loader, ховаємо контент
      const skeleton = document.getElementById("batch-skeleton-loader");
      const tableContainer = document.getElementById(
        "batch-table-container-Excel",
      );
      const textarea = document.getElementById(
        "batch-textarea-Excel",
      ) as HTMLTextAreaElement;
      const instructions = document.querySelector(
        ".batch-instructions-Excel",
      ) as HTMLElement;
      const parseBtn = document.getElementById(
        "batch-parse-btn-Excel",
      ) as HTMLButtonElement;
      const uploadBtn = document.getElementById(
        "batch-upload-btn-Excel",
      ) as HTMLButtonElement;

      if (skeleton) skeleton.style.display = "block";
      if (tableContainer)
        tableContainer.classList.add("hidden-all_other_bases");
      if (textarea) textarea.style.display = "none";
      if (instructions) instructions.style.display = "none";
      if (parseBtn) parseBtn.style.display = "none";
      if (uploadBtn) uploadBtn.classList.add("hidden-all_other_bases");

      // 3. Завантажуємо дані у фоні (модалка вже видима зі skeleton)
      try {
        const [shops, details, acts, warehouses, users, partNumbers] =
          await Promise.all([
            Promise.resolve([] as string[]),
            Promise.resolve([] as string[]),
            Promise.resolve({ list: [] as string[], map: new Map<number, string | null>() }),
            loadWarehouseList(),
            loadUsersList(),
            Promise.resolve([] as string[]),
          ]);
        if (opening !== batchSessionVersion) return;
        if (openingActor !== (localStorage.getItem("userAuthData") || "")) {
          throw new Error("Користувач змінився. Відкрийте вікно деталей повторно.");
        }
        shopsListCache = shops;
        detailsListCache = details;
        shopsListCacheNormalized = shopsListCache.map(normalizeNameForCompare);
        detailsListCacheNormalized = detailsListCache.map(
          normalizeNameForCompare,
        );
        actOptionLabels.clear();
        partNumberNameMap.clear();
        actsListCache = acts.list;
        actsDateOffMap = acts.map;
        warehouseListCache = warehouses;
        usersListCache = users.names;
        usersIdMap = users.byName;
        usersIdReverseMap = users.byId;
        usersCacheActor = openingActor;
        partNumbersCache = partNumbers as string[];
      } catch (err) {
        if (opening !== batchSessionVersion) return;
        clearBatchUsers();
        ++batchSessionVersion;
        ++batchReadVersion;
        modal.classList.add("hidden-all_other_bases");
        if (skeleton) skeleton.style.display = "none";
        showNotification(err instanceof Error ? err.message : "Не вдалося завантажити довідники. Відкрийте вікно деталей повторно.", "error", 6000);
        return;
      }

      if (opening !== batchSessionVersion) return;
      // 4. Відкриваємо «Додати» з порожнім рядком без завантаження sclad.
      showBatchAddMode();

      // 5. Ховаємо skeleton, показуємо таблицю
      if (skeleton) skeleton.style.display = "none";
    };
  }

  // === Кнопки фільтрації статусу ===
  const filterButtons = document.querySelectorAll(".batch-filter-btn-Excel[data-filter]");
  filterButtons.forEach((btn) => {
    (btn as HTMLButtonElement).onclick = async () => {
      activeFilter =
        (btn as HTMLElement).dataset.filter || "Замовити+Замовлено";
      await applyFilterAndReload();
    };
  });

  // Кнопка "Додати" (очистити все і додати 1 рядок)
  const clearAndAddBtn = document.getElementById(
    "batch-clear-and-add-btn-Excel",
  ) as HTMLButtonElement | null;
  if (clearAndAddBtn) {
    clearAndAddBtn.onclick = () => {
      if (isUploading) return;
      showBatchAddMode();
      showNotification("Додано новий рядок. Незбережені зміни залишено в таблиці.", "info", 2500);
    };
  }

  // Календарні фільтри (від — до)
  const dateFromInput = document.getElementById(
    "filter-date-from-Excel",
  ) as HTMLInputElement | null;
  const dateToInput = document.getElementById(
    "filter-date-to-Excel",
  ) as HTMLInputElement | null;
  if (dateFromInput) {
    dateFromInput.onchange = () => applyFilterAndReload();
  }
  if (dateToInput) {
    dateToInput.onchange = () => applyFilterAndReload();
  }

  // Позначаємо активну кнопку при ініціалізації
  updateFilterButtonsActive();

  // Ініціалізуємо кастомний DatePicker для фільтрових дат
  const filterBar = document.querySelector(
    ".batch-filter-bar-Excel",
  ) as HTMLElement | null;
  if (filterBar) {
    initCustomDatePicker(filterBar);
  }

  const closeBtn = document.querySelector(
    `#${batchModalId} .modal-close-all_other_bases`,
  ) as HTMLButtonElement | null;
  if (closeBtn) {
    closeBtn.onclick = () => {
      document
        .getElementById(batchModalId)
        ?.classList.add("hidden-all_other_bases");
      closeDropdownList();
      clearBatchUsers();
      invalidateBatchLookupCaches();
      // Closing does not fetch the warehouse or discard local drafts.
      ++batchSessionVersion;
      ++batchReadVersion;
      if (batchCatalogSearchReloadTimer !== null) {
        window.clearTimeout(batchCatalogSearchReloadTimer);
        batchCatalogSearchReloadTimer = null;
      }
    };
  }

  const parseBtn = document.getElementById(
    "batch-parse-btn-Excel",
  ) as HTMLButtonElement | null;
  if (parseBtn) {
    parseBtn.onclick = async () => {
      const textarea = document.getElementById(
        "batch-textarea-Excel",
      ) as HTMLTextAreaElement;
      const instructions = document.querySelector(
        ".batch-instructions-Excel",
      ) as HTMLElement;

      const data = parseBatchData(textarea.value);
      const source=textarea.value, session=batchSessionVersion;
      try { await hydrateEnteredReferences(data); await refreshEnteredActValidity(data); } catch {showNotification("Не вдалося перевірити введені назви. Повторіть дію.","error");return;}
      if(session!==batchSessionVersion || textarea.value!==source) return;
      data.forEach(row=>{row.shopExists=shopExistsInCache(row.shop);row.detailExists=detailExistsInCache(row.detail);row.actValid=!row.actNo || actsListCache.includes(row.actNo.trim());});
      if (data.length) {
        parsedDataGlobal = data;
        renderBatchTable(data);
        textarea.style.display = "none";
        if (instructions) instructions.style.display = "none";
        document
          .getElementById("batch-table-container-Excel")
          ?.classList.remove("hidden-all_other_bases");
        document
          .getElementById("batch-upload-btn-Excel")
          ?.classList.remove("hidden-all_other_bases");
        showNotification(
          `Розпарсовано ${data.length} ${
            data.length === 1 ? "рядок" : data.length < 5 ? "рядки" : "рядків"
          }`,
          "success",
        );
      } else {
        showNotification(
          "Немає валідних даних для парсингу! Перевірте формат.",
          "error",
          4000,
        );
      }
    };
  }

  // Обробник кнопки "Додати рядок"
  const addRowBtn = document.getElementById(
    "batch-add-row-btn-Excel",
  ) as HTMLButtonElement | null;
  if (addRowBtn) {
    addRowBtn.onclick = () => {
      // Додаємо новий порожній рядок
      const newRow = createEmptyRow();
      parsedDataGlobal.push(newRow);
      renderBatchTable(parsedDataGlobal);

      // Прокручуємо до нового рядка
      const tableContainer = document.getElementById(
        "batch-table-container-Excel",
      );
      if (tableContainer) {
        setTimeout(() => {
          tableContainer.scrollTop = tableContainer.scrollHeight;
        }, 50);
      }
    };
  }

  const invoiceButton = document.getElementById("batch-invoice-ocr-btn");
  if (invoiceButton) invoiceButton.onclick = async () => {
    const session = batchSessionVersion;
    try {
      if (isUploading) throw new Error("Зачекайте завершення запису таблиці.");
      const { openInvoiceRecognition } = await import("../../workshop/invoiceUI");
      await openInvoiceRecognition(async rows => {
        if (session !== batchSessionVersion || document.getElementById(batchModalId)?.classList.contains("hidden-all_other_bases")) throw new Error("Вікно складу вже змінилося. Відкрийте розпізнавання з поточного вікна.");
        if (isUploading) throw new Error("Зачекайте завершення запису таблиці.");
        if (rows.some(row => parsedDataGlobal.some(old => old._invoiceOrigin === row._invoiceOrigin))) throw new Error("Ця накладна вже додана до поточної таблиці.");
        await hydrateEnteredReferences(rows);
        if(session!==batchSessionVersion || isUploading) throw new Error("Вікно складу змінилося. Повторіть додавання.");
        // Only append; never replace unsaved rows or invoke upload automatically.
        const start = parsedDataGlobal.length;
        rows.forEach(row => parsedDataGlobal.push({ ...createEmptyRow(), ...row,
          shopValid: true, detailValid: true, qtyValid: row.qty > 0, priceValid: row.price > 0,
          shopExists: shopsListCache.includes(row.shop), detailExists: detailsListCache.includes(row.detail) }));
        renderBatchTable(parsedDataGlobal);
        for (let index = start; index < parsedDataGlobal.length; index++) revalidateRow(index);
        document.getElementById("batch-table-container-Excel")?.classList.remove("hidden-all_other_bases");
        document.getElementById("batch-upload-btn-Excel")?.classList.remove("hidden-all_other_bases");
        showNotification(`Додано ${rows.length} рядків. Перевірте склад і натисніть «Записати».`, "info", 6000);
      });
    } catch (error) { showNotification(error instanceof Error ? error.message : "Помилка розпізнавання", "error"); }
  };

  // === Голосове введення ===
  initVoiceInputExcel({
    addRow: (): number => {
      const newRow = createEmptyRow();
      parsedDataGlobal.push(newRow);
      renderBatchTable(parsedDataGlobal);
      const tc = document.getElementById("batch-table-container-Excel");
      if (tc)
        setTimeout(() => {
          tc.scrollTop = tc.scrollHeight;
        }, 50);
      return parsedDataGlobal.length - 1; // повертаємо індекс нового рядка
    },
    sortColumn: (col: string) => {
      sortTableByColumn(col);
    },
    getParsedData: () => parsedDataGlobal,
    renderTable: (data: any[]) => {
      renderBatchTable(data);
    },
  });

  const uploadBtn = document.getElementById(
    "batch-upload-btn-Excel",
  ) as HTMLButtonElement | null;
  if (uploadBtn) {
    uploadBtn.onclick = async () => {
      try { await refreshEnteredActValidity(parsedDataGlobal,true); } catch { showNotification("Не вдалося перевірити акти. Запис скасовано.", "error"); return; }
      const currentData = parsedDataGlobal.map((row, index) => {
        const tr = document.querySelector(
          `#batch-table-Excel tbody tr:nth-child(${index + 1})`,
        );
        if (!tr) return row as any;

        // Читаємо значення по data-field атрибуту замість позиційного індексу
        const getField = (field: string): string =>
          (
            tr.querySelector(
              `[data-field="${field}"]`,
            ) as HTMLInputElement | null
          )?.value ?? "";
        const statusText =
          tr.querySelector(".status-text-Excel")?.textContent || row.status;

        return {
          date: getField("date"),
          shop: getField("shop"),
          catno: getField("catno"),
          detail: getField("detail"),
          qty: parseLocalizedNumber(getField("qty")),
          price: parseLocalizedNumber(getField("price")),
          clientPrice: parseLocalizedNumber(getField("clientPrice")),
          clientPriceManual:
            getField("clientPrice").trim() !== "" &&
            !!(row as any).clientPriceManual,
          warehouse: getField("warehouse"), // Номер складу
          invoice: getField("invoice"),
          actNo: getField("actNo"),
          unit: getField("unit"),
          orderStatus: getField("orderStatus"), // Статус деталі
          createdBy: getField("createdBy"), // Замовив
          notes: row._invoiceOrigin && !getField("notes").includes(row._invoiceOrigin)
            ? `${getField("notes")} ${row._invoiceOrigin}`.trim() : getField("notes"),
          _invoiceOrigin: row._invoiceOrigin,
          action: getField("action") || row.action || "Записати", // Дія з DOM або parsedDataGlobal
          _scladId: row._scladId || null, // sclad_id для UPDATE/DELETE
          _actSyncPending: !!row._actSyncPending,
          status: statusText,
          rowNumber: index + 1,
          warehouseValid: row.warehouseValid,
        };
      });

      const allSuccessful = currentData.every(
        (row) =>
          !row._actSyncPending && (row.status === "✅ Успішно" || row.status === "⏭️ Без змін" || isCompletedBatchDeletion(row)),
      );
      if (allSuccessful && currentData.length > 0) {
        showNotification("Дані успішно додані до бази даних", "success", 3000);
        return;
      }

      const pendingData = currentData.filter(row => !isCompletedBatchDeletion(row));

      // базові валідації
      let hasErrors = false;
      const invalidUnits = pendingData.filter(
        (row) =>
          !VALID_UNITS.includes(row.unit) && !row.status.includes("Помилка"),
      );
      if (invalidUnits.length > 0) {
        showNotification("❌ Невірно вказана одиниця виміру", "error", 4000);
        hasErrors = true;
        invalidUnits.forEach((row) => {
          const unitTd = document.querySelector(
            `#batch-table-Excel tbody tr:nth-child(${row.rowNumber}) td:has(.unit-input-Excel)`,
          ) as HTMLElement;
          if (unitTd) unitTd.classList.add("invalid-unit");
        });
      }

      // Перевірка складів
      const invalidWarehouses = pendingData.filter(
        (row) =>
          (!row.warehouse ||
            !row.warehouse.trim() ||
            !warehouseListCache.includes(row.warehouse.trim())) &&
          !row.status.includes("Помилка") &&
          row.action !== "Видалити",
      );
      if (invalidWarehouses.length > 0) {
        showNotification(
          "❌ Невірно вказаний або порожній склад",
          "error",
          4000,
        );
        hasErrors = true;
        invalidWarehouses.forEach((row) => {
          const warehouseTd = document.querySelector(
            `#batch-table-Excel tbody tr:nth-child(${row.rowNumber}) td:has(.warehouse-input-Excel)`,
          ) as HTMLElement;
          if (warehouseTd) warehouseTd.classList.add("invalid-warehouse");
        });
      }

      // Перевірка Рах. № (invoice) — обов'язкове поле
      const invalidInvoices = pendingData.filter(
        (row) =>
          (!row.invoice || !row.invoice.trim()) &&
          !row.status.includes("Помилка") &&
          row.action !== "Видалити",
      );
      if (invalidInvoices.length > 0) {
        showNotification("❌ Рах. № не може бути порожнім", "error", 4000);
        hasErrors = true;
        invalidInvoices.forEach((row) => {
          const invoiceTd = document.querySelector(
            `#batch-table-Excel tbody tr:nth-child(${row.rowNumber}) td:has(.invoice-input-Excel)`,
          ) as HTMLElement;
          if (invoiceTd) invoiceTd.classList.add("invalid-invoice");
        });
      }

      if (hasErrors) return;

      const validData = pendingData.filter((row) => {
        // Рядки з дією "Видалити" і наявним _scladId — завжди валідні для видалення
        if (row.action === "Видалити" && row._scladId) {
          return true;
        }
        // Для записів "Записати" — стандартна валідація
        return (
          !row.status.includes("Помилка") &&
          row.shop &&
          row.unit &&
          row.detail &&
          row.warehouse &&
          row.warehouseValid &&
          row.invoice &&
          row.invoice.trim()
        );
      });
      if (validData.length === 0) {
        showNotification(
          "Немає валідних даних для завантаження! Перевірте, чи заповнено магазин, деталь, одиницю виміру та склад.",
          "error",
        );
        return;
      }

      // Перевірка актів (список відкритих у кеші)
      let hasInvalidActs = false;
      let hasClosedActs = false;
      for (const row of validData) {
        if (row.actNo && row.actNo.trim()) {
          const trimmed = row.actNo.trim();
          if (!actsListCache.includes(trimmed)) {
            hasInvalidActs = true;
          } else {
            const id = parseInt(trimmed, 10);
            if (actsDateOffMap.has(id) && actsDateOffMap.get(id) !== null) {
              hasClosedActs = true;
            }
          }
        }
      }
      if (hasInvalidActs) {
        showNotification("Номер акту не створений", "error");
        return;
      }
      if (hasClosedActs) {
        showNotification(
          "Номер акту закритий і ми неможемо вписати деталь в даний акт",
          "error",
        );
        return;
      }

      const confirmed = await showConfirmModal(
        validData.length,
        currentData.length,
      );
      if (confirmed) {
        // Recheck recognized rows immediately before the existing save workflow.
        try {
          await assertInvoiceOriginsNotPresent(validData
            .filter((item: any) => item._invoiceOrigin && !item._scladId)
            .map((item: any) => String(item._invoiceOrigin)));
        } catch (error) { showNotification(error instanceof Error ? error.message : "Перевірка імпорту не вдалася", "error"); return; }
        await uploadBatchData(validData); // ⬅️ тепер захищено isUploading
      }
    };
  }
}
