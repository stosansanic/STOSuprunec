import { isAccountingPaymentBusy } from "./accountingPaymentConfirmation";
import { accountingInitialRows, createAccountingScroll, setAccountingRows, ACCOUNTING_FETCH_BATCH, ACCOUNTING_VISIBLE_STEP } from "./accountingLazyRows";
import { exportPayrollReport } from "./zarplata";
import { exportDetailsReport } from "./poAktam";
import { isCancelled } from "./accountingRequests";
import { readAuditPage, readAuditDetails, cachedAuditDetails, cancelAuditRead } from "./auditRead";
// src/ts/roboha/bukhhalteriya/bukhhalteriya.ts
// Усі повідомлення через showNotification. Без confirm у масовому розрахунку магазину.
import { readAccountingPeriod, accountingSearchScope } from "./accountingPeriod";
import { runMassPaymentCalculation as runMassPaymentCalculationForPodlegle } from "./zarplata";
import { runMassPaymentCalculationForMagazine } from "./shopsBuxha";
import { withMagazineExport } from "./shopsBuxha";
import { runMassPaymentCalculationForDetails } from "./poAktam";
import {
  initializevutratuData,
  updatevutratuTable,
  deleteExpenseRecord,
  clearvutratuForm,
  calculatevutratuTotalSum,
  runMassPaymentCalculationForvutratu,
  withProfitExport,
} from "./prubutok";

import { initAnalityka, refreshAnalityka, searchAnalityka, clearAnalityka, suspendAnalityka } from "./analityka";

import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

import { showModal } from "../zakaz_naraudy/modalMain";
import {
  loadSlyusarsData,
  updatepodlegleTable,
  getFilteredpodlegleData,
  createNameSelect,
  createStatusToggle,
  createPaymentToggle,
  createPercentageToggle,
  handlepodlegleAddRecord,
  deletepodlegleRecord,
  togglepodleglePayment,
  clearpodlegleForm,
} from "./zarplata";

import {
  canUserSeeSkladButton,
  canUserSeeDetailsButton,
  attemptAutoLogin,
  userAccessLevel,
  loadRoleSettingsToCache,
} from "../tablucya/users";

import {
  calculateMagazineTotalSum,
  updateMagazineTable,
  deleteMagazineRecord,
  toggleMagazinePayment,
  clearMagazineForm,
  searchMagazineData,
  createMagazinePaymentToggle,
  createMagazineAvailabilityToggle,
  createShopsSelect,
} from "./shopsBuxha";

import {
  initializeDetailsData,
  calculateDetailsTotalSum,
  updateDetailsTable,
  addDetailsRecord,
  deleteDetailsRecord,
  toggleDetailsPayment,
  clearDetailsForm,
} from "./poAktam";

type TabName =
  | "podlegle"
  | "magazine"
  | "details"
  | "vutratu"
  | "analityka"
  | "audit";

let currentTab: TabName = "magazine";
let selectedRowIndex: number | null = null;

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  return el as T;
}

export function formatNumber(value: number): string {
  return Math.floor(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatDate(dateString: string): string {
  if (!dateString) return "-";
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function calculateTotalSum(): number {
  let total = 0;

  switch (currentTab) {
    case "podlegle":
      const podlegleData = getFilteredpodlegleData();
      total = podlegleData.reduce((sum, item) => sum + (item.total || 0), 0);
      break;
    case "magazine":
      total = calculateMagazineTotalSum();
      break;
    case "details":
      total = calculateDetailsTotalSum();
      break;
    case "vutratu":
      total = calculatevutratuTotalSum();
      break;
  }

  return total;
}

export function updateTotalSum(): void {
  const totalSumElement = byId("total-sum");

  // Для співробітників показуємо спеціальний формат
  if (currentTab === "podlegle") {
    // Викликаємо функцію з pidlehli.ts яка розраховує та відображає три суми
    if (typeof (window as any).updatePodlegleDisplayedSums === "function") {
      (window as any).updatePodlegleDisplayedSums();
    }
    return;
  }

  // Для магазину показуємо спеціальний формат
  if (currentTab === "magazine") {
    // Викликаємо функцію з shopsBuxha.ts яка розраховує та відображає дві суми
    if (typeof (window as any).updateMagazineTotalSum === "function") {
      (window as any).updateMagazineTotalSum();
    }
    return;
  }

  // Для деталей по актам показуємо спеціальний формат
  if (currentTab === "details") {
    // Викликаємо функцію з poAktam.ts яка розраховує та відображає три суми
    if (typeof (window as any).updateDetailsDisplayedSums === "function") {
      (window as any).updateDetailsDisplayedSums();
    }
    return;
  }

  // Для витрат показуємо спеціальний формат
  if (currentTab === "vutratu") {
    // Викликаємо функцію з vutratu.ts яка розраховує та відображає три суми
    if (typeof (window as any).updatevutratuDisplayedSums === "function") {
      (window as any).updatevutratuDisplayedSums();
    }
    return;
  }

  // Для аналітики ховаємо суму
  if (currentTab === "analityka" || currentTab === "audit") {
    if (totalSumElement) {
      totalSumElement.textContent = "";
    }
    return;
  }

  // Fallback для невідомих вкладок
  const total = calculateTotalSum();
  if (totalSumElement) {
    totalSumElement.textContent = `${formatNumber(total)} грн`;
  }
}

let payrollDirectoryScope = '';
let payrollDirectoryPending: Promise<void> | undefined;
function ensurePayrollDirectory(): Promise<void> {
  const scope = accountingSearchScope('payroll');
  if (scope === payrollDirectoryScope) return Promise.resolve();
  if (payrollDirectoryPending) return payrollDirectoryPending;
  const request = loadSlyusarsData(true).then(loaded => { if (loaded && scope === accountingSearchScope('payroll')) payrollDirectoryScope = scope; });
  payrollDirectoryPending = request;
  void request.finally(() => { if (payrollDirectoryPending === request) payrollDirectoryPending = undefined; }).catch(() => {});
  return request;
}

export function switchTab(e: Event | null, tabName: TabName) {
  if (tabName !== "audit") { auditScroll.pause(); cancelAuditRead(); }
  if (tabName !== "analityka") suspendAnalityka();
  currentTab = tabName;
  // Видаляємо активний клас з всіх кнопок вкладок
  const buttons = document.querySelectorAll<HTMLElement>(".Bukhhalter-tab-btn");
  buttons.forEach((button) => button.classList.remove("Bukhhalter-active"));

  // Додаємо активний клас до натиснутої кнопки
  if (e && e.currentTarget) {
    (e.currentTarget as HTMLElement).classList.add("Bukhhalter-active");
  } else {
    // Якщо виклик без івенту (ініціалізація), шукаємо кнопку за id
    const btn = document.getElementById(`tab-btn-${tabName}`);
    if (btn) btn.classList.add("Bukhhalter-active");
  }

  // Видаляємо активний клас з всіх форм
  const sections = document.querySelectorAll<HTMLElement>(
    ".Bukhhalter-form-section",
  );
  sections.forEach((section) => section.classList.remove("Bukhhalter-active"));

  // Додаємо активний клас до обраної форми
  const formSection = byId<HTMLElement>("Bukhhalter-" + tabName + "-section");
  if (formSection) {
    formSection.classList.add("Bukhhalter-active");
  }

  currentTab = tabName;
  updateTableDisplay();
  updateTotalSum();
}

(window as any).switchTab = switchTab;

let financialNavigationBusy = false;
// Open an existing paged report only after an explicit financial-card click.
document.addEventListener('sto:financial-drilldown', event => {
  const detail = (event as CustomEvent).detail;
  const kinds = ['turnover', 'workRevenue', 'partsRevenue', 'expenses', 'payroll'];
  if (currentTab !== 'analityka' || financialNavigationBusy || isAccountingPaymentBusy() ||
      userAccessLevel !== 'Адміністратор' || !detail || !kinds.includes(detail.kind) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(detail.from) || !/^\d{4}-\d{2}-\d{2}$/.test(detail.to) || detail.from > detail.to) return;
  financialNavigationBusy = true;
  const tab: TabName = detail.kind === 'payroll' ? 'podlegle' : detail.kind === 'partsRevenue' ? 'details' : 'vutratu';
  const setValue = (id: string, value: string, notify = false) => {
    const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!element) return;
    element.value = value;
    if (notify) element.dispatchEvent(new Event('change', {bubbles: true}));
  };
  try {
    if (tab === 'podlegle') {
      clearpodlegleForm();
      setValue('details-status-filter-toggle', '0', true);
    } else if (tab === 'details') {
      clearDetailsForm();
      setValue('poAktam-status-filter-toggle', '0', true);
    } else {
      clearvutratuForm();
      setValue('vutratu-type-filter-toggle', detail.kind === 'expenses' ? '1' : '0');
      setValue('vutratu-status-filter-toggle', detail.kind === 'expenses' ? '2' : '0');
    }
    const mode = detail.kind === 'expenses' ? 'open' : 'close';
    document.querySelector<HTMLButtonElement>(`#Bukhhalter-${tab}-section .date-filter-btn[data-filter="${mode}"]`)?.click();
    setValue(`Bukhhalter-${tab}-${tab === 'vutratu' ? 'date-from' : 'date-open'}`, detail.from);
    setValue(`Bukhhalter-${tab}-${tab === 'vutratu' ? 'date-to' : 'date-close'}`, detail.to);
    switchTab(null, tab);
    void addRecord().finally(() => { financialNavigationBusy = false; });
  } catch (error) {
    financialNavigationBusy = false;
    showNotification(error instanceof Error ? error.message : 'Не вдалося відкрити подробиці звіту', 'error');
  }
});

document.addEventListener("DOMContentLoaded", () => {
  // 📱 Реєстрація Service Worker для PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => {
        // console.log('SW registered');
      })
      .catch(() => {
        // console.log('SW registration failed');
      });
  }
});

