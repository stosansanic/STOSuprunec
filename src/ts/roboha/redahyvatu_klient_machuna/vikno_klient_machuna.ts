// src/ts/roboha/redahyvatu_klient_machuna/vikno_klient_machuna.ts
import { supabase } from "../../vxid/supabaseClient";
import "../../../scss/main.scss";
import { saveClientAndCarToDatabase } from "./pidtverdutu_sberihannya_PIB_avto";
import autoData from "./auto.json";
import { createClientFormOptions } from "./clientFormOptions";
import { mountClientFormDropdown } from "./clientFormDropdown";

import {
  createSavePromptModal,
  showSavePromptModal,
  savePromptModalId,
  cancelSavePromptModal,
} from "./pidtverdutu_sberihannya_PIB_avto";
import { setupEnterNavigation } from "./enter_navigation";
import {
  saveModalIdCreate,
  createSaveModalCreate,
  showSaveModalCreate,
  cancelSaveModalCreate,
  isActCreatePending,
} from "./pidtverdutu_sberihannya_zakaz_naryad";

// Функція для форматування телефонного номера
function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("380")) {
    const number = digits.slice(3);
    if (number.length === 0) return "+380";
    if (number.length <= 2) return `+380(${number}`;
    if (number.length <= 5)
      return `+380(${number.slice(0, 2)})${number.slice(2)}`;
    if (number.length <= 7)
      return `+380(${number.slice(0, 2)})${number.slice(2, 5)}-${number.slice(
        5,
      )}`;
    return `+380(${number.slice(0, 2)})${number.slice(2, 5)}-${number.slice(
      5,
      7,
    )}-${number.slice(7, 9)}`;
  }
  if (digits.length === 0) return "+380";
  if (digits.length <= 2) return `+380(${digits}`;
  if (digits.length <= 5)
    return `+380(${digits.slice(0, 2)})${digits.slice(2)}`;
  if (digits.length <= 7)
    return `+380(${digits.slice(0, 2)})${digits.slice(2, 5)}-${digits.slice(
      5,
    )}`;
  return `+380(${digits.slice(0, 2)})${digits.slice(2, 5)}-${digits.slice(
    5,
    7,
  )}-${digits.slice(7, 9)}`;
}

export function getModalFormValues() {
  // Оновлено: тепер підтримує і Input, і Textarea
  const get = (id: string) =>
    (
      document.getElementById(id) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null
    )?.value || "";
  const phoneValue = get(phoneInputId);
  return {
    client_id: selectedClientId,
    cars_id: selectedCarId,
    fullName: get(clientInputId),
    phone: phoneValue,
    carModel: get(carModelInputId),
    carCode: get(carCodeInputId).toUpperCase(),
    carNumber: get(carNumberInputId).toUpperCase(),
    engine: get(carEngineInputId),
    fuel: get(carFuelInputId),
    vin: get(carVinInputId).toUpperCase(),
    income: get(carIncomeInputId),
    extra: get(extraInputId),
    year: get(carYearInputId),
  };
}

export const modalOverlayId = "custom-modal-create-sakaz_narad";
const modalClass = "modal-content-create-sakaz_narad";
const modalCloseBtnId = "close-create-sakaz_narad";
const btnEditId = "btn-edit-create-sakaz_narad";
const clientInputId = "client-input-create-sakaz_narad";
const clientListId = "client-list-create-sakaz_narad";
const carModelInputId = "car-model-create-sakaz_narad";
const carModelListId = "car-model-list-create-sakaz_narad";
const phoneInputId = "phone-create-sakaz_narad";
const phoneListId = "phone-list-create-sakaz_narad";
const carNumberInputId = "car-number-input-create-sakaz_narad";
const carNumberListId = "car-number-list-create-sakaz_narad";
const carEngineInputId = "car-engine-create-sakaz_narad";
const carEngineListId = "car-engine-list-create-sakaz_narad";
const carFuelInputId = "car-fuel-create-sakaz_narad";
const carVinInputId = "car-vin-create-sakaz_narad";
const carVinListId = "car-vin-list-create-sakaz_narad";
const carIncomeInputId = "car-income-create-sakaz_narad";
const carIncomeListId = "car-income-list-create-sakaz_narad";
const extraInputId = "extra-create-sakaz_narad";
const btnSaveId = "btn-save-create-sakaz_narad";
const carYearInputId = "car-year-create-sakaz_narad";
const carCodeInputId = "car-code-create-sakaz_narad";
const carCodeListId = "car-code-list-create-sakaz_narad";
const btnCreateId = "btn-create-create-sakaz_narad";

let selectedClientId: string | null = null;
let selectedCarId: string | null = null;
export type ClientRecordBaseline = { client_id: string; data: Record<string, unknown> };
export type CarRecordBaseline = { cars_id: string; client_id: string; is_deleted: boolean | null; data: Record<string, unknown> };
export let clientRecordBaseline: ClientRecordBaseline | null = null;
export let carRecordBaseline: CarRecordBaseline | null = null;
let formMutationPending = false;
let formSelectionPending = false;
let mountedFormScope: string | null = null;
let refreshTransferredSelection: (() => void) | null = null;
// IDs, зафіксовані після успішного збереження — захищені від переписування автокомплетом
let lastSavedClientId: string | null = null;
let lastSavedCarId: string | null = null;

function clearLastSavedIds() {
  lastSavedClientId = null;
  lastSavedCarId = null;
}

export function clearModalSelectionState() {
  selectedClientId = null;
  selectedCarId = null;
  clientRecordBaseline = null;
  carRecordBaseline = null;
  clearLastSavedIds();
}

function getIdsForCreate() {
  if (selectedClientId && selectedCarId) {
    return { clientId: selectedClientId, carId: selectedCarId };
  }

  if (
    !selectedClientId &&
    !selectedCarId &&
    lastSavedClientId &&
    lastSavedCarId
  ) {
    return { clientId: lastSavedClientId, carId: lastSavedCarId };
  }

  return { clientId: selectedClientId, carId: selectedCarId };
}

export function setSelectedIds(cId: string | null, carId: string | null) {
  if (clientRecordBaseline?.client_id !== cId) clientRecordBaseline = null;
  if (carRecordBaseline?.cars_id !== carId) carRecordBaseline = null;
  selectedClientId = cId;
  selectedCarId = carId;
  clearLastSavedIds();
}

