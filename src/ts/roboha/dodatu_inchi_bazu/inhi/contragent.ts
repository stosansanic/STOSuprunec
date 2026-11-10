import { readDirectory, mountDirectoryDropdown, clearDirectoryReads, deleteDirectory } from './directoryRead';
// src\ts\roboha\dodatu_inchi_bazu\inhi\contragent.ts
import { supabase } from "../../../vxid/supabaseClient";
import { updateAllBd, CRUD } from "../dodatu_inchi_bazu_danux";
import { setupEnterNavigationForFields } from "../../redahyvatu_klient_machuna/enter_navigation";
import { logAction } from "../../../utils/auditLogger";

export interface ContragentRecord {
  faktura_id: number;
  name: string;
  oderjyvach: string;
  prumitka: string;
  data: string | null;
  namber: number | null;
}

export let contragentData: ContragentRecord[] = [];
let selectedContragentId: number | null = null;
let contragentOwner = "";
let contragentController: AbortController | null = null;
const currentActor = () => localStorage.getItem("userAuthData") || "";

const MAX_TEXTAREA_HEIGHT = 150;
const MONTH_NAMES = [
  "Січень",
  "Лютий",
  "Березень",
  "Квітень",
  "Травень",
  "Червень",
  "Липень",
  "Серпень",
  "Вересень",
  "Жовтень",
  "Листопад",
  "Грудень",
];

// ====== UTILITIES ======================================

function isoToDots(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!isNaN(d.getTime())) {
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  }
  const parts = iso.split("T")[0]?.split("-");
  if (parts?.length === 3) {
    return `${parts[2].padStart(2, "0")}.${parts[1].padStart(2, "0")}.${parts[0]}`;
  }
  return iso;
}

function dotsToISO(dots: string | null): string | null {
  if (!dots) return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dots.trim());
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function autoResizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  if (element.scrollHeight > MAX_TEXTAREA_HEIGHT) {
    element.style.height = `${MAX_TEXTAREA_HEIGHT}px`;
    element.style.overflowY = "auto";
  } else {
    element.style.height = `${element.scrollHeight}px`;
    element.style.overflowY = "hidden";
  }
}

// ====== DATA LOADING ===================================

export async function loadContragentData(): Promise<ContragentRecord[]> { return (await readDirectory('faktura')).items; }

// ====== DATE PICKER ====================================

function createDatePicker(input: HTMLInputElement) {
  const calendar = document.createElement("div");
  calendar.className = "contragent-calendar";
  calendar.style.cssText = `
    position: absolute; background: white; border: 1px solid #ccc;
    border-radius: 6px; padding: 8px 8px 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10000; display: none; width: 200px;
  `;

  const today = new Date();
  let currentYear = today.getFullYear();
  let currentMonth = today.getMonth();

  const header = document.createElement("div");
  header.style.cssText = `
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 4px; font-weight: bold; font-size: 12px;
  `;
  header.innerHTML = `
    <button type="button" class="cal-prev" style="border:none;background:none;cursor:pointer;font-size:11px;padding:1px 2px;">◀</button>
    <span class="cal-title" style="font-size:10px;">${MONTH_NAMES[currentMonth]} ${currentYear}</span>
    <button type="button" class="cal-next" style="border:none;background:none;cursor:pointer;font-size:11px;padding:1px 2px;">▶</button>
  `;

  const daysHeader = document.createElement("div");
  daysHeader.style.cssText = `
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
    text-align: center; font-weight: bold; margin-bottom: 6px; font-size: 10px;
  `;
  daysHeader.innerHTML = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"]
    .map((d) => `<div style="padding:1px;">${d}</div>`)
    .join("");

  calendar.appendChild(header);
  calendar.appendChild(daysHeader);

  const renderDays = (year: number, month: number) => {
    const existingGrid = calendar.querySelector(".days-grid");
    if (existingGrid) existingGrid.remove();

    const grid = document.createElement("div");
    grid.className = "days-grid";
    grid.style.cssText = `display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; text-align: center;`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = firstDay === 0 ? 6 : firstDay - 1;

    for (let i = 0; i < offset; i++) {
      grid.appendChild(document.createElement("div"));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dayBtn = document.createElement("button");
      dayBtn.type = "button";
      dayBtn.textContent = String(day);
      dayBtn.style.cssText = `
        min-height: 22px; padding: 4px 0; border: 1px solid #ddd;
        border-radius: 4px; background: white; cursor: pointer;
        transition: all 0.2s; font-size: 12px; line-height: 1.1;
      `;

      const isToday =
        year === today.getFullYear() &&
        month === today.getMonth() &&
        day === today.getDate();
      if (isToday) {
        dayBtn.style.background = "#e6f0ff";
        dayBtn.style.borderColor = "#3b82f6";
        dayBtn.style.color = "#0b5cff";
      }

      dayBtn.addEventListener("mouseenter", () => {
        if (!isToday) dayBtn.style.background = "#e3f2fd";
      });
      dayBtn.addEventListener("mouseleave", () => {
        dayBtn.style.background = isToday ? "#e6f0ff" : "white";
      });

      dayBtn.addEventListener("click", () => {
        input.value = `${String(day).padStart(2, "0")}.${String(month + 1).padStart(2, "0")}.${year}`;
        calendar.style.display = "none";
      });

      grid.appendChild(dayBtn);
    }

    calendar.appendChild(grid);
  };

  renderDays(currentYear, currentMonth);

  const titleSpan = header.querySelector(".cal-title") as HTMLSpanElement;
  const prevBtn = header.querySelector(".cal-prev");
  const nextBtn = header.querySelector(".cal-next");

  prevBtn?.addEventListener("click", () => {
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    titleSpan.textContent = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
    renderDays(currentYear, currentMonth);
  });

  nextBtn?.addEventListener("click", () => {
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    titleSpan.textContent = `${MONTH_NAMES[currentMonth]} ${currentYear}`;
    renderDays(currentYear, currentMonth);
  });

  return calendar;
}

