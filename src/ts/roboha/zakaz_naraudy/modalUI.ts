import { invalidateEditorReferences } from "./editorReferenceRead";
import { releaseEditorStockSubscription } from "./globalCache";
// ===== ФАЙЛ: modalUI.ts =====
import { confirmActNavigation, forgetActEditor } from "../../utils/actEditorGuard";
import { payrollPercent, floorPayrollSalary, payrollNumber } from "../../utils/payrollSafeWrite";

import {
  globalCache,
  loadGlobalData,
  ZAKAZ_NARAYD_MODAL_ID,
  ZAKAZ_NARAYD_BODY_ID,
  ACT_ITEMS_TABLE_CONTAINER_ID,
  formatNumberWithSpaces,
} from "./globalCache";
import {
  setupAutocompleteForEditableCells,
  refreshQtyWarningsIn,
  shortenTextToFirstAndLast,
} from "./inhi/kastomna_tabluca";
import {
  userAccessLevel,
  canUserAddRowToAct,
  userName,
} from "../tablucya/users";
import { supabase } from "../../vxid/supabaseClient";
import { cleanupSlusarsOnSubscription } from "./modalMain";
import { unsubscribeFromActPresence } from "./actPresence";
import { getAISalarySuggestion, checkAIEnabled } from "../ai/aiPriceHelper";
import { showNotification } from "./inhi/vspluvauhe_povidomlenna";
import { cleanupAllSnakeBorders } from "./inhi/act_changes_highlighter";

