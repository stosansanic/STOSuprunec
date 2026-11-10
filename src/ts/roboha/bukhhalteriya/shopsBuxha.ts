import { confirmAccountingPayment, withAccountingPaymentOperation } from './accountingPaymentConfirmation';
import { saveStockPayments } from './shopPaymentWrite';
import { ACCOUNTING_VISIBLE_STEP, accountingInitialRows, accountingVisibleRows, createAccountingScroll, setAccountingRows, withAccountingExportRows } from "./accountingLazyRows";
import { isCancelled, missingAccountingRpc } from "./accountingRequests";
import { accountingSearchScope, readAccountingPeriod, announceAccountingChange, accountingToday, accountingIso } from "./accountingPeriod";
import { cancelStockAccountingPages, invalidateStockAccounting, readStockAccountingPage, readStockAccountingSuggestions, stockAccountingStale, type StockAccountingFilter, type StockAccountingPage, type StockAccountingCursor } from "./stockAccountingRead";
// src/ts/roboha/bukhhalteriya/shopsBuxha.ts

import { supabase } from "../../vxid/supabaseClient";
import { formatDate, formatNumber, byId } from "./bukhhalteriya";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import {
  getSavedUserDataFromLocalStorage,
  userAccessLevel,
  canUserPayMagazine,
  canUserUnpayMagazine,
  canUserReturnMagazine,
  canUserCancelReturnMagazine,
} from "../tablucya/users";
import { checkCurrentPageAccess } from "../zakaz_naraudy/inhi/page_access_guard";
import { redirectToIndex } from "../../utils/gitUtils";

// ==== Доступ та підтвердження пароля (для масового розрахунку) ====
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

function splitDateTimeSafe(dt: string | null | undefined): {
  dateISO: string;
  timeHM: string;
} {
  const s = (dt || "").trim();
  if (!s) return { dateISO: "", timeHM: "" };

  // Витягнемо YYYY-MM-DD і HH:MM з будь-якого формату: "2025-10-05 16:06:00+00", "2025-10-05T16:06:00Z", тощо
  const m = s.match(/(\d{4}-\d{2}-\d{2}).*?(\d{2}:\d{2})/);
  if (m) {
    return { dateISO: m[1], timeHM: m[2] };
  }

  // fallback: парсимо як Date
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const dateISO = d.toISOString().slice(0, 10);
    const timeHM = d.toTimeString().slice(0, 5); // локальний HH:MM
    return { dateISO, timeHM };
  }

  // якщо зовсім дивний формат — хоч би дата
  return { dateISO: s.split(/[ T]/)[0] || "", timeHM: "" };
}

function hasFullAccess(): boolean {
  return FULL_ACCESS_ALIASES.includes(getCurrentAccessLevel());
}

// ==== DATE HELPERS (універсальні ISO з «очисткою») ====
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

function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function todayDateTime(): string {
  const now = new Date();
  const date = todayISO();
  const time = now.toTimeString().split(" ")[0].slice(0, 5); // HH:MM
  return `${date} ${time}`;
}

function createPasswordConfirmationModal(action: 'pay' | 'unpay' | 'return' | 'unreturn', isCurrent: () => boolean = () => true): Promise<boolean> {
  return confirmAccountingPayment(action === 'pay' || action === 'return' ? 'pay' : 'unpay',
    action === 'return' ? 'Повернення вибраної позиції.' : action === 'unreturn' ? 'Скасування повернення вибраної позиції.' : '', isCurrent);
}

// ==== Типи ====
interface Detail {
  sclad_id: number;
  Ціна: number;
  Каталог: number;
  Рахунок: string;
  Кількість: number;
  Найменування: string;
  Розраховано?: string;
}

interface HistoryRecord {
  Акт: number;
  Деталі: Detail[];
  Клієнт: string;
  Автомобіль: string;
  ДатаЗакриття: string | null;
  Статус?: string;
}

interface ShopData {
  Name: string;
  Склад: Record<string, any>;
  Історія: Record<string, HistoryRecord[]>;
  "Про магазин": string;
}

interface MagazineRecord {
  pkName?: string;
  pkValue?: string | number;
  rosraxovano: string | null;
  shops: string;
  rahunok: string;
  akt?: number | null;
  name: string;
  part_number: string;
  kilkist_on: number;
  price: number;
  kilkist_off: number;
  date_open?: string;
  date_close?: string;
  isPaid: boolean;
  povernennya?: string | null;
  isReturned?: boolean;
  xto_povernyv?: string | null;
  scladNomer?: number | null;
  sclad_id?: number | null;
  xto_zamovuv?: number | null;
}

const SCLAD_TABLE = "sclad";

// ==== Стан ====
let magazineData: MagazineRecord[] = [];
let allMagazineData: MagazineRecord[] = [];
let availableShops: string[] = [];
let shopsData: ShopData[] = [];

let shopsLoaded = false;
let currentFilters = {
  dateOpen: "",
  dateClose: "",
  shop: "",
  paymentStatus: 2 as 0 | 1 | 2, // 0: розраховано, 1: не розраховано, 2: всі
  availabilityStatus: 4 as 0 | 1 | 2 | 3 | 4, // 0: >0, 1: =0, 2: <0, 3: повернення, 4: всі
  scladNomer: null as number | null, // null = всі склади
  zapchastystFilter: null as number | null, // null = всі запчастисти
};

// Кеш імен Запчастистів (slyusar_id → Name)
let slyusarsNameCache: Map<number, string> = new Map();
// Функція для отримання імені Запчастиста за xto_zamovuv (slyusar_id)
function getZapchastystName(xto_zamovuv: number | null | undefined): string {
  if (!xto_zamovuv) return "-";
  return slyusarsNameCache.get(xto_zamovuv) || "-";
}

// Функція заповнення dropdown списку Запчастистів
function populateZapchastystDropdown(): void {
  const select = getEl<HTMLSelectElement>("Bukhhalter-magazine-zapchastyst");
  if (!select) return;

  // Зберігаємо поточне вибране значення
  const currentValue = select.value;

  // Очищаємо та додаємо опцію "Всі"
  select.innerHTML = '<option value="">Всі запчастисти</option>';

  const zapchastystList = (magazinePage?.facets?.requesters || []).map(row => ({id: Number(row.id), name: row.name}));
  zapchastystList.sort((a, b) => a.name.localeCompare(b.name, "uk"));

  // Додаємо опції
  for (const z of zapchastystList) {
    const option = document.createElement("option");
    option.value = String(z.id);
    option.textContent = z.name;
    select.appendChild(option);
  }

  // Відновлюємо вибране значення якщо воно є в списку
  if (currentValue) {
    if (!zapchastystList.some(item=>String(item.id)===currentValue)) select.add(new Option(slyusarsNameCache.get(Number(currentValue)) || `ID: ${currentValue}`,currentValue));
    select.value = currentValue;
  }
}

let autoSearchTimer: number | null = null;
const AUTOSEARCH_DELAY = 350;

function debounceAutoSearch(fn: () => void) {
  if (autoSearchTimer !== null) {
    clearTimeout(autoSearchTimer);
  }
  autoSearchTimer = window.setTimeout(() => {
    autoSearchTimer = null;
    fn();
  }, AUTOSEARCH_DELAY);
}

function getEl<T extends HTMLInputElement | HTMLSelectElement>(
  id: string,
): T | null {
  return document.getElementById(id) as T | null;
}

// ==== Завантаження даних магазинів з JSONB ====
async function fetchShopData(): Promise<ShopData[]> {
  try {
    const { data, error } = await supabase.from("shops").select("*");

    if (error) {
      // console.error("Помилка Supabase:", error);
      throw new Error(`Помилка завантаження: ${error.message}`);
    }

    if (data && Array.isArray(data)) {
      return data
        .map((item, _index) => {
          try {
            let parsedData;
            if (typeof item.data === "string") {
              parsedData = JSON.parse(item.data);
            } else if (typeof item.data === "object" && item.data !== null) {
              parsedData = item.data;
            } else {
              // console.warn(
              // `Пропущений запис ${index}: невірний формат data`,
              // item,
              // );
              return null;
            }

            if (!parsedData || !parsedData.Name) {
              // console.warn(
              // `Пропущений запис ${index}: немає поля Name`,
              // parsedData,
              // );
              return null;
            }

            return parsedData;
          } catch (parseError) {
            // console.error(
            // `Помилка парсингу запису ${index}:`,
            // parseError,
            // item,
            // );
            return null;
          }
        })
        .filter((item): item is ShopData => item !== null);
    } else {
      throw new Error("Невірний формат даних з Supabase");
    }
  } catch (error) {
    // console.error("Помилка завантаження даних магазинів:", error);
    showNotification("Помилка завантаження даних магазинів", "error", 5000);
    return [];
  }
}

