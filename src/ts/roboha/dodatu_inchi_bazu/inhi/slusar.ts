import { showNotification } from '../../zakaz_naraudy/inhi/vspluvauhe_povidomlenna';
import { supabase } from "../../../vxid/supabaseClient";
import {
  updateAllBd,
  updateTableNameDisplay,
  updateCRUD,
} from "../dodatu_inchi_bazu_danux";
import { setupEnterNavigationForFields } from "../../redahyvatu_klient_machuna/enter_navigation";
import { mountDirectoryDropdown, readDirectory, writeDirectory } from './directoryRead';
let employeeSelection = 0;
let selectedEmployeeRow: any = null;
let selectedEmployeeOwner = "";
let selectedFormBaseline: Record<string, any> | null = null;
const isEmployeeFormActive = (element: HTMLElement): boolean =>
 element.isConnected && currentConfig?.table === "slyusars" &&
 !element.closest(".modal-overlay-all_other_bases")?.classList.contains("hidden-all_other_bases");
async function selectEmployee(id: number, input: HTMLInputElement, requireSelection = false): Promise<void> {
 if(!isEmployeeFormActive(input))return;
 const token=++employeeSelection, value=input.value, owner=localStorage.getItem("userAuthData") || "";
 selectedEmployeeRow=null;lastValidSlyusarId=null;updateAllBd(null);
 try {
  const page=await readDirectory('slyusars','',0,false,id);
  if(token!==employeeSelection || !isEmployeeFormActive(input) || input.value!==value || owner!==(localStorage.getItem("userAuthData") || ""))return;
  const row=page.items[0];if(!row || Number(row.slyusar_id)!==id)throw new Error("Працівника не знайдено. Повторіть пошук.");
  selectedEmployeeRow=row;selectedEmployeeOwner=owner;lastValidSlyusarId=row.slyusar_id;
  fillSlusarInputs(row.data,row.data.Name);updateAllBd(JSON.stringify({table:'slyusars',slyusar_id:row.slyusar_id,data:{Name:row.data.Name}}));
 } catch(error: any) { if(requireSelection)throw error; if(token===employeeSelection && isEmployeeFormActive(input) && owner===(localStorage.getItem("userAuthData") || "")){updateAllBd(null);showNotification(error?.message || "Не вдалося завантажити працівника. Повторіть вибір зі списку.","error");} }
}
import { logAction } from "../../../utils/auditLogger";


let currentConfig: {
  table: string;
  field: string;
  deepPath?: string[];
  needsJsonParsing?: boolean;
} | null = null;

let lastValidSlyusarId: number | null = null;

// Функція отримання даних користувача з localStorage
const getCurrentUserFromLocalStorage = (): {
  name: string;
  access: string;
  id: number | null;
} | null => {
  try {
    const userDataStr = localStorage.getItem("userAuthData");
    if (!userDataStr) return null;
    const userData = JSON.parse(userDataStr);
    return {
      name: userData.Name || "",
      access: userData.Доступ || "",
      id: Number.isSafeInteger(Number(userData.slyusar_id)) && Number(userData.slyusar_id) > 0 ? Number(userData.slyusar_id) : null,
    };
  } catch (error) {
    // console.error("Помилка отримання даних користувача з localStorage:", error);
    return null;
  }
};

const databaseMapping = {
  Слюсар: {
    table: "slyusars",
    field: "data",
    deepPath: ["Name"],
    needsJsonParsing: true,
  },
};

// Функція нормалізації імені
const normalizeName = (s: string) => {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
};

// Функція перевірки чи існує співробітник з таким іменем
export const checkEmployeeExists = async (name: string): Promise<boolean> => (await readDirectory('slyusars',name,0,true)).total > 0;