// Утилиты для форматирования чисел с пробелами
const unformat = (s: string) => s.replace(/\s+/g, "");
const format = (num: number) => {
  const str = String(num);
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

const roundToKopiyky = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const formatMoneyMaybeDecimal = (value: number): string => {
  const rounded = roundToKopiyky(value);
  return formatNumberWithSpaces(
    rounded,
    Number.isInteger(rounded) ? 0 : 2,
    2,
  );
};

function expandName(shortenedName: string): string {
  if (!shortenedName || !shortenedName.includes(".....")) return shortenedName;

  const allNames = [...globalCache.works, ...globalCache.details];
  const [firstPart, lastPart] = shortenedName.split(".....");

  const fullName = allNames.find((name) => {
    const sentences = name
      .split(/(?<=\.)\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (sentences.length < 2) return false;
    const lastSentence = sentences[sentences.length - 1];
    return (
      name.startsWith(firstPart) &&
      (name.endsWith(lastPart) || lastSentence === lastPart)
    );
  });

  return fullName || shortenedName;
}

/**
 * Інтерфейс для запису роботи в історії слюсаря
 */
interface SlyusarWorkRecord {
  Робота: string;
  Ціна: number;
  Кількість: number;
  Зарплата: number;
  Записано?: string;
  Розраховано?: string;
  recordId?: string; // ✅ Унікальний ID запису для точного пошуку
}

/**
 * Знаходить запис роботи в історії слюсаря для конкретного акту
 * @param slyusarName - ім'я слюсаря
 * @param workName - назва роботи
 * @param actId - номер акту
 * @param rowIndex - індекс рядка для точного пошуку при однакових роботах
 * @param recordId - унікальний ID запису (пріоритетний спосіб пошуку)
 * @returns весь об'єкт запису або null
 */
function findSlyusarWorkRecord(
  slyusarName: string,
  workName: string,
  actId: number | null,
  rowIndex?: number,
  recordId?: string,
): SlyusarWorkRecord | null {
  if (!slyusarName || !workName || !actId) return null;

  const slyusar = globalCache.slyusars.find(
    (s) => s.Name?.toLowerCase() === slyusarName.toLowerCase(),
  );

  if (!slyusar?.["Історія"]) {
    return null;
  }

  const history = slyusar["Історія"];
  const targetActId = String(actId);
  const fullWorkName = expandName(workName);
  const workNameLower = workName.toLowerCase();
  const fullWorkNameLower = fullWorkName.toLowerCase();

  for (const dateKey in history) {
    const dayBucket = history[dateKey];
    if (!Array.isArray(dayBucket)) continue;

    for (const actEntry of dayBucket) {
      if (String(actEntry?.["Акт"] || "") !== targetActId) continue;

      const zapisi = actEntry?.["Записи"];
      if (!Array.isArray(zapisi)) continue;

      // ✅ 0. ПРІОРИТЕТ: Пошук за recordId (найточніший спосіб)
      if (recordId) {
        const recordById = zapisi.find((z: any) => z.recordId === recordId);
        if (recordById) {
          return recordById as SlyusarWorkRecord;
        }
        return null; // Never borrow another row's salary when an ID is known.
      }

      // ✅ 1. ВАЖЛИВО: Пошук за rowIndex (індекс запису в масиві Записи)
      // rowIndex відповідає порядку робіт слюсаря в акті
      if (
        typeof rowIndex === "number" &&
        rowIndex >= 0 &&
        rowIndex < zapisi.length
      ) {
        const record = zapisi[rowIndex];
        const recordWorkLower = (record?.Робота?.trim() || "").toLowerCase();

        // Перевіряємо співпадіння назви роботи
        if (
          recordWorkLower === workNameLower ||
          recordWorkLower === fullWorkNameLower
        ) {
          return record as SlyusarWorkRecord;
        }
      }

      // ❌ ВИДАЛЕНО FALLBACK ЗА НАЗВОЮ - він повертає неправильний запис при однакових назвах!
      // Якщо recordId і rowIndex не допомогли - повертаємо null
      return null;
    }
  }

  return null;
}

/**
 * ✅ Знаходить recordId для роботи в історії слюсаря
 * Використовується при завантаженні акту для прив'язки рядків до записів в історії
 * @param slyusarName - ім'я слюсаря
 * @param workName - назва роботи
 * @param actId - номер акту
 * @param workIndex - загальний індекс роботи серед ВСІХ робіт цього слюсаря в акті (0, 1, 2...)
 * @returns recordId або undefined
 */
export function getRecordIdFromHistory(
  slyusarName: string,
  workName: string,
  actId: number | null,
  workIndex: number,
): string | undefined {
  if (!slyusarName || !actId) return undefined;

  const slyusar = globalCache.slyusars.find(
    (s) => s.Name?.toLowerCase() === slyusarName.toLowerCase(),
  );

  if (!slyusar?.["Історія"]) return undefined;

  const history = slyusar["Історія"];
  const targetActId = String(actId);
  const fullWorkName = expandName(workName);
  const workNameLower = workName.toLowerCase();
  const fullWorkNameLower = fullWorkName.toLowerCase();

  for (const dateKey in history) {
    const dayBucket = history[dateKey];
    if (!Array.isArray(dayBucket)) continue;

    for (const actEntry of dayBucket) {
      if (String(actEntry?.["Акт"] || "") !== targetActId) continue;

      const zapisi = actEntry?.["Записи"];
      if (!Array.isArray(zapisi)) continue;

      // ✅ ВИПРАВЛЕНО: шукаємо за загальним індексом запису (workIndex = позиція серед всіх робіт слюсаря)
      if (workIndex >= 0 && workIndex < zapisi.length) {
        const record = zapisi[workIndex];
        const recordWorkLower = (record?.Робота?.trim() || "").toLowerCase();

        // Перевіряємо що назва співпадає (для надійності)
        if (
          recordWorkLower === workNameLower ||
          recordWorkLower === fullWorkNameLower
        ) {
          return record?.recordId;
        }
      }

      // Fallback: якщо за індексом не знайшли - шукаємо просто за назвою
      // (для старих записів без recordId)
      const matchingRecords = zapisi.filter((record: any) => {
        const recordWorkLower = (record?.Робота?.trim() || "").toLowerCase();
        return (
          recordWorkLower === workNameLower ||
          recordWorkLower === fullWorkNameLower
        );
      });
      if (matchingRecords.length === 1) return matchingRecords[0]?.recordId;
    }
  }

  return undefined;
}

/**
 * Отримує зарплату з історії слюсаря для конкретної роботи та акту
 * @param slyusarName - ім'я слюсаря
 * @param workName - назва роботи
 * @param actId - номер акту (ОБОВ'ЯЗКОВИЙ параметр)
 * @param rowIndex - індекс рядка для точного пошуку
 * @param recordId - унікальний ID запису (пріоритетний спосіб)
 * @returns зарплату > 0 або null (якщо 0 або немає - ігноруємо)
 */
export function getSlyusarSalaryFromHistory(
  slyusarName: string,
  workName: string,
  actId: number | null,
  rowIndex?: number,
  recordId?: string,
): number | null {
  const record = findSlyusarWorkRecord(
    slyusarName,
    workName,
    actId,
    rowIndex,
    recordId,
  );

  // ✅ ВИПРАВЛЕНО: Якщо зарплата = 0 — ігноруємо і повертаємо null
  // Тоді буде перерахунок від відсотка
  if (record && typeof record.Зарплата === "number" && record.Зарплата >= 0) {
    return record.Зарплата;
  }

  if (record && record.Зарплата === 0) {
    // Зарплата в історії = 0 - ігноруємо
  }

  return null;
}

/**
 * 🤖 Асинхронний пошук зарплати з AI fallback
 * Якщо зарплату не знайдено в історії поточного акту - шукає в загальній історії через AI
 * @param slyusarName - ім'я слюсаря
 * @param workName - назва роботи
 * @param actId - номер акту
 * @param price - ціна роботи (для розрахунку)
 * @param rowIndex - індекс рядка для точного пошуку
 * @param recordId - унікальний ID запису
 * @returns зарплата або null
 */
export async function getSlyusarSalaryWithAI(
  slyusarName: string,
  workName: string,
  actId: number | null,
  price: number,
  rowIndex?: number,
  recordId?: string,
): Promise<{ salary: number | null; isAISuggested: boolean }> {
  // Спочатку пробуємо стандартний пошук
  const standardSalary = getSlyusarSalaryFromHistory(
    slyusarName,
    workName,
    actId,
    rowIndex,
    recordId,
  );

  if (standardSalary !== null) {
    return { salary: standardSalary, isAISuggested: false };
  }

  // Якщо не знайшли - пробуємо AI
  const aiEnabled = await checkAIEnabled();
  if (!aiEnabled || price <= 0) {
    return { salary: null, isAISuggested: false };
  }

  const aiSuggestion = await getAISalarySuggestion(
    slyusarName,
    workName,
    price,
  );
  if (aiSuggestion && aiSuggestion.amount > 0) {
    return { salary: floorPayrollSalary(aiSuggestion.amount), isAISuggested: true };
  }

  return { salary: null, isAISuggested: false };
}

/**
 * Отримує відсоток роботи слюсаря з бази даних або кешу
 */
export async function getSlyusarWorkPercent(
  slyusarName: string,
): Promise<number> {
  if (!slyusarName) return 0;

  // Спочатку шукаємо в кеші
  const matches = globalCache.slyusars.filter(
    (s) => s.Name?.toLowerCase() === slyusarName.toLowerCase(),
  );

  if (matches.length > 1) throw new Error(`Кілька працівників із ПІБ «${slyusarName}». Оберіть однозначного виконавця.`);
  const cached = matches[0];
  if (cached && cached.ПроцентРоботи != null) {
    return payrollNumber(cached.ПроцентРоботи);
  }

  // Якщо в кеші немає - йдемо в базу даних
  try {
    const { data, error } = await supabase
      .from("slyusars")
      .select('work_percent:data->"ПроцентРоботи"')
      .eq("data->>Name", slyusarName)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) throw new Error(`Не знайдено відсоток працівника «${slyusarName}»`);

    const percent = payrollNumber(data.work_percent);

    // Оновлюємо кеш
    const existingIndex = globalCache.slyusars.findIndex(
      (s) => s.Name?.toLowerCase() === slyusarName.toLowerCase(),
    );

    if (existingIndex !== -1) {
      globalCache.slyusars[existingIndex].ПроцентРоботи = percent;
    } else {
      globalCache.slyusars.push({ Name: slyusarName, ПроцентРоботи: percent });
    }

    return percent;
  } catch (err) {
    throw err;
  }
}

/**
 * Розраховує зарплату слюсаря від суми
 */
export function calculateSlyusarSum(totalSum: number, percent: number): number {
  return payrollPercent(totalSum, percent);
}

/**
 * Оновлює зарплату слюсаря в рядку (async версія) - ВИПРАВЛЕНА ВЕРСІЯ 3.0
 *
 * ЛОГІКА:
 * - Якщо в історії слюсаря для цієї роботи вже є збережена зарплата > 0 → НЕ перераховуємо
 * - Якщо в історії = 0 або немає запису → перераховуємо за відсотком
 * - Це дозволяє зберегти вручну введену зарплату при зміні ціни/кількості
 */
async function updateSlyusarSalaryInRow(
  row: HTMLTableRowElement,
  rowIndex?: number, // Індекс рядка для точного пошуку при однакових роботах
  isInitialLoad: boolean = false, // ✅ НОВИЙ параметр: true = ініціалізація при завантаженні
): Promise<void> {
  // ✅ ВИПРАВЛЕНО: Зарплата розраховується ЗАВЖДИ, навіть якщо стовпець прихований
  // Це потрібно для коректного розрахунку прибутку приймальника

  // ✅ НОВИЙ ЗАХИСТ: Якщо зарплата заблокована (слюсар змінився, але зарплата була > 0) - не перераховуємо
  if (row.getAttribute("data-salary-locked") === "true") {
    row.removeAttribute("data-salary-locked"); // Знімаємо флаг після одного пропуску
    return;
  }

  const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
  const typeFromCell = nameCell?.getAttribute("data-type");

  if (typeFromCell !== "works") {
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement;
    if (slyusarSumCell) slyusarSumCell.textContent = "";
    return;
  }

  // Для вже збереженого рядка acts.data є єдиним джерелом істини.
  // Історія та поточний відсоток не мають права змінювати його при відкритті.
  if (row.getAttribute("data-salary-persisted") === "true") return;

  if (!globalCache.settings.showPibMagazin) return;

  // ✅ ВИПРАВЛЕНО: беремо повну назву з атрибуту, якщо є (для довгих назв)
  const workName =
    nameCell?.getAttribute("data-full-name") || nameCell?.textContent?.trim();

  const pibCell = row.querySelector('[data-name="pib_magazin"]') as HTMLElement;
  const slyusarName = pibCell?.textContent?.trim();
  const slyusarSumCell = row.querySelector(
    '[data-name="slyusar_sum"]',
  ) as HTMLElement;

  if (!workName || !slyusarName || !slyusarSumCell) return;

  // ✅ Зчитуємо recordId з атрибута рядка
  const recordId = row.getAttribute("data-record-id") || undefined;

  const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
  const totalSum = parseNumber(sumCell?.textContent);

  const actId = globalCache.currentActId;

  if (!actId) {
    return;
  }

  // 1. ПРІОРИТЕТ: Шукаємо в історії для ПОТОЧНОГО акту (з recordId якщо є)
  const historySalary = getSlyusarSalaryFromHistory(
    slyusarName,
    workName,
    actId,
    rowIndex, // Передаємо індекс для точного пошуку
    recordId, // ✅ Передаємо recordId для найточнішого пошуку
  );

  // ✅ НОВА ЛОГІКА v3.0:
  // Якщо в історії є збережена зарплата > 0 → НЕ перераховуємо при зміні ціни/кількості
  // Тільки при ініціалізації (isInitialLoad=true) встановлюємо значення з історії
  if (historySalary !== null) {
    if (isInitialLoad) {
      // При завантаженні акту - підтягуємо зарплату з історії
      slyusarSumCell.textContent = formatNumberWithSpaces(historySalary);
    } else {
      // При зміні ціни/кількості - НЕ перераховуємо, залишаємо поточне значення
    }
    return;
  }

  // 2. ВИПРАВЛЕННЯ: Якщо в історії немає І totalSum <= 0 - очищуємо
  if (totalSum <= 0) {
    // console.log(`⚠️ Сума <= 0 і немає даних в історії - очищуємо`);
    slyusarSumCell.textContent = "";
    return;
  }

  // 3. Якщо є сума, але в історії = 0 або немає - рахуємо від відсотка
  const percent = await getSlyusarWorkPercent(slyusarName);
  const calculatedSalary = calculateSlyusarSum(totalSum, percent);
  slyusarSumCell.textContent = formatNumberWithSpaces(calculatedSalary);
}

/**
 * Ініціалізує зарплати слюсарів при завантаженні акту - ВИПРАВЛЕНА ВЕРСІЯ 2.0
 */
export async function initializeSlyusarSalaries(): Promise<void> {
  // ✅ ВИПРАВЛЕНО: Зарплата ініціалізується ЗАВЖДИ, навіть якщо стовпець прихований
  // Це потрібно для коректного збереження даних в базу

  const tableBody = document.querySelector<HTMLTableSectionElement>(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tableBody) return;

  const actId = globalCache.currentActId;

  if (!actId) {
    return;
  }

  // Використовуємо спільну функцію для обходу рядків з індексами
  await processWorkRowsWithIndex(
    tableBody,
    async (row, slyusarName, workName, currentIndex) => {
      const slyusarSumCell = row.querySelector(
        '[data-name="slyusar_sum"]',
      ) as HTMLElement;
      if (!slyusarSumCell) return;

      if (row.getAttribute("data-salary-persisted") === "true") return;

      const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
      const totalSum = parseNumber(sumCell?.textContent);

      // ✅ Зчитуємо recordId з атрибута рядка
      const recordId = row.getAttribute("data-record-id") || undefined;

      // КРИТИЧНО: Завжди шукаємо в історії ПЕРШИМ, передаємо індекс та recordId
      const historySalary = getSlyusarSalaryFromHistory(
        slyusarName,
        workName,
        actId,
        currentIndex,
        recordId,
      );

      if (historySalary !== null) {
        slyusarSumCell.textContent = formatNumberWithSpaces(historySalary);
        return;
      }

      // Якщо немає в історії і сума <= 0 - пропускаємо
      if (totalSum <= 0) return;

      // Якщо немає в історії, але є сума - рахуємо від відсотка
      const percent = await getSlyusarWorkPercent(slyusarName);
      const calculatedSalary = calculateSlyusarSum(totalSum, percent);
      slyusarSumCell.textContent = formatNumberWithSpaces(calculatedSalary);
    },
  );
}

/**
 * Обходить всі рядки робіт в таблиці з правильним індексом для кожного слюсаря
 * @param tableBody - tbody таблиці
 * @param callback - функція для обробки кожного рядка
 */
async function processWorkRowsWithIndex(
  tableBody: HTMLTableSectionElement,
  callback: (
    row: HTMLTableRowElement,
    slyusarName: string,
    workName: string,
    slyusarWorkIndex: number,
  ) => void | Promise<void>,
): Promise<void> {
  const rows = Array.from(
    tableBody.querySelectorAll<HTMLTableRowElement>("tr"),
  );
  const slyusarWorkIndexMap = new Map<string, number>();

  for (const row of rows) {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    if (!nameCell) continue;

    const typeFromCell = nameCell.getAttribute("data-type");
    if (typeFromCell !== "works") continue;

    const workName =
      nameCell.getAttribute("data-full-name") ||
      nameCell.textContent?.trim() ||
      "";
    const pibCell = row.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement;
    const slyusarName = pibCell?.textContent?.trim() || "";

    if (!workName || !slyusarName) continue;

    // Визначаємо індекс роботи для цього слюсаря
    const slyusarKey = slyusarName.toLowerCase();
    const currentIndex = slyusarWorkIndexMap.get(slyusarKey) ?? 0;
    slyusarWorkIndexMap.set(slyusarKey, currentIndex + 1);

    await callback(row, slyusarName, workName, currentIndex);
  }
}

/**
 * Оновлює "Зар-та" для всіх робіт у таблиці з урахуванням історії/відсотків
 * Використовується з modalMain.ts одразу після рендеру модалки.
 * ✅ isInitialLoad=true - підтягує зарплати з історії слюсаря
 */
export async function updateAllSlyusarSumsFromHistory(): Promise<void> {
  // ✅ ВИПРАВЛЕНО: Зарплата оновлюється ЗАВЖДИ, навіть якщо стовпець прихований
  // Це потрібно для коректного збереження даних в базу
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tableBody) return;

  // ✅ ВИПРАВЛЕНО: тепер чекаємо завершення всіх async операцій
  // ✅ isInitialLoad=true - при ініціалізації підтягуємо зарплату з історії
  await processWorkRowsWithIndex(
    tableBody,
    async (row, _slyusarName, _workName, currentIndex) => {
      await updateSlyusarSalaryInRow(row, currentIndex, true);
    },
  );
}

