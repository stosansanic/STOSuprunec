import { announceAccountingChange, accountingSearchScope } from "./accountingPeriod";
import { patchPayrollReportPayments, reconcilePayrollReportPayments } from "./payrollReportRead";
import { confirmAccountingPayment, withAccountingPaymentOperation } from "./accountingPaymentConfirmation";
import { getPayrollPaymentState, getPayrollPaymentInPeriod, applyPayrollPayment } from "../../utils/payrollPayments";
import { readPayrollDirectory } from "./payrollDirectory";
import { updatePayrollRecoveryBanner } from "./payrollRecoveryUI";
import { readPayrollReport, readAllPayrollReport, clearPayrollReportCache, type PayrollReportPage, type PayrollReportFilters } from "./payrollReportRead";
import { accountingInitialRows, createAccountingScroll, setAccountingRows, withAccountingExportRows, accountingVisibleRows, ACCOUNTING_FETCH_BATCH, ACCOUNTING_VISIBLE_STEP } from "./accountingLazyRows";
import { mergePayrollReportEmployees, payrollReportWork, payrollReportWorkIndex } from "./payrollReportFragments";
import { savePayrollReportPayments } from "./payrollReportPaymentWrite";
import { accountingToday, readAccountingPeriod } from "./accountingPeriod";
// src\ts\roboha\bukhhalteriya\zarplata.ts
import { trackPayrollData, payrollEmployeeId, assertPayrollHistory } from "../../utils/payrollSafeWrite";
import { formatDate, formatNumber, byId } from "./bukhhalteriya";
import {
  getSavedUserDataFromLocalStorage,
  userAccessLevel,
} from "../tablucya/users";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { checkCurrentPageAccess } from "../zakaz_naraudy/inhi/page_access_guard";
import { redirectToIndex } from "../../utils/gitUtils";
import type { ActAccountingStatus } from "./actAccountingStatus";
import {
  resolveActDateClose,
  resolveIsActClosed,
} from "./actAccountingStatus";

const FULL_ACCESS_ALIASES = ["адміністратор", "full", "admin", "administrator"];

function getCurrentAccessLevel(): string {
  const fromVar =
    (typeof userAccessLevel === "string" ? userAccessLevel : "") || "";
  const fromLS = getSavedUserDataFromLocalStorage?.() || null;

  const level = (fromVar || fromLS?.access || (fromLS as any)?.["Доступ"] || "")
    .toString()
    .normalize("NFKC")
    .trim()
    .toLowerCase();

  return level;
}

function hasFullAccess(): boolean {
  return FULL_ACCESS_ALIASES.includes(getCurrentAccessLevel());
}

type PaymentFilter = "paid" | "unpaid" | "all";
type StatusFilter = "closed" | "open" | "all";
type PercentageFilter = "higher" | "lower" | "all";

export interface PodlegleRecord {
  employeeId?: number;
  dateOpen: string;
  dateClose: string;
  name: string;
  act: string;
  client: string;
  automobile: string;
  work: string;
  quantity: number;
  price: number;
  total: number;
  salary: number;
  margin: number;
  isClosed: boolean;
  isPaid: boolean;
  paymentDate?: string;
  paidAmount?: number;
  due?: number;
  overpaid?: number;
  paidInPeriod?: number;
  hasPayments?: boolean;
  hasLedger?: boolean;
  recordedDate?: string; // ✅ Додано: дата створення запису
  customHtmlTotal?: string; // ✅ Додано для кастомного відображення суми
  workIndex?: number; // ✅ Додано: індекс роботи в масиві Записи для точного пошуку
  recordId?: string; // ✅ Додано: унікальний ID запису для найточнішого пошуку
}

interface SlyusarData {
  Name: string;
  ПроцентРоботи?: number;
  Історія: {
    [date: string]: Array<{
      Акт: string;
      Записи?: Array<{
        Ціна: number;
        Робота: string;
        Кількість: number;
        Зарплата?: number;
        Розраховано?: string;
        Записано?: string; // ✅ Додано: дата створення запису
        recordId?: string; // ✅ Додано: унікальний ID для точного пошуку
      }>;
      Клієнт?: string;
      Автомобіль?: string;
      СуммаРоботи: number;
      ДатаЗакриття: string | null;
      // ✅ Нові поля для Приймальника
      СуммаЗапчастин?: number;
      МаржаДляЗарплати?: number; // Маржа запчастин БЕЗ свого складу (для розрахунку ЗарплатаЗапчастин)
      ЗарплатаРоботи?: number;
      ЗарплатаЗапчастин?: number;
      ЗарплатаЗапчастистів?: number; // Сума зарплат всіх Запчастистів по цьому акту
      Розраховано?: string;
      Знижка?: number; // Відсоток знижки
    }>;
  };
}

export let podlegleData: PodlegleRecord[] = [];
let slyusarsData: SlyusarData[] = [];
let availableNames: string[] = [];
let currentPaymentFilter: PaymentFilter = "all";
let currentPercentageFilter: PercentageFilter = "all";

// Кеш для процентів роботи слюсарів (Name -> ПроцентРоботи)
let slyusarPercentCache: Map<string, number> = new Map();

// 🔹 Кеш для дат закриття актів (act_id → date_off з таблиці acts)
let actAccountingStatuses: Map<string, ActAccountingStatus> = new Map();
let frozenActIds: Set<string> = new Set();

// 🔹 Хелпер для отримання дати закриття акту (пріоритет: acts.date_off, fallback: slyusars.Історія.ДатаЗакриття)
function getActDateClose(actId: string, fallbackDate: string | null): string {
  return resolveActDateClose(actAccountingStatuses, actId, fallbackDate);
}

// 🔹 Хелпер для перевірки чи акт закритий
function isActClosed(actId: string, fallbackDate: string | null): boolean {
  return resolveIsActClosed(actAccountingStatuses, actId, fallbackDate);
}

// Функція для отримання процента роботи слюсаря за ім'ям
function getSlyusarPercentByName(name: string): number {
  if (!name) return 0;
  return slyusarPercentCache.get(name.toLowerCase()) || 0;
}

function payrollRecordSettlement(target: any, parent: any, from: string, to: string) {
  const state = getPayrollPaymentState(target, parent);
  const period = getPayrollPaymentInPeriod(target, parent, toIsoDate(from), toIsoDate(to));
  return {
    salary: state.earned, paidAmount: state.paidAmount, due: state.due, overpaid: state.overpaid,
    paidInPeriod: period.amount, hasPayments: state.hasPayments, hasLedger: state.hasLedger,
    isPaid: state.isPaid, paymentDate: (podlegleDateFilterMode === "paid" ? period.date : state.paymentDate) || "",
  };
}

let currentStatusFilter: StatusFilter = "all";

let lastSearchDateOpen: string = "";
let lastSearchDateClose: string = "";

// НОВІ ЗМІННІ ДЛЯ АВТОФІЛЬТРАЦІЇ РОБІТ
let allPodlegleData: PodlegleRecord[] = [];
let hasPodlegleDataLoaded = false;
let payrollReport: PayrollReportPage | null = null;
let payrollReportGeneration = 0;
let payrollReportLoading = false;
let payrollSearchFailed = false;
let payrollReportFilterKey = "";
let payrollReportOwner = "";
let payrollReportScope = '';
let payrollQuiet = false;
let payrollVisibleCount = 0;
const hiddenPayrollKeys = new Set<string>();
const payrollRowKey = (row: PodlegleRecord) => JSON.stringify([row.employeeId, row.dateOpen, String(row.act), row.workIndex ?? null]);
const payrollScroll = createAccountingScroll('podlegle-tbody', showMorePayrollRows);

async function showMorePayrollRows(): Promise<void> {
  if (payrollReportLoading || payrollPaymentInFlight) { updatePayrollPager(); return; }
  if (payrollReportFilterKey !== JSON.stringify(currentPayrollFilters()) || payrollReportScope !== accountingSearchScope('payroll')) {
    await loadPayrollReportPage(0); return;
  }
  if (payrollVisibleCount < podlegleData.length) {
    payrollVisibleCount = Math.min(payrollVisibleCount + ACCOUNTING_VISIBLE_STEP, podlegleData.length);
    updatepodlegleTable(); updatePayrollPager(); return;
  }
  await loadPayrollReportPage(payrollReport?.keys.length || 0, true);
}

