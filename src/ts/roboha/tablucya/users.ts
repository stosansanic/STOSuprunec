// src\ts\roboha\tablucya\users.ts (ОНОВЛЕНИЙ КОД - ВИПРАВЛЕНО ДУБЛІКАТИ)
import { supabase } from "../../vxid/supabaseClient";
import { redirectToIndex } from "../../utils/gitUtils";
import { initNovaPoshtaMenu } from "../../utils/novaPoshtaMenu";

// =============================================================================
// ГЛОБАЛЬНІ ЗМІННІ ТА КОНСТАНТИ
// =============================================================================

export let isAuthenticated = false;
export let userAccessLevel: string | null = null;
export let userName: string | null = null;

const USER_DATA_KEY = "userAuthData";

interface UserData {
  Name: string;
  Доступ: string;
  slyusar_id: number | null;
  timestamp: number;
  version: string;
}

// =============================================================================
// LOCAL STORAGE ФУНКЦІЇ
// =============================================================================

function saveUserDataToLocalStorage(
  name: string,
  access: string,
  slyusar_id: number | null = null,
): void {
  try {
    const userData: UserData = {
      Name: name,
      Доступ: access,
      slyusar_id: slyusar_id,
      timestamp: Date.now(),
      version: "2.0",
    };

    localStorage.setItem(USER_DATA_KEY, JSON.stringify(userData));
  } catch (error) {
    // console.error("❌ Помилка при збереженні в localStorage:", error);
  }
}

function getSavedUserDataFromLocalStorage(): {
  name: string;
  access: string;
  slyusar_id: number | null;
} | null {
  try {
    const storedData = localStorage.getItem(USER_DATA_KEY);
    if (!storedData) return null;

    const userData: UserData = JSON.parse(storedData);
    if (!userData.Name || !userData.Доступ) {
      clearSavedUserDataFromLocalStorage();
      return null;
    }

    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - userData.timestamp < thirtyDaysInMs) {
      return {
        name: userData.Name,
        access: userData.Доступ,
        slyusar_id: userData.slyusar_id || null,
      };
    } else {
      clearSavedUserDataFromLocalStorage();
    }
  } catch (error) {
    // console.error("❌ Помилка при читанні з localStorage:", error);
    clearSavedUserDataFromLocalStorage();
  }
  return null;
}

function clearSavedUserDataFromLocalStorage(): void {
  try {
    localStorage.removeItem(USER_DATA_KEY);
  } catch (error) {
    // console.error("❌ Помилка при видаленні з localStorage:", error);
  }
}

// Експорт необхідних функцій та типів
export {
  saveUserDataToLocalStorage,
  getSavedUserDataFromLocalStorage,
  clearSavedUserDataFromLocalStorage,
  type UserData,
};

// =============================================================================
// СИСТЕМА ПАРОЛІВ ТА АВТЕНТИФІКАЦІЇ
// =============================================================================

// Перевірка Name + Пароль через серверний RPC
async function checkCredentials(
  inputName: string,
  inputPassword: string,
): Promise<{
  isValid: boolean;
  accessLevel: string | null;
  userName: string | null;
  slyusar_id: number | null;
}> {
  try {
    const { data, error } = await supabase.rpc("verify_slyusar_password", {
      input_name: inputName.trim(),
      input_password: inputPassword,
    });

    if (error || !data || data.length === 0) {
      return {
        isValid: false,
        accessLevel: null,
        userName: null,
        slyusar_id: null,
      };
    }

    const result = data[0];
    if (result.is_valid) {
      return {
        isValid: true,
        accessLevel: result.user_role || "Адміністратор",
        userName: result.user_name || inputName,
        slyusar_id: result.slyusar_id,
      };
    }

    return {
      isValid: false,
      accessLevel: null,
      userName: null,
      slyusar_id: null,
    };
  } catch {
    return {
      isValid: false,
      accessLevel: null,
      userName: null,
      slyusar_id: null,
    };
  }
}

// =============================================================================
// ДОСТУП ДО НАЛАШТУВАНЬ (GET SETTING VALUE) З КЕШЕМ В localStorage
// =============================================================================

const ROLE_SETTINGS_KEY = "sto_role_settings";

// In-memory кеш (швидший за localStorage)
let roleSettingsMemoryCache: Record<string, boolean> | null = null;

/**
 * Завантажує ВСІ налаштування ролі з БД один раз і кешує в localStorage.
 * Викликати при вході та при realtime оновленні налаштувань.
 */
export async function loadRoleSettingsToCache(): Promise<void> {
  const role = userAccessLevel;
  if (!role) return;

  // Адміністратор бачить все — не потрібно кешувати
  if (role === "Адміністратор") {
    roleSettingsMemoryCache = null;
    return;
  }

  try {
    // Завантажуємо всі рядки settings з колонкою поточної ролі та data
    const { data: rows, error } = await supabase
      .from("settings")
      .select(`setting_id, "${role}", data`);

    if (error || !rows) return;

    const cache: Record<string, boolean> = {};

    for (const row of rows) {
      const sid = row.setting_id;
      const roleVal = (row as any)[role];
      // Зберігаємо значення ролі
      cache[`${sid}:${role}`] = Boolean(roleVal);
      // Також зберігаємо значення data (для getSettingBoolFromSettings)
      if (row.data !== undefined) {
        cache[`${sid}:data`] = Boolean(row.data);
      }
    }

    roleSettingsMemoryCache = cache;
    try {
      localStorage.setItem(ROLE_SETTINGS_KEY, JSON.stringify(cache));
    } catch {
      /* quota exceeded — працюємо з in-memory */
    }
  } catch {
    // Мережева помилка — залишаємо попередній кеш
  }
}

