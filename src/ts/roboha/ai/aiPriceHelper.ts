// src/ts/roboha/ai/aiPriceHelper.ts
// Модуль підказок цін та зарплат з використанням AI/історії

import {
  isAIEnabled,
  getAveragePriceFromHistory,
  findSalaryInHistory,
  type PriceSuggestion,
  type SalarySuggestion,
} from "./aiService";

// Кеш для швидкого доступу до статусу AI
let aiEnabledCache: boolean | null = null;
let aiEnabledCacheTime = 0;
const CACHE_TTL = 30000; // 30 секунд

/**
 * Перевіряє чи AI увімкнено (з кешуванням)
 */
export async function checkAIEnabled(): Promise<boolean> {
  const now = Date.now();
  if (aiEnabledCache !== null && now - aiEnabledCacheTime < CACHE_TTL) {
    return aiEnabledCache;
  }

  aiEnabledCache = await isAIEnabled();
  aiEnabledCacheTime = now;
  return aiEnabledCache;
}

/**
 * Скидає кеш статусу AI
 */
export function resetAIEnabledCache(): void {
  aiEnabledCache = null;
  aiEnabledCacheTime = 0;
}

/**
 * Отримує підказку середньої ціни для товару/послуги
 */
export async function getAIPriceSuggestion(
  itemName: string,
  itemType: "work" | "detail",
): Promise<PriceSuggestion | null> {
  const aiEnabled = await checkAIEnabled();
  if (!aiEnabled) return null;

  return await getAveragePriceFromHistory(itemName, itemType);
}

/**
 * Отримує підказку зарплати для слюсаря
 */
export async function getAISalarySuggestion(
  slyusarName: string,
  workName: string,
  price: number,
): Promise<SalarySuggestion | null> {
  const aiEnabled = await checkAIEnabled();
  if (!aiEnabled) return null;

  return await findSalaryInHistory(slyusarName, workName, price);
}

/**
 * Показує підказку ціни в ячейці
 * @param priceCell - елемент ячейки ціни
 * @param suggestion - підказка ціни
 */
export function showPriceSuggestion(
  priceCell: HTMLElement,
  suggestion: PriceSuggestion,
): void {
  // Додаємо клас для стилізації
  priceCell.classList.add("ai-price-suggested");
  priceCell.setAttribute("data-ai-suggested", "true");
  priceCell.setAttribute("data-ai-avg-price", String(suggestion.avgPrice));

  // Встановлюємо сіру ціну
  priceCell.textContent = formatPrice(suggestion.avgPrice);
  priceCell.style.color = "#999";
  priceCell.style.fontStyle = "italic";

  // Додаємо title з інформацією
  let tooltip = `💡 Найнижча ціна з ${suggestion.count} записів: ${formatPrice(suggestion.avgPrice)} грн\nМін: ${formatPrice(suggestion.minPrice)} грн | Макс: ${formatPrice(suggestion.maxPrice)} грн`;

  if (suggestion.avgQuantity) {
    tooltip += `\n📦 Кількість: ${suggestion.avgQuantity}`;
  }
  if (suggestion.avgSalary) {
    tooltip += `\n💰 Зарплата: ${formatPrice(suggestion.avgSalary)} грн`;
  }
  if (suggestion.mostFrequentSlyusar) {
    tooltip += `\n👷 Слюсар: ${suggestion.mostFrequentSlyusar}`;
  }
  tooltip += `\n\nКлацніть для підтвердження`;

  priceCell.title = tooltip;
}

/**
 * Підтверджує підказку ціни (робить чорною)
 * @param priceCell - елемент ячейки ціни
 */
