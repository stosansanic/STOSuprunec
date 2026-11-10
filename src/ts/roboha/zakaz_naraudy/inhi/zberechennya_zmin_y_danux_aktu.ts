import { appConfirm } from "../../../utils/appDialogs";
import { prepareEditorRowReferences } from "../globalCache";
import { actQuantitySnapshot } from "../actQuantitySnapshot";
// ===== ФАЙЛ: src/ts/roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu_NEW.ts =====

import { supabase } from "../../../vxid/supabaseClient";
import { ActWriteConflict, countNamedActRows, stableActJson, readSavedActPayrollContext, type ActWriteReceipt, readEditorActForDelta, writeEditorActDelta } from "../../../utils/actSafeWrite";
import { commitPayrollSession, readPayrollRecoveryContext } from "../../../utils/payrollRecovery";
import { actEditorSignature, isActWritePending, markActEditorSaved, setActWritePending, setActEditorPayrollPending, trackActEditor } from "../../../utils/actEditorGuard";
import { assertValidActPayrollData } from "../../../utils/payrollValidation";
import { safeParseJSON } from "./ctvorennia_papku_googleDrive.";
import { logAction } from "../../../utils/auditLogger";
import { showNotification } from "./vspluvauhe_povidomlenna";
import {
  globalCache,
  ZAKAZ_NARAYD_BODY_ID,
  ZAKAZ_NARAYD_SAVE_BTN_ID,
  EDITABLE_PROBIG_ID,
  EDITABLE_REASON_ID,
  EDITABLE_RECOMMENDATIONS_ID,
  EDITABLE_NOTES_ID,
  ACT_ITEMS_TABLE_CONTAINER_ID,
  reloadSlyusarsOnly,
  invalidateEditorStockRows,
} from "../globalCache";
import type { ActItem } from "../globalCache";
import {
  updateCalculatedSumsInFooter,
  getSlyusarSalaryFromHistory,
} from "../modalUI";
import { refreshActRowInTable } from "../../tablucya/tablucya";
import { isActFrozen } from "../../../utils/actFrozenState";
import { refreshQtyWarningsIn } from "./kastomna_tabluca";
import { syncShopsOnActSave } from "./save_shops";
import { syncSlyusarsOnActSave } from "./save_work";
import { trackPayrollData, savePayrollData, fetchPayrollEmployees, payrollPercent, payrollInputKey, floorPayrollSalary, payrollNumber, assertPayrollHistory, PayrollWriteSession, payrollActorScope } from "../../../utils/payrollSafeWrite";
import { notifyActSaved } from "../actPresence";
import { enqueueActUpdate } from "../../offline/offlineSync";
import {
  userAccessLevel,
  userName,
  getSavedUserDataFromLocalStorage,
} from "../../tablucya/users";

/* =============================== ТИПИ І ІНТЕРФЕЙСИ =============================== */

interface DetailRow {
  shopName: string;
  sclad_id: number | null;
  Найменування: string;
  Каталог: string | null;
  Кількість: number;
  Ціна: number;
  recordId?: string; // ✅ Унікальний ID для точного пошуку
}

interface WorkRow {
  slyusarName: string;
  slyusar_id?: number | null;
  Найменування: string;
  Кількість: number;
  Ціна: number;
  Зарплата: number;
  recordId?: string; // ✅ Унікальний ID для точного пошуку
}

export interface SavedPayrollSnapshot {
  act_id: number;
  data: any;
  date_on: string | null;
  date_off: string | null;
  pruimalnyk: string | null;
  client_id: number | null;
  cars_id: number | null;
  checksum: string;
  revision: string | null;
}

interface ReceiverPayrollOptions {
  session?: PayrollWriteSession;
  snapshot?: SavedPayrollSnapshot;
  labels?: { pib: string; auto: string };
}

async function fetchPayrollEmployeesForAct(actId: number, session?: PayrollWriteSession,
  selector?: { id?: number; name?: string }): Promise<any[]> {
  return session ? session.fetchEmployees(selector) : fetchPayrollEmployees([actId], selector);
}

async function persistPayrollData(data: any, session?: PayrollWriteSession): Promise<void> {
  if (session) await session.save(data);
  else await savePayrollData(data);
}

function payrollErrorMessage(error: unknown): string {
  return typeof (error as any)?.message === "string" ? (error as any).message : String(error);
}

export interface ParsedItem {
  type: "detail" | "work";
  name: string;
  quantity: number;
  price: number;
  sum: number;
  pibMagazin: string;
  catalog: string;
  sclad_id: number | null;
  slyusar_id: number | null;
  slyusarSum?: number;
  recordId?: string; // ✅ Унікальний ID запису роботи для історії слюсаря
}

interface ActChangeRecord {
  act_id: number;
  item_name: string;
  cina: number;
  kilkist: number;
  zarplata: number;
  dodav_vudaluv: boolean;
  changed_by_surname: string;
  delit: boolean; // ✅ Додано для позначення видалених повідомлень
  data: string;
  pib?: string; // ✅ ПІБ клієнта з поточного акту
  auto?: string; // ✅ Дані автомобіля з поточного акту
  pruimalnyk?: string; // ✅ ПІБ приймальника з таблиці acts
}

// КЕШ: Зберігаємо ПОВНІ ДАНІ РЯДКІВ (для всіх ролей з прихованими колонками)
// Ключ: "type:name" (наприклад, "detail:Масляний фільтр")
const fullRowDataCache = new Map<string, ParsedItem>();
const saveContextByActId = new Map<number, any>();

// Keep the rendered baseline as well as the saved JSON. Legacy rows may acquire
// DOM record IDs or show an already saved salary from history when opened.
let unchangedActSaveBaseline: {
  actId: number;
  body: HTMLElement;
  dataSignature: string;
  inputSignature: string;
} | null = null;

function actSaveInputSignature(): string {
  const fields = [EDITABLE_PROBIG_ID, EDITABLE_REASON_ID, EDITABLE_RECOMMENDATIONS_ID,
    EDITABLE_NOTES_ID, "editable-avans", "editable-discount"].map(id => {
    const field = document.getElementById(id);
    const value = field && "value" in field
      ? String((field as HTMLInputElement).value)
      : field?.innerText ?? field?.textContent ?? "";
    return [id, value];
  });
  // Includes stock/employee/record IDs which the visual editor signature omits.
  return stableActJson({ fields, items: parseTableRows() });
}

function rememberUnchangedActBaseline(actId: number, data: any, body: HTMLElement): void {
  unchangedActSaveBaseline = {
    actId, body, dataSignature: stableActJson(data), inputSignature: actSaveInputSignature(),
  };
}

function canReuseUnchangedActBaseline(actId: number, data: any, body: HTMLElement): boolean {
  const baseline = unchangedActSaveBaseline;
  return baseline?.actId === actId && baseline.body === body &&
    baseline.dataSignature === stableActJson(data) &&
    baseline.inputSignature === actSaveInputSignature();
}

// КЕШ: Закупівельні ціни зі складу для обчислення маржі
const purchasePricesCache = new Map<number, number>();

// 🔒 Захист від подвійного збереження
let isSaving = false;

/* =============================== УТИЛІТИ =============================== */

/**
 * ✅ ВИПРАВЛЕНО: Отримує ПІБ клієнта та Авто з БАЗИ ДАНИХ за actId
 * Це гарантує коректні дані навіть якщо DOM застарів
 */
async function fetchActClientAndCarDataFromDB(actId: number): Promise<{
  pib: string;
  auto: string;
}> {
  try {
    const { data: act, error: actError } = await supabase
      .from("acts")
      .select("client_id, cars_id")
      .eq("act_id", actId)
      .single();

    if (actError || !act) {
      // console.warn("⚠️ Не вдалося отримати дані акту з БД:", actError?.message);
      // Fallback до DOM якщо БД недоступна
      return getClientAndCarInfo();
    }

    return await readSavedPayrollLabels(act);
  } catch (error) {
    // console.warn("⚠️ Помилка при отриманні даних клієнта з БД:", error);
    // Fallback до DOM
    return getClientAndCarInfo();
  }
}

/**
 * Завантажує закупівельні ціни зі складу для обчислення маржі
 */
async function loadPurchasePrices(ids: number[]): Promise<void> {
    const uniqueIds = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))];
    const prices = new Map<number, number>();
    for (let offset = 0; offset < uniqueIds.length; offset += 200) {
    const { data, error } = await supabase
      .from("sclad")
      .select("sclad_id, price")
      .in("sclad_id", uniqueIds.slice(offset, offset + 200));

    if (error) {
      throw new Error("Не вдалося перевірити закупівельні ціни. Повторіть збереження після відновлення з’єднання.");
    }

    data?.forEach((item) => {
      const scladId = Number(item.sclad_id);
      const price = Number(item.price);
      if (item.price != null && String(item.price).trim() !== "" && Number.isFinite(price)) {
        prices.set(scladId, price);
      }
    });
    }
    if (uniqueIds.some(id => !prices.has(id))) throw new Error("Для частини деталей відсутня закупівельна ціна. Перевірте склад перед збереженням.");
    purchasePricesCache.clear();
    prices.forEach((price, id) => purchasePricesCache.set(id, price));
}

/**
 * Отримує закупівельну ціну за sclad_id
 */
function getPurchasePrice(scladId: number | null): number | undefined {
  if (!scladId) return undefined;
  const price = purchasePricesCache.get(scladId);
  if (price === undefined) throw new Error("Для складської деталі відсутня підтверджена закупівельна ціна.");
  return price;
}

const cleanText = (s?: string | null): string =>
  (s ?? "").replace(/\u00A0/g, " ").trim();

