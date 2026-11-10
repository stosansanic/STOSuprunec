import { confirmAccountingPayment, withAccountingPaymentOperation, isAccountingPaymentBusy } from "./accountingPaymentConfirmation";
import { accountingInitialRows, accountingVisibleRows, createAccountingScroll, setAccountingRows, withAccountingExportRows } from "./accountingLazyRows";
import { isCancelled, missingAccountingRpc } from "./accountingRequests";
import { announceAccountingChange, accountingSearchScope, readAccountingPeriod } from "./accountingPeriod";
import { createProfitAccountingRead, isProfitAccountingStale, type ProfitAccountingFilter, type ProfitAccountingSnapshot } from "./profitAccountingRead";
// src/ts/roboha/bukhhalteriya/prubutok.ts
// Модуль для обліку витрат з інтеграцією Supabase
import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { byId, formatNumber, formatDate } from "./bukhhalteriya";
import { userName, getSavedUserDataFromLocalStorage } from "../tablucya/users";
import { checkCurrentPageAccess } from "../zakaz_naraudy/inhi/page_access_guard";
import { redirectToIndex } from "../../utils/gitUtils";

interface ExpenseRecordLocal {
  id: number;
  date: string;
  category: string;
  description: string;
  amount: number;
  paymentMethod: string;
  isPaid: boolean;
  paymentDate?: string | null;
  rosraxovanoDate?: string | null;
  notes?: string;
  actNumber?: string | number;
  createdBy?: string;
  detailsAmount?: number;
  workAmount?: number;
  clientId?: number;
  carId?: number;
  xto_rozraxuvav?: string;
  fullAmount?: number; // Повна сума з акту
  fullDetailsAmount?: number; // Повна сума за деталі з акту
  fullWorkAmount?: number; // Повна сума за роботу з акту
  tupOplatu?: string; // Тип оплати
  discount?: number; // Знижка у відсотках
  discountAmount?: number; // Сума знижки
  paymentBaseline?: string;
}

type ExpenseMode = "add" | "edit" | "delete";

interface ExpenseModeConfig {
  emoji: string;
  text: string;
  title: string;
  buttonText: string;
  className: string;
}

let vutratuData: ExpenseRecordLocal[] = [];
let filteredvutratuData: ExpenseRecordLocal[] = [];
let currentExpenseMode: ExpenseMode = "add";
let selectedExpenseId: number | null = null;

const expenseModes: Record<ExpenseMode, ExpenseModeConfig> = {
  add: {
    emoji: "➕",
    text: "Додати",
    title: "Додати витрату",
    buttonText: "💾 Додати",
    className: "mode-add",
  },
  edit: {
    emoji: "✏️",
    text: "Редагувати",
    title: "Редагувати витрату",
    buttonText: "💾 Зберегти зміни",
    className: "mode-edit",
  },
  delete: {
    emoji: "🗑️",
    text: "Видалити",
    title: "Видалити витрату",
    buttonText: "🗑️ Підтвердити видалення",
    className: "mode-delete",
  },
};

const modeSequence: ExpenseMode[] = ["add", "edit", "delete"];

const EXPENSE_CATEGORIES = [
  "🚕 Таксі",
  "🚚 Нова Пошта",
  "🚛 Meest Express",
  "🛻 Delivery",
  "⚙️ Деталі",
  "💳 Кредит",
  "💰 Аванс",
  "🔧 Інструменти",
  "🏢 Оренда",
  "💡 Комунальні послуги",
  "📱 Зв'язок",
  "🧰 Обладнання",
  "💻 Програмне забезпечення",
  "💸 Податок",
  "📄 Канцелярія",
  "👨‍🔧 Зарплата",
  "🍴 Харчування",
  "🏥 Медицина",
  "📚 Навчання",
  "🔨 Ремонт",
  "💼 Інше",
];

const PAYMENT_METHODS = ["💵 Готівка", "💳 Картка", "🏦 IBAN"];

// ВСТАВИТИ ЦЕЙ КОД:
// Функції для перетворення між форматами з емодзі та без
function removeEmoji(text: string): string {
  return text
    .replace(
      /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu,
      "",
    )
    .trim();
}

function addEmojiToCategory(categoryName: string): string {
  const found = EXPENSE_CATEGORIES.find(
    (cat) => removeEmoji(cat) === categoryName,
  );
  return found || categoryName;
}

function addEmojiToPaymentMethod(methodName: string): string {
  const found = PAYMENT_METHODS.find(
    (method) => removeEmoji(method) === methodName,
  );
  return found || methodName;
}

// ==================== ФУНКЦІЇ РЕЖИМІВ ====================

export function cycleExpenseMode(): void {
  const currentIndex = modeSequence.indexOf(currentExpenseMode);
  const nextIndex = (currentIndex + 1) % modeSequence.length;
  const nextMode = modeSequence[nextIndex];
  setExpenseMode(nextMode);
}

export function setExpenseMode(mode: ExpenseMode): void {
  if (!expenseModes[mode]) return;
  currentExpenseMode = mode;
  const config = expenseModes[mode];
  const modeBtn = byId<HTMLButtonElement>("expense-mode-btn");
  if (modeBtn) {
    modeBtn.textContent = `${config.emoji} ${config.text}`;
    modeBtn.className = `expense-mode-switcher ${config.className}`;
  }
  const title = byId<HTMLHeadingElement>("expense-modal-title");
  if (title) title.textContent = config.title;
  const saveBtn = document.querySelector(
    ".expense-modal-footer button",
  ) as HTMLButtonElement;
  if (saveBtn) {
    saveBtn.textContent = config.buttonText;
  }
}

export function getCurrentExpenseMode(): ExpenseMode {
  return currentExpenseMode;
}

// ==================== ДОПОМІЖНІ ФУНКЦІЇ ====================

export function formatAmountWithSpaces(input: HTMLInputElement): void {
  const cursorPosition = input.selectionStart || 0;
  const oldValue = input.value;
  let value = input.value.replace(/\s/g, "").replace(/[^\d.,]/g, "");
  value = value.replace(",", ".");
  const parts = value.split(".");
  let integerPart = parts[0];
  const decimalPart = parts.length > 1 ? "." + parts[1].substring(0, 2) : "";
  integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const newValue = integerPart + decimalPart;
  input.value = newValue;
  const diff = newValue.length - oldValue.length;
  input.setSelectionRange(cursorPosition + diff, cursorPosition + diff);
}

export function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
}

function getCurrentUserName(): string {
  if (userName && userName !== "Невідомий користувач") {
    return userName;
  }
  const savedData = getSavedUserDataFromLocalStorage();
  if (savedData && savedData.name) {
    return savedData.name;
  }
  return "Система";
}