export let transferredActComment: string = "";
export function setTransferredActComment(val: string) {
  transferredActComment = val;
}
let currentAutocompletes: { [key: string]: any } = {};
let disposeEnterNavigation: (() => void) | undefined;
let completeSourceOptions: string[] | null = null;
let authScope: string | undefined;
function currentFormScope(): string {
  try {
    const user = JSON.parse(localStorage.getItem("userAuthData") || "null");
    return JSON.stringify([authScope || "", user?.Name, user?.Доступ, user?.slyusar_id]);
  } catch { return JSON.stringify([authScope || ""]); }
}
const formOptions = createClientFormOptions(currentFormScope);
let formSelectionGeneration = 0;
let lastFormScope = currentFormScope();
const invalidateFormReads = () => {
  formSelectionGeneration++;
  formSelectionPending = false;
  formOptions.clear();
  completeSourceOptions = null;
  Object.values(currentAutocompletes).forEach(item => item.close?.());
};
const checkFormScope = () => {
  const next = currentFormScope();
  if (next !== lastFormScope) {
    lastFormScope = next;
    invalidateFormReads();
    clearModalSelectionState();
    clearFormSnapshot();
  }
};
window.addEventListener("storage", event => {
  if (!event.key || event.key === "userAuthData") checkFormScope();
});
for (const event of ["sto:client-saved", "sto:car-saved"]) {
  window.addEventListener(event, invalidateFormReads);
}
supabase.auth.onAuthStateChange((_event, session) => {
  authScope = JSON.stringify([session?.user?.id || null, session?.user?.role, session?.user?.app_metadata]);
  checkFormScope();
});

export function closeModalCreateSakazNarad(): void {
  if (formMutationPending || isActCreatePending()) {
    showLockToggleMessage(false, "Зачекайте завершення збереження.");
    return;
  }
  cancelSavePromptModal();
  cancelSaveModalCreate();
  Object.values(currentAutocompletes).forEach(item => item.dispose?.());
  currentAutocompletes = {};
  disposeEnterNavigation?.();
  disposeEnterNavigation = undefined;
  invalidateFormReads();
  document.getElementById(modalOverlayId)?.remove();
  setTransferredActComment("");
  clearModalSelectionState();
  clearFormSnapshot();
  mountedFormScope = null;
  refreshTransferredSelection = null;
}
export let userConfirmation: "no" | "yes" | null = null;

/** Keeps programmatic form fills and the visible operation button in sync. */
export function setClientCarOperation(mode: "no" | "yes" | null): boolean {
  if (formMutationPending || formSelectionPending || isActCreatePending()) return false;
  userConfirmation = mode;
  formSelectionGeneration++;
  Object.values(currentAutocompletes).forEach(dropdown => dropdown.close?.());
  const button = document.getElementById("confirm-toggle") as HTMLButtonElement | null;
  if (button) {
    button.textContent = mode === "yes" ? "➕" : mode === "no" ? "❌" : "🔁";
    button.className = "confirm-button" + (mode === "yes" ? " yes" : mode === "no" ? " no" : "");
    button.title = mode === "yes" ? "Додати автівку" : mode === "no"
      ? "Приховати автівку. Клієнт та історія залишаться" : "Редагувати клієнта й автівку";
  }
  if (!isLocked()) setupEditingAutocompletes();
  return true;
}

// --- СНЕПШОТ: зберігає первинні значення полів форми ---
export interface FormSnapshot {
  fullName: string;
  phone: string;
  carModel: string;
  carNumber: string;
  engine: string;
  fuel: string;
  vin: string;
  year: string;
  carCode: string;
  income: string;
  extra: string;
}
export let formSnapshot: FormSnapshot | null = null;

export function captureFormSnapshot() {
  const values = getModalFormValues();
  formSnapshot = {
    fullName: values.fullName, phone: values.phone, carModel: values.carModel,
    carNumber: values.carNumber, engine: values.engine, fuel: values.fuel,
    vin: values.vin, year: values.year, carCode: values.carCode,
    income: values.income, extra: values.extra,
  };
}

export function clearFormSnapshot() {
  formSnapshot = null;
}

let allUniqueData: {
  carModels: string[];
  carCodes: string[];
  phones: string[];
  carNumbers: string[];
  engines: string[];
  vins: string[];
} = {
  carModels: [],
  carCodes: [],
  phones: [],
  carNumbers: [],
  engines: [],
  vins: [],
};

function isLocked(): boolean {
  const editButton = document.getElementById(btnEditId);
  return editButton?.getAttribute("data-unlocked") !== "true";
}

function createModalElement(): HTMLDivElement {
  const modalOverlay = document.createElement("div");
  modalOverlay.id = modalOverlayId;
  modalOverlay.className = "modal-overlay-create-sakaz_narad";
  const modal = document.createElement("div");
  modal.className = modalClass;
  modal.innerHTML = `
    <button id="${modalCloseBtnId}" class="modal-close-create-sakaz_narad">&times;</button>
    <div class="modal-header-create-sakaz_narad">
      <h2>🔍 Картка клієнта</h2>
    </div>
    ${createInputFields()}
    <div class="buttons-create-sakaz_narad">
      <button id="${btnEditId}" class="btn-action-create-sakaz_narad btn-edit" title="Заблокувати інші поля">🔒</button>
      <button id="${btnSaveId}" class="btn-action-create-sakaz_narad btn-save" title="Зберегти">💾</button>    
      <button id="${btnCreateId}" class="btn-action-create-sakaz_narad btn-create" title="Створити">📝</button>
    </div>
  `;
  modalOverlay.appendChild(modal);
  return modalOverlay;
}

