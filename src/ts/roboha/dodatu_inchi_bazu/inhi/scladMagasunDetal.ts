import { stockSuggestionRevision } from "./stockReadRevision";
// src\ts\roboha\dodatu_inchi_bazu\inhi\scladMagasunDetal.ts
import { supabase } from "../../../vxid/supabaseClient";
import { readStockDirectory } from "./referenceLookup";
import { mountDirectoryDropdown } from "./directoryRead";
import { updateAllBd, CRUD } from "../dodatu_inchi_bazu_danux";
import { initBatchImport } from "./batchImportSclad";
import { setupEnterNavigationForFields } from "../../redahyvatu_klient_machuna/enter_navigation";

/** ====== СТАН МАГАЗИН ====== */
export type ShopEditState = {
  originalName: string | null;
  currentName: string;
  baseShopId: number | null;
  touched: boolean;
};
export const shopEditState: ShopEditState = {
  originalName: null,
  currentName: "",
  baseShopId: null,
  touched: false,
};
export function resetShopState() {
  shopEditState.originalName = null;
  shopEditState.currentName = "";
  shopEditState.baseShopId = null;
  shopEditState.touched = false;
}

/** ====== СТАН ДЕТАЛЬ ====== */
export type DetailEditState = {
  originalName: string | null;
  currentName: string;
  baseDetailId: number | null;
  touched: boolean;
};
export const detailEditState: DetailEditState = {
  originalName: null,
  currentName: "",
  baseDetailId: null,
  touched: false,
};
export function resetDetailState() {
  detailEditState.originalName = null;
  detailEditState.currentName = "";
  detailEditState.baseDetailId = null;
  detailEditState.touched = false;
}

/** ====== SCLAD ID (ключ для UPDATE/DELETE) ====== */
let currentScladId: string | null = null;
let persistentScladId: string | null = null;
let originalScladRecord: Record<string, any> | null = null;
let stockSelectionRevision = 0;
let formController = new AbortController();
let formGeneration = 0;
let lookupSession = 0;
const formScope = () => JSON.stringify([lookupSession, stockSuggestionRevision(), localStorage.getItem("userAuthData")]);
export function getOriginalScladRecord(): Record<string, any> | null {
  return originalScladRecord ? structuredClone(originalScladRecord) : null;
}
export function updateOriginalScladRecord(patch: Record<string, any>): void {
  if (originalScladRecord) originalScladRecord = { ...originalScladRecord, ...patch };
}

function setScladId(id: string | null) {
  currentScladId = id;
  if (id) {
    persistentScladId = id;
  }
  const hidden = document.getElementById(
    "hidden-sclad-id",
  ) as HTMLInputElement | null;
  if (hidden) hidden.value = id ?? "";
}

export function getCurrentScladId() {
  return currentScladId || persistentScladId;
}

let originalScladId: string | null = null;
let originalPartNumber: string | null = null;
export function getOriginalScladAnchor() {
  return { id: originalScladId, part: originalPartNumber };
}

function clearAllScladIds() {
  stockSelectionRevision++;
  currentScladId = null;
  persistentScladId = null;
  originalScladId = null;
  originalPartNumber = null;
  originalScladRecord = null;
  const hidden = document.getElementById(
    "hidden-sclad-id",
  ) as HTMLInputElement | null;
  if (hidden) hidden.value = "";
}

export function resetScladFormSession(): void {
  formGeneration++;
  formController.abort();
  formController = new AbortController();
  clearAllScladIds();
  resetShopState();
  resetDetailState();
}
if (typeof document !== "undefined") document.addEventListener("sto:other-bases-closed", resetScladFormSession);

/** Завантаження запчастистів та їх ID */
let zapchastystCache: Array<{ name: string; id: number }> = [];
let zapchastystCacheScope="";
let zapchastystPending: Promise<Array<{ name: string; id: number }>> | null = null;
let warehousePending: Promise<number[]> | null = null;
let warehouseScope = "";
if (typeof document !== "undefined") document.addEventListener("sto:other-bases-closed", () => {
  lookupSession++;
  zapchastystCache = []; zapchastystPending = null; warehousePending = null;
});

/** Отримати slyusar_id за ПІБ з кешу запчастистів */
export function getSlyusarIdByPib(pib: string): number | null {
  if (zapchastystCacheScope !== formScope()) return null;
  const found = zapchastystCache.filter(
    (z) => z.name.toLowerCase() === pib.toLowerCase(),
  );
  return found.length === 1 ? found[0].id : null;
}