/**
 * Перераховує суму в рядку і оновлює зарплату слюсаря (async)
 * ✅ isInitialLoad=false - НЕ перераховує зарплату якщо в історії слюсаря вже є збережене значення > 0
 */
export async function calculateRowSum(row: HTMLTableRowElement): Promise<void> {
  const price = parseNumber(
    (row.querySelector('[data-name="price"]') as HTMLElement)?.textContent,
  );
  const quantity = parseNumber(
    (row.querySelector('[data-name="id_count"]') as HTMLElement)?.textContent,
  );
  const sum = roundToKopiyky(price * quantity);

  const sumCell = row.querySelector(
    '[data-name="sum"]',
  ) as HTMLTableCellElement;
  if (sumCell)
    sumCell.textContent =
      sum === 0 ? "" : formatMoneyMaybeDecimal(sum);

  // ✅ isInitialLoad=false - при зміні ціни/к-ті НЕ перераховуємо якщо в історії є зарплата > 0
  await updateSlyusarSalaryInRow(row, undefined, false);
  updateCalculatedSumsInFooter();
}

/**
 * ✅ НОВА ФУНКЦІЯ: Примусово перераховує зарплату слюсаря від відсотка
 * Використовується коли слюсар змінюється в ПІБ_Магазин - ігнорує історію!
 * @param row - рядок таблиці
 */