function createInputFields(): string {
  // ЗМІНА ТУТ: Замінили input на textarea для clientInputId
  // Додали стилі resize: none, overflow: hidden, rows=1
  return `
    <div class="field-create-sakaz_narad">
      <label for="${clientInputId}">ПІБ</label>
      <textarea id="${clientInputId}" class="input-create-sakaz_narad" placeholder="Введіть ПІБ" autocomplete="off" rows="1" style="resize: none; overflow-y: hidden; min-height: 38px; padding-top: 8px; line-height: 1.4;"></textarea>
      <ul id="${clientListId}" class="suggestions-list-create-sakaz_narad"></ul>
    </div>
    <div class="field-create-sakaz_narad">
      <label for="${phoneInputId}">Номер телефону</label>
      <div class="phone-field-inline">
        <input type="text" id="${phoneInputId}" class="input-create-sakaz_narad" placeholder="+380(XX)XXX-XX-XX" autocomplete="off" />
        <div id="car-confirm-icons" class="car-confirm-icons">
          <button id="confirm-toggle" class="confirm-button yes" title="Підтвердження">✔️</button>
        </div>
      </div>
      <ul id="${phoneListId}" class="suggestions-list-create-sakaz_narad"></ul>
    </div>
    <div class="car-field-inline">
      <div class="field-create-sakaz_narad car-input-group">
        <label for="${carModelInputId}">Автомобіль</label>
        <input type="text" id="${carModelInputId}" class="input-create-sakaz_narad" placeholder="Автомобіль" autocomplete="off" />
        <ul id="${carModelListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
      <div class="field-create-sakaz_narad car-code-input-group">
        <label for="${carNumberInputId}">Номер авто</label>
        <input type="text" id="${carNumberInputId}" class="input-create-sakaz_narad" placeholder="Номер авто" autocomplete="off" style="text-transform: uppercase;" />
        <ul id="${carNumberListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
      <div class="field-create-sakaz_narad year-input-group">
        <label for="${carYearInputId}">Рік</label>
        <input type="text" id="${carYearInputId}" class="input-create-sakaz_narad" readonly autocomplete="off" />
      </div>
    </div>
    <div class="field-row-create-sakaz_narad">
      <div class="field-create-sakaz_narad">
        <label for="${carEngineInputId}">Обʼєм</label>
        <input type="text" id="${carEngineInputId}" class="input-create-sakaz_narad" readonly autocomplete="off" />
        <ul id="${carEngineListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
      <div class="field-create-sakaz_narad car-code-input-group">
        <label for="${carCodeInputId}">Код ДВЗ</label>
        <input type="text" id="${carCodeInputId}" class="input-create-sakaz_narad" readonly style="text-transform: uppercase;" autocomplete="off" />
        <ul id="${carCodeListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
      <div class="field-create-sakaz_narad">
        <label for="${carFuelInputId}">Пальне</label>
        <input type="text" id="${carFuelInputId}" class="input-create-sakaz_narad" readonly autocomplete="off" />
      </div>
    </div>
    <div class="field-row-create-sakaz_narad">
      <div class="field-create-sakaz_narad">
        <label for="${carVinInputId}">VIN-код</label>
        <input type="text" id="${carVinInputId}" class="input-create-sakaz_narad" readonly style="text-transform: uppercase;" autocomplete="off" />
        <ul id="${carVinListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
      <div class="field-create-sakaz_narad">
        <label for="${carIncomeInputId}">Джерело</label>
        <input type="text" id="${carIncomeInputId}" class="input-create-sakaz_narad" readonly autocomplete="off" />
        <ul id="${carIncomeListId}" class="suggestions-list-create-sakaz_narad"></ul>
      </div>
    </div>
    <div class="field-create-sakaz_narad">
      <label for="${extraInputId}">Додатково</label>
      <input type="text" id="${extraInputId}" class="input-create-sakaz_narad" readonly autocomplete="off" />
    </div>
  `;
}

function setupPhoneFormatting(phoneInput: HTMLInputElement) {
  if (!phoneInput.value) {
    phoneInput.value = "+380";
  }
  phoneInput.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    const cursorPosition = target.selectionStart || 0;
    const oldValue = target.value;
    const newValue = formatPhoneNumber(target.value);
    target.value = newValue;
    const lengthDiff = newValue.length - oldValue.length;
    const newCursorPosition = cursorPosition + lengthDiff;
    setTimeout(() => {
      target.setSelectionRange(newCursorPosition, newCursorPosition);
    }, 0);
  });
  phoneInput.addEventListener("focus", () => {
    if (phoneInput.value === "+380") {
      setTimeout(() => {
        phoneInput.setSelectionRange(
          phoneInput.value.length,
          phoneInput.value.length,
        );
      }, 0);
    }
  });
  phoneInput.addEventListener("keydown", (e) => {
    const target = e.target as HTMLInputElement;
    const cursorPosition = target.selectionStart || 0;
    if ((e.key === "Backspace" || e.key === "Delete") && cursorPosition <= 4) {
      e.preventDefault();
      return;
    }
  });
}

// --- ДОПОМІЖНА ФУНКЦІЯ ДЛЯ АВТО-РОЗШИРЕННЯ ---
function autoResizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = element.scrollHeight + "px";
}

// ЗМІНА ТУТ: Додали HTMLTextAreaElement до типу input
function setupAutocomplete(
  input: HTMLInputElement | HTMLTextAreaElement,
  list: HTMLUListElement,
  items: any[],
  labelFn: (i: any) => string,
  onSelect: (i: any) => void | Promise<void>,
  showOnFocus: boolean = false,
  key?: string,
  minLength: number = 0,
  customFilter?: (item: any, searchValue: string) => boolean,
) {
  for (const [oldKey, oldData] of Object.entries(currentAutocompletes)) {
    if (oldData.input !== input && oldKey !== key) continue;
    oldData.dispose();
    delete currentAutocompletes[oldKey];
  }
  const remoteKinds = new Set(["client", "phone", "carModel", "carNumber", "carCodeEdit", "carEngineEdit", "carVinEdit", "carVinRestore", "carModelEdit", "carNumberEdit", "phoneEdit"]);
  const phoneKind = key === "phone" || key === "phoneEdit";
  // A selected client's complete phone list is already present in its entity read.
  const phoneOwner = key === "phone" && items[0]?.id != null ? String(items[0].id) : null;
  const mountedScope = currentFormScope();
  const remote = key === "source" || (!!key && remoteKinds.has(key));
  const filter = customFilter || (phoneKind ? (item: any, query: string) => {
    const digits = query.replace(/\D/g, "");
    return !digits || labelFn(item).replace(/\D/g, "").includes(digits);
  } : undefined);
  const dropdown = mountClientFormDropdown({
    input, list, items: key === "phone" ? [] : items, label: labelFn, showOnFocus, minLength,
    isCurrent: () => currentFormScope() === mountedScope && !formMutationPending,
    customFilter: filter,
    deduplicate: key === "source" || !!key?.endsWith("Edit"),
    onInput: () => {
      checkFormScope();
      formSelectionGeneration++;
      if (input instanceof HTMLTextAreaElement) autoResizeTextarea(input);
    },
    onSelect: async item => {
      checkFormScope();
      if (currentFormScope() !== mountedScope) throw new Error("Користувач змінився. Відкрийте картку клієнта повторно.");
      await onSelect(item);
      if (input instanceof HTMLTextAreaElement) autoResizeTextarea(input);
    },
    onError: error => {
      if (input.isConnected && currentFormScope() === mountedScope) {
        showLockToggleMessage(false, error instanceof Error ? error.message : "Не вдалося вибрати запис");
      }
    },
    loadPage: remote ? async (query, after) => {
      checkFormScope();
      if (currentFormScope() !== mountedScope || !input.isConnected) throw new Error("Дані форми змінилися. Відкрийте картку клієнта повторно.");
      if (key === "phone" && phoneOwner && phoneOwner === selectedClientId && items.length > 0) {
        return { items: items.filter(item => filter ? filter(item, query) : labelFn(item).toLowerCase().includes(query.toLowerCase())), has_more: false, next_cursor: null };
      }
      if (key === "source") {
        const sourceGeneration = formSelectionGeneration;
        const offset = after ?? 0;
        if (completeSourceOptions) {
          const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
          const search = normalize(query);
          return { items: completeSourceOptions.filter(item => normalize(item).includes(search)), has_more: false, next_cursor: null };
        }
        const page = await formOptions.readEntity("sourceOptions", JSON.stringify([query, offset]), async () => {
          const { data, error } = await supabase.rpc("traffic_directory_page", {
            p_kind: "incomes", p_query: query, p_offset: offset, p_exact: false, p_id: null,
          });
          if (error) {
            if (error.code === "PGRST202" || error.code === "42883") {
              throw new Error("Для підказок джерел установіть міграцію traffic_directories. Ручне введення доступне.");
            }
            throw error;
          }
          if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)) {
            throw new Error("Не вдалося прочитати джерела.");
          }
          const next = offset + data.items.length;
          if (next < data.total && data.items.length === 0) throw new Error("Некоректна сторінка джерел.");
          const items: string[] = data.items.map((row: any) => String(row.data?.Name || "").trim()).filter(Boolean);
          return {
            items,
            has_more: next < data.total,
            next_cursor: next < data.total ? next : null,
          };
        });
        if (!query && offset === 0 && !page.has_more && input.isConnected && currentFormScope() === mountedScope && sourceGeneration === formSelectionGeneration) completeSourceOptions = page.items;
        return page;
      }
      const scope = key === "carModel" || key === "carNumber" || key === "phone" ? selectedClientId : null;
      const page = await formOptions.read(key === "phoneEdit" ? "phone" : key!, query, after, scope);
      const phoneDigits = query.replace(/\D/g, "");
      const rows = phoneKind
        ? page.items.flatMap(row => String(row.phone || "").split(/[,;]/)
          .map(phone => ({ ...row, phone: phone.trim() })).filter(row => row.phone && (
            !query || row.phone.toLowerCase().includes(query.toLowerCase())
            || (phoneDigits && row.phone.replace(/\D/g, "").includes(phoneDigits))
          )))
        : page.items;
      return {
        ...page,
        items: rows.map(row => key === "carModelEdit" ? { display: row.label }
          : key?.endsWith("Edit") ? (key === "phoneEdit" ? formatPhoneNumber(row.phone) : row.label) : row),
      };
    } : undefined,
  });
  currentAutocompletes[key || input.id] = { input, ...dropdown };
}
function setupSimpleAutocomplete(
  input: HTMLInputElement,
  list: HTMLUListElement,
  items: string[],
  onSelect?: (item: string) => void,
  key?: string,
  minLength: number = 0,
) {
  setupAutocomplete(
    input,
    list,
    items,
    (item) => item,
    (item) => {
      if (onSelect) onSelect(item);
    },
    true,
    key,
    minLength,
  );
}

