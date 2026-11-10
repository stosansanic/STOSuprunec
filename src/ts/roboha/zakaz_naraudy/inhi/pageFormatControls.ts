// src/ts/roboha/zakaz_naraudy/inhi/pageFormatControls.ts

// Висота контенту на сторінці PDF: 297mm - 10mm(marginTop) - 15mm(marginBottom) = 272mm
const PDF_CONTENT_HEIGHT_MM = 272;

interface FormatState {
  allTextSize: number;
  tableTextSize: number;
  cellPadding: number;
  lineSpacing: number;
  offsetTop: number;
  offsetBottom: number;
  offsetLeft: number;
  offsetRight: number;
}

/**
 * Додає панель керування розміром тексту та індикатори розриву сторінок А4
 * до контейнера модального вікна (Рахунок або Акт).
 */
export function attachPageFormatControls(
  overlay: HTMLElement,
  container: HTMLElement,
  options: {
    defaultAllTextSize: number;
    defaultTableTextSize: number;
    defaultCellPadding: number;
    tableSelector: string;
  },
): void {
  // За замовчуванням padding контейнера: 10mm 20mm 15mm 10mm (top right bottom left)
  const state: FormatState = {
    allTextSize: options.defaultAllTextSize,
    tableTextSize: options.defaultTableTextSize,
    cellPadding: options.defaultCellPadding,
    lineSpacing: 1.3,
    offsetTop: 10,
    offsetBottom: 15,
    offsetLeft: 10,
    offsetRight: 20,
  };

  const toolbar = document.createElement("div");
  toolbar.className = "page-format-toolbar";
  toolbar.setAttribute("data-no-pdf", "true");
  // Зупиняємо клік по тулбару від закриття модалки
  toolbar.addEventListener("click", (e) => e.stopPropagation());

  toolbar.innerHTML = `
    <div class="pf-group">
      <span class="pf-label">Весь текст</span>
      <button class="pf-btn" data-action="all-minus">−</button>
      <span class="pf-value" data-value="all">${state.allTextSize}pt</span>
      <button class="pf-btn" data-action="all-plus">+</button>
    </div>
    <div class="pf-group">
      <span class="pf-label">Таблиця</span>
      <button class="pf-btn" data-action="table-minus">−</button>
      <span class="pf-value" data-value="table">${state.tableTextSize}pt</span>
      <button class="pf-btn" data-action="table-plus">+</button>
    </div>
    <div class="pf-group">
      <span class="pf-label">Висоту</span>
      <button class="pf-btn" data-action="padding-minus">−</button>
      <span class="pf-value" data-value="padding">${state.cellPadding}px</span>
      <button class="pf-btn" data-action="padding-plus">+</button>
    </div>
    <div class="pf-divider"></div>
    <div class="pf-joystick">
      <div class="pf-joy-title">Стиснути / Розтягнути</div>
      <div class="pf-joy-row">
        <button class="pf-btn pf-joy-btn" data-action="stretch-v" title="Розтягнути вертикально (міжрядковий +)">-</button>
      </div>
      <div class="pf-joy-row">
        <span class="pf-joy-val pf-joy-val-side" data-value="sq-left">${state.offsetLeft}mm</span>
        <button class="pf-btn pf-joy-btn" data-action="squeeze-h" title="Стиснути з боків (left і right -1)">-</button>
        <span class="pf-joy-val" data-value="sq-line">${state.lineSpacing}</span>
        <button class="pf-btn pf-joy-btn" data-action="stretch-h" title="Стиснути вертикально (left і right -1)">+</button>
        <span class="pf-joy-val pf-joy-val-side" data-value="sq-right">${state.offsetRight}mm</span>
      </div>
      <div class="pf-joy-row">
        <button class="pf-btn pf-joy-btn" data-action="squeeze-v" title="Розтягнути горизонтально (міжрядковий +)">+</button>
      </div>
    </div>
    <div class="pf-divider"></div>
    <div class="pf-joystick">
      <div class="pf-joy-title">Пересунути</div>
      <div class="pf-joy-row">
        <span class="pf-joy-val" data-value="joy-top">${state.offsetTop}mm</span>
      </div>
      <div class="pf-joy-row">
        <button class="pf-btn pf-joy-btn" data-action="shift-up" title="Пересунути вгору (top −1, bottom +1)">▲</button>
      </div>
      <div class="pf-joy-row">
        <span class="pf-joy-val pf-joy-val-side" data-value="joy-left">${state.offsetLeft}mm</span>
        <button class="pf-btn pf-joy-btn" data-action="shift-left" title="Пересунути лівіше (left −1, right +1)">◀</button>
        <span class="pf-joy-icon">✥</span>
        <button class="pf-btn pf-joy-btn" data-action="shift-right" title="Пересунути правіше (left +1, right −1)">▶</button>
        <span class="pf-joy-val pf-joy-val-side" data-value="joy-right">${state.offsetRight}mm</span>
      </div>
      <div class="pf-joy-row">
        <button class="pf-btn pf-joy-btn" data-action="shift-down" title="Пересунути вниз (top +1, bottom −1)">▼</button>
      </div>
      <div class="pf-joy-row">
        <span class="pf-joy-val" data-value="joy-bottom">${state.offsetBottom}mm</span>
      </div>
    </div>
  `;

  // Вставляємо тулбар в body (позиціонується CSS fixed, не скролиться)
  document.body.appendChild(toolbar);

  // Прибираємо тулбар коли модалка закривається
  const cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      toolbar.remove();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true });

  toolbar.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const action = target.getAttribute("data-action");
    if (!action) return;

    switch (action) {
      case "all-plus":
        state.allTextSize += 0.5;
        break;
      case "all-minus":
        state.allTextSize = Math.max(6, state.allTextSize - 0.5);
        break;
      case "table-plus":
        state.tableTextSize += 0.5;
        break;
      case "table-minus":
        state.tableTextSize = Math.max(6, state.tableTextSize - 0.5);
        break;
      case "padding-plus":
        state.cellPadding += 1;
        break;
      case "padding-minus":
        state.cellPadding = Math.max(0, state.cellPadding - 1);
        break;
      case "stretch-v":
        state.lineSpacing = Math.max(
          0.8,
          Math.round((state.lineSpacing - 0.1) * 10) / 10,
        );
        break;
      case "squeeze-v":
        state.lineSpacing = Math.round((state.lineSpacing + 0.1) * 10) / 10;
        break;
      case "squeeze-h":
        state.offsetLeft += 1;
        state.offsetRight += 1;
        break;
      case "stretch-h":
        state.offsetLeft = Math.max(0, state.offsetLeft - 1);
        state.offsetRight = Math.max(0, state.offsetRight - 1);
        break;
      case "shift-left":
        state.offsetLeft = Math.max(0, state.offsetLeft - 1);
        state.offsetRight += 1;
        break;
      case "shift-right":
        state.offsetLeft += 1;
        state.offsetRight = Math.max(0, state.offsetRight - 1);
        break;
      case "shift-up":
        state.offsetTop = Math.max(0, state.offsetTop - 1);
        state.offsetBottom += 1;
        break;
      case "shift-down":
        state.offsetTop += 1;
        state.offsetBottom = Math.max(0, state.offsetBottom - 1);
        break;
    }

    applyStyles(container, state, options.tableSelector);
    updateLabels(toolbar, state);
    // Невелика затримка, щоб браузер перерахував розміри
    requestAnimationFrame(() => updatePageBreakMarkers(container));
  });

  applyStyles(container, state, options.tableSelector);
  updatePageBreakMarkers(container);

  // ResizeObserver для відстеження зміни розміру контейнера
  const resizeObs = new ResizeObserver(() => {
    updatePageBreakMarkers(container);
  });
  resizeObs.observe(container);

  // MutationObserver для відстеження зміни контенту (contenteditable)
  const mutationObs = new MutationObserver(() => {
    requestAnimationFrame(() => updatePageBreakMarkers(container));
  });
  mutationObs.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function applyStyles(
  container: HTMLElement,
  state: FormatState,
  tableSelector: string,
): void {
  // Встановлюємо розмір шрифту на всіх елементах контейнера, крім таблиці
  const table = container.querySelector(tableSelector) as HTMLElement;

  // Збираємо всі елементи з явним font-size (заголовки, секції тощо)
  const allElements = container.querySelectorAll("*");
  allElements.forEach((el) => {
    const htmlEl = el as HTMLElement;
    // Пропускаємо таблицю та її дочірні елементи — вони керуються окремо
    if (table && (htmlEl === table || table.contains(htmlEl))) return;
    // Пропускаємо маркери, фонові області та кнопки
    if (
      htmlEl.classList.contains("page-break-marker") ||
      htmlEl.classList.contains("page-background") ||
      htmlEl.closest(".invoice-controls") ||
      htmlEl.closest(".fakturaAct-controls")
    )
      return;

    htmlEl.style.fontSize = `${state.allTextSize}pt`;
  });

  container.style.fontSize = `${state.allTextSize}pt`;

  // Застосовуємо міжрядковий інтервал
  container.style.lineHeight = `${state.lineSpacing}`;

  // Застосовуємо зміщення (джойстик) як padding контейнера
  container.style.padding = `${state.offsetTop}mm ${state.offsetRight}mm ${state.offsetBottom}mm ${state.offsetLeft}mm`;

  if (table) {
    table.style.fontSize = `${state.tableTextSize}pt`;
    // Повертаємо розмір шрифту таблиці для всіх її дочірніх елементів
    table.querySelectorAll("*").forEach((el) => {
      (el as HTMLElement).style.fontSize = `${state.tableTextSize}pt`;
    });
  }

  const cells = container.querySelectorAll(
    `${tableSelector} td, ${tableSelector} th`,
  );
  cells.forEach((cell) => {
    (cell as HTMLElement).style.padding = `${state.cellPadding}px 6px`;
  });
}