function updateTableDisplay(): void {
  const controls = document.querySelector<HTMLElement>('.Bukhhalter-control-section');
  if (controls) controls.dataset.activeTab = currentTab;
  const tableTitle = byId<HTMLDivElement>("table-title");
  const magazineContainer = byId<HTMLDivElement>("magazine-table-container");
  const podlegleContainer = byId<HTMLDivElement>("podlegle-table-container");
  const detailsContainer = byId<HTMLDivElement>("details-table-container");
  const vutratuContainer = byId<HTMLDivElement>("vutratu-table-container");
  const analitykaContainer = byId<HTMLDivElement>("analityka-table-container");
  const auditContainer = byId<HTMLDivElement>("audit-table-container");

  if (podlegleContainer) podlegleContainer.style.display = "none";
  if (magazineContainer) magazineContainer.style.display = "none";
  if (detailsContainer) detailsContainer.style.display = "none";
  if (vutratuContainer) vutratuContainer.style.display = "none";
  if (analitykaContainer) analitykaContainer.style.display = "none";
  if (auditContainer) auditContainer.style.display = "none";

  // Показувати/ховати фільтри аудиту
  const auditFilters = byId<HTMLDivElement>("audit-filters");
  if (auditFilters)
    auditFilters.style.display = currentTab === "audit" ? "block" : "none";

  if (currentTab === "magazine") {
    if (tableTitle) tableTitle.innerHTML = "🏪 Дані по складу";
    if (magazineContainer) magazineContainer.style.display = "block";
    updateMagazineTable();
  } else if (currentTab === "podlegle") {
    if (tableTitle) tableTitle.innerHTML = "👨‍🔧 Дані по зарплаті";
    if (podlegleContainer) podlegleContainer.style.display = "block";
    void ensurePayrollDirectory();
    updatepodlegleTable();
  } else if (currentTab === "details") {
    if (tableTitle) tableTitle.innerHTML = "⚙️ Деталі по актам";
    if (detailsContainer) detailsContainer.style.display = "block";
    updateDetailsTable();
  } else if (currentTab === "vutratu") {
    if (tableTitle) tableTitle.innerHTML = "💰 Дані по витратам";
    if (vutratuContainer) vutratuContainer.style.display = "block";
    updatevutratuTable();
  } else if (currentTab === "analityka") {
    if (tableTitle) tableTitle.innerHTML = "📊 Аналітика";
    if (analitykaContainer) analitykaContainer.style.display = "block";
    initAnalityka();
  } else if (currentTab === "audit") {
    if (tableTitle) tableTitle.innerHTML = "📝 Лог дій";
    if (auditContainer) auditContainer.style.display = "block";
    updateAuditTable();
  }

  updateTotalSum();
}

function handleRowClick(index: number): void {
  if (selectedRowIndex !== null) {
    const prevRow = document.querySelector(
      `.Bukhhalter-data-table tbody tr:nth-child(${selectedRowIndex + 1})`,
    );
    if (prevRow) {
      prevRow.classList.remove("selected-row");
    }
  }

  selectedRowIndex = index;
  const currentRow = document.querySelector(
    `.Bukhhalter-data-table tbody tr:nth-child(${index + 1})`,
  );
  if (currentRow) {
    currentRow.classList.add("selected-row");
  }
}

function togglePayment(index: number, type: TabName): void {
  if (type === "podlegle") {
    togglepodleglePayment(index);
  } else if (type === "magazine") {
    toggleMagazinePayment(index);
  } else if (type === "details") {
    toggleDetailsPayment(index);
  }
  updateTotalSum();
}

// Функція для керування станом кнопки пошуку
// Було: setSearchButtonLoading(isLoading: boolean)
// Стало:
function setSearchButtonLoadingEl(
  btn: HTMLButtonElement | null,
  isLoading: boolean,
): void {
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    (btn as any)._origText = btn.textContent || "";
    btn.textContent = "⏳ Завантаження...";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.disabled = false;
    btn.textContent = (btn as any)._origText || "🔍 Пошук";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.removeAttribute("aria-busy");
    delete (btn as any)._origText;
  }
}