export function fillCarFields(car: any) {
  const carEngine = document.getElementById(
    carEngineInputId,
  ) as HTMLInputElement | null;
  const carFuel = document.getElementById(
    carFuelInputId,
  ) as HTMLInputElement | HTMLSelectElement | null;
  const carVin = document.getElementById(
    carVinInputId,
  ) as HTMLInputElement | null;
  const carNumber = document.getElementById(
    carNumberInputId,
  ) as HTMLInputElement | null;
  const carModel = document.getElementById(
    carModelInputId,
  ) as HTMLInputElement | null;
  const carYear = document.getElementById(
    carYearInputId,
  ) as HTMLInputElement | null;
  const carCode = document.getElementById(
    carCodeInputId,
  ) as HTMLInputElement | null;

  if (carEngine) carEngine.value = car["Обʼєм"] || "";
  if (carFuel) {
    const fuel = String(car["Пальне"] || "");
    if (carFuel instanceof HTMLSelectElement && fuel && !Array.from(carFuel.options).some(option => option.value === fuel)) {
      carFuel.add(new Option(fuel, fuel));
    }
    carFuel.value = fuel;
  }
  if (carVin) carVin.value = car["Vincode"] || "";
  if (carNumber) carNumber.value = car["Номер авто"] || "";
  if (carModel) carModel.value = car["Авто"] || "";
  if (carYear) carYear.value = car["Рік"] || "";
  if (carCode) carCode.value = car["КодДВЗ"] || car["Код ДВЗ"] || "";
}

async function fetchClientRecord(clientId: string): Promise<ClientRecordBaseline> {
  return formOptions.readEntity("client", String(clientId), async () => {
    const { data, error } = await supabase.rpc("traffic_client_car_record", { p_kind: "client", p_id: clientId });
    if (error) throw error;
    if (!data || String(data.client_id) !== String(clientId) || !data.data || typeof data.data !== "object") {
      throw new Error("Клієнт більше недоступний. Повторіть вибір.");
    }
    return { client_id: String(data.client_id), data: data.data };
  });
}

async function fetchCarRecord(carId: string): Promise<CarRecordBaseline> {
  return formOptions.readEntity("car", String(carId), async () => {
    const { data, error } = await supabase.rpc("traffic_client_car_record", { p_kind: "car", p_id: carId });
    if (error) throw error;
    if (!data || String(data.cars_id) !== String(carId) || !data.data || typeof data.data !== "object") {
      throw new Error("Автівка більше недоступна. Повторіть вибір.");
    }
    return { cars_id: String(data.cars_id), client_id: String(data.client_id), is_deleted: data.is_deleted ?? null, data: data.data };
  });
}

function fillClientFields(client: ClientRecordBaseline) {
  clientRecordBaseline = client;
  const clientData = client.data;
  const clientInput = document.getElementById(clientInputId) as HTMLTextAreaElement | null;
  if (clientInput) {
    clientInput.value = String(clientData["ПІБ"] || "");
    autoResizeTextarea(clientInput);
  }
  const phoneInput = document.getElementById(phoneInputId) as HTMLInputElement | null;
  const phones = String(clientData["Телефон"] || "").split(/[,;]/).map(phone => phone.trim()).filter(Boolean);
  if (phoneInput) phoneInput.value = phones[0] ? formatPhoneNumber(phones[0]) : "";
  const extraInput = document.getElementById(extraInputId) as HTMLInputElement | null;
  if (extraInput) extraInput.value = String(clientData["Додаткові"] || "");
  const incomeInput = document.getElementById(carIncomeInputId) as HTMLInputElement | null;
  if (incomeInput) incomeInput.value = String(clientData["Джерело"] || "Не вказано");
}

export async function fillClientInfo(clientId: string, isCurrent: () => boolean = () => true) {
  const modal = document.getElementById(modalOverlayId);
  const selection = formSelectionGeneration;
  const client = await fetchClientRecord(clientId);
  if (!isCurrent() || selection !== formSelectionGeneration || !modal?.isConnected || document.getElementById(modalOverlayId) !== modal) return null;
  fillClientFields(client);
  return client.data;
}

/** Transfers a planner selection with compact raw baselines for later edits. */
export async function fillSelectedClientCar(clientId: string, carId: string | null): Promise<boolean> {
  const modal = document.getElementById(modalOverlayId);
  if (!modal || formMutationPending || isActCreatePending()) return false;
  const generation = ++formSelectionGeneration;
  const owner = currentFormScope();
  formSelectionPending = true;
  clearModalSelectionState();
  clearFormSnapshot();
  Object.values(currentAutocompletes).forEach(dropdown => dropdown.close?.());
  try {
    const [client, car] = await Promise.all([fetchClientRecord(clientId), carId ? fetchCarRecord(carId) : null]);
    if (generation !== formSelectionGeneration || !modal.isConnected || document.getElementById(modalOverlayId) !== modal || owner !== currentFormScope()) return false;
    if (car && (car.client_id !== client.client_id || car.is_deleted === true)) throw new Error("Автівка більше не належить цьому клієнту або прихована. Повторіть вибір.");
    clearCarAndContactFields();
    fillClientFields(client);
    selectedClientId = client.client_id;
    if (car) {
      fillCarFields(car.data);
      selectedCarId = car.cars_id;
      carRecordBaseline = car;
    }
    captureFormSnapshot();
    refreshTransferredSelection?.();
    return true;
  } finally {
    if (generation === formSelectionGeneration) formSelectionPending = false;
  }
}