// 1) Функція для отримання поточного часу в UTC (залишаємо без змін, але уточнюємо)
// Повертає локальний київський час як 'YYYY-MM-DDTHH:MM:SS' (без 'Z')
// Підходить для колонок Postgres типу timestamp (без TZ)
function getCurrentUkrainianTime(): string {
  const now = new Date();
  // Час у Києві як Date, побудований із рядка (без прив'язки до UTC)
  const kyivNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour12: false }),
  );

  const y = kyivNow.getFullYear();
  const m = String(kyivNow.getMonth() + 1).padStart(2, "0");
  const d = String(kyivNow.getDate()).padStart(2, "0");
  const hh = String(kyivNow.getHours()).padStart(2, "0");
  const mm = String(kyivNow.getMinutes()).padStart(2, "0");
  const ss = String(kyivNow.getSeconds()).padStart(2, "0");

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`; // без 'Z' і без офсету
}

// 2) Нова функція для отримання дати в форматі YYYY-MM-DD за Київським часом
function getKyivDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-CA", {
      timeZone: "Europe/Kyiv",
    });
  } catch (error) {
    // console.error("❌ Помилка конвертації дати:", error);
    return null;
  }
}

// 3) Функція для форматування повної дати з часом за Київським часом (замінює вашу formatDateKyiv)
// Стало:
export function formatDateKyiv(iso?: string | null): string {
  if (!iso) return "-";
  try {
    const date = new Date(iso);
    const options: Intl.DateTimeFormatOptions = {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    return new Intl.DateTimeFormat("uk-UA", options)
      .format(date)
      .replace(", ", " / ");
  } catch (e) {
    // console.error("❌ Помилка форматування дати:", e);
    return "N/A";
  }
}

// Функції для керування станом кнопки збереження
function setSaveButtonLoading(isLoading: boolean): void {
  const saveBtn = document.querySelector(
    ".expense-modal-footer button",
  ) as HTMLButtonElement;

  if (!saveBtn) return;

  if (isLoading) {
    saveBtn.disabled = true;
    saveBtn.dataset.originalText = saveBtn.textContent || "";
    saveBtn.textContent = "⏳ Зачекайте...";
    saveBtn.style.opacity = "0.6";
    saveBtn.style.cursor = "not-allowed";
  } else {
    saveBtn.disabled = false;
    saveBtn.textContent = saveBtn.dataset.originalText || "💾 Зберегти";
    saveBtn.style.opacity = "1";
    saveBtn.style.cursor = "pointer";
    delete saveBtn.dataset.originalText;
  }
}

// ==================== РОБОТА З БАЗОЮ ДАНИХ ====================

function getClientData(value: any): string {
  try {
    const data = { data: value };
    if (value == null) return "-";

    let clientData: any = {};
    if (typeof data.data === "string") {
      clientData = JSON.parse(data.data);
    } else if (typeof data.data === "object") {
      clientData = data.data;
    }

    const pib = clientData["ПІБ"] || "-";
    const phone = clientData["Телефон"] || "-";
    const dzherelo = clientData["Джерело"] || "";
    const dodatkovi = clientData["Додаткові"] || "";

    // Формуємо рядок з усіма даними
    let result = `👤 ${pib}\n📱 ${phone}`;

    if (dzherelo && dzherelo !== "Невказано") {
      result += `\n📍 ${dzherelo}`;
    }

    if (dodatkovi) {
      result += `\n📝 ${dodatkovi}`;
    }

    return result;
  } catch (error) {
    // console.error(`❌ Помилка завантаження клієнта ${clientId}:`, error);
    return "-";
  }
}

function getCarData(value: any): string {
  try {
    const data = { data: value };
    if (value == null) return "-";

    let carData: any = {};
    if (typeof data.data === "string") {
      carData = JSON.parse(data.data);
    } else if (typeof data.data === "object") {
      carData = data.data;
    }

    const car = carData["Авто"] || "-";
    const volume = carData["Обʼєм"] || "";
    const engine = carData["КодДВЗ"] || "";
    const fuel = carData["Пальне"] || "";
    const plate = carData["Номер авто"] || "-";

    // Формуємо компактний рядок
    let engineInfo = "";
    if (volume || engine) {
      engineInfo = `\n🔧 ${[volume, engine].filter(Boolean).join(" ")}`;
    }

    let fuelInfo = fuel ? `\n⛽ ${fuel}` : "";

    return `🚗 ${car}\n🔢 ${plate}${engineInfo}${fuelInfo}`;
  } catch (error) {
    // console.error(`❌ Помилка завантаження авто ${carId}:`, error);
    return "-";
  }
}

// Глобальна змінна для зберігання поточного фільтра дат
let vutratuDateFilterMode: "open" | "close" | "paid" = "open";

// Функція для ініціалізації перемикача фільтрації дат для витрат
function initvutratuDateFilterToggle(): void {
  const toggleContainer = document.querySelector(
    "#Bukhhalter-vutratu-section .Bukhhalter-date-filter-toggle",
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

      // Зберігаємо режим фільтрації
      vutratuDateFilterMode = this.dataset.filter as "open" | "close" | "paid";

      // Each date mode has its own compact, cached server result.
      filtervutratuData();
    });
  });
}

const profitReader = createProfitAccountingRead();
let profitSnapshot: ProfitAccountingSnapshot | null = null;
let profitScope = "";
let profitShown = 0;
let profitLoadGeneration = 0;
let profitBusy = false;
let profitExporting = false;
let profitExportPending = false;
let profitMutationBusy = false;
let profitReadNeedsRefresh = false;
let profitPending: {key: string; promise: Promise<void>} | null = null;
const profitHiddenIds = new Set<number>();

function profitFilter(required = false): ProfitAccountingFilter | null {
  const from = byId<HTMLInputElement>("Bukhhalter-vutratu-date-from")?.value || "";
  if (!from && !required) return null;
  const period = readAccountingPeriod("vutratu");
  if (!period) return null;
  const value = (id: string, fallback = "") => byId<HTMLInputElement>(id)?.value || fallback;
  return {...period, mode: vutratuDateFilterMode,
    category: removeEmoji(value("Bukhhalter-vutratu-category")), paymentMethod: removeEmoji(value("Bukhhalter-vutratu-payment-method")),
    payment: value("vutratu-payment-filter-toggle", "2"), type: value("vutratu-type-filter-toggle", "2"),
    status: value("vutratu-status-filter-toggle", "2"), discount: value("vutratu-discount-filter-toggle", "2"),
    include_client: byId<HTMLInputElement>("include-client-description")?.checked || false,
    include_car: byId<HTMLInputElement>("include-car-notes")?.checked || false,
    exclude_ids: [...profitHiddenIds].sort((a,b) => a-b),
  };
}
function profitCurrentKey(): string {
  const filter = profitFilter();
  return filter ? JSON.stringify([accountingSearchScope('profit'), filter]) : "";
}
function profitRecord(row: any): ExpenseRecordLocal {
  const act = row.category === 'Прибуток';
  return {...row, category: act ? '💰 Прибуток' : addEmojiToCategory(row.category),
    paymentMethod: act ? row.paymentMethod : addEmojiToPaymentMethod(row.paymentMethod),
    description: act ? getClientData(row.clientLabel) : row.description,
    notes: act ? getCarData(row.carLabel) : row.notes,
  };
}
function applyProfitSnapshot(snapshot: ProfitAccountingSnapshot): void {
  profitSnapshot = snapshot;
  vutratuData = snapshot.rows.map(profitRecord);
  filteredvutratuData = vutratuData;
}
function resetProfitReport(clearHidden = false): void {
  profitLoadGeneration++; profitReader.clear(); profitPending = null;
  profitSnapshot = null; profitScope = ''; profitBusy = false; profitShown = 0;
  profitReadNeedsRefresh = false;
  if (clearHidden) profitHiddenIds.clear();
  vutratuData = []; filteredvutratuData = [];
  profitScroll.reset();
}
function reportProfitError(error: unknown): void {
  if (isCancelled(error)) return;
  if (isProfitAccountingStale(error)) {
    resetProfitReport(); updatevutratuTable();
    showNotification('Дані звіту змінилися. Натисніть «Пошук», щоб отримати актуальні підсумки.', 'warning');
  } else showNotification(error instanceof Error ? error.message : 'Не вдалося завантажити прибуток', 'error');
}
async function loadvutratuFromDatabase(force = false, preserveRows = false): Promise<void> {
  if (profitReadNeedsRefresh) force = true;
  const filter = profitFilter(true);
  if (!filter) { resetProfitReport(); updatevutratuTable(); return; }
  const scope = accountingSearchScope('profit');
  const key = JSON.stringify([scope, filter]);
  if (!force && profitPending?.key === key) return profitPending.promise;
  if (!force && profitSnapshot && profitScope === scope && JSON.stringify(profitSnapshot.filter) === JSON.stringify(filter)) {
    updatevutratuTable(); return;
  }
  if (force) profitReader.clear();
  const generation = ++profitLoadGeneration;
  profitScope = scope;
  if (!preserveRows) { profitSnapshot = null; profitShown = accountingInitialRows('vutratu-tbody'); vutratuData = []; filteredvutratuData = []; profitScroll.reset(); }
  profitBusy = true; updatevutratuTable();
  const current = () => generation === profitLoadGeneration && key === profitCurrentKey();
  const promise = (async () => {
    try {
      const snapshot = await profitReader.read(filter, scope, false, current);
      if (!current()) return;
      applyProfitSnapshot(snapshot);
      profitReadNeedsRefresh = false;
    } catch (error) { if (current()) { reportProfitError(error); profitReadNeedsRefresh = true; profitScroll.pause(); } }
    finally { if (generation === profitLoadGeneration) { profitBusy = false; updatevutratuTable(); } }
  })();
  profitPending = {key, promise};
  try { await promise; } finally { if (profitPending?.promise === promise) profitPending = null; }
}
async function loadMoreProfitRows(): Promise<void> {
  if (profitBusy || !profitSnapshot || profitExportPending || profitMutationBusy || profitReadNeedsRefresh) return;
  const generation = profitLoadGeneration, snapshot = profitSnapshot;
  const key = JSON.stringify([profitScope, snapshot.filter]);
  const current = () => generation === profitLoadGeneration && key === profitCurrentKey();
  if (!current()) return;
  if (profitShown < vutratuData.length) { profitShown += 10; updatevutratuTable(); return; }
  if (!snapshot.more) return;
  profitBusy = true; updatevutratuTable();
  try {
    const next = await profitReader.read(snapshot.filter, profitScope, true, current);
    if (!current()) return;
    applyProfitSnapshot(next); profitShown += 10;
  } catch (error) { if (current()) reportProfitError(error); throw error; }
  finally { if (generation === profitLoadGeneration) { profitBusy = false; updatevutratuTable(); } }
}
const profitScroll = createAccountingScroll('vutratu-tbody', loadMoreProfitRows);

/** Only an explicit export loads the remaining report pages. */
export async function withProfitExport(download: () => void): Promise<void> {
  if (profitExportPending || profitMutationBusy) return;
  profitExportPending = true;
  try { await exportProfitRows(download); }
  finally { profitExportPending = false; }
}
async function exportProfitRows(download: () => void): Promise<void> {
  const requestedKey = profitCurrentKey();
  await loadvutratuFromDatabase();
  if (!profitSnapshot || requestedKey !== profitCurrentKey()) return;
  const generation = profitLoadGeneration;
  const key = JSON.stringify([profitScope, profitSnapshot.filter]);
  const current = () => generation === profitLoadGeneration && key === profitCurrentKey();
  const shown = profitShown;
  profitBusy = true; updatevutratuTable();
  try {
    while (profitSnapshot.more) {
      const next = await profitReader.read(profitSnapshot.filter, profitScope, true, current);
      if (!current()) throw new DOMException('Пошук змінився', 'AbortError');
      applyProfitSnapshot(next);
    }
    if (!current()) return;
    profitExporting = true;
    withAccountingExportRows('vutratu-table', updatevutratuTable, download);
  } catch (error) { if (current()) reportProfitError(error); }
  finally {
    profitExporting = false;
    if (current()) { profitShown = shown; profitBusy = false; updatevutratuTable(); }
  }
}

const expenseColumns = 'vutratu_id,dataOnn,dataOff,kategoria,act,opys_vytraty,suma,sposob_oplaty,prymitky,xto_zapusav';
function applyExpenseReceipt(expense: ExpenseRecordLocal, row: any): void {
  Object.assign(expense, {id: row.vutratu_id, date: getKyivDate(row.dataOnn) || String(row.dataOnn).slice(0,10),
    category: addEmojiToCategory(String(row.kategoria || '')), description: row.opys_vytraty,
    amount: Number(row.suma), paymentMethod: addEmojiToPaymentMethod(String(row.sposob_oplaty || '')),
    notes: row.prymitky || undefined, isPaid: !!row.dataOff, paymentDate: getKyivDate(row.dataOff) || null,
    rosraxovanoDate: row.dataOff || null, createdBy: row.xto_zapusav || undefined, xto_rozraxuvav: row.xto_zapusav || undefined});
}
function rememberProfitWrite(actsChanged = false): void {
  resetProfitReport();
  announceAccountingChange(actsChanged ? ['profit','payroll'] : ['profit'], ['profit']);
}
async function saveExpenseToDatabase(expense: ExpenseRecordLocal, isNew = true, previous?: ExpenseRecordLocal): Promise<boolean> {
  try {
    const values: Record<string, any> = {kategoria: removeEmoji(expense.category), act: expense.actNumber ?? null,
      opys_vytraty: expense.description, suma: -Math.abs(Number(expense.amount || 0)),
      sposob_oplaty: removeEmoji(String(expense.paymentMethod)), prymitky: expense.notes || null};
    if (isNew) { values.dataOnn = expense.date + 'T00:00:00'; values.xto_zapusav = getCurrentUserName(); }
    else if (previous) {
      const old: Record<string, any> = {kategoria: removeEmoji(previous.category), act: previous.actNumber ?? null,
        opys_vytraty: previous.description, suma: -Math.abs(Number(previous.amount || 0)),
        sposob_oplaty: removeEmoji(String(previous.paymentMethod)), prymitky: previous.notes || null};
      for (const key of Object.keys(values)) if (values[key] === old[key]) delete values[key];
      if (expense.date !== previous.date) values.dataOnn = expense.date + 'T00:00:00';
    }
    if (!isNew && !Object.keys(values).length) return true;
    const query = isNew ? supabase.from('vutratu').insert(values) : supabase.from('vutratu').update(values).eq('vutratu_id', expense.id);
    const {data, error} = await query.select(expenseColumns).single();
    if (error) throw error;
    applyExpenseReceipt(expense, data); return true;
  } catch (error: any) { showNotification('Помилка збереження витрати: ' + (error?.message || ''), 'error', 7000); return false; }
}

// ==================== ІНІЦІАЛІЗАЦІЯ ====================

export async function initializevutratuData(): Promise<void> {
  resetProfitReport(true);
  vutratuData = [];
  filteredvutratuData = [];
  createExpenseCategorySelect();
  createPaymentMethodSelect();
  createExpensePaymentToggle();
  createExpenseDiscountToggle();
  createExpenseTypeToggle();
  createExpenseStatusToggle(); // Додати цю функцію

  // Додати слухачі для всіх фільтрів
  const categorySelect = byId<HTMLSelectElement>("Bukhhalter-vutratu-category");
  const paymentMethodSelect = byId<HTMLSelectElement>(
    "Bukhhalter-vutratu-payment-method",
  );

  const dateFromInput = byId<HTMLInputElement>("Bukhhalter-vutratu-date-from");
  const dateToInput = byId<HTMLInputElement>("Bukhhalter-vutratu-date-to");

  if (categorySelect) {
    categorySelect.addEventListener("change", () => {
      filtervutratuData();
    });
  }

  if (paymentMethodSelect) {
    paymentMethodSelect.addEventListener("change", () => {
      filtervutratuData();
    });
  }

  // ✅ Додаємо слухачі для зміни дати - ПЕРЕЗАВАНТАЖУЄМО з бази
  if (dateFromInput) {
    dateFromInput.addEventListener("change", () => {
      searchvutratuFromDatabase();
    });
  }

  if (dateToInput) {
    dateToInput.addEventListener("change", () => {
      searchvutratuFromDatabase();
    });
  }

  for (const id of ['include-client-description', 'include-car-notes']) {
    const checkbox = byId<HTMLInputElement>(id);
    if (checkbox && !checkbox.dataset.profitBound) {
      checkbox.dataset.profitBound = 'true'; checkbox.addEventListener('change', filtervutratuData);
    }
  }
  // ДОДАТИ В КІНЕЦЬ ФУНКЦІЇ:
  initvutratuDateFilterToggle();
}

function createExpenseTypeToggle(): void {
  const toggle = byId<HTMLInputElement>("vutratu-type-filter-toggle");
  if (!toggle) return;

  toggle.addEventListener("input", () => {
    filtervutratuData();
  });
}
// ==================== СТВОРЕННЯ СЕЛЕКТІВ ====================

function createExpenseCategorySelect(): void {
  const select = byId<HTMLSelectElement>("Bukhhalter-vutratu-category");
  if (!select) return;

  select.innerHTML = '<option value="">Оберіть категорію</option>';
  EXPENSE_CATEGORIES.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
}

function createPaymentMethodSelect(): void {
  const select = byId<HTMLSelectElement>("Bukhhalter-vutratu-payment-method");
  if (!select) return;

  select.innerHTML = '<option value="">Оберіть спосіб оплати</option>';
  PAYMENT_METHODS.forEach((method) => {
    const option = document.createElement("option");
    option.value = method;
    option.textContent = method;
    select.appendChild(option);
  });
}

export function createExpensePaymentToggle(): void {
  const toggle = byId<HTMLInputElement>("vutratu-payment-filter-toggle");
  if (!toggle) return;

  toggle.addEventListener("input", () => {
    filtervutratuData();
  });
}

export function createExpenseDiscountToggle(): void {
  const toggle = byId<HTMLInputElement>("vutratu-discount-filter-toggle");
  if (!toggle) return;

  toggle.addEventListener("input", () => {
    filtervutratuData();
  });
}

function createExpenseStatusToggle(): void {
  const toggle = byId<HTMLInputElement>("vutratu-status-filter-toggle");
  if (!toggle) return;

  toggle.addEventListener("input", () => {
    filtervutratuData();
  });
}

// ==================== ФІЛЬТРАЦІЯ ====================

export function filtervutratuData(): void {
  if (!profitFilter()) { resetProfitReport(); updatevutratuTable(); return; }
  void loadvutratuFromDatabase();
}

export async function searchvutratuFromDatabase(): Promise<void> {
  if (!readAccountingPeriod("vutratu")) {
    resetProfitReport(); updatevutratuTable();
    return;
  }
  // 🔐 Перевіряємо доступ до сторінки перед пошуком
  const hasAccess = await checkCurrentPageAccess();

  if (!hasAccess) {
    redirectToIndex();
    return;
  }

  await loadvutratuFromDatabase(false);
}

// ==================== ТАБЛИЦЯ ====================



export function updatevutratuTable(): void {
  const tbody = byId<HTMLTableSectionElement>("vutratu-tbody");
  if (!tbody) return;

  const visibleRows = profitExporting ? filteredvutratuData : accountingVisibleRows(filteredvutratuData, profitShown);
  if (!profitExporting) profitScroll.update({more: !profitReadNeedsRefresh && !!profitSnapshot && (profitShown < filteredvutratuData.length || profitSnapshot.more),
    busy: profitBusy || profitMutationBusy, shown: visibleRows.length, total: profitSnapshot?.summary.count});
  const staging = document.createElement("tbody");

  if (filteredvutratuData.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="11" class="Bukhhalter-no-data">Немає витрат для відображення</td></tr>';
    updatevutratuDisplayedSums();
    return;
  }

  visibleRows.forEach((expense, index) => {
    const row = staging.insertRow();

    const isNegative = expense.amount < 0;
    const isFromAct = expense.category === "💰 Прибуток";

    // Перевіряємо дату закриття (paymentDate) замість isPaid
    const isOpenAct = isFromAct && !expense.paymentDate;

    row.className = isOpenAct
      ? "open-row"
      : isNegative
        ? "negative-row"
        : "positive-row";

    // 💰 Розраховано - показуємо дату витрати або розрахунку акту
    const paymentCell = row.insertCell();

    if (isFromAct) {
      // Логіка для актів залишається без змін
      if (expense.isPaid) {
        const calculatorName = expense.xto_rozraxuvav || "Невідомо";

        let formattedDate = formatDateKyiv(expense.rosraxovanoDate);

        paymentCell.innerHTML = `
          <button class="Bukhhalter-payment-btn paid" 
                  onclick="event.stopPropagation(); toggleActPayment(${index})" 
                  title="Скасувати розрахунок">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 2px 0;">
              <span style="font-size: 0.95em; color: #333;">🧑‍💻 ${calculatorName}</span>
              <span style="font-size: 0.85em; color: #555;">📅 ${formattedDate}</span>
            </div>
          </button>
        `;
      } else {
        paymentCell.innerHTML = `
          <button class="Bukhhalter-payment-btn unpaid" 
                  onclick="event.stopPropagation(); toggleActPayment(${index})" 
                  title="Провести розрахунок">
            💲 Сума в касі
          </button>
        `;
      }
    } else {
      // Для витрат - показуємо дату витрати та хто створив
      if (expense.rosraxovanoDate) {
        const createdByText = expense.xto_rozraxuvav || "Система";

        let formattedDate = formatDateKyiv(expense.rosraxovanoDate);

        paymentCell.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 5px;">
            <span style="font-size: 0.75em; color: #333;">🧑‍💻 ${createdByText}</span>
            <span style="font-size: 0.70em; color: #555;">📅 ${formattedDate}</span>
          </div>
        `;
      } else {
        paymentCell.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: center; font-size: 11px; color: #999; padding: 5px;">
            -
          </div>
        `;
      }
    }

    // 📅 Відкриття
    const dateCell = row.insertCell();
    dateCell.textContent = formatDate(expense.date);

    // 📅 Закриття
    const dateCloseCell = row.insertCell();
    // Для актів показуємо дату закриття, для витрат - ту саму дату що і відкриття (для фільтрації)
    if (isFromAct) {
      dateCloseCell.textContent = expense.paymentDate
        ? formatDate(expense.paymentDate)
        : "-";
    } else {
      // Для витрат показуємо ту саму дату, що й у стовпці "Відкриття"
      dateCloseCell.textContent = formatDate(expense.date);
    }
    // 📂 Категорія
    const categoryCell = row.insertCell();
    categoryCell.textContent = expense.category;

    // 📋 Акт_№
    const actCell = row.insertCell();
    if (isFromAct && expense.actNumber) {
      actCell.innerHTML = `
        <button class="Bukhhalter-act-btn"
                onclick="event.stopPropagation(); openActModalWithClient(${
                  Number(expense.actNumber) || 0
                })"
                title="Відкрити акт №${expense.actNumber}">
          📋 ${expense.actNumber}
        </button>
      `;
    } else {
      actCell.textContent = expense.actNumber ? String(expense.actNumber) : "-";
    }

    // 📝 Опис
    const descriptionCell = row.insertCell();
    descriptionCell.style.whiteSpace = "pre-line";
    descriptionCell.style.fontSize = "0.9em";
    descriptionCell.textContent = expense.description;

    // 💵 Сума - спеціальне форматування для актів
    const amountCell = row.insertCell();

    if (
      isFromAct &&
      expense.detailsAmount !== undefined &&
      expense.workAmount !== undefined
    ) {
      // Знижка вже врахована в збережених значеннях detailsAmount і workAmount
      // Тому просто відображаємо їх без додаткових вирахувань
      let finalDetailsAmount = expense.detailsAmount;
      let finalWorkAmount = expense.workAmount;

      const detailsColor =
        finalDetailsAmount > 0
          ? "#28a745"
          : finalDetailsAmount < 0
            ? "#dc3545"
            : "#999";
      const workColor =
        finalWorkAmount > 0
          ? "#28a745"
          : finalWorkAmount < 0
            ? "#dc3545"
            : "#999";
      const detailsSign = finalDetailsAmount > 0 ? "+" : "";
      const workSign = finalWorkAmount > 0 ? "+" : "";

      // Показувати емодзі тільки якщо значення не дорівнює 0
      const detailsEmoji = finalDetailsAmount !== 0 ? "⚙️ " : "";
      const workEmoji = finalWorkAmount !== 0 ? "🛠️ " : "";

      amountCell.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
          <span style="color: ${detailsColor}; font-size: 0.95em; font-weight: 500; text-align: right;">
            ${detailsEmoji}${detailsSign}${formatNumber(finalDetailsAmount)}
          </span>
          <span style="color: ${workColor}; font-size: 0.95em; font-weight: 500; text-align: right;">
            ${workEmoji}${workSign}${formatNumber(finalWorkAmount)}
          </span>
        </div>
      `;
    } else {
      const color =
        expense.amount > 0
          ? "#28a745"
          : expense.amount < 0
            ? "#dc3545"
            : "#999";
      const sign = expense.amount > 0 ? "+" : "";
      amountCell.innerHTML = `<span style="color: ${color}; font-size: 0.95em; font-weight: 500;">${sign}${formatNumber(
        expense.amount,
      )}</span>`;
    }

    // � Сума в касі - показуємо повну суму з акту без вирахувань
    const fullAmountCell = row.insertCell();
    fullAmountCell.style.textAlign = "right";

    if (isFromAct && expense.fullAmount !== undefined) {
      const discount = expense.discount || 0;
      const discountVal = expense.discountAmount || 0;
      const finalVal = expense.fullAmount - discountVal;

      let html = `<span style="color: #006400; font-size: 0.95em; font-weight: 500;">
          ${formatNumber(expense.fullAmount)}
        </span>`;

      if (discount > 0) {
        html = `
            <div style="display: flex; flex-direction: column; align-items: flex-end;">
              <span style="color: #1a73e8; font-size: 0.95em; font-weight: 500;">
                ${formatNumber(expense.fullAmount)}
              </span>
              <div style="font-size: 0.85em; color: #d32f2f; margin-top: 2px;">
                🏷️${discount}% ${formatNumber(discountVal)}
              </div>
              <div style="font-size: 0.95em; font-weight: 700; color: #006400; margin-top: 2px; border-top: 1px solid #ddd; padding-top: 2px;">
                ${formatNumber(finalVal)}
              </div>
            </div>
          `;
      }

      fullAmountCell.innerHTML = html;
    } else {
      fullAmountCell.textContent = "-";
    }

    // 💳 Спосіб оплати
    const methodCell = row.insertCell();

    if (isFromAct && expense.tupOplatu) {
      // Для актів - відображаємо тип оплати з tupOplatu
      let paymentText = expense.tupOplatu;

      // Додаємо емодзі якщо їх немає
      if (
        !paymentText.includes("💵") &&
        !paymentText.includes("💳") &&
        !paymentText.includes("🏦")
      ) {
        if (paymentText.toLowerCase().includes("готівка")) {
          paymentText = "💵 " + paymentText;
        } else if (paymentText.toLowerCase().includes("картка")) {
          paymentText = "💳 " + paymentText;
        } else if (paymentText.toLowerCase().includes("iban")) {
          paymentText = "🏦 " + paymentText;
        }
      }

      const avansInfo =
        expense.paymentMethod && Number(expense.paymentMethod) > 0
          ? `<br><span style="color: #000; font-weight: 600; font-size: 0.95em;">💰 ${formatNumber(
              Number(expense.paymentMethod),
            )}</span>`
          : "";
      methodCell.innerHTML = `
        <span style="font-size: 0.95em;">
          ${paymentText}${avansInfo}
        </span>
      `;
    } else if (
      isFromAct &&
      expense.paymentMethod &&
      Number(expense.paymentMethod) > 0
    ) {
      // Для актів з авансом - відображаємо чорним
      methodCell.innerHTML = `
        <span style="color: #000; font-weight: 600; font-size: 0.95em;">
          💰 ${formatNumber(Number(expense.paymentMethod))}
        </span>
      `;
    } else if (isFromAct) {
      // Для актів без авансу та без типу оплати
      methodCell.textContent = "-";
    } else {
      // Для витрат - показуємо спосіб оплати
      methodCell.textContent = String(expense.paymentMethod);
    }

    // 📋 Примітки
    const notesCell = row.insertCell();
    notesCell.style.whiteSpace = "pre-line";
    notesCell.style.fontSize = "0.85em";
    notesCell.textContent = expense.notes || "-";

    // ⚡ Дії
    const actionsCell = row.insertCell();
    if (expense.id > 0) {
      actionsCell.innerHTML = `
        <button class="Bukhhalter-delete-btn" onclick="event.stopPropagation(); deleteExpenseRecord(${index})" title="Видалити">🗑️</button>
      `;
    } else {
      actionsCell.innerHTML = `
        <button class="Bukhhalter-delete-btn" onclick="event.stopPropagation(); deleteExpenseRecord(${index})" title="Видалити з відображення">🗑️</button>
      `;
    }


  });

  setAccountingRows(tbody, staging.innerHTML);
  Array.from(tbody.rows).forEach((row, index) => {
    row.onclick = event => {
      const expense = visibleRows[index];
      if (expense.id > 0 && expense.amount < 0) selectExpenseRow(index, event);
    };
  });
  updatevutratuDisplayedSums();
}