/**
 * Повертає кешовані налаштування ролі (спочатку in-memory, потім localStorage)
 */
function getRoleSettingsCache(): Record<string, boolean> | null {
  if (roleSettingsMemoryCache) return roleSettingsMemoryCache;

  try {
    const stored = localStorage.getItem(ROLE_SETTINGS_KEY);
    if (stored) {
      roleSettingsMemoryCache = JSON.parse(stored);
      return roleSettingsMemoryCache;
    }
  } catch {
    /* пошкоджені дані */
  }

  return null;
}

/** Read an isolated snapshot for Realtime comparisons without requesting the DB. */
export function getCachedRoleSettingsSnapshot(): Record<string, boolean> | null {
  const cache = getRoleSettingsCache();
  return cache ? { ...cache } : null;
}

async function getSettingValue(
  settingId: number,
  roleKey: string,
): Promise<boolean> {
  // Адміністратор — завжди true
  if (userAccessLevel === "Адміністратор") return true;

  // Читаємо з кешу
  const cache = getRoleSettingsCache();
  if (cache) {
    const cacheKey = `${settingId}:${roleKey}`;
    if (cacheKey in cache) return cache[cacheKey];
  }

  // Фоллбек: якщо кешу немає — одноразовий запит
  try {
    const { data, error } = await supabase
      .from("settings")
      .select(roleKey)
      .eq("setting_id", settingId)
      .single();

    if (error) return false;
    return Boolean((data as { [key: string]: any })?.[roleKey]);
  } catch {
    return false;
  }
}

/**
 * Очищує кеш налаштувань (викликати після зміни налаштувань в адмінці)
 */