const parseNum = (s?: string | null): number => {
  const v = cleanText(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
};

const getCellText = (el?: HTMLElement | null): string =>
  cleanText(el?.textContent);

/**
 * Отримує назву з комірки, перевіряючи спочатку атрибут data-full-name.
 * Якщо назва скорочена (є атрибут), повертає повну назву.
 */
const getNameCellText = (el?: HTMLElement | null): string => {
  if (!el) return "";
  // Перевіряємо чи є повна назва в атрибуті
  const fullName = el.getAttribute("data-full-name");
  if (fullName) return cleanText(fullName);
  // Інакше повертаємо текст з комірки
  return cleanText(el?.textContent);
};

/**
 * Зберігає ПОВНІ дані рядків у тимчасовий кеш.
 * Це потрібно для ВСІХ ролей з прихованими колонками (Слюсар, Приймальник, Складовщик, Запчастист).
 *
 * ✅ 10/10 FIX: Використовуємо recordId як ключ кешу для коректної обробки дублікатів.
 * Fallback на ${type}:${name} якщо recordId відсутній (для сумісності зі старими даними).
 */
export function cacheHiddenColumnsData(actDetails: any): void {
  fullRowDataCache.clear();

  const details = Array.isArray(actDetails?.["Деталі"])
    ? actDetails["Деталі"]
    : [];
  const works = Array.isArray(actDetails?.["Роботи"])
    ? actDetails["Роботи"]
    : [];

  // Кешуємо деталі
  details.forEach((d: any) => {
    const name = d["Деталь"]?.trim();
    if (!name) return;

    const recordId = d["recordId"];
    // ✅ Пріоритет: recordId, fallback на type:name
    const cacheKey = recordId || `detail:${name}`;
    fullRowDataCache.set(cacheKey, {
      type: "detail",
      name,
      price: Number(d["Ціна"]) || 0,
      sum: Number(d["Сума"]) || 0,
      catalog: d["Каталог"] || "",
      quantity: Number(d["Кількість"]) || 0,
      slyusarSum: 0,
      pibMagazin: d["Магазин"] || "",
      sclad_id: d["sclad_id"] || null,
      slyusar_id: null,
      recordId: recordId || undefined,
    });
  });

  // Кешуємо роботи
  works.forEach((w: any) => {
    const name = w["Робота"]?.trim();
    if (!name) return;

    const recordId = w["recordId"];
    // ✅ Пріоритет: recordId, fallback на type:name
    const cacheKey = recordId || `work:${name}`;
    fullRowDataCache.set(cacheKey, {
      type: "work",
      name,
      price: Number(w["Ціна"]) || 0,
      sum: Number(w["Сума"]) || 0,
      catalog: w["Каталог"] || "",
      quantity: Number(w["Кількість"]) || 0,
      slyusarSum: Number(w["Зарплата"]) || 0,
      pibMagazin: w["Слюсар"] || "",
      sclad_id: null,
      slyusar_id: w["slyusar_id"] || null,
      recordId: recordId || undefined,
    });
  });
}

/* =============================== РОБОТА З ТАБЛИЦЕЮ =============================== */

function readTableNewNumbers(): Map<number, number> {
  const tableRows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr`,
  );
  const numberMap = new Map<number, number>();

  tableRows.forEach((row) => {
    const nameCell = row.querySelector(
      '[data-name="name"]',
    ) as HTMLElement | null;
    if (!nameCell?.textContent?.trim()) return;

    const catalogCell = row.querySelector(
      '[data-name="catalog"]',
    ) as HTMLElement | null;
    const qtyCell = row.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    const scladIdAttr = catalogCell?.getAttribute("data-sclad-id");

    if (!scladIdAttr) return;

    const sclad_id = Number(scladIdAttr);
    const qty = parseNum(qtyCell?.textContent);

    if (!isNaN(sclad_id)) {
      numberMap.set(sclad_id, (numberMap.get(sclad_id) || 0) + qty);
    }
  });

  return numberMap;
}

export function parseTableRows(): ParsedItem[] {
  const tableRows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr:not(.deleted-item-row):not([data-notification-only])`,
  );
  const items: ParsedItem[] = [];
  const seenRecordIds = new Set<string>();

  tableRows.forEach((row: Element) => {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    // Використовуємо getNameCellText для отримання повної назви
    const name = getNameCellText(nameCell);
    if (!name) return;

    // ✅ НАДІЙНЕ ВИЗНАЧЕННЯ ТИПУ (3 рівні пріоритету):
    // 1. data-item-type на <tr> — встановлюється при рендері/виборі (100% надійно)
    // 2. data-type на комірці name — встановлюється при виборі з автодоповнення
    // 3. globalCache.works — fallback для старих даних
    const rowItemType = (row as HTMLElement).getAttribute("data-item-type");
    const typeFromCell = nameCell.getAttribute("data-type");
    let type: "work" | "detail";
    if (rowItemType === "work") {
      type = "work";
    } else if (rowItemType === "detail") {
      type = "detail";
    } else if (typeFromCell === "works") {
      type = "work";
    } else if (typeFromCell === "details") {
      type = "detail";
    } else {
      // Fallback для старих рядків без атрибутів
      type = globalCache.works.includes(name) ? "work" : "detail";
    }

    // ✅ 10/10 FIX: Зчитуємо recordId СПОЧАТКУ (для коректного отримання з кешу)
    // Кожен DOM-рядок повинен мати стабільний ID ще ДО merge/save. Раніше ID
    // генерувався лише всередині processItems, не повертався в DOM і на
    // наступному збереженні змінювався. На великих актах це призводило до
    // нестабільного об'єднання, дублювання або зникнення щойно доданого рядка.
    let recordId =
      (row as HTMLElement).getAttribute("data-record-id") || undefined;
    if (!recordId || seenRecordIds.has(recordId)) {
      const uniquePart =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      recordId = `${type}_${uniquePart}`;
      (row as HTMLElement).setAttribute("data-record-id", recordId);
    }
    seenRecordIds.add(recordId);

    // ✅ 10/10 FIX: Створюємо ключ для кешу з пріоритетом recordId
    // Це вирішує проблему дублікатів (дві однакові роботи з різними параметрами)
    const cacheKey = recordId || `${type}:${name}`;
    let cachedData = fullRowDataCache.get(cacheKey);

    // ✅ Fallback: якщо не знайдено по recordId, шукаємо по type:name
    if (!cachedData && recordId) {
      cachedData = fullRowDataCache.get(`${type}:${name}`);
    }

    // Отримуємо посилання на всі комірки
    const quantityCell = row.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement;
    const priceCell = row.querySelector('[data-name="price"]') as HTMLElement;
    const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
    const pibMagazinCell = row.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement;
    const catalogCell = row.querySelector(
      '[data-name="catalog"]',
    ) as HTMLElement;
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement;

    // 1. Кількість завжди беремо з DOM (користувач міг її змінити)
    const quantity = parseNum(quantityCell?.textContent);

    // 2. Перевіряємо видимість колонок та беремо дані
    let price = 0;
    let sum = 0;
    let pibMagazin = "";
    let catalog = "";
    let slyusarSum = 0;

    // ✅ ВИПРАВЛЕНО: Ціна завжди береться з DOM (незалежно від видимості колонки)
    // Причина: При додаванні нової роботи вона ще не в кеші, а ціна вже є в DOM
    if (priceCell) {
      price = parseNum(priceCell.textContent);
    } else if (cachedData) {
      price = cachedData.price;
    }

    // ✅ ВИПРАВЛЕНО: Сума завжди береться з DOM (незалежно від видимості колонки)
    // Причина: При додаванні нової роботи вона ще не в кеші, а сума вже є в DOM
    if (sumCell) {
      sum = parseNum(sumCell.textContent);
    } else if (cachedData) {
      sum = cachedData.sum;
    }

    // ✅ ВИПРАВЛЕНО: ПІБ_Магазин завжди береться з DOM (незалежно від видимості)
    // Причина: При зміні слюсаря/магазину дані мають оновлюватися
    if (pibMagazinCell) {
      pibMagazin = getCellText(pibMagazinCell);
    } else if (cachedData) {
      pibMagazin = cachedData.pibMagazin;
    }

    // ✅ ВИПРАВЛЕНО: Каталог завжди береться з DOM (незалежно від видимості)
    // Причина: При зміні каталогу дані мають оновлюватися
    if (catalogCell) {
      catalog = getCellText(catalogCell);
    } else if (cachedData) {
      catalog = cachedData.catalog;
    }

    // Зарплата зі збереженого акту (включно з явним 0) має пріоритет.
    // Для старих актів без поля "Зарплата" допускаємо fallback до історії,
    // але порожня прихована комірка більше не означає автоматично 0.
    if (type === "work" && pibMagazin && globalCache.currentActId) {
      const hasPersistedSalary =
        (row as HTMLElement).getAttribute("data-salary-persisted") === "true";
      const rawSalaryText = slyusarSumCell?.textContent || "";
      if (slyusarSumCell && (hasPersistedSalary || rawSalaryText.trim())) {
        slyusarSum = parseNum(rawSalaryText);
      } else {
        const historySalary = getSlyusarSalaryFromHistory(
          pibMagazin,
          name,
          globalCache.currentActId,
          undefined,
          recordId,
        );

        if (historySalary !== null) {
          slyusarSum = historySalary;
        } else if (cachedData) {
          slyusarSum = cachedData.slyusarSum || 0;
        }
      }
    } else {
      // Для деталей або якщо немає слюсаря - беремо з DOM як раніше
      if (slyusarSumCell) {
        const rawSalaryText = slyusarSumCell.textContent;
        slyusarSum = parseNum(rawSalaryText);
      } else if (cachedData) {
        slyusarSum = cachedData.slyusarSum || 0;
      }
    }

    const scladIdAttr = catalogCell?.getAttribute("data-sclad-id");
    const sclad_id = scladIdAttr ? Number(scladIdAttr) : null;
    const slyusar_id = nameCell.getAttribute("data-slyusar-id")
      ? Number(nameCell.getAttribute("data-slyusar-id"))
      : null;

    const item: ParsedItem = {
      type,
      name,
      quantity,
      price,
      sum,
      pibMagazin,
      catalog,
      sclad_id,
      slyusar_id,
      slyusarSum,
      recordId, // ✅ Додаємо recordId до item
    };

    items.push(item);

    // Оновлюємо кеш актуальними даними
    fullRowDataCache.set(cacheKey, item);
  });

  return items;
}

function processItems(items: ParsedItem[]) {
  const details: any[] = [];
  const works: any[] = [];
  const detailRowsForShops: DetailRow[] = [];
  const workRowsForSlyusars: WorkRow[] = [];

  let totalDetailsSum = 0;
  let totalWorksSum = 0;
  let totalWorksProfit = 0;
  let totalDetailsMargin = 0;

  items.forEach((item) => {
    const {
      type,
      name,
      quantity,
      price,
      sum,
      pibMagazin,
      catalog,
      sclad_id,
      slyusar_id,
      slyusarSum,
      recordId, // ✅ Додаємо recordId
    } = item;

    const itemBase = { Кількість: quantity, Ціна: price, Сума: sum };

    if (type === "work") {
      const salary = floorPayrollSalary(Number(slyusarSum || 0));
      const profit = Math.max(0, Number((sum - salary).toFixed(2)));

      // ✅ КРИТИЧНО: Якщо recordId немає - генеруємо новий
      // Це потрібно для нових рядків, які ще не мають recordId
      const workRecordId =
        recordId ||
        `new_${name.substring(0, 20)}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // ✅ Шукаємо work_id в глобальному кеші за ім'ям роботи
      const workObj = globalCache.worksWithId.find((w) => w.name === name);
      const work_id = catalog || (workObj ? workObj.work_id : null);

      works.push({
        ...itemBase,
        Робота: name,
        Слюсар: pibMagazin,
        Каталог: catalog,
        slyusar_id,
        Зарплата: salary,
        Прибуток: profit,
        recordId: workRecordId, // ✅ Завжди є recordId
        work_id, // ✅ Зберігаємо work_id в акт
      });

      totalWorksSum += sum;
      totalWorksProfit += profit;

      if (pibMagazin) {
        const workRow: WorkRow = {
          slyusarName: pibMagazin,
          Найменування: name,
          Кількість: quantity,
          Ціна: price,
          Зарплата: salary,
          recordId: workRecordId, // ✅ Передаємо recordId для точного пошуку
        };

        workRowsForSlyusars.push(workRow);
      }
    } else {
      // Обчислюємо маржу для деталі
      const purchasePrice = getPurchasePrice(sclad_id) ?? 0; // Нуль допустимий лише для ручної деталі без складського ID.
      const margin = (price - purchasePrice) * quantity; // ✅ Рахуємо маржу навіть якщо purchasePrice = 0

      totalDetailsMargin += margin;

      // ✅ Шукаємо detail_id в глобальному кеші для деталей не зі складу
      let detail_id = null;
      if (!sclad_id) {
        const detailObj = globalCache.detailsWithId.find(
          (d) => d.name === name,
        );
        if (detailObj) detail_id = detailObj.detail_id;
      }

      const detailRecordId =
        recordId ||
        `new_detail_${name.substring(0, 20)}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      details.push({
        ...itemBase,
        Деталь: name,
        Магазин: pibMagazin,
        Каталог: catalog,
        sclad_id,
        detail_id, // ✅ Зберігаємо detail_id в акт
        recordId: detailRecordId, // ✅ Додаємо recordId для acts
      });
      totalDetailsSum += sum;

      if (pibMagazin) {
        detailRowsForShops.push({
          shopName: pibMagazin,
          sclad_id,
          Найменування: name,
          Каталог: catalog || null,
          Кількість: quantity,
          Ціна: price,
          recordId: detailRecordId, // ✅ Передаємо recordId для історії магазину
        });
      }
    }
  });

  return {
    details,
    works,
    detailRowsForShops,
    workRowsForSlyusars,
    totalDetailsSum,
    totalWorksSum,
    grandTotalSum: totalDetailsSum + totalWorksSum,
    totalWorksProfit,
    totalDetailsMargin,
  };
}

