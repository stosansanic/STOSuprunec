import { announceAccountingChange, accountingSearchScope } from "./accountingPeriod";
import { accountingInitialRows, createAccountingScroll, setAccountingRows, withAccountingExportRows, accountingVisibleRows, ACCOUNTING_FETCH_BATCH, ACCOUNTING_VISIBLE_STEP } from "./accountingLazyRows";
import { mergeHistoryRows } from "./reportCacheFilter";
import { patchShopDetailPayments } from "./shopReportRead";
import { confirmAccountingPayment, withAccountingPaymentOperation } from "./accountingPaymentConfirmation";
import { saveDetailPayments, type DetailPaymentTarget } from "./shopPaymentWrite";
import { readShopReportPage, invalidateShopReport, type ShopReportFilter, type ShopReportPage } from "./shopReportRead";
import { accountingToday, readAccountingPeriod } from "./accountingPeriod";
import { trackShopPaymentData } from "./shopPaymentWrite";
// src/ts/roboha/bukhhalteriya/poAktam.ts

import {
  byId,
  formatNumber,
  formatDate,
  updateTotalSum,
} from "./bukhhalteriya";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import {
  getSavedUserDataFromLocalStorage,
  userAccessLevel,
} from "../tablucya/users";
import { checkCurrentPageAccess } from "../zakaz_naraudy/inhi/page_access_guard";
import { redirectToIndex } from "../../utils/gitUtils";

const FULL_ACCESS_ALIASES = ["адміністратор", "full", "admin", "administrator"];

// Типи для фільтрів
type StatusFilter = "closed" | "open" | "all";
type PaymentFilter = "paid" | "unpaid" | "all";

// Змінні для фільтрів
let currentStatusFilter: StatusFilter = "all";
let currentPaymentFilterDetails: PaymentFilter = "all";

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

// Інтерфейс для деталей у JSON
interface Detail {
  sclad_id: number;
  Ціна: number;
  Каталог: number;
  Кількість: number;
  Найменування: string;
  Розраховано?: string;
}

// Інтерфейс для запису історії у JSON
interface HistoryRecord {
  Акт: number;
  Деталі: Detail[];
  Клієнт: string;
  Автомобіль: string;
  ДатаЗакриття: string | null;
  Розрахунок?: string;
}

// Інтерфейс для JSON із бази даних
interface ShopData {
  shopId?: number;
  Name: string;
  Склад: Record<string, any>;
  Історія: Record<string, HistoryRecord[]>;
  "Про магазин": string;
}

// Інтерфейс для записів деталей по актам
export interface DetailsRecord {
  rowId?: string;
  entryOrdinal?: number;
  detailOrdinal?: number;
  paymentFingerprint?: string;
  recordId?: string;
  shopId?: number;
  dateOpen: string;
  dateClose: string | null;
  act: string;
  automobile: string;
  shop: string;
  item: string;
  catalog: string;
  quantity: number;
  price: number;
  purchasePrice?: number;
  total: number;
  margin?: number;
  discountPercent?: number;
  isPaid: boolean;
  paymentDate?: string;
  sclad_id?: number;
  scladNomer?: number; // Номер складу з таблиці sclad
  zapchastystName?: string; // Ім'я Запчастиста хто оприходував
  isClosed: boolean;
}

// Змінні для зберігання даних деталей
let detailsData: DetailsRecord[] = [];
let shopsData: ShopData[] = [];
let shopPaymentBusy = false;
let shopPaymentNeedsRefresh = false;
let reportPage: ShopReportPage | null = null;
let reportLoading = false;
let reportSearchFailed = false;
let reportGeneration = 0;
let appliedReportFilter: ShopReportFilter | null = null;
let appliedReportScope = '';
let detailsVisibleCount = 0;
const hiddenDetails = new Map<string, DetailsRecord>();
const detailsScroll = createAccountingScroll('details-tbody', showMoreDetailsRows);

async function showMoreDetailsRows(): Promise<void> {
  if (reportLoading || shopPaymentBusy) { updateReportPagination(); return; }
  if (JSON.stringify(appliedReportFilter) !== JSON.stringify(currentReportFilter()) || appliedReportScope !== accountingSearchScope('shops')) {
    await loadDetailsPage(0); return;
  }
  if (detailsVisibleCount < detailsData.length) {
    detailsVisibleCount = Math.min(detailsVisibleCount + ACCOUNTING_VISIBLE_STEP, detailsData.length);
    updateDetailsTable(); updateReportPagination(); return;
  }
  await loadDetailsPage(reportPage?.items.length || 0, false, true);
}

function currentReportFilter(): ShopReportFilter {
  const from = getDetailsInputValue("Bukhhalter-details-date-open");
  const to = getDetailsInputValue("Bukhhalter-details-date-close");
  return {dateMode: detailsDateFilterMode, from: toIsoDate(from), to: toIsoDate(to) || accountingToday(),
    item: getDetailsInputValue("Bukhhalter-details-item"), catalog: getDetailsInputValue("Bukhhalter-details-catalog"),
    status: currentStatusFilter, payment: currentPaymentFilterDetails, warehouse: currentDetailsScladFilter};
}