// Додай на початок addRecord:
export async function addRecord(e?: Event): Promise<void> {
  e?.preventDefault?.();
  if (isAccountingPaymentBusy()) return;
  if (currentTab === "analityka") { await searchAnalityka(); return; }
  if (["magazine", "podlegle", "details", "vutratu"].includes(currentTab) && !readAccountingPeriod(currentTab)) return;

  // Надійний пошук кнопки:
  const maybeFromEvent = e?.currentTarget as HTMLButtonElement | null;
  const maybeActiveEl =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : null;
  const btn =
    maybeFromEvent ||
    maybeActiveEl ||
    document.querySelector<HTMLButtonElement>("#Bukhhalter-search-button") ||
    null;

  setSearchButtonLoadingEl(btn, true);

  // Each tab checks access in its search entry point.
  try {
    if (currentTab === "podlegle") {
      await handlepodlegleAddRecord();
      updateTotalSum();
      return;
    }
    if (currentTab === "magazine") {
      await searchMagazineData();
      return;
    }
    if (currentTab === "details") {
      await addDetailsRecord();
      return;
    }
    if (currentTab === "vutratu") {
      await (window as any).searchvutratuFromDatabase();
      return;
    }
  } catch (error) {
    // console.error("Помилка при додаванні запису:", error);
    showNotification("Помилка при завантаженні даних", "error");
  } finally {
    setSearchButtonLoadingEl(btn, false);
  }
}

export function deleteRecord(type: TabName, index: number): void {
  if (type === "podlegle") {
    deletepodlegleRecord(index);
  } else if (type === "magazine") {
    deleteMagazineRecord(index);
  } else if (type === "details") {
    deleteDetailsRecord(index);
  } else if (type === "vutratu") {
    deleteExpenseRecord(index);
  }
  updateTotalSum();
}

// Універсальний хелпер (підтримує і textContent, і innerHTML з емодзі)
function setButtonLoadingEl(
  btn: HTMLButtonElement | null,
  isLoading: boolean,
  loadingLabel: string,
  fallbackLabel?: string,
): void {
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    // збережемо вихідну розмітку (емодзі, пробіли)
    (btn as any)._origHTML = btn.innerHTML;
    btn.innerHTML = loadingLabel;
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.disabled = false;
    btn.innerHTML = (btn as any)._origHTML || fallbackLabel || btn.innerHTML;
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    btn.removeAttribute("aria-busy");
    delete (btn as any)._origHTML;
  }
}

// [НОВИЙ КОД]
export function clearForm(): void {
  if (currentTab === "analityka") { clearAnalityka(); return; }
  const activeSection = document.querySelector<HTMLElement>(
    ".Bukhhalter-form-section.Bukhhalter-active",
  );
  if (!activeSection) return;

  // --- ПОЧАТОК ВИПРАВЛЕННЯ ---
  // Викликаємо правильну функцію очищення для кожної вкладки

  if (currentTab === "magazine") {
    clearMagazineForm();
    // Функція clearMagazineForm сама покаже сповіщення
    return;
  }

  if (currentTab === "details") {
    clearDetailsForm();
    // Функція clearDetailsForm сама покаже сповіщення
    return;
  }

  if (currentTab === "vutratu") {
    clearvutratuForm();
    // Функція clearvutratuForm сама покаже сповіщення
    return;
  }

  if (currentTab === "podlegle") {
    if (typeof clearpodlegleForm === "function") {
      // Викликаємо імпортовану функцію з zarplata.ts
      clearpodlegleForm(); // Вона вже містить updateTable та showNotification
    } else {
      // Запасний варіант, якщо імпорт не спрацював
      // console.error("clearpodlegleForm is not imported or not a function");
      const inputs = activeSection.querySelectorAll<HTMLInputElement>(
        "input:not([readonly])",
      );
      inputs.forEach((input) => {
        input.value = "";
      });
      const selects =
        activeSection.querySelectorAll<HTMLSelectElement>("select");
      selects.forEach((select) => {
        select.value = "";
      });
      showNotification("Фільтри очищено (частково)", "info", 1500);
    }
    return; // <--- ВАЖЛИВО
  }
  // --- КІНЕЦЬ ВИПРАВЛЕННЯ ---

  // Цей код не має виконуватись, якщо всі вкладки оброблені
  // console.warn(`Невідома вкладка для очищення: ${currentTab}`);
  const inputs = activeSection.querySelectorAll<HTMLInputElement>(
    "input:not([readonly])",
  );
  inputs.forEach((input) => {
    input.value = "";
  });
  const selects = activeSection.querySelectorAll<HTMLSelectElement>("select");
  selects.forEach((select) => {
    select.value = "";
  });
  updateTotalSum();
  showNotification("Фільтри очищено", "info", 1500);
}

function getCurrentDateForFileName(): string {
  const now = new Date();
  const day = now.getDate().toString().padStart(2, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const year = now.getFullYear();
  return `${day}-${month}-${year}`;
}

// Динамічне завантаження XLSX (CDN) при потребі
let xlsxLoadingPromise: Promise<boolean> | null = null;
function loadXLSXIfNeeded(): Promise<boolean> {
  // Перевіряємо чи бібліотека вже завантажена
  if (typeof (window as any).XLSX !== "undefined") {
    return Promise.resolve(true);
  }

  // Якщо вже йде завантаження - повертаємо існуючий Promise
  if (xlsxLoadingPromise) return xlsxLoadingPromise;

  xlsxLoadingPromise = new Promise<boolean>((resolve) => {
    try {
      // Перевіряємо чи скрипт вже в DOM
      const existing = document.querySelector(
        'script[src*="cdnjs.cloudflare.com/ajax/libs/xlsx"]',
      ) as HTMLScriptElement | null;

      if (existing) {
        // Скрипт є, але бібліотека ще не завантажилась - чекаємо
        let attempts = 0;
        const maxAttempts = 50; // 5 секунд (50 * 100ms)

        const checkInterval = setInterval(() => {
          attempts++;

          if (typeof (window as any).XLSX !== "undefined") {
            clearInterval(checkInterval);
            resolve(true);
            return;
          }

          if (attempts >= maxAttempts) {
            // console.error("❌ Таймаут очікування XLSX");
            clearInterval(checkInterval);
            resolve(false);
          }
        }, 100);

        return;
      }

      // Скрипта немає - додаємо його динамічно
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      script.async = false;
      script.onload = () => {
        setTimeout(() => {
          const loaded = typeof (window as any).XLSX !== "undefined";
          resolve(loaded);
        }, 100);
      };
      script.onerror = () => {
        // console.error("❌ Помилка завантаження скрипта XLSX");
        resolve(false);
      };
      document.head.appendChild(script);
    } catch (error) {
      // console.error("❌ Виняток при завантаженні XLSX:", error);
      resolve(false);
    }
  });

  return xlsxLoadingPromise;
}

type ExcelExportConfig = {
  tableSelector: string;
  missingTableMessage: string;
  emptyMessage: string;
  sheetName: string;
  filePrefix: string;
  successLabel: string;
  excludedHeaders?: string[];
  cellValue?: (
    cell: HTMLTableCellElement | undefined,
    header: string,
  ) => string | undefined;
};

const EXCLUDED_EXCEL_HEADERS = new Set(["Дії"]);

const EXCEL_EXPORT_CONFIGS: Partial<Record<TabName, ExcelExportConfig>> = {
  podlegle: {
    tableSelector: "#podlegle-table",
    missingTableMessage: "Таблиця зарплати не знайдена",
    emptyMessage: "Немає даних для експорту",
    sheetName: "Дані підлеглих",
    filePrefix: "Дані_підлеглих",
    successLabel: "записів зарплати",
    excludedHeaders: ["Ціна"],
    cellValue: getPodlegleExcelCellText,
  },
  magazine: {
    tableSelector: "#magazine-table",
    missingTableMessage: "Таблиця складу не знайдена",
    emptyMessage: "Немає даних складу для експорту",
    sheetName: "Дані складу",
    filePrefix: "Дані_складу",
    successLabel: "записів складу",
  },
  details: {
    tableSelector: "#details-table",
    missingTableMessage: "Таблиця деталей не знайдена",
    emptyMessage: "Немає деталей по актам для експорту",
    sheetName: "Деталі по актам",
    filePrefix: "Деталі_по_актам",
    successLabel: "записів деталей",
  },
  vutratu: {
    tableSelector: "#vutratu-table",
    missingTableMessage: "Таблиця прибутку та витрат не знайдена",
    emptyMessage: "Немає прибутку або витрат для експорту",
    sheetName: "Прибуток та витрати",
    filePrefix: "Прибуток_та_витрати",
    successLabel: "записів прибутку та витрат",
  },
};

function normalizeExcelText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFE0F]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getExcelHeaderText(
  headerCell: HTMLTableCellElement,
  index: number,
): string {
  const textNode =
    headerCell.querySelector<HTMLElement>(".table-header-text") || headerCell;
  const header = normalizeExcelText(textNode.textContent || "");
  return header || `Колонка ${index + 1}`;
}