function currentPayrollFilters(): PayrollReportFilters {
  const value = (id: string) => byId<HTMLInputElement>(`Bukhhalter-podlegle-${id}`)?.value.trim() || "";
  const from = value("date-open"), to = value("date-close");
  return { name: value("name-select"), from: toIsoDate(from), to: toIsoDate(to) || accountingToday(),
    mode: podlegleDateFilterMode, act: value("act-select"), work: value("work-input"), payment: currentPaymentFilter,
    status: currentStatusFilter, percentage: currentPercentageFilter };
}
function applyPayrollReport(page: PayrollReportPage, quiet = false): void {
  payrollReport = page;
  payrollReportFilterKey = JSON.stringify(currentPayrollFilters());
  payrollReportOwner = localStorage.getItem("userAuthData") || "";
  payrollReportScope = accountingSearchScope('payroll');
  slyusarsData = page.employees.map(row => trackPayrollData(row.slyusar_id, row.data));
  actAccountingStatuses = new Map(page.statuses.map(status => [String(status.actId), status]));
  frozenActIds.clear();
  for (const employee of slyusarsData) slyusarPercentCache.set(employee.Name.toLowerCase(), Number(employee.ПроцентРоботи) || 0);
  const filters = currentPayrollFilters();
  payrollQuiet = quiet;
  try { searchDataInDatabase(filters.from, filters.to, filters.name); }
  finally { payrollQuiet = false; }
}
function updatePayrollPager(): void {
  payrollScroll.update({more: !payrollSearchFailed && (!!payrollReport?.has_more || payrollVisibleCount < podlegleData.length), busy: payrollReportLoading || payrollPaymentInFlight,
    shown: Math.min(payrollVisibleCount, podlegleData.length), total: payrollReport?.total});
}
function mergePayrollPages(first: PayrollReportPage, next: PayrollReportPage): PayrollReportPage {
  const employees = mergePayrollReportEmployees([...first.employees, ...next.employees]);
  const keys = [...first.keys, ...next.keys];
  const changedTotals = (["salary", "revenue", "paidAmount", "due", "overpaid", "paidInPeriod"] as const)
    .some(field => !Number.isFinite(first[field]) || !Number.isFinite(next[field]) || Math.abs(first[field] - next[field]) > 0.000001);
  if (!employees || first.revision !== next.revision || first.total !== next.total || changedTotals ||
      new Set(keys.map(key => JSON.stringify(key))).size !== keys.length) throw new Error('Зарплата змінилася під час прокрутки. Повторіть пошук.');
  return {...next, employees, keys, statuses: [...new Map([...first.statuses, ...next.statuses].map(row => [String(row.actId), row])).values()]};
}
async function loadPayrollReportPage(offset = 0, append = false, preserveCount = false): Promise<void> {
  if (payrollPaymentInFlight || (append && payrollReportLoading)) return;
  if (append && payrollReport && !payrollReport.revision) {
    await loadPayrollReportPage(0, false, true);
    return;
  }
  if (!readAccountingPeriod("podlegle")) { payrollReportGeneration++; payrollScroll.reset(); return; }
  const generation = ++payrollReportGeneration;
  const owner = localStorage.getItem("userAuthData") || "";
  const filters = currentPayrollFilters();
  if (append && (!payrollReport || payrollReportFilterKey !== JSON.stringify(filters) || payrollReportOwner !== owner)) { payrollScroll.pause(); return; }
  if (append && payrollReportScope !== accountingSearchScope('payroll')) { await loadPayrollReportPage(0); return; }
  const target = preserveCount ? payrollReport?.keys.length || 0 : 0;
  const visibleTarget = append ? payrollVisibleCount + ACCOUNTING_VISIBLE_STEP : preserveCount ? payrollVisibleCount : accountingInitialRows('podlegle-tbody');
  if (!append) { payrollScroll.reset(); if (!preserveCount) hiddenPayrollKeys.clear(); }
  payrollSearchFailed = false; payrollReportLoading = true; updatePayrollPager();
  const current = () => generation === payrollReportGeneration && owner === (localStorage.getItem("userAuthData") || "") && JSON.stringify(filters) === JSON.stringify(currentPayrollFilters());
  try {
    let page = await readPayrollReport(filters, offset, undefined, append ? ACCOUNTING_FETCH_BATCH : visibleTarget);
    if (!current()) return;
    if (append && payrollReport) page = mergePayrollPages(payrollReport, page);
    while (!append && page.has_more && page.keys.length < target) {
      const next = await readPayrollReport(filters, page.keys.length, undefined, Math.min(200, target - page.keys.length));
      if (!current()) return;
      page = mergePayrollPages(page, next);
    }
    payrollVisibleCount = Math.min(visibleTarget, page.keys.length);
    applyPayrollReport(page, append || preserveCount);
  } catch (error) {
    if (generation === payrollReportGeneration) showNotification(error instanceof Error ? error.message : String(error), "error", 6000);
    if (!append) { payrollSearchFailed = true; payrollScroll.pause(); }
    else throw error;
  } finally { if (generation === payrollReportGeneration) { payrollReportLoading = false; updatePayrollPager(); } }
}
let autoPodlegleSearchTimer: number | null = null;
export async function exportPayrollReport(download: () => void): Promise<void> {
  if (payrollReportLoading || payrollPaymentInFlight) throw new Error('Дочекайтеся завершення поточної операції.');
  if (!payrollReport) { download(); return; }
  const previous = payrollReport, filters = currentPayrollFilters(), generation = payrollReportGeneration;
  if (JSON.stringify(filters) !== payrollReportFilterKey) throw new Error('Повторіть пошук перед експортом.');
  payrollReportLoading = true; updatePayrollPager();
  try {
    const complete = await readAllPayrollReport(filters, undefined, false);
    if (generation !== payrollReportGeneration || JSON.stringify(filters) !== JSON.stringify(currentPayrollFilters())) throw new Error('Фільтр змінився. Повторіть експорт.');
    try { withAccountingExportRows('podlegle-table', () => applyPayrollReport(complete, true), download); }
    finally { applyPayrollReport(previous, true); }
  } finally { if (generation === payrollReportGeneration) { payrollReportLoading = false; updatePayrollPager(); } }
}
const AUTO_PODLEGLE_SEARCH_DELAY = 350;

function debouncePodlegleAutoSearch(fn: () => void) {
  if (autoPodlegleSearchTimer !== null) {
    clearTimeout(autoPodlegleSearchTimer);
  }
  autoPodlegleSearchTimer = window.setTimeout(() => {
    autoPodlegleSearchTimer = null;
    fn();
  }, AUTO_PODLEGLE_SEARCH_DELAY);
}

// ВИПАДАЮЧИЙ СПИСОК ДЛЯ РОБІТ
interface WorkDropdownConfig {
  inputId: string;
  listId: string;
  placeholder: string;
  maxItems: number;
}

const workDropdownConfig: WorkDropdownConfig = {
  inputId: "Bukhhalter-podlegle-work-input",
  listId: "dl-podlegle-work",
  placeholder: "Введіть або оберіть роботу",
  maxItems: 150,
};

class WorkSmartDropdown {
  private input: HTMLInputElement;
  private dropdown: HTMLDivElement;
  public readonly config: WorkDropdownConfig;
  private items: string[] = [];
  private filteredItems: string[] = [];
  private selectedIndex = -1;
  private isOpen = false;

  constructor(config: WorkDropdownConfig) {
    this.config = config;
    const inputEl = document.getElementById(config.inputId) as HTMLInputElement;
    if (!inputEl) {
      throw new Error(`Input element with id ${config.inputId} not found`);
    }
    this.input = inputEl;
    this.dropdown = document.createElement("div");

    this.createDropdown();
    this.bindEvents();
  }

  private createDropdown() {
    if (!this.input.parentElement?.classList.contains("dropdown-wrapper")) {
      const wrapper = document.createElement("div");
      wrapper.className = "dropdown-wrapper";
      wrapper.style.cssText =
        "position: relative; display: inline-block; width: 100%;";

      this.input.placeholder = this.config.placeholder;

      this.input.parentNode?.insertBefore(wrapper, this.input);
      wrapper.appendChild(this.input);
    }

    this.dropdown.className = "smart-dropdown";
    this.dropdown.style.cssText = `
      position: absolute; top: 100%; left: 0; right: 0; z-index: 1000;
      background: white; border: 2px solid #e0e0e0; border-top: none;
      border-radius: 0 0 12px 12px; max-height: 240px; overflow-y: auto; overflow-x: auto;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12); display: none;
      backdrop-filter: blur(8px); background: rgba(255,255,255,0.95);
    `;

    this.input.parentElement?.appendChild(this.dropdown);
  }