function trackReportShops(rows: ShopReportPage["shops"]): ShopData[] {
  return rows.map(row => {
    const data = structuredClone(row.data);
    // Internal ID is non-enumerable, so it never enters the persisted JSON baseline.
    Object.defineProperty(data, "shopId", {value: Number(row.shop_id)});
    return trackShopPaymentData(Number(row.shop_id), data);
  });
}

function updateReportPagination(): void {
  document.getElementById("details-report-pagination")?.remove();
  if (!reportPage) { detailsScroll.update({more: false, busy: reportLoading, shown: 0}); return; }
  detailsScroll.update({more: !reportSearchFailed && (reportPage.items.length < reportPage.totalCount || detailsVisibleCount < detailsData.length), busy: reportLoading || shopPaymentBusy,
    shown: Math.min(detailsVisibleCount, detailsData.length), total: reportPage.totalCount - hiddenDetails.size});
}

function mergeDetailsPages(first: ShopReportPage, next: ShopReportPage): ShopReportPage {
  const shops = mergeHistoryRows([...first.shops, ...next.shops], row => row.shop_id);
  const items = [...first.items, ...next.items];
  if (!shops || first.revision !== next.revision || first.totalCount !== next.totalCount || JSON.stringify(first.totals) !== JSON.stringify(next.totals) ||
      new Set(items.map(row => row.rowId)).size !== items.length) throw new Error('Деталі змінилися під час прокрутки. Повторіть пошук.');
  return {...next, shops, items};
}
async function loadDetailsPage(offset: number, force = false, append = false, preserveCount = false, paymentRefresh = false): Promise<void> {
  if (shopPaymentBusy || (append && reportLoading)) return;
  if (!readAccountingPeriod("details")) { reportGeneration++; detailsScroll.reset(); return; }
  const generation = ++reportGeneration, filter = currentReportFilter();
  const scope = accountingSearchScope('shops');
  if (append && appliedReportScope !== scope) { await loadDetailsPage(0); return; }
  const current = () => generation === reportGeneration && scope === accountingSearchScope('shops') && JSON.stringify(filter) === JSON.stringify(currentReportFilter());
  if (append && JSON.stringify(appliedReportFilter) !== JSON.stringify(filter)) { detailsScroll.pause(); return; }
  const target = preserveCount && !paymentRefresh ? reportPage?.items.length || 0 : 0;
  const visibleTarget = append ? detailsVisibleCount + ACCOUNTING_VISIBLE_STEP : preserveCount ? detailsVisibleCount : accountingInitialRows('details-tbody');
  if (!append) { detailsScroll.reset(); if (!preserveCount) hiddenDetails.clear(); }
  reportSearchFailed = false; reportLoading = true; updateReportPagination();
  try {
    let page = await readShopReportPage(filter, offset, force, undefined, append ? ACCOUNTING_FETCH_BATCH : paymentRefresh ? Math.max(1, Math.min(200, detailsData.length)) : visibleTarget);
    if (!current()) return;
    if (append && reportPage) page = mergeDetailsPages(reportPage, page);
    while (!append && page.items.length < Math.min(target, page.totalCount)) {
      const next = await readShopReportPage(filter, page.items.length, false, undefined, Math.min(200, target - page.items.length));
      if (!current()) return;
      page = mergeDetailsPages(page, next);
    }
    reportPage = page; appliedReportFilter = filter; appliedReportScope = scope;
    shopPaymentNeedsRefresh = false;
    detailsData = page.items.filter(row => !hiddenDetails.has(row.rowId)); allDetailsData = detailsData; shopsData = trackReportShops(page.shops);
    detailsVisibleCount = Math.min(visibleTarget, detailsData.length);
    hasDetailsDataLoaded = true;
    ensureDetailsSmartDropdowns(); refreshDetailsDropdownOptions(); updateDetailsScladFilterButtons();
    updateDetailsTable(); updateReportPagination();
  } catch (error) {
    if (generation !== reportGeneration) return;
    if (paymentRefresh) shopPaymentNeedsRefresh = true;
    showNotification(paymentRefresh
      ? 'Розрахунок збережено. Не вдалося оновити звіт; повторіть пошук.'
      : `Не вдалося завантажити звіт: ${error instanceof Error ? error.message : (error as any)?.message || "перевірте встановлення SQL звіту"}`, paymentRefresh ? 'warning' : 'error');
    if (append) throw error;
    reportSearchFailed = true; detailsScroll.pause();
  } finally { if (generation === reportGeneration) { reportLoading = false; updateReportPagination(); } }
}

// Export reader; mass payments collect pages separately with revision validation.
async function readAllFilteredPaymentRows(track = true): Promise<DetailsRecord[]> {
  if (!appliedReportFilter) return [];
  const filter = structuredClone(appliedReportFilter), rows: DetailsRecord[] = [];
  const shops = new Map<number, any>();
  const rowIds = new Set<string>();
  let expectedCount: number | null = null;
  for (let offset = 0; ; offset += 100) {
    const page = await readShopReportPage(filter, offset, track && offset === 0);
    if (expectedCount !== null && page.totalCount !== expectedCount) throw new Error("Звіт змінено: повторіть розрахунок");
    expectedCount = page.totalCount;
    for (const row of page.items) {
      if (!row.rowId || rowIds.has(row.rowId)) throw new Error("Повторний рядок: оновіть звіт");
      rowIds.add(row.rowId);
    }
    rows.push(...page.items);
    for (const row of page.shops) {
      let shop = shops.get(row.shop_id);
      if (!shop) { shop = {Name: row.data.Name, Історія: {}}; shops.set(row.shop_id, shop); }
      for (const [date, entries] of Object.entries(row.data.Історія) as [string, HistoryRecord[]][]) {
        const existing: HistoryRecord[] = shop.Історія[date] ||= [];
        for (const entry of entries) {
          const previous = existing.find(e => String(e.Акт) === String(entry.Акт));
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw new Error("Акт змінено: оновіть звіт");
          if (!previous) existing.push(entry);
        }
      }
    }
    if (offset + page.items.length >= page.totalCount) break;
    if (!page.items.length) throw new Error("Неповна сторінка масового розрахунку");
  }
  if (track) shopsData = trackReportShops([...shops].map(([shop_id,data]) => ({shop_id,data})));
  return rows;
}

