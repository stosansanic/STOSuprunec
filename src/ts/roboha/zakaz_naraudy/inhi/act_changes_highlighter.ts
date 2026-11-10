// ===== ФАЙЛ: src/ts/roboha/zakaz_naraudy/inhi/act_changes_highlighter.ts =====

import { supabase } from "../../../vxid/supabaseClient";
import {
  userAccessLevel,
  getSavedUserDataFromLocalStorage,
} from "../../tablucya/users";
import { ACT_ITEMS_TABLE_CONTAINER_ID, globalCache } from "../globalCache";

/* ====================ТИПИ =============================== */

interface ChangeRecord {
  notification_id: number;
  act_id: number;
  item_name: string;
  cina: number;
  kilkist: number;
  zarplata: number;
  dodav_vudaluv: boolean;
  changed_by_surname: string;
}

/* =============================== УТИЛ ІТИ =============================== */

/** Активні змійки — для очищення при закритті акту */
const activeSnakeCleanups: Array<() => void> = [];
/** Рядки видалених позицій — для видалення з DOM при закритті */
const activeDeletedRows: HTMLTableRowElement[] = [];
/** Рядки доданих позицій — для зняття фону */
const activeAddedRows: HTMLTableRowElement[] = [];
/** Таймер автоочищення */
let autoCleanupTimer: ReturnType<typeof setTimeout> | null = null;
let highlightGeneration = 0;
const pendingReads = new Map<string, Promise<ChangeRecord[]>>();

/**
 * Очищає всі активні змійки та видалені рядки (викликається при закритті акту)
 */
export function cleanupAllSnakeBorders(): void {
  highlightGeneration++;
  if (autoCleanupTimer) {
    clearTimeout(autoCleanupTimer);
    autoCleanupTimer = null;
  }
  activeSnakeCleanups.forEach((fn) => fn());
  activeSnakeCleanups.length = 0;
  activeDeletedRows.forEach((row) => row.remove());
  activeDeletedRows.length = 0;
  activeAddedRows.forEach((row) => row.classList.remove("highlight-added", "highlight-added-off"));
  activeAddedRows.length = 0;
}

/**
 * Додає CSS стилі для змійки-підсвічування (якщо ще не додані)
 */
