// src/ts/roboha/zakaz_naraudy/inhi/fakturaAct.ts

import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { showNotification } from "./vspluvauhe_povidomlenna";
import { supabase } from "../../../vxid/supabaseClient";
import { formatNumberWithSpaces } from "../globalCache";
import {
  attachPageFormatControls,
  hideFormatControlsForPdf,
  showFormatControlsAfterPdf,
} from "./pageFormatControls";

export const ACT_PREVIEW_MODAL_ID = "act-preview-modal";

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseInputNumber(value: string): number {
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundToKopiyky(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoney(value: number): string {
  return formatNumberWithSpaces(roundToKopiyky(value), 2, 2);
}

function formatQuantity(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  return formatNumberWithSpaces(
    rounded,
    Number.isInteger(rounded) ? 0 : 1,
    3,
  );
}

function formatClientSelectLabel(raw: string, maxLength = 88): string {
  const singleLine = raw
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/**
 * Читає каталоги з вихідної таблиці DOM якщо вони відсутні в items
 */
function enrichItemsWithCatalog(items: any[]): any[] {
  const tableBody = document.querySelector("#act-items-table-container tbody");
  if (!tableBody) return items;

  const rows = Array.from(tableBody.querySelectorAll("tr"));

  return items.map((item, index) => {
    if (!item.catalog && rows[index]) {
      const catalogCell = rows[index].querySelector(
        '[data-name="catalog"]',
      ) as HTMLElement;
      if (catalogCell) {
        item.catalog = catalogCell.textContent?.trim() || "";
      }
    }
    return item;
  });
}

export async function renderActPreviewModal(data: any): Promise<void> {
  const oldModal = document.getElementById(ACT_PREVIEW_MODAL_ID);
  if (oldModal) oldModal.remove();

  // Номер акту: спочатку перевіряємо збережений contrAgent_act, потім contrAgent_raxunok
  let rawNum = data.foundContrAgentAct || data.foundContrAgentRaxunok || 0;

  // Якщо номера ще немає і обрано контрагента — беремо його namber + 1
  if (!rawNum && data.overrideSupplierFakturaId) {
    try {
      const { data: supplierData } = await supabase
        .from("faktura")
        .select("namber")
        .eq("faktura_id", data.overrideSupplierFakturaId)
        .single();
      if (supplierData?.namber != null) {
        rawNum = supplierData.namber + 1;
      }
    } catch {
      /* keep rawNum */
    }
  }

  const actNumber = String(rawNum).padStart(7, "0");
  const invoiceNumber = `СФ-${actNumber}`;

  let leftSideText = "Дані не завантажено";
  let rightSideText = "Дані не завантажено";
  let zamovnykSentencePart = "";
  let directorGenitive = "";
  let targetFakturaId = 0;
  let executorFullName = "";
  let executorPrumitka = "";
  let clientPrumitka = "";

  const invoiceDateText = formatInvoiceDate(new Date());
  const todayDateText = formatDateWithMonthName(new Date());

  try {
    // Завантажуємо виконавця: обраний контрагент або faktura_id=1
    const supplierFakturaId = data.overrideSupplierFakturaId || 1;
    const { data: myData, error: myError } = await supabase
      .from("faktura")
      .select("name, prumitka")
      .eq("faktura_id", supplierFakturaId)
      .single();

    if (myError) {
      /* silent */
    } else if (myData) {
      leftSideText = myData.name || "";
      executorPrumitka = myData.prumitka || "";
      if (myData.name) {
        const lines = myData.name
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (
            !line.startsWith("_") &&
            !line.toLowerCase().includes("фізична")
          ) {
            executorFullName = line;
            break;
          }
        }
      }
    }

    targetFakturaId = data.foundFakturaId;
    if (targetFakturaId) {
      const { data: clientData, error: clientError } = await supabase
        .from("faktura")
        .select("name, prumitka")
        .eq("faktura_id", targetFakturaId)
        .single();

      if (clientError) {
        rightSideText = "Помилка отримання даних";
      } else if (clientData) {
        rightSideText = clientData.name || "";
        clientPrumitka = clientData.prumitka || "";
        if (clientData.name) {
          const lines = clientData.name
            .split("\n")
            .map((l: string) => l.trim())
            .filter(Boolean);
          const organizationLines: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (
              line.includes("ЄДРПОУ") ||
              line.includes("тел.") ||
              line.includes("IBAN") ||
              line.includes("директор") ||
              /^_{3,}$/.test(line)
            )
              continue;
            const words = line.split(/\s+/);
            if (
              words.length === 3 &&
              /^[А-ЯЄІЇҐ]/.test(line) &&
              line.toUpperCase() !== line
            ) {
              directorGenitive = convertToGenitive(line);
              break;
            }
            organizationLines.push(line);
          }
          zamovnykSentencePart = organizationLines.join(" ");
        }
      }
    } else {
      rightSideText = "Клієнта не знайдено";
    }
  } catch (e) {
    // console.error(e);
  }

  if (!zamovnykSentencePart && rightSideText) {
    zamovnykSentencePart = normalizeSingleLine(rightSideText);
  }

  let executorSentencePart = "";
  try {
    const { data: executorData } = await supabase
      .from("faktura")
      .select("oderjyvach")
      .eq("faktura_id", 1)
      .single();
    if (executorData?.oderjyvach)
      executorSentencePart = shortenFOPName(executorData.oderjyvach);
  } catch (e) {
    // console.error("Помилка отримання oderjyvach:", e);
  }
  if (!executorSentencePart)
    executorSentencePart = shortenFOPName(leftSideText);

  let items = data.items || [];
  // Забезпечимо каталоги з DOM якщо вони відсутні
  items = enrichItemsWithCatalog(items);

  const totalSum = roundToKopiyky(items.reduce(
    (sum: number, item: any) => sum + (item.suma || 0),
    0,
  ));
  const totalSumWords = amountToWordsUA(totalSum);

  let rowsHtml = items
    .map(
      (item: any, index: number) => `
    <tr data-item-type="${item.type || "work"}">
      <td class="col-num"><span class="doc-row-index">${index + 1}</span>
        <span class="doc-row-actions" data-no-pdf="true">
          <button type="button" class="doc-row-btn doc-row-btn--delete" title="Видалити рядок">-</button>
          <button type="button" class="doc-row-btn doc-row-btn--add" title="Додати рядок">+</button>
        </span>
      </td>
      <td class="col-name"><textarea class="doc-name-input editable-autocomplete" rows="1" placeholder="Почніть вводити назву">${escapeHtmlAttr(item.name || "")}</textarea></td>
      <td class="col-catalog" contenteditable="true" title="Натисніть, щоб змінити каталожний номер" style="display: none;">${escapeHtmlAttr(item.catalog || "")}</td>
      <td class="col-unit" contenteditable="true" title="Натисніть, щоб змінити">шт</td>
      <td class="col-qty"><input type="text" inputmode="decimal" class="doc-qty-input" value="${formatQuantity(Number(item.quantity) || 0)}" /></td>
      <td class="col-price"><input type="text" inputmode="decimal" class="doc-price-input" value="${formatMoney(Number(item.price) || 0)}" /></td>
      <td class="col-sum">${formatMoney(item.suma || 0)}</td>
    </tr>
  `,
    )
    .join("");

  // Додаємо рядок "Всього:" жирним
  rowsHtml += `
      <tr class="total-row">
          <td colspan="4" class="empty-cell"></td>
          <td class="total-label">Всього:</td>
          <td class="total-value">${formatMoney(totalSum)}</td>
      </tr>
  `;

  const introText = `Ми, представники Замовника ${zamovnykSentencePart} директора <u>${directorGenitive}</u>, з одного боку, та представник Виконавця ${executorSentencePart}, з іншого боку, склали цей акт про те, що Виконавцем були проведені такі роботи (надані такі послуги) по рахунку № ${invoiceNumber}${
    invoiceDateText ? ` від ${invoiceDateText}` : ""
  }:`;

  const modalHtml = `
  <div id="${ACT_PREVIEW_MODAL_ID}" class="fakturaAct-overlay">
      <div class="fakturaAct-container">
          <div class="fakturaAct-header-approval">
            <div class="fakturaAct-approval-block">
                <div class="fakturaAct-approval-title">ЗАТВЕРДЖУЮ</div>
                <div class="fakturaAct-approval-content" contenteditable="true" title="Натисніть, щоб змінити">${leftSideText}</div>
            </div>
            <div class="fakturaAct-approval-block">
                <div class="fakturaAct-approval-title">ЗАТВЕРДЖУЮ</div>
                <div>Директор</div>
                <div class="fakturaAct-approval-content" contenteditable="true" title="Натисніть, щоб змінити">${rightSideText}</div>
            </div>
          </div>
          <div class="fakturaAct-main-title">АКТ № ОУ-<span contenteditable="true" id="editable-act-number" title="Натисніть, щоб змінити номер">${actNumber}</span> здачі-прийняття робіт (надання послуг)</div>
          <div class="fakturaAct-intro-text" contenteditable="true">${introText}</div>
          <table class="fakturaAct-table">
            <thead>
              <tr><th>№</th><th>Назва</th><th class="col-catalog-header" style="display: none;">Каталог</th><th>Од.</th><th>Кількість</th><th>Ціна без ПДВ</th><th>Сума без ПДВ</th></tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div class="fakturaAct-total-section">
            <p>Загальна вартість робіт (послуг) без ПДВ <span id="act-total-amount">${formatMoney(
              totalSum,
            )}</span> грн <span contenteditable="true">${totalSumWords}</span></p>
            <p>Сторони претензій одна до одної не мають.</p>
          </div>
          <div class="fakturaAct-footer">
            <div class="fakturaAct-footer-info">Місце складання: _____________________</div>
            <div class="fakturaAct-footer-columns">
              <div class="fakturaAct-footer-left">
                <div class="fakturaAct-footer-title">Від Виконавця*:</div>
                <div class="fakturaAct-footer-signature">____________________</div>
                <div class="fakturaAct-signature-name" contenteditable="true" title="Натисніть, щоб змінити">${executorFullName}</div>
                <div class="fakturaAct-footer-note">* Відповідальний за здійснення господарської операції і правильність її оформлення</div>
                <div class="fakturaAct-footer-date" contenteditable="true" title="Натисніть, щоб змінити дату">${todayDateText}</div>
                <div class="fakturaAct-footer-details" contenteditable="true" title="Натисніть, щоб змінити">${executorPrumitka}</div>
              </div>
              <div class="fakturaAct-footer-right">
                <div class="fakturaAct-footer-title">Від Замовника:</div>
                <div class="fakturaAct-footer-signatureZamov">____________________</div>
                <div class="fakturaAct-footer-date" contenteditable="true" title="Натисніть, щоб змінити дату">${todayDateText}</div>
                <div class="fakturaAct-footer-details" contenteditable="true" title="Натисніть, щоб змінити">${clientPrumitka}</div>
              </div>
            </div>
          </div>
          <div class="fakturaAct-controls">
            <div class="fakturaAct-controls__row fakturaAct-controls__row--top">
              <div class="doc-filter-group">
                <button class="doc-filter-btn doc-filter-btn--all active" data-filter="all">✅ Все</button>
                <button class="doc-filter-btn doc-filter-btn--detail" data-filter="detail">🔩 Деталі</button>
                <button class="doc-filter-btn doc-filter-btn--work" data-filter="work">🔧 Послуги</button>
                <button class="doc-filter-btn doc-filter-btn--catalog" data-toggle-catalog="true" title="Показати/приховати каталожний номер">📦 Каталог</button>
              </div>
              <select id="act-client-select" class="doc-client-select">
                <option value="">— Оберіть платника —</option>
              </select>
            </div>
            <div class="fakturaAct-controls__row fakturaAct-controls__row--bottom">
              <button id="btn-save-act" class="btn-save">💾 Зберегти</button>
              <button id="btn-print-act" class="btn-print">📥 Завантажити</button>
            </div>
          </div>
      </div>
  </div>`;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const overlay = document.getElementById(ACT_PREVIEW_MODAL_ID);
  if (overlay) {
    const a4Container = overlay.querySelector(
      ".fakturaAct-container",
    ) as HTMLElement;
    if (a4Container) {
      attachPageFormatControls(overlay, a4Container, {
        defaultAllTextSize: 11,
        defaultTableTextSize: 10,
        defaultCellPadding: 4,
        tableSelector: ".fakturaAct-table",
      });
    }
  }

  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const btnSave = document.getElementById("btn-save-act") as HTMLButtonElement;
  btnSave?.addEventListener("click", async () => {
    btnSave.disabled = true;
    btnSave.textContent = "⏳ Збереження...";
    const editedActNumber =
      document.getElementById("editable-act-number")?.textContent?.trim() ||
      actNumber;
    const editedRawNum = parseInt(editedActNumber) || rawNum;
    const success = await saveActData(
      data.act_id,
      editedRawNum,
      data.overrideSupplierFakturaId,
    );
    if (success) {
      btnSave.textContent = "✅ Збережено";
      btnSave.style.backgroundColor = "#4caf50";
      showNotification(
        `Акт № ОУ-${editedActNumber} збережено`,
        "success",
        4000,
      );
      setTimeout(() => {
        btnSave.textContent = "💾 Зберегти";
        btnSave.disabled = false;
        btnSave.style.backgroundColor = "";
      }, 2000);
    } else {
      showNotification("Помилка збереження", "error");
      btnSave.disabled = false;
      btnSave.textContent = "💾 Зберегти";
    }
  });

  const btnPrint = document.getElementById(
    "btn-print-act",
  ) as HTMLButtonElement;
  btnPrint?.addEventListener("click", async () => {
    btnPrint.textContent = "⏳ Генерація...";
    btnPrint.disabled = true;
    setTimeout(async () => {
      const editedActNum =
        document.getElementById("editable-act-number")?.textContent?.trim() ||
        actNumber;
      await generateActPdf(editedActNum);
      btnPrint.textContent = "📥 Завантажити";
      btnPrint.disabled = false;
    }, 50);
  });

  // --- Dropdown: вибір контрагента-замовника з таблиці faktura ---
  const actClientSelect = document.getElementById(
    "act-client-select",
  ) as HTMLSelectElement | null;
  if (actClientSelect) {
    (async () => {
      try {
        const { data: fakturaList } = await supabase
          .from("faktura")
          .select("faktura_id, name, prumitka")
          .not("prumitka", "is", null)
          .order("faktura_id", { ascending: true });
        if (fakturaList) {
          (
            fakturaList as Array<{
              faktura_id: number;
              name: string | null;
              prumitka: string | null;
            }>
          ).forEach((row) => {
            if (!row.prumitka) return;
            const opt = document.createElement("option");
            opt.value = String(row.faktura_id);
            const fullLabel =
              row.prumitka
                .replace(/\s*\n\s*/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim() || `ID ${row.faktura_id}`;
            opt.textContent = formatClientSelectLabel(fullLabel);
            opt.title = fullLabel;
            opt.dataset.name = row.name || "";
            opt.dataset.prumitka = row.prumitka || "";
            actClientSelect.appendChild(opt);
          });
        }
      } catch {
        /* silent */
      }
    })();

    actClientSelect.addEventListener("change", () => {
      const sel = actClientSelect.options[actClientSelect.selectedIndex];
      if (!sel?.value) return;
      const selectedName = sel.dataset.name || "";
      const selectedPrumitka = sel.dataset.prumitka || "";

      // 1. Оновлюємо правий блок "ЗАТВЕРДЖУЮ" (другий fakturaAct-approval-content)
      const approvalContents = overlay?.querySelectorAll(
        ".fakturaAct-approval-content",
      );
      const rightApproval = approvalContents?.[1] as HTMLElement | null;
      if (rightApproval) {
        rightApproval.textContent = selectedName;
      }

      // 2. Парсимо ім'я організації та директора для вступного тексту
      let newZamovnykPart = "";
      let newDirectorGenitive = "";
      if (selectedName) {
        const lines = selectedName
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const orgLines: string[] = [];
        for (const line of lines) {
          if (
            line.includes("ЄДРПОУ") ||
            line.includes("тел.") ||
            line.includes("IBAN") ||
            line.includes("директор") ||
            /^_{3,}$/.test(line)
          )
            continue;
          const words = line.split(/\s+/);
          if (
            words.length === 3 &&
            /^[А-ЯЄІЇҐ]/.test(line) &&
            line.toUpperCase() !== line
          ) {
            newDirectorGenitive = convertToGenitive(line);
            break;
          }
          orgLines.push(line);
        }
        newZamovnykPart = orgLines.join(" ");
      }
      if (!newZamovnykPart && selectedName) {
        newZamovnykPart = normalizeSingleLine(selectedName);
      }

      // 3. Оновлюємо вступний текст акту
      const introTextEl = overlay?.querySelector(
        ".fakturaAct-intro-text",
      ) as HTMLElement | null;
      if (introTextEl) {
        const currentActNum =
          (
            overlay?.querySelector("#editable-act-number") as HTMLElement | null
          )?.textContent?.trim() || actNumber;
        const currentInvoiceNumber = `СФ-${currentActNum}`;
        introTextEl.innerHTML = `Ми, представники Замовника ${newZamovnykPart} директора <u>${newDirectorGenitive}</u>, з одного боку, та представник Виконавця ${executorSentencePart}, з іншого боку, склали цей акт про те, що Виконавцем були проведені такі роботи (надані такі послуги) по рахунку № ${currentInvoiceNumber}${invoiceDateText ? ` від ${invoiceDateText}` : ""}:`;
      }

      // 4. Оновлюємо реквізити замовника в нижній частині (права колонка)
      const rightFooterDetails = overlay?.querySelector(
        ".fakturaAct-footer-right .fakturaAct-footer-details",
      ) as HTMLElement | null;
      if (rightFooterDetails) {
        rightFooterDetails.textContent = selectedPrumitka;
      }
    });
  }

  // --- Кнопки фільтру: Деталі / Послуги / Все ---
  const actTbody = overlay?.querySelector(
    ".fakturaAct-table tbody",
  ) as HTMLTableSectionElement | null;
  let currentAutocompleteList: HTMLElement | null = null;
  let currentAutocompleteInput: HTMLInputElement | HTMLTextAreaElement | null =
    null;
  let autocompleteRepositionHandler: (() => void) | null = null;
  let autocompleteScrollParents: HTMLElement[] = [];

  const inputSourceTypeByValue = new Map<string, "work" | "detail">();
  const nameInputTimers = new WeakMap<
    HTMLInputElement | HTMLTextAreaElement,
    number
  >();

  function createEditableActRow(index: number): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.dataset.itemType = "work";
    row.innerHTML = `
      <td class="col-num"><span class="doc-row-index">${index}</span>
        <span class="doc-row-actions" data-no-pdf="true">
          <button type="button" class="doc-row-btn doc-row-btn--delete" title="Видалити рядок">-</button>
          <button type="button" class="doc-row-btn doc-row-btn--add" title="Додати рядок">+</button>
        </span>
      </td>
      <td class="col-name"><textarea class="doc-name-input editable-autocomplete" rows="1" placeholder="Почніть вводити назву"></textarea></td>
      <td class="col-catalog" contenteditable="true" title="Натисніть, щоб змінити каталожний номер" style="display: none;"></td>
      <td class="col-unit" contenteditable="true" title="Натисніть, щоб змінити">шт</td>
      <td class="col-qty"><input type="text" inputmode="decimal" class="doc-qty-input" value="1" /></td>
      <td class="col-price"><input type="text" inputmode="decimal" class="doc-price-input" value="0,00" /></td>
      <td class="col-sum">0</td>
    `;
    return row;
  }

  async function fetchActSuggestions(
    query: string,
  ): Promise<Array<{ value: string; type: "work" | "detail" }>> {
    const term = query.trim();
    if (term.length < 3) return [];

    const [worksRes, detailsRes] = await Promise.allSettled([
      supabase.from("works").select("data").ilike("data", `%${term}%`).limit(8),
      supabase
        .from("details")
        .select("data")
        .ilike("data", `%${term}%`)
        .limit(8),
    ]);

    const out: Array<{ value: string; type: "work" | "detail" }> = [];
    const seen = new Set<string>();

    const worksRows =
      worksRes.status === "fulfilled" ? worksRes.value.data || [] : [];
    const detailsRows =
      detailsRes.status === "fulfilled" ? detailsRes.value.data || [] : [];

    worksRows.forEach((row: { data: string | null }) => {
      const name = (row.data || "").trim();
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      out.push({ value: name, type: "work" });
    });

    detailsRows.forEach((row: { data: string | null }) => {
      const name = (row.data || "").trim();
      if (!name || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      out.push({ value: name, type: "detail" });
    });

    return out;
  }

  function closeActAutocompleteList(): void {
    if (currentAutocompleteList) currentAutocompleteList.remove();
    if (currentAutocompleteInput) {
      currentAutocompleteInput.classList.remove("ac-open");
      currentAutocompleteInput.onkeydown = null;
    }
    currentAutocompleteList = null;
    currentAutocompleteInput = null;
    if (autocompleteRepositionHandler) {
      window.removeEventListener("scroll", autocompleteRepositionHandler, true);
      window.removeEventListener("resize", autocompleteRepositionHandler);
      autocompleteScrollParents.forEach((parent) => {
        parent.removeEventListener("scroll", autocompleteRepositionHandler!);
      });
      autocompleteScrollParents = [];
      autocompleteRepositionHandler = null;
    }
  }

  function getScrollableParents(element: HTMLElement): HTMLElement[] {
    const parents: HTMLElement[] = [];
    let current = element.parentElement;

    while (current) {
      const style = window.getComputedStyle(current);
      const overflow = `${style.overflow}${style.overflowY}${style.overflowX}`;
      if (/(auto|scroll|overlay)/.test(overflow)) {
        parents.push(current);
      }
      current = current.parentElement;
    }

    return parents;
  }

  function isNameInputElement(
    element: EventTarget | null,
  ): element is HTMLInputElement | HTMLTextAreaElement {
    return (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement) &&
      element.classList.contains("doc-name-input")
    );
  }

  function autoResizeNameInput(
    element: HTMLInputElement | HTMLTextAreaElement,
  ): void {
    if (!(element instanceof HTMLTextAreaElement)) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(element.scrollHeight, 22)}px`;
  }

  function positionActAutocompleteList(
    input: HTMLInputElement | HTMLTextAreaElement,
    list: HTMLElement,
  ): void {
    const rect = input.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${Math.max(rect.width, 320)}px`;
    list.style.maxHeight = "320px";
    list.style.overflowY = "auto";
    list.style.zIndex = "100001";
  }

  function renderActAutocompleteList(
    input: HTMLInputElement | HTMLTextAreaElement,
    suggestions: Array<{ value: string; type: "work" | "detail" }>,
  ): void {
    closeActAutocompleteList();
    if (!suggestions.length || !overlay) return;

    const list = document.createElement("ul");
    list.className = "autocomplete-list";
    const suggestionItems: HTMLLIElement[] = [];
    let activeIndex = -1;

    const applySuggestion = (suggestion: {
      value: string;
      type: "work" | "detail";
    }): void => {
      input.value = suggestion.value;
      const row = input.closest("tr") as HTMLTableRowElement | null;
      if (row) row.dataset.itemType = suggestion.type;
      closeActAutocompleteList();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };

    const setActiveIndex = (index: number): void => {
      if (!suggestionItems.length) return;
      const nextIndex = Math.max(
        0,
        Math.min(index, suggestionItems.length - 1),
      );
      activeIndex = nextIndex;

      suggestionItems.forEach((el, i) => {
        el.classList.toggle("active-suggestion", i === activeIndex);
      });

      const activeEl = suggestionItems[activeIndex];
      activeEl.scrollIntoView({ block: "nearest" });
    };

    suggestions.forEach((suggestion) => {
      const item = document.createElement("li");
      item.className = `autocomplete-item ${
        suggestion.type === "work" ? "item-work" : "item-detail"
      }`;
      item.dataset.value = suggestion.value;
      item.dataset.itemType = suggestion.type;
      item.innerHTML = `<div class="doc-suggest-main">${escapeHtmlAttr(
        suggestion.value,
      )}</div><div class="doc-suggest-sub">${
        suggestion.type === "work" ? "Послуга" : "Деталь"
      }</div>`;

      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        applySuggestion(suggestion);
      });

      item.addEventListener("mouseenter", () => {
        const hoveredIndex = suggestionItems.indexOf(item);
        if (hoveredIndex >= 0) setActiveIndex(hoveredIndex);
      });

      list.appendChild(item);
      suggestionItems.push(item);
    });

    overlay.appendChild(list);
    input.classList.add("ac-open");
    positionActAutocompleteList(input, list);

    const reposition = () => positionActAutocompleteList(input, list);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    autocompleteScrollParents = getScrollableParents(input);
    autocompleteScrollParents.forEach((parent) => {
      parent.addEventListener("scroll", reposition, { passive: true });
    });
    autocompleteRepositionHandler = reposition;
    currentAutocompleteList = list;
    currentAutocompleteInput = input;

    input.onkeydown = (event: KeyboardEvent) => {
      if (!currentAutocompleteList) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(activeIndex < 0 ? 0 : activeIndex + 1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(
          activeIndex < 0 ? suggestionItems.length - 1 : activeIndex - 1,
        );
        return;
      }

      if (event.key === "Enter") {
        if (activeIndex >= 0 && suggestionItems[activeIndex]) {
          event.preventDefault();
          const selected = suggestions[activeIndex];
          if (selected) applySuggestion(selected);
        }
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeActAutocompleteList();
      }
    };
  }

  function normalizeActRowNumbersAndTotal(
    recalculateRows = false,
    formatInputs = false,
  ): void {
    if (!actTbody) return;

    let visibleIndex = 1;
    let visibleSum = 0;
    const rows = Array.from(actTbody.querySelectorAll("tr"));

    rows.forEach((row) => {
      if (row.classList.contains("total-row")) return;
      const rowEl = row as HTMLTableRowElement;
      const qtyInput = rowEl.querySelector(
        ".doc-qty-input",
      ) as HTMLInputElement | null;
      const priceInput = rowEl.querySelector(
        ".doc-price-input",
      ) as HTMLInputElement | null;
      const sumCell = rowEl.querySelector(".col-sum") as HTMLElement | null;
      const numCell = rowEl.querySelector(".col-num") as HTMLElement | null;

      const quantity = Math.max(0, parseInputNumber(qtyInput?.value || "0"));
      const price = Math.max(0, parseInputNumber(priceInput?.value || "0"));
      let rowSum = parseInputNumber(sumCell?.textContent || "0");

      if (recalculateRows) {
        rowSum = roundToKopiyky(quantity * price);
        if (sumCell) {
          sumCell.textContent = formatMoney(rowSum);
        }
      }

      if (formatInputs && qtyInput) {
        qtyInput.value = quantity > 0 ? formatQuantity(quantity) : "";
      }
      if (formatInputs && priceInput) {
        priceInput.value = formatMoney(price);
      }
      if (!Number.isFinite(rowSum)) {
        rowSum = 0;
      }

      if ((rowEl as HTMLElement).style.display !== "none") {
        if (numCell) {
          const indexEl = numCell.querySelector(
            ".doc-row-index",
          ) as HTMLElement | null;
          if (indexEl) indexEl.textContent = String(visibleIndex++);
        }
        visibleSum += rowSum;
      }
    });

    const totalCell = actTbody.querySelector(
      ".total-value",
    ) as HTMLElement | null;
    if (totalCell) {
      totalCell.textContent = formatMoney(visibleSum);
    }

    const amountSpan = overlay?.querySelector(
      "#act-total-amount",
    ) as HTMLElement | null;
    if (amountSpan) {
      amountSpan.textContent = formatMoney(visibleSum);
    }

    const wordsSpan = overlay?.querySelector(
      ".fakturaAct-total-section p:first-child span[contenteditable]",
    ) as HTMLElement | null;
    if (wordsSpan) {
      wordsSpan.textContent = amountToWordsUA(visibleSum);
    }
  }

  function applyActFilter(filter: string): void {
    if (!actTbody) return;
    Array.from(actTbody.querySelectorAll("tr")).forEach((tr) => {
      if (tr.classList.contains("total-row")) return;
      const type = (tr as HTMLElement).dataset.itemType || "work";
      const show = filter === "all" || type === filter;
      (tr as HTMLElement).style.display = show ? "" : "none";
    });
    normalizeActRowNumbersAndTotal();
  }

  actTbody?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;

    if (isNameInputElement(target)) {
      autoResizeNameInput(target);
      const previousTimer = nameInputTimers.get(target);
      if (previousTimer) window.clearTimeout(previousTimer);

      const term = target.value.trim();
      if (term.length < 3) {
        closeActAutocompleteList();
        inputSourceTypeByValue.clear();
        return;
      }

      const timer = window.setTimeout(async () => {
        try {
          const suggestions = await fetchActSuggestions(term);
          inputSourceTypeByValue.clear();

          suggestions.forEach((item) => {
            inputSourceTypeByValue.set(item.value, item.type);
          });
          renderActAutocompleteList(target, suggestions);
        } catch {
          closeActAutocompleteList();
          inputSourceTypeByValue.clear();
        }
      }, 250);

      nameInputTimers.set(target, timer);
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      (target.classList.contains("doc-qty-input") ||
        target.classList.contains("doc-price-input"))
    ) {
      normalizeActRowNumbersAndTotal(true, false);
    }
  });

  actTbody?.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;

    if (isNameInputElement(target)) {
      autoResizeNameInput(target);
      const row = target.closest("tr") as HTMLTableRowElement | null;
      if (row) {
        const type = inputSourceTypeByValue.get(target.value.trim());
        if (type) row.dataset.itemType = type;
      }
      return;
    }

    if (!(target instanceof HTMLInputElement)) return;

    if (target.classList.contains("doc-qty-input")) {
      const normalizedQty = Math.max(0, parseInputNumber(target.value || "0"));
      target.value = normalizedQty > 0 ? formatQuantity(normalizedQty) : "";
      normalizeActRowNumbersAndTotal(true, false);
    }

    if (target.classList.contains("doc-price-input")) {
      const normalizedPrice = Math.max(
        0,
        parseInputNumber(target.value || "0"),
      );
      target.value = formatMoney(normalizedPrice);
      normalizeActRowNumbersAndTotal(true, false);
    }
  });

  actTbody?.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement;
    if (!isNameInputElement(target)) return;
    autoResizeNameInput(target);
    if (target.value.trim().length < 3) return;

    window.setTimeout(async () => {
      if (document.activeElement !== target) return;
      const suggestions = await fetchActSuggestions(target.value.trim());
      renderActAutocompleteList(target, suggestions);
    }, 0);
  });

  actTbody?.addEventListener("focusout", (event) => {
    const target = event.target as HTMLElement;
    if (!isNameInputElement(target)) return;
    window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !active.closest(".autocomplete-list")) {
        closeActAutocompleteList();
      }
    }, 120);
  });

  actTbody?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const addBtn = target.closest(
      ".doc-row-btn--add",
    ) as HTMLButtonElement | null;
    const deleteBtn = target.closest(
      ".doc-row-btn--delete",
    ) as HTMLButtonElement | null;
    const currentRow = target.closest("tr") as HTMLTableRowElement | null;
    if (!currentRow || currentRow.classList.contains("total-row") || !actTbody)
      return;

    if (addBtn) {
      const newRow = createEditableActRow(1);
      currentRow.insertAdjacentElement("afterend", newRow);
      const nameInput = newRow.querySelector(".doc-name-input") as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (nameInput) {
        autoResizeNameInput(nameInput);
        nameInput.focus();
      }
      normalizeActRowNumbersAndTotal();
      return;
    }

    if (deleteBtn) {
      const dataRowsCount =
        actTbody.querySelectorAll("tr:not(.total-row)").length;
      if (dataRowsCount <= 1) {
        showNotification("Має залишитись хоча б один рядок", "warning", 2000);
        return;
      }
      currentRow.remove();
      normalizeActRowNumbersAndTotal();
    }
  });

  overlay?.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (
      !target.closest(".autocomplete-list") &&
      !target.closest(".doc-name-input")
    ) {
      closeActAutocompleteList();
    }
  });

  actTbody?.querySelectorAll(".doc-name-input").forEach((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      autoResizeNameInput(el);
    }
  });

  normalizeActRowNumbersAndTotal();

  // --- Кнопка каталогу: перемикач показу/приховання ---
  const catalogToggleBtn = overlay?.querySelector(
    "[data-toggle-catalog]",
  ) as HTMLButtonElement | null;
  if (catalogToggleBtn) {
    catalogToggleBtn.addEventListener("click", () => {
      const catalogCells = overlay?.querySelectorAll(".col-catalog");
      const catalogHeader = overlay?.querySelector(
        ".col-catalog-header",
      ) as HTMLElement | null;
      const firstCell = catalogCells?.[0] as HTMLElement | null;
      const isHidden = firstCell?.style?.display === "none";

      catalogCells?.forEach((cell) => {
        const htmlCell = cell as HTMLElement;
        htmlCell.style.display = isHidden ? "" : "none";
      });

      if (catalogHeader) {
        catalogHeader.style.display = isHidden ? "" : "none";
      }

      // Змінюємо colspan рядка "Всього:" залежно від видимості каталогу
      const totalRow = actTbody?.querySelector(
        ".total-row",
      ) as HTMLTableRowElement | null;
      if (totalRow) {
        const emptyCell = totalRow.querySelector(
          ".empty-cell",
        ) as HTMLTableCellElement | null;
        if (emptyCell) {
          // isHidden=true означає ми показуємо каталог, тому colspan=5
          // isHidden=false означає ми приховуємо каталог, тому colspan=4
          emptyCell.colSpan = isHidden ? 5 : 4;
        }
      }

      catalogToggleBtn.classList.toggle("active");
    });
  }

  const filterBtns = overlay?.querySelectorAll(
    ".doc-filter-btn:not([data-toggle-catalog])",
  );
  filterBtns?.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyActFilter((btn as HTMLElement).dataset.filter || "all");
    });
  });
}