export function clearSettingsCache(): void {
  roleSettingsMemoryCache = null;
  try {
    localStorage.removeItem(ROLE_SETTINGS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Публічна обгортка для читання конкретного налаштування ролі з кешу.
 * Використовується в settings_subscription.ts для оновлення кнопок.
 */
export async function getCachedSettingForRole(
  settingId: number,
  roleKey: string,
): Promise<boolean> {
  return getSettingValue(settingId, roleKey);
}

// =============================================================================
// НОВІ ФУНКЦІЇ: ПЕРЕВІРКА ДОСТУПУ ДЛЯ ЗАПЧАСТИСТА ТА СКЛАДОВЩИКА
// =============================================================================

/**
 * Перевірка чи може Запчастист бачити всі акти
 * setting_id 12, колонка "Запчастист"
 */
export async function canZapchastystViewAllActs(): Promise<boolean> {
  if (userAccessLevel !== "Запчастист") return true;
  return await getSettingValue(12, "Запчастист");
}

/**
 * Перевірка чи може Складовщик бачити всі акти
 * setting_id 9, колонка "Складовщик"
 */
export async function canSkladovschykViewAllActs(): Promise<boolean> {
  if (userAccessLevel !== "Складовщик") return true;
  return await getSettingValue(9, "Складовщик");
}

/**
 * Перевірка чи може Запчастист відкривати акти для перегляду
 * setting_id 13, колонка "Запчастист"
 */
export async function canZapchastystOpenActs(): Promise<boolean> {
  if (userAccessLevel !== "Запчастист") return true;
  return await getSettingValue(13, "Запчастист");
}

/**
 * Перевірка чи може Складовщик відкривати акти для перегляду
 * setting_id 10, колонка "Складовщик"
 */
export async function canSkladovschykOpenActs(): Promise<boolean> {
  if (userAccessLevel !== "Складовщик") return true;
  return await getSettingValue(10, "Складовщик");
}

/**
 * Універсальна перевірка чи може користувач бачити акти
 */
export async function canUserViewActs(): Promise<boolean> {
  if (userAccessLevel === "Запчастист") {
    return await canZapchastystViewAllActs();
  }
  if (userAccessLevel === "Складовщик") {
    return await canSkladovschykViewAllActs();
  }
  return true; // Інші ролі мають доступ
}

/**
 * Універсальна перевірка чи може користувач відкривати акти
 */
export async function canUserOpenActs(): Promise<boolean> {
  if (userAccessLevel === "Запчастист") {
    return await canZapchastystOpenActs();
  }
  if (userAccessLevel === "Складовщик") {
    return await canSkladovschykOpenActs();
  }
  return true; // Інші ролі мають доступ
}

// =============================================================================
// ОНОВЛЕННЯ ІНТЕРФЕЙСУ (ГОЛОВНА ЛОГІКА)
// =============================================================================

/**
 * Динамічне оновлення інтерфейсу на основі рівня доступу та налаштувань БД
 * Ця функція викликається ТІЛЬКИ ПІСЛЯ успішного входу з main.html
 */
export async function updateUIBasedOnAccess(
  accessLevel: string | null,
): Promise<void> {
  void initNovaPoshtaMenu(accessLevel);
  const settingsMenuItem = document
    .querySelector('[data-action="openSettings"]')
    ?.closest("li") as HTMLElement | null;
  const addClientMenuItem = document
    .querySelector('[data-action="openClient"]')
    ?.closest("li") as HTMLElement | null;
  const homeMenuItem = document
    .querySelector('[data-action="openHome"]')
    ?.closest("li") as HTMLElement | null;
  const buhhalteriyaMenuItem = document
    .querySelector('[data-action="openBukhhalteriya"]')
    ?.closest("li") as HTMLElement | null;
  // Додано для Планування
  const planuvanyaMenuItem = document
    .querySelector('[data-action="openPlanyvannya"]')
    ?.closest("li") as HTMLElement | null;

  const setVisibility = (element: HTMLElement | null, isVisible: boolean) => {
    if (element) {
      element.style.display = isVisible ? "" : "none";
    }
  };

  if (!accessLevel) {
    setVisibility(settingsMenuItem, false);
    setVisibility(addClientMenuItem, false);
    setVisibility(homeMenuItem, false);
    setVisibility(buhhalteriyaMenuItem, false);
    setVisibility(planuvanyaMenuItem, false);
    return;
  }

  let shouldRenderSettings = true;
  let shouldRenderAdd = true;
  let shouldRenderHome = true;
  let shouldRenderBuhhalteriya = true;
  let shouldRenderPlanuvannya = true;

  // --- Логіка приховування для Слюсар, Запчастист, Складовщик ---
  if (
    accessLevel === "Слюсар" ||
    accessLevel === "Запчастист" ||
    accessLevel === "Складовщик"
  ) {
    shouldRenderSettings = false;
    shouldRenderHome = false;
    shouldRenderPlanuvannya = false; // За замовчуванням приховано
  }

  // --- Перевірки для Приймальника ---
  if (accessLevel === "Приймальник") {
    shouldRenderSettings = await getSettingValue(1, "Приймальник");
    shouldRenderAdd = await getSettingValue(2, "Приймальник");
    shouldRenderBuhhalteriya = await getSettingValue(4, "Приймальник");
    shouldRenderPlanuvannya = await getSettingValue(21, "Приймальник");
  }

  // --- Перевірки для Слюсаря ---
  if (accessLevel === "Слюсар") {
    shouldRenderAdd = false;
    shouldRenderBuhhalteriya = false;
    shouldRenderPlanuvannya = await getSettingValue(6, "Слюсар");
  }

  // --- Перевірки для Запчастиста ---
  if (accessLevel === "Запчастист") {
    shouldRenderAdd = await getSettingValue(1, "Запчастист");
    shouldRenderBuhhalteriya = await getSettingValue(2, "Запчастист");
    shouldRenderPlanuvannya = await getSettingValue(23, "Запчастист");
  }

  // --- Перевірки для Складовщика ---
  if (accessLevel === "Складовщик") {
    shouldRenderAdd = await getSettingValue(1, "Складовщик");
    shouldRenderPlanuvannya = await getSettingValue(20, "Складовщик");
  }

  setVisibility(settingsMenuItem, shouldRenderSettings);
  setVisibility(addClientMenuItem, shouldRenderAdd);
  setVisibility(homeMenuItem, shouldRenderHome);
  setVisibility(buhhalteriyaMenuItem, shouldRenderBuhhalteriya);
  setVisibility(planuvanyaMenuItem, shouldRenderPlanuvannya);
}

// =============================================================================
// 🔐 СЕРВЕРНА ВЕРИФІКАЦІЯ РОЛІ (захист від підміни localStorage)
// =============================================================================

const VALID_ROLES = [
  "Адміністратор",
  "Приймальник",
  "Слюсар",
  "Запчастист",
  "Складовщик",
] as const;

/**
 * Перевіряє що роль з localStorage відповідає реальній ролі в БД.
 * Якщо localStorage підмінили — скидає сесію і перезавантажує.
 */
export async function verifyRoleIntegrity(): Promise<boolean> {
  const savedData = getSavedUserDataFromLocalStorage();
  if (!savedData || !savedData.slyusar_id) return true; // немає даних — нема що перевіряти
  const owner = localStorage.getItem(USER_DATA_KEY);

  // Перевірка що роль з localStorage — допустима
  if (
    userAccessLevel &&
    !VALID_ROLES.includes(userAccessLevel as (typeof VALID_ROLES)[number])
  ) {
    clearSavedUserDataFromLocalStorage();
    isAuthenticated = false;
    userAccessLevel = null;
    userName = null;
    return false;
  }

  try {
    const { data: slyusar, error } = await supabase
      .from("slyusars")
      .select('slyusar_id, name:data->>Name, role:data->>"Доступ"')
      .eq("slyusar_id", savedData.slyusar_id)
      .single();
    if (owner !== localStorage.getItem(USER_DATA_KEY)) return false;

    if (error || !slyusar) {
      clearSavedUserDataFromLocalStorage();
      isAuthenticated = false;
      userAccessLevel = null;
      return false;
    }

    let dbRole = slyusar.role;
    let dbName = slyusar.name;
    if (dbRole == null || dbName == null) {
      // Older projects store JSON as a string. The targeted directory RPC decodes
      // that format server-side and omits salary/act histories.
      const { data: page, error: legacyError } = await supabase.rpc("traffic_directory_page", {
        p_kind: "slyusars", p_query: "", p_offset: 0, p_exact: false, p_id: savedData.slyusar_id,
      });
      if (owner !== localStorage.getItem(USER_DATA_KEY)) return false;
      const profile = page?.items?.find((row: any) => Number(row.slyusar_id) === savedData.slyusar_id)?.data;
      if (legacyError || !profile) {
        clearSavedUserDataFromLocalStorage();
        isAuthenticated = false;
        userAccessLevel = null;
        userName = null;
        return false;
      }
      dbRole = profile.Доступ;
      dbName = profile.Name;
    }

    // Порівнюємо роль з БД з тим що в localStorage
    if (dbRole !== userAccessLevel || dbName !== userName) {
      // Роль змінилася або дані підмінено — оновлюємо на правильні
      userAccessLevel = dbRole || null;
      userName = dbName || null;

      if (userAccessLevel && userName) {
        saveUserDataToLocalStorage(
          userName,
          userAccessLevel,
          savedData.slyusar_id,
        );
      } else {
        clearSavedUserDataFromLocalStorage();
        isAuthenticated = false;
        return false;
      }
    }

    return true;
  } catch {
    // Мережева помилка — довіряємо кешу (graceful degradation)
    return true;
  }
}

// =============================================================================
// ФУНКЦІЇ АВТОВХОДУ ТА ПОКАЗУ МОДАЛЬНОГО ВІКНА
// =============================================================================

export async function attemptAutoLogin(): Promise<{
  accessLevel: string | null;
  userName: string | null;
}> {
  const savedData = getSavedUserDataFromLocalStorage();
  if (!savedData) {
    return { accessLevel: null, userName: null };
  }

  // 🔐 Google OAuth session вже перевірено в showLoginModalBeforeTable.
  // localStorage зберігає ідентифікацію слюсаря (без пароля).
  // verifyRoleIntegrity фоново перевірить що роль не змінилась.
  isAuthenticated = true;
  userAccessLevel = savedData.access;
  userName = savedData.name;

  // 🔐 Фонова верифікація ролі (не блокує UI)
  verifyRoleIntegrity();

  return { accessLevel: userAccessLevel, userName: userName };
}

export function createLoginModal(): Promise<string | null> {
  return new Promise((resolve) => {
    // ─── БЛОКУВАННЯ СПРОБ ───
    const LOCKOUT_KEY = "loginLockout";
    // Цикл: 3 спроби=3хв, 6=10хв, 9=24год, потім знову
    const LOCKOUT_STAGES = [
      { attempts: 3, duration: 3 * 60 * 1000 }, // 3 хвилини
      { attempts: 6, duration: 10 * 60 * 1000 }, // 10 хвилин
      { attempts: 9, duration: 24 * 60 * 60 * 1000 }, // 24 години
    ];

    function getLockoutData(): {
      attempts: number;
      lockedUntil: number | null;
    } {
      try {
        const raw = localStorage.getItem(LOCKOUT_KEY);
        if (raw) return JSON.parse(raw);
      } catch {
        /* */
      }
      return { attempts: 0, lockedUntil: null };
    }

    function saveLockoutData(
      attempts: number,
      lockedUntil: number | null,
    ): void {
      localStorage.setItem(
        LOCKOUT_KEY,
        JSON.stringify({ attempts, lockedUntil }),
      );
    }

    function getLockoutDuration(attempts: number): number {
      // Цикл: після 9 спроб скидаємо лічильник і повторюємо
      const cycleAttempts = ((attempts - 1) % 9) + 1;
      for (const stage of LOCKOUT_STAGES) {
        if (cycleAttempts <= stage.attempts) return stage.duration;
      }
      return LOCKOUT_STAGES[LOCKOUT_STAGES.length - 1].duration;
    }

    function formatTimeLeft(ms: number): string {
      if (ms >= 60 * 60 * 1000) {
        const h = Math.ceil(ms / (60 * 60 * 1000));
        return `${h} год${h === 1 ? "ину" : h < 5 ? "ини" : "ин"}`;
      }
      const m = Math.ceil(ms / (60 * 1000));
      return `${m} хв${m === 1 ? "илину" : m < 5 ? "илини" : "илин"}`;
    }

    // ───── ОВЕРЛЕЙ ─────
    const modal = document.createElement("div");
    modal.id = "login-modal_users";
    modal.className = "login-modal login-modal--dark";

    // ───── КОНТЕНТ ─────
    const modalContent = document.createElement("div");
    modalContent.className = "login-modal-content login-modal-content--dark";

    // ───── ПЛАВАЮЧА ІКОНКА ─────
    const icon = document.createElement("span");
    icon.className = "login-modal-icon";
    icon.textContent = "🔐";

    // ───── ЗАГОЛОВОК ─────
    const title = document.createElement("h3");
    title.textContent = "Вхід в систему";
    title.className = "login-modal-title";

    // ───── ПІДЗАГОЛОВОК ─────
    const subtitle = document.createElement("p");
    subtitle.className = "login-modal-subtitle";
    subtitle.textContent = "Оберіть користувача та введіть пароль";

    // ───── КАСТОМНИЙ DROPDOWN (portal) ─────
    const dropdownWrapper = document.createElement("div");
    dropdownWrapper.className = "custom-dropdown";
    dropdownWrapper.id = "login-dropdown-wrapper";

    // Прихований select для зберігання значення
    const nameInput = document.createElement("select") as HTMLSelectElement;
    nameInput.id = "login-name_users";
    nameInput.className = "custom-dropdown-hidden";
    (nameInput as any).autocomplete = "username";

    // Кнопка-тригер для відкриття
    const dropdownTrigger = document.createElement("button");
    dropdownTrigger.type = "button";
    dropdownTrigger.className = "custom-dropdown-trigger";
    // Solid темний фон — браузерний ButtonFace не прозорий, rgba не працює
    dropdownTrigger.style.backgroundColor = "#16213e";

    const triggerText = document.createElement("span");
    triggerText.className = "custom-dropdown-trigger-text";
    triggerText.textContent = "Оберіть користувача...";

    const triggerIcon = document.createElement("span");
    triggerIcon.className = "custom-dropdown-trigger-icon";
    triggerIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    dropdownTrigger.appendChild(triggerText);
    dropdownTrigger.appendChild(triggerIcon);

    // Список — портал до body
    const dropdownList = document.createElement("ul");
    dropdownList.className = "custom-dropdown-list";
    document.body.appendChild(dropdownList);

    let dropdownOpen = false;

    const positionList = () => {
      const rect = dropdownTrigger.getBoundingClientRect();
      dropdownList.style.position = "fixed";
      dropdownList.style.top = `${rect.bottom + 6}px`;
      dropdownList.style.left = `${rect.left}px`;
      dropdownList.style.width = `${rect.width}px`;
    };

    const openDropdown = () => {
      if (dropdownWrapper.hasAttribute("data-disabled")) return;
      dropdownOpen = true;
      positionList();
      dropdownList.classList.add("open");
      dropdownTrigger.classList.add("open");
      const activeItem = dropdownList.querySelector(
        ".custom-dropdown-item.active",
      );
      if (activeItem) {
        setTimeout(
          () =>
            activeItem.scrollIntoView({ block: "center", behavior: "smooth" }),
          50,
        );
      }
    };

    const closeDropdown = () => {
      dropdownOpen = false;
      dropdownList.classList.remove("open");
      dropdownTrigger.classList.remove("open");
      dropdownList.querySelectorAll(".custom-dropdown-item").forEach((item) => {
        item.classList.remove("highlighted");
      });
    };

    // Порожній варіант за замовчуванням
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Оберіть користувача...";
    defaultOption.disabled = true;
    defaultOption.selected = true;
    nameInput.appendChild(defaultOption);

    // Функція для оновлення випадаючого списку
    const updateDropdownList = (names: string[]) => {
      dropdownList.innerHTML = "";
      for (const name of names) {
        const li = document.createElement("li");
        li.className = "custom-dropdown-item";
        li.textContent = name;
        li.dataset.value = name;

        li.addEventListener("mousedown", (e) => {
          e.preventDefault(); // не втрачаємо фокус
        });

        li.addEventListener("click", () => {
          nameInput.value = name;
          triggerText.textContent = name;
          triggerText.classList.add("selected");
          dropdownTrigger.classList.add("has-value");
          closeDropdown();

          dropdownList
            .querySelectorAll(".custom-dropdown-item")
            .forEach((item) => {
              item.classList.remove("active");
            });
          li.classList.add("active");

          nameInput.dispatchEvent(new Event("change", { bubbles: true }));
        });

        dropdownList.appendChild(li);
      }
    };

    // Завантажити список користувачів з БД
    (async () => {
      try {
        const { data: slyusars, error } = await supabase.rpc("traffic_employee_names");
        if (!error && Array.isArray(slyusars) && modal.isConnected) {
          const names: string[] = [];
          for (const s of slyusars) {
            const name = s?.name;
            if (name && typeof name === "string" && name.trim()) {
              names.push(name.trim());
            }
          }
          names.sort((a, b) => a.localeCompare(b, "uk"));
          for (const name of names) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            nameInput.appendChild(opt);
          }
          updateDropdownList(names);
        }
      } catch {
        /* не блокуємо вхід якщо список не завантажився */
      }
    })();

    // Відкриття/закриття dropdown
    dropdownTrigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dropdownOpen) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    // Закриття при кліку зовні
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (
        !dropdownWrapper.contains(e.target as Node) &&
        !dropdownList.contains(e.target as Node)
      ) {
        closeDropdown();
      }
    };
    document.addEventListener("click", closeOnOutsideClick);

    // Перепозиціонування при скролі / resize
    const repositionOnScroll = () => {
      if (dropdownOpen) positionList();
    };
    window.addEventListener("scroll", repositionOnScroll, true);
    window.addEventListener("resize", repositionOnScroll);

    // Клавіатурна навігація
    dropdownTrigger.addEventListener("keydown", (e) => {
      if (dropdownWrapper.hasAttribute("data-disabled")) return;
      const items = Array.from(
        dropdownList.querySelectorAll<HTMLElement>(".custom-dropdown-item"),
      );
      const currentIndex = items.findIndex((item) =>
        item.classList.contains("highlighted"),
      );

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!dropdownOpen) {
          openDropdown();
          return;
        }
        items.forEach((item) => item.classList.remove("highlighted"));
        const newIndex =
          e.key === "ArrowDown"
            ? currentIndex < items.length - 1
              ? currentIndex + 1
              : 0
            : currentIndex > 0
              ? currentIndex - 1
              : items.length - 1;
        items[newIndex]?.classList.add("highlighted");
        items[newIndex]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && dropdownOpen) {
        e.preventDefault();
        const highlighted = dropdownList.querySelector<HTMLElement>(
          ".custom-dropdown-item.highlighted",
        );
        if (highlighted) highlighted.click();
        else closeDropdown();
      } else if (e.key === "Escape") {
        closeDropdown();
      }
    });

    // Збирання dropdown
    dropdownWrapper.appendChild(nameInput);
    dropdownWrapper.appendChild(dropdownTrigger);

    // ───── ІНПУТ ПАРОЛЬ ─────
    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.id = "login-input_users";
    passInput.placeholder = "Пароль (напр. 11111)";
    passInput.className = "login-input";
    passInput.autocomplete = "current-password";

    // ───── ПОВІДОМЛЕННЯ ПРО ПОМИЛКУ ─────
    const errorDiv = document.createElement("div");
    errorDiv.id = "login-error";
    errorDiv.className = "login-error-message";
    errorDiv.style.display = "none";

    // ───── КНОПКА ─────
    const button = document.createElement("button");
    button.id = "login-button_users";
    button.innerHTML = "Увійти";
    button.className = "login-button";

    // ───── ОБРОБНИКИ ПОДІЙ ─────
    const showLoginError = (message: string) => {
      errorDiv.textContent = message;
      errorDiv.style.display = "block";
      passInput.classList.remove("input-error");
      dropdownTrigger.classList.remove("input-error");
      void passInput.offsetWidth;
      passInput.classList.add("input-error");
      dropdownTrigger.classList.add("input-error");
      setTimeout(() => {
        passInput.classList.remove("input-error");
        dropdownTrigger.classList.remove("input-error");
      }, 600);
    };

    const setLoadingState = (loading: boolean) => {
      if (loading) {
        button.innerHTML = '<span class="login-spinner"></span>';
        button.setAttribute("disabled", "true");
        dropdownWrapper.setAttribute("data-disabled", "true");
        dropdownTrigger.setAttribute("disabled", "true");
        passInput.setAttribute("disabled", "true");
      } else {
        button.innerHTML = "Увійти";
        button.removeAttribute("disabled");
        dropdownWrapper.removeAttribute("data-disabled");
        dropdownTrigger.removeAttribute("disabled");
        passInput.removeAttribute("disabled");
      }
    };

    const showSuccessState = () => {
      icon.textContent = "✅";
      icon.classList.add("login-success-anim");
      title.textContent = "Ласкаво просимо!";
      title.style.color = "#4ade80";
      passInput.classList.remove("input-error");
      dropdownTrigger.classList.remove("input-error");
      passInput.classList.add("input-success");
      dropdownTrigger.classList.add("input-success");
      button.innerHTML = "✓ Успішно";
      button.style.background =
        "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)";
    };

    // Функція показу блокування
    let lockoutTimer: ReturnType<typeof setInterval> | null = null;

    const showLockoutState = (lockedUntil: number) => {
      setLoadingState(false);
      button.setAttribute("disabled", "true");
      dropdownWrapper.setAttribute("data-disabled", "true");
      dropdownTrigger.setAttribute("disabled", "true");
      passInput.setAttribute("disabled", "true");

      const updateCountdown = () => {
        const remaining = lockedUntil - Date.now();
        if (remaining <= 0) {
          if (lockoutTimer) clearInterval(lockoutTimer);
          lockoutTimer = null;
          errorDiv.style.display = "none";
          button.removeAttribute("disabled");
          dropdownWrapper.removeAttribute("data-disabled");
          dropdownTrigger.removeAttribute("disabled");
          passInput.removeAttribute("disabled");
          button.innerHTML = "Увійти";
          dropdownTrigger.focus();
          return;
        }
        const s = Math.ceil(remaining / 1000);
        const mm = Math.floor(s / 60);
        const ss = s % 60;
        const timeStr =
          mm > 0 ? `${mm}:хв ${String(ss).padStart(2, "0")}с` : `${ss}с`;
        errorDiv.textContent = `⛔ Заблоковано. Спробуйте через ${timeStr}`;
        errorDiv.style.display = "block";
      };

      updateCountdown();
      lockoutTimer = setInterval(updateCountdown, 1000);
    };

    // Перевірка блокування при старті
    const lockData = getLockoutData();
    if (lockData.lockedUntil && lockData.lockedUntil > Date.now()) {
      showLockoutState(lockData.lockedUntil);
    }

    // Клік на кнопку — перевірка
    button.addEventListener("click", async () => {
      // Перевірка блокування
      const ld = getLockoutData();
      if (ld.lockedUntil && ld.lockedUntil > Date.now()) {
        showLockoutState(ld.lockedUntil);
        return;
      }

      const loginName = nameInput.value.trim();
      const loginPass = passInput.value.trim();

      if (!loginName) {
        showLoginError("Оберіть користувача");
        nameInput.focus();
        return;
      }
      if (!loginPass) {
        showLoginError("Введіть пароль");
        passInput.focus();
        return;
      }

      setLoadingState(true);
      errorDiv.style.display = "none";

      try {
        const {
          isValid,
          accessLevel,
          userName: fetchedUserName,
          slyusar_id,
        } = await checkCredentials(loginName, loginPass);

        if (isValid) {
          // Успіх — скидаємо лічильник
          localStorage.removeItem(LOCKOUT_KEY);
          isAuthenticated = true;
          userAccessLevel = accessLevel;
          userName = fetchedUserName;

          if (userName && accessLevel) {
            saveUserDataToLocalStorage(userName, accessLevel, slyusar_id);
          }

          showSuccessState();
          setTimeout(() => {
            modal.remove();
            resolve(userAccessLevel);
          }, 700);
        } else {
          // Невірні дані — збільшуємо лічильник
          const current = getLockoutData();
          const newAttempts = (current.attempts || 0) + 1;

          // Перевірка чи потрібно блокувати
          const shouldLock = newAttempts % 3 === 0;
          if (shouldLock) {
            const duration = getLockoutDuration(newAttempts);
            const lockedUntil = Date.now() + duration;
            saveLockoutData(newAttempts, lockedUntil);
            showLoginError(`⛔ Заброковано на ${formatTimeLeft(duration)}`);
            setLoadingState(false);
            showLockoutState(lockedUntil);
          } else {
            saveLockoutData(newAttempts, null);
            const left = 3 - (newAttempts % 3);
            showLoginError(
              `Невірне ім'я або пароль (залишилось ${left} спроб)`,
            );
            setLoadingState(false);
            dropdownTrigger.focus();
          }
        }
      } catch (error) {
        showLoginError("Помилка з'єднання. Спробуйте ще раз");
        setLoadingState(false);
        resolve(null);
      }
    });

    // При виборі користувача — авто-фокус на пароль
    nameInput.addEventListener("change", () => {
      if (nameInput.value) {
        passInput.focus();
      }
    });

    // Enter для підтвердження
    const onEnter = (event: KeyboardEvent) => {
      if (event.key === "Enter") button.click();
    };
    dropdownTrigger.addEventListener("keypress", onEnter);
    passInput.addEventListener("keypress", onEnter);

    // Блокування Escape
    const preventEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", preventEscape);

    const originalRemove = modal.remove;
    modal.remove = function () {
      document.removeEventListener("keydown", preventEscape);
      document.removeEventListener("click", closeOnOutsideClick);
      window.removeEventListener("scroll", repositionOnScroll, true);
      window.removeEventListener("resize", repositionOnScroll);
      if (lockoutTimer) clearInterval(lockoutTimer);
      dropdownList.remove();
      originalRemove.call(this);
    };

    // ───── ЗБІРКА DOM ─────
    modalContent.appendChild(icon);
    modalContent.appendChild(title);
    modalContent.appendChild(subtitle);
    modalContent.appendChild(dropdownWrapper);
    modalContent.appendChild(passInput);
    modalContent.appendChild(errorDiv);
    modalContent.appendChild(button);
    modal.appendChild(modalContent);

    setTimeout(() => dropdownTrigger.focus(), 150);
    document.body.appendChild(modal);
  });
}