  private bindEvents() {
    this.input.addEventListener("focus", () => {
      this.show();
    });

    this.input.addEventListener("click", (e) => {
      e.stopPropagation();
      this.filter(this.input.value);
      this.show();
    });

    this.input.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          this.selectNext();
          break;
        case "ArrowUp":
          e.preventDefault();
          this.selectPrev();
          break;
        case "Enter":
          e.preventDefault();
          this.selectCurrent();
          break;
        case "Escape":
          this.hide();
          break;
      }
    });

    this.input.addEventListener("input", () => {
      this.filter(this.input.value);
      if (!this.isOpen) this.show();
      triggerPodlegleAutoFilter();
    });

    document.addEventListener("click", (e) => {
      if (!this.input.parentElement?.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  public updateItems(items: string[]) {
    this.items = [...new Set(items)].sort();
    this.filter(this.input.value);
  }

  private filter(query: string) {
    const q = query.toLowerCase().trim();
    this.filteredItems = q
      ? this.items
          .filter((item) => item.toLowerCase().includes(q))
          .slice(0, this.config.maxItems)
      : this.items.slice(0, this.config.maxItems);

    this.selectedIndex = -1;
    this.render();
  }

  private render() {
    if (this.filteredItems.length === 0) {
      this.dropdown.innerHTML =
        '<div class="dropdown-empty">Немає варіантів</div>';
      return;
    }

    if (this.filteredItems.length > 6) {
      this.dropdown.style.maxHeight = "240px";
      this.dropdown.style.overflowY = "auto";
    } else {
      this.dropdown.style.maxHeight = "none";
      this.dropdown.style.overflowY = "visible";
    }

    this.dropdown.innerHTML = this.filteredItems
      .map(
        (item, index) => `
        <div class="dropdown-item ${
          index === this.selectedIndex ? "selected" : ""
        }" 
             data-index="${index}">
          ${this.highlightMatch(item, this.input.value)}
        </div>
      `,
      )
      .join("");

    this.dropdown.querySelectorAll(".dropdown-item").forEach((el, index) => {
      el.addEventListener("click", () => {
        this.selectItem(index);
      });
    });

    this.adjustDropdownWidth();
  }

  private adjustDropdownWidth() {
    const measurer = document.createElement("div");
    measurer.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: nowrap;
      font-size: 14px;
      padding: 12px 16px;
      font-family: inherit;
    `;
    document.body.appendChild(measurer);

    let maxWidth = this.input.offsetWidth;
    this.filteredItems.forEach((item) => {
      measurer.textContent = item;
      const itemWidth = measurer.offsetWidth;
      if (itemWidth > maxWidth) {
        maxWidth = itemWidth;
      }
    });

    document.body.removeChild(measurer);

    const inputWidth = this.input.offsetWidth;
    const finalWidth = Math.min(maxWidth + 20, inputWidth * 1.5);

    if (finalWidth > inputWidth) {
      this.dropdown.style.width = `${finalWidth}px`;
      this.dropdown.style.minWidth = `${inputWidth}px`;
    } else {
      this.dropdown.style.width = "100%";
    }
  }

  private highlightMatch(text: string, query: string): string {
    if (!query.trim()) return text;
    const regex = new RegExp(
      `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    return text.replace(regex, "<mark>$1</mark>");
  }

  private show() {
    this.isOpen = true;
    this.dropdown.style.display = "block";
    this.input.style.borderRadius = "8px 8px 0 0";
    this.input.style.borderColor = "#007bff";
  }

  private hide() {
    this.isOpen = false;
    this.dropdown.style.display = "none";
    this.input.style.borderRadius = "8px";
    this.input.style.borderColor = "#e0e0e0";
    this.selectedIndex = -1;
  }

  private selectNext() {
    this.selectedIndex = Math.min(
      this.selectedIndex + 1,
      this.filteredItems.length - 1,
    );
    this.render();
    this.scrollToSelected();
  }

  private selectPrev() {
    this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
    this.render();
    this.scrollToSelected();
  }

  private selectCurrent() {
    if (this.selectedIndex >= 0) {
      this.selectItem(this.selectedIndex);
    }
  }

  private selectItem(index: number) {
    if (index >= 0 && index < this.filteredItems.length) {
      const selectedValue = this.filteredItems[index];
      this.input.value = selectedValue;
      this.hide();

      triggerPodlegleAutoFilter();
    }
  }

  private scrollToSelected() {
    const selected = this.dropdown.querySelector(".dropdown-item.selected");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }
}

let workSmartDropdown: WorkSmartDropdown | null = null;

function addDropdownStyles() {
  if (document.getElementById("smart-dropdown-styles")) return;

  const style = document.createElement("style");
  style.id = "smart-dropdown-styles";
  style.textContent = `
    .dropdown-wrapper {
      position: relative !important;
      display: inline-block !important;
      width: 100% !important;
    }
    
    .smart-dropdown {
      border: 2px solid #007bff !important;
      border-top: none !important;
      border-radius: 0 0 12px 12px !important;
      background: rgba(255,255,255,0.98) !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15) !important;
      overflow-x: auto !important;
    }
    
    .dropdown-item {
      padding: 12px 16px !important;
      cursor: pointer !important;
      border-bottom: 1px solid #f0f0f0 !important;
      transition: all 0.2s ease !important;
      display: flex !important;
      align-items: center !important;
      font-size: 14px !important;
      white-space: nowrap !important;
    }
    
    .dropdown-item:last-child {
      border-bottom: none !important;
    }
    
    .dropdown-item:hover,
    .dropdown-item.selected {
      background: linear-gradient(135deg, #007bff, #0056b3) !important;
      color: white !important;
      transform: translateX(2px) !important;
    }
    
    .dropdown-item mark {
      background: #ffd700 !important;
      color: #333 !important;
      padding: 2px 4px !important;
      border-radius: 3px !important;
      font-weight: 600 !important;
    }
    
    .dropdown-item.selected mark {
      background: rgba(255,255,255,0.3) !important;
      color: white !important;
    }
    
    .dropdown-empty {
      padding: 16px !important;
      text-align: center !important;
      color: #666 !important;
      font-style: italic !important;
    }
    
    .smart-dropdown {
      animation: slideDown 0.2s ease-out !important;
    }
    
    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureWorkSmartDropdown(): void {
  addDropdownStyles();

  if (!workSmartDropdown) {
    const inputEl = document.getElementById(workDropdownConfig.inputId);
    if (inputEl) {
      try {
        workSmartDropdown = new WorkSmartDropdown(workDropdownConfig);
      } catch (error) {
        // console.warn(
        // `Failed to create work dropdown for ${workDropdownConfig.inputId}:`,
        // error,
        // );
      }
    }
  }
}

function refreshWorkDropdownOptions(): void {
  if (payrollReport) { workSmartDropdown?.updateItems(payrollReport.works); return; }
  const selectedName =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select")?.value || "";

  let source = allPodlegleData;
  if (selectedName) {
    source = source.filter((r) => r.name === selectedName);
  }

  const works = new Set<string>();
  source.forEach((r) => {
    if (r.work?.trim()) works.add(r.work.trim());
  });

  if (workSmartDropdown) {
    workSmartDropdown.updateItems(Array.from(works));
  }
}

// 🔹 Оновлення випадаючого списку номерів актів
function refreshActDropdownOptions(): void {
  const actSelect = byId<HTMLSelectElement>("Bukhhalter-podlegle-act-select");
  if (!actSelect) return;

  const selectedName =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select")?.value || "";

  let source = allPodlegleData;
  if (selectedName) {
    source = source.filter((r) => r.name === selectedName);
  }

  const actNumbers = new Set<string>(payrollReport?.acts || []);
  source.forEach((r) => {
    if (r.act && r.act.trim() && r.act.trim() !== "-") {
      actNumbers.add(r.act.trim());
    }
  });

  const previousValue = actSelect.value;
  actSelect.innerHTML = "";

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Всі";
  actSelect.appendChild(emptyOption);

  // Сортуємо номери актів за спаданням (найбільший зверху)
  const sortedActs = Array.from(actNumbers).sort((a, b) => {
    const numA = parseInt(a) || 0;
    const numB = parseInt(b) || 0;
    return numB - numA;
  });

  sortedActs.forEach((actNum) => {
    const option = document.createElement("option");
    option.value = actNum;
    option.textContent = actNum;
    actSelect.appendChild(option);
  });

  // Відновлюємо попереднє значення, якщо воно є в оновленому списку
  if (previousValue && sortedActs.includes(previousValue)) {
    actSelect.value = previousValue;
  } else {
    actSelect.value = "";
  }
}

function triggerPodlegleAutoFilter(): void {
  if (hasPodlegleDataLoaded) {
    // коли дані вже є — фільтруємо локально без звернення в базу
    debouncePodlegleAutoSearch(() => {
      filterPodlegleData();
    });
  } else {
    // коли даних ще немає — ініціюємо первинне завантаження
    debouncePodlegleAutoSearch(() => {
      void autoSearchPodlegleFromInputs();
    });
  }
}

// [НОВИЙ КОД]
async function autoSearchPodlegleFromInputs(): Promise<void> {
  const dateOpen =
    byId<HTMLInputElement>("Bukhhalter-podlegle-date-open")?.value || "";
  const dateClose =
    byId<HTMLInputElement>("Bukhhalter-podlegle-date-close")?.value || "";
  const selectedName =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select")?.value || "";
  const workInput =
    byId<HTMLInputElement>("Bukhhalter-podlegle-work-input")?.value.trim() ||
    "";

  if (!dateOpen && !dateClose && !selectedName && !workInput) {
    return;
  }

  await loadPayrollReportPage(0);
}

function getCurrentDate(): string {
  const now = new Date();
  const day = now.getDate().toString().padStart(2, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const year = now.getFullYear();
  return `${day}.${month}.${year}`;
}

function createPasswordConfirmationModal(action: "pay" | "unpay", details = "", isCurrent?: () => boolean): Promise<boolean> {
  return confirmAccountingPayment(action, details, isCurrent);
}

export async function loadSlyusarsData(directoryOnly = true): Promise<boolean> {
  if (!directoryOnly) { await loadPayrollReportPage(0); return true; }
  const scope = accountingSearchScope('payroll');
  try {
    const directory = await readPayrollDirectory();
    if (scope !== accountingSearchScope('payroll')) return false;
    const names = new Set<string>();
    for (const row of directory.rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (!data?.Name) continue;
      names.add(data.Name);
      slyusarPercentCache.set(data.Name.toLowerCase(), Number(data.ПроцентРоботи) || 0);
    }
    // The directory must never overwrite the report's histories or payment snapshots.
    availableNames = [...names].sort();
    createNameSelect();
    updatePayrollRecoveryBanner(directory.pendingCount, {
      onRecovered: async () => {
        clearPayrollReportCache();
        const filters = currentPayrollFilters();
        if (payrollReport && payrollReportOwner === (localStorage.getItem("userAuthData") || "") &&
          filters.from && filters.to >= filters.from && payrollReportFilterKey === JSON.stringify(filters)) {
          await loadPayrollReportPage(0);
        }
      },
    });
    return true;
  } catch (error) {
    showNotification(error instanceof Error ? error.message : 'Не вдалося завантажити довідник працівників', 'error', 5000);
    return false;
  }
}

export function createNameSelect(): void {
  try {
    const select = byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select");
    if (!select) return; // Added null check

    const selectedValue = select.value;
    select.innerHTML = "";

    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Оберіть ПІБ (або залиште порожнім для всіх)";
    select.appendChild(emptyOption);

    availableNames.forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    select.value = selectedValue;
    select.onchange = (event) => {
      const selectedName = (event.target as HTMLSelectElement).value;
      if (payrollReport || hasPodlegleDataLoaded) { void loadPayrollReportPage(0); return; }

      // ✅ ВИПРАВЛЕННЯ БАГ №2: ЗАВЖДИ оновлюємо дані при зміні імені
      // Раніше оновлення відбувалось тільки якщо hasDataForAllEmployees === true
      if (lastSearchDateOpen || lastSearchDateClose) {
        searchDataInDatabase(
          lastSearchDateOpen,
          lastSearchDateClose,
          selectedName,
        );

        // Оновлюємо таблицю після пошуку
        updatepodlegleTable();
      }

      refreshWorkDropdownOptions();
      refreshActDropdownOptions();
    };
  } catch (error) {}
}

export function getFilteredpodlegleData(): PodlegleRecord[] {
  if (payrollReport) return podlegleData;
  let filteredData = podlegleData;

  // ✅ ВИПРАВЛЕННЯ БАГ №1: Фільтрація по вибраному імені з селекту
  const selectedName =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select")?.value || "";
  if (selectedName) {
    filteredData = filteredData.filter((item) => item.name === selectedName);
  }

  // ✅ Фільтрація по номеру акту
  const selectedAct =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-act-select")?.value || "";
  if (selectedAct) {
    filteredData = filteredData.filter((item) => item.act === selectedAct);
  }

  if (currentPaymentFilter === "paid") {
    filteredData = filteredData.filter((item) => item.isPaid);
  } else if (currentPaymentFilter === "unpaid") {
    filteredData = filteredData.filter((item) => (item.due ?? (item.isPaid ? 0 : item.salary)) > 0);
  }

  if (currentStatusFilter === "closed") {
    filteredData = filteredData.filter((item) => item.isClosed);
  } else if (currentStatusFilter === "open") {
    filteredData = filteredData.filter((item) => !item.isClosed);
  }

  // Фільтр по відсоткам зарплати (тільки записи зі стрілками)
  if (
    currentPercentageFilter === "higher" ||
    currentPercentageFilter === "lower"
  ) {
    filteredData = filteredData.filter((item) => {
      // Фільтруємо тільки прості записи робіт (не приймальників)
      // Приймальники мають customHtmlTotal, а прості записи - ні
      if (item.customHtmlTotal) {
        return false; // Виключаємо приймальників з фільтрації
      }

      const actualSalaryPercent =
        item.total > 0 ? (item.salary / item.total) * 100 : 0;
      const configuredPercent = getSlyusarPercentByName(item.name);

      if (configuredPercent === 0 || item.salary === 0) {
        return false; // Не показувати записи без налаштованого відсотка або зарплати
      }

      if (currentPercentageFilter === "higher") {
        return actualSalaryPercent > configuredPercent; // Червона стрілка вверх
      } else {
        return actualSalaryPercent < configuredPercent; // Синя стрілка вниз
      }
    });
  }

  return filteredData;
}

// Функція для розрахунку суми зарплат
export function calculatePodlegleSalaryTotal(): number {
  if (payrollReport) return payrollReport.salary;
  const filteredData = getFilteredpodlegleData();
  return filteredData.reduce((sum, item) => sum + (item.salary || 0), 0);
}

// Функція для розрахунку маржі
export function calculatePodlegleMarginTotal(): number {
  if (payrollReport) return payrollReport.revenue - payrollReport.salary;
  const filteredData = getFilteredpodlegleData();
  return filteredData.reduce((sum, item) => sum + (item.margin || 0), 0);
}

// Функція для оновлення відображення суми для співробітників
export function updatePodlegleDisplayedSums(): void {
  const totalSumElement = byId<HTMLElement>("total-sum");

  if (!totalSumElement) {
    // console.warn("Елемент total-sum не знайдено");
    return;
  }

  const filteredData = getFilteredpodlegleData();

  let totalRevenue = 0;
  let totalSalary = 0;
  let totalMargin = 0;

  if (filteredData.length > 0) {
    totalRevenue = filteredData.reduce(
      (sum, item) => sum + (item.total || 0),
      0,
    );
    totalSalary = calculatePodlegleSalaryTotal();
    totalMargin = totalRevenue - totalSalary; // Виправлено: тепер margin = revenue - salary
  }

  if (payrollReport) { totalRevenue = payrollReport.revenue; totalSalary = payrollReport.salary; totalMargin = totalRevenue - totalSalary; }
  const totalPaid = payrollReport?.paidAmount ?? filteredData.reduce((sum, item) => sum + (item.paidAmount || 0), 0);
  const totalDue = payrollReport?.due ?? filteredData.reduce((sum, item) => sum + (item.due || 0), 0);
  const totalOverpaid = payrollReport?.overpaid ?? filteredData.reduce((sum, item) => sum + (item.overpaid || 0), 0);
  const paidInPeriod = payrollReport?.paidInPeriod ?? filteredData.reduce((sum, item) => sum + (item.paidInPeriod || 0), 0);
  const paidMode = podlegleDateFilterMode === "paid";
  const marginSign = totalMargin >= 0 ? "+" : "";

  totalSumElement.innerHTML = `
    <div style="display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 15px; font-size: 1.1em;">
      <span>Сума робіт <strong style="color: #333;">💰 ${formatNumber(
        totalRevenue,
      )}</strong> грн</span>
      <span>${paidMode ? "Виплачено за період" : "Нараховано"} <strong style="color: #8B0000;">💶 ${formatNumber(
        paidMode ? paidInPeriod : totalSalary,
      )}</strong> грн</span>
      <span>Маржа <strong style="color: ${
        totalMargin >= 0 ? "#006400 " : "#8B0000"
      };">📈 ${marginSign}${formatNumber(totalMargin)}</strong> грн</span>
      <span>${paidMode ? `Нараховано ${formatNumber(totalSalary)} · ` : ""}Виплачено всього <strong>${formatNumber(totalPaid)}</strong> грн</span>
      <span style="color:#9a6500;">До виплати <strong>${formatNumber(totalDue)}</strong> грн</span>
      ${totalOverpaid > 0 ? `<span style="color:#b42318;">Переплата <strong>${formatNumber(totalOverpaid)}</strong> грн</span>` : ""}
    </div>
  `;
}

export function updatepodlegleTable(): void {
  const tbody = byId<HTMLTableSectionElement>("podlegle-tbody");
  if (!tbody) {
    return;
  }

  const filteredData = getFilteredpodlegleData();

  if (filteredData.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="13" class="Bukhhalter-no-data">Немає даних для відображення</td></tr>';
    updatePodlegleDisplayedSums();
    return;
  }

  setAccountingRows(tbody, accountingVisibleRows(filteredData, payrollReport ? payrollVisibleCount : filteredData.length)
    .map((item, index) => {
      const originalIndex = podlegleData.indexOf(item);

      // ▼▼▼ ПОЧАТОК ВИПРАВЛЕННЯ ▼▼▼

      // 1. Клас для СТАТУСУ АКТУ (isClosed)
      const rowClass = item.isClosed ? "closed-row" : "open-row";

      // 1. Колір фону рядка (Закритий -> Зелений, Відкритий -> Червоний)
      const rowBackgroundColor = item.isClosed
        ? "rgba(212, 237, 218, 0.6)" // Зеленуватий
        : "rgba(248, 215, 218, 0.6)"; // Червонуватий

      // 2. Клас для КОЛЬОРУ РЯДКА (залежить ТІЛЬКИ від isClosed, як ви просили)
      //    (Червоний, якщо NULL (відкритий), Зелений, якщо НЕ NULL (закритий))
      const paidClass = item.isClosed ? "paid-row" : "unpaid-row";

      // 3. Клас і текст для КНОПКИ (залежить ТІЛЬКИ від isPaid / entry.Розраховано)
      const buttonPaidClass = item.isPaid ? "paid" : "unpaid";
      const due = item.due ?? (item.isPaid ? 0 : item.salary);
      const hasPayments = item.hasPayments ?? item.isPaid;
      const paymentButtonText = due > 0
        ? `${hasPayments ? "Доплатити" : "Виплатити"} ${formatNumber(due)} грн`
        : hasPayments ? (item.hasLedger ? "↶ Скасувати останню позначку" : `💰 ${item.paymentDate || "Розраховано"}`) : "Немає до виплати";

      // ▲▲▲ КІНЕЦЬ ВИПРАВЛЕННЯ ▲▲▲

      const marginColor = item.margin >= 0 ? "#28a745" : "#dc3545";
      const marginSign = item.margin >= 0 ? "+" : "";

      // Обчислюємо фактичний відсоток зарплати від загальної суми
      const actualSalaryPercent =
        item.total > 0 ? (item.salary / item.total) * 100 : 0;
      // Отримуємо налаштований відсоток слюсаря з кешу
      const configuredPercent = getSlyusarPercentByName(item.name);

      // Визначаємо стрілку для порівняння процентів
      let salaryArrowHtml = "";
      if (configuredPercent > 0 && item.salary > 0) {
        // Розраховуємо різницю в гривнях: очікувана зарплата - фактична зарплата
        const expectedSalary = (item.total * configuredPercent) / 100;
        const salaryDifference = item.salary - expectedSalary;
        const diffSign = salaryDifference >= 0 ? "+" : "";
        const diffText = `${actualSalaryPercent.toFixed(1)}% з ${configuredPercent}% (${diffSign}${Math.round(salaryDifference)} грн)`;

        if (actualSalaryPercent > configuredPercent) {
          // Процент зарплати більший ніж налаштований - темно червона стрілка вверх
          salaryArrowHtml = `<span class="salary-arrow-up" title="${diffText}">🡱</span>`;
        } else if (actualSalaryPercent < configuredPercent) {
          // Процент зарплати менший ніж налаштований - синя стрілка вниз
          salaryArrowHtml = `<span class="salary-arrow-down" title="${diffText}">🡳</span>`;
        }
      }

      // ✅ Якщо є customHtmlTotal - використовуємо його, інакше стандартний
      const baseTotalHtml = item.customHtmlTotal
        ? item.customHtmlTotal
        : `
        <div class="salary-cell-wrapper">
          <div class="salary-cell-numbers">
            <div style="font-size: 0.95em; font-weight: 600; color: #000;">${formatNumber(
              item.total,
            )}</div>
            <div style="font-size: 0.85em; color: #dc3545; margin-top: 2px;">-${formatNumber(
              item.salary,
            )}</div>
            <div style="font-size: 0.9em; color: ${marginColor}; font-weight: 500; margin-top: 2px;">${marginSign}${formatNumber(
              item.margin,
            )}</div>
          </div>
          ${
            salaryArrowHtml
              ? `<div class="salary-arrow-container">${salaryArrowHtml}</div>`
              : ""
          }
        </div>
      `;
      const totalHtml = `${podlegleDateFilterMode === "paid"
        ? `<div style="font-size:0.95em;font-weight:600;">Виплачено за період: ${formatNumber(item.paidInPeriod || 0)} грн</div>`
        : baseTotalHtml}<div style="font-size:0.78em;line-height:1.45;margin-top:5px;white-space:normal;">
        <span>Нараховано ${formatNumber(item.salary)} · Виплачено ${formatNumber(item.paidAmount ?? (item.isPaid ? item.salary : 0))}</span>
        ${due > 0 ? `<div style="color:#9a6500;font-weight:600;">До виплати: ${formatNumber(due)} грн</div>` : ""}
        ${(item.overpaid || 0) > 0 ? `<div style="color:#b42318;font-weight:600;">Переплата: ${formatNumber(item.overpaid!)} грн</div>` : ""}
      </div>`;

      return `
                <tr class="${rowClass} ${paidClass}" style="background-color: ${rowBackgroundColor};" onclick="handleRowClick(${index})">
                    <td>
                             <button class="Bukhhalter-payment-btn ${buttonPaidClass}"
                                ${due <= 0 && !hasPayments ? "disabled" : ""}
                                onclick="event.stopPropagation(); togglepodleglePaymentWithConfirmation(${originalIndex})" 
                                title="${
                                  due > 0 ? "Виплатити лише залишок нарахування" : "Скасувати останню позначку виплати після підтвердження"
                                }">
                            ${paymentButtonText}
                        </button>
                        ${due > 0 && hasPayments ? `<button type="button" class="Bukhhalter-payment-btn" style="font-size:0.75em;margin-top:4px;" onclick="event.stopPropagation(); togglepodleglePaymentWithConfirmation(${originalIndex}, 'void')" title="Скасувати останню позначку виплати">↶ Скасувати позначку</button>` : ""}
                    </td>
                    <td>${formatDate(item.dateOpen)}</td>
                    <td>${formatDate(item.dateClose) || "-"}</td>
                    <td>${item.recordedDate || "-"}</td> <!-- ✅ Додано колонку "Додано" -->
                    <td>${item.name || "-"}</td>
                    <td>
                     <button class="Bukhhalter-act-btn"
                             onclick="event.stopPropagation(); openActModalWithClient(${
                               Number(item.act) || 0
                             })"
                             title="Відкрити акт №${item.act}">
                       📋 ${item.act || "-"}
                     </button>
                   </td>

                    <td>${item.client || "-"}</td>
                    <td>${item.automobile || "-"}</td>
                    <td>${item.work || "-"}</td>
                    <td>${item.quantity || "-"}</td>
                    <td>${item.price ? formatNumber(item.price) : "-"}</td>
                    <td
                      data-excel-salary="${(podlegleDateFilterMode === "paid" ? item.paidInPeriod : item.salary) || 0}"
                      data-excel-earned="${item.salary || 0}"
                      data-excel-paid="${item.paidAmount || 0}"
                      data-excel-due="${due}"
                      data-excel-overpaid="${item.overpaid || 0}"
                      data-excel-paid-period="${item.paidInPeriod || 0}"
                      data-excel-payment-mode="${podlegleDateFilterMode}"
                      style="padding: 8px; min-width: 220px; white-space: nowrap;"
                    >
                      ${totalHtml}
                    </td>
                    <td><button class="Bukhhalter-delete-btn" onclick="event.stopPropagation(); deleteRecord('podlegle', ${originalIndex})">🗑️</button></td>
                </tr>
            `;
    })
    .join(""));

  updatePodlegleDisplayedSums();
}

// ==== DATE HELPERS (додай один раз у файлі) ====

function toIsoDate(input: string | null | undefined): string {
  if (!input) return "";
  const isoDatePrefix = String(input)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (isoDatePrefix) {
    return `${isoDatePrefix[1]}-${isoDatePrefix[2]}-${isoDatePrefix[3]}`;
  }
  // 1) нормалізуємо і викидаємо все зайве (емодзі, текст, тощо)
  const s = String(input)
    .normalize("NFKC")
    .trim()
    .replace(/[^\d.\-\/]/g, ""); // лишаємо тільки цифри і роздільники . - /

  if (!s) return "";

  // 2) Підтримка YMD: YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  let m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/);
  if (m) {
    const yyyy = m[1];
    const mm = m[2].padStart(2, "0");
    const dd = m[3].padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // 3) Підтримка DMY: DD.MM.YYYY / DD-MM-YYYY / DD/MM/YY
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yyyy = m[3];
    if (yyyy.length === 2) {
      // евристика: 70–99 -> 19xx, інакше -> 20xx
      yyyy = (+yyyy >= 70 ? "19" : "20") + yyyy;
    }
    return `${yyyy}-${mm}-${dd}`;
  }

  return "";
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function inRangeByIso(
  targetDmy: string,
  fromDmy?: string,
  toDmy?: string,
): boolean {
  const t = toIsoDate(targetDmy);
  if (!t) return false; // якщо дата в полі була "💰 31.10.2025" або інший шум — тепер парситься
  const f = fromDmy ? toIsoDate(fromDmy) : ""; // приймає і "28.10.2025", і "2025-10-28"
  const to = toDmy ? toIsoDate(toDmy) : todayIso();
  return (!f || t >= f) && (!to || t <= to);
}

// ЗАМІНИТИ ПОВНІСТЮ функцію searchDataInDatabase:
export function searchDataInDatabase(
  dateOpen: string,
  dateClose: string,
  selectedName: string,
): void {
  podlegleData = [];
  if (!dateOpen && !dateClose) {
    dateOpen = "01.01.2020"; // ✅ ВИПРАВЛЕНО: використовуємо більш ранню дату за замовчуванням
  }
  if (slyusarsData.length === 0) {
    showNotification(
      "⚠️ Немає даних з бази slyusars. Спробуйте перезавантажити сторінку.",
      "warning",
    );
    updatepodlegleTable();
    return;
  }

  lastSearchDateOpen = dateOpen;
  lastSearchDateClose = dateClose;
  try {
    for (const employee of slyusarsData) {
      if (!selectedName || employee.Name === selectedName) assertPayrollHistory(employee);
    }
  } catch (error) {
    allPodlegleData = [];
    updatepodlegleTable();
    showNotification(error instanceof Error ? error.message : String(error), "error", 7000);
    return;
  }

  const toIsoClose = dateClose || todayIso();

  slyusarsData.forEach((slyusar) => {
    if (selectedName && slyusar.Name !== selectedName) return;

    Object.keys(slyusar.Історія).forEach((openDmy) => {
      slyusar.Історія[openDmy].forEach((record) => {
        // ❄️ Пропускаємо заморожені акти
        if (record.Акт && frozenActIds.has(String(record.Акт))) return;

        // 1. ЛОГІКА ДЛЯ СЛЮСАРІВ (з масивом Записи)
        if (
          record.Записи &&
          Array.isArray(record.Записи) &&
          record.Записи.length > 0
        ) {
          if (podlegleDateFilterMode === "paid") {
            record.Записи.forEach((entry, entryIndex) => {
              const settlement = payrollRecordSettlement(entry, record, dateOpen, toIsoClose);
              // ✅ ВИПРАВЛЕНО: Якщо кількість 0, але є зарплата - показуємо запис!
              if (
                entry.Кількість === 0 &&
                settlement.salary === 0 && !settlement.hasPayments
              )
                return;

              const payDmy = settlement.paymentDate;
              if (!payDmy) return;
              if (!inRangeByIso(payDmy, dateOpen, toIsoClose)) return;

              const totalPrice = entry.Ціна * entry.Кількість;
              const salary = settlement.salary;
              podlegleData.push({
                ...settlement,
                dateOpen: openDmy,
                dateClose: getActDateClose(record.Акт, record.ДатаЗакриття),
                name: slyusar.Name,
                employeeId: payrollEmployeeId(slyusar),
                act: record.Акт,
                client: String(record.Клієнт || ""),
                automobile: String(record.Автомобіль || ""),
                work: String(entry.Робота || ""),
                quantity: entry.Кількість,
                price: entry.Ціна,
                total: totalPrice,
                salary,
                margin: totalPrice - salary,
                isClosed: isActClosed(record.Акт, record.ДатаЗакриття), // ✅ ВИПРАВЛЕНО: беремо з acts.date_off
                isPaid: settlement.isPaid,
                paymentDate: payDmy,
                recordedDate: entry.Записано || "", // ✅ Додано
                workIndex: payrollReportWorkIndex(record, entryIndex),
                recordId: entry.recordId, // ✅ Додано: унікальний ID
              });
            });
          } else {
            const targetDmy =
              podlegleDateFilterMode === "close"
                ? getActDateClose(record.Акт, record.ДатаЗакриття)
                : openDmy;
            if (!targetDmy) return;
            if (!inRangeByIso(targetDmy, dateOpen, toIsoClose)) return;

            record.Записи.forEach((entry, entryIndex) => {
              const settlement = payrollRecordSettlement(entry, record, dateOpen, toIsoClose);
              // ✅ ВИПРАВЛЕНО: Якщо кількість 0, але є зарплата - показуємо запис!
              if (
                entry.Кількість === 0 &&
                settlement.salary === 0 && !settlement.hasPayments
              )
                return;

              const totalPrice = entry.Ціна * entry.Кількість;
              const salary = settlement.salary;
              podlegleData.push({
                ...settlement,
                dateOpen: openDmy,
                dateClose: getActDateClose(record.Акт, record.ДатаЗакриття),
                name: slyusar.Name,
                employeeId: payrollEmployeeId(slyusar),
                act: record.Акт,
                client: String(record.Клієнт || ""),
                automobile: String(record.Автомобіль || ""),
                work: String(entry.Робота || ""),
                quantity: entry.Кількість,
                price: entry.Ціна,
                total: totalPrice,
                salary,
                margin: totalPrice - salary,
                isClosed: isActClosed(record.Акт, record.ДатаЗакриття), // ✅ ВИПРАВЛЕНО: беремо з acts.date_off
                isPaid: settlement.isPaid,
                paymentDate: settlement.paymentDate,
                recordedDate: entry.Записано || "", // ✅ Додано
                workIndex: payrollReportWorkIndex(record, entryIndex),
                recordId: entry.recordId, // ✅ Додано: унікальний ID
              });
            });
          }
        }

        // 2. ЛОГІКА ДЛЯ ПРИЙМАЛЬНИКІВ (без масиву Записи, але з сумами)
        else if (record.СуммаРоботи !== undefined) {
          const settlement = payrollRecordSettlement(record, undefined, dateOpen, toIsoClose);
          const isPaid = settlement.isPaid;
          const payDate = settlement.paymentDate;

          // Фільтр "paid"
          if (podlegleDateFilterMode === "paid") {
            if (!payDate) return;
            if (!inRangeByIso(payDate, dateOpen, toIsoClose)) return;
          }
          // Фільтр "open/close"
          else {
            const targetDmy =
              podlegleDateFilterMode === "close"
                ? getActDateClose(record.Акт, record.ДатаЗакриття)
                : openDmy;
            if (!targetDmy) return;
            // Якщо close-mode і дата закриття пуста - пропускаємо
            if (podlegleDateFilterMode === "close" && !targetDmy) return;
            if (!inRangeByIso(targetDmy, dateOpen, toIsoClose)) return;
          }

          const sumWork = Number(record.СуммаРоботи) || 0;
          const sumParts = Number(record.СуммаЗапчастин) || 0;

          // ✅ ВИПРАВЛЕНО: Якщо сума від'ємна → зарплата = 0
          const salaryWork = sumWork > 0 ? Number(record.ЗарплатаРоботи) || 0 : 0;
          const salaryParts = Number(record.ЗарплатаЗапчастин) || 0;

          const totalSum = sumWork + sumParts;
          const totalSalary = settlement.salary;

          // Дані вже збережені з урахуванням знижки, тому просто показуємо їх
          // sumWork та sumParts - це вже чистий прибуток після дисконту та зарплат
          const margin = totalSum;

          // ✅ ВИПРАВЛЕНО: Виводимо суму мінус зарплата приймальника
          // Для запчастин: виводимо sumParts - salaryParts
          const sumPartsAfterSalary = sumParts - salaryParts;
          // Для робіт: виводимо sumWork - salaryWork
          const sumWorkAfterSalary = sumWork - salaryWork;

          const customHtml = `
            <div style="font-size: 0.85em; line-height: 1.2; text-align: right;">
              ${
                salaryParts !== 0
                  ? `<div style="color: #dc3545;">⚙️ -${formatNumber(salaryParts)}</div>`
                  : sumParts < 0
                    ? `<div style="color: #6c757d;">⚙️ 0</div>`
                    : ""
              }
              ${
                sumPartsAfterSalary !== 0
                  ? `<div style="color: ${sumPartsAfterSalary > 0 ? "#28a745" : "#dc3545"};">⚙️ ${sumPartsAfterSalary > 0 ? "+" : ""}${formatNumber(sumPartsAfterSalary)}</div>`
                  : ""
              }
              ${
                salaryWork !== 0
                  ? `<div style="color: #dc3545;">🛠️ -${formatNumber(salaryWork)}</div>`
                  : sumWork < 0
                    ? `<div style="color: #6c757d;">🛠️ 0</div>`
                    : ""
              }
              ${
                sumWorkAfterSalary !== 0
                  ? `<div style="color: ${sumWorkAfterSalary > 0 ? "#28a745" : "#dc3545"};">🛠️ ${sumWorkAfterSalary > 0 ? "+" : ""}${formatNumber(sumWorkAfterSalary)}</div>`
                  : ""
              }
            </div>`;

          podlegleData.push({
            ...settlement,
            dateOpen: openDmy,
            dateClose: getActDateClose(record.Акт, record.ДатаЗакриття),
            name: slyusar.Name,
            employeeId: payrollEmployeeId(slyusar),
            act: record.Акт,
            client: String(record.Клієнт || ""),
            automobile: String(record.Автомобіль || ""),
            work: "-", // Пусто
            quantity: 0, // 0 або пусто
            price: 0,
            total: totalSum,
            salary: totalSalary,
            margin: margin,
            isClosed: isActClosed(record.Акт, record.ДатаЗакриття), // ✅ ВИПРАВЛЕНО: беремо з acts.date_off
            isPaid: isPaid,
            paymentDate: payDate,
            customHtmlTotal: customHtml,
          });
        }

        // 3. ЛОГІКА ДЛЯ ЗАПЧАСТИСТІВ (без СуммаРоботи, але з СуммаЗапчастин)
        else if (
          record.СуммаЗапчастин !== undefined &&
          record.СуммаРоботи === undefined
        ) {
          const settlement = payrollRecordSettlement(record, undefined, dateOpen, toIsoClose);
          const isPaid = settlement.isPaid;
          const payDate = settlement.paymentDate;

          // Фільтр "paid"
          if (podlegleDateFilterMode === "paid") {
            if (!payDate) return;
            if (!inRangeByIso(payDate, dateOpen, toIsoClose)) return;
          }
          // Фільтр "open/close"
          else {
            const targetDmy =
              podlegleDateFilterMode === "close"
                ? getActDateClose(record.Акт, record.ДатаЗакриття)
                : openDmy;
            if (!targetDmy) return;
            if (podlegleDateFilterMode === "close" && !targetDmy) return;
            if (!inRangeByIso(targetDmy, dateOpen, toIsoClose)) return;
          }

          const sumParts = Number(record.СуммаЗапчастин) || 0;
          const salaryParts = settlement.salary;
          const profitAfterSalary = sumParts - salaryParts;

          // Формуємо HTML: червона зарплата, зелений чистий прибуток
          const customHtml = `
            <div style="font-size: 0.85em; line-height: 1.2; text-align: right;">
              ${
                salaryParts !== 0
                  ? `<div style="color: #dc3545;">💰 -${formatNumber(salaryParts)}</div>`
                  : ""
              }
              ${
                profitAfterSalary !== 0
                  ? `<div style="color: ${profitAfterSalary > 0 ? "#28a745" : "#dc3545"};">📊 ${profitAfterSalary > 0 ? "+" : ""}${formatNumber(profitAfterSalary)}</div>`
                  : ""
              }
            </div>`;

          podlegleData.push({
            ...settlement,
            dateOpen: openDmy,
            dateClose: getActDateClose(record.Акт, record.ДатаЗакриття),
            name: slyusar.Name,
            employeeId: payrollEmployeeId(slyusar),
            act: record.Акт,
            client: String(record.Клієнт || ""),
            automobile: String(record.Автомобіль || ""),
            work: "Запчастини", // Позначаємо як запчастини
            quantity: 0,
            price: 0,
            total: sumParts,
            salary: salaryParts,
            margin: profitAfterSalary,
            isClosed: isActClosed(record.Акт, record.ДатаЗакриття),
            isPaid: isPaid,
            paymentDate: payDate,
            customHtmlTotal: customHtml,
          });
        }
      });
    });
  });

  // Фільтр по роботі - для приймальників work = "-", тому вони можуть відсіятись, якщо юзер щось ввів
  const workInput =
    byId<HTMLInputElement>("Bukhhalter-podlegle-work-input")?.value.trim() ||
    "";
  if (workInput) {
    // const beforeFilter = podlegleData.length;
    podlegleData = podlegleData.filter((record) =>
      (record.work || "").toLowerCase().includes(workInput.toLowerCase()),
    );
  }

  podlegleData.sort((a, b) => {
    const actA = parseInt(a.act) || 0;
    const actB = parseInt(b.act) || 0;
    if (actA !== actB) return actB - actA;

    const ka =
      podlegleDateFilterMode === "paid"
        ? toIsoDate(a.paymentDate || a.dateOpen)
        : toIsoDate(a.dateOpen);
    const kb =
      podlegleDateFilterMode === "paid"
        ? toIsoDate(b.paymentDate || b.dateOpen)
        : toIsoDate(b.dateOpen);
    return kb.localeCompare(ka);
  });

  if (payrollReport) {
    const keys = new Set(payrollReport.keys.map(key => JSON.stringify(key)));
    podlegleData = podlegleData.filter(record => keys.has(payrollRowKey(record)) && !hiddenPayrollKeys.has(payrollRowKey(record)));
  }

  if (!payrollQuiet) notificationHelperInSearch(
    payrollReport?.total ?? podlegleData.length,
    selectedName,
    dateOpen,
    dateClose,
    workInput,
  );

  allPodlegleData = [...podlegleData];
  hasPodlegleDataLoaded = true;
  ensureWorkSmartDropdown();
  refreshWorkDropdownOptions();
  refreshActDropdownOptions();
  updatepodlegleTable();
}

// Helper to keep notifications clean
function notificationHelperInSearch(
  count: number,
  name: string,
  dOpen: string,
  dClose: string,
  wInput: string,
) {
  const modeLabels = {
    open: "відкриття",
    close: "закриття",
    paid: "розрахунку" as const,
  };
  let dateFilterMessage = "";
  if (!dOpen && !dClose)
    dateFilterMessage = ` (всі дати ${modeLabels[podlegleDateFilterMode]})`;
  else if (dOpen && !dClose)
    dateFilterMessage = ` (${modeLabels[podlegleDateFilterMode]}: з ${dOpen} до сьогодні)`;
  else if (!dOpen && dClose)
    dateFilterMessage = ` (${modeLabels[podlegleDateFilterMode]}: до ${dClose} включно)`;
  else
    dateFilterMessage = ` (${modeLabels[podlegleDateFilterMode]}: з ${dOpen} до ${dClose})`;

  if (wInput) dateFilterMessage += ` | робота: "${wInput}"`;
  const filterMessage = name ? ` для ${name}` : "";

  showNotification(
    count > 0
      ? `✅ Знайдено ${count} записів${filterMessage}${dateFilterMessage}`
      : `ℹ️ Записів не знайдено${filterMessage}${dateFilterMessage}`,
    count > 0 ? "success" : "info",
  );
}

// Функція для локальної фільтрації завантажених даних
export function filterPodlegleData(): void {
  if (payrollReport || hasPodlegleDataLoaded) { void loadPayrollReportPage(0); return; }
  if (!hasPodlegleDataLoaded || allPodlegleData.length === 0) {
    podlegleData = [];
    updatepodlegleTable();
    showNotification(
      "ℹ️ Записів не знайдено за поточним фільтром",
      "info",
      2000,
    );
    return;
  }

  const dateOpen =
    byId<HTMLInputElement>("Bukhhalter-podlegle-date-open")?.value || "";
  const dateClose =
    byId<HTMLInputElement>("Bukhhalter-podlegle-date-close")?.value || "";
  const selectedName =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select")?.value || "";
  const workInput =
    byId<HTMLInputElement>("Bukhhalter-podlegle-work-input")?.value.trim() ||
    "";

  let filtered = [...allPodlegleData];

  if (selectedName) {
    filtered = filtered.filter((r) => r.name === selectedName);
  }

  if (podlegleDateFilterMode === "close") {
    filtered = filtered.filter((r) => r.dateClose);
  } else if (podlegleDateFilterMode === "paid") {
    filtered = filtered.filter((r) => r.paymentDate);
  }

  if (dateOpen || dateClose) {
    const toIsoClose = dateClose || todayIso();
    filtered = filtered.filter((r) => {
      let targetDate = "";
      switch (podlegleDateFilterMode) {
        case "close":
          targetDate = r.dateClose || "";
          break;
        case "paid":
          targetDate = r.paymentDate || "";
          break;
        case "open":
        default:
          targetDate = r.dateOpen;
          break;
      }
      if (!targetDate) return false;
      return inRangeByIso(targetDate, dateOpen, toIsoClose);
    });
  }

  if (workInput) {
    filtered = filtered.filter((record) =>
      (record.work || "").toLowerCase().includes(workInput.toLowerCase()),
    );
  }

  // 🔹 Фільтр по номеру акту
  const selectedAct =
    byId<HTMLSelectElement>("Bukhhalter-podlegle-act-select")?.value || "";
  if (selectedAct) {
    filtered = filtered.filter((record) => record.act === selectedAct);
  }

  filtered.sort((a, b) => {
    // Спочатку сортуємо за номером акту (більший номер - вище)
    const actA = parseInt(a.act) || 0;
    const actB = parseInt(b.act) || 0;

    if (actA !== actB) {
      return actB - actA; // Зворотний порядок: 300 > 299 > 298
    }

    // Якщо акти однакові, сортуємо за датою
    const ka =
      podlegleDateFilterMode === "paid"
        ? toIsoDate(a.paymentDate || a.dateOpen)
        : toIsoDate(a.dateOpen);
    const kb =
      podlegleDateFilterMode === "paid"
        ? toIsoDate(b.paymentDate || b.dateOpen)
        : toIsoDate(b.dateOpen);
    return kb.localeCompare(ka);
  });

  podlegleData = filtered;

  // ✅ якщо після фільтрації немає результатів — чиста таблиця + повідомлення
  if (filtered.length === 0) {
    updatepodlegleTable(); // це намалює "Немає даних для відображення"
    const modeLabel =
      podlegleDateFilterMode === "paid"
        ? "розрахунку"
        : podlegleDateFilterMode === "close"
          ? "закриття"
          : "відкриття";
    const datePart =
      !dateOpen && !dateClose
        ? ""
        : dateOpen && !dateClose
          ? ` (з ${dateOpen} до сьогодні)`
          : !dateOpen && dateClose
            ? ` (до ${dateClose} включно)`
            : ` (з ${dateOpen} до ${dateClose})`;

    const workPart = workInput ? ` | робота: "${workInput}"` : "";
    const namePart = selectedName ? ` для ${selectedName}` : "";

    showNotification(
      `ℹ️ Записів не знайдено${namePart} (${modeLabel})${datePart}${workPart}`,
      "info",
      2500,
    );
    return;
  }

  updatepodlegleTable();
}

// Глобальна змінна для зберігання поточного фільтра дат
let podlegleDateFilterMode: "open" | "close" | "paid" = "open";

// Функція для ініціалізації перемикача фільтрації дат для підлеглих
function initPodlegleDateFilterToggle(): void {
  const toggleContainer = document.querySelector(
    "#Bukhhalter-podlegle-section .Bukhhalter-date-filter-toggle",
  );
  if (!toggleContainer) return;

  const buttons =
    toggleContainer.querySelectorAll<HTMLButtonElement>(".date-filter-btn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", function () {
      buttons.forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      podlegleDateFilterMode = this.dataset.filter as "open" | "close" | "paid";

      // ✅ ВИПРАВЛЕНО: Завжди використовуємо локальну фільтрацію
      if (hasPodlegleDataLoaded) {
        filterPodlegleData();
      } else {
        // console.warn("⚠️ Дані ще не завантажені, натисніть 🔍 Пошук");
      }
    });
  });
}

export function createStatusToggle(): void {
  const toggle = byId<HTMLInputElement>("details-status-filter-toggle");

  if (!toggle) {
    // console.error("❌ Елемент status-filter-toggle не знайдено в HTML");
    return;
  }

  // ✅ ДОДАНО: Обробник change
  toggle.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentStatusFilter = "closed";
        break;
      case "1":
        currentStatusFilter = "open";
        break;
      case "2":
      default:
        currentStatusFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });

  // ✅ ЗАЛИШАЄМО: Обробник input (для сумісності)
  toggle.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentStatusFilter = "closed";
        break;
      case "1":
        currentStatusFilter = "open";
        break;
      case "2":
      default:
        currentStatusFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });
}

export function createPaymentToggle(): void {
  const toggle = byId<HTMLInputElement>("payment-filter-toggle");

  if (!toggle) {
    // console.error("❌ Елемент payment-filter-toggle не знайдено в HTML");
    return;
  }

  // ✅ ДОДАНО: Обробник change
  toggle.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentPaymentFilter = "paid";
        break;
      case "1":
        currentPaymentFilter = "unpaid";
        break;
      case "2":
      default:
        currentPaymentFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });

  // ✅ ЗАЛИШАЄМО: Обробник input (для сумісності)
  toggle.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentPaymentFilter = "paid";
        break;
      case "1":
        currentPaymentFilter = "unpaid";
        break;
      case "2":
      default:
        currentPaymentFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });
}

export function createPercentageToggle(): void {
  const toggle = byId<HTMLInputElement>("percentage-filter-toggle");

  if (!toggle) {
    // console.error("❌ Елемент percentage-filter-toggle не знайдено в HTML");
    return;
  }

  // Обробник change
  toggle.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentPercentageFilter = "lower";
        break;
      case "1":
        currentPercentageFilter = "higher";
        break;
      case "2":
      default:
        currentPercentageFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });

  // Обробник input (для сумісності)
  toggle.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentPercentageFilter = "lower";
        break;
      case "1":
        currentPercentageFilter = "higher";
        break;
      case "2":
      default:
        currentPercentageFilter = "all";
        break;
    }

    if (hasPodlegleDataLoaded) {
      filterPodlegleData();
    } else {
      updatepodlegleTable();
    }
  });
}

// [НОВИЙ КОД]
export async function handlepodlegleAddRecord(): Promise<void> {
  if (!readAccountingPeriod("podlegle")) return;
  // 🔐 Перевіряємо доступ до сторінки перед пошуком
  const hasAccess = await checkCurrentPageAccess();

  if (!hasAccess) {
    redirectToIndex();
    return;
  }

  await loadPayrollReportPage(0);
}

function initPodlegleDateAutoFilter(): void {
  const openEl = byId<HTMLInputElement>("Bukhhalter-podlegle-date-open");
  const closeEl = byId<HTMLInputElement>("Bukhhalter-podlegle-date-close");
  if (!openEl || !closeEl) return;

  const handler = () => {
    const newFromIso = toIsoDate(openEl.value); // новий "від"
    const newToIso = toIsoDate(closeEl.value); // новий "до"

    // що було завантажено востаннє
    const loadedFromIso = toIsoDate(lastSearchDateOpen) || "";
    const loadedToIso = toIsoDate(lastSearchDateClose) || todayIso(); // якщо не вказували "до", брали "сьогодні"

    // чи є дані вже в пам'яті
    if (!hasPodlegleDataLoaded) {
      // ще не завантажували — тягнемо з бази
      debouncePodlegleAutoSearch(() => {
        void autoSearchPodlegleFromInputs();
      });
      return;
    }

    // Визначаємо напрямок зміни:
    // звужуємо зліва: новий from >= завантаженого from
    const narrowsLeft =
      !!newFromIso && (!!loadedFromIso ? newFromIso >= loadedFromIso : true);
    // звужуємо справа: новий to <= завантаженого to
    const narrowsRight = !!newToIso && newToIso <= loadedToIso;

    // розширюємо зліва: новий from < завантаженого from
    const expandsLeft =
      !!newFromIso && (!!loadedFromIso ? newFromIso < loadedFromIso : false);
    // розширюємо справа: новий to > завантаженого to
    const expandsRight = !!newToIso && newToIso > loadedToIso;

    // якщо користувач звузив (від більша, або до менша) — фільтруємо локально
    if (narrowsLeft || narrowsRight) {
      debouncePodlegleAutoSearch(() => {
        filterPodlegleData();
      });
      return;
    }

    // якщо користувач розширив діапазон — дозавантажуємо з бази
    if (
      expandsLeft ||
      expandsRight ||
      (!newFromIso && loadedFromIso) ||
      (!newToIso && lastSearchDateClose)
    ) {
      debouncePodlegleAutoSearch(() => {
        void autoSearchPodlegleFromInputs();
      });
      return;
    }

    // якщо діапазон по суті не змінився — нічого не робимо
  };

  // слухаємо і 'input', і 'change' (щоб спрацювало і при ручному вводі, і при виборі з календаря)
  openEl.addEventListener("input", handler);
  closeEl.addEventListener("input", handler);
  openEl.addEventListener("change", handler);
  closeEl.addEventListener("change", handler);
}

export function deletepodlegleRecord(index: number): void {
  if (podlegleData[index]) hiddenPayrollKeys.add(payrollRowKey(podlegleData[index]));
  podlegleData.splice(index, 1);
  updatepodlegleTable();
  showNotification("🗑️ Запис видалено", "info");
}

function findPodlegleRecordIndex(record: PodlegleRecord): number {
  const directIndex = podlegleData.indexOf(record);
  if (directIndex !== -1) return directIndex;

  return podlegleData.findIndex((item) => {
    const sameAct =
      item.employeeId === record.employeeId &&
      item.dateOpen === record.dateOpen &&
      item.name === record.name &&
      String(item.act) === String(record.act);
    if (!sameAct) return false;
    if (record.recordId) return item.recordId === record.recordId;

    if (typeof record.workIndex === "number") {
      return item.workIndex === record.workIndex;
    }

    return (
      item.work === record.work &&
      item.price === record.price &&
      item.quantity === record.quantity &&
      item.total === record.total &&
      item.salary === record.salary
    );
  });
}

type PayrollPaymentOperation = "pay" | "void";

function findPayrollPaymentTarget(record: PodlegleRecord, source = slyusarsData): {target: any; parent: any} {
  const employees = source.filter(s => record.employeeId != null
    ? payrollEmployeeId(s) === record.employeeId : s.Name === record.name);
  if (employees.length !== 1) throw new Error(`Працівника ${record.name} не знайдено однозначно.`);
  const acts = (employees[0].Історія?.[record.dateOpen] || []).filter(a => String(a.Акт) === String(record.act));
  if (acts.length !== 1) throw new Error(`Акт №${record.act} не знайдено однозначно.`);
  const parent = acts[0];
  if ((!parent.Записи || parent.Записи.length === 0) &&
      (parent.СуммаРоботи !== undefined || parent.СуммаЗапчастин !== undefined)) return {target: parent, parent: undefined};
  const rows = parent.Записи || [];
  let candidates: any[] = [];
  if (record.recordId != null && String(record.recordId).trim()) {
    candidates = rows.filter(row => String(row.recordId ?? "") === String(record.recordId));
  } else if (typeof record.workIndex === "number" && payrollReportWork(parent, record.workIndex)?.Робота === record.work) {
    candidates = [payrollReportWork(parent, record.workIndex)];
  } else {
    candidates = rows.filter(row => row.Робота === record.work && Number(row.Кількість) === record.quantity &&
      Number(row.Ціна) === record.price && Number(row.Зарплата) === record.salary);
  }
  if (candidates.length !== 1) throw new Error(`Роботу «${record.work}» не знайдено однозначно. Оновіть пошук.`);
  return {target: candidates[0], parent};
}

function replacePayrollPaymentTarget(target: any, next: any): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function payrollPaymentConfirmation(target: any, parent: any, operation: PayrollPaymentOperation): string {
  const state = getPayrollPaymentState(target, parent);
  if (operation === "pay") return `Виплатити залишок ${formatNumber(state.due)} грн.`;
  const voided = new Set(state.payments.filter(event => "voids" in event).map(event => event.voids));
  const active = state.payments.filter(event => "amount" in event && !voided.has(event.id));
  const payment = active[active.length - 1];
  return payment && "amount" in payment
    ? `Скасувати останню позначку виплати ${formatNumber(payment.amount)} грн від ${payment.date}. Це виправлення обліку, кошти автоматично не повертаються.`
    : "Немає виплати для скасування.";
}

type PayrollPaymentSelection = {
  record: PodlegleRecord;
  expected: string;
  operation: PayrollPaymentOperation;
  amount: number;
};

function payrollPaymentScope(): string {
  return JSON.stringify([accountingSearchScope("payroll"), currentPayrollFilters(), payrollReportGeneration]);
}

function capturePayrollPayments(records: PodlegleRecord[], operation: PayrollPaymentOperation, employeesData = slyusarsData): PayrollPaymentSelection[] {
  const selection: PayrollPaymentSelection[] = [];
  const targets = new Set<any>();
  for (const record of records) {
    const {target, parent} = findPayrollPaymentTarget(record, employeesData);
    if (targets.has(target)) continue;
    const state = getPayrollPaymentState(target, parent);
    if (operation === "pay" ? state.due <= 0 : !state.hasPayments) continue;
    targets.add(target);
    selection.push({record: structuredClone(record), expected: JSON.stringify([target, parent?.Розраховано]), operation, amount: state.due});
  }
  const employees = new Set(selection.map(item => item.record.employeeId));
  if (employees.size > 50) throw new Error("За один розрахунок можна обробити до 50 працівників. Звузьте фільтр; жодну виплату не змінено.");
  if ([...employees].some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) throw new Error("Неоднозначний працівник. Повторіть пошук.");
  for (const id of employees) if (selection.filter(item => item.record.employeeId === id).length > 2000) {
    throw new Error("Забагато позицій одного працівника. Звузьте період; жодну виплату не змінено.");
  }
  return selection;
}

type PayrollPaymentSource = { report: PayrollReportPage; employees: SlyusarData[]; records: PodlegleRecord[] };

// Build exact payment identities from report keys without changing the displayed table.
function preparePayrollPaymentSource(report: PayrollReportPage): PayrollPaymentSource {
  const employees = report.employees.map(row => trackPayrollData(row.slyusar_id, row.data));
  const byEmployee = new Map(employees.map(employee => [payrollEmployeeId(employee), employee]));
  const records = report.keys.map(([employeeId, dateOpen, act, index]) => {
    const employee = byEmployee.get(employeeId);
    const entries = employee?.Історія?.[dateOpen]?.filter((entry: any) => String(entry.Акт) === String(act)) || [];
    if (entries.length !== 1) throw new Error("Неповний звіт зарплати. Повторіть пошук.");
    const entry = entries[0], target = index === null ? entry : payrollReportWork(entry, index);
    if (!target) throw new Error("Позицію зарплати не завантажено. Повторіть пошук.");
    const state = getPayrollPaymentState(target, index === null ? undefined : entry);
    const price = Number(target.Ціна) || 0, quantity = Number(target.Кількість) || 0;
    return { employeeId, dateOpen, act: String(act), name: employee.Name,
      work: index === null ? (entry.СуммаРоботи !== undefined ? "-" : "Запчастини") : String(target.Робота || ""),
      ...(index === null ? {} : {workIndex: index, recordId: target.recordId}),
      dateClose: "", client: "", automobile: "", price, quantity, total: price * quantity,
      salary: state.earned, margin: 0, isClosed: false, isPaid: state.isPaid };
  });
  return {report, employees, records};
}

export async function togglepodleglePaymentWithConfirmation(
  index: number, operation?: PayrollPaymentOperation,
): Promise<void> {
  await withPaymentLock(async () => {
    const record = podlegleData[index];
    if (!record) { showNotification("Запис не знайдено", "error"); return; }
    const {target, parent} = findPayrollPaymentTarget(record);
    const action = operation || (getPayrollPaymentState(target, parent).due > 0 ? "pay" : "void");
    const selection = capturePayrollPayments([record], action);
    if (!selection.length) { showNotification("Немає виплати для цієї дії.", "info"); return; }
    const scope = payrollPaymentScope();
    const isCurrent = () => scope === payrollPaymentScope() && hasFullAccess();
    const details = `Акт №${record.act}, ${record.name}, ${record.work}. ${payrollPaymentConfirmation(target, parent, action)}`;
    if (!await createPasswordConfirmationModal(action === "pay" ? "pay" : "unpay", details, isCurrent)) return;
    if (!isCurrent()) throw new Error("Користувач або фільтр змінився. Повторіть дію.");
    await executePayrollPaymentSelection(selection, scope);
  });
}

let payrollPaymentInFlight = false;
async function withPaymentLock(run: () => Promise<void>): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    if (!hasFullAccess()) { showNotification("У вас немає прав для зміни виплат", "warning"); return; }
    if (!readAccountingPeriod("podlegle")) return;
    if (payrollSearchFailed || (payrollReport && (payrollReportFilterKey !== JSON.stringify(currentPayrollFilters()) ||
      payrollReportOwner !== (localStorage.getItem("userAuthData") || "") || payrollReportScope !== accountingSearchScope("payroll")))) {
      showNotification("Оновіть пошук перед виплатою.", "warning"); return;
    }
    if (payrollReportLoading || payrollPaymentInFlight) { showNotification("Дочекайтеся завершення поточної операції.", "info"); return; }
    payrollPaymentInFlight = true; updatePayrollPager();
    try { await run(); }
    catch (error) { showNotification(error instanceof Error ? error.message : String(error), "error", 6000); }
    finally { payrollPaymentInFlight = false; updatePayrollPager(); }
  });
}

export async function togglepodleglePayment(index: number, operation?: PayrollPaymentOperation): Promise<void> {
  await togglepodleglePaymentWithConfirmation(index, operation);
}

async function executePayrollPaymentSelection(selection: PayrollPaymentSelection[], scope: string, source?: PayrollPaymentSource): Promise<void> {
  if (!selection.length) return;
  if (scope !== payrollPaymentScope() || !hasFullAccess()) throw new Error("Користувач або фільтр змінився. Повторіть дію.");
  const sourceEmployees = source?.employees || slyusarsData;
  const sourceRecords = source && new Map(source.records.map(record => [payrollRowKey(record), record]));
  const plans = selection.map(item => {
    const record = sourceRecords ? sourceRecords.get(payrollRowKey(item.record)) : podlegleData[findPodlegleRecordIndex(item.record)];
    if (!record) throw new Error("Позиція більше не належить поточному пошуку. Повторіть дію.");
    const {target, parent} = findPayrollPaymentTarget(record, sourceEmployees);
    if (item.expected !== JSON.stringify([target, parent?.Розраховано])) throw new Error("Сума або виплата вже змінилася. Повторіть дію.");
    return {record, target, parent, before: structuredClone(target),
      next: applyPayrollPayment(target, parent, getCurrentDate(), crypto.randomUUID(), item.operation)};
  });
  const ids = new Set(selection.map(item => item.record.employeeId));
  const employees = sourceEmployees.filter(data => ids.has(payrollEmployeeId(data)));
  if (employees.length !== ids.size || ids.has(undefined)) throw new Error("Неоднозначний працівник. Повторіть пошук.");
  const previousReport = source?.report || payrollReport;
  for (const plan of plans) replacePayrollPaymentTarget(plan.target, plan.next);
  try {
    // Server act guards and all employee updates share one transaction.
    await savePayrollReportPayments(plans, employees);
    patchPayrollReportPayments(employees.map(data => ({id: payrollEmployeeId(data)!, data})));
    announceAccountingChange(["payroll", "profit"], ["payroll"]);
  } catch (error) {
    for (const plan of plans) replacePayrollPaymentTarget(plan.target, plan.before);
    clearPayrollReportCache(); payrollSearchFailed = true; payrollScroll.pause();
    throw new Error(`${error instanceof Error ? error.message : String(error)} Оновіть пошук перед повторною виплатою.`);
  }
  if (scope !== payrollPaymentScope() || !hasFullAccess()) {
    clearPayrollReportCache(); payrollSearchFailed = true; payrollScroll.pause();
    showNotification("Виплату збережено. Користувач або фільтр змінився — повторіть пошук.", "warning"); return;
  }
  try {
    const filters = currentPayrollFilters();
    const reorderedPaidPrefix = !!previousReport?.has_more && filters.mode === "paid" && plans.some(plan =>
      getPayrollPaymentInPeriod(plan.before, plan.parent, filters.from, filters.to).date !==
      getPayrollPaymentInPeriod(plan.target, plan.parent, filters.from, filters.to).date);
    for (const plan of plans) Object.assign(plan.record, payrollRecordSettlement(plan.target, plan.parent, lastSearchDateOpen, lastSearchDateClose));
    if (previousReport) {
      const next = reconcilePayrollReportPayments(previousReport,
        sourceEmployees.map(data => ({slyusar_id: payrollEmployeeId(data)!, data})), currentPayrollFilters());
      if (source) applyPayrollReport(next, true);
      const order = new Map(next.keys.map((key, index) => [JSON.stringify(key), index]));
      const retained = (records: PodlegleRecord[]) => records.filter(record => order.has(payrollRowKey(record)))
        .sort((left, right) => order.get(payrollRowKey(left))! - order.get(payrollRowKey(right))!);
      podlegleData = retained(podlegleData);
      allPodlegleData = retained(allPodlegleData);
      payrollReport = next;
      payrollVisibleCount = Math.min(payrollVisibleCount, podlegleData.length);
    }
    // A paid-date change may move a retained key behind an unfetched key. Keep
    // the acknowledged rows, but never continue an offset from a broken prefix.
    if (reorderedPaidPrefix) { payrollSearchFailed = true; payrollScroll.pause(); }
    updatepodlegleTable();
    const amount = selection.reduce((sum, item) => sum + item.amount, 0);
    const message = selection[0].operation === "pay"
      ? `Виплачено ${formatNumber(amount)} грн за ${selection.length} позиціями${source ? " поточного фільтра" : ""}.`
      : "Останню позначку виплати скасовано.";
    showNotification(message + (reorderedPaidPrefix ? " Дата виплати змінилася. Натисніть «Пошук», щоб продовжити підвантаження у правильному порядку." : ""), "success");
  } catch (error) {
    // Acknowledged writes remain committed even if local rendering fails.
    clearPayrollReportCache(); payrollSearchFailed = true; payrollScroll.pause();
    showNotification(`Виплату збережено. ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