// Оновлена функція updateAllBdFromInput
const updateAllBdFromInput = async (inputValue: string, isFromDropdown = false, requireSelection = false) => {
 const input=document.getElementById("search-input-all_other_bases") as HTMLInputElement|null;
 if(!input || !isEmployeeFormActive(input))return;
 const owner=localStorage.getItem("userAuthData") || "";
 if(!inputValue.trim()){clearSlusarInputs();updateAllBd(null);return;}
 if(!currentConfig)return;
 const token=++employeeSelection;
 const page=await readDirectory('slyusars',inputValue,0,true);
 if(token!==employeeSelection || !isEmployeeFormActive(input) || input.value.trim()!==inputValue.trim() || owner!==(localStorage.getItem("userAuthData") || ""))return;
 if(page.total>1){updateAllBd(null);const message='Кілька працівників мають таке ім’я. Виберіть потрібний ID зі списку.';if(requireSelection)throw new Error(message);showNotification(message,'warning');return;}
 if(page.items[0] && input){await selectEmployee(page.items[0].slyusar_id,input,requireSelection);return;}
 if(requireSelection)throw new Error("Власний профіль працівника не знайдено. Повторіть відкриття розділу.");
 if(isFromDropdown){clearSlusarInputs();updateAllBd(JSON.stringify({table:'slyusars',slyusar_id:null,data:{Name:inputValue.trim()}}));}
};

async function selectCurrentEmployee(user: { id: number | null; name: string }, input: HTMLInputElement): Promise<void> {
  if (user.id) await selectEmployee(user.id, input, true);
  else if (user.name) await updateAllBdFromInput(user.name, true, true);
}

function fillEmployeeWarehouseOptions(select: HTMLSelectElement, warehouses: number[]): void {
  const value = select.value || "0";
  const choices = [...new Set([...warehouses, Number(value)])].filter(Number.isFinite).sort((a, b) => a - b);
  select.replaceChildren(...choices.map(number => new Option(String(number), String(number))));
  select.value = value;
}

// Оновлена функція для заповнення додаткових інпутів
export function employeeFormValues(data: any): Record<string, any> {
  const numeric = (value: unknown, fallback: number) => value == null || value === "" || !Number.isFinite(Number(value)) ? fallback : Number(value);
  return {
    Name: String(data?.Name ?? ""), Доступ: String(data?.Доступ || "Слюсар"),
    ПроцентРоботи: numeric(data?.ПроцентРоботи, 50), ПроцентЗапчастин: numeric(data?.ПроцентЗапчастин, 0), Склад: numeric(data?.Склад, 0),
  };
}
const fillSlusarInputs = (data: any, selectedName: string) => {
  const values = employeeFormValues(data);
  const isAdmin = getCurrentUserFromLocalStorage()?.access === "Адміністратор";
  const protectedEmployee = lastValidSlyusarId === 1;
  const input = document.getElementById("search-input-all_other_bases") as HTMLInputElement | null;
  const password = document.getElementById("slusar-password") as HTMLInputElement | null;
  const access = document.getElementById("slusar-access") as HTMLSelectElement | null;
  const percent = document.getElementById("slusar-percent") as HTMLInputElement | null;
  const parts = document.getElementById("slusar-percent-parts") as HTMLInputElement | null;
  const warehouse = document.getElementById("slusar-warehouse") as HTMLSelectElement | null;
  // Reset every input on selection; absent legacy fields cannot inherit another employee's values.
  if (password) {
    password.value = ""; password.placeholder = "Залиште порожнім, щоб не змінювати";
    delete password.dataset.originalHash; password.disabled = false;
  }
  if (input) {
    input.value = selectedName; input.readOnly = protectedEmployee;
    input.style.backgroundColor = protectedEmployee ? "#f9f9f9" : "";
    input.style.cursor = protectedEmployee ? "pointer" : "";
    input.title = protectedEmployee ? "Ім'я адміністратора не можна змінити. Виберіть іншого користувача зі списку." : "";
  }
  if (access) {
    access.value = values.Доступ;
    access.disabled = !isAdmin || protectedEmployee || normalizeName(selectedName) === normalizeName("Бемба В. Я");
    access.title = protectedEmployee ? "Доступ адміністраторського акаунту не можна змінити" : "";
  }
  if (percent) { percent.value = String(values.ПроцентРоботи); percent.disabled = !isAdmin; }
  if (parts) { parts.value = String(values.ПроцентЗапчастин); parts.disabled = !isAdmin; }
  if (warehouse) {
    if (!Array.from(warehouse.options).some(option => option.value === String(values.Склад))) warehouse.add(new Option(String(values.Склад), String(values.Склад)));
    warehouse.value = String(values.Склад); warehouse.disabled = !isAdmin;
  }
  updatePercentInputsVisibility(values.Доступ); updatePasswordVisibility(values.Доступ);
  selectedFormBaseline = values;
};