function convertToGenitive(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  let lastName = parts[0],
    firstName = parts[1] || "",
    patronymic = parts[2] || "";
  if (firstName.endsWith("а")) firstName = firstName.slice(0, -1) + "и";
  if (patronymic.endsWith("на")) patronymic = patronymic.slice(0, -2) + "ни";
  return `${lastName} ${firstName} ${patronymic}`.trim();
}

function shortenFOPName(oderjyvach: string | null | undefined): string {
  if (!oderjyvach) return "";
  const firstLine = oderjyvach.split(/\r?\n/)[0].trim();
  const parts = firstLine.split(/\s+/);
  if (parts.length >= 4 && parts[0].toUpperCase() === "ФОП")
    return `ФОП ${parts[1]} ${parts[2]?.[0] || ""}.${parts[3]?.[0] || ""}.`;
  return firstLine;
}

function formatInvoiceDate(raw: any): string {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}.${String(
    d.getMonth() + 1,
  ).padStart(2, "0")}.${String(d.getFullYear()).slice(-2)}`;
}

function formatDateWithMonthName(date: Date): string {
  const months = [
    "Січня",
    "Лютого",
    "Березня",
    "Квітня",
    "Травня",
    "Червня",
    "Липня",
    "Серпня",
    "Вересня",
    "Жовтня",
    "Листопада",
    "Грудня",
  ];
  return `${date.getDate()} ${
    months[date.getMonth()]
  } ${date.getFullYear()} р.`;
}

function normalizeSingleLine(text: string): string {
  if (!text) return "";
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function amountToWordsUA(amount: number): string {
  const roundedAmount = roundToKopiyky(amount),
    UAH = Math.floor(roundedAmount),
    kopecks = Math.round((roundedAmount - UAH) * 100);
  const ones = [
    "",
    "один",
    "два",
    "три",
    "чотири",
    "п'ять",
    "шість",
    "сім",
    "вісім",
    "дев'ять",
  ];
  const onesFeminine = [
    "",
    "одна",
    "дві",
    "три",
    "чотири",
    "п'ять",
    "шість",
    "сім",
    "вісім",
    "дев'ять",
  ];
  const teens = [
    "десять",
    "одинадцять",
    "дванадцять",
    "тринадцять",
    "чотирнадцять",
    "п'ятнадцять",
    "шістнадцять",
    "сімнадцять",
    "вісімнадцять",
    "дев'ятнадцять",
  ];
  const tens = [
    "",
    "",
    "двадцять",
    "тридцять",
    "сорок",
    "п'ятдесят",
    "шістдесят",
    "сімдесят",
    "вісімдесят",
    "дев'яносто",
  ];
  const hundreds = [
    "",
    "сто",
    "двісті",
    "триста",
    "чотириста",
    "п'ятсот",
    "шістсот",
    "сімсот",
    "вісімсот",
    "дев'ятсот",
  ];
  function convertGroup(n: number, isFeminine = false): string {
    if (n === 0) return "";
    let result = "";
    const h = Math.floor(n / 100),
      t = Math.floor((n % 100) / 10),
      o = n % 10;
    if (h > 0) result += hundreds[h] + " ";
    if (t === 1) {
      result += teens[o] + " ";
    } else {
      if (t > 1) result += tens[t] + " ";
      if (o > 0) result += (isFeminine ? onesFeminine[o] : ones[o]) + " ";
    }
    return result.trim();
  }
  function getForm(n: number, one: string, few: string, many: string): string {
    const lastDigit = n % 10,
      lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 19) return many;
    if (lastDigit === 1) return one;
    if (lastDigit >= 2 && lastDigit <= 4) return few;
    return many;
  }
  let words = "";
  if (UAH === 0) {
    words = "нуль гривень";
  } else {
    const thousands = Math.floor(UAH / 1000),
      remainder = UAH % 1000;
    if (thousands > 0) {
      words +=
        convertGroup(thousands, true) +
        " " +
        getForm(thousands, "тисяча", "тисячі", "тисяч") +
        " ";
    }
    if (remainder > 0) {
      words += convertGroup(remainder, true) + " ";
    }
    words += getForm(UAH, "гривня", "гривні", "гривень");
  }
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${kopecks
    .toString()
    .padStart(2, "0")} ${getForm(kopecks, "копійка", "копійки", "копійок")}`;
}

