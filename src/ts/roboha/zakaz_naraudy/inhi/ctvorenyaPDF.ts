import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { showNotification } from "./vspluvauhe_povidomlenna";
import { logAction } from "../../../utils/auditLogger";
import {
  globalCache,
  ZAKAZ_NARAYD_BODY_ID,
  ZAKAZ_NARAYD_SAVE_BTN_ID,
} from "../globalCache";
import {
  expandAllNamesInTable,
  restoreOriginalNames,
} from "./kastomna_tabluca";

/**
 * Підготовка таблиці до друку - запобігання розриву рядків
 */
function prepareTableForPrint(): void {
  const table = document.querySelector(".zakaz_narayd-items-table tbody");
  if (!table) return;

  const rows = Array.from(table.querySelectorAll("tr"));
  rows.forEach((row) => {
    (row as HTMLElement).style.pageBreakInside = "avoid";
    (row as HTMLElement).style.breakInside = "avoid";
  });
}

/**
 * Повертає межі всіх рядків tbody у DOM-пікселях відносно контейнера modalBody.
 * Це треба, щоб не різати зображення всередині рядка, а лише по його нижній межі.
 */
function getRowBoundsPx(
  modalBody: HTMLElement,
): Array<{ top: number; bottom: number }> {
  const tbody = modalBody.querySelector(
    ".zakaz_narayd-items-table tbody",
  ) as HTMLElement | null;
  if (!tbody) return [];
  const bodyRect = modalBody.getBoundingClientRect();

  return Array.from(tbody.querySelectorAll("tr")).map((tr) => {
    const r = (tr as HTMLElement).getBoundingClientRect();
    // Переводимо координати у систему відліку modalBody + враховуємо прокрутку всередині нього
    const top = r.top - bodyRect.top + modalBody.scrollTop;
    const bottom = r.bottom - bodyRect.top + modalBody.scrollTop;
    return { top, bottom };
  });
}

function getElementBoundsPx(modalBody: HTMLElement, selector: string) {
  const el = modalBody.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const bodyRect = modalBody.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - bodyRect.top + modalBody.scrollTop;
  const bottom = r.bottom - bodyRect.top + modalBody.scrollTop;
  return { top, bottom, height: bottom - top };
}

/**
 * Генерує PDF-файл з вмісту модального вікна.
 * Приховує керуючі елементи та історію авто в PDF для клієнта. Видимість решти даних і QR успадковується
 * з поточного режиму акту та прав користувача (включно з act-customer-view).
 * А також розширює скорочені найменування до повних.
 * Застосовує чорно-білий режим якщо printColorMode = false.
 * Після — усе повертає як було.
 */