function injectHighlightStyles(): void {
  const styleId = "act-changes-highlight-styles";

  if (document.getElementById(styleId)) {
    return;
  }

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
        /* Підсвітка фону для доданих рядків */
        .highlight-added {
            background-color: rgba(33, 150, 243, 0.15) !important;
            transition: background-color 3s ease;
        }
        .highlight-added-off {
            background-color: transparent !important;
            transition: background-color 3s ease;
        }
        /* Підсвітка фону для видалених рядків */
        .highlight-deleted {
            background-color: rgba(244, 67, 54, 0.12) !important;
            transition: background-color 3s ease, opacity 3s ease;
            opacity: 1;
        }
        .highlight-deleted-off {
            background-color: transparent !important;
            opacity: 0 !important;
            transition: background-color 3s ease, opacity 3s ease;
        }
    `;

  document.head.appendChild(style);
}

/**
 * Створює SVG-оверлей зі змійкою по периметру поверх групи рядків
 */
function createSnakeBorderOverlay(
  rows: HTMLTableRowElement[],
  type: "added" | "deleted",
): { cleanup: () => void } {
  if (rows.length === 0) return { cleanup: () => {} };

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const gradId = `snake-grad-${type}-${Date.now()}`;
  const sw = 1.5; // товщина лінії

  // Градієнт
  const defs = document.createElementNS(ns, "defs");
  const grad = document.createElementNS(ns, "linearGradient");
  grad.id = gradId;
  grad.setAttribute("gradientUnits", "userSpaceOnUse");

  const colors =
    type === "added"
      ? [
          ["0%", "#003399"],
          ["100%", "#00ff00"],
        ]
      : [
          ["0%", "#ff0000"],
          ["100%", "#ffa500"],
        ];

  for (const [offset, color] of colors) {
    const stop = document.createElementNS(ns, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Прямокутник
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("rx", "4");
  rect.setAttribute("ry", "4");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", `url(#${gradId})`);
  rect.setAttribute("stroke-width", String(sw));
  rect.setAttribute("stroke-linecap", "round");
  svg.appendChild(rect);

  svg.style.cssText =
    "position:fixed;z-index:99999;pointer-events:none;overflow:visible;opacity:0;transition:opacity 3s ease;";

  document.body.appendChild(svg);

  // Плавне появлення — запускаємо opacity: 1 після вставки в DOM
  requestAnimationFrame(() => {
    svg.style.opacity = "1";
  });

  let running = true;
  let rafId = 0;
  const startTime = performance.now();
  const cycleDuration = 4000; // 4 секунди на повний оберт

  function animate(): void {
    if (!running) return;

    // Обчислення bounding-box групи рядків
    const firstRect = rows[0].getBoundingClientRect();
    const lastRect = rows[rows.length - 1].getBoundingClientRect();
    const top = firstRect.top;
    const left = Math.min(firstRect.left, lastRect.left);
    const right = Math.max(firstRect.right, lastRect.right);
    const bottom = lastRect.bottom;
    const w = right - left;
    const h = bottom - top;

    svg.style.top = `${top}px`;
    svg.style.left = `${left}px`;
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    rect.setAttribute("x", String(sw / 2));
    rect.setAttribute("y", String(sw / 2));
    rect.setAttribute("width", String(Math.max(0, w - sw)));
    rect.setAttribute("height", String(Math.max(0, h - sw)));

    // Градієнт по діагоналі
    grad.setAttribute("x1", "0");
    grad.setAttribute("y1", "0");
    grad.setAttribute("x2", String(w));
    grad.setAttribute("y2", String(h));

    // Периметр і змійка (20% довжини)
    const perimeter = 2 * (w - sw + h - sw) + 4 * Math.PI; // з урахуванням rx/ry
    const snakeLen = perimeter * 0.2;
    const gapLen = perimeter * 0.8;

    rect.setAttribute("stroke-dasharray", `${snakeLen} ${gapLen}`);

    // Обидві за годинниковою, видалені зі зсувом 180° (пів-периметра)
    const elapsed = performance.now() - startTime;
    const progress = (elapsed % cycleDuration) / cycleDuration;
    const phaseShift = type === "deleted" ? perimeter * 0.5 : 0;
    const offset = -(progress * perimeter + phaseShift);

    rect.setAttribute("stroke-dashoffset", String(offset));

    rafId = requestAnimationFrame(animate);
  }

  animate();

  function cleanup(): void {
    if (!running) return;
    // Плавне зникнення
    svg.style.opacity = "0";
    setTimeout(() => {
      running = false;
      cancelAnimationFrame(rafId);
      svg.remove();
    }, 3000);
  }

  return { cleanup };
}

/* =============================== ПІДСВІЧУВАННЯ ДОДАНИХ =============================== */

/**
 * Знаходить рядок в таблиці за назвою позиції
 */
function findRowByItemName(itemName: string): HTMLTableRowElement | null {
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return null;

  const rows = container.querySelectorAll<HTMLTableRowElement>("tbody tr");

  for (const row of rows) {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    const name = nameCell?.textContent?.trim() || "";

    if (name === itemName) {
      return row;
    }
  }

  return null;
}

/**
 * Групує рядки в послідовні блоки (сусідні tr в DOM)
 */
function groupConsecutiveRows(
  rows: HTMLTableRowElement[],
): HTMLTableRowElement[][] {
  if (rows.length === 0) return [];

  // Сортуємо за позицією в DOM
  const sorted = [...rows].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const groups: HTMLTableRowElement[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    // Перевіряємо чи curr йде одразу після prev
    if (prev.nextElementSibling === curr) {
      groups[groups.length - 1].push(curr);
    } else {
      groups.push([curr]);
    }
  }

  return groups;
}

/**
 * Підсвічує додані позиції змійкою зелено-синього кольору по контуру групи рядків
 */
function startAddedHighlight(addedChanges: ChangeRecord[]): number[] {
  const rows: HTMLTableRowElement[] = [];
  const displayed: number[] = [];

  for (const change of addedChanges) {
    const row = findRowByItemName(change.item_name);
    if (row) {
      if (!rows.includes(row)) rows.push(row);
      displayed.push(change.notification_id);
    }
  }

  if (rows.length === 0) return displayed;

  // Блакитний фон — одразу додаємо клас (CSS transition зробить плавність)
  rows.forEach((row) => row.classList.add("highlight-added"));
  activeAddedRows.push(...rows);

  // Групуємо послідовні рядки — окрема змійка на кожну групу
  // Затримка 100мс щоб рядки встигли відрендеритись
  const generation = highlightGeneration;
  setTimeout(() => {
    if (generation !== highlightGeneration || !rows.every(row => row.isConnected)) return;
    const groups = groupConsecutiveRows(rows);
    for (const group of groups) {
      const { cleanup } = createSnakeBorderOverlay(group, "added");
      activeSnakeCleanups.push(cleanup);
    }
  }, 100);
  return displayed;
}

/* =============================== ПІДСВІЧУВАННЯ ВИДАЛЕНИХ =============================== */

/**
 * Генерує HTML для тимчасового рядка з даними видаленої позиції
 */
function generateDeletedItemHtml(change: ChangeRecord, index: number): string {
  const showPibMagazin = globalCache.settings?.showPibMagazin ?? true;
  const showCatalog = globalCache.settings?.showCatalog ?? true;
  const showZarplata = globalCache.settings?.showZarplata ?? true;

  // Визначаємо тип позиції (робота чи деталь) за наявністю зарплати
  const isWork = change.zarplata > 0;
  const icon = isWork ? "🛠️" : "⚙️";

  // Розраховуємо суму
  const sum = change.cina * change.kilkist;

  // Форматуємо числа
  const formatNum = (n: number) => new Intl.NumberFormat("uk-UA").format(n);
  const escapeText = (value: string) => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]!));

  // Presentation cells deliberately have no editor data-name/contenteditable
  // attributes or editing classes: they must never become saved act positions.
  const catalogCellHTML = `<td${!showCatalog ? ' style="display: none;"' : ""}></td>`;

  const pibMagazinCellHTML = showPibMagazin
    ? `<td>${escapeText(change.changed_by_surname)}</td>`
    : "";

  // ✅ ВИПРАВЛЕНО: Завжди створюємо комірку зарплати, але приховуємо якщо showZarplata = false
  const zarplataCellHTML = `<td class="text-right"${
    !showZarplata ? ' style="display: none;"' : ""
  }>${change.zarplata > 0 ? formatNum(change.zarplata) : ""}</td>`;

  return `
        <tr class="deleted-item-row" data-notification-only="true">
            <td>${icon} ${index + 1}</td>
            <td>
                <div>${escapeText(change.item_name)}</div>
            </td>
            ${catalogCellHTML}
            <td class="text-right">${formatNum(
              change.kilkist,
            )}</td>
            <td class="text-right">${formatNum(
              change.cina,
            )}</td>
            <td class="text-right">${formatNum(sum)}</td>
            ${zarplataCellHTML}
            ${pibMagazinCellHTML}
        </tr>
    `;
}