async function saveActData(
  actId: number,
  actNumber: number,
  supplierFakturaId?: number | null,
): Promise<boolean> {
  try {
    const now = new Date();
    const todayISO = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    let userName = "";
    try {
      const storedData = localStorage.getItem("userAuthData");
      if (storedData) {
        userName = JSON.parse(storedData)?.Name || "";
      }
    } catch (e) {
      // console.error(e);
    }
    const updatePayload: Record<string, any> = {
      contrAgent_act: actNumber,
      contrAgent_act_data: todayISO,
      xto_vbpbsav: userName,
    };
    if (supplierFakturaId) {
      updatePayload.faktura_id_akt = supplierFakturaId;
    }
    const { error } = await supabase
      .from("acts")
      .update(updatePayload)
      .eq("act_id", actId);
    if (error) {
      // console.error("❌ Помилка збереження акту:", error);
      return false;
    }

    // Оновлюємо лічильник namber у контрагента
    if (supplierFakturaId) {
      const { data: fakturaRow } = await supabase
        .from("faktura")
        .select("namber")
        .eq("faktura_id", supplierFakturaId)
        .single();
      if (fakturaRow) {
        const currentNamber = parseInt(fakturaRow.namber || "0");
        if (actNumber > currentNamber) {
          await supabase
            .from("faktura")
            .update({ namber: actNumber })
            .eq("faktura_id", supplierFakturaId);
        }
      }
    }

    return true;
  } catch (e) {
    // console.error("❌ Критична помилка:", e);
    return false;
  }
}