export async function deprecated_openActModal(actNumber: number): Promise<void> {
  if (!shopsData.length) shopsData = await fetchShopData();
  let foundRec: HistoryRecord | null = null;
  let foundShop: ShopData | null = null;
  let foundDate: string | null = null;

  for (const shop of shopsData) {
    for (const date of Object.keys(shop.Історія || {})) {
      for (const rec of shop.Історія[date]) {
        if (rec.Акт === actNumber) {
          foundRec = rec;
          foundShop = shop;
          foundDate = date;
          break;
        }
      }
      if (foundRec) break;
    }
    if (foundRec) break;
  }

  if (!foundRec) {
    showNotification("Акт не знайдено", "error");
    return;
  }

  const modal = document.createElement("div");
  modal.style.cssText = `position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.5); z-index:10000;`;

  const box = document.createElement("div");
  box.style.cssText = `background:#fff; width:90vw; max-width:800px; max-height:90vh; border-radius:12px; padding:24px; overflow-y:auto; box-shadow:0 8px 32px rgba(0,0,0,.15);`;

  const title = document.createElement("h2");
  title.textContent = `Акт №${actNumber}`;
  title.style.cssText = "margin:0 0 16px; color:#333;";

  const info = document.createElement("div");
  info.innerHTML = `
  <p><strong>Магазин:</strong> ${foundShop?.Name || "-"}</p>
  <p><strong>Дата відкриття:</strong> ${formatDate(foundDate || "")}</p>
  <p><strong>Клієнт:</strong> ${foundRec.Клієнт || "-"}</p>
  <p><strong>Автомобіль:</strong> ${foundRec.Автомобіль || "-"}</p>
  <p><strong>Статус:</strong> ${foundRec.Статус || "-"}</p>
  <p><strong>Дата закриття:</strong> ${formatDate(
    foundRec.ДатаЗакриття || "",
  )}</p>
`;

  info.style.cssText =
    "margin-bottom:24px; padding:16px; background:#f8f9fa; border-radius:8px;";

  const detailsTitle = document.createElement("h3");
  detailsTitle.textContent = "Деталі:";
  detailsTitle.style.cssText = "margin:16px 0 8px; color:#333;";

  const detailsTable = document.createElement("table");
  detailsTable.style.cssText = "width:100%; border-collapse:collapse;";

  const thead = detailsTable.createTHead();
  const trh = thead.insertRow();
  ["Найменування", "Каталог", "Рахунок", "Кількість", "Ціна", "Сума"].forEach(
    (text) => {
      const th = document.createElement("th");
      th.textContent = text;
      th.style.cssText =
        "padding:8px; border:1px solid #ddd; background:#e9ecef; text-align:left;";
      trh.appendChild(th);
    },
  );

  const tbody = detailsTable.createTBody();
  foundRec.Деталі?.forEach((det) => {
    const tr = tbody.insertRow();
    ["Найменування", "Каталог", "Рахунок", "Кількість", "Ціна"].forEach(
      (key) => {
        const td = tr.insertCell();
        let val = det[key as keyof Detail];
        if (key === "Ціна") val = formatNumber(Number(val));
        if (key === "Каталог") val = Number(val).toString();
        if (key === "Кількість") val = Number(val);
        td.textContent = String(val || "-");
        td.style.cssText = "padding:8px; border:1px solid #ddd;";
      },
    );
    const sumTd = tr.insertCell();
    sumTd.textContent = formatNumber(Number(det.Ціна) * Number(det.Кількість));
    sumTd.style.cssText =
      "padding:8px; border:1px solid #ddd; font-weight:bold;";
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Закрити";
  closeBtn.style.cssText =
    "margin-top:16px; padding:12px 24px; background:#6c757d; color:#fff; border:none; border-radius:8px; cursor:pointer;";
  closeBtn.onclick = () => modal.remove();

  box.append(title, info, detailsTitle, detailsTable, closeBtn);
  modal.appendChild(box);
  document.body.appendChild(modal);
}

// Resolve the catalogue for the selected name, not from one loaded page.
async function syncCatalogFromName(selectedName: string): Promise<void> {
  const input=getEl<HTMLInputElement>('Bukhhalter-magazine-catalog');
  if (!input || !selectedName.trim()) return;
  const filter=currentMagazineFilter(), scope=accountingSearchScope('stock');
  if (!filter.from) { triggerAutoFilter(); return; }
  try {
    const result=await readStockAccountingSuggestions(filter,'catalog','',selectedName.trim());
    if (!magazineFilterCurrent(filter,scope) || getElValue('Bukhhalter-magazine-item')!==selectedName) return;
    input.value=result.items.length===1 && !result.has_more ? result.items[0] : '';
    const dropdown=smartDropdowns.find(item=>item.config.inputId==='Bukhhalter-magazine-catalog');
    dropdown?.setExactItem(selectedName,result.items);
    if (result.items.length>1) dropdown?.show();
    triggerAutoFilter();
  } catch(error) {
    if (magazineFilterCurrent(filter,scope) && !isCancelled(error)) showNotification((error as any)?.message || 'Не вдалося отримати каталоги','error');
  }
}

// ==== Централізована функція для запуску автофільтрації ====
function triggerAutoFilter(): void {
  debounceAutoSearch(() => { void autoSearchFromInputs(); });
}

// ==== Завантаження списку магазинів ====
async function readAvailableShopRows(): Promise<Array<{ shops: string }>> {
  const rows: Array<{ shops: string }> = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.rpc("traffic_stock_shop_names", { p_offset: offset });
    if (error) throw missingAccountingRpc('traffic_stock_shop_names', error);
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") throw new Error("Invalid supplier page");
    rows.push(...data.items);
    if (!data.has_more) return rows;
    if (data.items.length !== 500) throw new Error("Incomplete supplier page");
  }

}

let availableShopScope = "";
let availableShopLoad: {scope: string; promise: Promise<void>} | null = null;
async function loadAvailableShops(): Promise<void> {
  const scope = accountingSearchScope('stock');
  if (shopsLoaded && availableShopScope === scope) return;
  if (availableShopLoad?.scope === scope) return availableShopLoad.promise;
  const promise = (async () => {
    try {
      const data = await readAvailableShopRows();
      if (scope !== accountingSearchScope('stock')) return;
      availableShops = [...new Set(data.map(row => row.shops).filter(Boolean))].sort();
      shopsLoaded = true; availableShopScope = scope;
      populateShopsSelectOptions();
    } catch (error) {
      if (scope === accountingSearchScope('stock') && !isCancelled(error)) {
        showNotification(error instanceof Error ? error.message : 'Помилка завантаження списку магазинів', 'error', 5000);
      }
    }
  })();
  availableShopLoad = {scope, promise};
  try { await promise; } finally { if (availableShopLoad?.promise === promise) availableShopLoad = null; }
}

// ==== Покращені випадаючі списки з пошуком ====
interface DropdownConfig {
  inputId: string;
  listId: string;
  placeholder: string;
  icon: string;
  maxItems: number;
}

const dropdownConfigs: DropdownConfig[] = [
  {
    inputId: "Bukhhalter-magazine-bill",
    listId: "dl-mag-bill",
    placeholder: "Введіть або оберіть рахунок...",
    icon: "",
    maxItems: 100,
  },
  {
    inputId: "Bukhhalter-magazine-item",
    listId: "dl-mag-item",
    placeholder: "Введіть або оберіть найменування...",
    icon: "",
    maxItems: 150,
  },
  {
    inputId: "Bukhhalter-magazine-catalog",
    listId: "dl-mag-catalog",
    placeholder: "Введіть або оберіть Каталог номер...",
    icon: "",
    maxItems: 100,
  },
];

class SmartDropdown {
  private input: HTMLInputElement;
  private dropdown: HTMLDivElement;
  public readonly config: DropdownConfig;
  private items: string[] = [];
  private filteredItems: string[] = [];
  private selectedIndex = -1;
  private isOpen = false;
  private userHasTyped = false;
  private hintGeneration=0;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private hintLoading=false;
  private hintMore=false;
  private hintAfter: string | null=null;
  private hintExact: string | null=null;
  private hintKey='';

  constructor(config: DropdownConfig) {
    this.config = config;
    const inputEl = getEl<HTMLInputElement>(config.inputId);
    if (!inputEl) {
      throw new Error(`Input element with id ${config.inputId} not found`);
    }
    this.input = inputEl;
    this.dropdown = document.createElement("div");

    this.createDropdown();
    this.bindEvents();
    this.dropdown.addEventListener('scroll',()=>{
      if (this.dropdown.scrollTop+this.dropdown.clientHeight>=this.dropdown.scrollHeight-50) void this.loadSuggestions(true);
    });
  }

  private createDropdown() {
    if (!this.input.parentElement?.classList.contains("dropdown-wrapper")) {
      const wrapper = document.createElement("div");
      wrapper.className = "dropdown-wrapper";
      wrapper.style.cssText =
        "position: relative; display: inline-block; width: 100%;";

      const icon = document.createElement("span");
      icon.textContent = this.config.icon;
      icon.className = "dropdown-icon";
      icon.style.cssText = `
        position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
        font-size: 16px; pointer-events: none; z-index: 2;
      `;

      this.input.placeholder = this.config.placeholder;

      this.input.parentNode?.insertBefore(wrapper, this.input);
      wrapper.appendChild(this.input);
      wrapper.appendChild(icon);
    }

    this.dropdown.className = "smart-dropdown";
    this.dropdown.style.cssText = `
      position: absolute; top: 100%; left: 0; right: 0; z-index: 1000;
      background: white; border: 2px solid #e0e0e0; border-top: none;
      border-radius: 0 0 12px 12px; max-height: 240px; overflow-y: auto; overflow-x: hidden;
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
      if (this.input.value && !this.userHasTyped) {
        this.filter("");
      } else {
        this.filter(this.input.value);
      }
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
      this.userHasTyped = true;
      if (this.config.inputId === "Bukhhalter-magazine-catalog") {
        const sanitized = sanitizeCatalogInputValue(this.input.value);
        if (this.input.value !== sanitized) {
          this.input.value = sanitized;
        }
      }

      this.filter(this.input.value);
      if (!this.isOpen) this.show();
      this.scheduleSuggestions();
      triggerAutoFilter();
    });

    document.addEventListener("click", (e) => {
      if (!this.input.parentElement?.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  public updateItems(items: string[]) {
    this.items = [...new Set([...this.items,...items])].sort();
    this.filter(this.input.value);
  }
  public resetItems(): void {
    this.hintGeneration++; clearTimeout(this.hintTimer); this.hintLoading=false;
    this.hintKey=''; this.hintMore=false; this.hintAfter=null; this.hintExact=null;
    this.items=[]; this.filter(this.input.value);
    if (this.isOpen) this.scheduleSuggestions();
  }

  private filter(query: string) {
    const q = query.toLowerCase().trim();
    const normalizedQuery = normalizeCatalogSearch(query);
    const isCatalogDropdown =
      this.config.inputId === "Bukhhalter-magazine-catalog";
    this.filteredItems = q
      ? this.items
          .filter((item) =>
            isCatalogDropdown
              ? item.toLowerCase().includes(q) ||
                normalizeCatalogSearch(item).includes(normalizedQuery)
              : item.toLowerCase().includes(q),
          )
          .slice(0, Math.max(this.config.maxItems,this.items.length))
      : this.items.slice(0, Math.max(this.config.maxItems,this.items.length));

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

    // Динамічне розширення ширини під найдовший елемент
    this.adjustDropdownWidth();
  }

  private adjustDropdownWidth() {
    // Встановлюємо ширину рівну ширині input (без розширення)
    const inputWidth = this.input.offsetWidth;
    this.dropdown.style.width = `${inputWidth}px`;
    this.dropdown.style.maxWidth = `${inputWidth}px`;
  }

  private highlightMatch(text: string, query: string): string {
    if (!query.trim()) return text;
    const regex = new RegExp(
      `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
    return text.replace(regex, "<mark>$1</mark>");
  }

  public setExactItem(name: string, items: string[]): void {
    this.hintGeneration++; clearTimeout(this.hintTimer); this.hintLoading=false;
    this.hintAfter=null; this.hintMore=false;
    this.hintExact=name; this.hintKey=''; this.items=items; this.filter(this.input.value);
  }
  private scheduleSuggestions(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer=setTimeout(()=>void this.loadSuggestions(false),300);
  }
  private async loadSuggestions(append: boolean): Promise<void> {
    const filter=currentMagazineFilter(), scope=accountingSearchScope('stock');
    if (!filter.from || !this.isOpen || append && (this.hintLoading || !this.hintMore)) return;
    const field=this.config.inputId==='Bukhhalter-magazine-bill' ? 'bill' : this.config.inputId==='Bukhhalter-magazine-item' ? 'item' : 'catalog';
    if (this.hintExact && getElValue('Bukhhalter-magazine-item')!==this.hintExact) this.hintExact=null;
    const query=this.input.value.trim(), exact=this.hintExact;
    const key=JSON.stringify([scope,filter.from,filter.to,filter.dateMode,filter.shop,field,query,exact]);
    if (!append && this.hintKey===key) return;
    const generation=++this.hintGeneration;
    if (!append) { this.hintKey=key; this.hintAfter=null; this.hintMore=false; }
    this.hintLoading=true;
    try {
      const result=await readStockAccountingSuggestions(filter,field,query,exact,append ? this.hintAfter : null);
      if (generation!==this.hintGeneration || !this.isOpen || !magazineFilterCurrent(filter,scope) || query!==this.input.value.trim()) return;
      this.items=append ? [...new Set([...this.items,...result.items])] : result.items;
      this.hintMore=result.has_more; this.hintAfter=result.items[result.items.length-1] || this.hintAfter;
      this.filter(this.input.value);
    } catch(error) {
      if (generation===this.hintGeneration) this.hintKey='';
      if (generation===this.hintGeneration && this.isOpen && magazineFilterCurrent(filter,scope) && !isCancelled(error)) showNotification((error as any)?.message || 'Не вдалося отримати підказки','error');
    } finally { if (generation===this.hintGeneration) this.hintLoading=false; }
  }
  public show() {
    this.isOpen = true;
    this.scheduleSuggestions();
    this.dropdown.style.display = "block";
    this.input.style.borderRadius = "8px 8px 0 0";
    this.input.style.borderColor = "#007bff";
  }

  private hide() {
    this.isOpen = false;
    clearTimeout(this.hintTimer); this.hintGeneration++; this.hintLoading=false;
    this.hintKey='';
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
      this.userHasTyped = false;
      this.hide();

      if (this.config.inputId === "Bukhhalter-magazine-item") {
        void syncCatalogFromName(selectedValue);
      } else {
        triggerAutoFilter();
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

// Стилі для випадаючих списків
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

    .dropdown-icon {
      position: absolute !important;
      left: 12px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
      font-size: 16px !important;
      pointer-events: none !important;
      z-index: 2 !important;
      color: #666 !important;
    }

    .smart-dropdown {
      border: 2px solid #007bff !important;
      border-top: none !important;
      border-radius: 0 0 12px 12px !important;
      background: rgba(255,255,255,0.98) !important;
      backdrop-filter: blur(8px) !important;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15) !important;
      overflow-x: hidden !important;
      max-width: 100% !important;
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
      overflow: hidden !important;
      text-overflow: ellipsis !important;
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

let smartDropdowns: SmartDropdown[] = [];

function ensureSmartDropdowns(): void {
  addDropdownStyles();

  if (smartDropdowns.length === 0) {
    smartDropdowns = dropdownConfigs
      .filter((config) => getEl(config.inputId))
      .map((config) => {
        try {
          return new SmartDropdown(config);
        } catch (error) {
          // console.warn(
          // `Failed to create dropdown for ${config.inputId}:`,
          // error,
          // );
          return null;
        }
      })
      .filter((dropdown): dropdown is SmartDropdown => dropdown !== null);
  }
}

function refreshDropdownOptions(): void {
  const shopEl = getEl<HTMLInputElement | HTMLSelectElement>(
    "Bukhhalter-magazine-shop",
  );
  const shopVal = (shopEl?.value || "").trim();

  let source = allMagazineData;
  if (shopVal) {
    source = source.filter(
      (r) => (r.shops || "").trim().toLowerCase() === shopVal.toLowerCase(),
    );
  }

  const bills = new Set<string>();
  const items = new Set<string>();
  const catalogs = new Set<string>();

  source.forEach((r) => {
    if (r.rahunok?.trim()) bills.add(r.rahunok.trim());
    if (r.name?.trim()) items.add(r.name.trim());
    if (r.part_number?.trim()) catalogs.add(r.part_number.trim());
  });

  smartDropdowns.forEach((dropdown) => {
    if (dropdown.config.inputId === "Bukhhalter-magazine-bill") {
      dropdown.updateItems(Array.from(bills));
    } else if (dropdown.config.inputId === "Bukhhalter-magazine-item") {
      dropdown.updateItems(Array.from(items));
    } else if (dropdown.config.inputId === "Bukhhalter-magazine-catalog") {
      dropdown.updateItems(Array.from(catalogs));
    }
  });
}

// A partial page is never a complete report; all filters run on the server.
function autoFilterFromInputs(): void { void autoSearchFromInputs(); }

// Глобальна змінна для зберігання поточного фільтра дат
let magazineDateFilterMode: "open" | "paid" = "open";

// Функція для ініціалізації перемикача фільтрації дат для магазину
function initMagazineDateFilterToggle(): void {
  const toggleContainer = document.querySelector(
    "#Bukhhalter-magazine-section .Bukhhalter-date-filter-toggle",
  );
  if (!toggleContainer) return;

  const buttons =
    toggleContainer.querySelectorAll<HTMLButtonElement>(".date-filter-btn");

  buttons.forEach((btn) => {
    btn.addEventListener("click", function () {
      // Знімаємо active з усіх кнопок
      buttons.forEach((b) => b.classList.remove("active"));
      // Додаємо active до натиснутої
      this.classList.add("active");

      // Зберігаємо режим фільтрації (тільки 'open' і 'paid' для магазину)
      const filterMode = this.dataset.filter;
      if (filterMode === "open" || filterMode === "paid") {
        magazineDateFilterMode = filterMode as "open" | "paid";
      } else {
        magazineDateFilterMode = "open"; // fallback
      }

      // ⤵️ ДОДАЙ ОЦЕ: коли режим 'paid' — показуємо тільки оплачені
      const payToggle = getEl<HTMLInputElement>(
        "magazine-payment-filter-toggle",
      );
      if (magazineDateFilterMode === "paid") {
        currentFilters.paymentStatus = 0; // 0 = Розраховано
        if (payToggle) payToggle.value = "0";
      } else {
        currentFilters.paymentStatus = 2; // 2 = Всі
        if (payToggle) payToggle.value = "2";
      }

      // Перезапускаємо фільтрацію
      triggerAutoFilter();

      // Перезапускаємо фільтрацію
      triggerAutoFilter();
    });
  });
}

function getElValue<T extends HTMLInputElement | HTMLSelectElement>(
  id: string,
): string {
  const el = document.getElementById(id) as T | null;
  return (el && "value" in el ? (el.value || "").trim() : "").trim();
}


function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function detectPK(row: any): { name: string; value: any } | null {
  const candidates = ["id", "sclad_id", "uid", "pk", "_id", "ID"];
  for (const k of candidates) {
    if (row && row[k] !== undefined && row[k] !== null) {
      return { name: k, value: row[k] };
    }
  }
  const js = typeof row?.data === "string" ? safeParse(row.data) : row?.data;
  if (js && typeof js === "object") {
    for (const k of candidates) {
      if (js[k] !== undefined && js[k] !== null) {
        return { name: k, value: js[k] };
      }
    }
  }
  return null;
}

function mapRowToMagazineRecord(row: any): MagazineRecord {
  const pk = detectPK(row);
  const aktVal =
    typeof row?.akt === "number"
      ? row.akt
      : row?.akt != null
        ? Number(row.akt) || null
        : null;

  return {
    pkName: pk?.name,
    pkValue: pk?.value,
    rosraxovano: row?.rosraxovano ?? null,
    shops: String(row?.shops ?? ""),
    rahunok: String(row?.rahunok ?? ""),
    akt: aktVal,
    name: String(row?.name ?? ""),
    part_number: String(row?.part_number ?? ""),
    kilkist_on: Number(row?.kilkist_on ?? 0) || 0,
    price: Number(row?.price ?? 0) || 0,
    kilkist_off: Number(row?.kilkist_off ?? 0) || 0,
    date_open: row?.time_on ?? "",
    date_close: row?.date_close ?? "",
    isPaid: !!row?.rosraxovano,
    povernennya: row?.povernennya ?? null,
    isReturned: !!row?.povernennya,
    xto_povernyv: row?.xto_povernyv ?? null,
    scladNomer: row?.scladNomer ?? null,
    sclad_id: row?.sclad_id ?? null,
    xto_zamovuv: row?.xto_zamovuv ?? null,
  };
}

// ==== Server-paged accounting report ====
let magazinePage: StockAccountingPage | null = null;
let magazineAppliedFilter: StockAccountingFilter | null = null;
let magazineAppliedScope = '';
let magazineVisibleCount = 0;
let magazineLoadGeneration = 0;
let magazineLoading = false;
let magazineBusy = false;
let magazinePending: {key: string; promise: Promise<void>} | null = null;
const hiddenMagazineIds = new Set<number>();
const magazineScroll = createAccountingScroll('magazine-tbody', showMoreMagazineRows);
function currentMagazineFilter(): StockAccountingFilter {
  return {
    from: accountingIso(getElValue('Bukhhalter-magazine-date-open')),
    to: accountingIso(getElValue('Bukhhalter-magazine-date-close')) || accountingToday(),
    dateMode: magazineDateFilterMode,
    shop: getElValue('Bukhhalter-magazine-shop'), bill: getElValue('Bukhhalter-magazine-bill'),
    item: getElValue('Bukhhalter-magazine-item'), catalog: getElValue('Bukhhalter-magazine-catalog'),
    payment: currentFilters.paymentStatus, availability: currentFilters.availabilityStatus,
    warehouse: currentFilters.scladNomer, requester: currentFilters.zapchastystFilter,
    exclude: [...hiddenMagazineIds].sort((a,b) => a-b),
  };
}
function magazineFilterCurrent(filter: StockAccountingFilter, scope: string): boolean {
  return scope === accountingSearchScope('stock') && JSON.stringify(filter) === JSON.stringify(currentMagazineFilter());
}
function updateMagazineScroll(): void {
  magazineScroll.update({more: !!magazinePage && (magazinePage.has_more || magazineVisibleCount < magazineData.length),
    busy: magazineLoading || magazineBusy, shown: Math.min(magazineVisibleCount,magazineData.length), total: magazinePage?.summary?.totalCount});
}
async function showMoreMagazineRows(): Promise<void> {
  if (magazineLoading || magazineBusy || !magazinePage || !magazineAppliedFilter) return;
  if (!magazineFilterCurrent(magazineAppliedFilter,magazineAppliedScope)) { await autoSearchFromInputs(); return; }
  if (magazineVisibleCount < magazineData.length) {
    magazineVisibleCount = Math.min(magazineData.length,magazineVisibleCount+ACCOUNTING_VISIBLE_STEP);
    updateMagazineTable(); updateMagazineScroll(); return;
  }
  await loadMagazinePage(true);
}
async function autoSearchFromInputs(): Promise<void> {
  if (magazineBusy) return;
  if (!readAccountingPeriod('magazine')) {
    magazineLoadGeneration++; invalidateStockAccounting(); magazinePending=null; magazineLoading=false;
    magazinePage=null; magazineAppliedFilter=null; magazineAppliedScope=''; magazineVisibleCount=0;
    magazineData=[]; allMagazineData=[];  slyusarsNameCache.clear(); magazineScroll.reset();
    updateMagazineTable(); updateMagazineTotalSum(); return;
  }
  const filter = currentMagazineFilter(), scope = accountingSearchScope('stock');
  if (magazinePage && magazineAppliedScope === scope && JSON.stringify(magazineAppliedFilter) === JSON.stringify(filter)) return;
  const key = JSON.stringify([scope,filter]);
  if (magazinePending?.key === key) return magazinePending.promise;
  const promise = loadMagazinePage(false);
  magazinePending={key,promise};
  try { await promise; } finally { if (magazinePending?.promise === promise) magazinePending=null; }
}
async function loadMagazinePage(append: boolean, retryStale = true): Promise<void> {
  if (magazineBusy || append && magazineLoading) return;
  const filter=currentMagazineFilter(), scope=accountingSearchScope('stock'), generation=++magazineLoadGeneration;
  const previous=append ? magazinePage : null;
  if (append && (!previous || !magazineFilterCurrent(magazineAppliedFilter!,magazineAppliedScope))) return;
  if (!append) {
    cancelStockAccountingPages(); magazineScroll.reset(); magazinePage=null; magazineData=[]; allMagazineData=[];
    slyusarsNameCache.clear(); smartDropdowns.forEach(dropdown=>dropdown.resetItems());
    updateMagazineTable(); updateMagazineTotalSum();
  }
  magazineLoading=true; updateMagazineScroll();
  try {
    const page=await readStockAccountingPage(filter,previous?.next_cursor || null,previous?.revision || null,40);
    if (generation!==magazineLoadGeneration || !magazineFilterCurrent(filter,scope)) return;
    const items=previous ? [...previous.items,...page.items] : page.items;
    if (new Set(items.map(row=>Number(row.sclad_id))).size!==items.length) throw new Error('Повторний рядок у звіті складу');
    magazinePage=previous ? {...previous,items,next_cursor:page.next_cursor,has_more:page.has_more} : page;
    magazineAppliedFilter=filter; magazineAppliedScope=scope;
    for (const row of page.items) if (row.xto_zamovuv && row.requester_name) slyusarsNameCache.set(Number(row.xto_zamovuv),row.requester_name);
    magazineData=items.map(mapRowToMagazineRecord); allMagazineData=magazineData;
    magazineVisibleCount=Math.min(magazineData.length,append ? magazineVisibleCount+ACCOUNTING_VISIBLE_STEP : accountingInitialRows('magazine-tbody'));

    populateShopsSelectOptions(); ensureSmartDropdowns(); refreshDropdownOptions(); populateZapchastystDropdown(); generateScladFilterButtons();
    updateMagazineTable(); updateMagazineTotalSum();
  } catch(error) {
    if (generation!==magazineLoadGeneration || !magazineFilterCurrent(filter,scope) || isCancelled(error)) return;
    if (stockAccountingStale(error) && retryStale) {
      invalidateStockAccounting(); magazineLoading=false;
      await loadMagazinePage(false,false); return;
    }
    showNotification(stockAccountingStale(error) ? 'Дані складу змінилися. Повторіть пошук.' : (error as any)?.message || 'Не вдалося завантажити склад','error');
    if (append) throw error;
  } finally { if (generation===magazineLoadGeneration) { magazineLoading=false; updateMagazineScroll(); } }
}
function resetMagazineReport(): void {
  magazineLoadGeneration++; invalidateStockAccounting(); magazinePending=null;
  magazinePage=null; magazineAppliedFilter=null; magazineAppliedScope=''; magazineVisibleCount=0; magazineLoading=false;
  hiddenMagazineIds.clear(); slyusarsNameCache.clear(); magazineScroll.reset();
  smartDropdowns.forEach(dropdown=>dropdown.resetItems());
}

// ==== Публічні API ====
export async function initializeMagazineData(): Promise<void> {
  resetMagazineReport();
  magazineData = [];
  allMagazineData = [];
  availableShops = [];
  shopsData = [];

  shopsLoaded = false;
  updateMagazineTable();
  updateMagazineTotalSum();
  initMagazineAutoBehaviors();
}

export async function searchMagazineData(): Promise<void> {
  if (!readAccountingPeriod("magazine")) return;
  if (!await checkCurrentPageAccess()) { redirectToIndex(); return; }
  await autoSearchFromInputs();
}

export function getMagazineData(): MagazineRecord[] {
  return magazineData;
}

export function calculateMagazineTotalSum(): number { return magazinePage?.summary?.totalAmount || 0; }
export function calculateMagazineRemainingSum(): number { return magazinePage?.summary?.remainingAmount || 0; }

export function updateMagazineTotalSum(): void {
  if (!byId('Bukhhalter-magazine-section')?.classList.contains('Bukhhalter-active')) return;
  const totalSumElement = byId<HTMLElement>("total-sum");

  if (!totalSumElement) return;

  const totalSum = calculateMagazineTotalSum();
  const remainingSum = calculateMagazineRemainingSum();

  totalSumElement.innerHTML = `
  <div style="display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 15px; font-size: 1.1em;">
    <span style="color: #ffffff;">Загальна сума: <strong style="color: #333;">💰 ${formatNumber(
      totalSum,
    )}</strong> грн</span>
    <span style="color: #666;">|</span>
    <span style="color: #ffffff;">На складі: <strong style="color: #8B0000;">💶 ${formatNumber(
      remainingSum,
    )}</strong> грн</span>
  </div>
`;
}

export function getMagazineExportData(): any[] {
  return magazineData.map((item) => {
    const { dateISO, timeHM } = splitDateTimeSafe(item.povernennya || "");

    return {
      rosraxovano:
        item.isPaid && item.rosraxovano
          ? formatDate(item.rosraxovano)
          : item.isPaid
            ? "Розраховано"
            : "Не розраховано",
      date_open: formatDate(item.date_open || ""),
      shops: item.shops,
      rahunok: item.rahunok,
      akt: item.akt || "-",
      name: item.name,
      part_number: item.part_number,
      kilkist_on: item.kilkist_on,
      price: item.price,
      total: item.kilkist_on * item.price,
      remainder: item.kilkist_on - item.kilkist_off,
      scladNomer: item.scladNomer ?? "-",
      povernennya: item.povernennya
        ? `${formatDate(dateISO)} ${timeHM}`
        : "Не повернено",
    };
  });
}



export function updateMagazineTable(): void {
  const tbody = byId<HTMLTableSectionElement>("magazine-tbody");
  if (!tbody) return;

  const visibleRows = accountingVisibleRows(magazineData,magazineVisibleCount);

  if (magazineData.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="15" class="Bukhhalter-no-data">Немає даних для відображення</td></tr>';
    return;
  }

  setAccountingRows(tbody, visibleRows
    .map((item, index) => {
      const total = item.kilkist_on * item.price;
      const remainder = item.kilkist_on - item.kilkist_off;

      let rowClass = item.isPaid ? "paid-row" : "unpaid-row";
      if (remainder > 0) {
        rowClass += " available-row stock-available-row";
      } else if (remainder === 0) {
        rowClass += " zero-stock-row";
      } else {
        rowClass += " unavailable-row stock-unavailable-row";
      }
      if (item.isReturned) {
        rowClass += " returned-row";
      }

      const paymentIcon = item.isPaid ? "💰" : "💲";
      const paymentText =
        item.isPaid && item.rosraxovano
          ? formatDate(item.rosraxovano)
          : item.isPaid
            ? "Розраховано"
            : "Не розраховано";

      let stockClass = "";
      if (remainder > 0) {
        stockClass = "available-stock";
      } else if (remainder === 0) {
        stockClass = "zero-stock";
      } else {
        stockClass = "unavailable-stock";
      }

      const returnTitle = item.isReturned
        ? "Скасувати повернення"
        : "Повернути постачальнику";
      const returnBtn = `<button class="Bukhhalter-return-btn" onclick="event.stopPropagation(); toggleReturn(${index})" title="${returnTitle}">↩️</button>`;

      let returnDateHtml = "";
      if (item.isReturned && item.povernennya != null) {
        const { dateISO, timeHM } = splitDateTimeSafe(item.povernennya);
        const userName = item.xto_povernyv || "Невідомий";
        returnDateHtml = `
    <div class="return-date">
      <div>${formatDate(dateISO)}</div>
      <div>${timeHM || "—"}</div>
      <div class="return-user">${userName}</div>
    </div>
  `;
      }

      const paymentDisabled = item.isReturned ? 'disabled="disabled"' : "";
      const paymentOnclick = item.isReturned
        ? ""
        : `onclick="event.stopPropagation(); toggleMagazinePayment(${index})"`;

      const actBtn = item.akt
        ? `<button class="Bukhhalter-act-btn" onclick="event.stopPropagation(); openActModalWithClient(${item.akt})" title="Відкрити акт №${item.akt}">📋 ${item.akt}</button>`
        : "<span>Склад</span>";

      return `
        <tr onclick="handleRowClick(${index})" class="${rowClass}">
          <td>
            <button class="Bukhhalter-payment-btn ${
              item.isPaid ? "paid" : "unpaid"
            }" ${paymentDisabled} ${paymentOnclick}
              title="${item.isPaid ? "Розраховано" : "Не розраховано"}">
              ${paymentIcon} ${paymentText}
            </button>
          </td>
          <td>${formatDate(item.date_open || "")}</td>
          <td>${item.shops || "-"}</td>
          <td>${item.rahunok || "-"}</td>
          <td>${actBtn}</td>
          <td>${item.name || "-"}</td>
          <td>${item.part_number || "-"}</td>
          <td>${item.kilkist_on || 0}</td>
          <td>${item.price ? formatNumber(item.price) : "-"}</td>
          <td>${total ? formatNumber(total) : "-"}</td>
          <td class="${stockClass}">${remainder}</td>
          <td class="zapchastyst-cell">${getZapchastystName(item.xto_zamovuv)}</td>
          <td class="sklad-cell">${item.scladNomer != null ? item.scladNomer : "-"}</td>
          <td class="return-cell">
            <div class="return-button-wrapper">
              ${returnBtn}
              ${returnDateHtml}
            </div>
          </td>
          <td><button class="Bukhhalter-delete-btn" onclick="event.stopPropagation(); deleteMagazineRecord(${index})">🗑️</button></td>
        </tr>
      `;
    })
    .join(""));
}

function magazinePaymentSnapshotCurrent(rows: Record<string, any>[], scope: string, generation: number, filter: StockAccountingFilter): boolean {
  return generation === magazineLoadGeneration && magazineFilterCurrent(filter, scope) &&
    rows.every(saved => JSON.stringify(magazinePage?.items.find(row => Number(row.sclad_id) === Number(saved.sclad_id))) === JSON.stringify(saved));
}
async function refreshMagazinePaymentPage(filter: StockAccountingFilter, scope: string): Promise<void> {
  if (!magazineFilterCurrent(filter, scope)) return;
  const generation = ++magazineLoadGeneration, limit = Math.max(1, Math.min(200, magazinePage?.items.length || 40));
  magazineLoading = true; updateMagazineScroll();
  try {
    const page = await readStockAccountingPage(filter, null, null, limit);
    if (generation !== magazineLoadGeneration || !magazineFilterCurrent(filter, scope)) return;
    magazinePage = page; magazineAppliedFilter = filter; magazineAppliedScope = scope;
    magazineData = page.items.map(mapRowToMagazineRecord); allMagazineData = magazineData;
    magazineVisibleCount = Math.min(magazineVisibleCount || accountingInitialRows('magazine-tbody'), magazineData.length);
    updateMagazineTable(); updateMagazineTotalSum();
  } catch (error) {
    magazineAppliedScope = ''; magazineScroll.pause();
    showNotification('Оплату збережено. Не вдалося оновити підсумки; повторіть пошук.', 'warning');
  } finally { if (generation === magazineLoadGeneration) { magazineLoading = false; updateMagazineScroll(); } }
}
async function performMagazinePayment(ids: number[], action: 'pay' | 'unpay', bulk = false): Promise<void> {
  if (magazineBusy || magazineLoading || !magazinePage || !magazineAppliedFilter) return;
  const filter = structuredClone(magazineAppliedFilter), scope = magazineAppliedScope, generation = magazineLoadGeneration;
  const rows = structuredClone(magazinePage.items.filter(row => ids.includes(Number(row.sclad_id))));
  if (!rows.length) { showNotification('За поточними фільтрами немає неоплачених товарів.', 'info'); return; }
  if (rows.some(row => !/^[a-f0-9]{64}$/.test(row.paymentFingerprint || ''))) { showNotification('Оновіть SQL бухгалтерії та повторіть пошук.', 'warning'); return; }
  if (rows.length !== ids.length || rows.length > 2000 || rows.some(row => row.povernennya)) { showNotification('Звузьте звіт до 2000 неповернених позицій.', 'warning'); return; }
  const current = () => magazinePaymentSnapshotCurrent(rows, scope, generation, filter);
  if (!current() || !readAccountingPeriod('magazine')) return;
  magazineBusy = true; updateMagazineScroll();
  let committed = false;
  try {
    const allowed = bulk ? hasFullAccess() : await (action === 'pay' ? canUserPayMagazine() : canUserUnpayMagazine());
    if (!allowed || !current()) { showNotification('Недостатньо прав або звіт змінився.', 'warning'); return; }
    const total = rows.reduce((sum, row) => sum + (Number(row.kilkist_on) || 0) * (Number(row.price) || 0), 0);
    if (!await confirmAccountingPayment(action, `${bulk ? 'Усі неоплачені позиції за поточними фільтрами' : 'Обрана позиція'}: ${rows.length}; сума: ${formatNumber(total)} грн.`, current)) return;
    if (!current()) throw new Error('Звіт або користувач змінився. Повторіть операцію.');
    const receipts = await saveStockPayments(rows, action === 'pay' ? accountingToday() : null);
    committed = true;
    if (!current()) {
      magazineAppliedScope = ''; invalidateStockAccounting(); magazineScroll.pause();
      showNotification('Розрахунок збережено. Користувач або звіт змінився; повторіть пошук.', 'warning'); return;
    }
    for (const receipt of receipts) {
      const raw = magazinePage?.items.find(row => Number(row.sclad_id) === receipt.id);
      if (raw) raw.rosraxovano = receipt.paidAt;
      const row = magazineData.find(item => Number(item.sclad_id) === receipt.id);
      if (row) { row.rosraxovano = receipt.paidAt; row.isPaid = !!receipt.paidAt; }
    }
    invalidateStockAccounting(); announceAccountingChange(['stock','shops','profit'], ['stock']);
    updateMagazineTable(); showNotification(`Розрахунок збережено: ${receipts.length} позицій`, 'success');
  } catch (error) {
    magazineAppliedScope = ''; magazineScroll.pause(); invalidateStockAccounting();
    showNotification((error as Error)?.message || 'Не вдалося підтвердити розрахунок. Повторіть пошук.', 'error');
  } finally { magazineBusy = false; updateMagazineScroll(); }
  // One bounded refresh obtains the new server revision; displayed rows remain until it returns.
  if (committed) await refreshMagazinePaymentPage(filter, scope);
}
export async function toggleMagazinePayment(index: number): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    const item = magazineData[index]; if (!item?.sclad_id) return;
    await performMagazinePayment([Number(item.sclad_id)], item.isPaid ? 'unpay' : 'pay');
  });
}

export async function toggleReturn(index: number): Promise<void> {
  await withAccountingPaymentOperation(() => performMagazineReturn(index));
}
async function performMagazineReturn(index: number): Promise<void> {
  if (magazineBusy || magazineLoading) return;
  const item = magazineData[index];
  if (!item) return;
  const scope=accountingSearchScope('stock');

  const action: "return" | "unreturn" = item.isReturned ? "unreturn" : "return";

  // Перевірка прав доступу
  const hasReturnPermission = await canUserReturnMagazine();
  const hasCancelReturnPermission = await canUserCancelReturnMagazine();

  if (action === "return" && !hasReturnPermission) {
    showNotification("⚠️ У вас немає прав для повернення товарів", "warning");
    return;
  }

  if (action === "unreturn" && !hasCancelReturnPermission) {
    showNotification("⚠️ У вас немає прав для відміни повернення", "warning");
    return;
  }

  if (action === "unreturn" && item.povernennya) {
    const { dateISO } = splitDateTimeSafe(item.povernennya);
    const todayISO = accountingToday();
    if (dateISO !== todayISO && !hasFullAccess()) {
      showNotification(
        "❌ Скасувати повернення неможливо: доступно тільки для сьогоднішніх повернень",
        "error",
        4000,
      );
      return;
    }
    if (dateISO !== todayISO && hasFullAccess()) {
      showNotification(
        "⚠️ Скасування повернення не сьогоднішнього терміну (як адміністратор)",
        "warning",
        2000,
      );
    }
  }

  const confirmed = await createPasswordConfirmationModal(action, () => magazineData.includes(item) && !magazineLoading && !!magazineAppliedFilter && magazineFilterCurrent(magazineAppliedFilter,scope));
  if (!confirmed) {
    showNotification("🚫 Операцію скасовано", "info");
    return;
  }

  if (!magazineData.includes(item) || magazineBusy || magazineLoading || !magazineAppliedFilter || !magazineFilterCurrent(magazineAppliedFilter,scope)) { showNotification('Звіт змінився. Повторіть дію.','warning'); return; }
  magazineBusy=true; updateMagazineScroll();
  const prevIsReturned = item.isReturned;
  const prevDate = item.povernennya;
  const prevKilkistOff = item.kilkist_off;
  const prevReturnedBy = item.xto_povernyv;
  let committed = false;

  item.isReturned = !prevIsReturned;
  item.povernennya = item.isReturned ? todayDateTime() : null;
  const userData = getSavedUserDataFromLocalStorage();
  const userName = userData?.name || "Невідомий";

  if (item.isReturned) {
    item.kilkist_off = item.kilkist_off + item.kilkist_on;
    item.xto_povernyv = userName;
  } else {
    item.kilkist_off = item.kilkist_off - item.kilkist_on;
    item.xto_povernyv = null;
  }

  try {
    await updateReturnInDatabase(item);
    committed = true;
    updateMagazineTable();
    updateMagazineTotalSum();

    if (item.isReturned && item.povernennya != null) {
      const { dateISO, timeHM } = splitDateTimeSafe(item.povernennya);
      showNotification(
        `🔄 Повернення встановлено на ${formatDate(dateISO)} ${timeHM || ""}`,
        "success",
      );
    } else {
      showNotification("🔄 Повернення скасовано", "success");
    }
  } catch (e) {
    item.isReturned = prevIsReturned;
    item.povernennya = prevDate;
    item.kilkist_off = prevKilkistOff;
    item.xto_povernyv = prevReturnedBy;
    // console.error(e);
    showNotification("❌ Помилка оновлення статусу повернення", "error", 4000);
    updateMagazineTable();
    updateMagazineTotalSum();
  } finally {
    invalidateStockAccounting(); magazineAppliedScope=''; magazineBusy=false;
    if (committed) await autoSearchFromInputs();
    else magazineScroll.pause();
    updateMagazineScroll();
  }
}

// ==== Динамічні кнопки фільтрації по складах ====
let availableScladNomers: number[] = [];

function getUniqueScladNomers(): number[] { return magazinePage?.facets?.warehouses || []; }

function generateScladFilterButtons(): void {
  const container = byId<HTMLElement>("magazine-sklad-filter-container");
  if (!container) return;

  availableScladNomers = getUniqueScladNomers();

  // Якщо немає складів або тільки 1 склад - не показуємо кнопки
  if (availableScladNomers.length === 0 || availableScladNomers.length === 1) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  // Додаємо клас для однакової ширини кнопок
  container.classList.add("equal-width");

  let buttonsHtml = "";

  availableScladNomers.forEach((nomer) => {
    const isActive = currentFilters.scladNomer === nomer;
    buttonsHtml += `
      <button
        class="Bukhhalter-sklad-btn ${isActive ? "active" : ""}"
        data-sclad-nomer="${nomer}"
        onclick="filterBySclad(${nomer})"
        title="Показати склад ${nomer}"
      >
        Склад ${nomer}
      </button>
    `;
  });

  // Кнопка "Всі" - помаранчева
  const isAllActive = currentFilters.scladNomer === null;
  buttonsHtml += `
    <button
      class="Bukhhalter-sklad-btn Bukhhalter-sklad-btn-all ${isAllActive ? "active" : ""}"
      data-sclad-nomer="all"
      onclick="filterBySclad(null)"
      title="Показати всі склади"
    >
      Всі
    </button>
  `;

  container.innerHTML = buttonsHtml;
}

function filterBySclad(scladNomer: number | null): void {
  currentFilters.scladNomer = scladNomer;

  // Оновлюємо активну кнопку
  const container = byId<HTMLElement>("magazine-sklad-filter-container");
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

  autoFilterFromInputs();
  updateMagazineTable();
  updateMagazineTotalSum();
}

// Експорт для глобального доступу
(window as any).filterBySclad = filterBySclad;

// ==== Ініціалізація автоповедінки з правильними обробниками ====
function initMagazineAutoBehaviors(): void {
  ensureSmartDropdowns();

  const shopEl = getEl<HTMLInputElement | HTMLSelectElement>(
    "Bukhhalter-magazine-shop",
  );
  if (shopEl && shopEl.tagName.toLowerCase() === "select") {
    const loadShopsHandler = async () => {
      await loadAvailableShops();
    };

    shopEl.addEventListener("focus", loadShopsHandler);
    shopEl.addEventListener("click", loadShopsHandler);

    const changeHandler = () => {
      refreshDropdownOptions();
      triggerAutoFilter();
    };
    shopEl.addEventListener("change", changeHandler);
    shopEl.addEventListener("input", changeHandler);
  }

  const onDateChange = () => {
    triggerAutoFilter();
  };

  const d1 = getEl<HTMLInputElement>("Bukhhalter-magazine-date-open");
  const d2 = getEl<HTMLInputElement>("Bukhhalter-magazine-date-close");
  d1?.addEventListener("change", onDateChange);
  d2?.addEventListener("change", onDateChange);

  // ==== Перемикач оплати ====
  const paymentToggle = getEl<HTMLInputElement>(
    "magazine-payment-filter-toggle",
  );
  if (paymentToggle) {
    paymentToggle.min = "0";
    paymentToggle.max = "2";
    if (!paymentToggle.value) {
      paymentToggle.value = "2";
      currentFilters.paymentStatus = 2;
    } else {
      currentFilters.paymentStatus = parseInt(paymentToggle.value, 10) as
        | 0
        | 1
        | 2;
    }

    paymentToggle.addEventListener("input", function () {
      const newValue = parseInt(this.value, 10) as 0 | 1 | 2;
      currentFilters.paymentStatus = newValue;
      autoFilterFromInputs();
      updateMagazineTable();
      updateMagazineTotalSum();
    });
  }

  // ==== Перемикач наявності ====
  const availabilityToggle = getEl<HTMLInputElement>(
    "magazine-availability-filter-toggle",
  );
  if (availabilityToggle) {
    availabilityToggle.min = "0";
    availabilityToggle.max = "4";
    if (!availabilityToggle.value) {
      availabilityToggle.value = "4";
      currentFilters.availabilityStatus = 4;
    } else {
      currentFilters.availabilityStatus = parseInt(
        availabilityToggle.value,
        10,
      ) as 0 | 1 | 2 | 3 | 4;
    }

    availabilityToggle.addEventListener("input", function () {
      const newValue = parseInt(this.value, 10) as 0 | 1 | 2 | 3 | 4;
      currentFilters.availabilityStatus = newValue;
      autoFilterFromInputs();
      updateMagazineTable();
      updateMagazineTotalSum();
    });
  }
  initMagazineDateFilterToggle();

  // ==== Фільтр по Запчастисту ====
  const zapchastystSelect = getEl<HTMLSelectElement>(
    "Bukhhalter-magazine-zapchastyst",
  );
  if (zapchastystSelect) {
    zapchastystSelect.addEventListener("change", function () {
      const value = this.value;
      currentFilters.zapchastystFilter = value ? parseInt(value, 10) : null;
      autoFilterFromInputs();
      updateMagazineTable();
      updateMagazineTotalSum();
    });
  }
}

function rememberMagazineWrite(): void {
  magazineLoadGeneration++; invalidateStockAccounting(); magazinePending=null; magazineAppliedScope=''; magazineScroll.pause();
  announceAccountingChange(['stock','shops','profit']);
}

function guardMagazineRowBaseline(query: any, item: MagazineRecord): any {
  const baseline=magazinePage?.items.find(row=>Number(row.sclad_id)===Number(item.sclad_id));
  if (!baseline) throw new Error('Звіт змінився. Повторіть пошук.');
  for (const field of ['shops','rahunok','akt','name','part_number','kilkist_on','kilkist_off','price',
    'rosraxovano','povernennya','xto_povernyv','scladNomer','xto_zamovuv']) {
    query=baseline[field] == null ? query.is(field,null) : query.eq(field,baseline[field]);
  }
  return query;
}

async function updateReturnInDatabase(item: MagazineRecord): Promise<void> {
  if (!item.pkName || item.pkValue === undefined || item.pkValue === null) {
    showNotification("Не знайдено первинний ключ запису (pk)", "error");
    throw new Error("PK запису не визначено");
  }

  const updateData: any = {
    povernennya: item.povernennya,
    kilkist_off: item.kilkist_off,
  };

  if (item.isReturned) {
    updateData.xto_povernyv = item.xto_povernyv;
  } else {
    updateData.xto_povernyv = null;
  }

  const query=guardMagazineRowBaseline(supabase.from(SCLAD_TABLE).update(updateData).eq(item.pkName,item.pkValue),item);
  const {data,error}=await query.select('povernennya,kilkist_off,xto_povernyv').single();

  if (error) {
    // console.error("Помилка оновлення статусу повернення:", error);
    throw error;
  }
  item.povernennya = data.povernennya; item.isReturned = !!data.povernennya;
  item.kilkist_off = Number(data.kilkist_off); item.xto_povernyv = data.xto_povernyv;
  rememberMagazineWrite();
  await autoSearchFromInputs();
}

export function deleteMagazineRecord(index: number): void {
  if (magazineBusy || magazineLoading) return;
  if (hiddenMagazineIds.size>=2000) { showNotification('Для подальшого звуження звіту використайте фільтри.','info'); return; }
  const row=magazineData[index]; if (!row?.sclad_id) return;
  hiddenMagazineIds.add(Number(row.sclad_id));
  void autoSearchFromInputs();
  showNotification('Видалено з таблиці','info',1600);
}

export function clearMagazineForm(): void {
  resetMagazineReport();
  const inputs = document.querySelectorAll<HTMLInputElement>(
    "#Bukhhalter-magazine-section input:not([readonly])",
  );
  inputs.forEach((i) => (i.value = ""));

  const selects = document.querySelectorAll<HTMLSelectElement>(
    "#Bukhhalter-magazine-section select",
  );
  selects.forEach((s) => (s.value = ""));

  currentFilters = {
    dateOpen: "",
    dateClose: "",
    shop: "",
    paymentStatus: 2,
    availabilityStatus: 4,
    scladNomer: null,
    zapchastystFilter: null,
  };

  const paymentToggle = byId<HTMLInputElement>(
    "magazine-payment-filter-toggle",
  );
  const availabilityToggle = byId<HTMLInputElement>(
    "magazine-availability-filter-toggle",
  );
  if (paymentToggle) paymentToggle.value = "2";
  if (availabilityToggle) availabilityToggle.value = "4";

  // Скидаємо фільтр запчастиста
  const zapchastystSelect = getEl<HTMLSelectElement>(
    "Bukhhalter-magazine-zapchastyst",
  );
  if (zapchastystSelect) zapchastystSelect.value = "";

  // Скидаємо фільтр складу
  generateScladFilterButtons();

  magazineData = [];
  allMagazineData = [];
  availableShops = [];
  shopsData = [];

  shopsLoaded = false;

  updateMagazineTable();
  updateMagazineTotalSum();
  showNotification("Фільтри магазину очищено", "info", 1500);
}

// ==== Функції створення перемикачів ====
export function createMagazinePaymentToggle(): void {
  const existing = byId("magazine-payment-filter-toggle");
  if (existing) {
    initMagazineAutoBehaviors();
    return;
  }

  const section = byId("Bukhhalter-magazine-section");
  const btnContainer = section?.querySelector(".Bukhhalter-button-container");

  const wrap = document.createElement("div");
  wrap.className = "Bukhhalter-toggle-container";
  wrap.innerHTML = `
    <label class="Bukhhalter-field-label">💰 Розрахунок</label>
    <div class="Bukhhalter-toggle-wrapper">
      <input type="range" min="0" max="2" value="2"
             class="Bukhhalter-payment-toggle"
             id="magazine-payment-filter-toggle">
      <div class="Bukhhalter-toggle-labels">
        <span>Розраховано</span>
        <span>Не розраховано</span>
        <span>Всі</span>
      </div>
    </div>
  `;
  section?.insertBefore(wrap, btnContainer || null);

  const toggle = byId<HTMLInputElement>("magazine-payment-filter-toggle");
  if (toggle) {
    currentFilters.paymentStatus = 2;
    toggle.addEventListener("input", function () {
      const newValue = parseInt(this.value, 10) as 0 | 1 | 2;
      currentFilters.paymentStatus = newValue;
      autoFilterFromInputs();
      updateMagazineTable();
      updateMagazineTotalSum();
    });
  }
}

export function createMagazineAvailabilityToggle(): void {
  const existing = byId("magazine-availability-filter-toggle");
  if (existing) {
    initMagazineAutoBehaviors();
    return;
  }

  const section = byId("Bukhhalter-magazine-section");
  const btnContainer = section?.querySelector(".Bukhhalter-button-container");

  const wrap = document.createElement("div");
  wrap.className = "Bukhhalter-toggle-container";
  wrap.innerHTML = `
    <label class="Bukhhalter-field-label">📦 Наявність на складі</label>
    <div class="Bukhhalter-toggle-wrapper">
      <input type="range" min="0" max="4" value="4"
             class="Bukhhalter-availability-toggle"
             id="magazine-availability-filter-toggle">
      <div class="Bukhhalter-toggle-labels-5">
        <span>Присутні</span>
        <span>Нульові</span>
        <span>Відємні</span>
        <span>Повернення</span>
        <span>Всі</span>
      </div>
    </div>
  `;
  section?.insertBefore(wrap, btnContainer || null);

  const toggle = byId<HTMLInputElement>("magazine-availability-filter-toggle");
  if (toggle) {
    currentFilters.availabilityStatus = 4;
    toggle.addEventListener("input", function () {
      const newValue = parseInt(this.value, 10) as 0 | 1 | 2 | 3 | 4;
      currentFilters.availabilityStatus = newValue;
      autoFilterFromInputs();
      updateMagazineTable();
      updateMagazineTotalSum();
    });
  }
}

export function getShopsList(): string[] {
  // Report rows already contain supplier names; the complete names-only directory
  // is requested only when the supplier filter is opened.
  const shops = new Set<string>(
    shopsLoaded && availableShopScope === accountingSearchScope('stock') ? availableShops : [],
  );
  allMagazineData.forEach((i) => {
    if (i.shops) shops.add(i.shops);
  });
  return Array.from(shops).sort();
}

export function createShopsSelect(): void {
  const current = document.getElementById("Bukhhalter-magazine-shop");
  if (!current) return;
  if (current.tagName.toLowerCase() === "select") return;

  const select = document.createElement("select");
  select.id = "Bukhhalter-magazine-shop";
  select.className = "Bukhhalter-field-input";
  select.innerHTML =
    '<option value="">Оберіть магазин (або залиште порожнім для всіх)</option>';

  current.parentNode?.replaceChild(select, current);

  const loadHandler = async () => {
    await loadAvailableShops();
  };

  select.addEventListener("focus", loadHandler);
  select.addEventListener("click", loadHandler);

  select.addEventListener("change", () => {
    refreshDropdownOptions();
    triggerAutoFilter();
  });
}

function populateShopsSelectOptions(): void {
  const el = document.getElementById(
    "Bukhhalter-magazine-shop",
  ) as HTMLSelectElement | null;
  if (!el) return;

  if (el.tagName.toLowerCase() !== "select") {
    createShopsSelect();
  }
  const select = document.getElementById(
    "Bukhhalter-magazine-shop",
  ) as HTMLSelectElement | null;
  if (!select) return;

  const currentValue = select.value;
  const shops = getShopsList();
  // Keep an explicitly selected historical supplier even if it has no rows in
  // the newly selected period or was renamed in the directory.
  if (currentValue && !shops.includes(currentValue)) shops.push(currentValue);
  select.replaceChildren(new Option('Оберіть магазин (або залиште порожнім для всіх)', ''));
  for (const shop of shops) select.add(new Option(shop, shop));
  select.value = currentValue;
}

export async function runMassPaymentCalculationForMagazine(): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    if (magazineBusy || magazineLoading || !magazinePage || !magazineAppliedFilter || !hasFullAccess()) return;
    const filter = structuredClone(magazineAppliedFilter), scope = magazineAppliedScope, generation = magazineLoadGeneration;
    const initial = magazinePage;
    const current = () => generation === magazineLoadGeneration && magazinePage === initial && magazineFilterCurrent(filter, scope);
    if (!current() || !readAccountingPeriod('magazine')) return;
    magazineBusy = true; updateMagazineScroll();
    try {
      const rows = [...initial.items], total = initial.summary?.totalCount;
      let page = initial;
      while (page.has_more) {
        page = await readStockAccountingPage(filter, page.next_cursor, initial.revision, 200);
        if (!current()) throw new Error('Фільтри змінилися. Повторіть розрахунок.');
        if (!page.items.length || page.revision !== initial.revision) throw new Error('Звіт змінився. Повторіть пошук.');
        rows.push(...page.items);
        if (new Set(rows.map(row => Number(row.sclad_id))).size !== rows.length) throw new Error('Повторні позиції. Повторіть пошук.');
      }
      if (!current() || rows.length !== total || new Set(rows.map(row => Number(row.sclad_id))).size !== rows.length) throw new Error('Неповний звіт. Оплату не виконано; повторіть пошук.');
      magazinePage = {...initial, items: rows, next_cursor: null, has_more: false};
      magazineData = rows.map(mapRowToMagazineRecord); allMagazineData = magazineData;
    } catch (error) {
      showNotification((error as Error)?.message || 'Не вдалося завантажити всі позиції. Оплату не виконано.', 'error');
      return;
    } finally { magazineBusy = false; updateMagazineScroll(); }
    const ids = magazineData.filter(row => !row.isPaid && !row.isReturned).map(row => Number(row.sclad_id));
    await performMagazinePayment(ids, 'pay', true);
  });
}