function getExcelCellText(cell: HTMLTableCellElement | undefined): string {
  if (!cell) return "";
  return normalizeExcelText(cell.innerText || cell.textContent || "");
}

function getPodlegleExcelCellText(
  cell: HTMLTableCellElement | undefined,
  header: string,
): string | undefined {
  if (header !== "Сума" || !cell) return undefined;

  const salary = Number(cell.dataset.excelEarned ?? cell.dataset.excelSalary ?? "");
  if (!Number.isFinite(salary)) return undefined;

  const paid = Number(cell.dataset.excelPaid);
  const due = Number(cell.dataset.excelDue);
  const overpaid = Number(cell.dataset.excelOverpaid);
  const inPeriod = Number(cell.dataset.excelPaidPeriod);
  if (![paid, due, overpaid, inPeriod].every(Number.isFinite)) return formatNumber(Math.abs(salary));
  return [
    cell.dataset.excelPaymentMode === "paid" ? `Виплачено за період: ${formatNumber(inPeriod)}` : null,
    `Нараховано: ${formatNumber(salary)}`,
    `Виплачено всього: ${formatNumber(paid)}`,
    `До виплати: ${formatNumber(due)}`,
    overpaid > 0 ? `Переплата: ${formatNumber(overpaid)}` : null,
  ].filter(Boolean).join("\n");
}

function getExcelTextWidth(value: string): number {
  return Math.max(...value.split(/\r?\n/).map((line) => line.length), 0);
}

function getExcelColumnWidths(headers: string[], rows: string[][]) {
  return headers.map((header, index) => {
    const longestCell = rows.reduce(
      (max, row) => Math.max(max, getExcelTextWidth(row[index] || "")),
      getExcelTextWidth(header),
    );

    return { wch: Math.min(Math.max(longestCell + 2, 10), 45) };
  });
}

function runWhenXLSXReady(callback: () => void): void {
  if (typeof (window as any).XLSX !== "undefined") {
    callback();
    return;
  }

  showNotification("⏳ Завантаження бібліотеки Excel...", "info", 2000);
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  loadXLSXIfNeeded().then((ok) => {
    if (!ok || typeof (window as any).XLSX === "undefined") {
      showNotification(
        "❌ Помилка завантаження бібліотеки Excel. Перевірте інтернет-з'єднання.",
        "error",
        5000,
      );
      return;
    }

    callback();
  });
}

let excelExportBusy = false;
function downloadTableToExcel(config: ExcelExportConfig): void {
  runWhenXLSXReady(() => {
    if (excelExportBusy) return;
    excelExportBusy = true;
    const download = () => {
    const table = document.querySelector<HTMLTableElement>(
      config.tableSelector,
    );

    if (!table) {
      showNotification(config.missingTableMessage, "error");
      return;
    }

    const columns = Array.from(
      table.querySelectorAll<HTMLTableCellElement>("thead th"),
    )
      .map((headerCell, index) => ({
        index,
        header: getExcelHeaderText(headerCell, index),
      }))
      .filter(
        ({ header }) =>
          !EXCLUDED_EXCEL_HEADERS.has(header) &&
          !config.excludedHeaders?.includes(header),
      );

    if (columns.length === 0) {
      showNotification("Немає колонок для експорту", "warning");
      return;
    }

    const bodyRows = Array.from(
      table.querySelectorAll<HTMLTableRowElement>("tbody tr"),
    ).filter((row) => !row.querySelector(".Bukhhalter-no-data"));

    if (bodyRows.length === 0) {
      showNotification(config.emptyMessage, "warning");
      return;
    }

    const headers = columns.map(({ header }) => header);
    const rows = bodyRows.map((row) => {
      const cells = Array.from(row.cells) as HTMLTableCellElement[];
      return columns.map(
        ({ header, index }) =>
          config.cellValue?.(cells[index], header) ??
          getExcelCellText(cells[index]),
      );
    });

    const XLSX = (window as any).XLSX;
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();

    worksheet["!cols"] = getExcelColumnWidths(headers, rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, config.sheetName);
    XLSX.writeFile(
      workbook,
      `${config.filePrefix}_${getCurrentDateForFileName()}.xlsx`,
    );

    showNotification(
      `Експортовано ${rows.length} ${config.successLabel}`,
      "success",
    );
    };
    void (async () => {
      try {
        if (config.tableSelector === '#podlegle-table') await exportPayrollReport(download);
        else if (config.tableSelector === '#details-table') await exportDetailsReport(download);
        else if (config.tableSelector === '#magazine-table') await withMagazineExport(download);
        else if (config.tableSelector === '#vutratu-table') await withProfitExport(download);
        else download();
      } catch (error) {
        showNotification(error instanceof Error ? error.message : 'Не вдалося підготувати повний експорт', 'error');
      } finally { excelExportBusy = false; }
    })();
  });
}

function getActiveBukhhalterTab(): TabName {
  const activeTab = document.querySelector<HTMLElement>(
    ".Bukhhalter-tab-btn.Bukhhalter-active",
  );
  const tabFromButton = activeTab?.id.replace(/^tab-btn-/, "") as
    | TabName
    | undefined;

  if (tabFromButton && tabFromButton in EXCEL_EXPORT_CONFIGS) {
    return tabFromButton;
  }

  const activeSection = document.querySelector<HTMLElement>(
    ".Bukhhalter-form-section.Bukhhalter-active",
  );
  const tabFromSection = activeSection?.id
    .replace(/^Bukhhalter-/, "")
    .replace(/-section$/, "") as TabName | undefined;

  if (tabFromSection && tabFromSection in EXCEL_EXPORT_CONFIGS) {
    return tabFromSection;
  }

  return currentTab;
}