export async function runMassPaymentCalculation(): Promise<void> {
  await withPaymentLock(runMassPaymentCalculationOnce);
}
async function runMassPaymentCalculationOnce(): Promise<void> {
  const scope = payrollPaymentScope();
  const isCurrent = () => scope === payrollPaymentScope() && hasFullAccess();
  const counts = new Map<number, number>();
  const complete = await readAllPayrollReport(currentPayrollFilters(), undefined, true, page => {
    if (!isCurrent()) throw new Error("Користувач або фільтр змінився під час завантаження. Повторіть виплату.");
    const source = preparePayrollPaymentSource(page);
    for (const item of capturePayrollPayments(source.records, "pay", source.employees)) {
      const id = item.record.employeeId!;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (counts.size > 50 || counts.get(id)! > 2000) {
        throw new Error("За один розрахунок можна обробити до 50 працівників і 2000 позицій кожного. Звузьте фільтр; жодну виплату не змінено.");
      }
    }
  });
  if (!isCurrent()) throw new Error("Користувач або фільтр змінився під час завантаження. Повторіть виплату.");
  const source = preparePayrollPaymentSource(complete);
  const selection = capturePayrollPayments(source.records, "pay", source.employees);
  if (!selection.length) { showNotification("За поточним фільтром немає залишку до виплати.", "info"); return; }
  const amount = selection.reduce((sum, item) => sum + item.amount, 0);
  const confirmed = await createPasswordConfirmationModal("pay",
    `Виплатити ${formatNumber(amount)} грн за всіма ${selection.length} неоплаченими позиціями поточного періоду й фільтра, включно з позиціями, які ще не показані в таблиці.`, isCurrent);
  if (!confirmed) return;
  if (!isCurrent()) throw new Error("Користувач або фільтр змінився під час підтвердження. Повторіть виплату.");
  await executePayrollPaymentSelection(selection, scope, source);
}