export async function showLoginModalBeforeTable(): Promise<string | null> {
  // 1. 🔥 ПЕРЕВІРКА ГЛОБАЛЬНОЇ СЕСІЇ (Google)
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    // console.warn(
    // "⛔ Немає авторизації Google. Модальне вікно пароля приховано.",
    // );
    redirectToIndex();
    return null;
  }

  // 2. Якщо Google-сесія є, перевіряємо чи збережений внутрішній пароль
  const { accessLevel: autoAccessLevel } = await attemptAutoLogin();

  if (autoAccessLevel) {
    // Завантажуємо налаштування ролі один раз при вході
    await loadRoleSettingsToCache();
    return autoAccessLevel;
  }

  // 3. Якщо збереженого пароля немає - ТІЛЬКИ ТОДІ показуємо модалку
  const result = await createLoginModal();
  if (result) {
    // Завантажуємо налаштування ролі один раз при вході
    await loadRoleSettingsToCache();
  }
  return result;
}

// =============================================================================
// ІНШІ ЕКСПОРТОВАНІ ФУНКЦІЇ
// =============================================================================

export function isUserAuthenticated(): boolean {
  return isAuthenticated;
}

export function logoutFromSystemAndRedirect(): void {
  // Очищаємо всі дані користувача з localStorage
  clearSavedUserDataFromLocalStorage();

  // Очищаємо додаткові ключі localStorage
  try {
    localStorage.removeItem("sto_general_settings"); // Загальні налаштування СТО
    localStorage.removeItem("current_act_pruimalnyk"); // Тимчасові дані акту
    localStorage.removeItem(ROLE_SETTINGS_KEY); // Кеш налаштувань ролі
    roleSettingsMemoryCache = null;
  } catch (e) {
    // console.warn("⚠️ Помилка при очищенні додаткових даних localStorage:", e);
  }

  // Очищаємо sessionStorage (прапори сесії)
  try {
    sessionStorage.clear();
  } catch (e) {
    // console.warn("⚠️ Помилка при очищенні sessionStorage:", e);
  }

  isAuthenticated = false;
  userAccessLevel = null;
  userName = null;
  redirectToIndex();
}