function updateLabels(toolbar: HTMLElement, state: FormatState): void {
  const allLabel = toolbar.querySelector('[data-value="all"]');
  const tableLabel = toolbar.querySelector('[data-value="table"]');
  const paddingLabel = toolbar.querySelector('[data-value="padding"]');

  if (allLabel) allLabel.textContent = `${state.allTextSize}pt`;
  if (tableLabel) tableLabel.textContent = `${state.tableTextSize}pt`;
  if (paddingLabel) paddingLabel.textContent = `${state.cellPadding}px`;

  const joyTop = toolbar.querySelector('[data-value="joy-top"]');
  const joyBottom = toolbar.querySelector('[data-value="joy-bottom"]');
  const joyLeft = toolbar.querySelector('[data-value="joy-left"]');
  const joyRight = toolbar.querySelector('[data-value="joy-right"]');
  if (joyTop) joyTop.textContent = `${state.offsetTop}mm`;
  if (joyBottom) joyBottom.textContent = `${state.offsetBottom}mm`;
  if (joyLeft) joyLeft.textContent = `${state.offsetLeft}mm`;
  if (joyRight) joyRight.textContent = `${state.offsetRight}mm`;

  // Оновлюємо індикатори першого джойстика (стиснути/розтягнути)
  const sqLine = toolbar.querySelector('[data-value="sq-line"]');
  const sqLeft = toolbar.querySelector('[data-value="sq-left"]');
  const sqRight = toolbar.querySelector('[data-value="sq-right"]');
  if (sqLine) sqLine.textContent = `${state.lineSpacing}`;
  if (sqLeft) sqLeft.textContent = `${state.offsetLeft}mm`;
  if (sqRight) sqRight.textContent = `${state.offsetRight}mm`;
}