/** Explicit full export only; opening/scrolling never reads the full period. */
export async function withMagazineExport(download: () => void): Promise<void> {
  if (!magazinePage || !magazineAppliedFilter) { download(); return; }
  if (magazineBusy || magazineLoading || !magazineFilterCurrent(magazineAppliedFilter,magazineAppliedScope)) throw new Error('Дочекайтеся поточного пошуку складу.');
  const filter=structuredClone(magazineAppliedFilter), scope=magazineAppliedScope, version=magazinePage.revision;
  const generation=magazineLoadGeneration, originalPage=magazinePage, rows=[...magazinePage.items], total=magazinePage.summary!.totalCount;
  let cursor: StockAccountingCursor | null=magazinePage.next_cursor, more=magazinePage.has_more, refresh=false;
  magazineBusy=true; updateMagazineScroll();
  try {
    while(more) {
      const page=await readStockAccountingPage(filter,cursor,version,200);
      if (generation!==magazineLoadGeneration || !magazineFilterCurrent(filter,scope)) throw new Error('Фільтр змінився. Повторіть експорт.');
      rows.push(...page.items); cursor=page.next_cursor; more=page.has_more;
    }
    if (generation!==magazineLoadGeneration || !magazineFilterCurrent(filter,scope) || originalPage!==magazinePage) throw new Error('Фільтр змінився. Повторіть експорт.');
    if (new Set(rows.map(row=>row.sclad_id)).size!==rows.length || rows.length!==total) throw new Error('Звіт змінився. Повторіть пошук перед експортом.');
    const previous=magazineData;
    try {
      magazineData=rows.map(mapRowToMagazineRecord);
      for (const row of rows) if (row.xto_zamovuv && row.requester_name) slyusarsNameCache.set(Number(row.xto_zamovuv),row.requester_name);
      withAccountingExportRows('magazine-table',updateMagazineTable,download);
    } finally { if (generation===magazineLoadGeneration && originalPage===magazinePage) magazineData=previous; }
  } catch(error) {
    if (stockAccountingStale(error)) {
      invalidateStockAccounting(); magazineAppliedScope=''; refresh=true;
      throw new Error('Дані складу змінилися. Звіт оновлено; повторіть експорт.');
    }
    throw error;
  } finally {
    magazineBusy=false;
    if (refresh || !magazineFilterCurrent(filter,scope)) await autoSearchFromInputs();
    if (generation!==magazineLoadGeneration || !magazineFilterCurrent(filter,scope)) updateMagazineTable();
    updateMagazineScroll();
  }
}

// Глобалізація функцій
// Глобалізація функцій
(window as any).toggleMagazinePayment = toggleMagazinePayment;
(window as any).toggleReturn = toggleReturn;
(window as any).deleteMagazineRecord = deleteMagazineRecord;

(window as any).updateMagazineTotalSum = updateMagazineTotalSum;
