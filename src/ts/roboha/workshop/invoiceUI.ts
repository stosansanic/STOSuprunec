import { appConfirm, notify } from "../../utils/appDialogs";
import { canUserSeeSkladButton, userAccessLevel } from "../tablucya/users";
import { errorText, workflowButton, workflowDialog } from "./dialog";
import { invoicePrompt, parseInvoiceResponse, validateInvoice, invoiceTotal, invoiceNumber, type InvoiceDocument } from "./invoiceModel";
import { destroyCustomDatePicker, initCustomDatePicker } from "../dodatu_inchi_bazu/inhi/customDatePicker";
import { STOCK_UNIT_OPTIONS } from "../dodatu_inchi_bazu/inhi/batchUnitOptions";
import { createBatchLookup, createInvoiceCatalogReader } from "../dodatu_inchi_bazu/inhi/batchLookup";
import { attachInvoiceDropdown, type InvoiceDropdownPage } from "./invoiceDropdown";

export interface RecognizedRow {
  date: string; shop: string; invoice: string; catno: string; detail: string;
  qty: number; price: number; unit: string; notes: string; _invoiceOrigin: string;
  orderStatus: string;
}

export async function openInvoiceRecognition(append: (rows: RecognizedRow[]) => Promise<void>, catalogReader?: (catalog: string) => string[] | Promise<string[]>, supplierReader?: (query?: string) => string[] | Promise<string[]>): Promise<void> {
  if (!userAccessLevel || !await canUserSeeSkladButton()) throw new Error("Немає доступу до складу.");
  const ui = workflowDialog("📷 Розпізнати накладну");
  ui.dialog.classList.add("workflow-invoice-dialog");
  // One cache for every row, retained across repeated recognition until actual close.
  const lookupLifetime = new AbortController();
  let recognitionRequest: AbortController | null = null;
  const lookup = createBatchLookup(undefined, undefined, undefined, lookupLifetime.signal);
  const namesForCatalog = catalogReader ?? createInvoiceCatalogReader(undefined, undefined, undefined, lookupLifetime.signal);
  // The RPC projects names only, never shop JSON, history or stock balances.
  const suggestionPage = async (kind: "shops" | "catalogs" | "details", query: string, offset = 0): Promise<InvoiceDropdownPage> => {
    const page = await lookup(kind, query, offset);
    return { values: page.items.map(row => row.value), hasMore: page.has_more, nextOffset: offset + page.items.length };
  };
  let previewCleanup: Array<() => void> = [];
  const clearPreview = () => { previewCleanup.forEach(dispose => dispose()); previewCleanup = []; };
  ui.dialog.addEventListener("close", () => { clearPreview(); lookupLifetime.abort(); recognitionRequest?.abort(); }, { once: true });
  let document: InvoiceDocument | null = null;
  let busy = false;
  let confirming = false;
  let hasDraft = false;
  let applyButton: HTMLButtonElement | null = null;
  const reportIssue = (message: string, type: "warning" | "error" | "info" = "warning") => {
    if (!ui.dialog.isConnected) return;
    ui.message.textContent = message;
    notify(message, type, 6500);
  };
  ui.setDirty(() => hasDraft);
  const hint = window.document.createElement("p");
  hint.textContent = "Файл буде передано налаштованому провайдеру Атласа (Gemini/OpenRouter) лише після натискання «Розпізнати». ШІ може помилятися: звірте ВСІ рядки з оригіналом. Фото тут не зберігається; до бази потраплять лише перевірені позиції після звичайної кнопки «Записати». PDF — через Gemini. Валюта — гривня.";
  ui.content.append(hint);
  const fileInput = window.document.createElement("input"); fileInput.type = "file"; fileInput.accept = "image/jpeg,image/png,image/webp,application/pdf";
  fileInput.className = "workflow-invoice-file";
  fileInput.setAttribute("aria-label", "Файл накладної"); ui.content.append(fileInput);
  const preview = window.document.createElement("section");
  const cancelRecognition = workflowButton("Зупинити очікування", () => recognitionRequest?.abort());
  cancelRecognition.className = "workflow-invoice-cancel";
  cancelRecognition.hidden = true;
  const recognize = workflowButton("Розпізнати через Атласа", async () => {
    if (busy || confirming) return;
    const file = fileInput.files?.[0]; if (!file) { reportIssue("Оберіть PDF або фото накладної для розпізнавання."); return; }
    if (hasDraft) {
      confirming = true;
      try { if (!await appConfirm("Замінити поточний результат розпізнавання?")) return; }
      finally { confirming = false; }
    }
    if (!ui.dialog.isConnected || busy) return;
    const request = new AbortController();
    recognitionRequest = request;
    busy = true; ui.setBusy(true); recognize.disabled = true; fileInput.disabled = true;
    if (applyButton) applyButton.disabled = true;
    cancelRecognition.hidden = false;
    ui.message.textContent = "Розпізнавання… Жодні залишки не змінюються.";
    try {
      const { recognizeInvoiceDocument } = await import("../ai/aiChat");
      const result = await recognizeInvoiceDocument(file, invoicePrompt, {
        signal: request.signal,
        onProgress: message => { if (ui.dialog.isConnected && !request.signal.aborted) ui.message.textContent = message; },
      });
      if (!ui.dialog.isConnected || request.signal.aborted) return;
      document = parseInvoiceResponse(result);
      hasDraft = true; renderPreview(); ui.message.textContent = `Отримано ${document.lines.length} рядків. Перевірте їх і суму накладної.`;
    } catch (error) {
      if (request.signal.aborted) {
        if (ui.dialog.isConnected) ui.message.textContent = "Очікування розпізнавання зупинено.";
      } else reportIssue(errorText(error), "error");
    } finally {
      recognitionRequest = null; cancelRecognition.hidden = true;
      busy = false; ui.setBusy(false); recognize.disabled = false; fileInput.disabled = false;
      if (applyButton) applyButton.disabled = false;
    }
  });
  recognize.className = "workflow-invoice-action";
  ui.content.append(recognize, cancelRecognition, preview);

  function renderPreview() {
    if (!document) return;
    const invoice = document;
    clearPreview();
    preview.replaceChildren();
    const fields = window.document.createElement("div"); fields.className = "workflow-form workflow-invoice-form";
    let supplierInput: HTMLInputElement | null = null;
    for (const [key, title] of [["supplier", "Постачальник *"], ["number", "Номер накладної *"], ["date", "Дата *"], ["currency", "Валюта *"], ["total", "Сума для звірки"]] as const) {
      const label = window.document.createElement("label"); label.textContent = title; label.className = `workflow-invoice-field workflow-invoice-${key}`;
      const input = window.document.createElement("input"); input.value = invoice[key]; input.type = key === "date" ? "date" : "text";
      if (key === "supplier") {
        input.classList.add("cell-input-Excel", "cell-input-combo-Excel", "shop-input-Excel");
        input.autocomplete = "off";
        supplierInput = input;
      }
      if (key === "date") {
        input.classList.add("cell-input-Excel");
        input.readOnly = true;
        input.setAttribute("aria-label", "Дата накладної");
      }
      input.oninput = () => { invoice[key] = input.value; acknowledge.checked = false; if (applyButton) applyButton.disabled = busy || confirming; updateTotal(); };
      label.append(input); fields.append(label);
    }
    const statusLabel = window.document.createElement("label"); statusLabel.textContent = "Стан деталей *"; statusLabel.title = "Сам рахунок не підтверджує фактичне отримання деталей."; statusLabel.className = "workflow-invoice-field workflow-invoice-status";
    const status = window.document.createElement("select"); status.setAttribute("aria-label", "Стан деталей");
    for (const value of ["Замовити", "Замовлено", "Прибула"]) status.add(new Option(value, value));
    status.value = "Замовити";
    status.hidden = true;
    const statusControl = window.document.createElement("div"); statusControl.className = "workflow-status-control";
    const statusButton = window.document.createElement("button"); statusButton.type = "button";
    statusButton.className = "workflow-status-trigger"; statusButton.setAttribute("aria-label", "Стан деталей");
    statusButton.setAttribute("aria-haspopup", "listbox"); statusButton.setAttribute("aria-expanded", "false");
    const statusMenu = window.document.createElement("div"); statusMenu.className = "workflow-status-menu";
    statusMenu.setAttribute("role", "listbox"); statusMenu.setAttribute("aria-label", "Оберіть стан деталей"); statusMenu.hidden = true;
    const statusOptions: Array<{ value: string; label: string; tone: string }> = [
      { value: "Замовити", label: "Замовити", tone: "order" },
      { value: "Замовлено", label: "Замовлено", tone: "ordered" },
      { value: "Прибула", label: "Прибула", tone: "arrived" },
    ];
    const statusChoiceButtons = statusOptions.map(option => {
      const choice = window.document.createElement("button"); choice.type = "button"; choice.textContent = option.label;
      choice.className = `workflow-status-option workflow-status-${option.tone}`;
      choice.setAttribute("role", "option"); choice.setAttribute("aria-selected", "false");
      choice.onclick = () => { status.value = option.value; acknowledge.checked = false; if (applyButton) applyButton.disabled = busy || confirming; renderStatus(); statusMenu.hidden = true; statusButton.setAttribute("aria-expanded", "false"); statusButton.focus(); };
      statusMenu.append(choice);
      return choice;
    });
    function renderStatus() {
      const selected = statusOptions.find(option => option.value === status.value) || statusOptions[0];
      statusButton.replaceChildren(window.document.createTextNode(selected.label));
      const arrow = window.document.createElement("span"); arrow.className = "workflow-status-arrow"; arrow.setAttribute("aria-hidden", "true"); statusButton.append(arrow);
      statusButton.className = `workflow-status-trigger workflow-status-${selected.tone}`;
      statusChoiceButtons.forEach((choice, index) => choice.setAttribute("aria-selected", String(statusOptions[index].value === status.value)));
    }
    statusButton.onclick = () => { statusMenu.hidden = !statusMenu.hidden; statusButton.setAttribute("aria-expanded", String(!statusMenu.hidden)); if (!statusMenu.hidden) statusChoiceButtons[0].focus(); };
    statusButton.onkeydown = event => { if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") { event.preventDefault(); statusMenu.hidden = false; statusButton.setAttribute("aria-expanded", "true"); statusChoiceButtons[0].focus(); } };
    statusMenu.addEventListener("keydown", event => {
      const index = statusChoiceButtons.indexOf(window.document.activeElement as HTMLButtonElement);
      if (event.key === "Escape") { statusMenu.hidden = true; statusButton.setAttribute("aria-expanded", "false"); statusButton.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); statusChoiceButtons[(index + (event.key === "ArrowDown" ? 1 : statusChoiceButtons.length - 1)) % statusChoiceButtons.length].focus(); }
    });
    const dismissStatusMenu = (event: MouseEvent) => {
      if (!statusControl.contains(event.target as Node)) { statusMenu.hidden = true; statusButton.setAttribute("aria-expanded", "false"); }
    };
    window.document.addEventListener("mousedown", dismissStatusMenu);
    previewCleanup.push(() => window.document.removeEventListener("mousedown", dismissStatusMenu));
    statusControl.append(statusButton, statusMenu, status); statusLabel.append(statusControl); fields.append(statusLabel); preview.append(fields);
    renderStatus();
    initCustomDatePicker(fields);
    previewCleanup.push(() => destroyCustomDatePicker(fields));
    const scroll = window.document.createElement("div"); scroll.className = "workflow-scroll";
    const table = window.document.createElement("table");
    const head = table.createTHead().insertRow();
    ["№", "Каталог", "Деталь", "Кількість", "Закуп. ціна/од.", "Одиниця", "Із складу"].forEach(text => { const th = window.document.createElement("th"); th.textContent = text; head.append(th); });
    const tbody = table.createTBody();
    const unitOptions = STOCK_UNIT_OPTIONS.map(option => option.value);
    // Prefetch compact names in blocks of 20 rows, not one RPC for every row
    // scrolled into view. Repeated catalogs still share one cached request.
    const catalogChecks = new Map<Element, number>();
    const catalogBlocks = new Map<number, Array<() => void>>();
    const rowObserver: IntersectionObserver | null = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const block = catalogChecks.get(entry.target);
        if (block === undefined) continue;
        for (const check of catalogBlocks.get(block) ?? []) check();
        catalogBlocks.delete(block);
        for (const [row, rowBlock] of catalogChecks) {
          if (rowBlock !== block) continue;
          rowObserver?.unobserve(row);
          catalogChecks.delete(row);
        }
      }
    }, { root: ui.dialog, rootMargin: "160px 0px" });
    previewCleanup.push(() => { rowObserver?.disconnect(); catalogChecks.clear(); catalogBlocks.clear(); });
    invoice.lines.forEach((line, index) => {
      const tr = tbody.insertRow(); tr.insertCell().textContent = String(index + 1);
      let names: string[] = [];
      let catalogGeneration = 0;
      previewCleanup.push(() => { catalogGeneration++; });
      const catalogWarning = window.document.createElement('td');
      const updateWarning = () => {
        catalogWarning.textContent=[line.warning,names.length>1?'Кілька назв для каталогу — оберіть правильну':names.length===1 && names[0]!==line.detail?names[0]:''].filter(Boolean).join('; ');
        tr.classList.toggle('workflow-warning',!!catalogWarning.textContent || !line.detail || !line.qty || !line.price || !line.unit);
      };
      const refreshCatalog = async () => {
        if(!tr.isConnected || !ui.dialog.open) return;
        const token=++catalogGeneration, catalog=line.catno;
        try {
          const matches=await namesForCatalog(catalog);
          if(token!==catalogGeneration || catalog!==line.catno || !tr.isConnected || !ui.dialog.open) return;
          names=matches;
          updateWarning();
        } catch { if(token===catalogGeneration && tr.isConnected) catalogWarning.textContent='Не вдалося перевірити каталог. Повторіть введення.'; }
      };
      for (const key of ["catno", "detail", "qty", "price", "unit"] as const) {
        const input = key === "detail" ? window.document.createElement("textarea") : window.document.createElement("input");
        input.value = line[key]; input.setAttribute("aria-label", `${key}, рядок ${index + 1}`);
        if (key === "unit" && input instanceof window.HTMLInputElement) {
          if (!unitOptions.includes(line.unit)) {
            line.warning = [line.warning, `Перевірте розпізнану одиницю «${line.unit || "не визначено"}» або оберіть зі списку.`].filter(Boolean).join("; ");
          }
          input.readOnly = true;
          input.autocomplete = "off";
          input.classList.add("cell-input-Excel", "cell-input-combo-Excel", "unit-input-Excel");
          previewCleanup.push(attachInvoiceDropdown(input, ui.dialog, () => unitOptions, option => {
            line.unit = option;
            acknowledge.checked = false;
            if (applyButton) applyButton.disabled = busy || confirming;
            updateTotal();
            updateWarning();
          }));
        }
        if (key === "qty" || key === "price") {
          if (input instanceof window.HTMLInputElement) input.inputMode = "decimal";
        }
        if (input instanceof window.HTMLTextAreaElement) {
          input.className = "workflow-invoice-detail-input";
          input.rows = 1;
          input.wrap = "soft";
          input.style.height = "auto";
          input.style.height = `${input.scrollHeight}px`;
        }
        input.oninput = () => {
          line[key] = input.value;
          if(key === "catno") {
            // While typing only request bounded suggestions. Resolve the exact
            // catalog on selection/blur, instead of also resolving every prefix.
            catalogGeneration++; names=[];
          }
          acknowledge.checked = false;
          if (applyButton) applyButton.disabled = busy || confirming;
          if (input instanceof window.HTMLTextAreaElement) {
            input.style.height = "auto";
            input.style.height = `${input.scrollHeight}px`;
          }
          updateTotal();
          updateWarning();
        };
        if (key === "catno") {
          input.autocomplete = "off";
          previewCleanup.push(attachInvoiceDropdown(input, ui.dialog, async (query, offset = 0) => {
            const value = (query ?? input.value).trim();
            return value.length < 3 ? [] : suggestionPage("catalogs", value, offset);
          }, option => {
            line.catno = option; catalogGeneration++; names=[];
            acknowledge.checked = false; if (applyButton) applyButton.disabled = busy || confirming;
            updateWarning(); void refreshCatalog();
          }, false));
          // Short real catalog numbers can still be checked once editing finishes.
          input.addEventListener("blur", () => { void refreshCatalog(); });
        }
        if (key === "detail") {
          previewCleanup.push(attachInvoiceDropdown(input, ui.dialog, async (query, offset = 0) => {
            const catalog = line.catno;
            const matchingNames = await namesForCatalog(catalog);
            if (!input.isConnected || !ui.dialog.open || catalog !== line.catno || (query !== undefined && query !== input.value)) return [];
            const value = query?.trim() ?? "";
            if (value.length < 3 || matchingNames.some(name => name.toLowerCase().includes(value.toLowerCase()))) return matchingNames;
            return suggestionPage("details", value, offset);
          }, option => {
            line.detail = option;
            acknowledge.checked = false;
            if (applyButton) applyButton.disabled = busy || confirming;
            if (input instanceof window.HTMLTextAreaElement) {
              input.style.height = "auto";
              input.style.height = `${input.scrollHeight}px`;
              input.focus();
            }
            updateTotal();
            updateWarning();
          }));
        }
        tr.insertCell().append(input);
        if (input instanceof window.HTMLTextAreaElement) {
          input.style.height = "auto";
          input.style.height = `${input.scrollHeight}px`;
        }
      }
      const warning = [line.warning, names.length > 1 ? "Кілька назв для каталогу — оберіть правильну" : names.length === 1 && names[0] !== line.detail ? names[0] : ""].filter(Boolean).join("; ");
      catalogWarning.textContent = warning; tr.append(catalogWarning);
      if (rowObserver) {
        const block = Math.floor(index / 20);
        const checks = catalogBlocks.get(block) ?? [];
        checks.push(() => { void refreshCatalog(); });
        catalogBlocks.set(block, checks);
        catalogChecks.set(tr, block);
        rowObserver.observe(tr);
      } else queueMicrotask(() => void refreshCatalog());
      if (warning || !line.detail || !line.qty || !line.price || !line.unit) tr.classList.add("workflow-warning");
    });
    scroll.append(table); preview.append(scroll);
    const totals = window.document.createElement("p");
    totals.className = "workflow-invoice-total-summary";
    totals.setAttribute("aria-live", "polite");
    preview.append(totals);
    function updateTotal() {
      const total = invoiceTotal(invoice), printed = invoiceNumber(invoice.total);
      const mismatch = Number.isFinite(total) && Number.isFinite(printed) && Math.abs(total - printed) > .02;
      totals.classList.toggle("workflow-invoice-total-mismatch", mismatch);
      totals.textContent = `Сума рядків: ${Number.isFinite(total) ? total.toFixed(2) : "є незаповнені значення"} грн. Підсумок документа: ${invoice.total || "не визначено"}.`;
      if (mismatch) totals.textContent += " ⚠️ Суми не збігаються: перевірте ПДВ, знижки, доставку та ціни за одиницю.";
    }
    const confirmLabel = window.document.createElement("label"); confirmLabel.className = "workflow-acknowledge";
    const acknowledge = window.document.createElement("input"); acknowledge.type = "checkbox"; acknowledge.setAttribute("aria-label", "Підтверджую, що звірив накладну з оригіналом");
    const track = window.document.createElement("span"); track.className = "workflow-acknowledge-track"; track.setAttribute("aria-hidden", "true");
    const confirmText = window.document.createElement("span"); confirmText.className = "workflow-acknowledge-text";
    confirmText.textContent = "Я звірив усі рядки, валюту, закупівельні ціни та розбіжності підсумку з оригіналом.";
    confirmLabel.append(acknowledge, track, confirmText); preview.append(confirmLabel);
    if (supplierInput) previewCleanup.push(attachInvoiceDropdown(supplierInput, ui.dialog,
      (query, offset = 0) => supplierReader
        ? supplierReader(query ?? supplierInput!.value)
        : suggestionPage("shops", query ?? supplierInput!.value, offset), option => {
      invoice.supplier = option;
      acknowledge.checked = false;
      if (applyButton) applyButton.disabled = busy || confirming;
    }));
    updateTotal();
    const apply = workflowButton("Додати перевірені рядки в таблицю (ще не записувати)", async () => {
      if (busy || confirming) { reportIssue("Зачекайте завершення поточної операції.", "info"); return; }
      // Keep validation local, before hashing or any append/database operation.
      try {
        validateInvoice(invoice);
        if (!["Замовити", "Замовлено", "Прибула"].includes(status.value)) throw new Error("Оберіть стан деталей: замовити, замовлено або вже прибула.");
      } catch (error) { reportIssue(errorText(error)); return; }
      if (!acknowledge.checked) {
        reportIssue("Перевірте накладну та увімкніть підтвердження «Я звірив усі рядки…» під таблицею. Після зміни даних підтвердження потрібно увімкнути знову.");
        return;
      }
      busy = true; ui.setBusy(true); apply.disabled = true;
      try {
        const identity = `${invoice.supplier.trim()}\n${invoice.number.trim()}\n${invoice.date}`;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
        const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
        await append(invoice.lines.map((line, index) => ({ date: invoice.date, shop: invoice.supplier.trim(), invoice: invoice.number.trim(),
          catno: line.catno.trim(), detail: line.detail.trim(), qty: invoiceNumber(line.qty), price: invoiceNumber(line.price), unit: line.unit,
          orderStatus: status.value, notes: `[atlas-invoice:${hash}:${index + 1}]`, _invoiceOrigin: `[atlas-invoice:${hash}:${index + 1}]` })));
        hasDraft = false; ui.dialog.close();
      } catch (error) { reportIssue(errorText(error), "error"); }
      finally { busy = false; ui.setBusy(false); apply.disabled = false; }
    });
    applyButton = apply;
    // An unchecked acknowledgement must explain the blocker on click, not make
    // the button silently unresponsive. Actual operations still lock the button.
    apply.disabled = busy || confirming;
    acknowledge.addEventListener("change", () => { apply.disabled = busy || confirming; });
    apply.className = "workflow-invoice-action";
    preview.append(apply);
  }
}