export async function initializeAuthSystem(): Promise<void> {
  // Функція більше не використовується для головної ініціалізації
}

export async function canUserSeeZarplataColumn(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role || role === "Адміністратор") {
    return true;
  }

  switch (role) {
    case "Приймальник":
      return await getSettingValue(14, "Приймальник");
    case "Слюсар":
      return await getSettingValue(1, "Слюсар");
    case "Запчастист":
      return await getSettingValue(14, "Запчастист");
    case "Складовщик":
      return await getSettingValue(11, "Складовщик");
    default:
      return true;
  }
}

async function getSettingBoolFromSettings(
  settingId: number,
  columnName: string,
): Promise<boolean> {
  // Адміністратор — завжди true
  if (userAccessLevel === "Адміністратор") return true;

  // Читаємо з кешу
  const cache = getRoleSettingsCache();
  if (cache) {
    const cacheKey = `${settingId}:${columnName}`;
    if (cacheKey in cache) return cache[cacheKey];
  }

  // Фоллбек: одноразовий запит якщо кешу немає
  try {
    const { data, error } = await supabase
      .from("settings")
      .select(columnName)
      .eq("setting_id", settingId)
      .single();

    if (error) return true;

    const safeData = data as unknown as Record<string, unknown>;
    const value = safeData?.[columnName];

    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      return v === "true" || v === "1" || v === "yes" || v === "y";
    }

    return true;
  } catch {
    return true;
  }
}

