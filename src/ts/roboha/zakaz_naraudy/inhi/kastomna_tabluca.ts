import { loadEditorReferences } from "../globalCache";
import { readEditorOwnerNames } from "../editorOwnerNames";
import { showNotification } from "./vspluvauhe_povidomlenna";
//src\ts\roboha\zakaz_naraudy\inhi\kastomna_tabluca.ts
import {
  globalCache,
  ensureSkladIdsLoaded,
  resolveScladItemByPart,
  searchSkladNames,
  searchSkladCatalog,
  normalizeCatalogSearchKey,
  ACT_ITEMS_TABLE_CONTAINER_ID,
} from "../globalCache";
import { supabase } from "../../../vxid/supabaseClient";
import {
  updateCatalogWarningForRow,
  updatePriceWarningForRow,
} from "./kastomna_tabluca_poperedhennya";
export {
  refreshQtyWarningsIn,
  initializeActWarnings,
  resetActDataCache,
} from "./kastomna_tabluca_poperedhennya";
import {
  getUserNameFromLocalStorage,
  getUserAccessLevelFromLocalStorage,
} from "../modalMain";
import { calculateRowSum } from "../modalUI";
import {
  handleItemSelection,
  setupPriceConfirmationHandler,
} from "../../ai/aiPriceHelper";

/* ====================== настройки ====================== */
const LIVE_WARNINGS = false;
let autocompleteRequestVersion = 0;
const NAME_AUTOCOMPLETE_MIN_CHARS = 3; // До трьох символів запит назв не виконується
const NAME_AUTOCOMPLETE_MAX_RESULTS = 50; // максимум результатів

function matchesCatalogSearch(value: unknown, query: string): boolean {
  const rawValue = String(value ?? "").trim().toLocaleLowerCase("uk-UA");
  const rawQuery = query.trim().toLocaleLowerCase("uk-UA");
  if (!rawQuery) return false;
  if (rawValue.includes(rawQuery)) return true;

  const normalizedQuery = normalizeCatalogSearchKey(rawQuery);
  return (
    normalizedQuery.length > 0 &&
    normalizeCatalogSearchKey(rawValue).includes(normalizedQuery)
  );
}

// Кеш для відсотків по складах: Map<scladNomer, procent>
// procent може бути: number (нормальний відсоток), -1 (заблокований), null (відсутній)
let warehousePercentsCache: Map<number, number | null> = new Map();
let warehousePercentsCacheLoaded = false;

/** Статус відсотка складу */
export interface WarehousePercentStatus {
  percent: number;
  status: "normal" | "blocked" | "missing";
  basePrice: number;
}

/** Завантажити всі відсотки складів з бази даних settings */
export async function loadWarehousePercents(): Promise<void> {
  if (warehousePercentsCacheLoaded) return;

  try {
    // Завантажуємо setting_id 1..500 для відсотків складів
    const { data, error } = await supabase
      .from("settings")
      .select("setting_id, procent")
      .gte("setting_id", 1)
      .lte("setting_id", 500);

    if (error) throw error;

    warehousePercentsCache.clear();
    if (data) {
      for (const row of data) {
        warehousePercentsCache.set(row.setting_id, row.procent);
      }
    }
    warehousePercentsCacheLoaded = true;
  } catch (err) {
    // console.error("Помилка завантаження відсотків складів:", err);
  }
}

/** Отримати відсоток для конкретного складу */
export async function loadPercentByWarehouse(
  scladNomer: number | null | undefined,
): Promise<WarehousePercentStatus> {
  await loadWarehousePercents();

  // Якщо склад не вказаний — використовуємо склад 1
  const warehouseId =
    scladNomer !== null && scladNomer !== undefined && scladNomer > 0
      ? scladNomer
      : 1;
  const procent = warehousePercentsCache.get(warehouseId);

  if (procent === -1) {
    // Заблокований склад
    return { percent: 0, status: "blocked", basePrice: 0 };
  } else if (procent === null || procent === undefined) {
    // Відсутній склад — націнка 0%
    return { percent: 0, status: "missing", basePrice: 0 };
  } else {
    // Нормальний відсоток
    return { percent: procent, status: "normal", basePrice: 0 };
  }
}

/** Стара функція для сумісності — завантажує відсоток з складу 1 */
export async function loadPercentFromSettings(): Promise<number> {
  const result = await loadPercentByWarehouse(1);
  return result.percent;
}

/** Скинути кеш відсотку (викликати після збереження налаштувань) */
export function resetPercentCache(): void {
  warehousePercentsCache.clear();
  warehousePercentsCacheLoaded = false;
}

/**
 * ✅ ВИПРАВЛЕНО: Отримує підказки для назви з globalCache та skladParts
 * Показуєwork_id для робіт та part_number, кількість, ціну, дату для деталей
 */
async function getNameSuggestions(query: string): Promise<Suggest[]> {
  const q = query.trim().toLowerCase();

  if (q.length < NAME_AUTOCOMPLETE_MIN_CHARS) {
    return [];
  }

  const [, stockMatches] = await Promise.all([loadEditorReferences({query:q}), searchSkladNames(q)]);
  const filteredSkladParts = stockMatches
    .map((p) => {
      const qty = Number(p.quantity) || 0;
      const price = Math.round(Number(p.price) || 0);
      const priceRounded = formatUA(price);

      // Форматування дати
      const timeOn = p.time_on
        ? new Date(p.time_on).toLocaleDateString("uk-UA")
        : "";

      // Колір для кількості та всієї інформації в дужках
      let colorStyle = "";
      // Якщо статус "Замовити" або "Замовлено" - сірий (деталі ще не прибули)
      if (p.statys === "Замовити" || p.statys === "Замовлено")
        colorStyle = "color: #888"; // сіра
      else if (qty === 0)
        colorStyle = "color: #888"; // сіра
      else if (qty < 0)
        colorStyle = "color: #e40b0b"; // червона
      else colorStyle = "color: #28a745"; // зелена

      // ✅ НОВИЙ ПОРЯДОК: Назва (синя) - Номер (чорний підкреслений) (К-ть і ціна) Дата
      const skladTag =
        p.scladNomer !== null && p.scladNomer !== undefined
          ? ` <span style="color: #1565c0; font-weight: normal;">(${p.scladNomer}-Склад)</span>`
          : "";
      // Статус (Замовити - червоний, Замовлено - синій)
      const statysTag =
        p.statys === "Замовити"
          ? ` <span style="color: #ff0000; font-weight: bold; text-decoration: underline;">Замовити</span>`
          : p.statys === "Замовлено"
            ? ` <span style="color: #0000ff; font-weight: bold; text-decoration: underline;">Замовлено</span>`
            : "";
      const labelHtml = `<span style="color: #1565c0">${p.name}</span> - <span style="color: #000; font-weight: normal; text-decoration: underline;">${p.part_number}</span> <span style="${colorStyle}; font-weight: bold;">(К-ть: ${qty} по ${priceRounded}-грн)</span>${skladTag}${statysTag}${timeOn ? ' <span style="color: #000; font-weight: normal;">' + timeOn + "</span>" : ""}`;

      return {
        value: p.name,
        sclad_id: p.sclad_id,
        label: `${p.name} - ${p.part_number} (К-ть: ${qty} ціна ${priceRounded} - грн)${timeOn ? " " + timeOn : ""}`,
        labelHtml: labelHtml,
        fullName: p.name,
        itemType: "detail" as const,
      };
    });

  // Фільтруємо деталі з бази даних details (пошук по назві)
  const filteredDetails = globalCache.details
    .filter((name) => name.toLowerCase().includes(q))
    .slice(0, NAME_AUTOCOMPLETE_MAX_RESULTS)
    .map((name) => ({
      label: name,
      value: name,
      fullName: name,
      itemType: "detail" as const,
      labelHtml: `<span style="color: #1565c0">${name}</span>`,
    }));

  // Фільтруємо роботи з worksWithId (пошук по work_id або name)
  const filteredWorks = globalCache.worksWithId
    .filter(
      (w) =>
        w.work_id.toLowerCase().includes(q) ||
        (w.name && w.name.toLowerCase().includes(q)),
    )
    .slice(0, NAME_AUTOCOMPLETE_MAX_RESULTS)
    .map((w) => ({
      label: `${w.work_id} - ${w.name}`,
      value: w.name,
      fullName: w.name,
      itemType: "work" as const,
    }));

  // Повертаємо в порядку: sclad (зверху), details (посередині), works (внизу)
  return [...filteredSkladParts, ...filteredDetails, ...filteredWorks];
}

/* ====================== helpers ====================== */