function buildShopRowsFromDetails(details: any[]): DetailRow[] {
  return details
    .filter((detail) => detail?.Магазин)
    .map((detail) => ({
      shopName: detail.Магазин,
      sclad_id: detail.sclad_id ?? null,
      Найменування: detail.Деталь || "",
      Каталог: detail.Каталог || null,
      Кількість: Number(detail.Кількість) || 0,
      Ціна: Number(detail.Ціна) || 0,
      recordId: detail.recordId,
    }));
}

function recalculateMergedTotals(details: any[], works: any[]) {
  let totalDetailsSum = 0;
  let totalWorksSum = 0;
  let totalWorksProfit = 0;
  let totalDetailsMargin = 0;

  for (const detail of details) {
    const qty = Number(detail?.Кількість) || 0;
    const price = Number(detail?.Ціна) || 0;
    const sum = Number(detail?.Сума) || qty * price;
    const purchasePrice = getPurchasePrice(detail?.sclad_id ?? null) || 0;
    totalDetailsSum += sum;
    totalDetailsMargin += (price - purchasePrice) * qty;
  }

  for (const work of works) {
    const qty = Number(work?.Кількість) || 0;
    const price = Number(work?.Ціна) || 0;
    const sum = Number(work?.Сума) || qty * price;
    const salary = Number(work?.Зарплата) || 0;
    totalWorksSum += sum;
    totalWorksProfit += Math.max(0, Number((sum - salary).toFixed(2)));
  }

  return {
    totalDetailsSum,
    totalWorksSum,
    grandTotalSum: totalDetailsSum + totalWorksSum,
    totalWorksProfit,
    totalDetailsMargin,
  };
}

function assertRowsPersisted(
  expectedRows: any[],
  savedRows: any[],
  kind: "detail" | "work",
): void {
  const label = kind === "detail" ? "деталей" : "робіт";
  if (savedRows.length !== expectedRows.length) {
    throw new Error(
      `База повернула неповний акт: очікувалось ${expectedRows.length} ${label}, збережено ${savedRows.length}`,
    );
  }

  const savedByRecordId = new Map<string, any>();
  for (const row of savedRows) {
    const recordId = String(row?.recordId || "").trim();
    if (!recordId) {
      throw new Error(`База повернула рядок (${label}) без унікального ID`);
    }
    if (savedByRecordId.has(recordId)) {
      throw new Error(`База повернула дубль ID у списку ${label}`);
    }
    savedByRecordId.set(recordId, row);
  }

  const fields =
    kind === "detail"
      ? ["Деталь", "Магазин", "Каталог", "sclad_id", "Кількість", "Ціна", "Сума"]
      : ["Робота", "Слюсар", "Каталог", "slyusar_id", "Кількість", "Ціна", "Сума", "Зарплата"];

  const expectedRecordIds = new Set<string>();
  for (const expected of expectedRows) {
    const recordId = String(expected?.recordId || "").trim();
    if (recordId && expectedRecordIds.has(recordId)) {
      throw new Error(`Перед збереженням знайдено дубль ID у списку ${label}`);
    }
    if (recordId) expectedRecordIds.add(recordId);
    const saved = savedByRecordId.get(recordId);
    if (!recordId || !saved) {
      throw new Error(
        `База не зберегла один із рядків (${label}): ${expected?.Деталь || expected?.Робота || "без назви"}`,
      );
    }

    for (const field of fields) {
      const expectedValue = expected?.[field];
      const savedValue = saved?.[field];
      const bothNumeric =
        typeof expectedValue === "number" && typeof savedValue === "number";
      const equal = bothNumeric
        ? expectedValue === savedValue
        : String(expectedValue ?? "").trim() === String(savedValue ?? "").trim();
      if (!equal) {
        throw new Error(
          `База повернула інше значення для рядка «${expected?.Деталь || expected?.Робота || "без назви"}» (${field})`,
        );
      }
    }
  }
}

async function cleanupEmptyRows(): Promise<void> {
  document
    .querySelectorAll(`#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr:not(.deleted-item-row):not([data-notification-only])`)
    .forEach((row) => {
      const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
      if (!nameCell?.textContent?.trim()) {
        row.remove();
      }
    });
}

/* =============================== ЛОГУВАННЯ ЗМІН (НОВИЙ КОД) =============================== */

/**
 * Конвертує ActItem[] (з globalCache) в ParsedItem[] для порівняння
 */
function convertActItemsToParsedItems(items: ActItem[]): ParsedItem[] {
  return items.map((item) => ({
    type: item.type,
    name: item.name,
    quantity: item.quantity,
    price: item.price,
    sum: item.sum,
    pibMagazin: item.person_or_store || "",
    catalog: item.catalog || "",
    sclad_id: item.sclad_id ?? null,
    slyusar_id: item.slyusar_id ?? null,
    slyusarSum: item.slyusarSum || 0, // ✅ Використовуємо slyusarSum з ActItem
    recordId: item.recordId,
  }));
}

/**
 * Порівнює початкові та поточні елементи акту і повертає додані та видалені позиції
 */
function compareActChanges(
  initialItems: ActItem[],
  currentItems: ParsedItem[],
): { added: ParsedItem[]; deleted: ParsedItem[] } {
  // Конвертуємо ActItem[] в ParsedItem[] для порівняння
  const initialParsed = convertActItemsToParsedItems(initialItems);

  // Створюємо унікальний ключ для кожної позиції (тип + назва)
  const createKey = (item: ParsedItem) => `${item.type}:${item.name}`;

  // Count occurrences: adding/removing a second identically named work is
  // still an actual change and must notify the receiver exactly once.
  const subtract = (source: ParsedItem[], baseline: ParsedItem[]) => {
    const remaining = new Map<string, number>();
    baseline.forEach(item => remaining.set(createKey(item), (remaining.get(createKey(item)) || 0) + 1));
    return source.filter(item => {
      const key = createKey(item), count = remaining.get(key) || 0;
      if (count === 0) return true;
      remaining.set(key, count - 1);
      return false;
    });
  };
  const added = subtract(currentItems, initialParsed);
  const deleted = subtract(initialParsed, currentItems);

  return { added, deleted };
}

/**
 * Записує зміни в таблицю act_changes_notifications
 * ЛОГІКА:
 * - Записуємо ТІЛЬКИ якщо це Слюсар, Запчастист, Складовщик
 * - НЕ записуємо якщо це Приймальник або Адміністратор
 * - Зберігаємо pruimalnyk з таблиці acts для фільтрації повідомлень
 */
async function logActChanges(
  actId: number,
  added: ParsedItem[],
  deleted: ParsedItem[],
  context: { pruimalnyk: string | null; labels?: { pib: string; auto: string } },
): Promise<void> {
  // An unchanged row list must not fetch the act/client/car just to discover
  // there is nothing to notify. Notes/price edits keep their separate audit.
  if (added.length === 0 && deleted.length === 0) return;
  // ✅ Записуємо зміни ТІЛЬКИ для Слюсаря, Запчастиста, Складовщика
  const allowedRoles = ["Слюсар", "Запчастист", "Складовщик"];
  if (!userAccessLevel || !allowedRoles.includes(userAccessLevel)) {
    return;
  }

  // ✅ ФУНКЦІЯ ВИЗНАЧЕННЯ АВТОРА ЗМІН
  const getChangeAuthor = (item: ParsedItem): string => {
    const currentUser = userName || "Невідомо";

    // 1. Якщо це ДЕТАЛЬ -> повертаємо того, хто зайшов (userName)
    if (item.type === "detail") {
      return currentUser;
    }

    // 2. Якщо це РОБОТА -> перевіряємо ПІБ_Магазин (це буде слюсар)
    if (item.type === "work") {
      const workerName = item.pibMagazin ? item.pibMagazin.trim() : "";
      // Якщо є ім'я слюсаря - беремо його, інакше - того, хто зайшов
      return workerName || currentUser;
    }

    // Fallback (на всяк випадок)
    return currentUser;
  };

  // ✅ ВИПРАВЛЕНО: Отримуємо ПІБ клієнта та авто з БАЗИ ДАНИХ
  const { pib, auto } = context.labels || await fetchActClientAndCarDataFromDB(actId);

  // ✅ ВИКОРИСТОВУЄМО ПРИЙМАЛЬНИКА З БД (отриманого вище)
  const pruimalnyk = context.pruimalnyk || undefined;

  const records: ActChangeRecord[] = [];

  // Додані позиції
  // Додані позиції (рядок 598-608)
  added.forEach((item) => {
    records.push({
      act_id: actId,
      item_name: item.name,
      cina: item.price,
      kilkist: item.quantity,
      zarplata: item.slyusarSum || 0,
      dodav_vudaluv: true,
      changed_by_surname: getChangeAuthor(item),
      delit: false, // ✅ За замовчуванням FALSE = показувати
      data: new Date().toISOString(),
      pib: pib || undefined, // ✅ ПІБ клієнта
      auto: auto || undefined, // ✅ Дані автомобіля
      pruimalnyk: pruimalnyk, // ✅ ПІБ приймальника з acts.pruimalnyk
    });
  });

  // Видалені позиції (рядок 611-621)
  deleted.forEach((item) => {
    records.push({
      act_id: actId,
      item_name: item.name,
      cina: item.price,
      kilkist: item.quantity,
      zarplata: item.slyusarSum || 0,
      dodav_vudaluv: false,
      changed_by_surname: getChangeAuthor(item),
      delit: false, // ✅ За замовчуванням FALSE = показувати
      data: new Date().toISOString(),
      pib: pib || undefined, // ✅ ПІБ клієнта
      auto: auto || undefined, // ✅ Дані автомобіля
      pruimalnyk: pruimalnyk, // ✅ ПІБ приймальника з acts
    });
  });

  if (records.length === 0) {
    return;
  }

  // Запис в БД
  const { error } = await supabase
    .from("act_changes_notifications")
    .insert(records);

  if (error) {
    // console.error("❌ ПОМИЛКА ЗАПИСУ ЗМІН:", error);
    throw error;
  }
}

/**
 * Отримує ПІБ клієнта та Авто з DOM
 */
function getClientAndCarInfo(): { pib: string; auto: string } {
  let pib = "";
  let auto = "";

  const leftTable = document.querySelector("table.zakaz_narayd-table.left");
  if (leftTable) {
    const rows = leftTable.querySelectorAll("tr");
    rows.forEach((row) => {
      const label = row.querySelector("td:first-child")?.textContent?.trim();
      const value = row.querySelector("td:last-child")?.textContent?.trim();
      if (label === "Клієнт" && value) pib = value;
    });
  }

  const rightTable = document.querySelector("table.zakaz_narayd-table.right");
  if (rightTable) {
    const rows = rightTable.querySelectorAll("tr");
    rows.forEach((row) => {
      const label = row.querySelector("td:first-child")?.textContent?.trim();
      const value = row.querySelector("td:last-child")?.textContent?.trim();
      if (label === "Автомобіль" && value) auto = value;
    });
  }
  return { pib, auto };
}

/**
 * ✅ НОВА ФУНКЦІЯ: Повна синхронізація історії ВСІХ Запчастистів для акту
 *
 * Логіка:
 * 1. Отримуємо ВСІХ користувачів з роллю "Запчастист"
 * 2. Для кожного перевіряємо: чи є в акті деталі де xto_zamovuv = його slyusar_id
 * 3. Якщо є: оновлюємо/створюємо запис акту в історії
 * 4. Якщо немає: ВИДАЛЯЄМО запис акту з історії (якщо був)
 *
 * Це гарантує коректну синхронізацію при:
 * - Видаленні деталей з акту
 * - Зміні xto_zamovuv в базі sclad
 * - Переміщенні деталей між актами
 *
 * ⚠️ БЕЗПЕКА: Функція працює ТІЛЬКИ з роллю "Запчастист", не чіпає інші ролі
 */