// Функція для завантаження списку складів з БД
let warehouseCache: number[] | null = null;
let warehousePending: Promise<number[]> | null = null;
let warehouseOwner = "", warehouseRevision = 0;
function clearEmployeeAuxiliaryReads(): void { warehouseRevision++; warehouseCache = null; warehousePending = null; }
const getWarehouseNumbers = async (): Promise<number[]> => {
  const owner = localStorage.getItem("userAuthData") || "";
  if (warehouseOwner !== owner) { clearEmployeeAuxiliaryReads(); warehouseOwner = owner; }
  if (warehouseCache) return warehouseCache;
  if (warehousePending) return warehousePending;
  const revision = warehouseRevision;
  const job = (async () => {
    const { data, error } = await supabase.from("settings").select("setting_id").not("setting_id", "is", null).not("procent", "is", null);
    if (error) throw error;
    const result = [...new Set<number>([0, ...(data || []).map((row: any) => Number(row.setting_id)).filter((id: number) => Number.isSafeInteger(id) && id >= 0)])].sort((a, b) => a - b);
    if (revision === warehouseRevision && owner === (localStorage.getItem("userAuthData") || "")) warehouseCache = result;
    return result;
  })();
  warehousePending = job;
  try { return await job; } finally { if (warehousePending === job) warehousePending = null; }
};

// Функція для керування видимістю пароля
const updatePasswordVisibility = (selectedRole: string) => {
  const passwordInput = document.getElementById(
    "slusar-password",
  ) as HTMLInputElement;
  if (!passwordInput) return;

  // Не-адмін завжди бачить зірочки; адмін бачить відкрито (крім ролі адміна)
  const currentUser = getCurrentUserFromLocalStorage();
  const isCurAdmin = currentUser?.access === "Адміністратор";
  passwordInput.type =
    !isCurAdmin || selectedRole === "Адміністратор" ? "password" : "text";
};

// Функція для керування видимістю інпутів
const updatePercentInputsVisibility = (role: string) => {
  const percentWrapper = document.getElementById("slusar-percent");
  const partsWrapper = document.getElementById("slusar-percent-parts-wrapper");
  const warehouseWrapper = document.getElementById("slusar-warehouse-wrapper");

  // Для Запчастиста: показуємо % з запчастин та Склад (ховаємо % роботи)
  if (role === "Запчастист") {
    if (percentWrapper) {
      percentWrapper.parentElement?.classList.add("hidden-all_other_bases");
    }
    if (partsWrapper) {
      partsWrapper.classList.remove("hidden-all_other_bases");
    }
    if (warehouseWrapper) {
      warehouseWrapper.classList.remove("hidden-all_other_bases");
    }
  }
  // Для Приймальника: показуємо % з запчастин та Склад (разом з % роботи)
  else if (role === "Приймальник") {
    if (percentWrapper) {
      percentWrapper.parentElement?.classList.remove("hidden-all_other_bases");
    }
    if (partsWrapper) {
      partsWrapper.classList.remove("hidden-all_other_bases");
    }
    if (warehouseWrapper) {
      warehouseWrapper.classList.remove("hidden-all_other_bases");
    }
  }
  // Для інших ролей: показуємо тільки % роботи (ховаємо запчастини та склад)
  else {
    if (percentWrapper) {
      percentWrapper.parentElement?.classList.remove("hidden-all_other_bases");
    }
    if (partsWrapper) {
      partsWrapper.classList.add("hidden-all_other_bases");
    }
    if (warehouseWrapper) {
      warehouseWrapper.classList.add("hidden-all_other_bases");
    }
  }
};