/** ---------- AUTO-FOLLOW helpers (для списку підказок) ---------- */
function isScrollable(el: Element): boolean {
  const s = getComputedStyle(el as HTMLElement);
  return /(auto|scroll|overlay)/.test(s.overflow + s.overflowY + s.overflowX);
}
function getScrollableAncestors(el: HTMLElement): HTMLElement[] {
  const res: HTMLElement[] = [];
  let p = el.parentElement;
  while (p) {
    if (isScrollable(p)) res.push(p);
    p = p.parentElement;
  }
  return res;
}

let _repositionCleanup: (() => void) | null = null;

function startAutoFollow(
  target: HTMLElement,
  list: HTMLElement,
  positionFn: () => void,
) {
  _repositionCleanup?.();

  const parents = getScrollableAncestors(target);
  const onScroll = () => positionFn();
  const onResize = () => positionFn();

  const ro = new ResizeObserver(positionFn);
  ro.observe(document.documentElement);
  ro.observe(list);

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  parents.forEach((p) =>
    p.addEventListener("scroll", onScroll, { passive: true }),
  );

  const mo = new MutationObserver(() => {
    if (!document.body.contains(target) || !document.body.contains(list)) {
      cleanup();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  function cleanup() {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    parents.forEach((p) => p.removeEventListener("scroll", onScroll));
    ro.disconnect();
    mo.disconnect();
  }

  _repositionCleanup = cleanup;
}

function stopAutoFollow() {
  _repositionCleanup?.();
  _repositionCleanup = null;
}

/** ---------- стилі списку ---------- */
function ensureAutocompleteStyles() {
  if (document.getElementById("autocomplete-styles")) return;
  const css = `
    .catalog-info-popover {
      position: absolute;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 8px 12px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      font-size: 14px;
      line-height: 1.2;
      color: #222;
      z-index: 100000;
    }
    .autocomplete-list {
      position: absolute;
      background: #f1f5ff;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 4px 0;
      box-shadow: 0 6px 18px rgba(0,0,0,0.15);
      font-size: 14px;
      z-index: 100000;
      overflow-y: auto;
      max-width: 880px;
      box-sizing: border-box;
    }
    .autocomplete-item { padding: 6px 10px; cursor: pointer; }
    .autocomplete-item:focus, .autocomplete-item:hover { background: #e0e7ff; outline: none; }
    .autocomplete-item.negative { color: #e40b0b; }
    .autocomplete-item.neutral { color: #888; }
    .autocomplete-item.positive { color: #2e7d32; }
    .editable-autocomplete { transition: box-shadow 120ms ease; }
    /* Styles for Catalog specific items */
    .autocomplete-item.item-work-cat { color: #2e7d32; } /* Green */
    .autocomplete-item.item-detail-cat { color: #1565c0; } /* Blue */
    /* Підсвічування поточного значення в списку */
    .autocomplete-item.active-suggestion { background: #cce8ff !important; border-left: 3px solid #1976d2; padding-left: 7px; }
  `;
  const tag = document.createElement("style");
  tag.id = "autocomplete-styles";
  tag.textContent = css;
  document.head.appendChild(tag);
}

function formatUA(n: number) {
  return new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 3 }).format(n);
}

function roundToKopiyky(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** ---------- робота з назвами ---------- */

/**
 * Скорочує текст: показує перше речення до першої крапки і останнє речення після останньої крапки.
 * Якщо речень менше 3, повертає оригінал.
 * @param fullText - повний текст
 * @returns скорочений текст з ".....". між першим і останнім реченнями
 */
export function shortenTextToFirstAndLast(fullText: string): string {
  if (!fullText) return fullText;

  // Розбиваємо на речення по крапці
  // Шукаємо крапку за якою йде пробіл та велика літера (або кінець тексту)
  const sentences = fullText
    .split(/\.(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Якщо менше 3 речень - не скорочуємо
  if (sentences.length < 3) return fullText;

  const firstSentence = sentences[0];
  const lastSentence = sentences[sentences.length - 1];

  // Додаємо крапку після першого речення та перед крапками
  return `${firstSentence}.....${lastSentence}`;
}

/**
 * Розгортає скорочену назву назад до повної з кеша globalCache
 */
function expandName(shortenedName: string): string {
  if (!shortenedName || !shortenedName.includes(".....")) return shortenedName;

  const allNames = [...globalCache.details, ...globalCache.works];
  const [firstPart, lastPart] = shortenedName.split(".....");

  const fullName = allNames.find((name) => {
    // Розбиваємо на речення таким же чином як при скороченні
    const sentences = name
      .split(/\.(?:\s+|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (sentences.length < 2) return false;
    const firstSentence = sentences[0];
    const lastSentence = sentences[sentences.length - 1];
    return firstSentence === firstPart && lastSentence === lastPart;
  });

  return fullName || shortenedName;
}

/**
 * Розгортає всі скорочені назви в таблиці і зберігає оригінальні значення.
 * Використовується для PDF генерації.
 * Спочатку перевіряє data-full-name атрибут, потім намагається розгорнути через кеш.
 */
export function expandAllNamesInTable(): Map<HTMLElement, string> {
  const originalTexts = new Map<HTMLElement, string>();
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return originalTexts;

  const nameCells =
    container.querySelectorAll<HTMLElement>('[data-name="name"]');

  nameCells.forEach((cell) => {
    const currentText = cell.textContent?.trim() || "";
    originalTexts.set(cell, currentText);

    // Спочатку перевіряємо data-full-name атрибут
    const fullNameAttr = cell.getAttribute("data-full-name");
    if (fullNameAttr) {
      cell.textContent = fullNameAttr;
    } else if (currentText.includes(".....")) {
      // Якщо немає атрибута, намагаємося розгорнути через кеш
      cell.textContent = expandName(currentText);
    }
  });

  return originalTexts;
}

/**
 * Відновлює скорочені назви після PDF генерації
 */
export function restoreOriginalNames(
  originalTexts: Map<HTMLElement, string>,
): void {
  originalTexts.forEach((originalText, cell) => {
    cell.textContent = originalText;
  });
}

/** ---------- підрахунки ---------- */
function setCellText(cell: HTMLElement | null, text: string) {
  if (!cell) return;
  cell.textContent = text;
  cell.dispatchEvent(new Event("input", { bubbles: true }));
}
function parseNum(text: string | null | undefined) {
  return parseFloat((text || "0").replace(/\s/g, "").replace(",", ".")) || 0;
}

function getRowSum(row: HTMLElement) {
  const priceEl = row.querySelector(
    '[data-name="price"]',
  ) as HTMLElement | null;
  const qtyEl = row.querySelector(
    '[data-name="id_count"]',
  ) as HTMLElement | null;
  const price = parseNum(priceEl?.textContent);
  const qty = parseNum(qtyEl?.textContent);
  return roundToKopiyky(price * qty);
}
function recalcRowSum(row: HTMLElement) {
  const sumEl = row.querySelector('[data-name="sum"]') as HTMLElement | null;
  const sum = getRowSum(row);
  if (sumEl) sumEl.textContent = sum === 0 ? "" : formatUA(sum);

  if (!globalCache.isActClosed) {
    updatePriceWarningForRow(row);
    if (LIVE_WARNINGS && globalCache.settings.showCatalog) {
      updateCatalogWarningForRow(row);
    }
  }
}

/** ---------- info popover під Каталог (тільки hover) ---------- */
let currentCatalogInfo: HTMLElement | null = null;
let currentCatalogInfoAnchor: HTMLElement | null = null;

function removeCatalogInfo() {
  currentCatalogInfo?.remove();
  currentCatalogInfo = null;
  currentCatalogInfoAnchor = null;
  window.removeEventListener("scroll", handleScrollForCatalogInfo);
}
function handleScrollForCatalogInfo() {
  if (!currentCatalogInfo || !currentCatalogInfoAnchor) {
    removeCatalogInfo();
    return;
  }
  const rect = currentCatalogInfoAnchor.getBoundingClientRect();
  currentCatalogInfo.style.top = `${rect.bottom + window.scrollY}px`;
  currentCatalogInfo.style.left = `${rect.left + window.scrollX}px`;
}
function showCatalogInfo(target: HTMLElement, sclad_id: number) {
  if (currentAutocompleteList) return;

  ensureAutocompleteStyles();
  removeCatalogInfo();
  const picked = globalCache.skladParts.find((p) => p.sclad_id === sclad_id);
  if (!picked) return;

  const qty = Number(picked.quantity);
  const qtyHtml =
    qty < 0
      ? `<span class="neg">${qty}</span>`
      : qty === 0
        ? `<span class="neutral">${qty}</span>`
        : `<span class="positive">${qty}</span>`;

  const box = document.createElement("div");
  box.className = "catalog-info-popover";

  box.innerHTML = `К-ть: ${qtyHtml} по ${formatUA(Math.round(picked.price))}`;

  const rect = target.getBoundingClientRect();
  box.style.top = `${rect.bottom + window.scrollY}px`;
  box.style.left = `${rect.left + window.scrollX}px`;
  box.style.minWidth = `${rect.width}px`;
  document.body.appendChild(box);

  currentCatalogInfo = box;
  currentCatalogInfoAnchor = target;
  window.addEventListener("scroll", handleScrollForCatalogInfo);
}

/* ======== AUTOCOMPLETE state & utils ======== */
type Suggest = {
  label: string;
  value: string;
  sclad_id?: number;
  labelHtml?: string;
  fullName?: string;
  itemType?: "detail" | "work";
};

let currentAutocompleteInput: HTMLElement | null = null;
let currentAutocompleteList: HTMLElement | null = null;
let selectedOwnerInput: HTMLElement | null = null;

function closeAutocompleteList() {
  document.querySelector(".autocomplete-list")?.remove();
  stopAutoFollow();
  if (currentAutocompleteInput) {
    currentAutocompleteInput.classList.remove("ac-open");
    // Ensure we don't clear content if it was a valid selection, but here we just close list.
    // Logic for returning focus is below.
    if (
      document.activeElement &&
      document.activeElement.closest(".autocomplete-list")
    ) {
      currentAutocompleteInput.focus();
    }
  }
  currentAutocompleteList = null;
  currentAutocompleteInput = null;
}

/** ---------- рендер списку підказок (з автослідуванням) ---------- */
function renderAutocompleteList(target: HTMLElement, suggestions: Suggest[]) {
  ensureAutocompleteStyles();
  closeAutocompleteList();
  if (!suggestions.length) return;

  // Поточне значення поля для підсвічування збігу
  const currentTargetValue = (
    target.getAttribute("data-full-name") ||
    target.textContent ||
    ""
  )
    .trim()
    .toLowerCase();
  const currentScladIdAttr =
    target.getAttribute("data-sclad-id") ||
    target
      .closest("tr")
      ?.querySelector('[data-name="catalog"]')
      ?.getAttribute("data-sclad-id");
  const targetScladId = currentScladIdAttr
    ? Number(currentScladIdAttr)
    : undefined;

  const GAP = 4;
  const ROWS_MAX = 15;

  target.classList.add("ac-open");

  const list = document.createElement("ul");
  list.className = "autocomplete-list";
  list.style.position = "absolute";
  list.style.visibility = "hidden";
  list.style.zIndex = "100000";

  let activeItem: HTMLElement | null = null;

  suggestions.forEach((s) => {
    const { label, value, sclad_id, labelHtml, fullName, itemType } = s;
    const li = document.createElement("li");
    li.className = "autocomplete-item";

    if (itemType === "detail") li.classList.add("item-detail");
    if (itemType === "work") li.classList.add("item-work");
    // Special classes for Catalog dropdown colors
    if (itemType === "work") li.classList.add("item-work-cat");
    if (itemType === "detail") li.classList.add("item-detail-cat");

    // Підсвічуємо рядок, який відповідає поточній вибраній деталі (або за sclad_id, або за текстом)
    let isActive = false;

    // Пріоритетно перевіряємо sclad_id. Якщо він є у ячейці, шукаємо СУВОРО такий саме sclad_id
    if (
      targetScladId !== undefined &&
      !Number.isNaN(targetScladId) &&
      targetScladId > 0
    ) {
      if (sclad_id === targetScladId) {
        isActive = true;
      }
    } else {
      // Якщо sclad_id немає в комірці (наприклад, це робота або нова деталь),
      // підсвічуємо по тексту ТІЛЬКИ якщо підказка НЕ зі складу
      // Це запобігає масовому підсвічуванню всіх деталей з однаковою назвою
      if (sclad_id === undefined && currentTargetValue && value) {
        if (value.trim().toLowerCase() === currentTargetValue) {
          isActive = true;
        }
      }
    }

    if (isActive) {
      li.classList.add("active-suggestion");
      activeItem = li;
    }

    li.tabIndex = 0;
    li.dataset.value = value;
    if (sclad_id !== undefined) li.dataset.scladId = String(sclad_id);
    if (fullName) li.dataset.fullName = fullName;
    if (itemType) li.dataset.itemType = itemType;

    const m = label.match(/К-ть:\s*(-?\d+)/);
    if (m) {
      const qty = parseInt(m[1], 10);
      if (qty < 0) li.classList.add("negative");
      else if (qty === 0) li.classList.add("neutral");
      else li.classList.add("positive");
    }
    if (labelHtml) li.innerHTML = labelHtml;
    else li.textContent = label;

    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // Trigger click logic
        li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      } else if (e.key === "Escape") {
        e.preventDefault();
        const ownerTarget = target.getAttribute("data-name") === "pib_magazin";
        if (ownerTarget) {
          ++autocompleteRequestVersion;
          selectedOwnerInput = target;
          queueMicrotask(() => {
            if (selectedOwnerInput === target) selectedOwnerInput = null;
          });
        }
        try {
          closeAutocompleteList();
          target.focus();
        } finally {
          if (ownerTarget && selectedOwnerInput === target) selectedOwnerInput = null;
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = li.nextElementSibling as HTMLElement;
        if (next) next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = li.previousElementSibling as HTMLElement;
        if (prev) {
          prev.focus();
        } else {
          target.focus();
        }
      }
    });

    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const chosenValue = el.dataset.value || value;
      const chosenScladId = Number(el.dataset.scladId) || undefined;
      const chosenFullName = el.dataset.fullName;
      const chosenItemType = el.dataset.itemType as
        | "detail"
        | "work"
        | undefined;

      const dataName = target.getAttribute("data-name");
      const row = target.closest("tr")!;
      const indexCell = row.querySelector(".row-index");

      // Selecting an owner dispatches input for recalculation, not for reopening
      // the same suggestions. Also cancel any earlier pending owner request.
      if (dataName === "pib_magazin") {
        ++autocompleteRequestVersion;
        selectedOwnerInput = target;
        queueMicrotask(() => {
          if (selectedOwnerInput === target) selectedOwnerInput = null;
        });
      }

      if (dataName === "catalog") {
        target.textContent = chosenValue;

        if (chosenItemType === "work") {
          // Case: Work selected in Catalog
          if (chosenFullName) {
            const nameCell = row.querySelector(
              '[data-name="name"]',
            ) as HTMLElement | null;
            if (nameCell) {
              // ✅ ВИПРАВЛЕНО: Виводимо повну назву замість скороченої
              setCellText(nameCell, chosenFullName);
              nameCell.setAttribute("data-type", "works");
              nameCell.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          // ✅ Маркуємо рядок як роботу
          (row as HTMLElement).setAttribute("data-item-type", "work");
          // Update # to 🛠️
          if (indexCell) {
            const num =
              indexCell.textContent?.replace(/\D/g, "") ||
              (row as HTMLTableRowElement).sectionRowIndex + 1;
            indexCell.textContent = `🛠️ ${num}`;
          }

          // Set pib_magazin to slyusars
          const pibMagCell = row.querySelector(
            '[data-name="pib_magazin"]',
          ) as HTMLElement | null;
          if (pibMagCell) pibMagCell.setAttribute("data-type", "slyusars");
        } else {
          // Case: Detail selected in Catalog (via sclad_id or just type)
          if (chosenScladId !== undefined) {
            applyCatalogSelectionById(target, chosenScladId, chosenFullName, {
              forcePriceUpdate: true,
            });
          }
          // Update # to ⚙️
          if (indexCell) {
            const num =
              indexCell.textContent?.replace(/\D/g, "") ||
              (row as HTMLTableRowElement).sectionRowIndex + 1;
            indexCell.textContent = `⚙️ ${num}`;
          }

          // Set type to details if not set by applyCatalogSelection
          const nameCell = row.querySelector(
            '[data-name="name"]',
          ) as HTMLElement;
          if (nameCell) nameCell.setAttribute("data-type", "details");
          // ✅ Маркуємо рядок як деталь
          (row as HTMLElement).setAttribute("data-item-type", "detail");
        }

        // ✅ Автозаповнення кількості = 1 якщо поле порожнє (вибір через каталог)
        const qtyCellCat = row.querySelector(
          '[data-name="id_count"]',
        ) as HTMLElement | null;
        if (qtyCellCat && !qtyCellCat.textContent?.trim()) {
          qtyCellCat.textContent = "1";
          qtyCellCat.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (dataName === "name") {
        // Suppress next focusin/input trigger
        _suppressAutocomplete = true;

        const fullText = chosenFullName || label;
        // ✅ ВИПРАВЛЕНО: Виводимо повну назву замість скороченої
        target.textContent = fullText;

        // Determine Type
        const rawItemType =
          chosenItemType ||
          (globalCache.details.includes(fullText) ? "detail" : "work");

        const typeToSet = rawItemType === "detail" ? "details" : "works";
        target.setAttribute("data-type", typeToSet);
        // ✅ Маркуємо рядок надійно - для 100% визначення типу при збереженні
        (row as HTMLElement).setAttribute("data-item-type", rawItemType);

        // Update # Emoji
        if (indexCell) {
          const num =
            indexCell.textContent?.replace(/\D/g, "") ||
            (row as HTMLTableRowElement).sectionRowIndex + 1;
          const icon = typeToSet === "works" ? "🛠️" : "⚙️";
          indexCell.textContent = `${icon} ${num}`;
        }

        const pibMagCell = row.querySelector(
          '[data-name="pib_magazin"]',
        ) as HTMLElement | null;

        if (pibMagCell) {
          pibMagCell.setAttribute(
            "data-type",
            typeToSet === "details" ? "shops" : "slyusars",
          );

          if (typeToSet === "works") {
            // Auto-fill Mechanic Name ТІЛЬКИ якщо поле порожнє
            const currentPibValue = pibMagCell.textContent?.trim() || "";
            if (!currentPibValue) {
              const userName = getUserNameFromLocalStorage();
              const userLevel = getUserAccessLevelFromLocalStorage();

              if (userName && userLevel === "Слюсар") {
                pibMagCell.textContent = userName;
              }
              // Якщо не слюсар - залишаємо поле порожнім, НЕ очищаємо якщо вже є значення
            }

            // Auto-fill Catalog with Work ID
            const workObj = globalCache.worksWithId.find(
              (w) => w.name === fullText,
            );
            if (workObj) {
              const catalogCell = row.querySelector(
                '[data-name="catalog"]',
              ) as HTMLElement | null;
              if (catalogCell) {
                setCellText(catalogCell, workObj.work_id);
              }
            }

            // 🤖 AI: Підказка середньої ціни для роботи
            handleItemSelection(row, fullText, "work");
          } else {
            // ✅ ВИПРАВЛЕНО: Якщо вибрано деталь зі складу - підтягуємо всі дані
            if (chosenScladId !== undefined) {
              applyCatalogSelectionById(target, chosenScladId, fullText, {
                forcePriceUpdate: true,
              });
            }
            // НЕ очищаємо pib_magazin якщо вибрано деталь
          }
        }

        // ✅ Автозаповнення кількості = 1 якщо поле порожнє
        const qtyCell = row.querySelector(
          '[data-name="id_count"]',
        ) as HTMLElement | null;
        if (qtyCell && !qtyCell.textContent?.trim()) {
          qtyCell.textContent = "1";
          qtyCell.dispatchEvent(new Event("input", { bubbles: true }));
        }

        (target as any)._fromAutocomplete = true;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.focus();

        setTimeout(() => {
          _suppressAutocomplete = false;
        }, 200);
      } else {
        target.textContent = chosenValue;
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }

      closeAutocompleteList();
      if (selectedOwnerInput === target) selectedOwnerInput = null;
    });

    list.appendChild(li);
  });

  document.body.appendChild(list);

  // Прокручуємо список до підсвіченого елементу після рендеру
  if (activeItem) {
    requestAnimationFrame(() => {
      (activeItem as HTMLElement).scrollIntoView({ block: "nearest" });
    });
  }

  const tr = target.getBoundingClientRect();
  const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;

  const firstLi = list.querySelector("li") as HTMLElement | null;
  const rowH = Math.max(firstLi?.offsetHeight || 0, 28);

  const ls = getComputedStyle(list);
  const padV = parseFloat(ls.paddingTop) + parseFloat(ls.paddingBottom);
  const borderV =
    parseFloat(ls.borderTopWidth) + parseFloat(ls.borderBottomWidth);

  const availableAbove = Math.max(0, tr.top - GAP);
  const rowsFitBySpace = Math.max(
    1,
    Math.floor((availableAbove - padV - borderV) / rowH),
  );
  const rowsToShow = Math.min(ROWS_MAX, rowsFitBySpace, suggestions.length);

  const finalMaxHeight = rowsToShow * rowH + padV + borderV;
  list.style.maxHeight = `${finalMaxHeight}px`;
  list.style.overflowY = rowsToShow < suggestions.length ? "auto" : "hidden";

  const minW = Math.max(tr.width, 200);
  list.style.minWidth = `${minW}px`;

  const effectiveHeight = rowsToShow * rowH + padV + borderV;
  let top = scrollY + tr.top - effectiveHeight - GAP;
  if (top < scrollY) top = scrollY;

  let left = scrollX + tr.left;
  const vw = document.documentElement.clientWidth;
  const listW = Math.max(minW, list.offsetWidth);
  if (left + listW > scrollX + vw - 4)
    left = Math.max(scrollX, scrollX + vw - listW - 4);

  list.style.left = `${left}px`;
  list.style.top = `${top}px`;
  list.style.visibility = "visible";

  currentAutocompleteInput = target;
  currentAutocompleteList = list;

  const reposition = () => {
    if (!document.body.contains(target) || !document.body.contains(list)) {
      closeAutocompleteList();
      return;
    }

    const rect = target.getBoundingClientRect();
    const sX = window.scrollX || document.documentElement.scrollLeft || 0;
    const sY = window.scrollY || document.documentElement.scrollTop || 0;

    const first = list.querySelector("li") as HTMLElement | null;
    const rowH2 = Math.max(first?.offsetHeight || 0, 28);

    const ls2 = getComputedStyle(list);
    const padV2 = parseFloat(ls2.paddingTop) + parseFloat(ls2.paddingBottom);
    const borderV2 =
      parseFloat(ls2.borderTopWidth) + parseFloat(ls2.borderBottomWidth);

    const parents = getScrollableAncestors(target);
    const viewportEl = parents[0] || document.documentElement;
    const vpRect = viewportEl.getBoundingClientRect();

    const availableAbove2 = Math.max(
      0,
      rect.top - Math.max(vpRect.top, 0) - GAP,
    );

    const totalItems = list.children.length;
    const rowsFit = Math.max(
      1,
      Math.floor((availableAbove2 - padV2 - borderV2) / rowH2),
    );
    const rowsToShow2 = Math.min(ROWS_MAX, totalItems, rowsFit);

    const finalMaxH = rowsToShow2 * rowH2 + padV2 + borderV2;
    list.style.maxHeight = `${finalMaxH}px`;
    list.style.overflowY = rowsToShow2 < totalItems ? "auto" : "hidden";

    const effH = rowsToShow2 * rowH2 + padV2 + borderV2;
    let top2 = sY + rect.top - effH - GAP;

    const vpTopAbs = sY + vpRect.top;
    if (top2 < vpTopAbs) top2 = vpTopAbs;

    let left2 = sX + rect.left;
    const vw2 = document.documentElement.clientWidth;
    const listW2 = list.offsetWidth || Math.max(rect.width, 200);
    if (left2 + listW2 > sX + vw2 - 4) {
      left2 = Math.max(sX, sX + vw2 - listW2 - 4);
    }

    list.style.top = `${top2}px`;
    list.style.left = `${left2}px`;

    const fullyOut =
      rect.bottom < Math.max(vpRect.top, 0) ||
      rect.top > vpRect.bottom ||
      rect.right < vpRect.left ||
      rect.left > vpRect.right;

    if (fullyOut) closeAutocompleteList();
  };

  startAutoFollow(target, list, reposition);
}

// Global flag to suppress opening autocomplete immediately after selection
let _suppressAutocomplete = false;

/* ====================== public API ====================== */

export function setupAutocompleteForEditableCells(
  containerId: string,
  cache: typeof globalCache,
  onEnterCallback?: () => void,
) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const showCatalog = globalCache.settings.showCatalog;
  const showPibMagazin = globalCache.settings.showPibMagazin;

  let ownerRequest: {
    target: HTMLElement;
    type: string;
    query: string;
    text: string;
    version: number;
    promise: Promise<void>;
  } | null = null;

  function showOwnerSuggestions(target: HTMLElement, filterText: boolean): Promise<void> {
    if (
      selectedOwnerInput === target ||
      !showPibMagazin || cache.isActClosed || !target.isContentEditable ||
      !target.isConnected || document.activeElement !== target
    ) return Promise.resolve();

    const type = updatePibMagazinDataType(target);
    const text = target.textContent?.trim() || "";
    const query = filterText ? text.toLowerCase() : "";
    if (
      ownerRequest?.target === target && ownerRequest.type === type &&
      ownerRequest.query === query && ownerRequest.text === text &&
      ownerRequest.version === autocompleteRequestVersion
    ) return ownerRequest.promise;

    const request = {
      target, type, query, text,
      version: ++autocompleteRequestVersion,
      promise: Promise.resolve(),
    };
    ownerRequest = request;
    const actId = globalCache.currentActId;
    const accessLevel = getUserAccessLevelFromLocalStorage();
    const userName = getUserNameFromLocalStorage();
    const isCurrent = () =>
      request.version === autocompleteRequestVersion &&
      globalCache.currentActId === actId &&
      target.isConnected && container!.contains(target) &&
      document.activeElement === target && target.isContentEditable &&
      !cache.isActClosed && (target.textContent?.trim() || "") === text &&
      updatePibMagazinDataType(target) === type &&
      getUserAccessLevelFromLocalStorage() === accessLevel &&
      getUserNameFromLocalStorage() === userName;

    request.promise = (async () => {
      try {
        let names: string[];
        if (type === "shops") {
          names = await readEditorOwnerNames("shops");
        } else if (accessLevel === "Слюсар" && userName) {
          names = [userName];
        } else {
          names = await readEditorOwnerNames("slyusars");
        }
        if (!isCurrent()) return;
        const filtered = [...new Set(names)]
          .filter(name => !query || name.toLowerCase().includes(query))
          .sort((a, b) => a.localeCompare(b, "uk", { sensitivity: "base" }));
        const suggestions = (type === "shops" ? filtered.slice(0, 50) : filtered)
          .map(name => ({ label: name, value: name }));
        if (suggestions.length) renderAutocompleteList(target, suggestions);
        else closeAutocompleteList();
      } catch (error) {
        if (isCurrent()) {
          closeAutocompleteList();
          showNotification(
            error instanceof Error && error.message.startsWith("Встановіть SQL-функцію traffic_stock_directory")
              ? error.message
              : type === "shops"
              ? "Не вдалося завантажити магазини. Натисніть на поле, щоб повторити."
              : "Не вдалося завантажити слюсарів. Натисніть на поле, щоб повторити.",
            "error",
          );
        }
      } finally {
        if (ownerRequest === request) ownerRequest = null;
      }
    })();
    return request.promise;
  }

  container.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '.editable-autocomplete[data-name="pib_magazin"]',
    );
    if (!target || !container.contains(target) ||
        (currentAutocompleteInput === target && currentAutocompleteList)) return;
    void showOwnerSuggestions(target, false);
  });

  container.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("editable-autocomplete")) return;

    if (e.key === "Enter") {
      if (currentAutocompleteList) {
        // If list is open, let the user select via Arrow/Enter logic in the list
        // Or if focus is still in input, maybe Enter should select the first item?
        // Currently focus remains in input mostly.
        // If user pressed ArrowDown, focus moved to list.

        // If focus is in input and list is open:
        if (document.activeElement === target) {
          // If the list contains exactly one item and it matches the current text, it's effectively "selected" already?
          // No, user might want to confirm it.
          // Check if selecting it changes anything.

          e.preventDefault();
          const first = currentAutocompleteList.querySelector(
            ".autocomplete-item",
          ) as HTMLElement;
          if (first) {
            first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          }
        }
      } else {
        // List closed, Enter adds new row
        if (onEnterCallback) {
          e.preventDefault();
          onEnterCallback();
        }
      }
    } else if (e.key === "ArrowDown") {
      if (currentAutocompleteList) {
        e.preventDefault();
        const first = currentAutocompleteList.querySelector(
          ".autocomplete-item",
        ) as HTMLElement;
        if (first) first.focus();
      } else {
        if (target.getAttribute("data-name") === "pib_magazin") {
          e.preventDefault();
          void showOwnerSuggestions(target, false);
        }
      }
    } else if (e.key === "Escape") {
      if (target.getAttribute("data-name") === "pib_magazin") {
        ++autocompleteRequestVersion;
        ownerRequest = null;
      }
      if (currentAutocompleteList) {
        e.preventDefault();
        closeAutocompleteList();
      }
    }
  });

  // 📌 Підсвітка активного рядка
  container.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest("tr") as HTMLElement | null;
    if (!row || !row.parentElement?.closest("tbody")) return;
    const prev = container.querySelector("tr.active-row");
    if (prev && prev !== row) prev.classList.remove("active-row");
    row.classList.add("active-row");
  });
  container.addEventListener("focusout", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest("tr") as HTMLElement | null;
    // Знімаємо підсвітку тільки якщо фокус пішов за межі цього рядка
    if (!row) return;
    const related = (e as FocusEvent).relatedTarget as HTMLElement | null;
    if (!related || !row.contains(related)) {
      row.classList.remove("active-row");
    }
  });

  container.addEventListener("focusin", async (e) => {
    const target = e.target as HTMLElement;
    if (
      !target.classList.contains("editable-autocomplete") ||
      cache.isActClosed
    )
      return;

    const dataName = target.getAttribute("data-name") || "";
    if (dataName === "pib_magazin") {
      await showOwnerSuggestions(target, false);
      return;
    }
    if (_suppressAutocomplete) return; // Skip only the just-selected item name.
    const requestVersion = ++autocompleteRequestVersion;
    if (dataName === "catalog") {
      if (!showCatalog) return;

      const initial = (target.textContent || "").trim();
      (target as any)._initialPn = initial;
      (target as any)._prevCatalogText = initial;

      const row = target.closest("tr") as HTMLElement | null;
      const nameCell = row?.querySelector(
        '[data-name="name"]',
      ) as HTMLElement | null;
      const selectedName = nameCell?.textContent?.trim() || "";

      if (selectedName && !initial) {
        let matches: Awaited<ReturnType<typeof searchSkladCatalog>>;
        try { matches = await searchSkladCatalog(selectedName, true); }
        catch { if (target.isConnected && document.activeElement === target) showNotification("Не вдалося завантажити підказки. Повторіть пошук.", "error"); return; }
        if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target || (target.textContent || "").trim() !== initial ||
            (nameCell?.textContent?.trim() || "") !== selectedName) return;
        if (matches.length > 0) {
          // Генеруємо підказки з усіх знайдених деталей
          const suggestions = matches.map((p) => {
            const qty = Number(p.quantity) || 0;
            const priceRounded = formatUA(Math.round(p.price));

            // Якщо статус "Замовити" або "Замовлено" - сірий (деталі ще не прибули)
            let colorStyle = "color: #2e7d32"; // default green
            if (p.statys === "Замовити" || p.statys === "Замовлено")
              colorStyle = "color: #888"; // grey - деталі ще не прибули
            else if (qty === 0)
              colorStyle = "color: #888"; // grey
            else if (qty < 0)
              colorStyle = "color: #e40b0b"; // red
            else colorStyle = "color: #1565c0"; // blue

            // Форматування дати
            const timeOn = p.time_on
              ? new Date(p.time_on).toLocaleDateString("uk-UA")
              : "";

            // Склад (синій, не жирний)
            const skladTag =
              p.scladNomer !== null && p.scladNomer !== undefined
                ? ` <span style="color: #1565c0; font-weight: normal;">(${p.scladNomer}-Склад)</span>`
                : "";

            // Статус (Замовити - червоний, Замовлено - синій)
            const statysTag =
              p.statys === "Замовити"
                ? ` <span style="color: #ff0000; font-weight: bold; text-decoration: underline;">Замовити</span>`
                : p.statys === "Замовлено"
                  ? ` <span style="color: #0000ff; font-weight: bold; text-decoration: underline;">Замовлено</span>`
                  : "";

            // Дата (чорний)
            const dateTag = timeOn
              ? ` <span style="color: #000; font-weight: normal;">${timeOn}</span>`
              : "";

            const labelHtml = `<span style="color: #000; font-weight: normal; text-decoration: underline;">${p.part_number}</span> - <span style="color: #1565c0">${p.name}</span> <span style="${colorStyle}; font-weight: bold;">(К-ть: ${qty}, ${priceRounded})</span>${skladTag}${statysTag}${dateTag}`;

            return {
              value: p.part_number,
              sclad_id: p.sclad_id,
              label: `${p.part_number} - ${p.name} (К-ть: ${qty}, ${priceRounded})`,
              labelHtml: labelHtml,
              fullName: p.name,
              itemType: "detail" as const,
            };
          });
          renderAutocompleteList(target, suggestions);
        } else {
          closeAutocompleteList();
        }
      }

      removeCatalogInfo();
      return;
    }

    let suggestions: Suggest[] = [];

    if (dataName === "name") {
      // ✅ При фокусі показуємо повний текст для редагування
      const currentText = target.textContent?.trim() || "";
      const fullNameAttr = target.getAttribute("data-full-name");

      if (fullNameAttr && currentText.includes(".....")) {
        // Зберігаємо скорочений текст і показуємо повний
        target.setAttribute("data-shortened-name", currentText);
        target.textContent = fullNameAttr;
      } else if (currentText.includes(".....")) {
        // Намагаємося розгорнути через кеш
        const expanded = expandName(currentText);
        if (expanded !== currentText) {
          target.setAttribute("data-shortened-name", currentText);
          target.setAttribute("data-full-name", expanded);
          target.textContent = expanded;
        }
      }

      // ← Використовуємо нову функцію з кешуванням
      const query = target.textContent?.trim() || "";
      try { suggestions = await getNameSuggestions(query); }
      catch { if (target.isConnected && document.activeElement === target) showNotification("Не вдалося завантажити підказки. Повторіть пошук.", "error"); return; }
      if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target || target.textContent?.trim() !== query) return;
    }

    if (suggestions.length) renderAutocompleteList(target, suggestions);
    else closeAutocompleteList();
  });

  container.addEventListener("input", async (e) => {
    const target = e.target as HTMLElement;
    if (
      !target.classList.contains("editable-autocomplete") ||
      cache.isActClosed
    ) {
      closeAutocompleteList();
      removeCatalogInfo();
      return;
    }

    const dataName = target.getAttribute("data-name") || "";
    if (dataName === "pib_magazin") {
      await showOwnerSuggestions(target, true);
      return;
    }
    if (_suppressAutocomplete) return;
    const currTextRaw = (target.textContent || "").trim();
    const query = currTextRaw.toLowerCase();
    const requestVersion = ++autocompleteRequestVersion;
    if (dataName === "catalog" || dataName === "name") {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target ||
          (target.textContent || "").trim() !== currTextRaw) return;
    }

    if (dataName === "catalog" && query) {
      try { await loadEditorReferences({query}); } catch { showNotification("Не вдалося завантажити довідник робіт", "error"); return; }
      if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target || (target.textContent || "").trim() !== currTextRaw) return;
    }
    let suggestions: Suggest[] = [];

    if (dataName === "catalog") {

      const row = target.closest("tr") as HTMLElement;
      const nameCell = row?.querySelector(
        '[data-name="name"]',
      ) as HTMLElement | null;

      /* Mixed Search Logic for Catalog: Works (Green) + Sclad (Blue) */

      const query = currTextRaw.toLowerCase();

      if (query.length >= 1) {
        // Визначаємо тип рядка з поля "Найменування"

        const nameType = nameCell?.getAttribute("data-type") || ""; // "details" або "works"

        let matchedParts: Awaited<ReturnType<typeof searchSkladCatalog>> = [];
        if (nameType !== "works") {
          try { matchedParts = await searchSkladCatalog(query); }
          catch { if (target.isConnected && document.activeElement === target) showNotification("Не вдалося завантажити підказки. Повторіть пошук.", "error"); return; }
          if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target || (target.textContent || "").trim() !== currTextRaw ||
              (nameCell?.getAttribute("data-type") || "") !== nameType) return;
        }
        let workSuggestions: Suggest[] = [];
        let partSuggestions: Suggest[] = [];

        // 1. Якщо чітко визначено РОБОТА - показуємо ТІЛЬКИ роботи
        if (nameType === "works") {
          const matchedWorks = globalCache.worksWithId
            .filter(
              (w) =>
                matchesCatalogSearch(w.work_id, query) ||
                matchesCatalogSearch(w.name, query),
            )
            .slice(0, NAME_AUTOCOMPLETE_MAX_RESULTS);

          workSuggestions = matchedWorks.map((w) => ({
            label: `${w.work_id} - ${w.name}`,
            value: w.work_id,
            fullName: w.name,
            itemType: "work", // Will be Green
          }));

          // 2. Якщо чітко визначено ДЕТАЛІ - показуємо ТІЛЬКИ деталі
        } else if (nameType === "details") {
    
          // Видалено перевірку if (selectedName), щоб шукати по всіх деталях, навіть якщо назва вже введена
          partSuggestions = matchedParts.map((p) => {
            const qty = Number(p.quantity) || 0;
            const priceRounded = formatUA(Math.round(p.price));

            // Якщо статус "Замовити" або "Замовлено" - сірий (деталі ще не прибули)
            let colorStyle = "color: #2e7d32"; // default green
            if (p.statys === "Замовити" || p.statys === "Замовлено")
              colorStyle = "color: #888"; // grey - деталі ще не прибули
            else if (qty === 0)
              colorStyle = "color: #888"; // grey
            else if (qty < 0)
              colorStyle = "color: #e40b0b"; // red
            else colorStyle = "color: #1565c0"; // blue

            // Форматування дати
            const timeOn = p.time_on
              ? new Date(p.time_on).toLocaleDateString("uk-UA")
              : "";

            // Склад (синій, не жирний)
            const skladTag =
              p.scladNomer !== null && p.scladNomer !== undefined
                ? ` <span style="color: #1565c0; font-weight: normal;">(${p.scladNomer}-Склад)</span>`
                : "";

            // Статус (Замовити - червоний, Замовлено - синій)
            const statysTag =
              p.statys === "Замовити"
                ? ` <span style="color: #ff0000; font-weight: bold; text-decoration: underline;">Замовити</span>`
                : p.statys === "Замовлено"
                  ? ` <span style="color: #0000ff; font-weight: bold; text-decoration: underline;">Замовлено</span>`
                  : "";

            // Дата (чорний)
            const dateTag = timeOn
              ? ` <span style="color: #000; font-weight: normal;">${timeOn}</span>`
              : "";

            const labelHtml = `<span style="color: #000; font-weight: normal; text-decoration: underline;">${p.part_number}</span> - <span style="color: #1565c0">${p.name}</span> <span style="${colorStyle}; font-weight: bold;">(К-ть: ${qty}, ${priceRounded})</span>${skladTag}${statysTag}${dateTag}`;

            return {
              value: p.part_number,
              sclad_id: p.sclad_id,
              label: `${p.part_number} - ${p.name} (К-ть: ${qty}, ${priceRounded})`,
              labelHtml: labelHtml,
              fullName: p.name,
              itemType: "detail", // Will be Blue
            };
          });

          // 3. Якщо НЕ визначено тип - показуємо ВСЕ (деталі зверху, роботи знизу)
        } else {
    
          // Деталі
          partSuggestions = matchedParts.map((p) => {
            const qty = Number(p.quantity) || 0;
            const priceRounded = formatUA(Math.round(p.price));

            // Якщо статус "Замовити" або "Замовлено" - сірий (деталі ще не прибули)
            let colorStyle = "color: #2e7d32"; // default green
            if (p.statys === "Замовити" || p.statys === "Замовлено")
              colorStyle = "color: #888"; // grey - деталі ще не прибули
            else if (qty === 0)
              colorStyle = "color: #888"; // grey
            else if (qty < 0)
              colorStyle = "color: #e40b0b"; // red
            else colorStyle = "color: #1565c0"; // blue

            // Форматування дати
            const timeOn = p.time_on
              ? new Date(p.time_on).toLocaleDateString("uk-UA")
              : "";

            // Склад (синій, не жирний)
            const skladTag =
              p.scladNomer !== null && p.scladNomer !== undefined
                ? ` <span style="color: #1565c0; font-weight: normal;">(${p.scladNomer}-Склад)</span>`
                : "";

            // Статус (Замовити - червоний, Замовлено - синій)
            const statysTag =
              p.statys === "Замовити"
                ? ` <span style="color: #ff0000; font-weight: bold; text-decoration: underline;">Замовити</span>`
                : p.statys === "Замовлено"
                  ? ` <span style="color: #0000ff; font-weight: bold; text-decoration: underline;">Замовлено</span>`
                  : "";

            // Дата (чорний)
            const dateTag = timeOn
              ? ` <span style="color: #000; font-weight: normal;">${timeOn}</span>`
              : "";

            const labelHtml = `<span style="color: #000; font-weight: normal; text-decoration: underline;">${p.part_number}</span> - <span style="color: #1565c0">${p.name}</span> <span style="${colorStyle}; font-weight: bold;">(К-ть: ${qty}, ${priceRounded})</span>${skladTag}${statysTag}${dateTag}`;

            return {
              value: p.part_number,
              sclad_id: p.sclad_id,
              label: `${p.part_number} - ${p.name} (К-ть: ${qty}, ${priceRounded})`,
              labelHtml: labelHtml,
              fullName: p.name,
              itemType: "detail", // Will be Blue
            };
          });

          // Роботи
          const matchedWorks = globalCache.worksWithId
            .filter(
              (w) =>
                matchesCatalogSearch(w.work_id, query) ||
                matchesCatalogSearch(w.name, query),
            )
            .slice(0, NAME_AUTOCOMPLETE_MAX_RESULTS);

          workSuggestions = matchedWorks.map((w) => ({
            label: `${w.work_id} - ${w.name}`,
            value: w.work_id,
            fullName: w.name,
            itemType: "work", // Will be Green
          }));
        }

        // Комбінуємо: спочатку деталі, потім роботи
        suggestions = [...partSuggestions, ...workSuggestions];
      }

      // Відображаємо підказки або закриваємо список
      if (suggestions.length) {
        renderAutocompleteList(target, suggestions);
      } else {
        closeAutocompleteList();
      }
      removeCatalogInfo();
    } else if (dataName === "name") {
      // ← НОВИЙ КОД: використовуємо нову функцію з кешуванням
      try { suggestions = await getNameSuggestions(currTextRaw); }
      catch { if (target.isConnected && document.activeElement === target) showNotification("Не вдалося завантажити підказки. Повторіть пошук.", "error"); return; }
      if (requestVersion !== autocompleteRequestVersion || !target.isConnected || document.activeElement !== target || (target.textContent || "").trim() !== currTextRaw) return;

      const row = target.closest("tr");
      const pibMagCell = row?.querySelector(
        '[data-name="pib_magazin"]',
      ) as HTMLElement | null;
      if (pibMagCell) {
        const t = updatePibMagazinDataType(pibMagCell);
        const currentText = pibMagCell.textContent?.trim() || "";
        if (currentText) {
          const ownerActId = globalCache.currentActId;
          let allowedNames: string[] | null = null;
          try {
            allowedNames = await readEditorOwnerNames(t === "shops" ? "shops" : "slyusars");
          } catch {
            // An unavailable directory must never erase the existing owner.
          }
          if (requestVersion !== autocompleteRequestVersion || !target.isConnected ||
              document.activeElement !== target || globalCache.currentActId !== ownerActId ||
              (target.textContent || "").trim() !== currTextRaw ||
              (pibMagCell.textContent || "").trim() !== currentText || updatePibMagazinDataType(pibMagCell) !== t) return;
          if (allowedNames && !allowedNames.some(name => name.toLowerCase() === currentText.toLowerCase())) {
            pibMagCell.textContent = "";
          }
        }
        if (query.length === 0) pibMagCell.textContent = "";
      }
    }

    if (suggestions.length) renderAutocompleteList(target, suggestions);
    else closeAutocompleteList();

    const row = target.closest("tr") as HTMLElement | null;
    if (!row) return;

    if (dataName === "price") {
      await updatePriceWarningForRow(row);
    } else if (
      dataName === "id_count" &&
      LIVE_WARNINGS &&
      globalCache.settings.showCatalog
    ) {
      updateCatalogWarningForRow(row);
    }
  });

  container.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("editable-autocomplete")) return;
    if (target.getAttribute("data-name") !== "catalog") return;
    if (e.key === "Enter") {
      e.preventDefault();
      const scladIdAttr = target.getAttribute("data-sclad-id");
      const sclad_id = scladIdAttr ? Number(scladIdAttr) : null;
      if (sclad_id)
        applyCatalogSelectionById(target, sclad_id, undefined, {
          forcePriceUpdate: true,
        });
      closeAutocompleteList();
      removeCatalogInfo();
    }
  });

  container.addEventListener("focusout", (e) => {
    const target = e.target as HTMLElement;

    if (target.getAttribute("data-name") === "pib_magazin" &&
        !(e.relatedTarget as HTMLElement | null)?.closest(".autocomplete-list")) {
      ++autocompleteRequestVersion;
      ownerRequest = null;
    }

    if (
      target &&
      target.classList.contains("editable-autocomplete") &&
      target.getAttribute("data-name") === "catalog"
    ) {
      setTimeout(async () => {
        const pn = (target.textContent || "").trim();
        const initialRaw = (target as any)._initialPn;
        const initial = typeof initialRaw === "string" ? initialRaw : "";
        removeCatalogInfo();

        const row = target.closest("tr") as HTMLElement | null;
        const catalogCell = row?.querySelector(
          '[data-name="catalog"]',
        ) as HTMLElement | null;

        const scladIdAttr = target.getAttribute("data-sclad-id");
        const sclad_id = scladIdAttr ? Number(scladIdAttr) : null;

        // Якщо _initialPn не ініціалізовано (нестандартний blur), не робимо автопідстановок ціни.
        if (initialRaw === undefined) {
          if (row && LIVE_WARNINGS) {
            updateCatalogWarningForRow(row);
            updatePriceWarningForRow(row);
          }
          return;
        }

        let picked: Awaited<ReturnType<typeof resolveScladItemByPart>> = null;
        try {
          if (sclad_id) {
            await ensureSkladIdsLoaded([sclad_id]);
            picked = globalCache.skladParts.find(part => part.sclad_id === sclad_id) || null;
          } else if (pn) picked = await resolveScladItemByPart(pn);
        } catch {
          // Preserve the typed value and its ID when availability cannot be checked.
          return;
        }
        if (!target.isConnected || (target.textContent || "").trim() !== pn ||
            target.getAttribute("data-sclad-id") !== scladIdAttr) return;

        if (pn && pn !== initial) {
          if (sclad_id) {
            applyCatalogSelectionById(target, sclad_id, undefined, {
              forcePriceUpdate: true,
            });
          } else {
            if (picked)
              applyCatalogSelectionById(target, picked.sclad_id, undefined, {
                forcePriceUpdate: true,
              });
          }
        } else {
          if (row && LIVE_WARNINGS) {
            updateCatalogWarningForRow(row);
            updatePriceWarningForRow(row);
          }
          if (catalogCell && pn && !picked) {
            catalogCell.removeAttribute("data-sclad-id");
          }
        }
      }, 0);
    }

    if (
      target &&
      target.classList.contains("editable-autocomplete") &&
      target.getAttribute("data-name") === "name"
    ) {
      setTimeout(async () => {
        const originalName = (target.textContent || "").trim();
        try { await loadEditorReferences({names:[target.getAttribute("data-full-name") || originalName]}); } catch { return; }
        if (!target.isConnected || (target.textContent || "").trim() !== originalName) return;
        const row = target.closest("tr");
        let nameText = (target.textContent || "").trim();

        // ✅ При blur скорочуємо довгий текст
        if (nameText && !nameText.includes(".....")) {
          const shortened = shortenTextToFirstAndLast(nameText);
          if (shortened !== nameText) {
            // Зберігаємо повний текст в атрибут
            target.setAttribute("data-full-name", nameText);
            target.textContent = shortened;
            nameText = shortened;
          }
        }
        // Очищаємо тимчасовий атрибут
        target.removeAttribute("data-shortened-name");

        if (row && nameText) {
          const indexCell = row.querySelector(".row-index");
          const currentType = target.getAttribute("data-type");

          // Використовуємо повну назву для перевірки типу
          const fullNameForCheck =
            target.getAttribute("data-full-name") || nameText;

          // Check exact matches if type is not set or we want to double check
          const isDetail = globalCache.details.includes(fullNameForCheck);
          const isWork = globalCache.works.includes(fullNameForCheck);

          let finalType = currentType;

          if (isDetail) finalType = "details";
          else if (isWork) finalType = "works";
          else if (!currentType || currentType === "") {
            // Fallback for custom text -> Work
            finalType = "works";
          }

          if (finalType !== currentType) {
            target.setAttribute("data-type", finalType || "works");
          }

          // Update Emoji based on final type (or default to work if custom)
          if (indexCell) {
            const num =
              indexCell.textContent?.replace(/\D/g, "") ||
              (row as HTMLTableRowElement).sectionRowIndex + 1;
            const icon = finalType === "details" ? "⚙️" : "🛠️";
            // Only update if it doesn't have the icon yet? Or always force it
            if (!indexCell.textContent?.includes(icon)) {
              indexCell.textContent = `${icon} ${num}`;
            }
          }

          // Update pib_magazin type
          const pibMagCell = row.querySelector(
            '[data-name="pib_magazin"]',
          ) as HTMLElement | null;
          if (pibMagCell) {
            const targetPibType =
              finalType === "details" ? "shops" : "slyusars";
            if (pibMagCell.getAttribute("data-type") !== targetPibType) {
              pibMagCell.setAttribute("data-type", targetPibType);
              // Clear if type switched? Maybe safer to leave content if user typed it.
            }
          }
        }
      }, 0);
    }

    const relatedTarget = (e as FocusEvent).relatedTarget as HTMLElement;
    if (relatedTarget && relatedTarget.closest(".autocomplete-list")) return;

    setTimeout(() => {
      if (
        !document.activeElement?.closest(".autocomplete-list") &&
        document.activeElement !== currentAutocompleteInput
      ) {
        closeAutocompleteList();
      }
    }, 100);
  });

  container.addEventListener(
    "mouseenter",
    async (e) => {
      const t = e.target as HTMLElement;
      const cell = t.closest('[data-name="catalog"]') as HTMLElement | null;
      if (!cell) return;
      if (currentAutocompleteList) return;

      const scladIdAttr = cell.getAttribute("data-sclad-id");
      const sclad_id = scladIdAttr ? Number(scladIdAttr) : null;
      if (!sclad_id) return;

      await ensureSkladIdsLoaded([sclad_id]);
      showCatalogInfo(cell, sclad_id);
    },
    true,
  );

  container.addEventListener(
    "mouseleave",
    (e) => {
      const t = e.target as HTMLElement;
      const cell = t.closest('[data-name="catalog"]');
      if (!cell) return;
      removeCatalogInfo();
    },
    true,
  );

  container.addEventListener("mouseleave", () => {
    removeCatalogInfo();
  });

  // 🤖 AI: Встановлюємо обробник підтвердження ціни при кліку
  setupPriceConfirmationHandler(container);
}