async function loadZapchastystFromDB(): Promise<Array<{ name: string; id: number }>> {
  const scope = formScope();
  if (scope !== zapchastystCacheScope) { zapchastystCache = []; zapchastystPending = null; zapchastystCacheScope = scope; }
  if (zapchastystPending) return zapchastystPending;
  const job = (async () => {
    const rows = await readStockDirectory<{ slyusar_id: number; data: { Name?: string; "Ім'я"?: string; Доступ?: string } }>("staff");
    if (!rows) throw new Error("Оновіть SQL traffic_stock_directory для списку запчастистів.");
    const result = rows.filter(row => row.data?.Доступ !== "Слюсар")
      .map(row => ({ id: Number(row.slyusar_id), name: String(row.data?.Name || row.data?.["Ім'я"] || "").trim() }))
      .filter(row => row.name && Number.isSafeInteger(row.id) && row.id > 0)
      .sort((a, b) => a.name.localeCompare(b.name, "uk") || a.id - b.id);
    if (scope !== formScope()) throw new Error("Список співробітників змінився. Повторіть вибір.");
    zapchastystCache = result;
    return result;
  })();
  zapchastystPending = job;
  void job.catch(() => { if (zapchastystPending === job) zapchastystPending = null; });
  return job;
}

/* ==== автокомпліт запчастистів ==== */
async function wireZapchastystAutocomplete(inputId: string, dropdownId: string) {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const dd = document.getElementById(dropdownId);
  if (!input || !dd) return;
  setupDropdownKeyboard(input, dd);
  const signal = formController.signal;
  let generation = 0;
  const close = () => { generation++; dd.classList.add("hidden-all_other_bases"); };
  const render = async () => {
    const token = ++generation, scope = formScope();
    try {
      const names = await loadZapchastystFromDB();
      if (token !== generation || signal.aborted || !input.isConnected || scope !== formScope()) return;
      dd.replaceChildren();
      for (const { name, id } of names) {
        const item = document.createElement("div");
        item.className = "custom-dropdown-item";
        item.textContent = names.filter(row => row.name === name).length > 1 ? name + " · №" + id : name;
        item.addEventListener("pointerdown", event => event.preventDefault());
        item.addEventListener("click", () => {
          if (token !== generation || signal.aborted || !input.isConnected || scope !== formScope()) return;
          input.value = name;
          input.dataset.slyusarId = String(id);
          close();
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        dd.appendChild(item);
      }
      dd.classList.toggle("hidden-all_other_bases", !names.length);
    } catch (error: any) {
      if (token !== generation || signal.aborted || !input.isConnected) return;
      dd.textContent = error?.message || "Не вдалося завантажити запчастистів. Натисніть поле для повтору.";
      dd.classList.remove("hidden-all_other_bases");
    }
  };
  input.addEventListener("focus", () => { void render(); }, { signal });
  input.addEventListener("click", () => { void render(); }, { signal });
  input.addEventListener("keydown", event => { if (event.key === "Escape") close(); }, { signal });
  document.addEventListener("click", event => { if (event.target !== input && !dd.contains(event.target as Node)) close(); }, { signal });
}

/** Рендер форми «Склад» */
export async function renderScladForm() {
  const host = document.getElementById("sclad-form");
  if (!host) return;

  resetScladFormSession();
  const generation = formGeneration;
  const active = () => generation === formGeneration && host.isConnected && !formController.signal.aborted;

  host.innerHTML = `
    <input id="hidden-sclad-id" type="hidden" />
    <div class="sclad-grid">
      ${field("sclad_date", "Дата", "date")}
      ${field("sclad_shop", "Магазин", "text", '<div id="sclad_shop_dd" class="custom-dropdown hidden-all_other_bases"></div>')}
      ${field("sclad_detail_catno", "Каталог номер деталі", "text", '<div id="sclad_part_dd" class="custom-dropdown hidden-all_other_bases"></div>')}
      ${field("sclad_detail", "Деталь", "text", '<div id="sclad_detail_dd" class="custom-dropdown hidden-all_other_bases"></div>')}
      <div class="sclad-row-4">
          ${field("sclad_qty_in", "К-ть надходження", "number")}
        ${field("sclad_price", "Ціна", "number")}
        ${field("sclad_sum", "Сума", "number")}
        <div class="form-field">
          <label class="field-label" for="sclad_procent">Склад</label>
          <select id="sclad_procent" class="input-all_other_bases"><option value="">Завантаження...</option></select>
        </div>
      </div>
      <div class="sclad-row-3">
        ${field("sclad_invoice_no", "Рахунок №")}
        ${selectField("sclad_unit", "Одиниця виміру", [
          ["штук", "штук"],
          ["літр", "літр"],
          ["комплект", "комплект"],
          ["метр", "метр"],
        ])}
        <div class="form-field">
          <label class="field-label" for="sclad_zapchastyst_pib">Запчастист</label>
          <input id="sclad_zapchastyst_pib" type="text" class="input-all_other_bases" autocomplete="off" readonly style="cursor: pointer;">
          <div id="sclad_zapchastyst_dd" class="custom-dropdown hidden-all_other_bases"></div>
        </div>
      </div>
    </div>
  `;
  host.classList.remove("hidden-all_other_bases");
  const sumInput = host.querySelector<HTMLInputElement>("#sclad_sum");
  if (sumInput) { sumInput.readOnly = true; sumInput.tabIndex = -1; sumInput.setAttribute("aria-label", "Сума: кількість × ціна"); }
  for (const id of ["sclad_qty_in", "sclad_price"]) {
    const input = host.querySelector<HTMLInputElement>("#" + id);
    if (input) { input.step = "any"; input.addEventListener("input", updateScladTotal); input.addEventListener("change", updateScladTotal); }
  }
  updateScladTotal();

  // ✅ ВИПРАВЛЕННЯ: ініціалізуємо одразу, до async-операцій,
  // щоб onclick на "💾 Записати деталі" спрацював без затримки 4-5с
  initBatchImport();

  // Автозаповнення сьогоднішньої дати
  const dateInput = host.querySelector<HTMLInputElement>("#sclad_date");
  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    dateInput.value = `${yyyy}-${mm}-${dd}`;
  }

  // Автозаповнення ПІБ поточного користувача (для всіх крім Слюсарів)
  const currentUserData = localStorage.getItem("userAuthData");
  if (currentUserData) {
    try {
      const userData = JSON.parse(currentUserData);
      const userAccess = userData["Доступ"] || userData.Dostup || "";
      const currentPib = userData.Name || "";
      // Автозаповнення для всіх користувачів крім Слюсарів
      if (userAccess !== "Слюсар" && currentPib) {
        const pibInput = document.getElementById(
          "sclad_zapchastyst_pib",
        ) as HTMLInputElement | null;
        if (pibInput) {
          pibInput.value = currentPib;
          if (userData.slyusar_id) pibInput.dataset.slyusarId = String(userData.slyusar_id);
        }
      }
    } catch (e) {
      // console.error("Помилка автозаповнення ПІБ:", e);
    }
  }

  // Налаштування date picker
  if (dateInput && !dateInput.dataset.pickerBound) {
    const openPicker = () => {
      try {
        (dateInput as any).showPicker?.();
      } catch {}
    };
    dateInput.dataset.pickerBound = "1";
    dateInput.addEventListener("click", openPicker);
    dateInput.addEventListener("focus", openPicker);
    dateInput.addEventListener("keydown", (e) => {
      if (["ArrowDown", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openPicker();
      }
    });
  }

  host.querySelectorAll("input,select,textarea").forEach((el) => {
    el.addEventListener("input", snapshotToAllBd);
    el.addEventListener("change", snapshotToAllBd);
  });
  snapshotToAllBd();

  await wireShopAutocomplete("sclad_shop", "sclad_shop_dd");
  if (!active()) return;
  await wireDetailsAutocompleteWithLiveLoad("sclad_detail", "sclad_detail_dd");
  await wireLinkedAutocomplete();

  // Налаштування автокомпліту для запчастистів
  await wireZapchastystAutocomplete(
    "sclad_zapchastyst_pib",
    "sclad_zapchastyst_dd",
  );

  if (!active()) return;

  // Завантаження опцій відсотків
  await loadProcentOptions();
  if (!active()) return;

  // Налаштування навігації Enter між полями
  const removeEnterNavigation = setupEnterNavigationForFields([
    "sclad_date",
    "sclad_shop",
    "sclad_detail_catno",
    "sclad_detail",
    "sclad_qty_in",
    "sclad_price",
    "sclad_invoice_no",
    "sclad_unit",
    "sclad_procent",
  ]);
  formController.signal.addEventListener("abort", removeEnterNavigation, { once: true });
}

/** Завантаження опцій відсотків з таблиці settings */
async function loadProcentOptions() {
  const signal = formController.signal;
  const select = document.getElementById(
    "sclad_procent",
  ) as HTMLSelectElement | null;
  if (!select) return;

  try {
    const scope = formScope();
    if (warehouseScope !== scope) { warehousePending = null; warehouseScope = scope; }
    warehousePending ??= (async () => {
      const { data, error } = await supabase.from("settings").select("setting_id")
        .gte("setting_id", 1).lte("setting_id", 500).not("procent", "is", null)
        .gte("procent", 0).order("setting_id", { ascending: true });
      if (error) throw error;
      return (data || []).map(row => Number(row.setting_id));
    })().catch(error => { warehousePending = null; throw error; });
    const activeIds = await warehousePending;
    if (!select.isConnected || signal.aborted) return;

    // Генеруємо опції для активних ID (можуть бути розріджені, напр. 1,2,3,15)
    const optionsHtml = activeIds
      .map((id) => `<option value="${id}">${id}</option>`)
      .join("");

    const selected = select.dataset.selectedWarehouse || select.value;
    select.innerHTML = optionsHtml || '<option value="">Немає активних складів</option>';
    if (selected) {
      if (![...select.options].some(option => option.value === selected)) select.add(new Option(selected + " (неактивний)", selected));
      select.value = selected;
    }
  } catch (e) {
    // console.error("Помилка завантаження відсотків:", e);
    select.innerHTML = '<option value="">Помилка</option>';
  }
}

/* ---------- helpers ---------- */
function field(
  id: string,
  label: string,
  type: "text" | "date" | "number" = "text",
  extra = "",
) {
  return `
    <div class="form-field">
      <label class="field-label" for="${id}">${label}</label>
      <input id="${id}" type="${type}" class="input-all_other_bases" autocomplete="off" />
      ${extra}
    </div>`;
}

function selectField(
  id: string,
  label: string,
  options: Array<[string, string]>,
) {
  const opts = options
    .map(([v, t]) => `<option value="${v}">${t}</option>`)
    .join("");
  return `
    <div class="form-field">
      <label class="field-label" for="${id}">${label}</label>
      <select id="${id}" class="input-all_other_bases">${opts}</select>
    </div>`;
}

import { setupDropdownKeyboard } from "./sharedAutocomplete";

/* ==== автопідказка магазин ==== */
async function wireShopAutocomplete(inputId: string, dropdownId: string) {
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  const dd = document.getElementById(dropdownId);
  if (!input || !dd) return;
  const signal = formController.signal;
  mountDirectoryDropdown("shops", input, dd, row => {
    if (signal.aborted || !input.isConnected) return;
    const name = String(row.data?.Name || "");
    Object.assign(shopEditState, { originalName: name, currentName: name, baseShopId: Number(row.shop_id), touched: true });
    snapshotToAllBd();
  }, () => {
    if (signal.aborted || !input.isConnected) return;
    shopEditState.currentName = input.value.trim();
    shopEditState.touched = true;
  });
}

async function fillFormFieldsFromSclad(record: any) {
  stockSelectionRevision++;
  originalScladRecord = structuredClone(record);
  if (record?.sclad_id) {
    setScladId(String(record.sclad_id));
    originalScladId = String(record.sclad_id);
  }

  originalPartNumber = record?.part_number ?? null;

  const fields: Record<string, any> = {
    sclad_date: record?.time_on ? String(record.time_on).split("T")[0] : "",
    sclad_shop: record?.shops ?? "",
    sclad_detail: record?.name ?? "",
    sclad_qty_in: record?.kilkist_on ?? "",
    sclad_price: record?.price ?? "",
    sclad_invoice_no: record?.rahunok ?? "",
    sclad_unit: record?.unit_measurement ?? "",
    sclad_detail_catno: record?.part_number ?? "",
    sclad_procent: record?.scladNomer ?? "",
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (el) {
      const value = String(val ?? "");
      if (el.tagName === "SELECT" && value) {
        const select = el as HTMLSelectElement;
        if (![...select.options].some(option => option.value === value)) {
          select.add(new Option(id === "sclad_procent" ? value + " (неактивний)" : value, value));
        }
      }
      el.value = value;
    }
  });

  // Оновлюємо стиль select sclad_procent при завантаженні даних
  const procentSelect = document.getElementById(
    "sclad_procent",
  ) as HTMLSelectElement | null;
  if (procentSelect) {
    procentSelect.dataset.selectedWarehouse = record?.scladNomer == null ? "" : String(record.scladNomer);
    const selectedOption = procentSelect.options[procentSelect.selectedIndex];
    if (selectedOption?.dataset.empty === "true") {
      procentSelect.style.backgroundColor = "#ffcccc";
      procentSelect.style.color = "#cc0000";
    } else {
      procentSelect.style.backgroundColor = "";
      procentSelect.style.color = "";
    }
  }

  const shopName=String(record.shops||'').trim(), detailName=String(record.name||'').trim();
  Object.assign(shopEditState,{touched:true,originalName:shopName,currentName:shopName,baseShopId:record.shop_id==null?null:Number(record.shop_id)});
  Object.assign(detailEditState,{touched:true,originalName:detailName,currentName:detailName,baseDetailId:record.detail_id==null?null:Number(record.detail_id)});
  for(const [id,missing] of [['sclad_shop',record.shop_id==null],['sclad_detail',record.detail_id==null]] as const) {
    const field=document.getElementById(id);if(field)field.title=missing?'Назву не знайдено у довіднику. Перевірте перед записом.':'';
  }
  const employee=document.getElementById('sclad_zapchastyst_pib') as HTMLInputElement|null;
  if(employee) { employee.value=record.employee_name||''; employee.dataset.slyusarId=record.xto_zamovuv == null ? '' : String(record.xto_zamovuv); }
  updateScladTotal();

}

/** A local derived value, never part of a stock write or its original baseline. */
function updateScladTotal(): void {
  const total = document.getElementById('sclad_sum') as HTMLInputElement | null;
  if (!total) return;
  const number = (id: string) => {
    const value = (document.getElementById(id) as HTMLInputElement | null)?.value.trim();
    return value ? Number(value.replace(/\s/g, '').replace(',', '.')) : NaN;
  };
  const qty = number('sclad_qty_in'), price = number('sclad_price');
  const amount = qty * price;
  total.value = Number.isFinite(amount) ? String(Math.round((amount + Number.EPSILON) * 100) / 100) : '';
}

type StockCandidate = { sclad_id: number; part_number: string; name: string; shops?: string; kilkist_on?: number; price?: number; rahunok?: string };
type StockLookupPage = { rows: StockCandidate[]; hasMore: boolean };
type StockLookupSide = 'catalog' | 'detail';
const stockLookupBindings = new WeakMap<HTMLInputElement, AbortSignal>();

/** Both inputs share selection ownership; a click in one cannot cancel the other's result. */
function wireStockAutocompletes(detailInputId = 'sclad_detail', detailDropdownId = 'sclad_detail_dd'): void {
  const detailInput = document.getElementById(detailInputId) as HTMLInputElement | null;
  const catalogInput = document.getElementById('sclad_detail_catno') as HTMLInputElement | null;
  const controls = {
    catalog: { input: catalogInput, dropdown: document.getElementById('sclad_part_dd') as HTMLDivElement | null },
    detail: { input: detailInput, dropdown: document.getElementById(detailDropdownId) as HTMLDivElement | null },
  };
  const anchor = detailInput || catalogInput;
  const signal = formController.signal;
  if (!anchor || stockLookupBindings.get(anchor) === signal) return;
  stockLookupBindings.set(anchor, signal);
  let generation = 0, applying = false, focusing = false;
  let active: StockLookupSide | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let linked: { source: StockLookupSide; value: string; scope: string } | null = null;
  const pages = new Map<string, Promise<StockLookupPage>>();
  const positions = new Map<string, Promise<any>>();
  const moreHandlers: Partial<Record<StockLookupSide, () => void>> = {};
  const col = (side: StockLookupSide) => side === 'catalog' ? 'part_number' : 'name';
  const opposite = (side: StockLookupSide): StockLookupSide => side === 'catalog' ? 'detail' : 'catalog';
  const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
  const same = (a: string, b: string) => a.toLocaleLowerCase('uk-UA') === b.toLocaleLowerCase('uk-UA');
  const valid = (token: number, scope: string) => token === generation && !signal.aborted && anchor.isConnected && scope === formScope();
  const hide = () => {
    clearTimeout(timer); active = null;
    for (const control of Object.values(controls)) control.dropdown?.classList.add('hidden-all_other_bases');
  };
  const cancel = () => { generation++; applying = false; hide(); };
  const remember = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = load(); cache.set(key, pending);
    if (cache.size > 60) cache.delete(cache.keys().next().value!);
    void pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
  const capture = () => Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id^="sclad_"],select[id^="sclad_"]'))
    .filter(field => field.id !== 'sclad_sum')
    .map(field => ({ field, value: field.value, employee: field.dataset.slyusarId }));
  const unchanged = (snapshot: ReturnType<typeof capture>) => snapshot.every(({ field, value, employee }) => field.isConnected && field.value === value && field.dataset.slyusarId === employee);

  function loadStock(side: StockLookupSide, query: string, offset: number, exact = false,
    constraint: typeof linked = null): Promise<StockLookupPage> {
    const key = JSON.stringify([formScope(), side, query, offset, exact, constraint]);
    return remember(pages, key, async () => {
      let request = supabase.from('sclad').select('sclad_id,part_number,name,shops,kilkist_on,price,rahunok');
      if (constraint) request = request.ilike(col(constraint.source), escapeLike(constraint.value));
      if (query || !constraint) request = request.ilike(col(side), exact ? escapeLike(query) : '%' + escapeLike(query) + '%');
      const { data, error } = await request.order('sclad_id', { ascending: false }).range(offset, offset + 20);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Некоректні підказки складу');
      return { rows: data.slice(0, 20) as StockCandidate[], hasMore: data.length > 20 };
    });
  }

  function display(side: StockLookupSide): HTMLDivElement | null {
    hide(); active = side;
    delete moreHandlers[side];
    const { input, dropdown } = controls[side];
    if (!input || !dropdown) return null;
    dropdown.replaceChildren(); dropdown.classList.remove('hidden-all_other_bases');
    dropdown.style.minWidth = `${input.getBoundingClientRect().width}px`;
    dropdown.style.maxHeight = '300px'; dropdown.style.overflowY = 'auto';
    return dropdown;
  }
  function message(side: StockLookupSide, text: string): void {
    const dd = display(side); if (dd) dd.textContent = text;
  }
  function option(dd: HTMLElement, title: string, description: string, choose: () => void): void {
    const item = document.createElement('div'); item.className = 'custom-dropdown-item';
    const heading = document.createElement('div'); heading.textContent = title; heading.style.cssText = 'font-weight:600;color:#333';
    item.appendChild(heading);
    if (description) { const text = document.createElement('div'); text.textContent = description; text.style.cssText = 'font-size:11px;color:#666;margin-top:3px'; item.appendChild(text); }
    item.addEventListener('pointerdown', event => event.preventDefault());
    item.addEventListener('mousedown', event => event.preventDefault());
    let selected = false;
    item.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (selected || signal.aborted || !dd.contains(item)) return;
      selected = true; choose();
    });
    item.addEventListener('mouseenter', () => {
      for (const other of Array.from(dd.querySelectorAll('.custom-dropdown-item'))) other.classList.toggle('selected', other === item);
    });
    dd.appendChild(item);
  }
  function addMore(side: StockLookupSide, dd: HTMLElement, hasMore: boolean, next: () => Promise<void>): void {
    delete moreHandlers[side]; if (!hasMore) return;
    const more = document.createElement('button'); more.type = 'button'; more.textContent = 'Ще…';
    let busy = false;
    const load = () => { if (busy || active !== side || signal.aborted) return; busy = true; more.disabled = true; void next().finally(() => { busy = false; more.disabled = false; }); };
    more.addEventListener('pointerdown', event => event.preventDefault());
    more.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); load(); });
    dd.appendChild(more); moreHandlers[side] = load;
  }

  async function selectPosition(row: StockCandidate, side: StockLookupSide): Promise<void> {
    const token = ++generation, scope = formScope(), mode = CRUD;
    clearAllScladIds(); hide(); applying = true;
    const selectionRevision = stockSelectionRevision;
    if (catalogInput) catalogInput.value = row.part_number || '';
    if (detailInput) detailInput.value = row.name || '';
    const snapshot = capture();
    try {
      const key = JSON.stringify([scope, row.sclad_id]);
      const fresh = await remember(positions, key, async () => {
        const { data, error } = await supabase.rpc('traffic_stock_position', { p_id: row.sclad_id });
        if (error) throw error;
        if (!data || String(data.sclad_id) !== String(row.sclad_id)) throw new Error('Позицію не знайдено');
        return data;
      });
      if (!valid(token, scope) || selectionRevision !== stockSelectionRevision || CRUD !== mode || !unchanged(snapshot)) return;
      linked = null;
      await fillFormFieldsFromSclad(fresh); updateScladTotal(); snapshotToAllBd();
    } catch {
      if (valid(token, scope) && selectionRevision === stockSelectionRevision && CRUD === mode && unchanged(snapshot)) message(side, 'Не вдалося завантажити позицію. Повторіть вибір перед записом.');
    } finally { if (token === generation) applying = false; }
  }

  function renderStock(side: StockLookupSide, page: StockLookupPage, token: number, scope: string,
    selectSource: boolean, next: () => Promise<void>): void {
    if (!valid(token, scope)) return;
    const dd = display(side); if (!dd) return;
    if (!page.rows.length) { dd.textContent = 'Позицій не знайдено. Можна ввести нові дані.'; return; }
    const seen = new Set<string>();
    for (const row of page.rows) {
      const value = String(row[col(side)] || '');
      if (selectSource && seen.has(value)) continue;
      seen.add(value);
      const label = value || (side === 'catalog' ? 'Без каталожного номера' : 'Без назви');
      const description = [String(row[col(opposite(side))] || ''), row.shops || '', `${row.price ?? 0} грн`, `к-ть: ${row.kilkist_on ?? 0}`, row.rahunok ? `Рахунок: ${row.rahunok}` : ''].filter(Boolean).join(' · ');
      option(dd, label, description, () => {
        if (!valid(token, scope)) return;
        if (selectSource) void chooseSource(side, value, !page.hasMore ? page.rows.filter(candidate => same(String(candidate[col(side)] || ''), value)) : undefined);
        else void selectPosition(row, side);
      });
    }
    addMore(side, dd, page.hasMore, next);
  }

  async function showStock(side: StockLookupSide, query: string, token: number, scope: string,
    constraint: typeof linked, offset = 0, prior: StockCandidate[] = []): Promise<void> {
    try {
      const page = await loadStock(side, query, offset, false, constraint);
      if (!valid(token, scope) || controls[side].input?.value.trim() !== query) return;
      const combined = { rows: [...prior, ...page.rows], hasMore: page.hasMore };
      renderStock(side, combined, token, scope, !constraint, () => showStock(side, query, token, scope, constraint, offset + 20, combined.rows));
    } catch { if (valid(token, scope)) message(side, 'Не вдалося завантажити підказки. Натисніть поле для повтору.'); }
  }

  async function chooseSource(side: StockLookupSide, value: string, completeRows?: StockCandidate[]): Promise<void> {
    const token = ++generation, scope = formScope(), mode = CRUD;
    clearAllScladIds(); hide(); applying = true;
    const selectionRevision = stockSelectionRevision;
    const source = controls[side].input, targetSide = opposite(side), target = controls[targetSide].input;
    if (source) source.value = value;
    if (target) target.value = '';
    // An unresolved choice must not be saved with the previous receipt's values.
    for (const id of ['sclad_shop', 'sclad_qty_in', 'sclad_price', 'sclad_invoice_no']) {
      const field = document.getElementById(id) as HTMLInputElement | null;
      if (field) field.value = '';
    }
    resetShopState(); updateScladTotal();
    if (side === 'detail') Object.assign(detailEditState, { originalName: value, currentName: value, baseDetailId: null, touched: true });
    else resetDetailState();
    snapshotToAllBd();
    const snapshot = capture();
    try {
      const page = completeRows ? { rows: completeRows, hasMore: false } : await loadStock(side, value, 0, true);
      if (!valid(token, scope) || selectionRevision !== stockSelectionRevision || CRUD !== mode || !unchanged(snapshot)) return;
      applying = false;
      if (page.rows.length === 1 && !page.hasMore) { await selectPosition(page.rows[0], side); return; }
      if (!page.rows.length) { linked = null; return; }
      linked = { source: side, value, scope };
      const constraint = linked;
      // These rows already answer the empty constrained counterpart query.
      const key = JSON.stringify([scope, targetSide, '', 0, false, constraint]);
      pages.set(key, Promise.resolve(page));
      renderStock(targetSide, page, token, scope, false, () => showStock(targetSide, '', token, scope, constraint, 20, page.rows));
      focusing = true; target?.focus?.(); focusing = false;
    } catch { if (valid(token, scope) && selectionRevision === stockSelectionRevision && CRUD === mode && unchanged(snapshot)) message(side, 'Не вдалося знайти пов’язані позиції. Повторіть вибір.'); }
    finally { if (token === generation) applying = false; }
  }

  function search(side: StockLookupSide, debounce: boolean, focusOnly = false): void {
    if (focusing || (focusOnly && applying)) return;
    const input = controls[side].input;
    if (!input) return;
    const token = ++generation, scope = formScope(), query = input.value.trim();
    applying = false; hide();
    if (linked?.scope !== scope) linked = null;
    if (side === linked?.source && input.value !== linked.value) linked = null;
    const constraint = linked && linked.source !== side ? linked : null;
    const run = () => {
      if (!valid(token, scope)) return;
      if (side === 'catalog' && !query && !constraint) return;
      void showStock(side, query, token, scope, constraint);
    };
    if (debounce) timer = setTimeout(run, 250); else run();
  }

  for (const side of ['catalog', 'detail'] as const) {
    const { input, dropdown } = controls[side]; if (!input || !dropdown) continue;
    setupDropdownKeyboard(input, dropdown);
    input.addEventListener('input', () => {
      if (side === 'detail') {
        if (!detailEditState.touched) { detailEditState.originalName = null; detailEditState.baseDetailId = null; }
        detailEditState.currentName = input.value.trim(); detailEditState.touched = true;
      }
      if (!input.value.trim() && CRUD === 'Додати') clearAllScladIds();
      search(side, true);
    }, { signal });
    input.addEventListener('focus', () => search(side, false, true), { signal });
    input.addEventListener('click', () => search(side, false), { signal });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); }, { signal });
    dropdown.addEventListener('scroll', () => {
      if (active === side && dropdown.scrollHeight > dropdown.clientHeight && dropdown.scrollHeight - dropdown.scrollTop - dropdown.clientHeight < 48) moreHandlers[side]?.();
    }, { signal });
  }
  document.addEventListener('click', event => {
    if (Object.values(controls).some(({ input, dropdown }) => event.target === input || dropdown?.contains(event.target as Node))) return;
    // A selection may be loading while keyboard navigation focuses another field.
    // Keep its value guards; merely closing a menu is not a changed draft.
    hide(); if (!applying) generation++;
  }, { signal });
  signal.addEventListener('abort', () => { cancel(); pages.clear(); positions.clear(); }, { once: true });
}