function formatDisplayText(text: string): string {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function setupEditingAutocompletes() {
  const carModelInput = document.getElementById(
    carModelInputId,
  ) as HTMLInputElement;
  const carModelList = document.getElementById(
    carModelListId,
  ) as HTMLUListElement;
  const carCodeInput = document.getElementById(
    carCodeInputId,
  ) as HTMLInputElement;
  const carCodeList = document.getElementById(
    carCodeListId,
  ) as HTMLUListElement;
  const phoneInput = document.getElementById(phoneInputId) as HTMLInputElement;
  const phoneList = document.getElementById(phoneListId) as HTMLUListElement;
  const carNumberInput = document.getElementById(
    carNumberInputId,
  ) as HTMLInputElement;
  const carNumberList = document.getElementById(
    carNumberListId,
  ) as HTMLUListElement;
  const carEngineInput = document.getElementById(
    carEngineInputId,
  ) as HTMLInputElement;
  const carEngineList = document.getElementById(
    carEngineListId,
  ) as HTMLUListElement;
  const carVinInput = document.getElementById(
    carVinInputId,
  ) as HTMLInputElement;
  const carVinList = document.getElementById(carVinListId) as HTMLUListElement;
  const hasSelectedClientContext = !!selectedClientId;

  // Дані з auto.json
  const carSuggestionsFromFile = autoData.data.flatMap((mark) =>
    mark.models.map((model) => ({
      mark_id: formatDisplayText(mark.id),
      mark_cyrillic: mark.cyrillic_name || "",
      name: formatDisplayText(model.name),
      model_cyrillic: model.cyrillic_name || "",
      display: `${formatDisplayText(mark.id)} ${formatDisplayText(model.name)}`,
      source: "file", // Позначка що це з файлу
    })),
  );

  // Дані з бази даних cars
  const carSuggestionsFromDB = allUniqueData.carModels.map((model) => ({
    mark_id: "",
    mark_cyrillic: "",
    name: model,
    model_cyrillic: "",
    display: model,
    source: "database", // Позначка що це з БД
  }));

  // Комбінуємо обидва джерела і видаляємо дублі
  const uniqueMap = new Map<string, any>();

  // Спочатку додаємо дані з файлу (вони мають пріоритет)
  carSuggestionsFromFile.forEach((item) => {
    const key = item.display.toLowerCase().trim();
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, item);
    }
  });

  // Потім додаємо дані з БД (тільки якщо їх ще немає)
  carSuggestionsFromDB.forEach((item) => {
    const key = item.display.toLowerCase().trim();
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, item);
    }
  });

  const combinedCarSuggestions = Array.from(uniqueMap.values());

  const matchesSearch = (item: any, searchValue: string): boolean => {
    const search = searchValue.toLowerCase();
    const englishMatch =
      item.mark_id.toLowerCase().includes(search) ||
      item.name.toLowerCase().includes(search) ||
      item.display.toLowerCase().includes(search);
    const cyrillicMatch =
      item.mark_cyrillic.toLowerCase().includes(search) ||
      item.model_cyrillic.toLowerCase().includes(search);
    return englishMatch || cyrillicMatch;
  };

  if (!hasSelectedClientContext) {
    setupAutocomplete(
      carModelInput,
      carModelList,
      combinedCarSuggestions,
      (item) => item.display,
      (item) => {
        carModelInput.value = item.display;
      },
      false,
      "carModelEdit",
      2,
      matchesSearch,
    );
  }

  setupSimpleAutocomplete(
    carCodeInput,
    carCodeList,
    allUniqueData.carCodes,
    undefined,
    "carCodeEdit",
  );
  if (!hasSelectedClientContext) {
    setupSimpleAutocomplete(
      phoneInput,
      phoneList,
      allUniqueData.phones,
      undefined,
      "phoneEdit",
    );
    setupSimpleAutocomplete(
      carNumberInput,
      carNumberList,
      allUniqueData.carNumbers,
      undefined,
      "carNumberEdit",
    );
  }
  setupSimpleAutocomplete(
    carEngineInput,
    carEngineList,
    allUniqueData.engines,
    undefined,
    "carEngineEdit",
  );
  if (userConfirmation === "yes") {
    setupAutocomplete(carVinInput, carVinList, [], item => item.label || item.Vincode || "", async item => {
      const selection = ++formSelectionGeneration;
      const modal = document.getElementById(modalOverlayId);
      const owner = currentFormScope();
      formSelectionPending = true;
      Object.values(currentAutocompletes).forEach(dropdown => dropdown.close?.());
      try {
        const car = await fetchCarRecord(String(item.id));
        if (selection !== formSelectionGeneration || !modal?.isConnected || owner !== currentFormScope()) return;
        // Reusing a VIN keeps the chosen new owner. Historical acts retain the
        // same car ID; the atomic save performs the ownership change.
        fillCarFields(car.data);
        carRecordBaseline = car;
        selectedCarId = car.cars_id;
        clearLastSavedIds();
      } finally {
        if (selection === formSelectionGeneration) formSelectionPending = false;
      }
    }, false, "carVinRestore", 1);
  } else {
    setupSimpleAutocomplete(carVinInput, carVinList, allUniqueData.vins, undefined, "carVinEdit");
  }

  document.getElementById("car-confirm-icons")!.style.display = "flex";
}