export function clearpodlegleForm(): void {
  if (payrollPaymentInFlight) return;
  if (autoPodlegleSearchTimer !== null) {
    clearTimeout(autoPodlegleSearchTimer);
    autoPodlegleSearchTimer = null;
  }
  const podlegleSection = byId<HTMLElement>("Bukhhalter-podlegle-section");
  if (!podlegleSection) return;
  // Reset before control events so clearing/prefilling does not issue intermediate searches.
  hasPodlegleDataLoaded = false;
  payrollReport = null;

  // ✅ 1. Очищаємо всі інпути
  const inputs = podlegleSection.querySelectorAll<HTMLInputElement>(
    "input:not([readonly])",
  );
  inputs.forEach((input) => {
    input.value = "";
  });

  // ✅ 2. Очищаємо селект ПІБ
  const nameSelect = byId<HTMLSelectElement>("Bukhhalter-podlegle-name-select");
  if (nameSelect) {
    nameSelect.value = "";
  }

  // ✅ 3. Очищаємо поле "Робота"
  const workInput = byId<HTMLInputElement>("Bukhhalter-podlegle-work-input");
  if (workInput) {
    workInput.value = "";
  }

  // ✅ 3.1 Очищаємо селект номера акту
  const actSelect = byId<HTMLSelectElement>("Bukhhalter-podlegle-act-select");
  if (actSelect) {
    actSelect.value = "";
  }

  // ✅ 4. Скидаємо перемикач статусу актів на "Всі" (значення "2")
  const statusToggle = byId<HTMLInputElement>("details-status-filter-toggle");
  if (statusToggle) {
    statusToggle.value = "2";
    currentStatusFilter = "all";
    // Тригеримо подію change для оновлення UI
    statusToggle.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ✅ 5. Скидаємо перемикач розрахунків на "Всі" (значення "2")
  const paymentToggle = byId<HTMLInputElement>("payment-filter-toggle");
  if (paymentToggle) {
    paymentToggle.value = "2";
    currentPaymentFilter = "all";
    // Тригеримо подію change для оновлення UI
    paymentToggle.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ✅ 6. Скидаємо перемикач процентів на "Всі" (значення "2")
  const percentageToggle = byId<HTMLInputElement>("percentage-filter-toggle");
  if (percentageToggle) {
    percentageToggle.value = "2";
    currentPercentageFilter = "all";
    // Тригеримо подію change для оновлення UI
    percentageToggle.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ✅ 7. Скидаємо режим фільтрації дат на "Відкриття"
  podlegleDateFilterMode = "open";
  const dateFilterButtons = document.querySelectorAll(
    "#Bukhhalter-podlegle-section .date-filter-btn",
  );
  dateFilterButtons.forEach((btn) => {
    if ((btn as HTMLButtonElement).dataset.filter === "open") {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // ✅ 7. Очищаємо дані
  podlegleData = [];
  allPodlegleData = [];
  hasPodlegleDataLoaded = false;
  payrollReportGeneration++; payrollReport = null; payrollVisibleCount = 0; payrollReportLoading = false; hiddenPayrollKeys.clear(); clearPayrollReportCache(); payrollScroll.reset(); updatePayrollPager();
  lastSearchDateOpen = "";
  lastSearchDateClose = "";

  // ✅ 8. Оновлюємо таблицю
  updatepodlegleTable();

  showNotification("🗑️ Фільтри та дані очищено", "info", 1500);
}

(window as any).runMassPaymentCalculation = runMassPaymentCalculation;
(window as any).togglepodleglePaymentWithConfirmation =
  togglepodleglePaymentWithConfirmation;
(window as any).updatePodlegleDisplayedSums = updatePodlegleDisplayedSums;
(window as any).clearpodlegleForm = clearpodlegleForm;

// Ініціалізація випадаючого списку робіт та перемикача дат при завантаженні
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    ensureWorkSmartDropdown();
    initPodlegleDateFilterToggle();
    initPodlegleDateAutoFilter(); // 👈 нове

    // 🔹 Ініціалізація обробника для селекту номера акту
    const actSelectEl = byId<HTMLSelectElement>(
      "Bukhhalter-podlegle-act-select",
    );
    if (actSelectEl) {
      actSelectEl.addEventListener("change", () => {
        triggerPodlegleAutoFilter();
      });
    }
  }, 100);
});

export { initPodlegleDateFilterToggle, podlegleDateFilterMode };