/** підтягування даних по вибраному sclad_id */
async function applyCatalogSelectionById(
  target: HTMLElement,
  sclad_id: number,
  fullName?: string,
  options?: { forcePriceUpdate?: boolean },
) {
  const picked = globalCache.skladParts.find((p) => p.sclad_id === sclad_id);
  if (!picked) return;

  const row = target.closest("tr") as HTMLTableRowElement;
  if (!row) return;

  const nameCell = row.querySelector(
    '[data-name="name"]',
  ) as HTMLElement | null;
  const priceCell = row.querySelector(
    '[data-name="price"]',
  ) as HTMLElement | null;
  const pibMagCell = row.querySelector(
    '[data-name="pib_magazin"]',
  ) as HTMLElement | null;
  const catalogCell = row.querySelector(
    '[data-name="catalog"]',
  ) as HTMLElement | null;

  // ✅ НОВИЙ КОД: Отримуємо відсоток по складу деталі
  const scladNomer = picked.scladNomer;
  const percentInfo = await loadPercentByWarehouse(scladNomer);

  const basePrice = Math.round(picked.price || 0);
  const priceWithMarkup = Math.ceil(
    basePrice * (1 + percentInfo.percent / 100),
  );

  // ✅ ВИПРАВЛЕНО: Виводимо повну назву замість скороченої
  const nameToSet = fullName || picked.name || "";
  setCellText(nameCell, nameToSet);

  // КРИТИЧНО: Встановлюємо тип "details" для деталей зі складу
  if (nameCell) {
    nameCell.setAttribute("data-type", "details");
  }

  // 🔒 Не перезаписуємо ціну якщо обрана та сама деталь і ціна вже встановлена.
  // Перезаписуємо тільки коли: ціна порожня/0, або користувач обрав ІНШУ деталь.
  const currentPrice = parseNum(priceCell?.textContent);
  const isManualPrice = priceCell?.getAttribute("data-price-manual") === "1";

  // Перевіряємо чи це та сама деталь що вже була в рядку
  const prevScladId = catalogCell?.getAttribute("data-sclad-id");
  const isSameDetail =
    prevScladId !== null &&
    prevScladId !== undefined &&
    Number(prevScladId) === sclad_id;

  const shouldAutoFillPrice =
    // Якщо деталь змінилась — завжди підставляємо нову ціну
    (!!options?.forcePriceUpdate && !isSameDetail) ||
    // Якщо деталь та сама — тільки коли ціна порожня/0 і не ручна
    (!isManualPrice && (!currentPrice || currentPrice <= 0));

  // При явному перевиборі ІНШОЇ деталі дозволяємо нову автопідстановку ціни
  if (options?.forcePriceUpdate && !isSameDetail && priceCell) {
    priceCell.removeAttribute("data-price-manual");
  }

  if (shouldAutoFillPrice) {
    setCellText(priceCell, formatUA(priceWithMarkup));
  }

  // ✅ СТИЛІЗАЦІЯ ЯЧЕЙКИ ЦІНИ ПО СТАТУСУ СКЛАДУ
  if (priceCell) {
    // Видаляємо попередні стилі та атрибути
    priceCell.style.backgroundColor = "";
    priceCell.removeAttribute("data-warehouse-status");
    priceCell.removeAttribute("title");

    if (percentInfo.status === "blocked") {
      // Склад заблокований (-1) → червоний фон
      priceCell.style.backgroundColor = "#ffcdd2"; // світло-червоний
      priceCell.setAttribute("data-warehouse-status", "blocked");
      priceCell.title = `⛔ Склад ${scladNomer || 1} заблокований! Вхідна ціна: ${formatUA(basePrice)} грн`;
    } else if (percentInfo.status === "missing") {
      // Склад відсутній (null) → синій фон
      priceCell.style.backgroundColor = "#bbdefb"; // світло-синій
      priceCell.setAttribute("data-warehouse-status", "missing");
      priceCell.title = `⚠️ Склад ${scladNomer || "?"} відсутній, націнка 0%. Вхідна ціна: ${formatUA(basePrice)} грн`;
    }
  }

  if (catalogCell) {
    catalogCell.setAttribute("data-sclad-id", String(picked.sclad_id));
    // ✅ Зберігаємо номер складу для перевірки націнки при повторному відкритті
    if (scladNomer !== null && scladNomer !== undefined && scladNomer > 0) {
      catalogCell.setAttribute("data-sclad-nomer", String(scladNomer));
    }
    setCellText(catalogCell, picked.part_number || "");
  }
  if (pibMagCell) {
    pibMagCell.setAttribute("data-type", "shops");
    setCellText(pibMagCell, picked.shop || "");
  }

  const typeFromCell = nameCell?.getAttribute("data-type");

  if (typeFromCell === "works") {
    calculateRowSum(row).catch((_err) => {
      // console.error("Помилка при розрахунку суми після вибору каталогу:", _err);
    });
  } else {
    recalcRowSum(row);
  }
}