/**
 * Підсвічує видалені позиції змійкою помаранчево-червоного кольору, потім видаляє рядки
 */
function startDeletedHighlight(deletedChanges: ChangeRecord[]): number[] {
  const container = document.getElementById(ACT_ITEMS_TABLE_CONTAINER_ID);
  if (!container) return [];

  const tableBody = container.querySelector("tbody");
  if (!tableBody) return [];

  const rowsCreated: HTMLTableRowElement[] = [];
  const displayed: number[] = [];

  for (const change of deletedChanges) {
    try {
      const currentRowCount = tableBody.querySelectorAll("tr").length;
      const index = currentRowCount;

      const rowHtml = generateDeletedItemHtml(change, index);
      tableBody.insertAdjacentHTML("beforeend", rowHtml);

      const row = tableBody.querySelector(
        "tr.deleted-item-row:last-child",
      ) as HTMLTableRowElement;

      if (!row) continue;

      row.classList.add("highlight-deleted");
      rowsCreated.push(row);
      displayed.push(change.notification_id);
    } catch (error) {
      // Пропускаємо помилку
    }
  }

  if (rowsCreated.length === 0) return displayed;

  // Групуємо послідовні рядки — окрема змійка на кожну групу
  const generation = highlightGeneration;
  setTimeout(() => {
    if (generation !== highlightGeneration || !rowsCreated.every(row => row.isConnected)) return;
    const groups = groupConsecutiveRows(rowsCreated);
    for (const group of groups) {
      const { cleanup } = createSnakeBorderOverlay(group, "deleted");
      activeSnakeCleanups.push(cleanup);
    }
  }, 100);
  activeDeletedRows.push(...rowsCreated);
  return displayed;
}

/* =============================== РОБОТА З БД =============================== */

/**
 * Завантажує зміни для акту з БД
 */
async function loadChangesForAct(actId: number, reception: string | null, scope: string, generation: number, isCurrent: () => boolean): Promise<ChangeRecord[]> {
  const key = JSON.stringify([scope, actId, reception, generation]);
  const existing = pendingReads.get(key);
  if (existing) return existing;
  const request = (async () => {
    const rows: ChangeRecord[] = [];
    let after = 0;
    for (;;) {
      if (!isCurrent() || generation !== highlightGeneration) return [];
      let query = supabase.from("act_changes_notifications")
        .select("notification_id,act_id,item_name,cina,kilkist,zarplata,dodav_vudaluv,changed_by_surname")
        .eq("act_id", actId).gt("notification_id", after).order("notification_id").limit(200);
      // Dismissed toast rows remain available until their act changes are seen.
      if (reception) query = query.eq("pruimalnyk", reception);
      const { data, error } = await query;
      if (error) throw error;
      if (!isCurrent() || generation !== highlightGeneration) return [];
      rows.push(...(data || []) as ChangeRecord[]);
      if (!data || data.length < 200) return rows;
      after = Number(data[data.length - 1].notification_id);
    }
  })();
  pendingReads.set(key, request);
  void request.finally(() => { if (pendingReads.get(key) === request) pendingReads.delete(key); }).catch(() => {});
  return request;
}