// НОВІ ЗМІННІ ДЛЯ АВТОФІЛЬТРАЦІЇ
let allDetailsData: DetailsRecord[] = [];
let hasDetailsDataLoaded = false;
let autoDetailsSearchTimer: number | null = null;
const AUTO_DETAILS_SEARCH_DELAY = 350;

// Змінна для фільтру по складу в деталях
let currentDetailsScladFilter: number | null = null;
let availableDetailsScladNomers: number[] = [];

function debounceDetailsAutoSearch(fn: () => void) {
  if (autoDetailsSearchTimer !== null) {
    clearTimeout(autoDetailsSearchTimer);
  }
  autoDetailsSearchTimer = window.setTimeout(() => {
    autoDetailsSearchTimer = null;
    fn();
  }, AUTO_DETAILS_SEARCH_DELAY);
}

// ВИПАДАЮЧІ СПИСКИ
interface DetailsDropdownConfig {
  inputId: string;
  listId: string;
  placeholder: string;
  maxItems: number;
}

const detailsDropdownConfigs: DetailsDropdownConfig[] = [
  {
    inputId: "Bukhhalter-details-item",
    listId: "dl-details-item",
    placeholder: "Введіть або оберіть найменування...",
    maxItems: 150,
  },
  {
    inputId: "Bukhhalter-details-catalog",
    listId: "dl-details-catalog",
    placeholder: "Введіть або оберіть Каталог номер...",
    maxItems: 100,
  },
];

class DetailsSmartDropdown {
  private input: HTMLInputElement;
  private dropdown: HTMLDivElement;
  public readonly config: DetailsDropdownConfig;
  private items: string[] = [];
  private filteredItems: string[] = [];
  private selectedIndex = -1;
  private isOpen = false;

  constructor(config: DetailsDropdownConfig) {
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
      if (this.config.inputId === "Bukhhalter-details-catalog") {
        const sanitized = sanitizeCatalogInputValue(this.input.value);
        if (this.input.value !== sanitized) {
          this.input.value = sanitized;
        }
      }

      this.filter(this.input.value);
      if (!this.isOpen) this.show();

      if (hasDetailsDataLoaded) {
        debounceDetailsAutoSearch(() => {
          autoFilterDetailsFromInputs();
        });
      } else {
        debounceDetailsAutoSearch(() => {
          void autoSearchDetailsFromInputs();
        });
      }
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
    const normalizedQuery = normalizeCatalogSearch(query);
    const isCatalogDropdown =
      this.config.inputId === "Bukhhalter-details-catalog";
    this.filteredItems = q
      ? this.items
          .filter((item) =>
            isCatalogDropdown
              ? item.toLowerCase().includes(q) ||
                normalizeCatalogSearch(item).includes(normalizedQuery)
              : item.toLowerCase().includes(q),
          )
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
    this.filter(this.input.value);
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
      this.input.value = this.filteredItems[index];
      this.hide();

      if (hasDetailsDataLoaded) {
        debounceDetailsAutoSearch(() => {
          autoFilterDetailsFromInputs();
        });
      } else {
        debounceDetailsAutoSearch(() => {
          void autoSearchDetailsFromInputs();
        });
      }
    }
  }

  private scrollToSelected() {
    const selected = this.dropdown.querySelector(".dropdown-item.selected");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }
}

let detailsSmartDropdowns: DetailsSmartDropdown[] = [];

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

function ensureDetailsSmartDropdowns(): void {
  addDropdownStyles();

  if (detailsSmartDropdowns.length === 0) {
    detailsSmartDropdowns = detailsDropdownConfigs
      .filter((config) => document.getElementById(config.inputId))
      .map((config) => {
        try {
          return new DetailsSmartDropdown(config);
        } catch (error) {
          // console.warn(
          // `Failed to create details dropdown for ${config.inputId}:`,
          // error,
          // );
          return null;
        }
      })
      .filter(
        (dropdown): dropdown is DetailsSmartDropdown => dropdown !== null,
      );
  }
}

function refreshDetailsDropdownOptions(): void {
  const items = new Set<string>();
  const catalogs = new Set<string>();

  allDetailsData.forEach((r) => {
    if (r.item?.trim()) items.add(r.item.trim());
    if (r.catalog?.trim()) catalogs.add(r.catalog.trim());
  });

  detailsSmartDropdowns.forEach((dropdown) => {
    if (dropdown.config.inputId === "Bukhhalter-details-item") {
      dropdown.updateItems(Array.from(items));
    } else if (dropdown.config.inputId === "Bukhhalter-details-catalog") {
      dropdown.updateItems(Array.from(catalogs));
    }
  });
}

function getDetailsInputValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | null;
  return (el?.value || "").trim();
}

// Функція для фільтрації завантажених даних
export function filterDetailsData(): void { if (hasDetailsDataLoaded) void loadDetailsPage(0); }

// Автофільтрація з урахуванням статусу актів + надійні дати
function autoFilterDetailsFromInputs(): void {
  filterDetailsData();
}

async function autoSearchDetailsFromInputs(): Promise<void> { await loadDetailsPage(0); }

// Обчислення загальної суми деталей
export function calculateDetailsTotalSum(): number {
  if (reportPage) return reportPage.totals.sale - [...hiddenDetails.values()].reduce((sum, row) => sum + (row.total || 0), 0);
  return detailsData.reduce((sum, item) => sum + (item.total || 0), 0);
}

function calculateDetailsPurchaseTotal(): number {
  if (reportPage) return reportPage.totals.purchase - [...hiddenDetails.values()].reduce((sum, row) => sum + (row.purchasePrice || 0) * row.quantity, 0);
  return detailsData.reduce((sum, item) => {
    const purchaseTotal = (item.purchasePrice || 0) * (item.quantity || 0);
    return sum + purchaseTotal;
  }, 0);
}

function calculateDetailsMarginTotal(): number {
  if (reportPage) return reportPage.totals.margin - [...hiddenDetails.values()].reduce((sum, row) => sum + (row.margin || 0), 0);
  return detailsData.reduce((sum, item) => sum + (item.margin || 0), 0);
}

// Оновлення таблиці з кольоровим кодуванням та фільтрацією
export function updateDetailsTable(): void {
  const tbody = byId<HTMLTableSectionElement>("details-tbody");

  // Перевірка чи елемент існує (може бути null якщо не на сторінці bukhhalteriya.html)
  if (!tbody) {
    return;
  }

  const filteredData = detailsData;

  if (filteredData.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="13" class="Bukhhalter-no-data">Немає даних для відображення</td></tr>';

    updateDetailsTotalSumDisplay(0, 0, 0);
    return;
  }

  setAccountingRows(tbody, accountingVisibleRows(filteredData, reportPage ? detailsVisibleCount : filteredData.length)
    .map((item, index) => {
      const originalIndex = detailsData.indexOf(item);
      const rowClass = item.isClosed ? "closed-row" : "open-row";
      const paidClass = item.isPaid ? "paid-row" : "unpaid-row";

      // Формуємо текст для кнопки розрахунку
      const paymentButtonText = item.isPaid
        ? `💰 ${item.paymentDate || "Розраховано"}`
        : "💲 Не розраховано";

      // Форматування цін
      const purchasePriceHtml =
        item.purchasePrice !== undefined
          ? `<div style="font-size: 0.85em; color: #666; border-bottom: 1px solid #ddd; padding-bottom: 2px; margin-bottom: 2px;">${formatNumber(
              item.purchasePrice,
            )}</div>`
          : '<div style="font-size: 0.85em; color: #999; border-bottom: 1px solid #ddd; padding-bottom: 2px; margin-bottom: 2px;">-</div>';

      const salePriceHtml = `<div style="font-size: 0.95em; font-weight: 500;">${formatNumber(
        item.price,
      )}</div>`;

      // Показуємо маржу з індикатором знижки якщо вона є
      const discountIndicator =
        item.discountPercent && item.discountPercent > 0
          ? ` <span style="color: #ff9800; font-size: 0.75em;">(-${item.discountPercent}%)</span>`
          : "";

      const marginHtml =
        item.margin !== undefined
          ? `<div style="font-size: 0.85em; color: ${
              item.margin >= 0 ? "#28a745" : "#dc3545"
            }; font-weight: 500; margin-top: 2px;">${item.margin >= 0 ? "+" : ""}${formatNumber(
              item.margin,
            )}${discountIndicator}</div>`
          : "";

      return `
        <tr class="${rowClass} ${paidClass}" onclick="handleRowClick(${index})">
          <td>
            <button class="Bukhhalter-payment-btn ${
              item.isPaid ? "paid" : "unpaid"
            }" 
                    onclick="event.stopPropagation(); toggleDetailsPaymentWithConfirmation(${originalIndex})" 
                    title="${
                      item.isPaid
                        ? `Розраховано ${item.paymentDate || ""}`
                        : "Не розраховано"
                    }">
              ${paymentButtonText}
            </button>
          </td>
          <td>${formatDate(item.dateOpen)}</td>
          <td>${formatDate(item.dateClose || "")}</td>
          <td>
            <button class="Bukhhalter-act-btn"
                    onclick="event.stopPropagation(); openActModalWithClient(${
                      Number(item.act) || 0
                    })"
                    title="Відкрити акт №${item.act}">
              📋 ${item.act || "-"}
            </button>
          </td>
          <td>${item.automobile || "-"}</td>
          <td>${item.shop || "-"}</td>
          <td>${item.item || "-"}</td>
          <td>${item.catalog || "-"}</td>
          <td>${item.quantity || "-"}</td>
          <td style="padding: 8px;">
            ${purchasePriceHtml}
            ${salePriceHtml}
          </td>
          <td>${item.total ? formatNumber(item.total) : "-"}${marginHtml}</td>
          <td class="sklad-cell">${item.scladNomer || "-"}</td>
          <td>
            <button class="Bukhhalter-delete-btn"
                    onclick="event.stopPropagation(); deleteRecord('details', ${originalIndex})">🗑️</button>
          </td>
        </tr>
      `;
    })
    .join(""));

  // Розраховуємо три суми з відфільтрованих даних
  const purchaseTotal = calculateDetailsPurchaseTotal();
  const saleTotal = calculateDetailsTotalSum();
  const marginTotal = calculateDetailsMarginTotal();

  updateDetailsTotalSumDisplay(purchaseTotal, saleTotal, marginTotal);
}