/**
 * Чи може поточний користувач бачити колонки "Ціна" та "Сума".
 */
export async function canUserSeePriceColumns(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, показуємо Ціна/Сума по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 15;
      columnName = "Приймальник";
      break;
    case "Слюсар":
      settingId = 2;
      columnName = "Слюсар";
      break;
    case "Запчастист":
      settingId = 15;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 12;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не обмежуємо Ціна/Сума.`);
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може поточний користувач закривати акти (без зауважень).
 * Перевіряє налаштування "📋 Акт Закриття акту 🗝️"
 */
export async function canUserCloseActsNormal(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn("userAccessLevel порожній, не обмежуємо закриття акту.");
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      // Приймальник завжди може закривати акти без зауважень (немає окремого налаштування)
      return true;
    case "Слюсар":
      // Слюсар не може закривати акти, тільки завершувати роботи
      return false;
    case "Запчастист":
      settingId = 16; // "📋 Акт Зариття акту 🗝️"
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 13; // "📋 Акт Закриття акту 🗝️"
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не обмежуємо закриття акту.`);
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може поточний користувач закривати акти ІЗ ЗАУВАЖЕННЯМИ.
 * Перевіряє налаштування "📋 Акт Закриття акту із зауваженнями ⚠️"
 */
export async function canUserCloseActsWithWarnings(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn("userAccessLevel порожній, не обмежуємо закриття акту.");
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 16; // "📋 Акт Закриття акту із зауваженнями ⚠️"
      columnName = "Приймальник";
      break;
    case "Слюсар":
      // Слюсар не може закривати акти із зауваженнями
      return false;
    case "Запчастист":
      settingId = 17; // "📋 Акт Закриття акту із зауваженнями ⚠️"
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 14; // "📋 Акт Закриття акту із зауваженнями ⚠️"
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не обмежуємо закриття акту.`);
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може поточний користувач відкривати закриті акти.
 */
export async function canUserOpenClosedActs(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, показуємо доступ до відкриття актів по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 17;
      columnName = "Приймальник";
      break;
    case "Слюсар":
      settingId = 5;
      columnName = "Слюсар";
      break;
    case "Запчастист":
      settingId = 18;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 15;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не обмежуємо відкриття актів.`);
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може поточний користувач додавати рядки до акту.
 */
