// src/ts/roboha/ai/aiService.ts
// Модуль штучного інтелекту для СТО
import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { globalCache } from "../zakaz_naraudy/globalCache";
import { readPriceSummary, invalidatePriceSummaries } from "./priceSummary";

// ============================================================================
// ТИПИ ТА ІНТЕРФЕЙСИ
// ============================================================================

export interface AISettings {
  enabled: boolean; // Чи увімкнено ШІ (setting_id: 10)
  model: string; // Модель (setting_id: 12, за замовчуванням gemini-2.0-flash)
}

export interface PriceSuggestion {
  avgPrice: number; // Середня ціна
  minPrice: number; // Мінімальна ціна
  maxPrice: number; // Максимальна ціна
  count: number; // Кількість записів для розрахунку
  source: "history" | "ai"; // Джерело даних
  confirmed: boolean; // Чи підтверджено користувачем
  // Додаткові підказки для робіт
  avgQuantity?: number; // Середня кількість
  avgSalary?: number; // Середня зарплата
  mostFrequentSlyusar?: string; // Найчастіший виконавець
}

export interface SalarySuggestion {
  amount: number; // Сума зарплати
  percent: number; // Відсоток
  source: "history" | "ai"; // Джерело
  slyusarName: string; // Ім'я слюсаря
  workName: string; // Назва роботи
}

// ============================================================
// КЕШУВАННЯ НАЛАШТУВАНЬ AI
// ============================================================

let aiSettingsCache: AISettings | null = null;
let aiSettingsCacheLoaded = false;

// Кеш середніх цін для швидкого доступу
// Кеш зарплат слюсарів
const salaryCacheMap = new Map<string, SalarySuggestion>();

// ============================================================
// ФУНКЦІЇ РОБОТИ З НАЛАШТУВАННЯМИ AI
// ============================================================

/**
 * Завантажує налаштування AI з globalCache
 * Тепер AI toggle зберігається в setting_id=7, data колонці
 */
export async function loadAISettings(): Promise<AISettings> {
  if (aiSettingsCacheLoaded && aiSettingsCache) {
    return aiSettingsCache;
  }

  const settings: AISettings = {
    enabled: globalCache.generalSettings.aiEnabled || false,
    model: "gemini-2.0-flash",
  };

  aiSettingsCache = settings;
  aiSettingsCacheLoaded = true;

  return settings;
}

/**
 * Зберігає налаштування AI в базу даних
 */