export async function showModalCreateSakazNarad() {
  if (document.getElementById(modalOverlayId)) return;
  invalidateFormReads();
  mountedFormScope = currentFormScope();
  formMutationPending = false;
  if (!document.getElementById(savePromptModalId)) {
    document.body.appendChild(createSavePromptModal());
  }
  clearModalSelectionState();
  clearFormSnapshot();
  const modal = createModalElement();
  document.body.appendChild(modal);
  userConfirmation = "yes";
  const confirmToggle = document.getElementById(
    "confirm-toggle",
  ) as HTMLButtonElement;
  document.getElementById("car-confirm-icons")!.style.display = "none";
  userConfirmation = null;
  if (confirmToggle) {
    const states: Array<"yes" | "no" | null> = ["yes", null, "no"];
    setClientCarOperation("yes");
    confirmToggle.addEventListener("click", () => {
      const currentIndex = states.indexOf(userConfirmation);
      setClientCarOperation(states[(currentIndex + 1) % states.length]);
    });
  }
  const btnSave = document.getElementById(btnSaveId) as HTMLButtonElement;
  const modalElement = document.getElementById(modalOverlayId)!;
  // Every editable field invalidates pending selection reads, including fields
  // without autocomplete (notes, year, fuel and source). Programmatic fills do
  // not dispatch these events, so a single selection can still fill its fields.
  const invalidatePendingSelection = () => { checkFormScope(); formSelectionGeneration++; formSelectionPending = false; };
  modalElement.addEventListener("input", invalidatePendingSelection);
  modalElement.addEventListener("change", invalidatePendingSelection);
  const closeBtn = document.getElementById(modalCloseBtnId)!;
  const btnEdit = document.getElementById(btnEditId)!;

  // ЗМІНА ТУТ: Приводимо до HTMLTextAreaElement
  const clientInput = document.getElementById(
    clientInputId,
  ) as HTMLTextAreaElement;

  const clientList = document.getElementById(clientListId) as HTMLUListElement;
  const carNumberInput = document.getElementById(
    carNumberInputId,
  ) as HTMLInputElement;
  const carNumberList = document.getElementById(
    carNumberListId,
  ) as HTMLUListElement;
  const carModelInput = document.getElementById(
    carModelInputId,
  ) as HTMLInputElement;
  const carModelList = document.getElementById(
    carModelListId,
  ) as HTMLUListElement;
  const phoneInput = document.getElementById(phoneInputId) as HTMLInputElement;
  const phoneList = document.getElementById(phoneListId) as HTMLUListElement;
  setupPhoneFormatting(phoneInput);

  // Додаємо слухач для clientInput, щоб він розширювався під час ручного введення
  // (хоча setupAutocomplete це теж робить, але для безпеки)
  clientInput.addEventListener("input", () => autoResizeTextarea(clientInput));

  const forceUppercase = (id: string) => {
    const el = document.getElementById(id) as HTMLInputElement;
    if (el) {
      el.addEventListener("input", () => {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.toUpperCase();
        if (start !== null && end !== null) {
          el.setSelectionRange(start, end);
        }
      });
    }
  };
  forceUppercase(carNumberInputId);
  forceUppercase(carVinInputId);
  forceUppercase(carCodeInputId);

  clientInput.addEventListener("input", () => {
    if (userConfirmation === null) {
      clearLastSavedIds();
      return;
    }

    const hadSelectedClient = selectedClientId !== null;
    selectedClientId = null;
    selectedCarId = null;
    clientRecordBaseline = null;
    carRecordBaseline = null;
    clearLastSavedIds();
    if (hadSelectedClient) {
      setupCarAutocompletes([]);
      setupPhoneAutocomplete([]);
      if (!isLocked()) setupEditingAutocompletes();
    }
  });

  const clearSelectedCarOnManualInput = () => {
    if (userConfirmation === null) {
      clearLastSavedIds();
      return;
    }

    selectedCarId = null;
    carRecordBaseline = null;
    lastSavedCarId = null;
  };
  carModelInput.addEventListener("input", clearSelectedCarOnManualInput);
  carNumberInput.addEventListener("input", clearSelectedCarOnManualInput);
  document.getElementById(carVinInputId)?.addEventListener("input", clearSelectedCarOnManualInput);

  // --- НАЛАШТУВАННЯ НАВІГАЦІЇ ENTER-ОМ ---
  const navigationFieldIds = [
    clientInputId, // ПІБ
    phoneInputId, // Номер телефону
    carModelInputId, // Автомобіль
    carNumberInputId, // Номер авто
    carYearInputId, // Рік
    carEngineInputId, // Обʼєм
    carCodeInputId, // Код ДВЗ
    carFuelInputId, // Пальне
    carVinInputId, // VIN-код
    carIncomeInputId, // Джерело
    extraInputId, // Додатково
  ];
  disposeEnterNavigation?.();
  disposeEnterNavigation = setupEnterNavigation(navigationFieldIds);

  const editableFieldsInitially = [
    clientInput,
    carModelInput,
    carNumberInput,
    phoneInput,
  ];
  editableFieldsInitially.forEach((el) => el.removeAttribute("readonly"));
  btnEdit.addEventListener("click", async () => {
    if (formMutationPending || formSelectionPending || isActCreatePending()) return;
    formSelectionGeneration++;
    const isUnlocked = btnEdit.dataset.unlocked === "true";
    btnEdit.dataset.unlocked = (!isUnlocked).toString();
    btnEdit.textContent = isUnlocked ? "🔒" : "🔓";
    btnEdit.title = isUnlocked ? "Розблокувати поля?" : "Заблокувати поля?";
    if (!isUnlocked) {
      btnEdit.style.backgroundColor = "red";
      btnEdit.style.color = "white";
      document.getElementById(carEngineInputId)?.removeAttribute("readonly");
      document.getElementById(carVinInputId)?.removeAttribute("readonly");
      document.getElementById(extraInputId)?.removeAttribute("readonly");
      document.getElementById(carYearInputId)?.removeAttribute("readonly");
      document.getElementById(carCodeInputId)?.removeAttribute("readonly");
      setupEditingAutocompletes();
      const fuelInput = document.getElementById(carFuelInputId);
      const fuelContainer = fuelInput?.parentElement;
      if (fuelContainer && fuelInput instanceof HTMLInputElement) {
        const currentFuel = fuelInput.value;
        const fuelOptions = ["Бензин", "Дизель", "Газ", "Гібрид", "Електро"];
        const fuelSelect = document.createElement("select");
        fuelSelect.id = carFuelInputId;
        fuelSelect.className = "input-create-sakaz_narad";
        fuelSelect.add(new Option("Невказано", ""));
        for (const fuel of fuelOptions) fuelSelect.add(new Option(fuel, fuel));
        if (currentFuel && !fuelOptions.includes(currentFuel)) fuelSelect.add(new Option(currentFuel, currentFuel));
        fuelSelect.value = currentFuel;
        fuelContainer.replaceChild(fuelSelect, fuelInput);
      }
      const incomeInput = document.getElementById(carIncomeInputId) as HTMLInputElement | null;
      const incomeList = document.getElementById(carIncomeListId) as HTMLUListElement | null;
      if (incomeInput && incomeList) {
        incomeInput.readOnly = false;
        setupSimpleAutocomplete(incomeInput, incomeList, ["Не вказано"], undefined, "source");
      }
    } else {
      // Закриваємо замок - повертаємо оригінальний колір
      btnEdit.style.backgroundColor = "";
      btnEdit.style.color = "";
      const confirmIcons = document.getElementById("car-confirm-icons");
      if (confirmIcons) confirmIcons.style.display = "none";
      document
        .getElementById(carEngineInputId)
        ?.setAttribute("readonly", "true");
      document.getElementById(carVinInputId)?.setAttribute("readonly", "true");
      document.getElementById(extraInputId)?.setAttribute("readonly", "true");
      document.getElementById(carYearInputId)?.setAttribute("readonly", "true");
      document.getElementById(carCodeInputId)?.setAttribute("readonly", "true");
      for (const dropdown of Object.values(currentAutocompletes)) dropdown.dispose();
      currentAutocompletes = {};
      (document.getElementById(carIncomeInputId) as HTMLInputElement).readOnly = true;
      const fuelContainer =
        document.getElementById(carFuelInputId)?.parentElement;
      const fuelInput = document.getElementById(carFuelInputId);
      if (fuelContainer && fuelInput instanceof HTMLSelectElement) {
        const selectedValue = fuelInput.value;
        const newInput = document.createElement("input");
        newInput.id = carFuelInputId;
        newInput.className = "input-create-sakaz_narad";
        newInput.type = "text";
        newInput.readOnly = true;
        newInput.value = selectedValue;
        fuelContainer.replaceChild(newInput, fuelInput);
      }
      // Скидаємо стан на ➕ (за замовчуванням) і візуальний стан кнопки
      setClientCarOperation("yes");
      setupNormalAutocompletes();
    }
  });
  closeBtn.addEventListener("click", closeModalCreateSakazNarad);
  let clientOptions: any[] = [];
  let allCarItems: any[] = [];
  let selectedClientPhones: any[] = [];

  const getClientAndDefaultCar = async (clientId: string) => {
    const result = await formOptions.readEntity("client-car", clientId, async () => {
      const { data, error } = await supabase.rpc("traffic_client_car_record", { p_kind: "client_car", p_id: clientId });
      if (error) throw error;
      if (!data?.client || String(data.client.client_id) !== String(clientId)) throw new Error("Клієнт більше недоступний. Повторіть вибір.");
      const client: ClientRecordBaseline = { client_id: String(data.client.client_id), data: data.client.data || {} };
      const car: CarRecordBaseline | null = data.car ? { cars_id: String(data.car.cars_id), client_id: String(data.car.client_id), data: data.car.data || {}, is_deleted: data.car.is_deleted ?? null } : null;
      if (car && (car.client_id !== client.client_id || car.is_deleted === true)) throw new Error("Автівка більше недоступна. Повторіть вибір.");
      return { client, car };
    });
    // The bundled compact records are shared with later explicit selections.
    await formOptions.readEntity("client", clientId, async () => result.client);
    if (result.car) await formOptions.readEntity("car", result.car.cars_id, async () => result.car!);
    return result;
  };
  const getPhonesForClient = (clientId: string, clientData: any) => {
    const normalizedClientId = String(clientId);
    const phoneData = clientData?.["Телефон"] || "";
    if (typeof phoneData !== "string") return selectedClientPhones = [];
    const phones = phoneData
      .split(/[,;]/)
      .map((phone) => phone.trim())
      .filter((phone) => phone);
    return selectedClientPhones = phones.map((phone) => ({
      id: normalizedClientId,
      data: clientData,
      phone: phone,
      displayPhone: phone,
    }));
  };
  function validCurrentForm(): boolean {
    checkFormScope();
    if (isActCreatePending()) {
      showLockToggleMessage(false, "Зачекайте завершення створення акта.");
      return false;
    }
    if (mountedFormScope !== currentFormScope()) {
      showLockToggleMessage(false, "Користувач змінився. Відкрийте картку клієнта повторно.");
      return false;
    }
    if (formSelectionPending) {
      showLockToggleMessage(false, "Зачекайте завершення вибору клієнта або автівки.");
      return false;
    }
    return modalElement.isConnected && document.getElementById(modalOverlayId) === modalElement;
  }
  function validateRequiredFields(): boolean {
    if (userConfirmation === "no") {
      if (selectedCarId) return true;
      showLockToggleMessage(false, "Оберіть автівку для видалення.");
      return false;
    }
    const missing = [];
    if (!clientInput.value.trim()) missing.push("ПІБ");
    if ((userConfirmation === "yes" || selectedCarId) && !carModelInput.value.trim()) missing.push("Автомобіль");
    if (!missing.length) return true;
    showLockToggleMessage(false, "Заповніть поле: " + missing.join(" та "));
    return false;
  }
  btnSave.addEventListener("click", async () => {
    if (formMutationPending || !validCurrentForm()) return;
    if (btnEdit.dataset.unlocked !== "true") {
      showLockToggleMessage(false, "Спочатку розблокуйте форму для редагування.");
      return;
    }
    if (!validateRequiredFields()) return;
    const operation = userConfirmation;
    const owner = currentFormScope();
    const controls = Array.from(modalElement.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("input, button, textarea, select"));
    const previousDisabled = controls.map(control => control.disabled);
    let relock = false;
    formMutationPending = true;
    formSelectionGeneration++;
    Object.values(currentAutocompletes).forEach(dropdown => dropdown.close?.());
    controls.forEach(control => { control.disabled = true; });
    try {
      const confirmed = await showSavePromptModal();
      if (!confirmed || !modalElement.isConnected || owner !== currentFormScope()) return;
      const result = await saveClientAndCarToDatabase();
      if (!result.saved) {
        // A conflict keeps the draft, while an explicit re-selection must read
        // the current server baseline instead of repeating the same conflict.
        invalidateFormReads();
        return;
      }
      invalidateFormReads();
      if (!modalElement.isConnected || owner !== currentFormScope() || document.getElementById(modalOverlayId) !== modalElement) return;
      selectedClientId = result.client_id || null;
      selectedCarId = result.cars_id || null;
      clientRecordBaseline = result.client ? { client_id: String(result.client.client_id), data: result.client.data } : clientRecordBaseline;
      carRecordBaseline = result.car ? { ...result.car, cars_id: String(result.car.cars_id), client_id: String(result.car.client_id), is_deleted: result.car.is_deleted ?? null } : carRecordBaseline;
      if (clientRecordBaseline) fillClientFields(clientRecordBaseline);
      if (operation === "no") {
        clearCarFields();
      } else if (carRecordBaseline) {
        fillCarFields(carRecordBaseline.data);
      }
      selectedClientPhones = clientRecordBaseline ? getPhonesForClient(clientRecordBaseline.client_id, clientRecordBaseline.data) : [];
      lastSavedClientId = selectedClientId;
      lastSavedCarId = selectedCarId;
      captureFormSnapshot();
      relock = true;
    } catch (error) {
      invalidateFormReads();
      if (modalElement.isConnected && owner === currentFormScope()) showLockToggleMessage(false, error instanceof Error ? error.message : "Не вдалося зберегти дані.");
    } finally {
      formMutationPending = false;
      controls.forEach((control, index) => { control.disabled = previousDisabled[index]; });
      if (relock && modalElement.isConnected && btnEdit.dataset.unlocked === "true") btnEdit.click();
    }
  });
  const btnCreate = document.getElementById(btnCreateId);
  if (btnCreate) {
    btnCreate.addEventListener("click", async () => {
      if (formMutationPending || !validCurrentForm()) return;
      const values = getModalFormValues();
      if (formSnapshot && Object.keys(formSnapshot).some(key => String(values[key as keyof typeof values] ?? "") !== formSnapshot![key as keyof FormSnapshot])) {
        showLockToggleMessage(false, "Спочатку збережіть зміни клієнта та автівки.");
        return;
      }
      if (!document.getElementById(saveModalIdCreate)) document.body.appendChild(createSaveModalCreate());
      const { clientId: clientIdToUse, carId: carIdToUse } = getIdsForCreate();
      if (!clientIdToUse || !carIdToUse || carRecordBaseline?.is_deleted === true || (carRecordBaseline && carRecordBaseline.client_id !== clientIdToUse)) {
        showLockToggleMessage(false, "Оберіть або збережіть клієнта та його автівку.");
        return;
      }
      selectedClientId = clientIdToUse;
      selectedCarId = carIdToUse;
      await showSaveModalCreate();
    });
  }
  const setupCarAutocompletes = (carItems: any[]) => {
    const carNumberItems = carItems;
    setupAutocomplete(
      carNumberInput,
      carNumberList,
      carNumberItems,
      (c) => c["Номер авто"] || "",
      handleCarSelection,
      true,
      "carNumber",
    );
    setupAutocomplete(
      carModelInput,
      carModelList,
      carItems,
      (c) => (c["Авто"] || "").toString().trim(),
      handleCarSelection,
      true,
      "carModel",
    );
  };
  const beginSelection = () => {
    const generation = ++formSelectionGeneration;
    const owner = currentFormScope();
    formSelectionPending = true;
    clearModalSelectionState();
    clearFormSnapshot();
    Object.values(currentAutocompletes).forEach(dropdown => dropdown.close?.());
    return {
      current: () => generation === formSelectionGeneration && modalElement.isConnected && document.getElementById(modalOverlayId) === modalElement && owner === currentFormScope(),
      finish: () => { if (generation === formSelectionGeneration) formSelectionPending = false; },
    };
  };
  const selectClient = async (clientId: string, chosenPhone?: string) => {
    const selection = beginSelection();
    try {
      // One compact bundled read in browsing mode. Editing a client does not
      // download a car that the user has not selected.
      const records = isLocked() ? await getClientAndDefaultCar(String(clientId))
        : { client: await fetchClientRecord(String(clientId)), car: null };
      if (!selection.current()) return;
      clearCarAndContactFields();
      fillClientFields(records.client);
      if (chosenPhone) phoneInput.value = chosenPhone;
      selectedClientId = records.client.client_id;
      if (records.car) {
        carRecordBaseline = records.car;
        selectedCarId = records.car.cars_id;
        fillCarFields(records.car.data);
      }
      captureFormSnapshot();
      setupCarAutocompletes([]);
      setupPhoneAutocomplete(getPhonesForClient(records.client.client_id, records.client.data));
      if (!isLocked()) setupEditingAutocompletes();
    } finally { selection.finish(); }
  };
  const setupPhoneAutocomplete = (phoneItems: any[]) => {
    setupAutocomplete(phoneInput, phoneList, phoneItems, item => item.displayPhone || item.phone || "",
      item => selectClient(String(item.id), item.phone), true, "phone");
  };
  const handleCarSelection = async (item: any) => {
    const selection = beginSelection();
    try {
      const car = await fetchCarRecord(String(item.id));
      if (!selection.current()) return;
      if (car.is_deleted === true) throw new Error("Автівку вже приховано. Додайте її за VIN, щоб відновити.");
      const client = await fetchClientRecord(car.client_id);
      if (!selection.current()) return;
      // Commit only after both reads succeed, avoiding a car from one owner
      // combined with the old client's fields when the second read fails.
      fillClientFields(client);
      fillCarFields(car.data);
      selectedClientId = client.client_id;
      selectedCarId = car.cars_id;
      carRecordBaseline = car;
      captureFormSnapshot();
      setupCarAutocompletes([]);
      setupPhoneAutocomplete(getPhonesForClient(client.client_id, client.data));
      if (!isLocked()) setupEditingAutocompletes();
    } finally { selection.finish(); }
  };
  const setupNormalAutocompletes = () => {
    setupAutocomplete(clientInput, clientList, clientOptions, item => item.fullName || "",
      item => selectClient(String(item.id)), true, "client");
    setupCarAutocompletes(allCarItems);
    setupPhoneAutocomplete(selectedClientId ? selectedClientPhones : []);
  };
  refreshTransferredSelection = () => {
    selectedClientPhones = clientRecordBaseline ? getPhonesForClient(clientRecordBaseline.client_id, clientRecordBaseline.data) : [];
    setupNormalAutocompletes();
    if (!isLocked()) setupEditingAutocompletes();
  };
  setupNormalAutocompletes();
}