/**
 * Отримує межі рядків таблиці відносно контейнера
 */
function getRowBoundsPx(
  container: HTMLElement,
  tableSelector: string,
): Array<{ top: number; bottom: number }> {
  const tbody = container.querySelector(
    `${tableSelector} tbody`,
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
 * Отримує межі елемента відносно контейнера
 */
function getElementBoundsPx(container: HTMLElement, selector: string) {
  const el = container.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const containerRect = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - containerRect.top;
  const bottom = r.bottom - containerRect.top;
  return { top, bottom, height: bottom - top };
}

/**
 * Визначає точки розриву сторінок за тією ж логікою, що й PDF-генерація
 */
function calculateSmartBreaks(container: HTMLElement): number[] {
  // Тимчасово прибираємо min-height для точного розрахунку (як при PDF-генерації)
  const origMinHeight = container.style.minHeight;
  const origHeight = container.style.height;
  container.style.minHeight = "auto";
  container.style.height = "auto";

  const containerHeight = container.scrollHeight;
  const pxPerMm = container.offsetWidth / 210;
  const pageHeightPx = PDF_CONTENT_HEIGHT_MM * pxPerMm;

  // Визначаємо тип контейнера
  const isAct = container.classList.contains("fakturaAct-container");

  const tableSelector = isAct ? ".fakturaAct-table" : ".invoice-table";
  const rowBounds = getRowBoundsPx(container, tableSelector);

  // Отримуємо межі ключових секцій
  const sectionSelectors = isAct
    ? [".fakturaAct-total-section", ".fakturaAct-footer"]
    : [".sum-in-words", ".vat-note", ".signature-section"];

  const sectionBounds = sectionSelectors
    .map((sel) => getElementBoundsPx(container, sel))
    .filter(Boolean) as Array<{ top: number; bottom: number; height: number }>;

  const breaks: number[] = [];
  let currentDomY = 0;

  while (currentDomY < containerHeight - 10) {
    const pageMaxDomY = currentDomY + pageHeightPx;

    if (pageMaxDomY >= containerHeight - 10) break;

    // 1) Шукаємо останній повний рядок таблиці, що влазить
    let safeCutDomY = currentDomY;
    let foundRowBreak = false;

    for (let i = 0; i < rowBounds.length; i++) {
      if (
        rowBounds[i].bottom <= pageMaxDomY &&
        rowBounds[i].bottom > currentDomY
      ) {
        safeCutDomY = rowBounds[i].bottom;
        foundRowBreak = true;
      } else if (rowBounds[i].bottom > pageMaxDomY) {
        break;
      }
    }

    if (!foundRowBreak || safeCutDomY <= currentDomY) {
      safeCutDomY = Math.min(pageMaxDomY, containerHeight);
    }

    // 2) Перевіряємо ключові секції — чи можуть повністю влізти
    for (const bounds of sectionBounds) {
      const startsOnThisPage =
        bounds.top >= currentDomY && bounds.top <= pageMaxDomY;
      if (startsOnThisPage) {
        const remainingSpace = pageMaxDomY - safeCutDomY;
        if (bounds.height <= remainingSpace) {
          safeCutDomY = bounds.bottom;
        }
      }
    }

    breaks.push(safeCutDomY);
    currentDomY = safeCutDomY;
  }

  // Відновлюємо оригінальні стилі
  container.style.minHeight = origMinHeight;
  container.style.height = origHeight;

  return breaks;
}

function updatePageBreakMarkers(container: HTMLElement): void {
  // Видаляємо старі маркери та фонові області
  container.querySelectorAll(".page-break-marker").forEach((el) => el.remove());
  container.querySelectorAll(".page-background").forEach((el) => el.remove());

  const containerHeight = container.scrollHeight;
  const pxPerMm = container.offsetWidth / 210;
  // Висота нижнього поля PDF (у пікселях)
  const marginBottomPx = Math.round(15 * pxPerMm); // 15mm нижнє поле

  // Обчислюємо розумні точки розриву (як у PDF)
  const breaks = calculateSmartBreaks(container);

  // Створює фонову область сторінки з зонами полів
  function createPageBg(top: number, height: number, pageNum: number) {
    const pageBg = document.createElement("div");
    pageBg.className = "page-background";
    pageBg.setAttribute("data-no-pdf", "true");
    pageBg.style.top = `${top}px`;
    pageBg.style.height = `${height}px`;
    pageBg.innerHTML = `
      <div class="page-margin-zone page-margin-bottom" style="height: ${marginBottomPx}px"></div>
      <span class="page-number">Аркуш ${pageNum}</span>
    `;
    container.appendChild(pageBg);
  }

  if (breaks.length === 0) {
    createPageBg(0, containerHeight, 1);
    return;
  }

  // Перша сторінка
  createPageBg(0, breaks[0], 1);

  for (let i = 0; i < breaks.length; i++) {
    const breakPos = breaks[i];
    const pageNum = i + 1;

    // Маркер розриву — висота 50px, центрується на breakPos
    const marker = document.createElement("div");
    marker.className = "page-break-marker";
    marker.setAttribute("data-no-pdf", "true");
    marker.style.top = `${breakPos - 25}px`;
    marker.innerHTML = `
      <div class="page-break-bottom">
        <span>▼ Кінець аркуша ${pageNum} ▼</span>
      </div>
      <div class="page-break-gap"></div>
      <div class="page-break-top">
        <span>▲ Початок аркуша ${pageNum + 1} ▲</span>
      </div>
    `;
    container.appendChild(marker);

    // Фонова область наступної сторінки
    const nextBreak = i + 1 < breaks.length ? breaks[i + 1] : containerHeight;
    createPageBg(breakPos, nextBreak - breakPos, pageNum + 1);
  }
}

/**
 * Ховає елементи керування та маркери перед генерацією PDF.
 */
export function hideFormatControlsForPdf(container: HTMLElement): void {
  container
    .querySelectorAll(".page-break-marker, .page-background")
    .forEach((el) => {
      (el as HTMLElement).style.display = "none";
    });
}

/**
 * Повертає видимість елементів після генерації PDF.
 */
export function showFormatControlsAfterPdf(container: HTMLElement): void {
  container
    .querySelectorAll(".page-break-marker, .page-background")
    .forEach((el) => {
      (el as HTMLElement).style.display = "";
    });
}