/**
 * Повертає межі всіх рядків tbody у DOM-пікселях відносно контейнера.
 */
function getActRowBoundsPx(
  container: HTMLElement,
): Array<{ top: number; bottom: number }> {
  const tbody = container.querySelector(
    ".fakturaAct-table tbody",
  ) as HTMLElement | null;
  if (!tbody) return [];

  const containerRect = container.getBoundingClientRect();

  return Array.from(tbody.querySelectorAll("tr")).map((tr) => {
    const r = (tr as HTMLElement).getBoundingClientRect();
    return {
      top: r.top - containerRect.top,
      bottom: r.bottom - containerRect.top,
    };
  });
}

/**
 * Отримує межі певного елемента відносно контейнера
 */
function getActElementBoundsPx(container: HTMLElement, selector: string) {
  const el = container.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const containerRect = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - containerRect.top;
  const bottom = r.bottom - containerRect.top;
  return { top, bottom, height: bottom - top };
}

function replaceActTextareasForPdf(container: HTMLElement): Array<{
  parent: HTMLElement;
  textarea: HTMLTextAreaElement;
  proxy: HTMLDivElement;
}> {
  const replacements: Array<{
    parent: HTMLElement;
    textarea: HTMLTextAreaElement;
    proxy: HTMLDivElement;
  }> = [];

  const textareas = container.querySelectorAll(
    ".doc-name-input",
  ) as NodeListOf<HTMLTextAreaElement>;

  textareas.forEach((textarea) => {
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const parent = textarea.parentElement;
    if (!parent) return;

    const styles = window.getComputedStyle(textarea);
    const proxy = document.createElement("div");

    proxy.textContent = textarea.value;
    proxy.style.width = `${textarea.offsetWidth}px`;
    proxy.style.minHeight = `${Math.max(
      textarea.scrollHeight,
      textarea.offsetHeight,
      22,
    )}px`;
    proxy.style.font = styles.font;
    proxy.style.fontSize = styles.fontSize;
    proxy.style.fontFamily = styles.fontFamily;
    proxy.style.fontWeight = styles.fontWeight;
    proxy.style.lineHeight = styles.lineHeight;
    proxy.style.letterSpacing = styles.letterSpacing;
    proxy.style.color = styles.color;
    proxy.style.padding = styles.padding;
    proxy.style.margin = styles.margin;
    proxy.style.border = styles.border;
    proxy.style.boxSizing = styles.boxSizing;
    proxy.style.background = "transparent";
    proxy.style.whiteSpace = "pre-wrap";
    proxy.style.overflowWrap = "anywhere";
    proxy.style.wordBreak = "break-word";

    parent.replaceChild(proxy, textarea);
    replacements.push({ parent, textarea, proxy });
  });

  return replacements;
}