function downloadpodlegleToExcel(): void {
  downloadTableToExcel(EXCEL_EXPORT_CONFIGS.podlegle!);
}

function downloadMagazineToExcel(): void {
  downloadTableToExcel(EXCEL_EXPORT_CONFIGS.magazine!);
}

function downloadDetailsToExcel(): void {
  downloadTableToExcel(EXCEL_EXPORT_CONFIGS.details!);
}

function downloadvutratuToExcel(): void {
  downloadTableToExcel(EXCEL_EXPORT_CONFIGS.vutratu!);
}

export function downloadToExcel(): void {
  try {
    const activeTabName = getActiveBukhhalterTab();

    if (activeTabName === "podlegle") {
      downloadpodlegleToExcel();
    } else if (activeTabName === "magazine") {
      downloadMagazineToExcel();
    } else if (activeTabName === "details") {
      downloadDetailsToExcel();
    } else if (activeTabName === "vutratu") {
      downloadvutratuToExcel();
    } else {
      showNotification(
        "Для цієї вкладки Excel-експорт не налаштований",
        "info",
      );
    }
  } catch (error) {
    // console.error("Помилка при експорті в Excel:", error);
    showNotification("Помилка при створенні Excel файлу", "error", 5000);
  }
}

export async function runMassPaymentCalculation(e?: Event): Promise<void> {
  e?.preventDefault?.();
  if (isAccountingPaymentBusy()) return;

  const maybeFromEvent = e?.currentTarget as HTMLButtonElement | null;
  const maybeActiveEl =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement
      : null;
  const btn =
    maybeFromEvent ||
    maybeActiveEl ||
    document.querySelector<HTMLButtonElement>("#Bukhhalter-calc-button") ||
    document.querySelector<HTMLButtonElement>(".Bukhhalter-save-btn") ||
    null;

  setButtonLoadingEl(btn, true, "⏳ Розрахунок...", "💰 Розрахунок");

  const activeTab = getActiveBukhhalterTab();

  try {
    if (activeTab === 'podlegle') {
      await runMassPaymentCalculationForPodlegle();
    } else if (activeTab === 'magazine') {
      await runMassPaymentCalculationForMagazine();
    } else if (activeTab === 'details') {
      await runMassPaymentCalculationForDetails();
    } else if (activeTab === 'vutratu') {
      await runMassPaymentCalculationForvutratu();
    } else {
      showNotification(
        "Спочатку оберіть вкладку 👨‍🔧 Зарплата, 🏪 Магазин, ⚙️ Деталі або 💰 Прибуток",
        "info",
      );
    }
  } catch (error) {
    // console.error("❌ Помилка виконання масового розрахунку:", error);
    showNotification("❌ Помилка виконання масового розрахунку", "error");
  } finally {
    setButtonLoadingEl(btn, false, "", "💰 Розрахунок");
  }
}

function initializeDateInputs(): void {
  const dateInputs =
    document.querySelectorAll<HTMLInputElement>('input[type="date"]');

  dateInputs.forEach((input) => {
    input.addEventListener("click", function () {
      try {
        (this as any).showPicker?.();
      } catch (e) {
        // console.warn("showPicker not allowed:", e);
      }
    });

    // Removed focus listener to prevent NotAllowedError

    input.addEventListener("change", function () {});
  });
}

// src/ts/roboha/bukhhalteriya/bukhhalteriya.ts