export function confirmPriceSuggestion(priceCell: HTMLElement): void {
  if (priceCell.getAttribute("data-ai-suggested") !== "true") return;

  priceCell.classList.remove("ai-price-suggested");
  priceCell.classList.add("ai-price-confirmed");
  priceCell.setAttribute("data-ai-confirmed", "true");
  priceCell.removeAttribute("data-ai-suggested");

  // Робимо ціну чорною
  priceCell.style.color = "#333";
  priceCell.style.fontStyle = "normal";
  priceCell.removeAttribute("title");
}

/**
 * Показує підказку зарплати в ячейці
 * @param salaryCell - елемент ячейки зарплати
 * @param suggestion - підказка зарплати
 */
export function showSalarySuggestion(
  salaryCell: HTMLElement,
  suggestion: SalarySuggestion,
): void {
  salaryCell.classList.add("ai-salary-suggested");
  salaryCell.setAttribute("data-ai-suggested", "true");
  salaryCell.setAttribute("data-ai-salary", String(suggestion.amount));
  salaryCell.setAttribute("data-ai-percent", String(suggestion.percent));

  // Встановлюємо сіру зарплату
  salaryCell.textContent = formatPrice(suggestion.amount);
  salaryCell.style.color = "#999";
  salaryCell.style.fontStyle = "italic";

  salaryCell.title = `💡 Автопідказка: ${suggestion.percent}% від ціни
З історії "${suggestion.workName}"
Клацніть для підтвердження`;
}

/**
 * Підтверджує підказку зарплати
 * @param salaryCell - елемент ячейки зарплати
 */
export function confirmSalarySuggestion(salaryCell: HTMLElement): void {
  if (salaryCell.getAttribute("data-ai-suggested") !== "true") return;

  salaryCell.classList.remove("ai-salary-suggested");
  salaryCell.classList.add("ai-salary-confirmed");
  salaryCell.setAttribute("data-ai-confirmed", "true");
  salaryCell.removeAttribute("data-ai-suggested");

  salaryCell.style.color = "#333";
  salaryCell.style.fontStyle = "normal";
  salaryCell.removeAttribute("title");
}

/**
 * Очищає AI підказку з ячейки
 */
export function clearAISuggestion(cell: HTMLElement): void {
  cell.classList.remove("ai-price-suggested", "ai-price-confirmed");
  cell.classList.remove("ai-salary-suggested", "ai-salary-confirmed");
  cell.removeAttribute("data-ai-suggested");
  cell.removeAttribute("data-ai-confirmed");
  cell.removeAttribute("data-ai-avg-price");
  cell.removeAttribute("data-ai-salary");
  cell.removeAttribute("data-ai-percent");
  cell.style.color = "";
  cell.style.fontStyle = "";
  cell.removeAttribute("title");
}

/**
 * Перевіряє чи ціна є AI підказкою (не підтверджена)
 */
export function isAISuggested(cell: HTMLElement): boolean {
  return cell.getAttribute("data-ai-suggested") === "true";
}

/**
 * Форматує число як ціну
 */