/** ПІБ/Магазин: визначає тип на основі бази даних */
function updatePibMagazinDataType(pibMagazinCell: HTMLElement): string {
  const currentRow = pibMagazinCell.closest("tr");
  const nameCell = currentRow?.querySelector(
    '[data-name="name"]',
  ) as HTMLElement | null;

  const nameQuery = (nameCell?.textContent || "").trim();

  // 1. Якщо у "Найменування" вже є data-type – ДОВІРЯЄМО йому
  const explicitType = nameCell?.getAttribute("data-type");
  if (explicitType === "details") {
    pibMagazinCell.setAttribute("data-type", "shops");
    return "shops"; // деталь → магазини
  }
  if (explicitType === "works") {
    pibMagazinCell.setAttribute("data-type", "slyusars");
    return "slyusars"; // робота → слюсарі
  }

  // 2. Якщо назва пуста – дефолтно слюсар
  if (!nameQuery) {
    pibMagazinCell.setAttribute("data-type", "slyusars");
    return "slyusars";
  }

  // 3. Fallback: аналізуємо, де назва є в кеші (на випадок, якщо data-type не виставлений)
  const nameQueryLower = nameQuery.toLowerCase();

  const isInDetails = globalCache.details.some(
    (d) => d.toLowerCase() === nameQueryLower,
  );

  const isInWorks = globalCache.works.some(
    (w) => w.toLowerCase() === nameQueryLower,
  );

  let targetType: "shops" | "slyusars";

  if (isInDetails && !isInWorks) {
    targetType = "shops"; // ДЕТАЛЬ → МАГАЗИН
  } else if (isInWorks && !isInDetails) {
    targetType = "slyusars"; // РОБОТА → СЛЮСАР
  } else {
    targetType = "slyusars"; // за замовчуванням слюсар
  }

  pibMagazinCell.setAttribute("data-type", targetType);

  return targetType;
}
