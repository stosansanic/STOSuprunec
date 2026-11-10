// src/ts/roboha/zakaz_naraudy/inhi/faktura.ts

import {
  renderInvoicePreviewModal,
  getCurrentActDataFromDOM,
} from "./fakturaRaxunok";
import { renderActPreviewModal } from "./fakturaAct";
import { supabase } from "../../../vxid/supabaseClient";
import { showNotification } from "./vspluvauhe_povidomlenna";

export const MODAL_ACT_RAXUNOK_ID = "modal-act-raxunok";

// Зберігаємо обраний faktura_id контрагента-отримувача
let selectedReceiverFakturaId: number | null = null;

export function getSelectedReceiverFakturaId(): number | null {
  return selectedReceiverFakturaId;
}

export function setSelectedReceiverFakturaId(id: number | null): void {
  selectedReceiverFakturaId = id;
}

/* --- Модальне вікно вибору (Рахунок або Акт) --- */

export function createModalActRaxunok(): HTMLElement {
  const modal = document.createElement("div");
  modal.id = MODAL_ACT_RAXUNOK_ID;
  modal.className = "act-raxunok-overlay hidden";
  modal.innerHTML = `
    <div class="act-raxunok-content">
      <button class="act-raxunok-close" id="act-raxunok-close">✕</button>
      <div class="act-raxunok-header"><h2>Оберіть тип документа</h2></div>
      <div class="act-raxunok-buttons">
        <button class="act-raxunok-btn act-raxunok-btn-copy" id="copy-act-raxunok-btn">
          <span class="btn-icon">📄</span>
          <span class="btn-text">Копія акту</span>
          <span class="btn-description">Створити копію акту?</span>
        </button>
        <button class="act-raxunok-btn act-raxunok-btn-delivery" id="create-delivery-note-btn">
          <span class="btn-icon">📝</span>
          <span class="btn-text">Видаткова накладна</span>
          <span class="btn-description">За номером рахунку</span>
        </button>
        <button class="act-raxunok-btn act-raxunok-btn-invoice" id="create-raxunok-btn">
          <span class="btn-icon">🧾</span>
          <span class="btn-text">Рахунок</span>
          <span class="btn-description">Попередній рахунок</span>
        </button>
        <button class="act-raxunok-btn act-raxunok-btn-act" id="create-act-only-btn">
          <span class="btn-icon">📋</span>
          <span class="btn-text">Акт</span>
          <span class="btn-description">Акт виконаних робіт</span>
        </button>
      </div>
    </div>
  `;
  return modal;
}

export function openModalActRaxunok(): void {
  const modal = document.getElementById(MODAL_ACT_RAXUNOK_ID);
  if (!modal) return;
  modal.classList.remove("hidden");
}

export function closeModalActRaxunok(): void {
  const modal = document.getElementById(MODAL_ACT_RAXUNOK_ID);
  if (modal) modal.classList.add("hidden");
}