// ==================== СУМИ ====================

export function calculatevutratuTotalSum(): number {
  return profitSnapshot?.summary.amount || 0;
}

export function updatevutratuDisplayedSums(): void {
  // A slow request for a hidden tab must not replace another report's footer.
  if (document.querySelector<HTMLElement>('.Bukhhalter-control-section')?.dataset.activeTab !== 'vutratu') return;
  const totalSumElement = byId("total-sum");
  if (!totalSumElement) return;

  const summary = profitSnapshot?.summary;
  const totalNegativeSum = summary?.negative || 0;
  const totalAvansSum = summary?.advances || 0;
  const totalNetDetailsProfit = summary?.detailsProfit || 0;
  const totalNetWorkProfit = summary?.workProfit || 0;
  const totalNetFullDetails = summary?.cashDetails || 0;
  const totalNetFullWork = summary?.cashWork || 0;
  const totalDiscountSum = summary?.discount || 0;

  // Фінальні суми
  // Каса = (Залишок Деталі + Залишок Робота + Всі Аванси) + Витрати (від'ємні)
  // ВАЖЛИВО: totalNegativeSum НЕ включає акти, тільки реальні витрати
  const finalSumCasa =
    totalNetFullDetails + totalNetFullWork + totalAvansSum + totalNegativeSum;

  // Прибуток = (Чиста Маржа Деталі + Чиста Маржа Робота) - Витрати
  const finalSumProfit =
    totalNetDetailsProfit + totalNetWorkProfit + totalNegativeSum;

  totalSumElement.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; gap: 10px; font-size: 1.1em;">
      <div style="display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 15px;">
        <span>Каса</span>
        <span><strong style="color: #1E90FF;">⚙️ ${formatNumber(
          totalNetFullDetails,
        )}</strong></span>
        <span style="color: #666;">+</span>
        <span><strong style="color: #FF8C00;">🛠️ ${formatNumber(
          totalNetFullWork,
        )}</strong></span>
        <span style="color: #666;">+</span>
        <span><strong style="color: #000;">💰 ${formatNumber(
          totalAvansSum,
        )}</strong></span>${
          totalNegativeSum !== 0
            ? `
        <span style="color: #666;">+</span>
        <span><strong style="color: #8B0000;">💶 ${formatNumber(
          totalNegativeSum,
        )}</strong></span>`
            : ""
        }
        <span style="color: #666;">=</span>
        <span><strong style="color: ${
          finalSumCasa >= 0 ? "#006400" : "#8B0000"
        };">📈 ${formatNumber(finalSumCasa)}</strong> грн</span>
      </div>
      <div style="display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 15px;">
        <span>Прибуток</span>
        <span><strong style="color: #1E90FF;">⚙️ ${formatNumber(
          totalNetDetailsProfit,
        )}</strong></span>
        <span style="color: #666;">+</span>
        <span><strong style="color: #FF8C00;">🛠️ ${formatNumber(
          totalNetWorkProfit,
        )}</strong></span>${
          totalNegativeSum !== 0
            ? `
        <span style="color: #666;">+</span>
        <span><strong style="color: #8B0000;">💶 ${formatNumber(
          totalNegativeSum,
        )}</strong></span>`
            : ""
        }
        <span style="color: #666;">=</span>
        <span><strong style="color: ${
          finalSumProfit >= 0 ? "#006400" : "#8B0000"
        };">📈 ${formatNumber(finalSumProfit)}</strong> грн</span>
        
        <span style="color: #ccc; margin-left: 10px;">|</span>
        
        <span>Знижки</span>
        <span><strong style="color: #c62828;">🏷️ ${formatNumber(
          totalDiscountSum,
        )}</strong> грн</span>
      </div>
    </div>
  `;
}

// ==================== CRUD ОПЕРАЦІЇ ====================

async function handleAddExpense(
  date: string,
  category: string,
  description: string,
  amount: number,
  paymentMethod: string,
  notes: string,
): Promise<void> {
  setSaveButtonLoading(true);

  try {
    const newExpense: ExpenseRecordLocal = {
      id: 0,
      date,
      category,
      description,
      amount,
      paymentMethod,
      isPaid: false,
      notes: notes || undefined,
      actNumber: undefined,
    };

    const success = await saveExpenseToDatabase(newExpense, true);
    if (success) {
      vutratuData.push(newExpense); rememberProfitWrite();
      filtervutratuData();
      showNotification("✅ Витрату додано", "success");
      closeExpenseModal();
    }
  } finally {
    setSaveButtonLoading(false);
  }
}

async function handleEditExpense(
  date: string,
  category: string,
  description: string,
  amount: number,
  paymentMethod: string,
  notes: string,
): Promise<void> {
  if (selectedExpenseId === null) {
    showNotification("⚠️ Витрата для редагування не вибрана", "warning");
    return;
  }

  const expense = vutratuData.find((e) => e.id === selectedExpenseId);
  if (!expense) {
    showNotification("⚠️ Витрата не знайдена", "warning");
    return;
  }

  setSaveButtonLoading(true);

  try {
    const previous = structuredClone(expense);
    const draft = {...expense};
    draft.date = date;
    draft.category = category;
    draft.description = description;
    draft.amount = amount;
    draft.paymentMethod = paymentMethod;
    draft.notes = notes || undefined;

    const success = await saveExpenseToDatabase(draft, false, previous);
    if (success) {
      Object.assign(expense, draft); rememberProfitWrite();
      filtervutratuData();
      showNotification("✅ Витрату оновлено", "success");
      closeExpenseModal();
      selectedExpenseId = null;
    }
  } finally {
    setSaveButtonLoading(false);
  }
}

async function handleDeleteExpense(): Promise<void> {
  if (selectedExpenseId === null) {
    showNotification("⚠️ Витрата для видалення не вибрана", "warning");
    return;
  }

  const expenseIndex = vutratuData.findIndex((e) => e.id === selectedExpenseId);
  if (expenseIndex === -1) {
    showNotification("⚠️ Витрата не знайдена", "warning");
    return;
  }

  const expense = vutratuData[expenseIndex];

  setSaveButtonLoading(true);

  try {
    const { error } = await supabase
      .from("vutratu")
      .delete()
      .eq("vutratu_id", expense.id);

    if (error) {
      // console.error("❌ Помилка видалення з БД:", error);
      showNotification("❌ Помилка видалення з бази даних", "error");
      return;
    }

    vutratuData.splice(expenseIndex, 1);
    rememberProfitWrite();
    filtervutratuData();

    showNotification("✅ Витрату видалено з бази даних", "success", 2000);
    closeExpenseModal();
    selectedExpenseId = null;
  } catch (error) {
    // console.error("❌ Критична помилка видалення:", error);
    showNotification("❌ Не вдалося видалити витрату", "error");
  } finally {
    setSaveButtonLoading(false);
  }
}

export function deleteExpenseRecord(index: number): void {
  if (profitMutationBusy || isAccountingPaymentBusy()) return;
  const expense = filteredvutratuData[index];
  if (!expense) return;
  profitHiddenIds.add(expense.id);
  filtervutratuData();
  showNotification("🗑️ Запис приховано з відображення", "info", 2000);
}

function selectExpenseRow(index: number, event?: MouseEvent): void {
  const expense = filteredvutratuData[index];
  if (!expense) return;

  if (
    event &&
    (event.target as HTMLElement).closest(".Bukhhalter-delete-btn")
  ) {
    return;
  }

  if (expense.amount >= 0) {
    showNotification(
      "⚠️ Редагування доступне тільки для витрат",
      "warning",
      2000,
    );
    return;
  }

  selectedExpenseId = expense.id;
  setExpenseMode("edit");

  // 1) Спочатку відкрити модалку → populate* створять <option>
  openExpenseModal();

  // 2) Тепер безпечно ставити значення – опції вже існують
  byId<HTMLInputElement>("expense-modal-date").value = expense.date;
  byId<HTMLSelectElement>("expense-modal-category").value = expense.category;
  byId<HTMLSelectElement>("expense-modal-payment-method").value =
    expense.paymentMethod;
  byId<HTMLInputElement>("expense-modal-amount").value = Math.abs(
    expense.amount,
  ).toString();
  byId<HTMLTextAreaElement>("expense-modal-description").value =
    expense.description;
  byId<HTMLTextAreaElement>("expense-modal-notes").value = expense.notes || "";

  // 3) Формат суми
  const amountInput = byId<HTMLInputElement>("expense-modal-amount");
  if (amountInput) formatAmountWithSpaces(amountInput);
}

// ==================== ФОРМА ====================

export function clearvutratuForm(): void {
  resetProfitReport(true);
  byId<HTMLInputElement>("Bukhhalter-vutratu-date-from").value = "";
  byId<HTMLInputElement>("Bukhhalter-vutratu-date-to").value = "";
  byId<HTMLSelectElement>("Bukhhalter-vutratu-category").value = "";
  byId<HTMLSelectElement>("Bukhhalter-vutratu-payment-method").value = "";
  byId<HTMLInputElement>("vutratu-payment-filter-toggle").value = "2";
  byId<HTMLInputElement>("vutratu-discount-filter-toggle").value = "2";
  vutratuData = [];
  filteredvutratuData = [];
  updatevutratuTable();
}

export async function runMassPaymentCalculationForvutratu(): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    if (profitMutationBusy || profitExportPending || profitBusy) return;
    if (profitReadNeedsRefresh) { showNotification('Натисніть «Пошук», щоб оновити звіт перед розрахунком.', 'warning'); return; }
    const snapshot = profitSnapshot, generation = profitLoadGeneration;
    const key = profitCurrentKey(), actor = getCurrentUserName(), scope = profitScope;
    if (!snapshot || !key || JSON.stringify([scope, snapshot.filter]) !== key) {
      showNotification('Спочатку оновіть звіт для поточного періоду.', 'warning'); return;
    }
    const current = () => generation === profitLoadGeneration && key === profitCurrentKey()
      && scope === profitScope && actor === getCurrentUserName() && profitSnapshot?.revision === snapshot.revision;
    profitBusy = true; updatevutratuTable();
    try {
      // Payment covers the complete filtered result, including pages not reached by scrolling.
      while (profitSnapshot!.more) {
        const next = await profitReader.read(snapshot.filter, scope, true, current);
        if (!current()) return;
        if (next.revision !== snapshot.revision) throw new Error('ACCOUNTING_REPORT_STALE');
        applyProfitSnapshot(next);
      }
      if (!current()) return;
      if (profitSnapshot!.rows.length !== profitSnapshot!.summary.count) throw new Error('ACCOUNTING_REPORT_STALE');
    } catch (error) {
      if (current()) reportProfitError(error);
      return;
    } finally {
      if (generation === profitLoadGeneration) { profitBusy = false; updatevutratuTable(); }
    }
    if (!current()) return;
    const rows = filteredvutratuData.filter(row => !row.isPaid);
    if (!rows.length) { showNotification('Немає неоплачених записів за поточним фільтром.', 'info'); return; }
    await settleProfitRows(rows, 'pay');
  });
}

// ==================== МОДАЛЬНЕ ВІКНО ====================

export function openExpenseModal(): void {
  const modal = byId<HTMLDivElement>("expense-modal");
  if (!modal) return;

  // 1) Спочатку опції (щоб <select> мав варіанти до будь-яких .value)
  populateModalCategorySelect();
  populateModalPaymentMethodSelect();

  // 2) Очищення тільки для "add"
  if (currentExpenseMode === "add") {
    selectedExpenseId = null;
    const today = new Date().toISOString().split("T")[0];
    byId<HTMLInputElement>("expense-modal-date").value = today;
    byId<HTMLSelectElement>("expense-modal-category").value = "";
    byId<HTMLSelectElement>("expense-modal-payment-method").value = "";
    byId<HTMLInputElement>("expense-modal-amount").value = "";
    byId<HTMLTextAreaElement>("expense-modal-description").value = "";
    byId<HTMLTextAreaElement>("expense-modal-notes").value = "";
  }

  modal.style.display = "flex";
}

export function closeExpenseModal(): void {
  const modal = byId<HTMLDivElement>("expense-modal");
  if (!modal) return;
  modal.style.display = "none";
  selectedExpenseId = null;
  setExpenseMode("add");
}

function populateModalCategorySelect(): void {
  const select = byId<HTMLSelectElement>("expense-modal-category");
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="">Оберіть категорію</option>';
  EXPENSE_CATEGORIES.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  if (currentValue) select.value = currentValue;
}

function populateModalPaymentMethodSelect(): void {
  const select = byId<HTMLSelectElement>("expense-modal-payment-method");
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="">Оберіть спосіб оплати</option>';
  PAYMENT_METHODS.forEach((method) => {
    const option = document.createElement("option");
    option.value = method;
    option.textContent = method;
    select.appendChild(option);
  });
  if (currentValue) select.value = currentValue;
}

export async function saveExpenseFromModal(): Promise<void> {
  if (profitMutationBusy || isAccountingPaymentBusy()) return;
  const mode = getCurrentExpenseMode();
  const date = byId<HTMLInputElement>("expense-modal-date")?.value || "";
  const category =
    byId<HTMLSelectElement>("expense-modal-category")?.value || "";
  const description =
    byId<HTMLTextAreaElement>("expense-modal-description")?.value || "";
  const amountStr = byId<HTMLInputElement>("expense-modal-amount")?.value || "";
  const paymentMethod =
    byId<HTMLSelectElement>("expense-modal-payment-method")?.value || "";
  const notes = byId<HTMLTextAreaElement>("expense-modal-notes")?.value || "";

  const amount = parseFloat(amountStr.replace(/\s/g, ""));

  if (!date) {
    showNotification("⚠️ Введіть дату", "warning");
    return;
  }

  if (!category) {
    showNotification("⚠️ Оберіть категорію", "warning");
    return;
  }

  if (!paymentMethod) {
    showNotification("⚠️ Оберіть спосіб оплати", "warning");
    return;
  }

  if (!description) {
    showNotification("⚠️ Введіть опис витрати", "warning");
    return;
  }

  if (!amount || amount <= 0 || isNaN(amount)) {
    showNotification("⚠️ Введіть коректну суму більше 0", "warning");
    return;
  }

  profitMutationBusy = true;
  try { switch (mode) {
    case "add":
      await handleAddExpense(
        date,
        category,
        description,
        amount,
        paymentMethod,
        notes,
      );
      break;
    case "edit":
      await handleEditExpense(
        date,
        category,
        description,
        amount,
        paymentMethod,
        notes,
      );
      break;
    case "delete":
      await handleDeleteExpense();
      break;
  } } finally { profitMutationBusy = false; }
}

// A password confirmation applies only to the captured rows and actor.
async function settleProfitRows(rows: ExpenseRecordLocal[], action: 'pay' | 'unpay'): Promise<void> {
  if (profitMutationBusy || profitExportPending || profitBusy) return;
  if (profitReadNeedsRefresh) { showNotification('Натисніть «Пошук», щоб оновити звіт перед розрахунком.', 'warning'); return; }
  const snapshot = profitSnapshot, generation = profitLoadGeneration;
  const key = profitCurrentKey(), actor = getCurrentUserName();
  if (!snapshot || !key || JSON.stringify([profitScope, snapshot.filter]) !== key) {
    showNotification('Спочатку оновіть звіт для поточного періоду.', 'warning'); return;
  }
  if (rows.length > 1000 || rows.some(row => !/^[0-9a-f]{32}$/.test(row.paymentBaseline || ''))) {
    showNotification(rows.length > 1000 ? 'Звузьте період: один розрахунок підтримує до 1000 неоплачених записів за поточним фільтром.' : 'Оновіть SQL бухгалтерії та повторіть пошук перед розрахунком.', 'warning'); return;
  }
  const selected = rows.map(row => ({id: row.id, baseline: row.paymentBaseline!, expected_paid: row.rosraxovanoDate || null, expected_actor: row.xto_rozraxuvav ?? null}));
  const selection = JSON.stringify(selected);
  const current = () => generation === profitLoadGeneration && key === profitCurrentKey() && profitSnapshot === snapshot && actor === getCurrentUserName()
    && selection === JSON.stringify(rows.map(row => ({id: row.id, baseline: row.paymentBaseline!, expected_paid: row.rosraxovanoDate || null, expected_actor: row.xto_rozraxuvav ?? null})))
    && rows.every(row => filteredvutratuData.includes(row));
  let submitted = false;
  profitMutationBusy = true; updatevutratuTable();
  try {
    const amount = rows.reduce((sum, row) => sum + Number(row.category === '💰 Прибуток' ? Number(row.fullAmount || 0) - Number(row.discountAmount || 0) : row.amount), 0);
    const summary = rows.length === 1 ? 'Акт №' + Math.abs(rows[0].id) + ', сума в касі ' + formatNumber(amount) + ' грн'
      : rows.length + ' неоплачених записів за поточним фільтром, сума в касі з витратами ' + formatNumber(amount) + ' грн';
    const confirmed = await confirmAccountingPayment(action, summary, current);
    if (!confirmed) return;
    if (!current()) { showNotification('Звіт змінився. Повторіть підтвердження розрахунку.', 'warning'); return; }
    const paidAt = action === 'pay' ? getCurrentUkrainianTime() : null;
    submitted = true;
    const {data, error} = await supabase.rpc('traffic_profit_payment_rows', {p_rows: selected, p_paid_at: paidAt, p_actor: actor});
    if (error) throw missingAccountingRpc('traffic_profit_payment_rows', error);
    if (data?.updated_count !== selected.length || !Array.isArray(data.rows) || data.rows.length !== selected.length ||
      new Set(data.rows.map((row: any) => row.id)).size !== selected.length ||
      data.rows.some((row: any) => !selected.some(item => item.id === row.id) || (action === 'pay' ? !row.paid_at : row.paid_at !== null)))
      throw new Error('Не вдалося підтвердити результат розрахунку. Оновіть звіт.');
    announceAccountingChange(['profit','payroll'], ['profit']);
    if (!current()) { profitReader.clear(); return; }
    for (const receipt of data.rows) {
      const row = rows.find(item => item.id === receipt.id)!;
      row.isPaid = !!receipt.paid_at; row.rosraxovanoDate = receipt.paid_at; row.xto_rozraxuvav = receipt.actor || undefined;
    }
    // The report fingerprint includes paid dates: refresh one bounded page + totals.
    // Retain rows on screen while the response is in flight; no automatic payment retry.
    await loadvutratuFromDatabase(true, true);
    if (actor === getCurrentUserName() && key === profitCurrentKey()) showNotification(profitReadNeedsRefresh
      ? 'Розрахунок збережено. Натисніть «Пошук», щоб оновити підсумки.'
      : action === 'pay' ? 'Розраховано ' + selected.length + ' записів.' : 'Розрахунок скасовано.', profitReadNeedsRefresh ? 'warning' : 'success');
  } catch (error) {
    const wasCurrent = current();
    if (submitted) announceAccountingChange(['profit','payroll'], ['profit']);
    if (!wasCurrent) return;
    reportProfitError(error);
    if (submitted) await loadvutratuFromDatabase(true, true);
  } finally { profitMutationBusy = false; updatevutratuTable(); }
}

async function toggleActPayment(index: number): Promise<void> {
  await withAccountingPaymentOperation(async () => {
    const expense = filteredvutratuData[index];
    if (!expense || expense.category !== '💰 Прибуток') { showNotification('Це не акт.', 'warning'); return; }
    await settleProfitRows([expense], expense.isPaid ? 'unpay' : 'pay');
  });
}

export function getFilteredvutratuData(): ExpenseRecordLocal[] {
  return filteredvutratuData;
}

// ==================== ГЛОБАЛІЗАЦІЯ ====================

(window as any).openExpenseModal = openExpenseModal;
(window as any).closeExpenseModal = closeExpenseModal;
(window as any).saveExpenseFromModal = saveExpenseFromModal;
(window as any).deleteExpenseRecord = deleteExpenseRecord;
(window as any).updatevutratuDisplayedSums = updatevutratuDisplayedSums;
(window as any).cycleExpenseMode = cycleExpenseMode;
(window as any).setExpenseMode = setExpenseMode;
(window as any).formatAmountWithSpaces = formatAmountWithSpaces;
(window as any).autoResizeTextarea = autoResizeTextarea;
(window as any).getCurrentExpenseMode = getCurrentExpenseMode;
(window as any).searchvutratuFromDatabase = searchvutratuFromDatabase;
(window as any).toggleActPayment = toggleActPayment;