window.addEventListener("load", async function () {
  // Перевіряємо чи це сторінка бухгалтерії - якщо ні, виходимо
  const currentPath = window.location.pathname;
  if (
    !currentPath.includes("bukhhalteriya.html") &&
    !currentPath.endsWith("bukhhalteriya")
  ) {
    return;
  }

  // Перевірка наявності XLSX
  if (typeof (window as any).XLSX !== "undefined") {
  } else {
    // console.warn("⚠️ Бібліотека XLSX НЕ завантажена при ініціалізації");
  }

  // [FIX] Контейнер тепер прихований за замовчуванням через CSS (style="display: none; visibility: hidden;")
  const mainContainer = document.querySelector(
    ".Bukhhalter-container",
  ) as HTMLElement;

  try {
    // 1. Авторизація та визначення ролі
    await attemptAutoLogin();
    await loadRoleSettingsToCache();
    const role = userAccessLevel;

    // 2. Отримуємо посилання на кнопки
    const btnSklad = document.getElementById("tab-btn-magazine");
    const btnZarplata = document.getElementById("tab-btn-podlegle");
    const btnVutratu = document.getElementById("tab-btn-vutratu");
    const btnDetails = document.getElementById("tab-btn-details");
    const btnAnalityka = document.getElementById("tab-btn-analityka");
    const btnAudit = document.getElementById("tab-btn-audit");

    // 3. Логіка відображення кнопок (ХОВАЄМО/ПОКАЗУЄМО)

    // --- Склад ---
    const canSeeSklad = await canUserSeeSkladButton();
    if (btnSklad) {
      btnSklad.style.display = canSeeSklad ? "" : "none";
    }

    // --- Деталі ---
    const canSeeDetails = await canUserSeeDetailsButton();
    if (btnDetails) {
      btnDetails.style.display = canSeeDetails ? "" : "none";
    }

    // --- Зарплата та Прибуток (Тільки Адмін) ---
    const isAdmin = role === "Адміністратор";
    if (btnZarplata) {
      btnZarplata.style.display = isAdmin ? "" : "none";
    }
    if (btnVutratu) {
      btnVutratu.style.display = isAdmin ? "" : "none";
    }
    if (btnAnalityka) {
      btnAnalityka.style.display = isAdmin ? "" : "none";
    }
    if (btnAudit) {
      btnAudit.style.display = isAdmin ? "" : "none";
    }

    // 4. Ініціалізація даних (завантажуємо довідники, селекти тощо)
    // Payroll directory is loaded on first use of its tab.
    initializeDetailsData();
    initializevutratuData();

    createStatusToggle();
    createPaymentToggle();
    createPercentageToggle();
    createNameSelect();

    createMagazinePaymentToggle();
    createMagazineAvailabilityToggle();
    createShopsSelect();

    initializeDateInputs();

    // 5. 🎯 АВТО-КЛІК АБО БЛОКУВАННЯ
    const allTabButtons = document.querySelectorAll<HTMLElement>(
      ".Bukhhalter-tab-btn",
    );
    let firstVisibleTab: HTMLElement | null = null;

    for (let i = 0; i < allTabButtons.length; i++) {
      const btn = allTabButtons[i];
      // Перевіряємо, чи кнопка видима (display != none)
      if (btn && btn.style.display !== "none") {
        firstVisibleTab = btn;
        break; // Знайшли першу, зупиняємось
      }
    }

    if (firstVisibleTab) {
      // [FIX] Якщо є доступні вкладки, показуємо ВЕСЬ контейнер
      if (mainContainer) {
        mainContainer.style.display = "";
        mainContainer.style.visibility = "visible";
      }

      firstVisibleTab.click();

      // 6. Додаткова ініціалізація перемикачів (тільки якщо доступ дозволено)
      setTimeout(() => {
        if (typeof (window as any).initMagazineDateFilterToggle === "function")
          (window as any).initMagazineDateFilterToggle();
        if (typeof (window as any).initPodlegleDateFilterToggle === "function")
          (window as any).initPodlegleDateFilterToggle();
        if (typeof (window as any).initDetailsDateFilterToggle === "function")
          (window as any).initDetailsDateFilterToggle();
        if (typeof (window as any).initvutratuDateFilterToggle === "function")
          (window as any).initvutratuDateFilterToggle();
      }, 200);
    } else {
      // Очищаємо основний контейнер, щоб приховати інтерфейс (хоча він і так прихований, але для надійності)
      if (mainContainer) {
        mainContainer.innerHTML = "";
      }

      // Створюємо повноекранне повідомлення
      const accessDeniedOverlay = document.createElement("div");
      accessDeniedOverlay.id = "access-denied-overlay";
      accessDeniedOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: #f8f9fa; display: flex; flex-direction: column;
        justify-content: center; align-items: center; z-index: 99999;
        font-family: 'Segoe UI', sans-serif; text-align: center;
      `;

      accessDeniedOverlay.innerHTML = `
        <div style="font-size: 64px; margin-bottom: 20px;">⛔</div>
        <h1 style="color: #dc3545; margin: 0 0 10px 0;">Доступ заборонено</h1>
        <p style="color: #555; font-size: 18px; margin-bottom: 30px;">
          У вас немає прав доступу до розділу Бухгалтерія.<br>
          Будь ласка, зверніться до Адміністратора.
        </p>
        <a href="main.html" style="
          padding: 12px 24px; background: #6c757d; color: white;
          text-decoration: none; border-radius: 8px; font-weight: 500;
          transition: background 0.2s;
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        " onmouseover="this.style.background='#5a6268'" onmouseout="this.style.background='#6c757d'">
          🔙 Повернутися на Головну
        </a>
      `;

      document.body.appendChild(accessDeniedOverlay);
    }
  } catch (error) {
    // console.error("❌ Помилка ініціалізації:", error);
  }
});
function openActModal(act: string | number) {
  const id = parseInt(String(act), 10);
  if (!Number.isFinite(id) || id <= 0) {
    showNotification("Некоректний номер акту", "warning");
    return;
  }
  showModal(id, "client");
}

// @ts-ignore
(window as any).openActModal = openActModal;
// @ts-ignore
(window as any).showModal = showModal;

// Глобалізація функцій для HTML
// @ts-ignore
window.switchTab = switchTab;
// @ts-ignore
window.addRecord = addRecord;
// @ts-ignore
window.clearForm = clearForm;
// @ts-ignore
window.downloadToExcel = downloadToExcel;
// @ts-ignore
window.deleteRecord = deleteRecord;
// @ts-ignore
window.handleRowClick = handleRowClick;
// @ts-ignore
window.togglePayment = togglePayment;
// @ts-ignore
window.runMassPaymentCalculation = runMassPaymentCalculation;
// @ts-ignore
window.refreshAnalityka = refreshAnalityka;

/**
 * 📝 Завантажує та відображає лог дій (Аудит)
 */

let auditRawData: any[] = [];
let auditActiveCategory = "all";

/** Визначити категорію з details._category або з назви action */
function resolveCategory(log: any): string {
  if (log.details?._category) return log.details._category;
  const a = log.action || "";
  if (
    a.startsWith("act_") ||
    [
      "open_act",
      "close_act",
      "freeze_act",
      "unfreeze_act",
      "update_act_items",
      "update_act_info",
    ].includes(a)
  )
    return "act";
  if (a.startsWith("planning_")) return "planning";
  if (a.startsWith("client_") || a.startsWith("car_")) return "client";
  if (
    a.startsWith("settings_") ||
    a.startsWith("db_edit_slyusars") ||
    a.startsWith("db_delete_slyusars") ||
    a.startsWith("db_add_slyusars")
  )
    return "settings";
  if (
    a.startsWith("warehouse_") ||
    a.startsWith("db_edit_") ||
    a.startsWith("db_delete_") ||
    a.startsWith("db_add_")
  )
    return "warehouse";
  if (a === "act_create") return "order";
  return "act";
}

const ACTION_MAP: Record<string, { text: string; cls: string }> = {
  close_act: { text: "🔒 Закрив акт", cls: "status-closed" },
  open_act: { text: "🗝️ Відкрив акт", cls: "status-open" },
  freeze_act: { text: "🧊 Заморозив акт", cls: "status-closed" },
  unfreeze_act: { text: "☀️ Розморозив акт", cls: "status-open" },
  update_act_items: { text: "✏️ Змінив рядки", cls: "status-update" },
  update_act_info: { text: "ℹ️ Оновив інфо", cls: "status-info" },
  act_create: { text: "📋 Створив наряд", cls: "status-open" },
  client_create: { text: "👤 Новий клієнт", cls: "status-open" },
  client_edit: { text: "✏️ Ред. клієнта", cls: "status-update" },
  car_add: { text: "🚗 Додав авто", cls: "status-open" },
  car_edit: { text: "✏️ Ред. авто", cls: "status-update" },
  car_delete: { text: "🗑️ Видалив авто", cls: "status-closed" },
  planning_create: { text: "📅 Новий запис", cls: "status-open" },
  planning_edit: { text: "✏️ Редагування", cls: "status-update" },
  planning_delete: { text: "🗑️ Видалив запис", cls: "status-closed" },
  planning_reschedule: { text: "🔄 Переміщення", cls: "status-update" },
  planning_resize: { text: "↔️ Зміна часу", cls: "status-update" },
  settings_add_category: { text: "➕ Нова категорія", cls: "status-open" },
  settings_edit_category: { text: "✏️ Ред. категорію", cls: "status-update" },
  settings_delete_category: {
    text: "🗑️ Видалив категорію",
    cls: "status-closed",
  },
  settings_add_post: { text: "➕ Новий пост", cls: "status-open" },
  settings_edit_post: { text: "✏️ Ред. пост", cls: "status-update" },
  settings_delete_post: { text: "🗑️ Видалив пост", cls: "status-closed" },
  act_pdf: { text: "📄 Створив PDF", cls: "status-info" },
  act_sms: { text: "📨 Надіслав SMS", cls: "status-info" },
  act_drive_folder: { text: "📁 Google Drive", cls: "status-info" },
  act_copy: { text: "📋 Копія акту", cls: "status-open" },
  // Склад
  warehouse_add: { text: "➕ Додав на склад", cls: "status-open" },
  warehouse_edit: { text: "✏️ Ред. склад", cls: "status-update" },
  warehouse_delete: { text: "🗑️ Видалив зі складу", cls: "status-closed" },
  warehouse_add_shop: { text: "➕ Новий магазин", cls: "status-open" },
  warehouse_edit_shop: { text: "✏️ Ред. магазин", cls: "status-update" },
  warehouse_delete_shop: { text: "🗑️ Видалив магазин", cls: "status-closed" },
  warehouse_add_detail: { text: "➕ Нова деталь", cls: "status-open" },
  warehouse_edit_detail: { text: "✏️ Ред. деталь", cls: "status-update" },
  warehouse_delete_detail: { text: "🗑️ Видалив деталь", cls: "status-closed" },
  warehouse_add_contragent: { text: "➕ Новий контрагент", cls: "status-open" },
  warehouse_edit_contragent: {
    text: "✏️ Ред. контрагента",
    cls: "status-update",
  },
  warehouse_delete_contragent: {
    text: "🗑️ Видалив контрагента",
    cls: "status-closed",
  },
  warehouse_add_work: { text: "➕ Нова робота", cls: "status-open" },
  warehouse_excel_import: { text: "📊 Excel імпорт", cls: "status-info" },
  // Довідники через модалку all_other_bases
  settings_edit_worker: { text: "✏️ Ред. працівника", cls: "status-update" },
  db_add_slyusars: { text: "➕ Додано працівника", cls: "status-open" },
  db_delete_slyusars: { text: "🗑️ Видалено працівника", cls: "status-closed" },
  db_edit_slyusars: { text: "✏️ Ред. працівника", cls: "status-update" },
};

const CATEGORY_LABELS: Record<string, { emoji: string; name: string }> = {
  act: { emoji: "🔧", name: "Акт" },
  order: { emoji: "📋", name: "Наряд" },
  client: { emoji: "👥", name: "Клієнт" },
  planning: { emoji: "📅", name: "Планув." },
  settings: { emoji: "⚙️", name: "Налашт." },
  warehouse: { emoji: "📦", name: "Склад" },
};

/** Форматує число з пробілами між тисячними: 20000 → "20 000" */
function fmtNum(v: string | number): string {
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s.replace(/\s/g, ""))) return s;
  const [int, dec] = s.split(".");
  const formatted = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return dec !== undefined ? `${formatted}.${dec}` : formatted;
}

function formatChangeStr(s: string): string {
  const idx = s.indexOf(" → ");
  if (idx === -1) return s;
  const labelEnd = s.indexOf(": ");
  if (labelEnd === -1)
    return `<span class='log-old'>${fmtNum(s.substring(0, idx))}</span> → <span class='log-new'>${fmtNum(s.substring(idx + 3))}</span>`;
  const label = s.substring(0, labelEnd + 2);
  const oldVal = s.substring(labelEnd + 2, idx);
  const newVal = s.substring(idx + 3);
  return `${label}<span class='log-old'>${fmtNum(oldVal)}</span> → <span class='log-new'>${fmtNum(newVal)}</span>`;
}

function buildDetailsHtml(log: any): string {
  const d = log.details;
  if (!d) return "-";
  const parts: string[] = [];

  // added / deleted — без слів "Додано"/"Видалено", тільки емодзі + назви
  if (d.added?.length) {
    parts.push(
      `<div class='log-added' style='color:#2e7d32'>➕ ${d.added.map((i: any) => i.name).join(", ")}</div>`,
    );
  }
  if (d.deleted?.length) {
    parts.push(
      `<div class='log-deleted' style='color:#d32f2f'>🗑️ ${d.deleted.map((i: any) => i.name).join(", ")}</div>`,
    );
  }
  // modified (price/qty/slyusar changes) — з кольорами: синій = було, червоний = стало
  if (d.modified?.length) {
    for (const m of d.modified) {
      const coloredChanges = m.changes.map((c: string) => formatChangeStr(c));
      parts.push(
        `<div class='log-modified'>✏️ ${m.name}: ${coloredChanges.join("; ")}</div>`,
      );
    }
  }
  // changes array — warehouse edit (object[]) або client/car edit (string[])
  if (d.changes?.length) {
    if (typeof d.changes[0] === "string") {
      if (log.action === "warehouse_excel_import") {
        const lines = d.changes
          .map((change: string, idx: number) => {
            const suffix = idx < d.changes.length - 1 ? ";" : "";
            return `<div class='log-excel-line'>${change}${suffix}</div>`;
          })
          .join("");
        parts.push(`<div class='log-modified log-excel-import'>${lines}</div>`);
      } else {
        parts.push(`<div class='log-modified'>📝 ${d.changes.join("; ")}</div>`);
      }
    } else {
      for (const ch of d.changes) {
        parts.push(
          `<div class='log-modified'>✏️ ${ch.field}: <span class='log-old'>${fmtNum(ch.old)}</span> → <span class='log-new'>${fmtNum(ch.new)}</span></div>`,
        );
      }
    }
  }
  // single-field info
  if (d.shops) parts.push(`<span>🏪 ${d.shops}</span>`);
  if (d.client) parts.push(`<span>👤 ${d.client}</span>`);
  if (d.car) parts.push(`<span>🚗 ${d.car}</span>`);
  if (d.status) parts.push(`<span>📌 ${d.status}</span>`);
  if (d.name) parts.push(`<span>${d.name}</span>`);
  if (d.phone) parts.push(`<span>📞 ${d.phone}</span>`);
  if (d.auto) parts.push(`<span>🚗 ${d.auto} ${d.number || ""}</span>`);
  if (d.reason) parts.push(`<span>📝 ${d.reason}</span>`);
  if (d.post) parts.push(`<span>📌 ${d.post}</span>`);
  if (d.category && !d.post) parts.push(`<span>📁 ${d.category}</span>`);
  if (d.time) parts.push(`<span>🕐 ${d.time}</span>`);
  if (d.date && !d.date_off) parts.push(`<span>📅 ${d.date}</span>`);
  if (d.date_off) {
    // Не показуємо date_off — дата вже є в стовпці "Дата"
  }
  if (d.totalSum !== undefined)
    parts.push(`<span>💰 ${fmtNum(d.totalSum)} грн</span>`);
  if (d.driveUrl)
    parts.push(
      `<span>🔗 <a href="${d.driveUrl}" target="_blank" rel="noopener">Папка</a></span>`,
    );
  if (d.source_act_id) parts.push(`<span>📋 з Акту №${d.source_act_id}</span>`);
  if (d.new_time) parts.push(`<span>🕐 ${d.new_time}</span>`);
  // warehouse / settings fields
  if (d.part_number) parts.push(`<span>🔢 ${d.part_number}</span>`);
  if (d.table) parts.push(`<span>📁 ${d.table}</span>`);
  if (d.id && !d.source_act_id) parts.push(`<span>#${d.id}</span>`);
  if (d.access) parts.push(`<span>🔑 ${d.access}</span>`);
  if (d.oderjyvach) parts.push(`<span>📬 ${d.oderjyvach}</span>`);
  if (d.work_id) parts.push(`<span>🛠️ #${d.work_id}</span>`);
  // excel batch
  if (d.success !== undefined) parts.push(`<span>✅ ${d.success}</span>`);
  if (d.errors) parts.push(`<span>❌ ${d.errors}</span>`);
  if (d.skipped) parts.push(`<span>⏭️ ${d.skipped}</span>`);

  return parts.length ? parts.join(" ") : "-";
}

function renderAuditRows(data: any[]): void {
  const container = byId("audit-logs-list");
  if (!container) return;

  const result = data;

  if (result.length === 0) {
    container.innerHTML =
      '<div class="Bukhhalter-no-data">Логів за цим фільтром немає</div>';
    return;
  }

  let html = `
    <table class="Bukhhalter-data-table audit-table">
      <thead>
        <tr>
          <th>📅 Дата</th>
          <th>👤 Користувач</th>
          <th>⚡ Система</th>
          <th>🎯 Дія</th>
          <th>📋 Акт №</th>
          <th>📝 Виконано</th>
        </tr>
      </thead>
      <tbody>
  `;

  result.forEach((log: any) => {
    const d = new Date(log.created_at);
    const datePart = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(-2)}`;
    const timePart = d.toLocaleTimeString("uk-UA", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const cat = resolveCategory(log);
    const catInfo = CATEGORY_LABELS[cat] || { emoji: "❓", name: cat };
    const actionInfo = ACTION_MAP[log.action] || { text: log.action, cls: "" };
    const detailsHtml = cachedAuditDetails(String(log.id)) ? buildDetailsHtml({...log, details: cachedAuditDetails(String(log.id))}) : `<button type="button" data-audit-details="${Number(log.id)}">Переглянути</button>`;

    html += `
      <tr>
        <td>${datePart}<br>${timePart}</td>
        <td><span style="font-weight:bold">${log.user_login}</span><br><span class="role-badge role-${log.user_role}">${log.user_role}</span></td>
        <td><span class="cat-badge cat-${cat}">${catInfo.emoji} ${catInfo.name}</span></td>
        <td><span class="action-label ${actionInfo.cls}">${actionInfo.text}</span></td>
        <td>${log.act_id ? `<button class="Bukhhalter-act-btn" onclick="event.stopPropagation(); openActModalWithClient(${log.act_id})" title="Відкрити акт №${log.act_id}">📋 ${log.act_id}</button>` : "-"}</td>
        <td style="font-size: 12px;">${detailsHtml}</td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  const staging = document.createElement("div"); staging.innerHTML = html;
  const body = container.querySelector("tbody");
  if (body) setAccountingRows(body, staging.querySelector("tbody")!.innerHTML);
  else container.innerHTML = html;
}

const auditScroll = createAccountingScroll("audit-logs-list", () => updateAuditTable(false, true));
let auditLoading = false;
let auditGeneration = 0;
let auditVisibleCount = 0;
let auditHasMore = false;
let auditFilterKey = '';
let auditReadScope = '';

function updateAuditScrollStatus(): void {
  auditScroll.update({more: auditHasMore || auditVisibleCount < auditRawData.length, busy: auditLoading,
    shown: Math.min(auditVisibleCount, auditRawData.length)});
}

function renderAuditView(): void {
  const container = byId('audit-logs-list');
  if (!container) return;
  renderAuditRows(auditRawData.slice(0, auditVisibleCount));
  container.querySelectorAll<HTMLButtonElement>('[data-audit-details]').forEach(button => {
    button.onclick = async () => {
      const id = button.dataset.auditDetails!, row = auditRawData.find(value => String(value.id) === id);
      if (!row) return; button.disabled = true;
      try {
        const details = await readAuditDetails(id);
        if (button.isConnected) button.parentElement!.innerHTML = buildDetailsHtml({...row, details});
      } catch { button.disabled = false; showNotification('Не вдалося завантажити подробиці', 'error'); }
    };
  });
  updateAuditScrollStatus();
}

async function updateAuditTable(force = false, more = false): Promise<void> {
  const container = byId('audit-logs-list'); if (!container || (more && auditLoading)) return;
  const filter = {category: auditActiveCategory, user: byId<HTMLSelectElement>('audit-user-filter')?.value || '', role: byId<HTMLSelectElement>('audit-role-filter')?.value || '',
    from: byId<HTMLInputElement>('audit-date-from')?.value || '', to: byId<HTMLInputElement>('audit-date-to')?.value || ''};
  if (filter.from && filter.to && filter.from > filter.to) { auditScroll.pause(); showNotification('Дата «До» має бути не раніше дати «Від».', 'warning'); return; }
  const filterKey = JSON.stringify(filter), scope = accountingSearchScope();
  if (more && (filterKey !== auditFilterKey || scope !== auditReadScope)) more = false;
  if (more && auditVisibleCount < auditRawData.length) {
    auditVisibleCount = Math.min(auditVisibleCount + ACCOUNTING_VISIBLE_STEP, auditRawData.length);
    renderAuditView(); return;
  }
  const generation = ++auditGeneration;
  const visibleTarget = more ? auditVisibleCount + ACCOUNTING_VISIBLE_STEP : accountingInitialRows('audit-logs-list');
  if (!more) { auditScroll.reset(); auditHasMore = false; }
  auditLoading = true;
  let loaded = false;
  try {
    const page = await readAuditPage(filter, force, more, more ? ACCOUNTING_FETCH_BATCH : visibleTarget);
    if (generation !== auditGeneration || currentTab !== 'audit') return;
    auditRawData = page.rows.map(row => ({...row, details: {_category: row.category}}));
    auditVisibleCount = Math.min(visibleTarget, auditRawData.length);
    auditHasMore = page.more; auditFilterKey = filterKey; auditReadScope = scope;
    populateAuditUserFilter(page.users.map(user_login => ({user_login})));
    populateAuditRoleFilter(page.roles.map(user_role => ({user_role})));
    renderAuditView(); loaded = true;
  } catch (error) {
    if (!isCancelled(error) && generation === auditGeneration) showNotification(error instanceof Error ? error.message : 'Не вдалося завантажити журнал', 'error');
    if (more && generation === auditGeneration) throw error;
  } finally {
    if (generation === auditGeneration) { auditLoading = false; if (loaded) updateAuditScrollStatus(); }
  }
}

// @ts-ignore
window.updateAuditTable = () => updateAuditTable(true);

/** Фільтрація по категоріям (чіпси) */
function toggleAuditFilter(btn: HTMLElement): void {
  const category = btn.dataset.category || "all";
  auditActiveCategory = category;
  // Update active chip
  document
    .querySelectorAll(".audit-chip")
    .forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  void updateAuditTable();
}
// @ts-ignore
window.toggleAuditFilter = toggleAuditFilter;

/** Заповнити випадаючий список користувачів */
function populateAuditUserFilter(data: any[]): void {
  const sel = byId<HTMLSelectElement>("audit-user-filter");
  if (!sel) return;
  const current = sel.value;
  const users = [...new Set(data.map((l) => l.user_login))].sort();
  sel.innerHTML =
    '<option value="">-- Всі --</option>' +
    users
      .map(
        (u) =>
          `<option value="${u}"${u === current ? " selected" : ""}>${u}</option>`,
      )
      .join("");
}

/** Заповнити випадаючий список ролей */
function populateAuditRoleFilter(data: any[]): void {
  const sel = byId<HTMLSelectElement>("audit-role-filter");
  if (!sel) return;
  const current = sel.value;
  const roles = [...new Set(data.map((l) => l.user_role))].sort();
  sel.innerHTML =
    '<option value="">-- Всі --</option>' +
    roles
      .map(
        (r) =>
          `<option value="${r}"${r === current ? " selected" : ""}>${r}</option>`,
      )
      .join("");
}

/** Застосувати додаткові фільтри */
function applyAuditExtraFilters(): void {
  void updateAuditTable();
}
// @ts-ignore
window.applyAuditExtraFilters = applyAuditExtraFilters;