export function initModalActRaxunokHandlers(): void {
  const closeBtn = document.getElementById("act-raxunok-close");
  closeBtn?.addEventListener("click", closeModalActRaxunok);

  const modal = document.getElementById(MODAL_ACT_RAXUNOK_ID);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModalActRaxunok();
  });

  // Кнопка "Рахунок"
  const raxunokBtn = document.getElementById("create-raxunok-btn");
  raxunokBtn?.addEventListener("click", async () => {
    try {
      const actData = getCurrentActDataFromDOM();
      if (!actData) {
        showNotification("Помилка: дані акту не знайдено", "error");
        return;
      }

      // Передаємо вибраного контрагента як постачальника (замість faktura_id=1)
      if (selectedReceiverFakturaId) {
        actData.overrideSupplierFakturaId = selectedReceiverFakturaId;
      }

      await renderInvoicePreviewModal(actData);
      closeModalActRaxunok();
    } catch (error) {
      // console.error(error);
      showNotification("Помилка при створенні рахунку", "error");
    }
  });

  // Кнопка "Видаткова накладна"
  const deliveryNoteBtn = document.getElementById("create-delivery-note-btn");
  deliveryNoteBtn?.addEventListener("click", async () => {
    try {
      const actData = getCurrentActDataFromDOM();
      if (!actData) {
        showNotification("Помилка: дані акту не знайдено", "error");
        return;
      }

      if (selectedReceiverFakturaId) {
        actData.overrideSupplierFakturaId = selectedReceiverFakturaId;
      }

      await renderInvoicePreviewModal(actData, {
        documentType: "deliveryNote",
      });
      closeModalActRaxunok();
    } catch (error) {
      showNotification("Помилка при створенні видаткової накладної", "error");
    }
  });

  // Кнопка "Акт" - ЗМІНЕНО
  const actBtn = document.getElementById("create-act-only-btn");
  actBtn?.addEventListener("click", async () => {
    try {
      // 1. Отримуємо поточні дані з DOM
      const actData = getCurrentActDataFromDOM();
      if (!actData) {
        showNotification("Помилка: дані акту не знайдено", "error");
        return;
      }

      // 2. Отримуємо ID акту з DOM
      const actNumberSpan = document.getElementById("act-number");
      const extractedActId = actNumberSpan
        ? parseInt(actNumberSpan.innerText.trim())
        : 0;

      // Ініціалізуємо змінні в об'єкті actData
      actData.realActId = extractedActId;
      actData.foundFakturaId = null;
      actData.foundContrAgentRaxunok = null;
      actData.foundContrAgentRaxunokData = null;
      actData.foundContrAgentAct = null;
      actData.foundContrAgentActData = null;

      // 3. Якщо ID валідний, робимо розширений запит до БД
      if (extractedActId > 0) {
        const { data: dbData, error } = await supabase
          .from("acts")
          .select(
            "faktura_id, contrAgent_raxunok, contrAgent_raxunok_data, contrAgent_act, contrAgent_act_data",
          )
          .eq("act_id", extractedActId)
          .single();

        if (error) {
          // console.error("❌ Помилка пошуку в БД acts:", error);
        } else if (dbData) {
          // 4. Записуємо отримані дані
          actData.foundFakturaId = dbData.faktura_id;
          actData.foundContrAgentRaxunok = dbData.contrAgent_raxunok;
          actData.foundContrAgentRaxunokData = dbData.contrAgent_raxunok_data;
          actData.foundContrAgentAct = dbData.contrAgent_act;
          actData.foundContrAgentActData = dbData.contrAgent_act_data;
        }
      }

      // Передаємо вибраного контрагента як виконавця (замість faktura_id=1)
      if (selectedReceiverFakturaId) {
        actData.overrideSupplierFakturaId = selectedReceiverFakturaId;
      }

      // 5. Викликаємо рендер
      await renderActPreviewModal(actData);

      closeModalActRaxunok();
    } catch (error) {
      // console.error(error);
      showNotification("Помилка при створенні акту", "error");
    }
  });

  // Кнопка "Копія акту" → відкриваємо модалку вибору клієнта
  const copyBtn = document.getElementById("copy-act-raxunok-btn");
  copyBtn?.addEventListener("click", async () => {
    const actNumberSpan = document.getElementById("act-number");
    const actId = actNumberSpan ? parseInt(actNumberSpan.innerText.trim()) : 0;
    if (!actId) {
      showNotification("Помилка: ID акту не знайдено", "error");
      return;
    }
    closeModalActRaxunok();
    const { openCopyActPicker } = await import("./copy_act");
    openCopyActPicker(actId);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModalActRaxunok();
  });
}

export function initCreateActRaxunokButton(): void {
  const createActBtn = document.getElementById("create-act-btn");
  if (!createActBtn) return;

  const newBtn = createActBtn.cloneNode(true) as HTMLElement;
  createActBtn.parentNode?.replaceChild(newBtn, createActBtn);

  newBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      const { data: receivers, error } = await supabase
        .from("faktura")
        .select("faktura_id, name, oderjyvach, namber")
        .not("namber", "is", null)
        .order("faktura_id", { ascending: true });

      if (error || !receivers || receivers.length === 0) {
        showNotification("Контрагентів-отримувачів не знайдено", "error");
        return;
      }

      if (receivers.length === 1) {
        selectedReceiverFakturaId = receivers[0].faktura_id;
        openModalActRaxunok();
      } else {
        showReceiverSelectionModal(receivers);
      }
    } catch (err) {
      showNotification("Помилка завантаження контрагентів", "error");
    }
  });
}

function showReceiverSelectionModal(
  receivers: Array<{
    faktura_id: number;
    name: string;
    oderjyvach: string;
    namber: number;
  }>,
): void {
  const existing = document.getElementById("receiver-selection-modal");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "receiver-selection-modal";
  overlay.className = "receiver-selection-overlay";

  const content = document.createElement("div");
  content.className = "receiver-selection-content";

  const header = document.createElement("h2");
  header.className = "receiver-selection-title";
  header.textContent = "Оберіть отримувача";
  content.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "receiver-selection-grid";

  receivers.forEach((r) => {
    const card = document.createElement("div");
    card.className = "receiver-selection-card";

    const firstLine = (r.name || "").split("\n")[0]?.trim() || "Без назви";

    card.innerHTML = `
      <div class="receiver-card__name">${firstLine}</div>
      <div class="receiver-card__details">${r.oderjyvach || ""}</div>
      <div class="receiver-card__number">№ ${r.namber}</div>
    `;

    card.addEventListener("click", () => {
      selectedReceiverFakturaId = r.faktura_id;
      overlay.remove();
      openModalActRaxunok();
    });

    grid.appendChild(card);
  });

  content.appendChild(grid);
  overlay.appendChild(content);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
}