export async function canUserAddRowToAct(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, дозволяємо додавання рядків по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор" || role === "Приймальник" || role === "Слюсар") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Запчастист":
      settingId = 22;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 19;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", дозволяємо додавання рядків.`);
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може поточний користувач бачити кнопку "Співробітники".
 */
export async function canUserSeeEmployeeButton(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, показуємо кнопку Співробітники по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 3;
      columnName = "Приймальник";
      break;
    case "Складовщик":
      settingId = 2;
      columnName = "Складовщик";
      break;
    default:
      return true;
  }

  if (settingId === null || columnName === null) {
    return true;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може користувач бачити кнопку "Склад" (Магазин).
 */
export async function canUserSeeSkladButton(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) return false;

  if (role === "Адміністратор" || role === "Складовщик") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 5;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 6;
      columnName = "Запчастист";
      break;
    default:
      return false;
  }

  if (settingId !== null && columnName !== null) {
    return await getSettingBoolFromSettings(settingId, columnName);
  }

  return false;
}

/**
 * Перевірка чи може користувач бачити кнопку "Деталі".
 */
export async function canUserSeeDetailsButton(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) return false;

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 13;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 11;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 8;
      columnName = "Складовщик";
      break;
    default:
      return false;
  }

  if (settingId !== null && columnName !== null) {
    return await getSettingBoolFromSettings(settingId, columnName);
  }

  return false;
}