export async function forceRecalculateSlyusarSalary(
  row: HTMLTableRowElement,
): Promise<void> {
  // ✅ ВИПРАВЛЕНО: Зарплата перераховується ЗАВЖДИ, навіть якщо стовпець прихований
  // Це потрібно для коректного збереження даних в базу

  const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
  const typeFromCell = nameCell?.getAttribute("data-type");

  // Тільки для робіт
  if (typeFromCell !== "works") {
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement;
    if (slyusarSumCell) slyusarSumCell.textContent = "";
    return;
  }

  const pibCell = row.querySelector('[data-name="pib_magazin"]') as HTMLElement;
  const slyusarName = pibCell?.textContent?.trim();
  const slyusarSumCell = row.querySelector(
    '[data-name="slyusar_sum"]',
  ) as HTMLElement;
  const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;

  if (!slyusarName || !slyusarSumCell) {
    if (slyusarSumCell) slyusarSumCell.textContent = "";
    return;
  }

  const totalSum = parseNumber(sumCell?.textContent);

  if (totalSum <= 0) {
    slyusarSumCell.textContent = "";
    return;
  }

  // ✅ ПРИМУСОВО рахуємо від відсотка нового слюсаря, ігноруючи історію
  const percent = await getSlyusarWorkPercent(slyusarName);
  const calculatedSalary = calculateSlyusarSum(totalSum, percent);
  slyusarSumCell.textContent = formatNumberWithSpaces(calculatedSalary);

  updateCalculatedSumsInFooter();
}

/**
 * Перевіряє попередження про зарплату при завантаженні
 */
export function checkSlyusarSalaryWarnings(): void {
  if (!globalCache.settings.showZarplata) return;
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return;

  const rows = Array.from(
    container.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  );
  let hasWarnings = false;

  for (const row of rows) {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    const typeFromCell = nameCell?.getAttribute("data-type");

    if (typeFromCell !== "works") continue;

    const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement;

    if (!sumCell || !slyusarSumCell) continue;

    const sum = parseNumber(sumCell.textContent);
    const slyusarSum = parseNumber(slyusarSumCell.textContent);

    if (slyusarSum > sum && sum > 0) {
      hasWarnings = true;
      slyusarSumCell.setAttribute("data-warnzp", "1");
      slyusarSumCell.classList.add("slyusar-sum-cell");
    } else {
      slyusarSumCell.removeAttribute("data-warnzp");
      slyusarSumCell.classList.remove("slyusar-sum-cell");
    }
  }

  if (hasWarnings) {
    showNotification(
      "⚠️ Увага: Зарплата більша ніж сума роботи у деяких рядках",
      "warning",
    );
  }
}