async function syncAllZapchastystyHistoryForAct(
  actId: number,
  partsList: Array<{
    scladId: number | null;
    qty: number;
    sale: number;
    buyPrice: number;
    xtoZamovuv: number | null;
  }>,
  scladToScladNomeMap: Map<number, number>,
  discountMultiplier: number,
  actDateOn: string | null,
  pib: string,
  auto: string,
  inputKey: string,
  unchangedInput: boolean,
  options: ReceiverPayrollOptions = {},
): Promise<number> {
  // Групуємо деталі по xto_zamovuv (хто оприходував)
  const partsGroupedByOwner = new Map<number, Array<(typeof partsList)[0]>>();

  for (const part of partsList) {
    if (part.xtoZamovuv && part.xtoZamovuv > 0) {
      const existing = partsGroupedByOwner.get(part.xtoZamovuv) || [];
      existing.push(part);
      partsGroupedByOwner.set(part.xtoZamovuv, existing);
    }
  }

  // Отримуємо ВСІХ Запчастистів з бази
  const allZapchastysty = await fetchPayrollEmployeesForAct(actId, options.session);

  if (!allZapchastysty || allZapchastysty.length === 0) {
    return 0;
  }

  const actDate = actDateOn
    ? actDateOn.split("T")[0]
    : new Date().toISOString().split("T")[0];

  let totalZapchastystySalary = 0;

  // Обробляємо КОЖНОГО користувача
  for (const zapchastyst of allZapchastysty) {
    const zData = trackPayrollData(zapchastyst.slyusar_id, zapchastyst.data);

    // ✅ БЕЗПЕКА: Працюємо ТІЛЬКИ з Запчастистами
    if (zData.Доступ !== "Запчастист") {
      continue;
    }

    const zSlyusarId = zapchastyst.slyusar_id;
    const zSklad = Number(zData.Склад) || 0;

    // Перевіряємо: чи є деталі в акті де xto_zamovuv = цей Запчастист
    const hisParts = partsGroupedByOwner.get(zSlyusarId) || [];
    const hasPartsInAct = hisParts.length > 0;

    // Рахуємо маржу для цього Запчастиста (БЕЗ деталей з його складу)
    let marginForSalary = 0;
    for (const part of hisParts) {
      // Перевіряємо чи склад деталі ≠ склад Запчастиста
      const detailSklad = part.scladId
        ? scladToScladNomeMap.get(part.scladId)
        : undefined;
      const shouldCount = detailSklad === undefined || detailSklad !== zSklad;

      if (shouldCount) {
        const partMargin =
          part.sale * discountMultiplier - part.buyPrice * part.qty;
        marginForSalary += partMargin;
      }
    }

    // Отримуємо поточну історію
    let zHistory = zData.Історія || {};
    let zActFound = false;
    let zFoundDateKey = "";
    let zFoundIndex = -1;

    // Шукаємо існуючий запис акту в історії
    for (const dateKey of Object.keys(zHistory)) {
      const dailyActs = zHistory[dateKey];
      if (Array.isArray(dailyActs)) {
        const idx = dailyActs.findIndex(
          (item: any) => String(item.Акт) === String(actId),
        );
        if (idx !== -1) {
          zActFound = true;
          zFoundDateKey = dateKey;
          zFoundIndex = idx;
          break;
        }
      }
    }

    let needsUpdate = false;

    // Reopening/viewing or saving unrelated notes must not reprice old payroll.
    const previous = zActFound ? zHistory[zFoundDateKey][zFoundIndex] : null;
    // A later stock-owner change must not create a second salary for an
    // unchanged, already synchronized act. Recovery is enabled by pending.
    if (!previous && unchangedInput) continue;
    if (previous && (previous.__payroll_input === inputKey || (!previous.__payroll_input && unchangedInput))) {
      totalZapchastystySalary += Number(previous.ЗарплатаЗапчастин) || 0;
      previous.__payroll_input = inputKey;
      if (options.snapshot) previous.ДатаЗакриття = options.snapshot.date_off?.split("T")[0] ?? null;
      await persistPayrollData(zData, options.session);
      continue;
    }

    if (hasPartsInAct) {
      const zPercent = payrollNumber(zData.ПроцентЗапчастин);
      const zSalary = payrollPercent(marginForSalary, zPercent);
      // ✅ Є деталі в акті → оновлюємо/створюємо запис
      totalZapchastystySalary += zSalary;

      const zActRecord = {
        Акт: String(actId),
        Клієнт: pib,
        Автомобіль: auto,
        СуммаЗапчастин: Math.round(marginForSalary * 100) / 100,
        ЗарплатаЗапчастин: zSalary,
        ДатаЗакриття: options.snapshot ? options.snapshot.date_off?.split("T")[0] ?? null : previous?.ДатаЗакриття ?? null,
        __payroll_input: inputKey,
        __payroll_percent: zPercent,
      };

      if (zActFound) {
        // Оновлюємо існуючий запис
        const oldRecord = zHistory[zFoundDateKey][zFoundIndex];
        zHistory[zFoundDateKey][zFoundIndex] = { ...oldRecord, ...zActRecord };
        needsUpdate = true;
        // console.log(
        // `📝 Оновлено історію Запчастиста "${zData.Name}" для акту ${actId}: маржа=${marginForSalary.toFixed(2)}, ЗП=${zSalary}`,
        // );
      } else {
        // Створюємо новий запис
        if (!zHistory[actDate]) {
          zHistory[actDate] = [];
        }
        zHistory[actDate].push(zActRecord);
        needsUpdate = true;
        // console.log(
        // `➕ Додано запис в історію Запчастиста "${zData.Name}" для акту ${actId}: маржа=${marginForSalary.toFixed(2)}, ЗП=${zSalary}`,
        // );
      }
    } else {
      // ❌ Немає деталей в акті → видаляємо запис (якщо був)
      if (zActFound) {
        zHistory[zFoundDateKey].splice(zFoundIndex, 1);

        // Якщо масив порожній, видаляємо дату
        if (zHistory[zFoundDateKey].length === 0) {
          delete zHistory[zFoundDateKey];
        }

        needsUpdate = true;
        // console.log(
        // `🗑️ Видалено акт ${actId} з історії Запчастиста "${zData.Name}" (деталей більше немає)`,
        // );
      }
    }

    // Зберігаємо оновлену історію в БД
    if (needsUpdate) {
      zData.Історія = zHistory;

      await persistPayrollData(zData, options.session);
    }
  }

  return totalZapchastystySalary;
}

/**
 * Синхронізує історію акту для Приймальника та Запчастистів
 * ✅ ОНОВЛЕНА ЛОГІКА: Працює однаково для ВСІХ ролей (Адміністратор, Приймальник, Слюсар, Запчастист, Складовщик)
 * - Завжди шукає приймальника з acts.pruimalnyk
 * - Оновлює історію приймальника
 * - Оновлює історію всіх Запчастистів
 */