// Функція для оновлення відображення трьох сум:
function updateDetailsTotalSumDisplay(
  purchaseTotal: number,
  saleTotal: number,
  marginTotal: number,
): void {
  const totalSumElement = byId<HTMLElement>("total-sum");

  if (totalSumElement) {
    const marginSign = marginTotal >= 0 ? "+" : "";

    totalSumElement.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 15px; font-size: 1.1em;">
        <span>Сума <strong style="color: #333;">💰 ${formatNumber(
          saleTotal,
        )}</strong> грн</span>
        <span style="color: #666;">-</span>
        <span><strong style="color: #8B0000;">💶 ${formatNumber(
          purchaseTotal,
        )}</strong> грн</span>
        <span style="color: #666;">=</span>
        <span><strong style="color: ${
          marginTotal >= 0 ? "#006400 " : "#8B0000"
        };">📈 ${marginSign}${formatNumber(marginTotal)}</strong> грн</span>
      </div>
    `;
  }
}

// ==== DATE HELPERS (оновлено, додати один раз у файлі) ====
function toIsoDate(input: string | null | undefined): string {
  if (!input) return "";
  const isoDatePrefix = String(input)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (isoDatePrefix) {
    return `${isoDatePrefix[1]}-${isoDatePrefix[2]}-${isoDatePrefix[3]}`;
  }
  // чистимо емодзі/текст і лишаємо цифри та роздільники
  const s = String(input)
    .normalize("NFKC")
    .trim()
    .replace(/[^\d.\-\/]/g, "");

  if (!s) return "";

  // YMD: YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  let m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/);
  if (m) {
    const yyyy = m[1];
    const mm = m[2].padStart(2, "0");
    const dd = m[3].padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // DMY: DD.MM.YYYY / DD-MM-YYYY / DD/MM/YY
  m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yyyy = m[3];
    if (yyyy.length === 2) {
      yyyy = (+yyyy >= 70 ? "19" : "20") + yyyy; // 70–99 -> 19xx, інакше 20xx
    }
    return `${yyyy}-${mm}-${dd}`;
  }

  return "";
}


// Функція пошуку з визначенням статусу акту
export async function searchDetailsData(): Promise<void> { if (!readAccountingPeriod("details")) return; if (!await checkCurrentPageAccess()) { redirectToIndex(); return; } await loadDetailsPage(0); }

function initDetailsAutoBehaviors(): void {
  const trigger = () => {
    if (hasDetailsDataLoaded) {
      debounceDetailsAutoSearch(() => {
        autoFilterDetailsFromInputs();
      });
    } else {
      debounceDetailsAutoSearch(() => {
        void autoSearchDetailsFromInputs();
      });
    }
  };

  const openEl = document.getElementById(
    "Bukhhalter-details-date-open",
  ) as HTMLInputElement | null;
  const closeEl = document.getElementById(
    "Bukhhalter-details-date-close",
  ) as HTMLInputElement | null;
  openEl?.addEventListener("change", trigger);
  closeEl?.addEventListener("change", trigger);

  ["Bukhhalter-details-item", "Bukhhalter-details-catalog"].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.addEventListener("input", trigger);
      el.addEventListener("focus", trigger);
    }
  });

  ensureDetailsSmartDropdowns();
  initDetailsDateFilterToggle();
}

export function createDetailsStatusToggle(): void {
  const toggle = byId<HTMLInputElement>("poAktam-status-filter-toggle");

  if (!toggle) {
    // console.error("❌ Елемент poAktam-status-filter-toggle не знайдено в HTML");
    return;
  }

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

    // ЗМІНЕНО: використовуємо filterDetailsData замість updateDetailsTable
    if (hasDetailsDataLoaded) {
      filterDetailsData();
    } else {
      updateDetailsTable();
    }
    updateTotalSum();
  });

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

    // ЗМІНЕНО: використовуємо filterDetailsData
    if (hasDetailsDataLoaded) {
      filterDetailsData();
    } else {
      updateDetailsTable();
    }
  });
}

// Створення перемикача для фільтра розрахунків деталей
export function createDetailsPaymentToggle(): void {
  const toggle = byId<HTMLInputElement>("poAktam-payment-filter-toggle");

  if (!toggle) {
    // console.error("❌ Елемент poAktam-payment-filter-toggle не знайдено");
    return;
  }

  toggle.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const value = target.value;

    switch (value) {
      case "0":
        currentPaymentFilterDetails = "paid";
        break;
      case "1":
        currentPaymentFilterDetails = "unpaid";
        break;
      case "2":
      default:
        currentPaymentFilterDetails = "all";
        break;
    }

    // ЗМІНЕНО: використовуємо filterDetailsData
    if (hasDetailsDataLoaded) {
      filterDetailsData();
    } else {
      updateDetailsTable();
    }
    updateTotalSum();
  });
}

// ==================== ФІЛЬТР ПО СКЛАДАХ ДЛЯ ДЕТАЛЕЙ ====================

// Отримати унікальні номери складів з даних деталей
function getUniqueDetailsScladNomers(): number[] {
  if (reportPage) return reportPage.warehouses;
  const scladSet = new Set<number>();
  allDetailsData.forEach((item) => {
    if (item.scladNomer && typeof item.scladNomer === "number") {
      scladSet.add(item.scladNomer);
    }
  });
  return Array.from(scladSet).sort((a, b) => a - b);
}

// Оновити кнопки фільтрації складів для деталей
export function updateDetailsScladFilterButtons(): void {
  const container = byId<HTMLElement>("details-sklad-filter-container");
  if (!container) return;

  availableDetailsScladNomers = getUniqueDetailsScladNomers();

  // Якщо немає складів або тільки 1 склад - не показуємо кнопки
  if (
    availableDetailsScladNomers.length === 0 ||
    availableDetailsScladNomers.length === 1
  ) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  // Додаємо клас для однакової ширини кнопок
  container.classList.add("equal-width");

  let buttonsHtml = "";

  availableDetailsScladNomers.forEach((nomer) => {
    const isActive = currentDetailsScladFilter === nomer;
    buttonsHtml += `
      <button 
        class="Bukhhalter-sklad-btn ${isActive ? "active" : ""}" 
        data-sclad-nomer="${nomer}"
        onclick="filterDetailsBySclad(${nomer})"
        title="Показати склад ${nomer}"
      >
        Склад ${nomer}
      </button>
    `;
  });

  // Кнопка "Всі" - помаранчева
  const isAllActive = currentDetailsScladFilter === null;
  buttonsHtml += `
    <button 
      class="Bukhhalter-sklad-btn Bukhhalter-sklad-btn-all ${isAllActive ? "active" : ""}" 
      data-sclad-nomer="all"
      onclick="filterDetailsBySclad(null)"
      title="Показати всі склади"
    >
      Всі
    </button>
  `;

  container.innerHTML = buttonsHtml;
}

// Функція фільтрації по складу для деталей
function filterDetailsBySclad(scladNomer: number | null): void {
  currentDetailsScladFilter = scladNomer;

  // Оновлюємо активну кнопку
  const container = byId<HTMLElement>("details-sklad-filter-container");
  if (container) {
    const buttons = container.querySelectorAll(".Bukhhalter-sklad-btn");
    buttons.forEach((btn) => {
      const btnNomer = btn.getAttribute("data-sclad-nomer");
      if (scladNomer === null) {
        btn.classList.toggle("active", btnNomer === "all");
      } else {
        btn.classList.toggle("active", btnNomer === String(scladNomer));
      }
    });
  }

  filterDetailsData();
}

// Експорт для глобального доступу
(window as any).filterDetailsBySclad = filterDetailsBySclad;

export function initializeDetailsData(): void {
  detailsData = [];
  allDetailsData = [];
  hasDetailsDataLoaded = false;
  updateDetailsTable();
  initDetailsAutoBehaviors();
  createDetailsStatusToggle();
  createDetailsPaymentToggle();
}

// Глобальна змінна для зберігання поточного фільтра дат
let detailsDateFilterMode: "open" | "close" | "paid" = "open";

// Функція для ініціалізації перемикача фільтрації дат для деталей
function initDetailsDateFilterToggle(): void {
  const toggleContainer = document.querySelector(
    "#Bukhhalter-details-section .Bukhhalter-date-filter-toggle",
  );
  if (!toggleContainer) return;

  const buttons =
    toggleContainer.querySelectorAll<HTMLButtonElement>(".date-filter-btn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", function () {
      buttons.forEach((b) => b.classList.remove("active"));
      this.classList.add("active");

      detailsDateFilterMode = this.dataset.filter as "open" | "close" | "paid";

      // ЗМІНЕНО: просто застосовуємо фільтр до вже завантажених даних
      if (hasDetailsDataLoaded) {
        filterDetailsData();
      }
    });
  });
}

// Функція для кнопки "Пошук"
export async function addDetailsRecord(): Promise<void> {
  await searchDetailsData();
}

// Видалення запису деталей
export function deleteDetailsRecord(index: number): void {
  if (index >= 0 && index < detailsData.length) {
    // This action only removes a row from the displayed report; preserve that
    // existing behavior while keeping global displayed totals consistent.
    if (reportPage) {
      const row = detailsData[index];
      // Do not shorten the server cursor or alter its baseline totals.
      if (row.rowId) hiddenDetails.set(row.rowId, row);
    }
    detailsData.splice(index, 1);
    updateDetailsTable();
    updateTotalSum();
    updateReportPagination();
    showNotification("🗑️ Запис видалено", "info");
  }
}

/** Keep the confirmed selection unchanged while the payment dialog is open. */
function detailsPaymentSnapshotCurrent(rows: DetailsRecord[], scope: string, generation: number, filter: string, bulk = false): boolean {
  return scope === accountingSearchScope('shops') && generation === reportGeneration && filter === JSON.stringify(currentReportFilter()) &&
    filter === JSON.stringify(appliedReportFilter) && rows.every(saved => {
      const current = (bulk ? reportPage?.items || [] : detailsData).find(row => row.rowId === saved.rowId);
      return current && JSON.stringify(current) === JSON.stringify(saved);
    });
}
async function performDetailsPayment(rows: DetailsRecord[], action: 'pay' | 'unpay', bulk = false): Promise<void> {
  if (shopPaymentBusy || reportLoading) return;
  if (!hasFullAccess()) { showNotification('Недостатньо прав для розрахунку', 'warning'); return; }
  if (shopPaymentNeedsRefresh) { showNotification('Спочатку повторіть пошук після помилки розрахунку', 'warning'); return; }
  if (!rows.length) { showNotification('За поточними фільтрами немає позицій для розрахунку', 'info'); return; }
  if (rows.some(row => !row.rowId || !row.shopId || !row.entryOrdinal || !row.detailOrdinal || !/^[a-f0-9]{64}$/.test(row.paymentFingerprint || ''))) {
    showNotification('Оновіть SQL бухгалтерії та повторіть пошук.', 'warning'); return;
  }
  const targets = structuredClone(rows), scope = accountingSearchScope('shops'), generation = reportGeneration, filter = JSON.stringify(appliedReportFilter);
  const current = () => detailsPaymentSnapshotCurrent(targets, scope, generation, filter, bulk);
  if (!current() || !readAccountingPeriod('details')) { showNotification('Звіт змінився. Повторіть пошук.', 'warning'); return; }
  if (targets.length > 2000) { showNotification('Звузьте період або фільтр до 2000 неоплачених позицій. Оплату не виконано.', 'warning'); return; }
  let committed = false, needsPage = false;
  shopPaymentBusy = true; updateReportPagination();
  try {
    const sum = targets.reduce((value, row) => value + row.total, 0);
    if (!await confirmAccountingPayment(action, `${bulk ? 'Усі неоплачені позиції за поточними фільтрами' : 'Обрана позиція'}: ${targets.length}; сума: ${formatNumber(sum)} грн.`, current)) return;
    if (!current() || !hasFullAccess()) throw new Error('Звіт або користувач змінився. Повторіть операцію.');
    const receipts = await saveDetailPayments(targets as DetailPaymentTarget[], action === 'pay' ? accountingToday() : null);
    committed = true;
    if (!current()) {
      shopPaymentNeedsRefresh = true; invalidateShopReport(); detailsScroll.pause();
      showNotification('Розрахунок збережено. Користувач або звіт змінився; повторіть пошук.', 'warning'); return;
    }
    const edits = new Map(receipts.map(receipt => [receipt.rowId, receipt]));
    for (const row of [...detailsData, ...(reportPage?.items || [])]) {
      const receipt = row.rowId && edits.get(row.rowId);
      if (receipt) { row.isPaid = !!receipt.paidAt; row.paymentDate = receipt.paidAt || ''; }
    }
    patchShopDetailPayments(receipts); announceAccountingChange(['shops'], ['shops']);
    needsPage = appliedReportFilter?.payment !== 'all' || appliedReportFilter?.dateMode === 'paid';
    updateDetailsTable(); updateTotalSum();
    showNotification(`Розрахунок збережено: ${receipts.length} позицій`, 'success');
  } catch (error) {
    if (!committed) { shopPaymentNeedsRefresh = true; invalidateShopReport(); }
    showNotification((error as Error)?.message || 'Не вдалося підтвердити розрахунок. Повторіть пошук.', 'error');
  } finally { shopPaymentBusy = false; updateReportPagination(); }
  // Date/payment filters can change membership; a single bounded read repairs the cursor.
  if (committed && needsPage && scope === accountingSearchScope('shops')) await loadDetailsPage(0, false, false, true, true);
}
export async function toggleDetailsPaymentWithConfirmation(index: number): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    const row = detailsData[index];
    if (row) await performDetailsPayment([row], row.isPaid ? 'unpay' : 'pay');
  });
}
export async function toggleDetailsPayment(index: number): Promise<void> {
  await toggleDetailsPaymentWithConfirmation(index);
}
export async function runMassPaymentCalculationForDetails(): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    if (shopPaymentBusy || reportLoading || !reportPage || !appliedReportFilter || shopPaymentNeedsRefresh || !hasFullAccess()) return;
    const filter = structuredClone(appliedReportFilter), scope = accountingSearchScope('shops'), generation = reportGeneration;
    const initial = reportPage;
    const current = () => generation === reportGeneration && scope === accountingSearchScope('shops') &&
      scope === appliedReportScope && JSON.stringify(filter) === JSON.stringify(currentReportFilter()) && reportPage === initial;
    if (!current() || !readAccountingPeriod('details')) return;
    shopPaymentBusy = true; updateReportPagination();
    try {
      let complete = initial;
      while (complete.items.length < complete.totalCount) {
        const page = await readShopReportPage(filter, complete.items.length, false, undefined, 200);
        if (!current()) throw new Error('Фільтри змінилися. Повторіть розрахунок.');
        if (!page.items.length) throw new Error('Неповний звіт. Повторіть пошук перед розрахунком.');
        complete = mergeDetailsPages(complete, page);
      }
      if (!current() || complete.items.length !== complete.totalCount) throw new Error('Звіт змінився. Повторіть пошук.');
      reportPage = complete;
      detailsData = complete.items.filter(row => !hiddenDetails.has(row.rowId)); allDetailsData = detailsData;
      shopsData = trackReportShops(complete.shops);
    } catch (error) {
      showNotification((error as Error)?.message || 'Не вдалося завантажити всі позиції. Оплату не виконано.', 'error');
      return;
    } finally { shopPaymentBusy = false; updateReportPagination(); }
    await performDetailsPayment(reportPage.items.filter(row => !row.isPaid), 'pay', true);
  });
}

// Очищення форми деталей
export function clearDetailsForm(): void {
  if (shopPaymentBusy) return;
  if (autoDetailsSearchTimer !== null) {
    clearTimeout(autoDetailsSearchTimer);
    autoDetailsSearchTimer = null;
  }
  currentDetailsScladFilter = null;
  availableDetailsScladNomers = [];
  hasDetailsDataLoaded = false;
  reportGeneration++;
  reportPage = null;
  reportLoading = false; reportSearchFailed = false; detailsVisibleCount = 0; hiddenDetails.clear(); detailsScroll.reset();
  appliedReportFilter = null;
  appliedReportScope = '';
  const detailsSection = byId<HTMLElement>("Bukhhalter-details-section");
  if (!detailsSection) return;

  // Очищаємо всі інпути
  const inputs = detailsSection.querySelectorAll<HTMLInputElement>(
    "input:not([readonly])",
  );
  inputs.forEach((input) => {
    input.value = "";
  });

  // Очищаємо всі селекти
  const selects = detailsSection.querySelectorAll<HTMLSelectElement>("select");
  selects.forEach((select) => {
    select.value = "";
  });

  // Скидаємо перемикачі статусу актів на "Всі" (значення "2")
  const statusToggle = byId<HTMLInputElement>("poAktam-status-filter-toggle");
  if (statusToggle) {
    statusToggle.value = "2";
    currentStatusFilter = "all";
  }

  // Скидаємо перемикачі розрахунків на "Всі" (значення "2")
  const paymentToggle = byId<HTMLInputElement>("poAktam-payment-filter-toggle");
  if (paymentToggle) {
    paymentToggle.value = "2";
    currentPaymentFilterDetails = "all";
  }

  // Скидаємо режим фільтрації дат на "Відкриття"
  detailsDateFilterMode = "open";
  const dateFilterButtons = document.querySelectorAll(
    "#Bukhhalter-details-section .date-filter-btn",
  );
  dateFilterButtons.forEach((btn) => {
    if ((btn as HTMLButtonElement).dataset.filter === "open") {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Очищаємо дані
  detailsData = [];
  allDetailsData = [];
  hasDetailsDataLoaded = false;

  // Оновлюємо таблицю
  updateDetailsTable();

  updateReportPagination();

  showNotification("🗑️ Фільтри та дані очищено", "info", 1500);
}

export async function exportDetailsReport(download: () => void): Promise<void> {
  if (shopPaymentBusy || reportLoading) throw new Error('Дочекайтеся завершення поточної операції.');
  if (!reportPage) { download(); return; }
  if (JSON.stringify(appliedReportFilter) !== JSON.stringify(currentReportFilter())) throw new Error('Повторіть пошук перед експортом.');
  const generation = reportGeneration, filter = JSON.stringify(appliedReportFilter);
  const previousRows = detailsData, previousShops = shopsData;
  reportLoading = true; updateReportPagination();
  try {
    const complete = await readAllFilteredPaymentRows(false);
    if (generation !== reportGeneration || filter !== JSON.stringify(currentReportFilter())) throw new Error('Фільтр змінився. Повторіть експорт.');
    detailsData = complete.filter(row => !hiddenDetails.has(row.rowId || ''));
    withAccountingExportRows('details-table', updateDetailsTable, download);
  } finally {
    if (generation === reportGeneration) {
      detailsData = previousRows; shopsData = previousShops; reportLoading = false; updateReportPagination();
    }
  }
}
// Оновлення відображених сум
export function updateDetailsDisplayedSums(): void {
  const purchaseTotal = calculateDetailsPurchaseTotal();
  const saleTotal = calculateDetailsTotalSum();
  const marginTotal = calculateDetailsMarginTotal();

  updateDetailsTotalSumDisplay(purchaseTotal, saleTotal, marginTotal);
}

// Глобалізація функцій
(window as any).runMassPaymentCalculationForDetails =
  runMassPaymentCalculationForDetails;
(window as any).updateDetailsDisplayedSums = updateDetailsDisplayedSums;
(window as any).createDetailsStatusToggle = createDetailsStatusToggle;
(window as any).toggleDetailsPaymentWithConfirmation =
  toggleDetailsPaymentWithConfirmation;
(window as any).createDetailsPaymentToggle = createDetailsPaymentToggle;

// Затримуємо ініціалізацію перемикачів при завантаженні сторінки
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    const statusToggle = document.getElementById(
      "poAktam-status-filter-toggle",
    ) as HTMLInputElement;
    const paymentToggle = document.getElementById(
      "poAktam-payment-filter-toggle",
    ) as HTMLInputElement;

    if (statusToggle) {
      createDetailsStatusToggle();
    }

    if (paymentToggle) {
      createDetailsPaymentToggle();
    }
  }, 100);
});