// ====== FORM MANAGEMENT ================================

function setRecipientState(active: boolean): void {
  const toggle = document.getElementById("contragent-recipient-toggle");
  if (toggle) {
    toggle.dataset.active = String(active); toggle.classList.toggle("active", active);
    toggle.parentElement?.querySelector(".recipient-toggle-label--left")?.classList.toggle("active", !active);
    toggle.parentElement?.querySelector(".recipient-toggle-label--right")?.classList.toggle("active", active);
  }
  const number = document.getElementById("contragent-namber") as HTMLInputElement | null;
  if (number) number.style.display = active ? "" : "none";
}
export function clearFormFields() {
  for (const id of ["contragent-name", "contragent-receiver", "contragent-note", "contragent-date", "contragent-namber"]) {
    const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (input) { input.value = ""; if (input.tagName === "TEXTAREA") autoResizeTextarea(input as HTMLTextAreaElement); }
  }
  setRecipientState(false); selectedContragentId = null; updateAllBd(null);
}

export async function handleDhereloContragent() {
  contragentController?.abort();
  const controller = new AbortController(); contragentController = controller;
  contragentData = []; selectedContragentId = null; contragentOwner = currentActor();
  document.addEventListener("sto:other-bases-closed", () => { controller.abort(); selectedContragentId = null; contragentData = []; }, { signal: controller.signal });

  const rightPanel = document.querySelector(
    ".modal-right-all_other_bases",
  ) as HTMLDivElement;
  if (!rightPanel) {
    // console.error("❌ Не знайдено правої панелі модального вікна");
    return;
  }

  const globalSearch = document.getElementById("global-search-wrap");
  if (globalSearch) {
    globalSearch.classList.add("hidden-all_other_bases");
  }

  const existing = document.getElementById("contragent-form");
  if (existing) existing.remove();

  const formContainer = document.createElement("div");
  formContainer.id = "contragent-form";
  formContainer.style.cssText =
    "display: flex; flex-direction: column; gap: 5px; padding: 0;";

  // Створення елементів форми
  const createTextarea = (id: string, label: string, placeholder: string) => {
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";

    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    labelEl.style.cssText =
      "font-weight: 500; margin-bottom: 5px; display: block;";

    const textarea = document.createElement("textarea");
    textarea.id = id;
    textarea.className = "textarea-all_other_bases";
    textarea.placeholder = placeholder;
    textarea.autocomplete = "off";
    textarea.rows = 1;
    textarea.style.cssText = `
      resize: none; overflow-y: hidden; min-height: 38px;
      padding-top: 8px; line-height: 1.4; width: 100%; box-sizing: border-box;
    `;
    textarea.addEventListener("input", () => autoResizeTextarea(textarea));

    wrapper.appendChild(labelEl);
    wrapper.appendChild(textarea);
    return { wrapper, textarea };
  };

  // Одержувач (з dropdown)
  const receiverWrapper = document.createElement("div");
  receiverWrapper.style.position = "relative";

  const receiverLabel = document.createElement("label");
  receiverLabel.textContent = "Рахунок Одержувач:";
  receiverLabel.style.cssText =
    "font-weight: 500; margin-bottom: 5px; display: block;";

  const receiverInput = document.createElement("textarea");
  receiverInput.id = "contragent-receiver";
  receiverInput.className = "textarea-all_other_bases";
  receiverInput.placeholder = "Введіть одержувача...";
  receiverInput.autocomplete = "off";
  receiverInput.rows = 1;
  receiverInput.style.cssText = `
    resize: none; overflow-y: hidden; min-height: 38px;
    padding-top: 8px; line-height: 1.4; width: 100%; box-sizing: border-box;
  `;

  const receiverDropdown = document.createElement("div");
  receiverDropdown.className = "contragent-dropdown custom-dropdown hidden-all_other_bases";

  receiverWrapper.appendChild(receiverLabel);
  receiverWrapper.appendChild(receiverInput);
  receiverWrapper.appendChild(receiverDropdown);

  // Setup keyboard navigation

  // ЗАТВЕРДЖУЮ
  const { wrapper: nameWrapper, textarea: nameInput } = createTextarea(
    "contragent-name",
    "Акт ЗАТВЕРДЖУЮ:",
    "Введіть назву контрагента...",
  );

  // Від Замовника
  const { wrapper: noteWrapper, textarea: noteInput } = createTextarea(
    "contragent-note",
    "Акт Від Замовника:",
    "Введіть примітку...",
  );

  // Дата і кнопка
  const dateAndButtonWrapper = document.createElement("div");
  dateAndButtonWrapper.className = "contragent-date-act-wrapper";

  const dateWrapper = document.createElement("div");
  dateWrapper.className = "contragent-date-wrapper";

  const dateLabel = document.createElement("label");
  dateLabel.textContent = "Дата:";
  dateLabel.className = "contragent-date-label";

  const dateInput = document.createElement("input");
  dateInput.type = "text";
  dateInput.id = "contragent-date";
  dateInput.className = "input-all_other_bases contragent-date-input";
  dateInput.placeholder = "Оберіть дату...";
  dateInput.readOnly = true;

  const calendar = createDatePicker(dateInput);
  dateWrapper.appendChild(dateLabel);
  dateWrapper.appendChild(dateInput);
  dateWrapper.appendChild(calendar);

  // Перемикач-повзунок Отримувач / Платник
  const toggleWrapper = document.createElement("div");
  toggleWrapper.className = "recipient-toggle-wrapper";

  const labelLeft = document.createElement("span");
  labelLeft.className =
    "recipient-toggle-label recipient-toggle-label--left active";
  labelLeft.textContent = "Платник";

  const switchOuter = document.createElement("div");
  switchOuter.className = "recipient-switch";
  switchOuter.id = "contragent-recipient-toggle";
  switchOuter.dataset.active = "false";

  const switchKnob = document.createElement("div");
  switchKnob.className = "recipient-switch__knob";
  switchOuter.appendChild(switchKnob);

  const labelRight = document.createElement("span");
  labelRight.className = "recipient-toggle-label recipient-toggle-label--right";
  labelRight.textContent = "Отримувач";

  // Інпут для номера (namber)
  const namberInput = document.createElement("input");
  namberInput.type = "number";
  namberInput.id = "contragent-namber";
  namberInput.className = "input-all_other_bases contragent-namber-input";
  namberInput.placeholder = "№ акту...";
  namberInput.style.display = "none";

  switchOuter.addEventListener("click", () => {
    const isActive = switchOuter.dataset.active === "true";
    switchOuter.dataset.active = isActive ? "false" : "true";
    switchOuter.classList.toggle("active", !isActive);
    labelLeft.classList.toggle("active", isActive);
    labelRight.classList.toggle("active", !isActive);
    // Показати інпут namber при Отримувач, приховати при Платник
    namberInput.style.display = !isActive ? "" : "none";
  });

  toggleWrapper.appendChild(labelLeft);
  toggleWrapper.appendChild(switchOuter);
  toggleWrapper.appendChild(labelRight);
  toggleWrapper.appendChild(namberInput);

  dateAndButtonWrapper.appendChild(dateWrapper);
  dateAndButtonWrapper.appendChild(toggleWrapper);

  // Функція заповнення форми
  const fillFormWithContragent = (item: ContragentRecord) => {
    if (!formContainer.isConnected || controller.signal.aborted || contragentOwner !== currentActor()) return;
    selectedContragentId = item.faktura_id; setRecipientState(item.namber != null);
    receiverInput.value = item.oderjyvach || "";
    autoResizeTextarea(receiverInput);

    nameInput.value = item.name;
    autoResizeTextarea(nameInput);

    noteInput.value = item.prumitka || "";
    autoResizeTextarea(noteInput);

    dateInput.value = isoToDots(item.data);

    namberInput.value = item.namber != null ? String(item.namber) : "";

    receiverDropdown.classList.add("hidden-all_other_bases");

    updateAllBd(
      JSON.stringify({
        table: "faktura",
        faktura_id: item.faktura_id,
        name: item.name,
        oderjyvach: item.oderjyvach,
        prumitka: item.prumitka,
        data: item.data,
      }),
    );
  };

  mountDirectoryDropdown('faktura',receiverInput,receiverDropdown,row=>{
    contragentData=[...contragentData.filter(item=>item.faktura_id!==row.faktura_id),row];
    fillFormWithContragent(row);
  },()=>{autoResizeTextarea(receiverInput);if(!receiverInput.value.trim())clearFormFields();});

  dateInput.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".contragent-calendar").forEach((cal) => {
      if (cal !== calendar) (cal as HTMLElement).style.display = "none";
    });
    receiverDropdown.classList.add("hidden-all_other_bases");

    const isVisible = calendar.style.display === "block";
    if (isVisible) {
      calendar.style.display = "none";
      return;
    }

    calendar.style.display = "block";
    calendar.style.left = "0";
    calendar.style.top = "auto";
    calendar.style.bottom = `${dateInput.offsetHeight + 5}px`;

    const calRect = calendar.getBoundingClientRect();
    if (calRect.top < 0) {
      calendar.style.bottom = "auto";
      calendar.style.top = `${dateInput.offsetHeight + 5}px`;
    }
  });

  document.addEventListener("click", (e) => {
    if (!dateWrapper.contains(e.target as Node)) {
      calendar.style.display = "none";
    }
  }, { signal: controller.signal });

  // Додаємо елементи до форми
  formContainer.appendChild(receiverWrapper);
  formContainer.appendChild(nameWrapper);
  formContainer.appendChild(noteWrapper);
  formContainer.appendChild(dateAndButtonWrapper);

  // Додаємо кнопку до контейнера кнопок
  const buttonsDiv = rightPanel.querySelector(
    ".yes-no-buttons-all_other_bases",
  );
  if (buttonsDiv) {
    (buttonsDiv as HTMLElement).style.display = "flex";
    (buttonsDiv as HTMLElement).style.justifyContent = "flex-end";
    (buttonsDiv as HTMLElement).style.width = "100%";

    rightPanel.insertBefore(formContainer, buttonsDiv);
  } else {
    rightPanel.appendChild(formContainer);
  }

  // Налаштування навігації Enter між полями
  setupEnterNavigationForFields([
    "contragent-receiver",
    "contragent-name",
    "contragent-note",
    "contragent-date",
  ]);

}