// Функція для очищення додаткових інпутів
const clearSlusarInputs = () => {
  employeeSelection++;
  selectedEmployeeRow = null;
  selectedFormBaseline = null;
  selectedEmployeeOwner = "";
  lastValidSlyusarId = null; // Скидаємо збережений ID
  const passwordInput = document.getElementById(
    "slusar-password",
  ) as HTMLInputElement;
  const accessSelect = document.getElementById(
    "slusar-access",
  ) as HTMLSelectElement;
  const percentInput = document.getElementById(
    "slusar-percent",
  ) as HTMLInputElement;
  const percentPartsInput = document.getElementById(
    "slusar-percent-parts",
  ) as HTMLInputElement;
  const warehouseSelect = document.getElementById(
    "slusar-warehouse",
  ) as HTMLSelectElement;
  const searchInput = document.getElementById(
    "search-input-all_other_bases",
  ) as HTMLInputElement;

  const currentUser = getCurrentUserFromLocalStorage();
  const isAdmin = currentUser?.access === "Адміністратор";

  // Скидаємо стан поля пошуку
  if (searchInput) {
    searchInput.readOnly = false;
    searchInput.disabled = false;
    searchInput.style.backgroundColor = "";
    searchInput.style.cursor = "";
    searchInput.title = "";
  }

  if (passwordInput) {
    passwordInput.value = "";
    passwordInput.disabled = false; // Пароль завжди доступний
  }
  if (accessSelect) {
    accessSelect.value = "Слюсар";
    accessSelect.disabled = !isAdmin; // Блокуємо для не-адміністраторів
    // Скидаємо видимість (для Слюсаря поле запчастин приховане)
    updatePercentInputsVisibility("Слюсар");
    updatePasswordVisibility("Слюсар");
  }
  if (percentInput) {
    percentInput.value = "50";
    percentInput.disabled = !isAdmin; // Блокуємо для не-адміністраторів
  }
  if (percentPartsInput) {
    percentPartsInput.value = "0";
    percentPartsInput.disabled = !isAdmin; // Блокуємо для не-адміністраторів
  }
  if (warehouseSelect) {
    warehouseSelect.value = "0";
    warehouseSelect.disabled = !isAdmin; // Блокуємо для не-адміністраторів
  }
};

const createCustomDropdown = (inputElement: HTMLInputElement | null) => {
 const dropdown = document.getElementById('custom-dropdown-all_other_bases'); if(!inputElement || !dropdown)return;
 mountDirectoryDropdown('slyusars',inputElement,dropdown,row=>{void selectEmployee(row.slyusar_id,inputElement);},()=>{employeeSelection++;if(!inputElement.value.trim()){clearSlusarInputs();selectedEmployeeRow=null;updateAllBd(null);}else updateAllBd(JSON.stringify({table:'slyusars',slyusar_id:lastValidSlyusarId,data:selectedEmployeeRow?.data || {Name:inputElement.value.trim()}}));});
};

// Функція для отримання та відображення статистики співробітників
const fetchAndDisplayEmployeeStats = async (container: HTMLElement | null) => {
  if (!container || !isEmployeeFormActive(container)) return;
  try {
    // One tiny aggregate replaces paging through every employee just to count roles.
    const { data: counts, error } = await supabase.rpc("traffic_employee_counts");
    if (error) throw error;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new Error("Некоректна статистика співробітників");
    if (container && isEmployeeFormActive(container)) container.textContent = Object.entries(counts).map(([role, count]) => role + ': ' + count).join(', ');
  } catch { if (container && isEmployeeFormActive(container)) container.textContent = "Статистика недоступна"; }
};

