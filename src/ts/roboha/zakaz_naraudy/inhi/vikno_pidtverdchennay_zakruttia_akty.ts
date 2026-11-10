// src/ts/roboha/zakaz_naraudy/inhi/vikno_pidtverdchennay_zakruttia_akty.ts

import { showNotification } from "./vspluvauhe_povidomlenna";
import { ACT_ITEMS_TABLE_CONTAINER_ID } from "../globalCache";
import { userAccessLevel } from "../../tablucya/users";
import { saveCurrentAct } from "./zberechennya_zmin_y_danux_aktu";

export const viknoPidtverdchennayZakruttiaAktyId =
  "vikno_pidtverdchennay_zakruttia_akty-modal";

export function createViknoPidtverdchennayZakruttiaAkty(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = viknoPidtverdchennayZakruttiaAktyId;
  overlay.className = "vikno_pidtverdchennay_zakruttia_akty-overlay";
  overlay.style.display = "none";

  const modal = document.createElement("div");
  modal.className = "vikno_pidtverdchennay_zakruttia_akty-content";
  modal.innerHTML = `
    <p id="vikno_pidtverdchennay_zakruttia_akty-message">Підтвердити закриття акту?</p>
    <div class="vikno_pidtverdchennay_zakruttia_akty-buttons save-buttons">
      <button id="vikno_pidtverdchennay_zakruttia_akty-confirm" class="vikno_pidtverdchennay_zakruttia_akty-confirm-btn btn-save-confirm">Так</button>
      <div class="payment-type-container">
        <select id="payment-type-select" class="payment-type-select">
          <option value="Готівка" selected>💵 Готівка</option>
          <option value="Картка">💳 Картка</option>
          <option value="IBAN">🏦 IBAN</option>
        </select>
      </div>
      <button id="vikno_pidtverdchennay_zakruttia_akty-cancel" class="vikno_pidtverdchennay_zakruttia_akty-cancel-btn btn-save-cancel">Ні</button>
    </div>
  `;
  overlay.appendChild(modal);
  return overlay;
}