/** Acknowledge only rows that were actually loaded and displayed. */
async function deleteProcessedChanges(actId: number, ids: number[], reception: string | null, isCurrent: () => boolean): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 200) {
    if (!isCurrent()) return;
    let query = supabase.from("act_changes_notifications").delete()
      .eq("act_id", actId).in("notification_id", ids.slice(offset, offset + 200));
    if (reception) query = query.eq("pruimalnyk", reception);
    const { data, error } = await query.select("notification_id");
    if (error) throw error;
    if (data?.length && isCurrent()) window.dispatchEvent(new CustomEvent("sto:act-notifications-removed", {
      detail: { actId, notificationIds: data.map(row => Number(row.notification_id)) },
    }));
  }
}

/* =============================== ГОЛОВНА ФУНКЦІЯ =============================== */

/**
 * Перевіряє та підсвічує зміни в акті для Адміністратора та Приймальника
 */
export async function checkAndHighlightChanges(actId: number, isCurrentOpening: () => boolean = () => true): Promise<void> {
  // ✅ Працює для Адміністратора та Приймальника
  if (
    userAccessLevel !== "Адміністратор" &&
    userAccessLevel !== "Приймальник"
  ) {
    return;
  }

  const scope = localStorage.getItem("userAuthData") || "";
  const reception = userAccessLevel === "Приймальник" ? getSavedUserDataFromLocalStorage()?.name || "" : null;
  if (reception === "") return;
  const generation = highlightGeneration;
  const isCurrent = () => isCurrentOpening() && scope === (localStorage.getItem("userAuthData") || "");
  try {
    // Додаємо CSS стилі
    injectHighlightStyles();

    // Завантажуємо зміни з БД (з фільтрацією по pruimalnyk для Приймальника)
    const changes = await loadChangesForAct(actId, reception, scope, generation, isCurrent);
    if (!isCurrent() || generation !== highlightGeneration) return;
    const added = changes.filter(row => row.dodav_vudaluv === true);
    const deleted = changes.filter(row => row.dodav_vudaluv === false);

    // Якщо змін немає - виходимо
    if (added.length === 0 && deleted.length === 0) {
      return;
    }

    // Очищаємо попередні змійки (якщо були)
    cleanupAllSnakeBorders();

    // Запускаємо обидва підсвічування ОДНОЧАСНО
    const displayedIds = [
      ...(added.length ? startAddedHighlight(added) : []),
      ...(deleted.length ? startDeletedHighlight(deleted) : []),
    ];

    // Через 8 секунд (3с fade-in + 5с показ) запускаємо плавне зникнення (fade-out 3с)
    const displayedGeneration = highlightGeneration;
    autoCleanupTimer = setTimeout(() => {
      if (displayedGeneration !== highlightGeneration) return;
      // Плавно прибираємо фон доданих
      activeAddedRows.forEach((row) => {
        row.classList.remove("highlight-added");
        row.classList.add("highlight-added-off");
      });
      // Плавно прибираємо фон + текст видалених (фон та opacity зникають за 2с)
      activeDeletedRows.forEach((row) => {
        row.classList.remove("highlight-deleted");
        row.classList.add("highlight-deleted-off");
      });
      // Змійки плавно зникають (cleanup робить opacity→0 за 2с)
      activeSnakeCleanups.forEach((fn) => fn());
      activeSnakeCleanups.length = 0;
      // Через 3с (коли fade-out завершиться) — прибираємо DOM
      setTimeout(() => {
        if (displayedGeneration !== highlightGeneration) return;
        activeDeletedRows.forEach((row) => row.remove());
        activeDeletedRows.length = 0;
        activeAddedRows.forEach((row) =>
          row.classList.remove("highlight-added-off"),
        );
        activeAddedRows.length = 0;
      }, 3000);
    }, 9000);

    // ✅ ДЛЯ ПРИЙМАЛЬНИКА та АДМІНІСТРАТОРА: видаляємо оброблені записи
    if (
      userAccessLevel === "Приймальник" ||
      userAccessLevel === "Адміністратор"
    ) {
      await deleteProcessedChanges(actId, displayedIds, reception, isCurrent);
    } else {
    }
  } catch (error) {
    // console.error("❌ Помилка при підсвічуванні змін:", error);
    // Не блокуємо відкриття акту через помилку підсвічування
  }
}