// =============================================================================
// ПЕРЕВІРКА ПРАВ ДОСТУПУ ДЛЯ КНОПОК СКЛАДУ (МАГАЗИНУ)
// =============================================================================

/**
 * Перевірка чи може користувач розраховувати товари в складі/магазині.
 */
export async function canUserPayMagazine(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, дозволяємо розрахунок по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 6;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 7;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 4;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не дозволяємо розрахунок.`);
      return false;
  }

  if (settingId === null || columnName === null) {
    return false;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може користувач відміняти розрахунок товарів в складі/магазині.
 */
export async function canUserUnpayMagazine(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, дозволяємо відміну розрахунку по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 7;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 8;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 5;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(
      // `Невідома роль "${role}", не дозволяємо відміну розрахунку.`,
      // );
      return false;
  }

  if (settingId === null || columnName === null) {
    return false;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може користувач повертати товари в магазин.
 */
export async function canUserReturnMagazine(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, дозволяємо повернення по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 8;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 9;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 6;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(`Невідома роль "${role}", не дозволяємо повернення.`);
      return false;
  }

  if (settingId === null || columnName === null) {
    return false;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}

/**
 * Перевірка чи може користувач відміняти повернення товарів в магазин.
 */
export async function canUserCancelReturnMagazine(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn(
    // "userAccessLevel порожній, дозволяємо відміну повернення по замовчуванню.",
    // );
    return true;
  }

  if (role === "Адміністратор") {
    return true;
  }

  let settingId: number | null = null;
  let columnName: string | null = null;

  switch (role) {
    case "Приймальник":
      settingId = 9;
      columnName = "Приймальник";
      break;
    case "Запчастист":
      settingId = 10;
      columnName = "Запчастист";
      break;
    case "Складовщик":
      settingId = 7;
      columnName = "Складовщик";
      break;
    default:
      // console.warn(
      // `Невідома роль "${role}", не дозволяємо відміну повернення.`,
      // );
      return false;
  }

  if (settingId === null || columnName === null) {
    return false;
  }

  return await getSettingBoolFromSettings(settingId, columnName);
}
/**
 * Перевірка чи може Слюсар завершувати роботи (встановлювати slusarsOn).
 * setting_id = 3, колонка "Слюсар"
 */
export async function canSlusarCompleteTasks(): Promise<boolean> {
  const role = userAccessLevel;

  if (!role) {
    // console.warn("userAccessLevel порожній, блокуємо завершення робіт.");
    return false;
  }

  if (role !== "Слюсар") {
    return false; // Тільки для Слюсаря
  }

  return await getSettingBoolFromSettings(3, "Слюсар");
}