function ensureModalMounted(): HTMLElement {
  let el = document.getElementById(viknoPidtverdchennayZakruttiaAktyId);
  if (!el) {
    el = createViknoPidtverdchennayZakruttiaAkty();
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Перевірка наявності попереджень у таблиці акту
 * Повертає true якщо помилок немає, false якщо є попередження
 */
export function checkForWarnings(): boolean {
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return true;

  const qtyWarnings = container.querySelectorAll('.qty-cell[data-warn="1"]');
  const priceWarnings = container.querySelectorAll(
    '.price-cell[data-warnprice="1"]',
  );
  const slyusarSumWarnings = container.querySelectorAll(
    '.slyusar-sum-cell[data-warnzp="1"]',
  );
  const belowCostWarnings = container.querySelectorAll(
    '.price-cell[data-warnprice-red="1"]',
  );

  const pomulka =
    qtyWarnings.length === 0 &&
    priceWarnings.length === 0 &&
    slyusarSumWarnings.length === 0 &&
    belowCostWarnings.length === 0;

  return pomulka;
}

/**
 * Збирає інформацію про деталі з ціною нижче собівартості
 */
function getBelowCostDetails(): Array<{
  name: string;
  basePrice: string;
  actPrice: string;
}> {
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return [];

  const redCells = container.querySelectorAll(
    '.price-cell[data-warnprice-red="1"]',
  );
  const details: Array<{ name: string; basePrice: string; actPrice: string }> =
    [];

  redCells.forEach((cell) => {
    const row = cell.closest("tr");
    if (!row) return;
    const nameCell = row.querySelector(
      '[data-name="name"]',
    ) as HTMLElement | null;
    const name = nameCell?.textContent?.trim() || "Без назви";
    const actPrice = (cell.textContent || "0").trim();
    // Витягуємо вхідну ціну з title (формат: "⛔ Ціна нижче собівартості! Вхідна: X грн, продаж: Y грн")
    const title = (cell as HTMLElement).title || "";
    const match = title.match(/Вхідна:\s*([\d\s,\.]+)/);
    const basePrice = match ? match[1].trim() : "?";
    details.push({ name, basePrice, actPrice });
  });

  return details;
}

/**
 * Збирає інформацію про роботи де зарплата більша за суму
 */
function getOverpaidSalaryDetails(): Array<{
  name: string;
  salary: string;
  sum: string;
}> {
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return [];

  const redCells = container.querySelectorAll(
    '.slyusar-sum-cell[data-warnzp="1"]',
  );
  const details: Array<{ name: string; salary: string; sum: string }> = [];

  redCells.forEach((cell) => {
    const row = cell.closest("tr");
    if (!row) return;
    const nameCell = row.querySelector(
      '[data-name="name"]',
    ) as HTMLElement | null;
    const sumCell = row.querySelector(
      '[data-name="sum"]',
    ) as HTMLElement | null;
    const name = nameCell?.textContent?.trim() || "Без назви";
    const salary = (cell.textContent || "0").trim();
    const sum = sumCell?.textContent?.trim() || "0";
    details.push({ name, salary, sum });
  });

  return details;
}

/**
 * Показ модалки підтвердження та закриття акту з відправкою SMS
 * ТЕПЕР:
 *  - не блокує закриття при попередженнях для не-адміністратора
 *  - завжди показує попередження, якщо вони є
 *  - дає користувачу вибрати: закривати чи ні
 */
export function showViknoPidtverdchennayZakruttiaAkty(
  actId: number,
): Promise<{ confirmed: boolean; paymentType?: string }> {
  return new Promise((resolve) => {
    const modal = ensureModalMounted();

    // Перевіряємо, чи є попередження в таблиці
    const pomulka = checkForWarnings(); // true = без попереджень
    const hasWarnings = !pomulka;
    const belowCostDetails = getBelowCostDetails();
    const hasBelowCost = belowCostDetails.length > 0;
    const overpaidSalary = getOverpaidSalaryDetails();
    const hasOverpaidSalary = overpaidSalary.length > 0;
    const hasCritical = hasBelowCost || hasOverpaidSalary;

    const messageEl = modal.querySelector(
      "#vikno_pidtverdchennay_zakruttia_akty-message",
    ) as HTMLParagraphElement | null;

    // Стилізація модалки при критичних помилках
    const modalContent = modal.querySelector(
      ".vikno_pidtverdchennay_zakruttia_akty-content",
    ) as HTMLElement | null;
    if (modalContent) {
      modalContent.style.backgroundColor = hasCritical ? "#ffebee" : "";
    }

    if (messageEl) {
      if (hasCritical) {
        // Є критичні помилки — червоний стиль
        let criticalHtml = "";

        if (hasBelowCost) {
          const detailsList = belowCostDetails
            .map(
              (d) =>
                `<div style="margin: 4px 0; padding: 3px 6px; border-radius: 4px; background: #fff;">
              <span style="color: #e53935; font-weight: bold;">⛔</span>
              <span style="color: #e53935; font-weight: 600;">${d.name}</span> —
              вхідна: <span style="color: #1565c0; font-weight: 600;">${d.basePrice} грн</span>,
              продаж: <span style="color: #e53935; font-weight: 600;">${d.actPrice} грн</span>
            </div>`,
            )
            .join("");
          criticalHtml += `<strong style="color: #e53935;">⛔ Продаж деталей нижче собівартості!</strong><br>${detailsList}`;
        }

        if (hasOverpaidSalary) {
          const salaryList = overpaidSalary
            .map(
              (d) =>
                `<div style="margin: 4px 0; padding: 3px 6px; border-radius: 4px; background: #fff;">
              <span style="color: #e53935; font-weight: bold;">⛔</span>
              <span style="color: #e53935; font-weight: 600;">${d.name}</span> —
              зарплата: <span style="color: #e53935; font-weight: 600;">${d.salary} грн</span>,
              сума: <span style="color: #1565c0; font-weight: 600;">${d.sum} грн</span>
            </div>`,
            )
            .join("");
          criticalHtml += `${hasBelowCost ? "<br>" : ""}<strong style="color: #e53935;">⛔ Зарплата більша за суму роботи!</strong><br>${salaryList}`;
        }

        messageEl.innerHTML = `
          ${criticalHtml}
          ${hasWarnings && !hasCritical ? "" : hasWarnings ? '<br><span style="color: #ff9800;">⚠️ Також є інші попередження.</span>' : ""}
          <br>Ви впевнені, що хочете закрити акт №${actId}?
        `;
      } else if (hasWarnings) {
        // Є попередження — показуємо розширений текст
        messageEl.innerHTML = `
          <strong style="color: #ff9800;">⚠️ Увага!</strong><br>
          Виявлено попередження про перевищення кількості, надто низьку ціну
          або зарплату більшу ніж сума роботи.<br>
          Ви впевнені, що хочете закрити акт №${actId}?<br>
          <span style="font-size: 0.9em; opacity: 0.8;">
            Ваш доступ: ${userAccessLevel || "Невідомо"}
          </span>
        `;
      } else {
        // Попереджень немає — стандартний текст
        messageEl.textContent = `Підтвердити закриття акту №${actId}`;
      }
    }

    modal.style.display = "flex";

    const confirmBtn = document.getElementById(
      "vikno_pidtverdchennay_zakruttia_akty-confirm",
    ) as HTMLButtonElement | null;
    const cancelBtn = document.getElementById(
      "vikno_pidtverdchennay_zakruttia_akty-cancel",
    ) as HTMLButtonElement | null;

    if (!confirmBtn || !cancelBtn) {
      // console.error("Кнопки підтвердження/скасування не знайдені");
      modal.style.display = "none";
      return resolve({ confirmed: false });
    }

    const cleanup = () => {
      modal.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    };

    const onCancel = () => {
      cleanup();
      resolve({ confirmed: false });
    };

    const onConfirm = async () => {
      confirmBtn.disabled = true;
      try {
        if (!navigator.onLine) {
          throw new Error(
            "Закриття акту потребує інтернету. Підключіться до мережі та повторіть.",
          );
        }
        // Автозбереження акту перед закриттям: чекаємо завершення.
        showNotification("Зберігаємо акт перед закриттям...", "info", 1200);
        await saveCurrentAct(actId);

        // Отримуємо вибраний тип оплати
        const paymentSelect = document.getElementById(
          "payment-type-select",
        ) as HTMLSelectElement | null;
        const selectedPaymentType = paymentSelect?.value || "Готівка";

        cleanup();

        resolve({ confirmed: true, paymentType: selectedPaymentType });
      } catch (e: any) {
        // console.error(e);
        showNotification(
          "Помилка при закритті акту: " + (e?.message || e),
          "error",
          2500,
        );
        confirmBtn.disabled = false;
      }
    };

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}