export async function printModalToPdf(): Promise<void> {
  showNotification("Генерація PDF...", "info", 2000);

  const modalBody = document.getElementById(ZAKAZ_NARAYD_BODY_ID);
  if (!modalBody) {
    showNotification("Тіло модального вікна не знайдено.", "error");
    return;
  }

  const modalContent = modalBody.closest(
    ".zakaz_narayd-modal-content",
  ) as HTMLElement | null;
  const isNarrowViewport = window.matchMedia("(max-width: 869px)").matches;

  // збереження стилів
  const originalBodyStyle = modalBody.style.cssText;
  const originalModalContentStyle = modalContent?.style.cssText || "";

  // Перевірка режиму друку і застосування чорно-білих стилів
  const isBlackAndWhiteMode = !globalCache.generalSettings.printColorMode;
  const header = modalBody.querySelector(".zakaz_narayd-header") as HTMLElement;
  const headerInfo = modalBody.querySelector(
    ".zakaz_narayd-header-info",
  ) as HTMLElement;
  const headerH1 = headerInfo?.querySelector("h1") as HTMLElement;
  const headerParagraphs = headerInfo?.querySelectorAll(
    "p",
  ) as NodeListOf<HTMLElement>;

  let originalHeaderBg = "";
  let originalH1Color = "";
  let originalPColors: string[] = [];

  if (isBlackAndWhiteMode && header && headerInfo) {
    // Зберігаємо оригінальні стилі
    originalHeaderBg = header.style.backgroundColor || "";
    if (headerH1) originalH1Color = headerH1.style.color || "";
    headerParagraphs?.forEach((p) => originalPColors.push(p.style.color || ""));

    // Застосовуємо чорно-білі стилі
    header.style.backgroundColor = "#ffffff";
    if (headerH1) headerH1.style.color = "#000000";
    headerParagraphs?.forEach((p) => (p.style.color = "#000000"));
  }

  // елементи, які ховаємо
  // ... (код всередині printModalToPdf) ...

  const elementsToHide: HTMLElement[] = [
    document.getElementById("print-act-button") as HTMLElement,
    document.getElementById("add-row-button") as HTMLElement,
    document.getElementById(ZAKAZ_NARAYD_SAVE_BTN_ID) as HTMLElement,
    document.getElementById("status-lock-btn") as HTMLElement,
    document.getElementById("sklad") as HTMLElement,
    document.getElementById("sms-btn") as HTMLElement, // <--- Приховуємо SMS кнопку

    // <--- ДОДАНО: Приховуємо нові кнопки-іконки під час друку
    document.getElementById("create-act-btn") as HTMLElement,
    document.getElementById("create-invoice-btn") as HTMLElement,
    // <--- КІНЕЦЬ ДОДАНОГО

    document.getElementById("voice-input-button") as HTMLElement, // Приховуємо кнопку голосового введення
    document.querySelector(".modal-close-button") as HTMLElement,
    document.querySelector(".modal-footer") as HTMLElement,
    // Nova Poshta tracking belongs to the internal workflow and is omitted from every act PDF.
    modalBody.querySelector<HTMLElement>("#nova-poshta-act-slot"),
    ...Array.from(modalBody.querySelectorAll<HTMLElement>(".np-act-section")),
    // Payroll synchronization and draft wages are internal editor information.
    ...Array.from(modalBody.querySelectorAll<HTMLElement>(
      ".act-payroll-pending-notice, .act-payroll-draft-notice",
    )),
  ].filter(Boolean) as HTMLElement[];

  // Omit the whole zero-discount row from the PDF, including its label and unit.
  // The existing finally block restores the editor after success or failure.
  const discountInput = modalBody.querySelector<HTMLInputElement>("#editable-discount");
  const discountRow = discountInput?.closest<HTMLElement>(".sum-row");
  if (discountInput && discountRow) {
    const discount = Number(discountInput.value.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(discount) && discount === 0) elementsToHide.push(discountRow);
  }

  // Історія авто не входить у клієнтський PDF; у режимі користувача лишається.
  if (modalBody.classList.contains("act-customer-view")) {
    const vehicleHistory = modalBody.querySelector<HTMLElement>("#vehicle-history-slot");
    if (vehicleHistory) elementsToHide.push(vehicleHistory);
  }

  // 🔶 тимчасово зняти прапорці-попередження
  const warnedQtyCells = Array.from(
    document.querySelectorAll<HTMLElement>('.qty-cell[data-warn="1"]'),
  );
  const warnedPriceCells = Array.from(
    document.querySelectorAll<HTMLElement>('.price-cell[data-warnprice="1"]'),
  );
  const warnedSlyusarSumCells = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.slyusar-sum-cell[data-warnzp="1"]',
    ),
  );
  warnedQtyCells.forEach((el) => el.removeAttribute("data-warn"));
  warnedPriceCells.forEach((el) => el.removeAttribute("data-warnprice"));
  warnedSlyusarSumCells.forEach((el) => el.removeAttribute("data-warnzp"));

  // 🔶 розгорнути скорочені найменування
  const originalNames = expandAllNamesInTable();

  // 🔶 підготувати таблицю до друку (стилі-анти-розрив)
  prepareTableForPrint();

  // сховати керуючі елементи
  const originalDisplays = new Map<HTMLElement, string>();
  elementsToHide.forEach((el) => {
    originalDisplays.set(el, el.style.display);
    el.style.display = "none";
  });


  // Розширити модалку для якісного скріншота.
  // На вузьких екранах (<870) тимчасово вмикаємо desktop-геометрію,
  // щоб PDF формувався як на широкому екрані.
  if (modalContent) {
    const targetWidth = isNarrowViewport ? "1200px" : "1000px";
    modalContent.style.width = targetWidth;
    modalContent.style.maxWidth = targetWidth;

    if (isNarrowViewport) {
      modalContent.style.height = "auto";
      modalContent.style.maxHeight = "none";
      modalContent.style.overflow = "visible";
      modalContent.style.overflowY = "visible";
    }
  }
  modalBody.style.overflow = "visible";
  modalBody.style.height = "auto";
  modalBody.style.maxHeight = "none";

  try {
    // робимо знімок
    const canvas = await html2canvas(modalBody, { scale: 2, useCORS: true });
    const imgData = canvas.toDataURL("image/jpeg", 0.9);

    // створюємо PDF
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    // поля
    const marginTop = 10; // мм
    const marginLeft = 10; // мм
    const marginRight = 10; // мм
    const marginBottom = 20; // мм

    const contentWidthMm = pageWidth - marginLeft - marginRight;
    const contentHeightMm = pageHeight - marginTop - marginBottom;

    // реальна висота зображення у мм, якщо масштабувати по ширині контенту
    const imgHeightMm = (canvas.height * contentWidthMm) / canvas.width;

    // ——— відповідності одиниць виміру ———
    const domHeightPx = modalBody.scrollHeight; // реальна висота DOM-контенту
    const canvasPxPerDomPx = canvas.height / domHeightPx; // скільки пікселів canvas на 1 DOM-піксель
    const mmPerCanvasPx = imgHeightMm / canvas.height; // мм на 1 canvas-піксель
    const mmPerDomPx = imgHeightMm / domHeightPx; // мм на 1 DOM-піксель

    // межі всіх рядків у DOM-пікселях
    const rowBounds = getRowBoundsPx(modalBody);
    // межі блоку підсумків (може бути відсутній у режимі "Слюсар")
    const footerBounds = getElementBoundsPx(
      modalBody,
      ".zakaz_narayd-sums-footer",
    );

    // межі блоку тексту претензій та підписів (тільки для закритого акту)
    const closedActInfoBounds = getElementBoundsPx(
      modalBody,
      ".closed-act-info",
    );

    // Об'єднуємо footer та closedActInfo в один комбінований блок
    // Це потрібно, щоб сума, текст і підписи не розривалися
    let combinedFooterBounds: {
      top: number;
      bottom: number;
      height: number;
    } | null = null;
    if (footerBounds && closedActInfoBounds) {
      combinedFooterBounds = {
        top: footerBounds.top,
        bottom: closedActInfoBounds.bottom,
        height: closedActInfoBounds.bottom - footerBounds.top,
      };
    } else if (footerBounds) {
      combinedFooterBounds = footerBounds;
    } else if (closedActInfoBounds) {
      combinedFooterBounds = closedActInfoBounds;
    }

    // Якщо все влазить — одним зображенням
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
      let currentDomY = 0; // позиція старту зрізу (DOM px)
      let pageIndex = 0;

      while (currentDomY < domHeightPx - 1) {
        if (pageIndex > 0) pdf.addPage();

        // максимальна висота контенту в DOM-пікселях, що влазить у сторінку
        const pageMaxDomY = currentDomY + contentHeightMm / mmPerDomPx;

        // 1) шукаємо останній повний рядок, що влазить у сторінку
        let safeCutDomY = currentDomY;
        for (let i = 0; i < rowBounds.length; i++) {
          if (rowBounds[i].bottom <= pageMaxDomY)
            safeCutDomY = rowBounds[i].bottom;
          else break;
        }

        // захист від дуже високого рядка
        if (safeCutDomY <= currentDomY) {
          safeCutDomY = Math.min(pageMaxDomY, domHeightPx);
        }

        // 2) якщо комбінований блок (підсумки + текст + підписи) починається у межах цієї сторінки
        //    і ПОВНІСТЮ вміщається — додаємо його у поточний зріз
        //    якщо НЕ вміщається — переносимо ВЕСЬ блок на наступну сторінку (не розриваємо)
        if (combinedFooterBounds) {
          const footerStartsOnThisPage =
            combinedFooterBounds.top >= currentDomY &&
            combinedFooterBounds.top <= pageMaxDomY;
          if (footerStartsOnThisPage) {
            const remainingDomSpace = pageMaxDomY - safeCutDomY; // залишок після останнього рядка
            const footerFitsHere =
              combinedFooterBounds.height <= remainingDomSpace;
            if (footerFitsHere) {
              // тягнемо зріз до низу комбінованого блоку — він не підуть на наступну сторінку
              safeCutDomY = combinedFooterBounds.bottom;
            } else {
              // Блок не вміщається повністю - переносимо ВЕСЬ блок на наступну сторінку
              // Якщо safeCutDomY вже включає частину блоку, обрізаємо до початку блоку
              if (safeCutDomY > combinedFooterBounds.top) {
                safeCutDomY = combinedFooterBounds.top;
              }
            }
          }
        }

        // 3) ріжемо canvas по обрахованих межах
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

        const sliceImg = tempCanvas.toDataURL("image/jpeg", 0.9);
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

    const actNumber = globalCache.currentActId;
    pdf.save(`Акт №${actNumber}.pdf`);
    showNotification("PDF успішно створено!", "success", 2000);

    if (actNumber) {
      const totalSumEl = document.getElementById("total-overall-sum");
      const totalSum = totalSumEl
        ? totalSumEl.textContent?.replace(/\s/g, "") || "0"
        : "0";
      await logAction(
        "act_pdf",
        actNumber,
        { totalSum: Number(totalSum) || 0 },
        "act",
      );
    }
  } catch (error) {
    // console.error("💥 Помилка при генерації PDF:", error);
    showNotification("Помилка генерації PDF", "error");
  } finally {
    // повернути скорочення назв
    restoreOriginalNames(originalNames);

    // повернути попереджувальні індикатори
    warnedQtyCells.forEach((el) => el.setAttribute("data-warn", "1"));
    warnedPriceCells.forEach((el) => el.setAttribute("data-warnprice", "1"));
    warnedSlyusarSumCells.forEach((el) => el.setAttribute("data-warnzp", "1"));

    // Повернути кольори header якщо був чорно-білий режим
    if (isBlackAndWhiteMode && header && headerInfo) {
      header.style.backgroundColor = originalHeaderBg;
      if (headerH1) headerH1.style.color = originalH1Color;
      headerParagraphs?.forEach(
        (p, i) => (p.style.color = originalPColors[i] || ""),
      );
    }

    // повернути відображення елементів та стилі
    originalDisplays.forEach((disp, el) => (el.style.display = disp));
    modalBody.style.cssText = originalBodyStyle;
    if (modalContent) {
      modalContent.style.cssText = originalModalContentStyle;
    }
  }
}