function clearCarFields() {
  const idsToClear = [
    carNumberInputId,
    carModelInputId,
    carEngineInputId,
    carFuelInputId,
    carVinInputId,
    carYearInputId,
    carCodeInputId,
  ];
  idsToClear.forEach((id) => {
    const input = document.getElementById(id) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement // Додано
      | null;
    if (
      input instanceof HTMLInputElement ||
      input instanceof HTMLTextAreaElement
    ) {
      input.value = "";
    } else if (input instanceof HTMLSelectElement) {
      input.selectedIndex = 0;
    }
  });
  selectedCarId = null;
  carRecordBaseline = null;
  lastSavedCarId = null;
}

function clearCarAndContactFields() {
  clearCarFields();
  for (const id of [phoneInputId, carIncomeInputId, extraInputId]) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = "";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document
    .querySelector('[data-action="openHome"]')
    ?.addEventListener("click", async (e) => {
      // 1. Додано async
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // 2. ДОДАНО ПЕРЕВІРКУ АВТОРИЗАЦІЇ
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        // console.warn(
        // "⛔ Користувач не авторизований. Модальне вікно 'Наряд' не відкривається.",
        // );
        // Тут можна викликати вашу функцію показу помилки, якщо вона не викликається автоматично глобально
        // Але головне - ми не йдемо далі:
        return;
      }

      showModalCreateSakazNarad();
    });
});

export function showLockToggleMessage(
  isUnlocked: boolean,
  customText?: string,
) {
  const note = document.createElement("div");
  note.textContent =
    customText ||
    (isUnlocked
      ? "🔓 Розблоковано для редагування"
      : "🔒 Заблоковано редагування");
  note.style.position = "fixed";
  note.style.left = "50%";
  note.style.bottom = "50%";
  note.style.transform = "translateX(-50%)";
  note.style.backgroundColor = isUnlocked ? "#4caf50" : "#f44336";
  note.style.color = "white";
  note.style.padding = "12px 24px";
  note.style.borderRadius = "8px";
  note.style.zIndex = "10001";
  note.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
  note.style.fontSize = "16px";
  document.body.appendChild(note);
  setTimeout(() => {
    note.remove();
  }, 1500);
}