function createRowHtml(
  item: any | null,
  index: number,
  showPibMagazin: boolean,
  showCatalog: boolean,
  canDelete: boolean = true, // <--- НОВИЙ ПАРАМЕТР
): string {
  const isActClosed = globalCache.isActClosed;

  // Перевірка прав для слюсаря:
  const isSlyusar = userAccessLevel === "Слюсар";
  const pibMagazinValue = item?.person_or_store || ""; // значення ПІБ_Магазин

  // Перевіряємо, чи це рядок слюсаря (його прізвище в ПІБ_Магазин)
  const isOwnRow =
    userName && pibMagazinValue.toLowerCase() === userName.toLowerCase();

  // 🆕 НОВА ЛОГІКА: Рядок з роботою, де ПІБ_Магазин пустий
  // Слюсар може редагувати пусті поля (кількість, ціна, зарплата, ПІБ_Магазин)
  // але НЕ може редагувати вже заповнене поле "name"
  const isWorkRowWithEmptyPib =
    isSlyusar &&
    item !== null &&
    item.type === "work" &&
    item.name?.trim() !== "" &&
    pibMagazinValue.trim() === "";

  // ⚠️ Слюсар може редагувати:
  // 1. Нові рядки (item === null)
  // 2. Рядки зі своїм прізвищем в ПІБ_Магазин
  // 3. 🆕 Рядки з роботою де ПІБ_Магазин пустий (тільки пусті поля!)
  // Адміністратор і Приймальник можуть редагувати все
  // ✅ ВИПРАВЛЕНО: Запчастист і Складовщик можуть редагувати якщо canDelete = true (налаштування id:22/19)
  const isZapchastystOrSkladovschyk =
    userAccessLevel === "Запчастист" || userAccessLevel === "Складовщик";
  const canEdit =
    userAccessLevel === "Адміністратор" ||
    userAccessLevel === "Приймальник" ||
    (isSlyusar && (item === null || isOwnRow || isWorkRowWithEmptyPib)) ||
    (isZapchastystOrSkladovschyk && canDelete);

  const isEditable = !isActClosed && canEdit;

  // 🆕 Для рядків з пустим ПІБ - дозволяємо редагувати тільки пусті поля
  // Поле "name" заборонено редагувати, якщо воно вже заповнене
  const isNameEditable = isEditable && !isWorkRowWithEmptyPib;

  // 🆕 Для пустих полів - дозволяємо редагування, якщо значення пусте
  const isQtyEditable =
    isEditable &&
    (!isWorkRowWithEmptyPib || !item?.quantity || item.quantity === 0);
  const isPriceEditable =
    isEditable && (!isWorkRowWithEmptyPib || !item?.price || item.price === 0);
  const isZarplataEditable = isEditable && globalCache.settings.showZarplata;
  const isPibMagazinEditable =
    isEditable && (!isWorkRowWithEmptyPib || pibMagazinValue.trim() === "");
  const isCatalogEditable =
    isEditable && (!isWorkRowWithEmptyPib || !item?.catalog?.trim());

  const dataTypeForName =
    item?.type === "detail" ? "details" : item?.type === "work" ? "works" : "";
  const pibMagazinType = item?.type === "detail" ? "shops" : "slyusars";

  const catalogValue = item?.catalog || "";
  // ✅ ВИПРАВЛЕНО: Завжди зберігаємо sclad_id, навіть якщо стовпець прихований
  const scladIdAttr =
    item?.sclad_id != null ? `data-sclad-id="${item.sclad_id}"` : "";

  // Зарплата з acts.data є канонічним знімком і не повинна зникати,
  // коли колонка прихована або історія слюсаря ще не синхронізувалась.
  const salaryNum = item ? Number(item.slyusarSum) : 0;
  const slyusarSumValue =
    item?.type === "work" &&
    item?.hasPersistedSalary &&
    Number.isFinite(salaryNum)
      ? salaryNum === 0
        ? "0"
        : formatMoneyMaybeDecimal(salaryNum)
      : "";

  // 🆕 Для рядків з пустим ПІБ - автоматично підставляємо ім'я слюсаря
  let displayPibMagazinValue = pibMagazinValue;

  // ✅ ВИПРАВЛЕНО: Завжди створюємо комірку каталогу для збереження data-sclad-id
  // Приховуємо через display: none якщо showCatalog = false
  const catalogCellHTML = `<td contenteditable="${isCatalogEditable}" class="editable-autocomplete catalog-cell" data-name="catalog" ${scladIdAttr}${!showCatalog ? ' style="display: none;"' : ""}>${catalogValue}</td>`;

  const pibMagazinCellHTML = showPibMagazin
    ? `<td contenteditable="${isPibMagazinEditable}" class="editable-autocomplete pib-magazin-cell" data-name="pib_magazin" data-type="${
        item ? pibMagazinType : ""
      }" data-prev-value="${displayPibMagazinValue}">${displayPibMagazinValue}</td>`
    : "";

  /* ===== ЗМІНИ: відображення пустоти замість 0 ===== */
  const priceNum = item ? Number(item.price) : 0;
  const priceValue =
    priceNum && !isNaN(priceNum) && priceNum !== 0
      ? formatMoneyMaybeDecimal(priceNum)
      : "";

  const sumNum = item ? Number(item.sum) : 0;
  const sumValue =
    sumNum && !isNaN(sumNum) && sumNum !== 0
      ? formatMoneyMaybeDecimal(sumNum)
      : "";

  // ⚡ ВАЖЛИВО: завжди створюємо комірки "Ціна" і "Сума",
  // а показ/приховування робимо через JS (togglePriceColumnsVisibility)
  const priceCellHTML = `<td data-col="price" contenteditable="${isPriceEditable}" inputmode="decimal" class="text-right editable-autocomplete price-cell" data-name="price">${priceValue}</td>`;

  const sumCellHTML = `<td data-col="sum" class="text-right" data-name="sum">${sumValue}</td>`;

  const showZarplata = globalCache.settings.showZarplata;
  const canEditZarplata = isZarplataEditable; // акт відкритий і стовпець увімкнено

  // ✅ ВИПРАВЛЕНО: Завжди створюємо комірку зарплати, але приховуємо якщо showZarplata = false
  // Це потрібно для коректного збереження даних (parseTableRows читає з DOM)
  const zarplataCellHTML = `<td contenteditable="${canEditZarplata}"
        class="text-right editable-number slyusar-sum-cell"
        data-name="slyusar_sum"
        ${!showZarplata ? 'style="display: none;"' : ""}>
       ${slyusarSumValue}
     </td>`;

  // 🔽 ЛОГІКА ВИДАЛЕННЯ:
  // Кнопка показується ТІЛЬКИ якщо акт відкритий І користувач має права (canDelete) І може редагувати цей рядок
  // 🆕 Для рядків з пустим ПІБ - слюсар НЕ може видаляти (бо це чужий рядок)
  const showDeleteBtn =
    !isActClosed && canDelete && canEdit && !isWorkRowWithEmptyPib;

  // Скорочуємо назву для відображення (перше речення.....останнє речення)
  // Зберігаємо повну назву в data-full-name для PDF генерації
  const fullName = item?.name || "";
  const displayName = shortenTextToFirstAndLast(fullName);
  const hasShortened = displayName !== fullName;

  // ✅ 10/10 FIX: Генеруємо recordId для КОЖНОГО рядка
  // 1. Якщо є recordId в item - використовуємо його
  // 2. Якщо item є, але recordId немає - генеруємо на основі item.name
  // 3. Якщо item немає (новий рядок) - генеруємо тимчасовий recordId
  let rowRecordId = item?.recordId;
  if (!rowRecordId) {
    const nameForId = (item?.name || "new")
      .substring(0, 20)
      .replace(/\s+/g, "_");
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    rowRecordId = `row_${nameForId}_${timestamp}_${random}`;
  }

  // ✅ Формуємо атрибути рядка
  const rowAttrs: string[] = [];
  if (isWorkRowWithEmptyPib) rowAttrs.push('data-partial-edit="true"');
  rowAttrs.push(`data-record-id="${rowRecordId}"`);
  // ✅ НАДІЙНЕ ВИЗНАЧЕННЯ ТИПУ: зберігаємо тип прямо на рядку
  if (item?.type === "work") rowAttrs.push('data-item-type="work"');
  else if (item?.type === "detail") rowAttrs.push('data-item-type="detail"');
  if (item?.type === "work" && item?.hasPersistedSalary) {
    rowAttrs.push('data-salary-persisted="true"');
  }
  const rowAttrsStr = rowAttrs.length > 0 ? " " + rowAttrs.join(" ") : "";

  return `
    <tr${rowAttrsStr}>
      <td class="row-index" style="${
        item?.type === "work" && showCatalog && !catalogValue
          ? "cursor: pointer;"
          : ""
      }">${
        item?.type === "work"
          ? `🛠️ ${index + 1}`
          : item?.type === "detail"
            ? `⚙️ ${index + 1}`
            : `${index + 1}`
      }</td>
      <td style="position: relative; padding-right: 30px;" class="name-cell">
        <div contenteditable="${isNameEditable}" class="editable-autocomplete" data-name="name" data-type="${dataTypeForName}"${hasShortened ? ` data-full-name="${fullName.replace(/"/g, "&quot;")}"` : ""} style="display: inline-block; width: 100%; outline: none; min-width: 50px;">${
          displayName
        }</div>
        ${
          showDeleteBtn
            ? `<button class="delete-row-btn" style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 18px; padding: 0; margin: 0; z-index: 10; pointer-events: auto; line-height: 1; opacity: 0.6; transition: opacity 0.2s;" title="Видалити рядок">🗑️</button>`
            : ""
        }
      </td>
      ${catalogCellHTML}
      <td contenteditable="${isQtyEditable}" inputmode="decimal" class="text-right editable-autocomplete qty-cell" data-name="id_count">${
        item && item.quantity ? formatNumberWithSpaces(item.quantity) : ""
      }</td>
      ${priceCellHTML}
      ${sumCellHTML}
      ${zarplataCellHTML}
      ${pibMagazinCellHTML}
    </tr>`;
}

export function generateTableHTML(
  allItems: any[],
  showPibMagazin: boolean,
  canAddRow: boolean = true,
): string {
  const showCatalog = globalCache.settings.showCatalog;
  const showZarplata = globalCache.settings.showZarplata;
  const isRestricted = userAccessLevel === "Слюсар";

  const catalogColumnHeader = showCatalog ? '<th data-name="catalog">Каталог</th>' : "";
  const pibMagazinColumnHeader = showPibMagazin ? '<th data-name="pib_magazin">ПІБ _ Магазин</th>' : "";
  const zarplataColumnHeader = showZarplata ? '<th data-name="slyusar_sum">Зар-та</th>' : "";

  // ⚡ НОВЕ: заголовки для "Ціна" і "Сума" з data-col
  const priceColumnHeader = '<th class="text-right" data-col="price">Ціна</th>';
  const sumColumnHeader = '<th class="text-right" data-col="sum">Сума</th>';

  const actItemsHtml =
    allItems.length > 0
      ? allItems
          .map(
            (item, index) =>
              createRowHtml(
                item,
                index,
                showPibMagazin,
                showCatalog,
                canAddRow,
              ), // <--- ПЕРЕДАЄМО canAddRow
          )
          .join("")
      : createRowHtml(null, 0, showPibMagazin, showCatalog, canAddRow); // <--- ПЕРЕДАЄМО canAddRow

  const isActClosed = globalCache.isActClosed;
  const sumsFooter = isRestricted
    ? ""
    : `
  <div class="zakaz_narayd-sums-footer">
    <p class="sum-row">
      <span class="sum-label">Аванс:</span>
      <input 
        type="text"
        id="editable-avans"
        class="editable-avans-input sum-value"
        value="0"
        placeholder="0"
        autocomplete="off"
        ${isActClosed ? "disabled" : ""}
      />
      <span class="sum-currency">грн</span>
    </p>
    <p><strong>За роботу:</strong> <span class="zakaz_narayd-sums-footer-sum" id="total-works-sum">${formatNumberWithSpaces(
      0,
    )}</span> грн</p>
    <p><strong>За деталі:</strong> <span class="zakaz_narayd-sums-footer-sum" id="total-details-sum">${formatNumberWithSpaces(
      0,
    )}</span> грн</p>
    <p class="sum-row">
      <span class="sum-label">Знижка:</span>
      <input 
        type="text"
        id="editable-discount"
        class="editable-discount-input sum-value"
        value="0"
        placeholder="0"
        autocomplete="off"
        ${isActClosed ? "disabled" : ""}
      />
      <span class="sum-currency">%</span>
    </p>
    <p id="overall-sum-line"><strong>Загальна сума:</strong> <span class="zakaz_narayd-sums-footer-total" id="total-overall-sum">${formatNumberWithSpaces(
      0,
    )}</span> грн<span id="avans-subtract-display" class="avans-subtract-display" style="display: none;"></span><span id="final-sum-display" class="final-sum-display" style="display: none;"></span></p>
  </div>`;

  const buttons =
    globalCache.isActClosed || !canAddRow
      ? ""
      : `
    <div class="zakaz_narayd-buttons-container${
      isRestricted ? " obmesheniy" : ""
    }">
      <button id="add-row-button" class="action-button add-row-button">➕ Додати рядок</button>
      <button id="save-act-data" class="zakaz_narayd-save-button" style="padding: 0.5rem 1rem;"> 💾 Зберегти зміни</button>
    </div>`;

  const tableHTML = `
    <div class="zakaz_narayd-table-container-value" id="${ACT_ITEMS_TABLE_CONTAINER_ID}">
      <div class="zakaz_narayd-table-scroll-wrapper">
        <table class="zakaz_narayd-items-table">
          <thead>
            <tr>
              <th>№</th>
              <th>Найменування</th>
              ${catalogColumnHeader}
              <th class="text-right">К-ть</th>
              ${priceColumnHeader}
              ${sumColumnHeader}
              ${zarplataColumnHeader}
              ${pibMagazinColumnHeader}
            </tr>
          </thead>
          <tbody>${actItemsHtml}</tbody>
        </table>
      </div>
      ${sumsFooter}
      ${buttons}
    </div>`;

  setTimeout(() => {
    const avans = document.getElementById(
      "editable-avans",
    ) as HTMLInputElement | null;
    const discount = document.getElementById(
      "editable-discount",
    ) as HTMLInputElement | null;

    if (!avans && !discount) return;

    // Обробник для Авансу
    if (avans) {
      const autoFitAvans = () => {
        const visibleLen = (avans.value || avans.placeholder || "0").length;
        const ch = Math.min(Math.max(visibleLen, 3), 16);
        avans.style.width = ch + "ch";
      };

      const initialValue = parseInt(unformat(avans.value) || "0");
      avans.value = format(initialValue);
      autoFitAvans();
      updateFinalSumWithAvans();

      const onInputAvans = () => {
        const selEndBefore = avans.selectionEnd ?? avans.value.length;
        const digitsBefore = unformat(
          avans.value.slice(0, selEndBefore),
        ).length;

        const numValue = parseInt(unformat(avans.value) || "0");
        avans.value = format(numValue);
        autoFitAvans();

        let idx = 0,
          digitsSeen = 0;
        while (idx < avans.value.length && digitsSeen < digitsBefore) {
          if (/\d/.test(avans.value[idx])) digitsSeen++;
          idx++;
        }
        avans.setSelectionRange(idx, idx);

        updateFinalSumWithAvans();
      };

      const onBlurAvans = () => {
        const numValue = parseInt(unformat(avans.value) || "0");
        avans.value = format(numValue);
        autoFitAvans();
        updateFinalSumWithAvans();
      };

      const onKeyDownAvans = (e: KeyboardEvent) => {
        const allowed =
          /\d/.test(e.key) ||
          [
            "Backspace",
            "Delete",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Tab",
          ].includes(e.key);
        if (!allowed) {
          e.preventDefault();
        }
      };

      avans.addEventListener("keydown", onKeyDownAvans);
      avans.addEventListener("input", onInputAvans);
      avans.addEventListener("blur", onBlurAvans);
    }

    // Обробник для Знижки
    if (discount) {
      const autoFitDiscount = () => {
        const visibleLen = (discount.value || discount.placeholder || "0")
          .length;
        const ch = Math.min(Math.max(visibleLen, 3), 16);
        discount.style.width = ch + "ch";
      };

      let initialValue = parseFloat(discount.value.replace(/,/g, ".") || "0");
      // Обмежуємо до 100% при ініціалізації
      initialValue = Math.min(100, Math.max(0, initialValue));
      discount.value = String(initialValue);
      autoFitDiscount();
      updateFinalSumWithAvans();

      const onInputDiscount = () => {
        // Дозволяємо тільки цифри, крапку та кому
        let value = discount.value.replace(/[^0-9.,]/g, "");
        // Замінюємо кому на крапку
        value = value.replace(/,/g, ".");
        // Дозволяємо тільки одну крапку
        const parts = value.split(".");
        if (parts.length > 2) {
          value = parts[0] + "." + parts.slice(1).join("");
        }

        discount.value = value;
        autoFitDiscount();

        updateFinalSumWithAvans();
      };

      const onBlurDiscount = () => {
        let numValue = parseFloat(discount.value.replace(/,/g, ".") || "0");
        // Обмежуємо до 100% при розфокусуванні
        numValue = Math.min(100, Math.max(0, numValue));
        discount.value = String(numValue);
        autoFitDiscount();
        updateFinalSumWithAvans();
      };

      const onKeyDownDiscount = (e: KeyboardEvent) => {
        const allowed =
          /\d/.test(e.key) ||
          e.key === "." ||
          e.key === "," ||
          [
            "Backspace",
            "Delete",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Tab",
          ].includes(e.key);
        if (!allowed) {
          e.preventDefault();
        }
      };

      const onFocusDiscount = () => {
        // Коли користувач фокусується на полі проценту,
        // скидаємо флаг, щоб сума знижки перераховувалася автоматично
        (window as any).isDiscountAmountManuallySet = false;
      };

      discount.addEventListener("focus", onFocusDiscount);
      discount.addEventListener("keydown", onKeyDownDiscount);
      discount.addEventListener("input", onInputDiscount);
      discount.addEventListener("blur", onBlurDiscount);
    }
  }, 0);

  return tableHTML;
}

/**
 * Приховує або показує кнопки "➕ Додати рядок" та "💾 Зберегти зміни" на основі прав користувача
 * Викликається після рендерингу модального вікна
 * Для Запчастиста та Складовщика обидві кнопки керуються однією перевіркою прав
 */
export async function toggleAddRowButtonVisibility(): Promise<void> {
  const addRowButton = document.getElementById("add-row-button");
  const saveButton = document.getElementById("save-act-data");

  // Якщо кнопок немає (акт закритий) - нічого не робимо
  if (!addRowButton && !saveButton) {
    return;
  }

  try {
    const canAdd = await canUserAddRowToAct();

    if (!canAdd) {
      // Приховуємо обидві кнопки
      if (addRowButton) {
        addRowButton.style.display = "none";
      }
      if (saveButton) {
        saveButton.style.display = "none";
      }
    } else {
      // Показуємо обидві кнопки
      if (addRowButton) {
        addRowButton.style.display = "";
      }
      if (saveButton) {
        saveButton.style.display = "";
      }
    }
  } catch (error) {
    // console.error("❌ Помилка при перевірці прав на додавання рядків:", error);
    // У випадку помилки - показуємо кнопки (безпечніший варіант)
    if (addRowButton) {
      addRowButton.style.display = "";
    }
    if (saveButton) {
      saveButton.style.display = "";
    }
  }
}

export function addNewRow(containerId: string): void {
  const tableBody = document.querySelector<HTMLTableSectionElement>(
    `#${containerId} tbody`,
  );
  if (!tableBody) return;

  const rowCount = tableBody.children.length;
  const showPibMagazin = globalCache.settings.showPibMagazin;
  const showCatalog = globalCache.settings.showCatalog;

  // При додаванні нового рядка кнопкою, ми явно маємо право (кнопка була доступна)
  // тому canDelete = true
  const newRowHTML = createRowHtml(
    null,
    rowCount,
    showPibMagazin,
    showCatalog,
    true,
  );
  tableBody.insertAdjacentHTML("beforeend", newRowHTML);

  // Focus the new row's Name input
  const lastRow = tableBody.lastElementChild as HTMLElement;
  if (lastRow) {
    const nameInput = lastRow.querySelector(
      '[data-name="name"]',
    ) as HTMLElement;
    if (nameInput) {
      nameInput.focus();
    }
  }

  updateCalculatedSumsInFooter();
}