export async function saveAISettings(
  settings: Partial<AISettings>,
): Promise<boolean> {
  try {
    const updates: Array<{ id: number; value: string }> = [];

    if (settings.enabled !== undefined) {
      updates.push({ id: 10, value: String(settings.enabled) });
    }
    if (settings.model !== undefined) {
      updates.push({ id: 12, value: settings.model });
    }

    for (const { id, value } of updates) {
      // Перевіряємо чи існує запис
      const { data: existing } = await supabase
        .from("settings")
        .select("setting_id")
        .eq("setting_id", id)
        .single();

      if (existing) {
        const { error } = await supabase
          .from("settings")
          .update({ Загальні: value })
          .eq("setting_id", id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("settings")
          .insert({ setting_id: id, Загальні: value, data: false });
        if (error) throw error;
      }
    }

    // Оновлюємо кеш
    if (aiSettingsCache) {
      if (settings.enabled !== undefined)
        aiSettingsCache.enabled = settings.enabled;
      if (settings.model !== undefined) aiSettingsCache.model = settings.model;
    }

    return true;
  } catch (err) {
    // console.error("❌ Помилка збереження AI налаштувань:", err);
    return false;
  }
}

/**
 * Перевіряє чи увімкнено AI
 * Для базових підказок з історії токен НЕ потрібен
 */
export async function isAIEnabled(): Promise<boolean> {
  const settings = await loadAISettings();
  return settings.enabled;
}

/**
 * Скидає кеш AI налаштувань
 */
export function resetAISettingsCache(): void {
  aiSettingsCache = null;
  aiSettingsCacheLoaded = false;
  invalidatePriceSummaries();
  salaryCacheMap.clear();
}

// ============================================================================
// ФУНКЦІЇ РОЗРАХУНКУ СЕРЕДНІХ ЦІН
// ============================================================================

/**
 * Отримує середню ціну для роботи/деталі з історії актів
 * @param itemName - назва роботи або деталі
 * @param itemType - тип: "work" або "detail"
 */
export async function getAveragePriceFromHistory(
  itemName: string,
  itemType: "work" | "detail",
): Promise<PriceSuggestion | null> {
  try {
    return await readPriceSummary(itemName, itemType);
  } catch (error: any) {
    showNotification(`Помилка отримання історії цін: ${error?.message || "Невідома помилка"}`, "error");
    return null;
  }
}
// ============================================================================
// ФУНКЦІЇ РОЗРАХУНКУ ЗАРПЛАТ
// ============================================================================

/**
 * Шукає зарплату в історії слюсаря для подібної роботи
 */
export async function findSalaryInHistory(
  slyusarName: string,
  workName: string,
  price: number,
): Promise<SalarySuggestion | null> {
  if (!slyusarName?.trim() || !workName?.trim()) return null;

  const cacheKey = `salary:${slyusarName.toLowerCase()}:${workName.toLowerCase()}`;

  if (salaryCacheMap.has(cacheKey)) {
    return salaryCacheMap.get(cacheKey)!;
  }

  try {
    // Завантажуємо історію слюсаря
    const { data: slyusars, error } = await supabase
      .from("slyusars")
      .select("Name, Історія")
      .ilike("Name", slyusarName);

    if (error) throw error;
    if (!slyusars?.length) return null;

    const slyusar = slyusars[0] as any;
    const history = slyusar["Історія"] as Record<string, any>;

    if (!history || typeof history !== "object") return null;

    const workNameLower = workName.toLowerCase();
    const salaryEntries: Array<{ salary: number; price: number }> = [];

    // Шукаємо подібні роботи в історії
    for (const dateKey in history) {
      const dayBucket = history[dateKey];
      if (!Array.isArray(dayBucket)) continue;

      for (const actEntry of dayBucket) {
        const zapisi = actEntry?.["Записи"];
        if (!Array.isArray(zapisi)) continue;

        for (const record of zapisi) {
          const recordWorkLower = (record.Робота || "").toLowerCase();

          // Шукаємо схожі роботи
          if (
            recordWorkLower.includes(workNameLower) ||
            workNameLower.includes(recordWorkLower)
          ) {
            if (record.Зарплата > 0 && record.Ціна > 0) {
              salaryEntries.push({
                salary: record.Зарплата,
                price: record.Ціна,
              });
            }
          }
        }
      }
    }

    if (salaryEntries.length === 0) return null;

    // Обчислюємо Помірний відсоток
    const percentages = salaryEntries.map((e) => (e.salary / e.price) * 100);
    const avgPercent =
      percentages.reduce((a, b) => a + b, 0) / percentages.length;
    const calculatedSalary = Math.floor((price * avgPercent) / 100);

    const suggestion: SalarySuggestion = {
      amount: calculatedSalary,
      percent: Math.round(avgPercent),
      source: "history",
      slyusarName,
      workName,
    };

    salaryCacheMap.set(cacheKey, suggestion);

    return suggestion;
  } catch (err) {
    // console.error("❌ Помилка пошуку зарплати в історії:", err);
    return null;
  }
}

// ============================================================================
// МОДАЛЬНЕ ВІКНО ВВЕДЕННЯ ТОКЕНА
// ============================================================================

const AI_TOKEN_MODAL_ID = "ai-token-modal";

/**
 * Створює та показує модальне вікно для налаштування ШІ Атлас
 */
export function showAITokenModal(onSave?: () => void): void {
  // Видаляємо попереднє вікно якщо є
  const existing = document.getElementById(AI_TOKEN_MODAL_ID);
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = AI_TOKEN_MODAL_ID;
  modal.className = "ai-token-modal";
  modal.innerHTML = `
    <div class="ai-token-modal-content">
      <div class="ai-token-modal-header">
        <h3>🤖 Налаштування ШІ Атлас</h3>
        <button class="ai-token-close-btn" id="ai-token-close">×</button>
      </div>
      <div class="ai-token-modal-body">
        <p class="ai-token-description">
          ШІ Атлас використовує спільні ключі Gemini, налаштовані в чаті.<br>
          Тут ви можете увімкнути/вимкнути допомогу ШІ в замовленнях-нарядах.
        </p>
        <div class="ai-token-model-group">
          <label for="ai-model-select">Модель підказок:</label>
          <select id="ai-model-select">
            <option value="gemini-2.0-flash" selected>Gemini 2.0 Flash (рекомендовано)</option>
            <option value="gemini-1.5-flash">Gemini 1.5 Flash (швидка)</option>
            <option value="gemini-1.5-pro">Gemini 1.5 Pro (точна)</option>
          </select>
        </div>
      </div>
      <div class="ai-token-modal-footer">
        <button type="button" id="ai-token-cancel" class="ai-token-btn cancel">Скасувати</button>
        <button type="button" id="ai-token-save" class="ai-token-btn save">Зберегти</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Завантажуємо поточні налаштування
  loadAISettings().then((settings) => {
    const modelSelect = modal.querySelector(
      "#ai-model-select",
    ) as HTMLSelectElement;

    if (modelSelect && settings.model) {
      modelSelect.value = settings.model;
    }
  });

  // Обробники
  const closeBtn = modal.querySelector("#ai-token-close") as HTMLButtonElement;
  const cancelBtn = modal.querySelector(
    "#ai-token-cancel",
  ) as HTMLButtonElement;
  const saveBtn = modal.querySelector("#ai-token-save") as HTMLButtonElement;

  const closeModal = () => {
    modal.classList.add("closing");
    setTimeout(() => modal.remove(), 200);
  };

  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Збереження
  saveBtn?.addEventListener("click", async () => {
    const model = (modal.querySelector("#ai-model-select") as HTMLSelectElement)
      .value;

    saveBtn.disabled = true;
    saveBtn.textContent = "Збереження...";

    const success = await saveAISettings({
      model,
      enabled: true,
    });

    if (success) {
      showNotification("✅ Налаштування Атлас збережено", "success", 2000);
      onSave?.();
      closeModal();
    } else {
      showNotification("❌ Помилка збереження", "error", 2000);
      saveBtn.disabled = false;
      saveBtn.textContent = "Зберегти";
    }
  });

  // Анімація появи
  requestAnimationFrame(() => {
    modal.classList.add("visible");
  });
}

// ============================================================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ============================================================================

/**
 * Форматує ціну для відображення
 */
export function formatPriceForDisplay(price: number): string {
  return Math.round(price)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