export function clearContragentForm() {
  contragentController?.abort(); contragentController = null; selectedContragentId = null; contragentOwner = "";
  const form = document.getElementById("contragent-form");
  if (form) form.remove();

  document.querySelectorAll(".contragent-calendar").forEach((cal) => {
    (cal as HTMLElement).style.display = "none";
  });

  contragentData = [];
  updateAllBd(null);
}

export function contragentFormValues(row: Partial<ContragentRecord>): Record<string, any> {
  return { name: String(row.name ?? "").trim(), oderjyvach: String(row.oderjyvach ?? "").trim(),
    prumitka: String(row.prumitka ?? "").trim(), data: dotsToISO(isoToDots(row.data ?? null)), namber: row.namber ?? null };
}
export function contragentMetadataPatch(original: ContragentRecord, values: Record<string, any>): Record<string, any> {
  const baseline = contragentFormValues(original), patch: Record<string, any> = {};
  for (const key of Object.keys(baseline)) if (values[key] !== baseline[key]) patch[key] = values[key];
  return patch;
}
function readFakturaFormPayload() {
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() ?? "";
  const number = value("contragent-namber");
  const recipient = document.getElementById("contragent-recipient-toggle")?.dataset.active === "true";
  if (recipient && (!number || !Number.isSafeInteger(Number(number)) || Number(number) < 0)) throw new Error("Для отримувача вкажіть початковий номер акта: ціле число від 0");
  return { name: value("contragent-name"), oderjyvach: value("contragent-receiver"), prumitka: value("contragent-note"),
    data: dotsToISO(value("contragent-date")), namber: recipient && number ? Number(number) : null };
}
function assertContragentReceipt(saved: any, id?: number): asserts saved is ContragentRecord {
  if (!saved || !Number.isSafeInteger(saved.faktura_id) || saved.faktura_id <= 0 || (id !== undefined && saved.faktura_id !== id) || typeof saved.name !== "string") throw new Error("Не отримано підтвердження збереження контрагента. Повторно виберіть запис зі списку.");
}
export async function tryHandleFakturaCrud(): Promise<boolean> {
  const mode = CRUD, form = document.getElementById("contragent-form"), owner = currentActor(), controller = contragentController;
  if (!form?.isConnected || !controller || controller.signal.aborted || contragentOwner !== owner) throw new Error("Повторно відкрийте форму контрагента");
  const payload = mode === "Видалити" ? { name: "", oderjyvach: "", prumitka: "", data: null, namber: null } : readFakturaFormPayload();
  if (mode !== "Видалити" && !payload.name) throw new Error("Заповніть назву контрагента");
  const id = selectedContragentId;
  const original = contragentData.find(row => row.faktura_id === id);
  if (mode !== "Додати" && (!id || !original)) throw new Error("Виберіть контрагента зі списку перед редагуванням або видаленням");
  if (mode === "Видалити") {
    try { await deleteDirectory("faktura", id!, original); }
    catch (error) { clearDirectoryReads(); throw error; }
    if (form.isConnected && contragentController === controller && !controller.signal.aborted && owner === currentActor()) {
      contragentData = contragentData.filter(row => row.faktura_id !== id);
      if (selectedContragentId === id) { selectedContragentId = null; updateAllBd(null); }
    }
    await logAction("warehouse_delete_contragent", null, { faktura_id: id }, "warehouse");
    return true;
  }
  if (mode !== "Додати" && mode !== "Редагувати") throw new Error("Невідомий режим роботи з контрагентом");
  const patch = mode === "Додати" ? payload : contragentMetadataPatch(original!, payload);
  if (!Object.keys(patch).length) return true;
  const expected = mode === "Додати" ? null : Object.fromEntries(Object.keys(patch).filter(key => Object.prototype.hasOwnProperty.call(original, key)).map(key => [key, (original as any)[key]]));
  let saved: ContragentRecord;
  try {
    const result = await supabase.rpc("traffic_contragent_write", { p_id: mode === "Додати" ? null : id, p_patch: patch, p_expected: expected });
    if (result.error) throw result.error;
    assertContragentReceipt(result.data, mode === "Редагувати" ? id! : undefined);
    saved = result.data;
  } catch (error) {
    // A re-selection must read a fresh baseline after a rejected write; never auto-retry a mutation.
    clearDirectoryReads();
    throw error;
  }
  clearDirectoryReads();
  if (owner !== currentActor()) throw new Error("Користувач змінився під час збереження. Оновіть довідник.");
  if (form.isConnected && contragentController === controller && !controller.signal.aborted) {
    contragentData = [...contragentData.filter(row => row.faktura_id !== saved.faktura_id), saved];
    if (selectedContragentId === id) {
      selectedContragentId = saved.faktura_id;
      updateAllBd(JSON.stringify({ table: "faktura", ...saved }));
    }
  }
  await logAction(mode === "Додати" ? "warehouse_add_contragent" : "warehouse_edit_contragent", null, { faktura_id: saved.faktura_id, name: saved.name }, "warehouse");
  return true;
}