export function updateCalculatedSumsInFooter(): void {
  if (userAccessLevel === "Слюсар") return;

  const tableBody = document.querySelector<HTMLTableSectionElement>(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tableBody) return;

  const { totalWorksSum, totalDetailsSum } = Array.from(
    tableBody.querySelectorAll("tr:not(.deleted-item-row):not([data-notification-only])"),
  ).reduce(
    (sums, row, index) => {
      const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
      const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
      const iconCell = row.querySelector("td:first-child");

      if (!nameCell || !sumCell || !iconCell) return sums;

      const name = nameCell.textContent?.trim() || "";
      const sum = parseNumber(sumCell.textContent);
      let type = nameCell.getAttribute("data-type");

      const works = new Set(globalCache.works);
      const details = new Set(globalCache.details);

      if (!type || (type !== "details" && type !== "works")) {
        const isInWorks = works.has(name);
        const isInDetails = details.has(name);

        // If name is present, try to deduce type
        if (name.length > 0) {
          if (isInDetails && !isInWorks) {
            type = "details";
          } else if (isInWorks && !isInDetails) {
            type = "works";
          } else {
            type = "works"; // default to works if ambiguous but has name
          }
          nameCell.setAttribute("data-type", type);
        } else {
          // Name is empty -> Neutral. Do not set type.
          type = null;
        }
      }

      // Update Icons only if type is known
      if (type === "works") {
        sums.totalWorksSum += sum;
        iconCell.textContent = `🛠️ ${index + 1}`;
      } else if (type === "details") {
        sums.totalDetailsSum += sum;
        iconCell.textContent = `⚙️ ${index + 1}`;
      } else {
        // Neutral
        iconCell.textContent = `${index + 1}`;
      }

      return sums;
    },
    { totalWorksSum: 0, totalDetailsSum: 0 },
  );

  const totalOverallSum = totalWorksSum + totalDetailsSum;

  const set = (id: string, val: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatMoneyMaybeDecimal(val);
  };
  set("total-works-sum", totalWorksSum);
  set("total-details-sum", totalDetailsSum);
  set("total-overall-sum", totalOverallSum);

  updateFinalSumWithAvans();
}