async function wireDetailsAutocompleteWithLiveLoad(inputId: string, dropdownId: string) {
  wireStockAutocompletes(inputId, dropdownId);
}

async function wireLinkedAutocomplete() {
  wireStockAutocompletes();
}

function pick(id: string) {
  const el = document.getElementById(id) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  return el ? el.value : "";
}

function snapshotToAllBd() {
  const payload = {
    table: "sclad",
    sclad_id: getCurrentScladId(),
    data: {
      Дата: pick("sclad_date"),
      Магазин: pick("sclad_shop"),
      "Рахунок №": pick("sclad_invoice_no"),
      Деталь: pick("sclad_detail"),
      "Каталог номер деталі": pick("sclad_detail_catno"),
      "Кі-ть надходження": pick("sclad_qty_in"),
      Ціна: pick("sclad_price"),
      Найменування: pick("sclad_unit"),
    },
  };
  updateAllBd(JSON.stringify(payload, null, 2));
}

export function clearScladForm() {
  clearAllScladIds();

  const formFields = [
    "sclad_date",
    "sclad_shop",
    "sclad_detail_catno",
    "sclad_detail",
    "sclad_qty_in",
    "sclad_price",
    "sclad_invoice_no",
    "sclad_unit",
  ];

  formFields.forEach((id) => {
    const el = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (el) el.value = "";
  });

  resetShopState();
  resetDetailState();
  updateScladTotal();

  snapshotToAllBd();
}

export const handleScladClick = async () => {
  await renderScladForm();
};

export const initScladMagasunDetal = () => {};