// Функція для створення додаткових інпутів
const createSlusarAdditionalInputs = async () => {
  const rightContent = document.querySelector(".modal-right-all_other_bases");
  if (!rightContent || !isEmployeeFormActive(rightContent as HTMLElement)) return;
  if (document.getElementById("slusar-additional-inputs")) {
    return;
  }

  // Отримуємо поточного користувача
  const currentUser = getCurrentUserFromLocalStorage();
  const isAdmin = currentUser?.access === "Адміністратор";

  // ✅ ВИПРАВЛЕННЯ: рендеримо HTML одразу (без очікування БД),
  // склади і статистика підвантажуються у фоні паралельно
  const additionalInputsContainer = document.createElement("div");
  additionalInputsContainer.id = "slusar-additional-inputs";
  additionalInputsContainer.className = "slusar-additional-inputs";
  additionalInputsContainer.innerHTML = `
    <div class="slusar-input-group">
      <label for="slusar-password" class="label-all_other_bases">Пароль:</label>
      <input type="password" id="slusar-password" class="input-all_other_bases" placeholder="Введіть пароль" autocomplete="new-password">
    </div>
    <div class="slusar-input-group">
      <label for="slusar-access" class="label-all_other_bases">Доступ:</label>
      <select id="slusar-access" class="input-all_other_bases" ${
        !isAdmin ? "disabled" : ""
      }>
        <option value="Адміністратор">Адміністратор</option>
        <option value="Приймальник">Приймальник</option>  
        <option value="Слюсар" selected>Слюсар</option>
        <option value="Запчастист">Запчастист</option>
        <option value="Складовщик">Складовщик</option>                              
      </select>
    </div>
    <div class="slusar-percent-container">
      <div class="slusar-input-group slusar-percent-half" id="slusar-percent-wrapper">
        <label for="slusar-percent" class="label-all_other_bases">% роботи:</label>
        <input type="number" id="slusar-percent" class="input-all_other_bases" placeholder="Від 0 до 100" min="0" max="100" value="50" ${
          !isAdmin ? "disabled" : ""
        }>
      </div>
      <div class="slusar-input-group slusar-percent-half hidden-all_other_bases" id="slusar-percent-parts-wrapper">
        <label for="slusar-percent-parts" class="label-all_other_bases">% з запчастин:</label>
        <input type="number" id="slusar-percent-parts" class="input-all_other_bases" placeholder="Від 0 до 100" min="0" max="100" value="0" ${
          !isAdmin ? "disabled" : ""
        }>
      </div>
      <div class="slusar-input-group slusar-percent-half hidden-all_other_bases" id="slusar-warehouse-wrapper">
        <label for="slusar-warehouse" class="label-all_other_bases">Склад:</label>
        <select id="slusar-warehouse" class="input-all_other_bases" ${
          !isAdmin ? "disabled" : ""
        }>
          <option value="0">Завантаження...</option>
        </select>
      </div>
    </div>
    <div class="slusar-stats-container">
      <div class="employee-stats-label">Статистика співробітників:</div>
      <div id="employee-stats-container" class="employee-stats-content">Завантаження...</div>
    </div>
  `;
  const yesNoButtons = rightContent.querySelector(
    ".yes-no-buttons-all_other_bases",
  );
  if (yesNoButtons) {
    rightContent.insertBefore(additionalInputsContainer, yesNoButtons);
  }

  // Додаємо обробник зміни ролі
  const accessSelect = document.getElementById(
    "slusar-access",
  ) as HTMLSelectElement;
  if (accessSelect) {
    accessSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      updatePercentInputsVisibility(target.value);
      updatePasswordVisibility(target.value);
    });
    // Ініціалізація початкового стану (за замовчуванням Слюсар - приховано)
    updatePercentInputsVisibility(accessSelect.value);
    updatePasswordVisibility(accessSelect.value);
  }

  // ✅ Завантажуємо склади і статистику ПАРАЛЕЛЬНО у фоні (не блокуємо UI)
  const warehouseSelect = additionalInputsContainer.querySelector<HTMLSelectElement>("#slusar-warehouse");
  const owner = localStorage.getItem("userAuthData") || "";
  getWarehouseNumbers().then((warehouses) => {
    if (warehouseSelect && isEmployeeFormActive(warehouseSelect) && owner === (localStorage.getItem("userAuthData") || "")) {
      fillEmployeeWarehouseOptions(warehouseSelect, warehouses);
    }
  }).catch(() => {
    if (warehouseSelect && isEmployeeFormActive(warehouseSelect) && owner === (localStorage.getItem("userAuthData") || "")) {
      fillEmployeeWarehouseOptions(warehouseSelect, []);
    }
  });
  void fetchAndDisplayEmployeeStats(additionalInputsContainer.querySelector<HTMLElement>("#employee-stats-container"));

  // Налаштування навігації Enter між полями
  setupEnterNavigationForFields([
    "search-input-all_other_bases",
    "slusar-password",
    "slusar-access",
    "slusar-percent",
    "slusar-percent-parts",
    "slusar-warehouse",
  ]);
};

// Функція для видалення додаткових інпутів
const removeSlusarAdditionalInputs = () => {
  employeeSelection++;
  selectedEmployeeRow = null;
  selectedFormBaseline = null;
  selectedEmployeeOwner = "";
  lastValidSlyusarId = null;
  currentConfig = null;
  const additionalInputs = document.getElementById("slusar-additional-inputs");
  if (additionalInputs) {
    additionalInputs.remove();
  }
};