function parseNumber(text: string | null | undefined): number {
  return parseFloat((text ?? "0").replace(/\s/g, "").replace(",", ".")) || 0;
}

// --- ДАНІ ДЛЯ РОЗРАХУНКУ ЗНИЖКИ ---
const discountDataCache = {
  actId: null as number | null,
  receiverWorkPercent: 0,
  receiverPartPercent: 0,
  purchasePrices: new Map<number, number>(), // scladId -> price
  isDataLoaded: false,
  isLoading: false,
};

export function resetDiscountCache() {
  discountDataCache.actId = null;
  discountDataCache.isDataLoaded = false;
  discountDataCache.isLoading = false;
  discountDataCache.purchasePrices.clear();
}

function calculateDiscountBase(overallSum: number): number {
  // Знижка діє на ВЕСЬ чек (загальну суму), а не на маржу
  return overallSum;
}

function updateFinalSumWithAvans(): void {
  const avansInput = document.getElementById(
    "editable-avans",
  ) as HTMLInputElement;
  const discountInput = document.getElementById(
    "editable-discount",
  ) as HTMLInputElement;
  const discountAmountInput = document.getElementById(
    "editable-discount-amount",
  ) as HTMLInputElement;
  const overallSumSpan = document.getElementById("total-overall-sum");
  const avansSubtractDisplay = document.getElementById(
    "avans-subtract-display",
  );
  const finalSumDisplay = document.getElementById("final-sum-display");

  if (
    !avansInput ||
    !overallSumSpan ||
    !avansSubtractDisplay ||
    !finalSumDisplay
  )
    return;

  const avans = parseNumber(avansInput.value);
  const discountPercent = parseNumber(discountInput?.value || "0");
  const overallSum = parseNumber(overallSumSpan.textContent);

  // Розраховуємо БАЗУ для знижки (Загальна - Слюсар - Приймальник - Закупка)
  const discountBase = calculateDiscountBase(overallSum);

  // Визначаємо реальну суму знижки
  let actualDiscountAmount: number;

  if ((window as any).isDiscountAmountManuallySet && discountAmountInput) {
    // Якщо користувач вводив суму вручну - використовуємо її значення
    actualDiscountAmount = parseNumber(discountAmountInput.value);
  } else {
    // Інакше розраховуємо з процента ВІД НОВОЇ БАЗИ
    actualDiscountAmount = roundToKopiyky(
      (discountBase * discountPercent) / 100,
    );
    // Оновлюємо поле суми знижки
    if (discountAmountInput) {
      discountAmountInput.value = formatMoneyMaybeDecimal(actualDiscountAmount);
    }
  }

  const sumAfterDiscount = roundToKopiyky(overallSum - actualDiscountAmount);
  const finalSum = roundToKopiyky(sumAfterDiscount - avans);

  let displayText = "";

  // Спочатку знижка (червона), потім аванс (зелений)
  if (discountPercent > 0 || actualDiscountAmount > 0) {
    displayText += ` - <input type="text" id="editable-discount-amount" class="editable-discount-amount" value="${formatMoneyMaybeDecimal(
      actualDiscountAmount,
    )}" style="color: #d32f2f; font-weight: 700; border: none; background: transparent; width: auto; padding: 0; margin: 0; font-size: inherit;" /> <span style="color: #d32f2f; font-weight: 700;">грн (знижка)</span>`;
  }

  if (avans > 0) {
    displayText += ` - <span style="color: #2e7d32; font-weight: 700;">${formatMoneyMaybeDecimal(
      avans,
    )} грн (аванс)</span>`;
  }

  if (discountPercent > 0 || avans > 0) {
    avansSubtractDisplay.innerHTML = displayText;
    avansSubtractDisplay.style.display = "inline";

    // Додаємо обробник для редагування суми знижки
    if (discountPercent > 0) {
      const discountAmountInput = avansSubtractDisplay.querySelector(
        "#editable-discount-amount",
      ) as HTMLInputElement | null;
      if (discountAmountInput) {
        // Встановлюємо ширину input в залежності від значення
        const autoFitInput = () => {
          const visibleLen = (discountAmountInput.value || "0").length;
          const ch = Math.min(Math.max(visibleLen, 3), 16);
          discountAmountInput.style.width = ch + "ch";
        };
        autoFitInput();

        const onInputDiscount = () => {
          // При вводі НЕ форматуємо - тільки дозволяємо вводити цифри
          // Форматування буде тільки при blur (вихід з інпута)
        };

        const onBlurDiscount = () => {
          let numValue = parseNumber(discountAmountInput.value);

          // Перевіряємо не більша ли сума від загальної суми
          if (numValue > overallSum) {
            numValue = overallSum;
          }

          // Форматуємо число з пробілами
          discountAmountInput.value = formatMoneyMaybeDecimal(numValue);
          autoFitInput();

          const discountInputEl = document.getElementById(
            "editable-discount",
          ) as HTMLInputElement;

          if (discountInputEl && overallSum > 0) {
            // Розраховуємо БАЗУ для зворотного розрахунку
            const currentDiscountBase = calculateDiscountBase(overallSum);

            // Розраховуємо відсоток від бази (якщо база > 0)
            const calculatedPercent =
              currentDiscountBase > 0
                ? (numValue / currentDiscountBase) * 100
                : 0;

            // Заокруглюємо до 0.5 (математичне заокруглювання)
            const roundedToHalf = Math.round(calculatedPercent / 0.5) * 0.5;

            // Встановлюємо розраховані відсотки (максимум 100%)
            const finalPercent = Math.min(roundedToHalf, 100);
            discountInputEl.value = String(finalPercent);

            // Встановлюємо флаг, що сума вводилася вручну
            (window as any).isDiscountAmountManuallySet = true;

            // Оновлюємо відображення напряму, БЕЗ виклику події input
            // (щоб не скинути флаг isDiscountAmountManuallySet)
            updateFinalSumWithAvans();
          }
        };

        const onKeyDownDiscount = (e: KeyboardEvent) => {
          const allowed =
            /\d/.test(e.key) ||
            [
              "Backspace",
              "Delete",
              "ArrowLeft",
              "ArrowRight",
              "Home",
              "End",
              "Tab",
            ].includes(e.key);
          if (!allowed) {
            e.preventDefault();
          }
        };

        discountAmountInput.addEventListener("keydown", onKeyDownDiscount);
        discountAmountInput.addEventListener("input", onInputDiscount);
        discountAmountInput.addEventListener("blur", onBlurDiscount);
      }
    }

    finalSumDisplay.textContent = ` = ${formatMoneyMaybeDecimal(finalSum)} грн`;
    finalSumDisplay.style.color = "#1a73e8";
    finalSumDisplay.style.display = "inline";
  } else {
    avansSubtractDisplay.style.display = "none";
    finalSumDisplay.style.display = "none";
  }
}