function formatPrice(price: number): string {
  return Math.round(price)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Інтеграція AI підказок з обробником вибору елемента
 * Викликається після вибору роботи/деталі з автокомпліту
 */
export async function handleItemSelection(
  row: HTMLElement,
  itemName: string,
  itemType: "work" | "detail",
): Promise<void> {
  const aiEnabled = await checkAIEnabled();
  if (!aiEnabled) return;

  const priceCell = row.querySelector(
    '[data-name="price"]',
  ) as HTMLElement | null;
  if (!priceCell) {
    return;
  }

  // Якщо ціна вже встановлена (не пуста і не 0) - не перезаписуємо
  const currentPrice = parseFloat(
    (priceCell.textContent || "0").replace(/\s/g, ""),
  );
  if (currentPrice > 0) {
    return;
  }

  // Отримуємо AI підказку
  const suggestion = await getAIPriceSuggestion(itemName, itemType);
  if (suggestion && suggestion.avgPrice > 0) {
    showPriceSuggestion(priceCell, suggestion);

    // Знаходимо потрібні ячейки
    const idCountCell = row.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    const sumCell = row.querySelector(
      '[data-name="sum"]',
    ) as HTMLElement | null;
    //const salaryCell = row.querySelector('[data-name="slyusar_sum"]') as HTMLElement | null;
    //const slyusarCell = row.querySelector('[data-name="person_or_store"]') as HTMLElement | null;

    // Кількість НЕ чіпаємо — залишаємо як є

    // Прераховуємо суму рядка
    if (idCountCell && sumCell) {
      const qty =
        parseFloat((idCountCell.textContent || "1").replace(/\s/g, "")) || 1;
      const sum = Math.round(suggestion.avgPrice * qty);
      sumCell.textContent = formatPrice(sum);
      sumCell.style.color = "#999";
      sumCell.style.fontStyle = "italic";
    }

    // ❌ ВІДКЛЮЧЕНО: Автозаповнення зарплати (тільки для робіт)
    // if (suggestion.avgSalary && salaryCell && itemType === 'work') {
    //   const currentSalary = parseFloat((salaryCell.textContent || "0").replace(/\s/g, ""));
    //   if (currentSalary === 0) {
    //     salaryCell.textContent = formatPrice(suggestion.avgSalary);
    //     salaryCell.style.color = "#999";
    //     salaryCell.style.fontStyle = "italic";
    //     salaryCell.setAttribute("data-ai-suggested", "true");
    //     salaryCell.setAttribute("data-ai-salary", String(suggestion.avgSalary));
    //     salaryCell.title = "💡 Підказка з історії. Клацніть для підтвердження";
    //   }
    // }

    // ❌ ВІДКЛЮЧЕНО: Автозаповнення ПІБ слюсаря (тільки для робіт)
    // if (suggestion.mostFrequentSlyusar && slyusarCell && itemType === 'work') {
    //   const currentSlyusar = (slyusarCell.textContent || "").trim();
    //   if (!currentSlyusar) {
    //     slyusarCell.textContent = suggestion.mostFrequentSlyusar;
    //     slyusarCell.style.color = "#999";
    //     slyusarCell.style.fontStyle = "italic";
    //     slyusarCell.setAttribute("data-ai-suggested", "true");
    //     slyusarCell.title = "💡 Найчастіший виконавець. Клацніть для підтвердження";
    //   }
    // }
  }
}

/**
 * Встановлює обробник для підтвердження ціни при кліку
 */
export function setupPriceConfirmationHandler(container: HTMLElement): void {
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest("tr");

    // Обробка кліку на ячейку ціни
    if (target.getAttribute("data-name") === "price" && isAISuggested(target)) {
      confirmPriceSuggestion(target);

      // Також підтверджуємо суму
      const sumCell = row?.querySelector(
        '[data-name="sum"]',
      ) as HTMLElement | null;
      if (sumCell) {
        sumCell.style.color = "#333";
        sumCell.style.fontStyle = "normal";
      }
    }

    // Обробка кліку на ячейку кількості
    if (
      target.getAttribute("data-name") === "id_count" &&
      isAISuggested(target)
    ) {
      target.style.color = "#333";
      target.style.fontStyle = "normal";
      target.removeAttribute("data-ai-suggested");
      target.removeAttribute("title");
    }

    // ❌ ВІДКЛЮЧЕНО: Обробка кліку на ячейку зарплати
    // if (target.getAttribute("data-name") === "slyusar_sum" && isAISuggested(target)) {
    //   confirmSalarySuggestion(target);
    // }

    // ❌ ВІДКЛЮЧЕНО: Обробка кліку на ячейку ПІБ слюсаря
    // if (target.getAttribute("data-name") === "person_or_store" && isAISuggested(target)) {
    //   target.style.color = "#333";
    //   target.style.fontStyle = "normal";
    //   target.removeAttribute("data-ai-suggested");
    //   target.removeAttribute("title");
    // }
  });
}