const loadDatabaseData = async (buttonText: string) => {
  const token=++employeeSelection;
  selectedEmployeeRow = null;
  lastValidSlyusarId = null;
  const config = databaseMapping[buttonText as keyof typeof databaseMapping];
  if (!config) return;
  currentConfig = config;
  try {
    const searchInput = document.getElementById(
      "search-input-all_other_bases",
    ) as HTMLInputElement;
    if(!searchInput || !isEmployeeFormActive(searchInput))return;
    searchInput.readOnly = false;
    searchInput.title = "";

    // Отримуємо поточного користувача
    const currentUser = getCurrentUserFromLocalStorage();
    const isAdmin = currentUser?.access === "Адміністратор";

    // The dropdown reads compact names lazily; the selected profile is a separate ID lookup.
    await createSlusarAdditionalInputs();
    if(token!==employeeSelection || currentConfig!==config || !isEmployeeFormActive(searchInput))return;

    // Отримуємо кнопку режиму
    const modeButton = document.getElementById(
      "modeToggleLabel",
    ) as HTMLButtonElement;

    if (!isAdmin && (currentUser?.id || currentUser?.name)) {
      // Для не-адміністраторів: блокуємо поле пошуку і заповнюємо їхнє ім'я
      if (searchInput) {
        searchInput.value = currentUser.name || "";
        searchInput.disabled = true;
        searchInput.style.backgroundColor = "#f0f0f0";
        searchInput.style.cursor = "not-allowed";
      }

      // Keep the exported mode and the main modal mode switch in agreement.
      updateCRUD("Редагувати");
      // Встановлюємо кнопку в режим "Редагувати"
      if (modeButton) {
        modeButton.textContent = "Редагувати";
        modeButton.style.color = "orange";
        modeButton.disabled = true;
        modeButton.style.cursor = "not-allowed";
      }

      // Приховуємо кнопки імпорту/експорту для не-адміністраторів
      const importBtn = document.getElementById("import-excel-btn");
      const exportBtn = document.getElementById("export-works-excel-btn");
      if (importBtn) importBtn.style.display = "none";
      if (exportBtn) exportBtn.style.display = "none";
    } else {
      // Для адміністраторів: звичайна поведінка
      if (searchInput) {
        searchInput.value = "";
        searchInput.disabled = false;
        searchInput.style.backgroundColor = "";
        searchInput.style.cursor = "";
      }
      if (modeButton) {
        modeButton.disabled = false;
        modeButton.style.cursor = "pointer";
      }
    }

    updateAllBd(
      JSON.stringify(
        {
          config: config,
          table: config.table,
          input: currentUser?.name || "",
        },
        null,
        2,
      ),
    );
    updateTableNameDisplay(buttonText, config.table);

    createCustomDropdown(searchInput);

    // Для не-адміністраторів автоматично завантажуємо їхні дані
    if (!isAdmin && currentUser && searchInput) {
      await selectCurrentEmployee(currentUser, searchInput);
    }
  } catch (err) {
    // The parent section owns the initialization notice and must remain retryable.
    if (token === employeeSelection) updateAllBd(null);
    throw err;
  }
};