async function syncPruimalnikHistory(
  actId: number,
  _totalWorksSumIgnored: number,
  _totalDetailsSumIgnored: number,
  actDateOn: string | null = null,
  discountPercent: number = 0,
  savedActData?: any,
  previousActData?: any,
  savedReceipt?: ActWriteReceipt,
  lockOwner?: string,
  options: ReceiverPayrollOptions = {},
): Promise<void> {
  // ✅ Визначаємо ПІБ приймальника - ЗАВЖДИ з acts.pruimalnyk для всіх ролей
  let pruimalnykName: string;

  // Шукаємо приймальника з acts.pruimalnyk
  const { data: actData, error: actError } = options.snapshot
    ? { data: options.snapshot, error: null }
    : savedReceipt
      ? { data: { ...await readSavedActPayrollContext(savedReceipt, lockOwner || ""), data: savedActData }, error: null }
      : await supabase.from("acts").select("pruimalnyk, data, date_off").eq("act_id", actId).single();

  if (actError || !actData) throw actError || new Error("Не вдалося прочитати приймальника акта");
  if (savedActData && (stableActJson(safeParseJSON(actData.data)) !== stableActJson(savedActData) || (!options.snapshot && isActFrozen(actData)))) {
    throw new Error("Акт змінився під час синхронізації зарплати. Повторіть збереження актуальних даних.");
  }
  if (!actData.pruimalnyk) {
    // console.warn(
    // `⚠️ syncPruimalnikHistory: Не вдалося отримати pruimalnyk для акту №${actId}. Історія приймальника НЕ оновлюється, але історія Запчастистів буде оновлена.`,
    // );
    // ✅ НЕ виходимо! Продовжуємо для оновлення історії Запчастистів
    pruimalnykName = "";
  } else {
    pruimalnykName = String(actData.pruimalnyk).trim();
  }
  if (!pruimalnykName && ((savedActData?.Роботи || []).some((row: any) => row.Робота) || (savedActData?.Деталі || []).some((row: any) => row.Деталь))) {
    throw new Error("В акті не призначено приймальника. Нарахування не завершено.");
  }

  // Змінні для приймальника (можуть бути undefined якщо немає приймальника)
  let userData: any = null;
  let slyusarData: any = null;
  let pruimalnykSklad = 0;
  let percentWork = 0;
  let percentParts = 0;

  // --- ОТРИМАННЯ ДАНИХ ПРИЙМАЛЬНИКА З БД (якщо є приймальник) ---
  if (pruimalnykName) {
    const userDataArray = await fetchPayrollEmployeesForAct(actId, options.session, {name:pruimalnykName});
    if (!userDataArray || userDataArray.length !== 1) {
      // console.warn(
      // `⚠️ syncPruimalnikHistory: Приймальник "${pruimalnykName}" не знайдений в БД. Історія Запчастистів все одно буде оновлена.`,
      // );
      throw new Error(`Приймальника «${pruimalnykName}» не знайдено однозначно.`);
    } else {
      userData = userDataArray[0];
      slyusarData = trackPayrollData(userData.slyusar_id, userData.data);

      // Додаткова перевірка ролі в базі - дозволяємо Приймальник та Адміністратор
      if (
        slyusarData.Доступ !== "Приймальник" &&
        slyusarData.Доступ !== "Адміністратор"
      ) {
        // console.warn(
        // "⚠️ syncPruimalnikHistory: Користувач не є Приймальником/Адміністратором в базі. Історія Запчастистів все одно буде оновлена.",
        // );
        throw new Error(`Працівник «${pruimalnykName}» не має ролі приймальника або адміністратора.`);
      } else {
        // Склад приймальника для порівняння
        pruimalnykSklad = Number(slyusarData.Склад) || 0;
        percentWork = payrollNumber(slyusarData.ПроцентРоботи);
        percentParts = payrollNumber(slyusarData.ПроцентЗапчастин);
      }
    }
  }

  // Use the confirmed saved act, never a modal that may now show another act.
  if (!savedActData || !Array.isArray(savedActData.Роботи) || !Array.isArray(savedActData.Деталі)) {
    throw new Error("Немає підтверджених позицій акта для розрахунку зарплати.");
  }
  const financialInput = (data: any) => ({
    receiver: pruimalnykName,
    discount: Number(data?.Знижка) || 0,
    works: (data?.Роботи || []).filter((w: any) => w.Робота).map((w: any) =>
      [w.recordId, w.slyusar_id, w.Слюсар, w.Кількість, w.Ціна, w.Сума, w.Зарплата]),
    parts: (data?.Деталі || []).filter((p: any) => p.Деталь).map((p: any) =>
      [p.recordId, p.sclad_id, p.Кількість, p.Ціна, p.Сума]),
  });
  const inputKey = payrollInputKey(financialInput(savedActData));
  const unchangedInput = previousActData != null && !previousActData.__payroll_pending &&
    inputKey === payrollInputKey(financialInput(previousActData));

  let worksTotalSale = 0;
  let worksTotalSlusarSalary = 0;

  let partsTotalSale = 0;
  // Масив для деталей: { scladId, qty, sale, buyPrice, xtoZamovuv }
  const partsList: {
    scladId: number | null;
    qty: number;
    sale: number;
    buyPrice: number;
    xtoZamovuv: number | null;
  }[] = [];

  const works = savedActData.Роботи.filter((w: any) => w.Робота);
  const details = savedActData.Деталі.filter((p: any) => p.Деталь);
  const rowSum = (row: any) => Number(row.Сума ?? Number(row.Кількість) * Number(row.Ціна));
  for (const work of works) {
    worksTotalSale += rowSum(work);
    worksTotalSlusarSalary += Number(work.Зарплата ?? 0);
  }
  for (const part of details) {
    const sale = rowSum(part);
    partsTotalSale += sale;
    partsList.push({ scladId: Number(part.sclad_id) || null,
      qty: Number(part.Кількість), sale, buyPrice: 0, xtoZamovuv: null });
  }

  // --- ОТРИМАННЯ ВХІДНИХ ЦІН ТА НОМЕРА СКЛАДУ ---
  let partsTotalBuy = 0;
  // Суми для розрахунку (без деталей, де номер складу деталі = складу приймальника)
  let partsSaleForPruimalnyk = 0;
  let partsBuyForPruimalnyk = 0;

  const scladIdsToFetch = [...new Set(partsList
    .map((p) => p.scladId)
    .filter((id): id is number => id !== null && Number.isSafeInteger(id) && id > 0))];

  // Мапа: sclad_id -> номер складу деталі (scladNome)
  const scladToScladNomeMap = new Map<number, number>();

  if (scladIdsToFetch.length > 0) {
    // Отримуємо дані з sclad разом з scladNomer (номер фізичного складу) та xto_zamovuv (хто оприходував)
    const scladItems: any[] = [];
    for (let offset = 0; offset < scladIdsToFetch.length; offset += 200) {
      const { data, error } = await supabase.from("sclad")
        .select('sclad_id, price, "scladNomer", xto_zamovuv')
        .in("sclad_id", scladIdsToFetch.slice(offset, offset + 200));
      if (error) throw new Error("Не вдалося прочитати закупівельні ціни. Зарплату не перераховано: " + error.message);
      scladItems.push(...(data || []));
    }
    options.session?.captureStock(scladItems);
    {
      // Створюємо мапи: sclad_id -> ціна, номер складу, xto_zamovuv
      const priceMap = new Map<number, number>();
      const xtoZamovuvMap = new Map<number, number>(); // sclad_id -> xto_zamovuv (slyusar_id)
      scladItems.forEach((item: any) => {
        // Парсимо ціну (якщо рядок "938,00" або число 938)
        let val = NaN;
        if (typeof item.price === "number") {
          val = item.price;
        } else {
          // Якщо рядок або щось інше
          val =
            parseFloat(
              String(item.price)
                .replace(",", ".")
                .replace(/[^\d.-]/g, ""),
            );
        }
        if (!Number.isFinite(val)) throw new Error("Закупівельна ціна некоректна. Зарплату не перераховано.");
        priceMap.set(Number(item.sclad_id), val);

        // Зберігаємо номер складу для цієї деталі (scladNomer)
        const scladNomer = Number(item.scladNomer) || 0;
        if (scladNomer > 0) {
          scladToScladNomeMap.set(item.sclad_id, scladNomer);
        }

        // Зберігаємо xto_zamovuv (хто оприходував деталь)
        const xtoZamovuv = Number(item.xto_zamovuv) || 0;
        if (xtoZamovuv > 0) {
          xtoZamovuvMap.set(item.sclad_id, xtoZamovuv);
        }
      });

      if (scladIdsToFetch.some(id => !priceMap.has(id))) throw new Error("Для частини деталей відсутня закупівельна ціна. Зарплату не перераховано.");

      // Рахуємо суму закупки (загальну та для приймальника) + оновлюємо partsList
      partsList.forEach((part) => {
        if (part.scladId && priceMap.has(part.scladId)) {
          const buyPrice = priceMap.get(part.scladId) || 0;
          const buyCost = buyPrice * part.qty;
          partsTotalBuy += buyCost;

          // ✅ Оновлюємо деталь buyPrice та xtoZamovuv
          part.buyPrice = buyPrice;
          part.xtoZamovuv = xtoZamovuvMap.get(part.scladId) || null;

          // Перевіряємо, чи номер складу деталі НЕ співпадає зі складом приймальника
          const detailSklad = scladToScladNomeMap.get(part.scladId);
          const shouldCount =
            detailSklad === undefined || detailSklad !== pruimalnykSklad;

          // console.log(
          // `🔍 Деталь sclad_id=${part.scladId}: scladNomer=${detailSklad}, pruimalnykSklad=${pruimalnykSklad}, xtoZamovuv=${part.xtoZamovuv}, shouldCount=${shouldCount}, sale=${part.sale}, buyPrice=${buyPrice}`,
          // );

          if (shouldCount) {
            // Деталь враховується в зарплаті приймальника
            partsSaleForPruimalnyk += part.sale;
            partsBuyForPruimalnyk += buyCost;
          }
        } else {
          if (part.scladId) throw new Error(`Не знайдено закупівельну ціну деталі №${part.scladId}. Зарплату не перераховано.`);
          // Деталь без scladId або без ціни в sclad - враховуємо повністю в зарплаті приймальника
          // (невідомий запчастист = враховується)
          // console.log(
          // `🔍 Деталь без scladId або ціни: scladId=${part.scladId}, sale=${part.sale}`,
          // );
          partsSaleForPruimalnyk += part.sale;
          // partsBuyForPruimalnyk не додаємо, бо невідома ціна закупки
        }
      });
    }
  } else {
    // Якщо немає scladIdsToFetch - всі деталі без scladId, враховуємо всю суму продажу
    partsList.forEach((part) => {
      partsSaleForPruimalnyk += part.sale;
    });
  }

  // --- РОЗРАХУНОК БАЗ ТА ЗАРПЛАТ ---
  // Враховуємо дисконт (знижку)
  const discountMultiplier =
    discountPercent > 0 ? 1 - discountPercent / 100 : 1;

  // 1. Робота: (Сума Продажу * множник дисконту - Зарплата Слюсаря)
  // Дисконт застосовується до суми продажу, а потім віднімаємо зарплату слюсаря
  const workSaleAfterDiscount = worksTotalSale * discountMultiplier;
  const baseWorkProfit = workSaleAfterDiscount - worksTotalSlusarSalary;

  // 2. Запчастини: (Сума Продажу * множник дисконту - Сума Закупки)
  // Загальні суми (для відображення)
  const partsSaleAfterDiscount = partsTotalSale * discountMultiplier;
  const basePartsProfit = partsSaleAfterDiscount - partsTotalBuy;

  // 3. Запчастини для приймальника (виключаємо деталі, де scladNome = Склад приймальника)
  const partsSaleForPruimalnykAfterDiscount =
    partsSaleForPruimalnyk * discountMultiplier;
  const basePartsProfitForPruimalnyk =
    partsSaleForPruimalnykAfterDiscount - partsBuyForPruimalnyk;

  // ✅ ВИПРАВЛЕНО: Якщо сума від'ємна - зарплата = 0
  // Зарплата приймальника розраховується ТІЛЬКИ з деталей, де номер складу деталі (scladNome) ≠ складу приймальника
  const salaryWork = payrollPercent(baseWorkProfit, percentWork);
  const salaryParts = payrollPercent(basePartsProfitForPruimalnyk, percentParts);

  // Determine previous owners from this act's actual payroll history, not a
  // browser-global localStorage key shared between unrelated acts and tabs.
  for (const employee of await fetchPayrollEmployeesForAct(actId, options.session)) {
    if (employee.slyusar_id === userData?.slyusar_id) continue;
    const receiver = trackPayrollData(employee.slyusar_id, employee.data);
    if (!["Приймальник", "Адміністратор"].includes(receiver.Доступ)) continue;
    for (const date of Object.keys(receiver.Історія || {})) {
      const bucket = receiver.Історія[date];
      if (!Array.isArray(bucket)) throw new Error("Некоректна історія приймальника");
      receiver.Історія[date] = bucket.filter((entry: any) => String(entry.Акт) !== String(actId));
      if (!receiver.Історія[date].length) delete receiver.Історія[date];
    }
    await persistPayrollData(receiver, options.session);
  }

  // ✅ ВИПРАВЛЕНО: Отримуємо дані клієнта та авто з БАЗИ ДАНИХ, а не з DOM
  const { pib, auto } = options.labels || await fetchActClientAndCarDataFromDB(actId);

  // --- РОЗРАХУНОК ТА ЗАПИС ЗАРПЛАТ ЗАПЧАСТИСТІВ ---
  // ✅ Використовуємо нову функцію для повної синхронізації історії ВСІХ Запчастистів
  // ✅ ВАЖЛИВО: Це виконується ЗАВЖДИ, незалежно від наявності приймальника
  const totalZapchastystySalary = await syncAllZapchastystyHistoryForAct(
    actId,
    partsList,
    scladToScladNomeMap,
    discountMultiplier,
    actDateOn,
    pib,
    auto,
    inputKey,
    unchangedInput,
    options,
  );

  // --- ОНОВЛЕННЯ ІСТОРІЇ ПРИЙМАЛЬНИКА (тільки якщо є приймальник) ---
  if (pruimalnykName && userData && slyusarData) {
    let history = slyusarData.Історія || {};
    let actFound = false;
    let foundDateKey = "";
    let foundIndex = -1;

    // 3. Шукаємо існуючий запис акту в історії
    for (const dateKey of Object.keys(history)) {
      const dailyActs = history[dateKey];
      if (Array.isArray(dailyActs)) {
        const idx = dailyActs.findIndex(
          (item: any) => String(item.Акт) === String(actId),
        );
        if (idx !== -1) {
          actFound = true;
          foundDateKey = dateKey;
          foundIndex = idx;
          break;
        }
      }
    }

    // ✅ ВИПРАВЛЕНО: Перевіряємо чи акт порожній (немає робіт і деталей)
    const isActEmpty = works.length === 0 && details.length === 0;

    const previous = actFound ? history[foundDateKey][foundIndex] : null;
    if (previous && !isActEmpty && (previous.__payroll_input === inputKey || (!previous.__payroll_input && unchangedInput))) {
      previous.__payroll_input = inputKey;
      previous.ЗарплатаЗапчастистів = totalZapchastystySalary;
      if (options.snapshot) previous.ДатаЗакриття = options.snapshot.date_off?.split("T")[0] ?? null;
      await persistPayrollData(slyusarData, options.session);
      return;
    }

    if (isActEmpty) {
      // ❌ Акт порожній → видаляємо запис з історії (якщо був)
      if (actFound) {
        history[foundDateKey].splice(foundIndex, 1);

        // Якщо масив порожній, видаляємо дату
        if (history[foundDateKey].length === 0) {
          delete history[foundDateKey];
        }

        slyusarData.Історія = history;

        await persistPayrollData(slyusarData, options.session);
      } else {
        // console.log(
        // `ℹ️ Акт ${actId} порожній і не був в історії Приймальника - нічого видаляти`,
        // );
      }
    } else {
      // ✅ Акт має дані → оновлюємо/створюємо запис
      const actRecordUpdate = {
        Акт: String(actId),
        Клієнт: pib,
        Автомобіль: auto,
        // Записуємо чистий прибуток (після дисконту, собівартості/зарплати слюсаря і зарплати приймальника)
        // Записуємо Базовий прибуток (ДО відрахування зарплати приймальника), щоб співвідношення ЗП/Сума відповідало відсотку
        // ✅ ВИПРАВЛЕНО: Якщо сума від'ємна - записуємо 0 для зарплати
        СуммаРоботи: baseWorkProfit,
        СуммаЗапчастин: basePartsProfit, // Загальна сума запчастин (включаючи свій склад)
        МаржаДляЗарплати: basePartsProfitForPruimalnyk, // Маржа БЕЗ свого складу (для розрахунку ЗарплатаЗапчастин)
        ЗарплатаРоботи: salaryWork, // Вже = 0 якщо baseWorkProfit <= 0
        ЗарплатаЗапчастин: salaryParts, // = МаржаДляЗарплати × ПроцентЗапчастин / 100
        ЗарплатаЗапчастистів: totalZapchastystySalary, // Сума зарплат всіх Запчастистів по цьому акту
        Знижка: discountPercent, // Зберігаємо відсоток знижки для відображення
        ДатаЗакриття: options.snapshot ? options.snapshot.date_off?.split("T")[0] ?? null : previous?.ДатаЗакриття ?? null,
        __payroll_input: inputKey,
        __payroll_percent_work: percentWork,
        __payroll_percent_parts: percentParts,
      };

      if (actFound) {
        const oldRecord = history[foundDateKey][foundIndex];
        history[foundDateKey][foundIndex] = {
          ...oldRecord,
          ...actRecordUpdate,
        };
      } else {
        // Використовуємо дату створення акту, а не поточну дату
        const actDate = actDateOn
          ? actDateOn.split("T")[0]
          : new Date().toISOString().split("T")[0];
        if (!history[actDate]) {
          history[actDate] = [];
        }
        history[actDate].push(actRecordUpdate);
      }

      // 4. Зберігаємо оновлену історію в БД
      slyusarData.Історія = history;

      await persistPayrollData(slyusarData, options.session);
      if (!options.snapshot) localStorage.setItem("current_act_pruimalnyk", pruimalnykName);
    }
  } else {
    // console.log(
    // "⚠️ syncPruimalnikHistory: Немає приймальника - історія приймальника НЕ оновлюється (але Запчастисти оновлені)",
    // );
  }
}