async function generateActPdf(actNumber: string): Promise<void> {
  const container = document.querySelector(
    ".fakturaAct-container",
  ) as HTMLElement;
  if (!container) return;

  const controls = document.querySelector(
    ".fakturaAct-controls",
  ) as HTMLElement;
  if (controls) controls.style.display = "none";
  hideFormatControlsForPdf(container);

  // Ховаємо плаваючу кнопку голосового введення
  const voiceBtn = document.getElementById("voice-input-button") as HTMLElement;
  if (voiceBtn) voiceBtn.style.display = "none";

  // Зберігаємо оригінальні стилі
  const originalStyle = container.style.cssText;

  // Налаштування для якісного скріншота
  container.style.height = "auto";
  container.style.minHeight = "auto";
  container.style.overflow = "visible";
  container.style.boxShadow = "none";

  const textareaReplacements = replaceActTextareasForPdf(container);

  try {
    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
    });

    const imgData = canvas.toDataURL("image/jpeg", 0.95);
    const pdf = new jsPDF("p", "mm", "a4");

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // Поля сторінки
    const marginTop = 10;
    const marginLeft = 0;
    const marginRight = 0;
    const marginBottom = 15;

    const contentWidthMm = pageWidth - marginLeft - marginRight;
    const contentHeightMm = pageHeight - marginTop - marginBottom;

    // Висота зображення у мм при масштабуванні по ширині
    const imgHeightMm = (canvas.height * contentWidthMm) / canvas.width;

    // Співвідношення одиниць виміру
    const domHeightPx = container.scrollHeight;
    const canvasPxPerDomPx = canvas.height / domHeightPx;
    const mmPerCanvasPx = imgHeightMm / canvas.height;
    const mmPerDomPx = imgHeightMm / domHeightPx;

    // Отримуємо межі рядків таблиці
    const rowBounds = getActRowBoundsPx(container);

    // Отримуємо межі футера з підписами
    const footerBounds = getActElementBoundsPx(container, ".fakturaAct-footer");

    // Отримуємо межі секції "Всього на суму"
    const totalBounds = getActElementBoundsPx(
      container,
      ".fakturaAct-total-section",
    );

    // Якщо все влазить на одну сторінку
    if (imgHeightMm <= contentHeightMm) {
      pdf.addImage(
        imgData,
        "JPEG",
        marginLeft,
        marginTop,
        contentWidthMm,
        imgHeightMm,
      );
    } else {
      // Багатосторінкова логіка
      let currentDomY = 0;
      let pageIndex = 0;

      while (currentDomY < domHeightPx - 1) {
        if (pageIndex > 0) {
          pdf.addPage();
        }

        // Максимальна висота, що влазить на сторінку (в DOM px)
        const pageMaxDomY = currentDomY + contentHeightMm / mmPerDomPx;

        // 1) Шукаємо останній повний рядок таблиці, що влазить
        let safeCutDomY = currentDomY;
        let foundRowBreak = false;

        for (let i = 0; i < rowBounds.length; i++) {
          if (rowBounds[i].bottom <= pageMaxDomY) {
            safeCutDomY = rowBounds[i].bottom;
            foundRowBreak = true;
          } else {
            break;
          }
        }

        // Якщо не знайшли підходящий розрив (рядок занадто високий)
        if (!foundRowBreak || safeCutDomY <= currentDomY) {
          safeCutDomY = Math.min(pageMaxDomY, domHeightPx);
        }

        // 2) Перевіряємо, чи може секція "Всього на суму" повністю влізти
        if (totalBounds) {
          const totalStartsOnThisPage =
            totalBounds.top >= currentDomY && totalBounds.top <= pageMaxDomY;
          if (totalStartsOnThisPage) {
            const remainingSpace = pageMaxDomY - safeCutDomY;
            if (totalBounds.height <= remainingSpace) {
              safeCutDomY = totalBounds.bottom;
            }
          }
        }

        // 3) Перевіряємо футер з підписами
        if (footerBounds) {
          const footerStartsOnThisPage =
            footerBounds.top >= currentDomY && footerBounds.top <= pageMaxDomY;
          if (footerStartsOnThisPage) {
            const remainingSpace = pageMaxDomY - safeCutDomY;
            if (footerBounds.height <= remainingSpace) {
              safeCutDomY = footerBounds.bottom;
            }
          }
        }

        // 4) Ріжемо canvas
        const sourceYCanvas = Math.round(currentDomY * canvasPxPerDomPx);
        const sourceHCanvas = Math.round(
          (safeCutDomY - currentDomY) * canvasPxPerDomPx,
        );

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = canvas.width;
        tempCanvas.height = Math.max(1, sourceHCanvas);

        const tctx = tempCanvas.getContext("2d")!;
        tctx.drawImage(
          canvas,
          0,
          sourceYCanvas,
          canvas.width,
          sourceHCanvas,
          0,
          0,
          canvas.width,
          sourceHCanvas,
        );

        const sliceImg = tempCanvas.toDataURL("image/jpeg", 0.95);
        const sliceHeightMm = sourceHCanvas * mmPerCanvasPx;

        pdf.addImage(
          sliceImg,
          "JPEG",
          marginLeft,
          marginTop,
          contentWidthMm,
          sliceHeightMm,
        );

        currentDomY = safeCutDomY;
        pageIndex++;
      }
    }

    pdf.save(`Акт_ОУ-${actNumber}.pdf`);
  } catch (error) {
  } finally {
    textareaReplacements.forEach(({ parent, textarea, proxy }) => {
      if (proxy.parentElement === parent) {
        parent.replaceChild(textarea, proxy);
      }
    });

    // Повертаємо оригінальні стилі
    if (controls) controls.style.display = "flex";
    showFormatControlsAfterPdf(container);
    if (voiceBtn) voiceBtn.style.display = "";
    container.style.cssText = originalStyle;
  }
}