// Функція для отримання даних з додаткових інпутів
export const getSlusarAdditionalData = () => {
  const value = (id: string, fallback: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? fallback;
  const percent = Number(value("slusar-percent", "50")), percentParts = Number(value("slusar-percent-parts", "0"));
  const warehouse = Number(value("slusar-warehouse", "0"));
  for (const number of [percent, percentParts]) if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error("Відсоток має бути числом від 0 до 100");
  if (!Number.isSafeInteger(warehouse) || warehouse < 0) throw new Error("Виберіть коректний склад");
  return { password: value("slusar-password", "").trim(), access: value("slusar-access", "Слюсар"), percent, percentParts, warehouse };
};

export const handleSlusarClick = async () => {
  await loadDatabaseData("Слюсар");
};

// Додаємо обробник для кнопки "Ок" - ТІЛЬКИ ПОКАЗУЄ МОДАЛЬНЕ ВІКНО
export const initYesButtonHandler = () => {
  // Обробник прибрано - збереження тепер тільки через модальне вікно з перевіркою пароля
};

export const initSlusar = () => {
  initYesButtonHandler();
  document.addEventListener("sto:other-bases-closed", () => {
    if (currentConfig?.table === "slyusars") {
      const input = document.getElementById("search-input-all_other_bases") as HTMLInputElement | null;
      (input as (HTMLInputElement & { __directoryController?: AbortController }) | null)?.__directoryController?.abort();
      updateAllBd(null);
    }
    removeSlusarAdditionalInputs(); clearEmployeeAuxiliaryReads();
  });
  document.addEventListener("other-base-data-updated", clearEmployeeAuxiliaryReads);
  document.addEventListener("settings-updated", clearEmployeeAuxiliaryReads);
  window.addEventListener("storage", event => { if (!event.key || event.key === "userAuthData") clearEmployeeAuxiliaryReads(); });
  supabase.auth.onAuthStateChange(clearEmployeeAuxiliaryReads);
  document.addEventListener("table-changed", (event: any) => {
    if (event.detail?.table !== "slyusars") {
      removeSlusarAdditionalInputs();
    }
  });
};

// Функція збереження даних слюсаря (викликається з модального вікна після перевірки пароля)
export function employeeMetadataPatch(current: any, baseline: Record<string, any>, values: Record<string, any>, isAdmin: boolean, id: number): Record<string, any> {
  const patch: Record<string, any> = {};
  const fields = isAdmin ? ["Name", "Доступ", "ПроцентРоботи", "ПроцентЗапчастин", "Склад"] : [];
  for (const key of fields) {
    if (id === 1 && (key === "Name" || key === "Доступ")) continue;
    if (values[key] !== baseline[key] && values[key] !== current[key]) patch[key] = values[key];
  }
  if (isAdmin && values.Доступ === "Запчастист" && values.Доступ !== baseline.Доступ && Number(current.ПроцентРоботи || 0) !== 0) patch.ПроцентРоботи = 0;
  if (values.Пароль && values.Пароль !== current.Пароль) patch.Пароль = values.Пароль;
  return patch;
}
export const saveSlusarData = async (): Promise<boolean> => {
  const input = document.getElementById("search-input-all_other_bases") as HTMLInputElement | null;
  const rows = selectedEmployeeRow, baseline = selectedFormBaseline;
  if (!input || !isEmployeeFormActive(input) || !rows || !baseline || rows.slyusar_id !== lastValidSlyusarId || selectedEmployeeOwner !== (localStorage.getItem("userAuthData") || "")) throw new Error("Виберіть працівника зі списку перед редагуванням");
  const name = input.value.trim();
  if (!name) throw new Error("Введіть ім’я працівника");
  const user = getCurrentUserFromLocalStorage(), isAdmin = user?.access === "Адміністратор";
  if (!isAdmin && (user?.id ? rows.slyusar_id !== user.id : normalizeName(name) !== normalizeName(user?.name || ""))) throw new Error("Можна змінювати лише власний пароль");
  const field = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  const values = {
    Name: name, Доступ: field("slusar-access"), Пароль: field("slusar-password").trim(),
    ПроцентРоботи: Number(field("slusar-percent")), ПроцентЗапчастин: Number(field("slusar-percent-parts")), Склад: Number(field("slusar-warehouse")),
  };
  if (isAdmin) {
    for (const key of ["ПроцентРоботи", "ПроцентЗапчастин"] as const) if (values[key] !== baseline[key] && (!Number.isFinite(values[key]) || values[key] < 0 || values[key] > 100)) throw new Error("Відсоток має бути числом від 0 до 100");
    if (values.Склад !== baseline.Склад && (!Number.isSafeInteger(values.Склад) || values.Склад < 0)) throw new Error("Виберіть коректний склад");
    if (values.Доступ !== baseline.Доступ && !values.Доступ) throw new Error("Оберіть роль працівника");
  }
  const current = typeof rows.data === "string" ? JSON.parse(rows.data) : rows.data;
  const patch = employeeMetadataPatch(current, baseline, values, isAdmin, rows.slyusar_id);
  if (!Object.keys(patch).length) return true;
  const selection = employeeSelection, owner = selectedEmployeeOwner;
  const saved = await writeDirectory("slyusars", rows.slyusar_id, patch, current);
  if (selection === employeeSelection && selectedEmployeeRow === rows && isEmployeeFormActive(input) && document.getElementById("search-input-all_other_bases") === input && owner === (localStorage.getItem("userAuthData") || "")) {
    selectedEmployeeRow = saved.row; fillSlusarInputs(saved.row.data, saved.row.data.Name);
  }
  if (saved.status !== "unchanged") await logAction("settings_edit_worker", null, {
    slyusar_id: rows.slyusar_id, name: saved.row.data.Name, access: saved.row.data.Доступ,
    changes: Object.keys(patch).map(key => key === "Пароль" ? "Пароль змінено" : key + ": " + (current[key] ?? "—") + " → " + patch[key]),
  }, "settings");
  return true;
};

export { removeSlusarAdditionalInputs };