/* =============================== ЗБЕРЕЖЕННЯ АКТУ =============================== */

async function readSavedPayrollLabels(snapshot: Pick<SavedPayrollSnapshot, "client_id" | "cars_id">): Promise<{ pib: string; auto: string }> {
  const read = async (table: "clients" | "cars", key: string, id: number | null): Promise<any> => {
    if (id == null) return {};
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error(`Некоректний ідентифікатор ${table} в акті.`);
    const projection = table === "clients"
      ? 'full_name:data->>"ПІБ",fio:data->>fio'
      : 'model:data->>"Авто",year:data->>"Рік",plate:data->>"Номер авто"';
    const { data: projected, error } = await supabase.from(table).select(projection).eq(key, id).single();
    const data = projected as unknown as Record<string, unknown> | null;
    if (error || !data) throw new Error(`Не вдалося прочитати ${table} для нарахування: ${payrollErrorMessage(error || "запис відсутній")}`);
    if (Object.values(data).some(value => value != null)) {
      return table === "clients" ? { "ПІБ": data.full_name, fio: data.fio }
        : { "Авто": data.model, "Рік": data.year, "Номер авто": data.plate };
    }
    // Legacy rows may contain a JSON string inside JSONB. Only those empty
    // projections need the compatibility read; ordinary labels stay tiny.
    const legacy = await supabase.from(table).select("data").eq(key, id).single();
    if (legacy.error || !legacy.data) throw new Error(`Не вдалося прочитати ${table} для нарахування: ${payrollErrorMessage(legacy.error || "запис відсутній")}`);
    const parsed = typeof legacy.data.data === "string" ? JSON.parse(legacy.data.data) : legacy.data.data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Некоректні дані ${table} в акті.`);
    return parsed;
  };
  const [client, car] = await Promise.all([
    read("clients", "client_id", snapshot.client_id),
    read("cars", "cars_id", snapshot.cars_id),
  ]);
  return {
    pib: String(client["ПІБ"] || client.fio || ""),
    auto: [car["Авто"], car["Рік"], car["Номер авто"]].filter(value => value != null && value !== "").join(" ").trim(),
  };
}

/** Build recovery changes exclusively from the server snapshot; the caller commits the session. */
export async function planSavedActPayroll(snapshot: SavedPayrollSnapshot, session: PayrollWriteSession, previousActData?: any): Promise<{ pib: string; auto: string }> {
  const actId = Number(snapshot.act_id);
  if (!Number.isSafeInteger(actId) || actId <= 0) throw new Error("Некоректний номер акта для нарахування.");
  if (!snapshot.date_on || Number.isNaN(Date.parse(snapshot.date_on)) ||
      (snapshot.date_off != null && Number.isNaN(Date.parse(snapshot.date_off)))) {
    throw new Error(`Акт №${actId}: некоректна дата відкриття або закриття.`);
  }
  const data = typeof snapshot.data === "string" ? JSON.parse(snapshot.data) : structuredClone(snapshot.data);
  if (!data || !Array.isArray(data.Роботи) || !Array.isArray(data.Деталі)) {
    throw new Error(`Акт №${actId}: відсутні повні збережені роботи або деталі.`);
  }
  assertValidActPayrollData(data);
  const works = data.Роботи.filter((row: any) => row?.Робота);
  const parts = data.Деталі.filter((row: any) => row?.Деталь);
  if ((works.length || parts.length) && !String(snapshot.pruimalnyk || "").trim()) {
    throw new Error(`Акт №${actId}: не призначено приймальника.`);
  }
  const number = (value: unknown, field: string, minimum?: number): number => {
    if (value == null || (typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
      throw new Error(`Акт №${actId}: відсутнє число «${field}».`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (minimum !== undefined && parsed < minimum)) {
      throw new Error(`Акт №${actId}: некоректне число «${field}».`);
    }
    return parsed;
  };
  const discount = data.Знижка == null ? 0 : number(data.Знижка, "Знижка", 0);
  if (discount > 100) throw new Error(`Акт №${actId}: знижка перевищує 100%.`);
  for (const row of [...works, ...parts]) {
    number(row.Кількість, "Кількість");
    number(row.Ціна, "Ціна", 0);
    if (row.Сума != null) number(row.Сума, "Сума");
  }
  for (const part of parts) {
    if (part.sclad_id != null && (!Number.isSafeInteger(Number(part.sclad_id)) || Number(part.sclad_id) <= 0)) {
      throw new Error(`Акт №${actId}: некоректний складський ідентифікатор деталі.`);
    }
  }
  const employees = await session.fetchEmployees();
  for (const employee of employees) assertPayrollHistory(employee.data);
  const usedRecordIds = new Set<string>();
  const workRows: WorkRow[] = [];
  for (const work of works) {
    const salary = number(work.Зарплата, "Зарплата", 0);
    const name = String(work.Слюсар || "").trim();
    const id = work.slyusar_id == null ? null : number(work.slyusar_id, "slyusar_id", 1);
    if (id !== null && !Number.isSafeInteger(id)) throw new Error(`Акт №${actId}: некоректний ідентифікатор слюсаря.`);
    if (!name && id === null) {
      // An unassigned work is a draft, not an employee accrual. Keep its salary
      // in the saved act and in the receiver's cost base; do not invent an owner.
      // Assigned work still commits atomically, including removals/transfers.
      continue;
    }
    const matches = employees.filter(employee => id === null ? employee.data.Name === name : Number(employee.slyusar_id) === id);
    if (matches.length !== 1 || matches[0].data.Доступ !== "Слюсар") {
      throw new Error(`Акт №${actId}: слюсаря «${name || id}» не знайдено однозначно.`);
    }
    const recordId = work.recordId == null ? "" : String(work.recordId).trim();
    if (!recordId) {
      throw new Error(`Акт №${actId}: збережена робота «${work.Робота}» не має стабільного ідентифікатора. Потрібно перевірити старий запис; для відкритого акта збережіть його в редакторі.`);
    }
    if (usedRecordIds.has(recordId)) throw new Error(`Акт №${actId}: повторний recordId роботи «${recordId}».`);
    usedRecordIds.add(recordId);
    workRows.push({
      slyusarName: String(matches[0].data.Name || name), slyusar_id: Number(matches[0].slyusar_id),
      Найменування: String(work.Робота), Кількість: Number(work.Кількість), Ціна: Number(work.Ціна), Зарплата: salary, recordId,
    });
  }
  const labels = await readSavedPayrollLabels(snapshot);
  const confirmedSnapshot = { ...snapshot, data };
  await syncSlyusarsOnActSave(actId, workRows, {
    session,
    strictSavedRows: true,
    context: { date_on: snapshot.date_on, date_off: snapshot.date_off, clientInfo: labels.pib, carInfo: labels.auto },
  });
  await syncPruimalnikHistory(actId, 0, 0, snapshot.date_on, discount, data, previousActData, undefined, undefined,
    { session, snapshot: confirmedSnapshot, labels });
  return labels;
}

/**
 * Записує інформацію про приймальника в таблицю acts
 * ✅ ВИПРАВЛЕНО: Записуємо ТІЛЬКИ якщо поточний користувач є Приймальник
 * Це забезпечує що acts.pruimalnyk завжди вказує на актуального Приймальника
 * і не перезаписується Адміністратором або іншими ролями
 * @param actId - ID акту
 */
async function savePruimalnykToActs(actId: number, assertActor: () => void): Promise<void> {
  try {
    assertActor();
    // ✅ ВИПРАВЛЕНО: Записуємо приймальника якщо поточний користувач є Приймальник АБО Адміністратор
    // Вони можуть "забирати" акт собі (видаляють з попереднього, записують собі)
    // Слюсар / Запчастист / Складовщик → просто оновлюють дані у поточного власника акту
    if (
      userAccessLevel !== "Приймальник" &&
      userAccessLevel !== "Адміністратор"
    ) {
      // console.log(
      // `📝 savePruimalnykToActs: Пропускаємо для ролі ${userAccessLevel} (тільки Приймальник/Адміністратор можуть стати pruimalnyk)`,
      // );
      return;
    }

    // Звичайне відкриття/збереження з іншого акаунта не передає акт новому
    // приймальнику. Власника встановлюємо лише якщо він ще не заданий.
    const { data: currentAct, error: currentActError } = await supabase
      .from("acts")
      .select("pruimalnyk")
      .eq("act_id", actId)
      .single();
    if (currentActError) {
      throw new Error(currentActError.message);
    }
    assertActor();
    if (String(currentAct?.pruimalnyk || "").trim()) return;

    const userData = getSavedUserDataFromLocalStorage?.();
    if (!userData || !userData.name) {
      throw new Error("Не вдалося визначити приймальника поточного користувача.");
    }

    // Записуємо приймальника тільки якщо користувач є Приймальник
    const updateData = {
      pruimalnyk: userData.name,
    };

    let query = supabase
      .from("acts")
      .update(updateData)
      .eq("act_id", actId);
    query = currentAct?.pruimalnyk == null ? query.is("pruimalnyk", null) : query.eq("pruimalnyk", currentAct.pruimalnyk);
    assertActor();
    const { data: assigned, error } = await query.select("act_id,pruimalnyk").single();
    assertActor();

    if (error) {
      throw error;
    } else if (Number(assigned?.act_id) !== actId || assigned?.pruimalnyk !== userData.name) {
      throw new Error("Не підтверджено призначення приймальника. Повторіть збереження.");
    } else {
      // console.log(`✅ acts.pruimalnyk оновлено на: ${userData.name}`);
    }
  } catch (err: any) {
    throw new Error("Не вдалося зберегти приймальника: " + payrollErrorMessage(err));
  }
}

export interface ActSaveResult {
  warning?: string;
  changed: boolean;
  revision?: string;
  staffChanged?: boolean;
}

async function saveActData(actId: number, originalActData: any): Promise<ActSaveResult> {
  const actor = payrollActorScope();
  const assertActor = () => { if (actor !== payrollActorScope()) throw new Error("Користувач змінився під час збереження. Відкрийте акт повторно."); };
  if (isSaving || isActWritePending()) {
    throw new Error("Збереження вже виконується, зачекайте...");
  }
  if (globalCache.isActClosed) {
    throw new Error("Неможливо редагувати закритий акт");
  }
  const body = document.getElementById(ZAKAZ_NARAYD_BODY_ID);
  const tableBody = body?.querySelector(`#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`);
  if (!body || !tableBody || body.dataset.saveReadyAct !== String(actId)) {
    throw new Error("Таблиця акту не завантажена повністю. Збереження зупинено.");
  }
  const wasInert = body.inert;
  body.inert = true;
  isSaving = true;
  setActWritePending(true);

  try {
    // ✅ FIX БАГ №1 + №3: Читаємо СВІЖІ дані з БД перед збереженням
    // Це запобігає перезапису даних інших користувачів, які зберегли свої зміни
    // поки поточний користувач тримав модалку відкритою
    let freshActData = originalActData;
    let freshSnapshot: Awaited<ReturnType<typeof readEditorActForDelta>>;
    try {
      const freshAct = freshSnapshot = await readEditorActForDelta(actId, userName || "");
      if (freshAct.date_off) {
        throw new Error("Акт вже закритий іншим користувачем");
      }
      if (isActFrozen(freshAct)) {
        throw new Error("Заморожений акт не можна зберігати — спочатку розморозьте його");
      }
      if (freshAct.data != null) {
        freshActData = safeParseJSON(freshAct.data) || originalActData;
      }
    } catch (freshReadErr) {
      if (freshReadErr instanceof ActWriteConflict || (freshReadErr instanceof Error && freshReadErr.message.includes("act_delta_save"))) throw freshReadErr;
      if (
        freshReadErr instanceof Error &&
        (freshReadErr.message.includes("вже закритий") ||
          freshReadErr.message.includes("Заморожений акт"))
      ) {
        throw freshReadErr;
      }
      // Якщо контрольне читання не вдалося, не ризикуємо перезаписувати акт
      // застарілим DOM іншого акаунта.
      throw new Error("Немає підтвердженого з’єднання з базою. Введені дані залишаються у вікні — повторіть збереження після відновлення зв’язку.");
    }

    assertActor();
    // Verify the server snapshot even when the user only wants to close an act.
    const editedFields = ["Деталі", "Роботи", "Пробіг", "Причина звернення", "Рекомендації", "Примітки", "Аванс", "Знижка"];
    if (editedFields.some(key => stableActJson(originalActData[key]) !== stableActJson(freshActData[key]))) {
      throw new ActWriteConflict();
    }

    // Closing an unchanged historical act must not recreate its rows, check
    // deleted stock receipts or recalculate already saved wages/costs. Pending
    // payroll and every actual edit still use the complete guarded save below.
    if (navigator.onLine && freshActData.__payroll_pending !== true &&
        canReuseUnchangedActBaseline(actId, originalActData, body)) {
      saveContextByActId.set(actId, structuredClone(freshActData));
      rememberUnchangedActBaseline(actId, freshActData, body);
      markActEditorSaved(actId, actEditorSignature(body));
      setActEditorPayrollPending(actId, false);
      return { changed: false, revision: freshActData.__act_revision,
        staffChanged: false };
    }

    // Include original, fresh and current rows, including removed/returned parts.
    const priceIds = new Set<number>();
    for (const snapshot of [originalActData, freshActData]) {
      for (const detail of snapshot?.Деталі || []) priceIds.add(Number(detail.sclad_id));
    }
    tableBody.querySelectorAll<HTMLElement>("[data-sclad-id]").forEach(node => priceIds.add(Number(node.dataset.scladId)));
    await loadPurchasePrices([...priceIds]);

    // ✅ FIX БАГ №3: Оновлюємо кеш прихованих стовпців свіжими даними з БД
    // Це гарантує що для ролей з прихованими стовпцями (Слюсар — без Ціна/Сума)
    // збереження використає актуальні значення, а не застарілі з моменту відкриття
    cacheHiddenColumnsData(freshActData);

    const probigText = cleanText(
      document.getElementById(EDITABLE_PROBIG_ID)?.textContent,
    );
    const probigCleaned = probigText.replace(/\s/g, "");
    const newProbig =
      probigCleaned && /^\d+$/.test(probigCleaned)
        ? Number(probigCleaned)
        : probigCleaned || 0;

    const newReason =
      (
        document.getElementById(EDITABLE_REASON_ID) as HTMLElement
      )?.innerText?.trim() || "";
    const newRecommendations =
      (
        document.getElementById(EDITABLE_RECOMMENDATIONS_ID) as HTMLElement
      )?.innerText?.trim() || "";
    const newNotes =
      (
        document.getElementById(EDITABLE_NOTES_ID) as HTMLElement
      )?.innerText?.trim() || "";

    const referenceSignature = actEditorSignature(body);
    await prepareEditorRowReferences(body);
    if (referenceSignature !== actEditorSignature(body)) throw new Error("Дані акта змінилися під час перевірки довідників. Повторіть збереження.");
    const items = parseTableRows();
    const persistedCount = countNamedActRows(freshActData);
    if (persistedCount > 0 && items.length === 0 && !await appConfirm(
      "Ви видалили всі роботи й деталі. Зберегти акт повністю порожнім?",
    )) throw new Error("Збереження порожнього акту скасовано");
    if (referenceSignature !== actEditorSignature(body)) throw new Error("Дані акта змінилися під час підтвердження. Повторіть збереження.");
    const savedEditorSignature = actEditorSignature(body);
    const savedInputSignature = actSaveInputSignature();

    // ⚠️ ПЕРЕВІРКА ДЛЯ СЛЮСАРЯ: він може зберігати зміни тільки в своїх рядках
    if (userAccessLevel === "Слюсар" && userName) {
      const originalItems = originalActData?.actItems || [];

      // Перевіряємо, чи слюсар намагається змінити існуючі рядки
      for (const item of items) {
        // Знаходимо оригінальний рядок
        const originalItem = originalItems.find(
          (orig: any) =>
            orig.Найменування === item.name && orig.Type === item.type,
        );

        // Якщо рядок існував раніше (не новий)
        if (originalItem) {
          const originalPib = originalItem.ПІБ_Магазин || "";

          // Перевіряємо, чи це не його рядок
          if (
            originalPib &&
            originalPib.toLowerCase() !== userName.toLowerCase()
          ) {
            throw new Error(
              `⛔ Ви не можете змінювати рядок "${item.name}", оскільки він призначений іншому слюсарю (${originalPib})`,
            );
          }
        }

        // (Перевірка на призначення чужого ПІБ для слюсаря видалена за вимогою)
      }
    }

    let {
      details,
      works,
      detailRowsForShops,
      totalDetailsSum,
      totalWorksSum,
      grandTotalSum,
      totalWorksProfit,
      totalDetailsMargin,
    } = processItems(items);

    // Явне збереження використовує повний поточний DOM як джерело істини.
    // Повторне merge зі старими масивами БД могло повернути видалений рядок
    // або перекрити новий у великих/legacy актах та при повторюваних назвах.
    // Метадані акту нижче все одно успадковуються зі freshActData.
    detailRowsForShops = buildShopRowsFromDetails(details);

    ({
      totalDetailsSum,
      totalWorksSum,
      grandTotalSum,
      totalWorksProfit,
      totalDetailsMargin,
    } = recalculateMergedTotals(details, works));

    const avansInput = document.getElementById(
      "editable-avans",
    ) as HTMLInputElement;
    const avansValue = avansInput
      ? parseFloat(avansInput.value.replace(/\s/g, "") || "0")
      : Number(originalActData?.["Аванс"] ?? 0);

    const discountInput = document.getElementById(
      "editable-discount",
    ) as HTMLInputElement;
    const discountValue = discountInput
      ? parseFloat(discountInput.value.replace(/\s/g, "") || "0")
      : Number(originalActData?.["Знижка"] ?? 0);

    // Розраховуємо знижку від ВАЛУ (загальної суми), а НЕ від маржі
    // Знижка застосовується до загальної суми продажу
    const discountMultiplier = discountValue > 0 ? 1 - discountValue / 100 : 1;

    // Сума продажу після знижки
    const detailsSaleAfterDiscount = totalDetailsSum * discountMultiplier;
    const worksSaleAfterDiscount = totalWorksSum * discountMultiplier;

    // Маржа = сума продажу після знижки - собівартість (для деталей вже врахована в totalDetailsMargin)
    // Для деталей: маржа = (продажна ціна - вхідна ціна) * кількість
    // Після знижки: маржа = продажна ціна * (1 - знижка%) - вхідна ціна * кількість
    // Це еквівалентно: (totalDetailsSum * discountMultiplier) - totalPurchasePrice
    // Де totalPurchasePrice = totalDetailsSum - totalDetailsMargin

    const totalPurchasePrice = totalDetailsSum - (totalDetailsMargin || 0);
    const finalDetailsProfit = detailsSaleAfterDiscount - totalPurchasePrice;

    // Для робіт: прибуток = сума продажу після знижки - зарплата слюсаря
    // totalWorksProfit = totalWorksSum - зарплата слюсаря, тому зарплата = totalWorksSum - totalWorksProfit
    const totalSlyusarSalary = totalWorksSum - (totalWorksProfit || 0);
    const finalWorksProfit = worksSaleAfterDiscount - totalSlyusarSalary;

    const updatedActData = {
      ...(freshActData || {}),
      __payroll_pending: freshActData.__payroll_pending,
      Пробіг: newProbig,
      "Причина звернення": newReason,
      Рекомендації: newRecommendations,
      Примітки: newNotes,
      Деталі: details,
      Роботи: works,
      "За деталі": totalDetailsSum,
      "За роботу": totalWorksSum,
      "Загальна сума": grandTotalSum,
      Аванс: avansValue,
      Знижка: discountValue,
      "Прибуток за деталі": Number(finalDetailsProfit.toFixed(2)),
      "Прибуток за роботу": Number(finalWorksProfit.toFixed(2)),
    };

    const financialChanged = ["Деталі", "Роботи", "Знижка", "За деталі", "За роботу", "Прибуток за деталі", "Прибуток за роботу"]
      .some(key => stableActJson(freshActData[key]) !== stableActJson((updatedActData as any)[key]));
    const needsFinancialSync = financialChanged || freshActData.__payroll_pending === true || !String(freshSnapshot!.pruimalnyk || "").trim();
    // Validate locally before writing an invalid financial snapshot or making
    // payroll requests. Unassigned salaries are valid drafts and remain intact.
    if (needsFinancialSync) assertValidActPayrollData(updatedActData);
    if (needsFinancialSync) updatedActData.__payroll_pending = true;
    else if (!Object.prototype.hasOwnProperty.call(freshActData, "__payroll_pending")) delete updatedActData.__payroll_pending;

    showNotification("Збереження змін...", "info");

    // 💾 Збереження даних акту (тільки JSONB, без окремих колонок)
    // 📵 Якщо офлайн — зберігаємо в чергу IndexedDB
    if (!navigator.onLine) {
      assertActor();
      await enqueueActUpdate(actId, updatedActData, avansValue, freshActData);
      showNotification(
        "📵 Зміни збережено локально. Синхронізуються при зʼєднанні.",
        "warning",
        4000,
      );
      throw new Error("Зміни збережено лише локально. Закриття акту можливе після синхронізації.");
    }

    let savedRow: { act_id: number; data: any; receipt?: ActWriteReceipt };
    try {
      assertActor();
      savedRow = await writeEditorActDelta(actId, freshActData, updatedActData, { checksum: freshSnapshot!.checksum, avans: Number(freshSnapshot!.avans ?? 0) === avansValue ? undefined : avansValue, lockOwner: userName || "" });
      assertActor();
    } catch (updateError: any) {
      // Якщо мережа зникла під час запиту — ставимо в чергу
      if (
        updateError.message?.includes("Failed to fetch") ||
        updateError.message?.includes("network")
      ) {
        assertActor();
        await enqueueActUpdate(actId, updatedActData, avansValue, freshActData);
        showNotification(
          "📵 Зміни збережено локально. Синхронізуються при зʼєднанні.",
          "warning",
          4000,
        );
        throw new Error("Зміни збережено лише локально. Закриття акту можливе після синхронізації.");
      }
      throw new Error(`Не вдалося оновити акт: ${updateError.message}`);
    }
    let savedData = savedRow.data;
    let savedChanged = savedRow.receipt?.status === "updated";
    let savedLabels: { pib: string; auto: string } | undefined;
    let savedReceiver = freshSnapshot!.pruimalnyk;
    const savedDetails = Array.isArray(savedData?.["Деталі"])
      ? savedData["Деталі"]
      : [];
    const savedWorks = Array.isArray(savedData?.["Роботи"])
      ? savedData["Роботи"]
      : [];
    assertRowsPersisted(details, savedDetails, "detail");
    assertRowsPersisted(works, savedWorks, "work");
    saveContextByActId.set(actId, structuredClone(savedData));

    // Основні дані акту вже збережені. Допоміжні таблиці не повинні блокувати
    // закриття через один старий/великий запис історії. Виконуємо кожен крок
    // окремо, щоб збій одного не скасував решту синхронізацій.
    setActEditorPayrollPending(actId, savedData.__payroll_pending === true);
    // The act has been acknowledged; payroll completion has its own visible guard.
    markActEditorSaved(actId, savedEditorSignature);
    const syncSteps: Array<() => Promise<unknown>> = needsFinancialSync ? [
      () => syncShopsOnActSave(actId, detailRowsForShops, savedData.__act_revision, userName || ""),
    ] : [];
    const saveWarnings: string[] = [];
    const stockLinkConflicts = (savedRow.receipt as (ActWriteReceipt & { stock_link_conflicts?: number[] }) | undefined)?.stock_link_conflicts;
    if (stockLinkConflicts?.length) saveWarnings.push(`Складські позиції ${stockLinkConflicts.join(", ")} вже пов’язані з іншим актом. Їхні зв’язки збережено; перевірте прив’язку на складі.`);
    let auxiliarySyncFailed = false;
    let payrollSyncError: unknown = null;
    for (const syncStep of syncSteps) {
      try {
        assertActor();
        await syncStep();
        assertActor();
      } catch (error) {
        auxiliarySyncFailed = true;
        saveWarnings.push(error instanceof Error ? error.message : String((error as any)?.message || error));
      }
    }
    if (auxiliarySyncFailed) {
      saveWarnings.push("Акт збережено; частину допоміжних даних буде потрібно синхронізувати повторно.");
    }
    if (needsFinancialSync) {
      try {
        if (!savedRow.receipt) throw new Error("Немає квитанції збереженого акту");
        assertActor();
        await savePruimalnykToActs(actId, assertActor);
        const snapshot = await readPayrollRecoveryContext(actId);
        savedReceiver = snapshot.pruimalnyk;
        assertActor();
        if (snapshot.checksum !== savedRow.receipt.checksum || snapshot.revision !== savedRow.receipt.revision) throw new ActWriteConflict();
        const session = await PayrollWriteSession.create(actId);
        assertActor();
        savedLabels = await planSavedActPayroll(snapshot, session, freshActData);
        assertActor();
        const confirmed = await commitPayrollSession(snapshot, session, userName || "");
        savedChanged ||= confirmed.receipt.status === "updated";
        assertActor();
        savedData = confirmed.data;
        saveContextByActId.set(actId, structuredClone(savedData));
        setActEditorPayrollPending(actId, false);
      } catch (error) {
        payrollSyncError = error;
        setActEditorPayrollPending(actId, true, payrollErrorMessage(error));
      }
    }
    assertActor();
    if (!payrollSyncError) markActEditorSaved(actId, savedEditorSignature);

    // ===== ЛОГУВАННЯ ЗМІН =====
    try {
      const currentItems = items;
      const { added, deleted } = compareActChanges(
        globalCache.initialActItems || [],
        currentItems,
      );
      await logActChanges(actId, added, deleted, { pruimalnyk: savedReceiver, labels: savedLabels });

      // Повний фінансовий аудит рядка: ціна, сума та зарплата не повинні
      // змінюватися непомітно при роботі з іншого акаунта.
      const initialParsed = convertActItemsToParsedItems(
        globalCache.initialActItems || [],
      );
      const modified: any[] = [];
      const createKey = (i: ParsedItem) => `${i.type}:${i.name}`;
      const initialMap = new Map<string, ParsedItem>();
      initialParsed.forEach((i) => initialMap.set(createKey(i), i));
      currentItems.forEach((cur) => {
        const old = initialMap.get(createKey(cur));
        if (!old) return;
        const changes: string[] = [];
        if (old.price !== cur.price)
          changes.push(`Ціна: ${old.price} → ${cur.price}`);
        if (old.quantity !== cur.quantity)
          changes.push(`Кількість: ${old.quantity} → ${cur.quantity}`);
        if (old.sum !== cur.sum)
          changes.push(`Сума: ${old.sum} → ${cur.sum}`);
        if (
          cur.type === "work" &&
          Number(old.slyusarSum || 0) !== Number(cur.slyusarSum || 0)
        ) {
          changes.push(
            `Зарплата: ${Number(old.slyusarSum || 0)} → ${Number(cur.slyusarSum || 0)}`,
          );
        }
        if (old.pibMagazin !== cur.pibMagazin)
          changes.push(
            `${cur.type === "work" ? "Слюсар" : "Магазин"}: «${old.pibMagazin}» → «${cur.pibMagazin}»`,
          );
        if (changes.length)
          modified.push({ name: cur.name, type: cur.type, changes });
      });

      // ✅ ЗАГАЛЬНИЙ ЛОГ ДІЙ
      if (added.length > 0 || deleted.length > 0 || modified.length > 0) {
        await logAction("update_act_items", actId, {
          added: added.map((i) => ({ name: i.name, type: i.type })),
          deleted: deleted.map((i) => ({ name: i.name, type: i.type })),
          modified,
        });
      }
    } catch (logError) {
      // console.error("⚠️ Помилка логування змін:", logError);
      // Не блокуємо збереження через помилку логування
    }
    // =====================================

    globalCache.oldNumbers = readTableNewNumbers();
    if (globalCache.currentActId) actQuantitySnapshot.seed(globalCache.currentActId, globalCache.oldNumbers);
    // Оновлюємо baseline напряму з ParsedItem[], щоб уникнути втрати даних
    // при подвійній конвертації ParsedItem → details/works → ActItem
    globalCache.initialActItems = items.map((i) => ({
      type: i.type,
      name: i.name,
      catalog: i.catalog || "",
      quantity: i.quantity,
      price: i.price,
      sum: i.sum,
      person_or_store: i.pibMagazin || "",
      sclad_id: i.sclad_id ?? null,
      slyusar_id: i.slyusar_id ?? null,
      slyusarSum: i.slyusarSum || 0,
      recordId: i.recordId,
    }));
    document
      .querySelectorAll<HTMLTableRowElement>(
        `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr[data-item-type="work"]`,
      )
      .forEach((row) => row.setAttribute("data-salary-persisted", "true"));

    // Reload only this act's staff history; expire quantities only for changed stock IDs.
    try {
      if (needsFinancialSync) await reloadSlyusarsOnly();
      const stockQuantities = (snapshot: any) => {
        const quantities = new Map<number, number>();
        for (const row of snapshot?.Деталі || []) {
          const id = Number(row.sclad_id);
          if (Number.isSafeInteger(id) && id > 0) quantities.set(id, (quantities.get(id) || 0) + Number(row.Кількість || 0));
        }
        return quantities;
      };
      const beforeStock = stockQuantities(freshActData), afterStock = stockQuantities(savedData);
      invalidateEditorStockRows([...new Set([...beforeStock.keys(), ...afterStock.keys()])]
        .filter(id => (beforeStock.get(id) || 0) !== (afterStock.get(id) || 0)));
      await cleanupEmptyRows();
      await refreshQtyWarningsIn(ACT_ITEMS_TABLE_CONTAINER_ID);
      updateCalculatedSumsInFooter();
    } catch {
      saveWarnings.push("Акт записано, але не вдалося оновити всі дані у вікні. Відкрийте його повторно для актуального відображення.");
    }
    // UI-only cleanup/formatting after the confirmed write is not a new edit.
    markActEditorSaved(actId, actEditorSignature(body));
    if (savedRow.receipt?.status !== "unchanged" || needsFinancialSync) void refreshActRowInTable(actId);
    if (payrollSyncError) {
      throw new Error(`Позиції акта збережено, але зарплату не синхронізовано повністю. ${payrollErrorMessage(payrollSyncError)}`);
    }
    // A background callback may still change the DOM while user input is inert.
    // Such values were not in this write and must not become a saved baseline.
    if (savedInputSignature === actSaveInputSignature()) {
      rememberUnchangedActBaseline(actId, savedData, body);
    } else {
      unchangedActSaveBaseline = null;
    }
    const warning = saveWarnings.join(" ");
    if (warning) showNotification(warning, "warning", 6000);
    return { ...(warning ? { warning } : {}), changed: savedChanged,
      revision: savedData.__act_revision, staffChanged: needsFinancialSync };
  } finally {
    isSaving = false;
    setActWritePending(false);
    body.inert = wasInert;
  }
}

export async function saveCurrentAct(actId: number): Promise<ActSaveResult> {
  const originalActData = saveContextByActId.get(actId);
  if (!originalActData) throw new Error("Акт ще не готовий до збереження");
  return saveActData(actId, originalActData);
}

export function addSaveHandler(actId: number, originalActData: any): void {
  unchangedActSaveBaseline = null;
  saveContextByActId.set(actId, structuredClone(originalActData));
  const body = document.getElementById(ZAKAZ_NARAYD_BODY_ID);
  if (body) {
    delete body.dataset.saveReadyAct;
    const expectedCount = countNamedActRows(originalActData);
    const table = body.querySelector(`#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`);
    if (table && parseTableRows().length === expectedCount) {
      body.dataset.saveReadyAct = String(actId);
      rememberUnchangedActBaseline(actId, originalActData, body);
    }
    trackActEditor(actId, body);
    setActEditorPayrollPending(actId, originalActData.__payroll_pending === true && !isActFrozen({ data: originalActData }));
  }

  const saveButton = document.getElementById(
    ZAKAZ_NARAYD_SAVE_BTN_ID,
  ) as HTMLButtonElement | null;
  if (!saveButton) return;

  const newSaveButton = saveButton.cloneNode(true) as HTMLButtonElement;
  saveButton.parentNode?.replaceChild(newSaveButton, saveButton);

  newSaveButton.addEventListener("click", async () => {
    if (isSaving) {
      showNotification("Збереження вже виконується, зачекайте...", "warning");
      return;
    }
    try {
      const result = await saveCurrentAct(actId);

      // ✅ Сповіщаємо про збереження
      try {
        if (result.changed) await notifyActSaved(actId, { revision: result.revision, staffChanged: result.staffChanged });
      } catch (notifyErr) {
        // console.warn("Помилка відправки сповіщення:", notifyErr);
      }

      if (!result.warning) showNotification("Зміни успішно збережено", "success");
    } catch (err: any) {
      // console.error("Помилка збереження:", err);
      showNotification(
        `Помилка збереження даних: ${err?.message || err}`,
        "error",
      );
    }
  });
}

/**
 * ✅ НОВА ФУНКЦІЯ: Видаляє акт з історії Приймальника та всіх Запчастистів
 * Використовується при повному видаленні акту з БД
 * @param actId - ID акту для видалення з історій
 */
export async function removeActFromAllHistories(actId: number): Promise<void> {
  for (const row of await fetchPayrollEmployees([actId])) {
    const data = trackPayrollData(row.slyusar_id, row.data);
    if (!["Приймальник", "Адміністратор", "Запчастист"].includes(data.Доступ)) continue;
    for (const date of Object.keys(data.Історія || {})) {
      if (!Array.isArray(data.Історія[date])) throw new Error("Некоректна історія зарплат");
      data.Історія[date] = data.Історія[date].filter((entry: any) => String(entry.Акт) !== String(actId));
      if (!data.Історія[date].length) delete data.Історія[date];
    }
    await savePayrollData(data);
  }
}