export function createTableRow(
  label: string,
  value: string,
  className: string = "",
): string {
  return `<tr><td>${label}</td><td${
    className ? ` class="${className}"` : ""
  }>${value}</td></tr>`;
}

export function createModal(): void {
  const modalOverlay = document.getElementById(ZAKAZ_NARAYD_MODAL_ID);
  if (modalOverlay) return;

  const newModalOverlay = document.createElement("div");
  newModalOverlay.id = ZAKAZ_NARAYD_MODAL_ID;
  newModalOverlay.className = "zakaz_narayd-modal-overlay hidden";
  newModalOverlay.innerHTML = `
    <div class="zakaz_narayd-modal-content">
      <button class="zakaz_narayd-modal-close" id="zakaz-narayd-close-btn">&times;</button>
      <div class="zakaz_narayd-modal-body" id="${ZAKAZ_NARAYD_BODY_ID}"></div>
    </div>`;
  document.body.appendChild(newModalOverlay);

  // Обробник для закриття по кліку на хрестик
  const closeBtn = newModalOverlay.querySelector<HTMLButtonElement>(
    "#zakaz-narayd-close-btn",
  );
  closeBtn?.addEventListener("click", () => closeZakazNaraydModal());

  // ❌ Закриття по кліку на overlay ВИМКНЕНО за запитом користувача
  // Модальне вікно закривається ТІЛЬКИ по кнопці ×
}

/** Функція для закриття модального вікна */
export async function closeZakazNaraydModal(): Promise<void> {
  if (!await confirmActNavigation()) return;
  forgetActEditor();
  invalidateEditorReferences();
  releaseEditorStockSubscription();
  const modalOverlay = document.getElementById(ZAKAZ_NARAYD_MODAL_ID);
  if (modalOverlay) {
    modalOverlay.classList.add("hidden");
    globalCache.currentActId = null;
    // 🐍 Прибираємо змійки підсвічування змін
    cleanupAllSnakeBorders();
    // ✅ Очищуємо приймальника з localStorage при закритті модального вікна
    localStorage.removeItem("current_act_pruimalnyk");
    // 🧹 Очищуємо Realtime підписку на slusarsOn
    cleanupSlusarsOnSubscription();
    // 🧹 Очищуємо кеш розрахунку знижки
    resetDiscountCache();
    // 🔐 Відписуємося від lock + global presence (await для надійного release)
    try {
      await unsubscribeFromActPresence();
    } catch {
      /* silent */
    }
  }
}

/**
 * Генерує HTML skeleton loader для швидкого відображення модалки
 * поки завантажуються реальні дані
 */
export function getSkeletonLoaderHTML(): string {
  return `
    <div class="skeleton-loader">
      <div class="skeleton-loader__header">
        <div class="skeleton-loader__title skeleton-pulse"></div>
        <div class="skeleton-loader__date skeleton-pulse"></div>
      </div>
      
      <div class="skeleton-loader__client-section">
        <div class="skeleton-loader__card">
          <div class="skeleton-loader__card-title skeleton-pulse"></div>
          <div class="skeleton-loader__card-line skeleton-loader__card-line--long skeleton-pulse"></div>
          <div class="skeleton-loader__card-line skeleton-loader__card-line--medium skeleton-pulse"></div>
          <div class="skeleton-loader__card-line skeleton-loader__card-line--short skeleton-pulse"></div>
        </div>
        <div class="skeleton-loader__card">
          <div class="skeleton-loader__card-title skeleton-pulse"></div>
          <div class="skeleton-loader__card-line skeleton-loader__card-line--long skeleton-pulse"></div>
          <div class="skeleton-loader__card-line skeleton-loader__card-line--medium skeleton-pulse"></div>
        </div>
      </div>
      
      <div class="skeleton-loader__table">
        <div class="skeleton-loader__table-header">
          <div class="skeleton-loader__table-header-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-header-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-header-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-header-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-header-cell skeleton-pulse"></div>
        </div>
        <div class="skeleton-loader__table-row">
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
        </div>
        <div class="skeleton-loader__table-row">
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
        </div>
        <div class="skeleton-loader__table-row">
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
          <div class="skeleton-loader__table-cell skeleton-pulse"></div>
        </div>
      </div>
      
      <div class="skeleton-loader__buttons">
        <div class="skeleton-loader__button skeleton-pulse"></div>
        <div class="skeleton-loader__button skeleton-pulse"></div>
        <div class="skeleton-loader__button skeleton-pulse"></div>
      </div>
    </div>
  `;
}

if (!(window as any).__otherBasesHandlerBound__) {
  document.addEventListener("other-base-data-updated", async () => {
    await loadGlobalData();
    const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
    if (container) {
      setupAutocompleteForEditableCells(
        ACT_ITEMS_TABLE_CONTAINER_ID,
        globalCache,
      );
      await refreshQtyWarningsIn(ACT_ITEMS_TABLE_CONTAINER_ID);
      updateCalculatedSumsInFooter();
    }
  });
  (window as any).__otherBasesHandlerBound__ = true;
}
