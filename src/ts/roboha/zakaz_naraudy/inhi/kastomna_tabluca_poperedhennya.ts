import { actQuantitySnapshot } from "../actQuantitySnapshot";
import { safeParseJSON } from "./ctvorennia_papku_googleDrive.";
import { globalCache, ensureSkladIdsLoaded } from "../globalCache";
import { loadPercentByWarehouse } from "./kastomna_tabluca";
import { supabase } from "../../../vxid/supabaseClient";
import { updateCalculatedSumsInFooter } from "../modalUI";
import { userAccessLevel } from "../../tablucya/users";

// Cache for current act data
let currentActDataCache: any = null;
let actDataPending: { id: number; generation: number; promise: Promise<any> } | null = null;
let actDataGeneration = 0;
let actDataLoadedId: number | null = null;
let actDataLoadedAt = 0;
let autoRefreshInterval: any = null;

// Cache for name cell lengths and clearing state
const nameLengthCache = new WeakMap<HTMLElement, number>();
const nameClearedOnce = new WeakMap<HTMLElement, boolean>();

/* ===================== UI STYLES ===================== */
function ensureWarningStyles() {
  if (document.getElementById("warn-badge-styles")) return;
  const css = `
    .qty-cell, .price-cell, .slyusar-sum-cell { position: relative; }
    
    .qty-cell[data-warn="1"]::before,
    .price-cell[data-warnprice="1"]::before {
      content: "!";
      position: absolute;
      top: 50%;
      left: 4px;
      transform: translateY(-50%);
      width: 16px; height: 16px; line-height: 16px; text-align: center;
      font-size: 10px; font-weight: 800;
      color: #fff; background: #ff9800;
      clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
      border-radius: 2px; pointer-events: none; user-select: none;
      z-index: 10;
    }
    
    .qty-cell[data-warn="1"],
    .price-cell[data-warnprice="1"] {
      background-color: #fff3e0 !important;
      border: 1px solid #ff9800 !important;
      padding-left: 24px !important;
    }

    /* Червоний warning — зарплата більша за суму (квадрат) */
    .slyusar-sum-cell[data-warnzp="1"]::before {
      content: "!";
      position: absolute;
      top: 50%;
      left: 4px;
      transform: translateY(-50%);
      width: 16px; height: 16px; line-height: 16px; text-align: center;
      font-size: 10px; font-weight: 800;
      color: #fff; background: #e53935;
      border-radius: 2px; pointer-events: none; user-select: none;
      z-index: 10;
    }

    .slyusar-sum-cell[data-warnzp="1"] {
      background-color: #ffebee !important;
      border: 1px solid #e53935 !important;
      padding-left: 24px !important;
    }

    /* Червоний warning — ціна нижче собівартості */
    .price-cell[data-warnprice-red="1"]::before {
      content: "!";
      position: absolute;
      top: 50%;
      left: 4px;
      transform: translateY(-50%);
      width: 16px; height: 16px; line-height: 16px; text-align: center;
      font-size: 10px; font-weight: 800;
      color: #fff; background: #e53935;
      border-radius: 2px; pointer-events: none; user-select: none;
      z-index: 10;
    }

    .price-cell[data-warnprice-red="1"] {
      background-color: #ffebee !important;
      border: 1px solid #e53935 !important;
      padding-left: 24px !important;
    }
  `;
  const tag = document.createElement("style");
  tag.id = "warn-badge-styles";
  tag.textContent = css;
  document.head.appendChild(tag);
}

function ensureCellClass(
  cell: HTMLElement,
  cls: "qty-cell" | "price-cell" | "slyusar-sum-cell",
) {
  if (!cell.classList.contains(cls)) cell.classList.add(cls);
}

/* ===================== WARNING FLAG SETTERS ===================== */
export function setWarningFlag(cell: HTMLElement | null, on: boolean) {
  if (!cell) return;
  ensureWarningStyles();
  ensureCellClass(cell, "qty-cell");
  if (on) cell.setAttribute("data-warn", "1");
  else cell.removeAttribute("data-warn");
}

export function setPriceWarningFlag(cell: HTMLElement | null, on: boolean) {
  if (!cell) return;
  ensureWarningStyles();
  ensureCellClass(cell, "price-cell");
  if (on) cell.setAttribute("data-warnprice", "1");
  else cell.removeAttribute("data-warnprice");
}

export function setPriceBelowCostFlag(cell: HTMLElement | null, on: boolean) {
  if (!cell) return;
  ensureWarningStyles();
  ensureCellClass(cell, "price-cell");
  if (on) cell.setAttribute("data-warnprice-red", "1");
  else cell.removeAttribute("data-warnprice-red");
}

export function setSlyusarSumWarningFlag(
  cell: HTMLElement | null,
  on: boolean,
) {
  if (!cell) return;
  ensureWarningStyles();
  ensureCellClass(cell, "slyusar-sum-cell");
  if (on) cell.setAttribute("data-warnzp", "1");
  else cell.removeAttribute("data-warnzp");
}

/* ===================== UTILITY FUNCTIONS ===================== */
function formatUA(n: number): string {
  return new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 3 }).format(n);
}

function parseNumFromNode(node: HTMLElement | null): number {
  if (!node) return 0;
  const raw = (node as HTMLInputElement).value ?? node.textContent ?? "";
  const val = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(val) ? val : 0;
}

function getNodeTextLen(el: HTMLElement): number {
  return (el.textContent ?? "").replace(/\u00A0/g, " ").replace(/\u200B/g, "")
    .length;
}

function getCurrentTableQtyForSclad(row: HTMLElement, sclad_id: number): number {
  const table = row.closest("table");
  const rows = Array.from(
    table?.querySelectorAll<HTMLTableRowElement>("tbody tr") || [],
  );

  return rows.reduce((total, tr) => {
    const nameCell = tr.querySelector('[data-name="name"]') as HTMLElement | null;
    if (!nameCell?.textContent?.trim()) return total;

    const catalogCell = tr.querySelector(
      '[data-name="catalog"]',
    ) as HTMLElement | null;
    const rowScladId = catalogCell?.getAttribute("data-sclad-id")
      ? Number(catalogCell.getAttribute("data-sclad-id"))
      : null;

    if (rowScladId !== sclad_id) return total;

    const qtyCell = tr.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    return total + parseNumFromNode(qtyCell);
  }, 0);
}

/* ===================== ACT DATA CACHE ===================== */
export function receiveSavedActQuantities(id: number, raw: unknown): void {
  if (id !== globalCache.currentActId) return;
  const data = safeParseJSON(raw);
  if (!data || typeof data !== "object" || (data.Деталі !== undefined && !Array.isArray(data.Деталі))) return;
  resetActDataCache();
  const quantities = new Map<number, number>();
  for (const detail of data.Деталі || []) {
    const stockId = Number(detail.sclad_id);
    if (stockId) quantities.set(stockId, (quantities.get(stockId) || 0) + (Number(String(detail.Кількість ?? 0).replace(/\s/g, "").replace(",", ".")) || 0));
  }
  actQuantitySnapshot.seed(id, quantities);
}
async function loadCurrentActData(): Promise<any> {
  const id = globalCache.currentActId;
  const generation = actDataGeneration;
  if (!id) return null;
  if (actDataPending?.id === id && actDataPending.generation === generation) return actDataPending.promise;
  if (actDataLoadedId === id && currentActDataCache && Date.now() - actDataLoadedAt < 500) return currentActDataCache;
  const promise = fetchCurrentActData(id, generation);
  actDataPending = { id, generation, promise };
  try { return await promise; } finally {
    if (actDataPending?.promise === promise) actDataPending = null;
  }
}

async function fetchCurrentActData(id: number, generation: number): Promise<any> {
  if (!globalCache.currentActId) {
    currentActDataCache = null;
    return null;
  }
  try {
    const { data, error } = await supabase.rpc("traffic_editor_act_quantities", {p_act_id:id});

    if (generation !== actDataGeneration || id !== globalCache.currentActId) return null;
    if (error || !data || !Array.isArray(data.Деталі)) {
      // console.error("Помилка завантаження даних акту:", error);
      currentActDataCache = null;
      return null;
    }
    currentActDataCache = safeParseJSON(data) || {};
    const quantities = new Map<number, number>();
    for (const detail of currentActDataCache.Деталі || []) {
      const stockId = Number(detail.sclad_id);
      if (stockId) quantities.set(stockId, (quantities.get(stockId) || 0) + (Number(String(detail.Кількість ?? 0).replace(/\s/g, "").replace(",", ".")) || 0));
    }
    actQuantitySnapshot.seed(id, quantities);
    actDataLoadedId = id;
    actDataLoadedAt = Date.now();
    return currentActDataCache;
  } catch (err) {
    // console.error("Помилка завантаження даних акту:", err);
    currentActDataCache = null;
    return null;
  }
}

export function resetActDataCache(): void {
  actDataGeneration++;
  actDataLoadedId = null;
  actDataLoadedAt = 0;
  currentActDataCache = null;
}

export async function refreshActDataCache(): Promise<void> {
  resetActDataCache();
  await loadCurrentActData();
}

async function getCurrentActDetailQty(sclad_id: number): Promise<number> {
  const known = actQuantitySnapshot.quantity(globalCache.currentActId || 0, sclad_id);
  if (known !== undefined) return known;
  const snapshot = await loadCurrentActData();
  if (!snapshot) throw new Error("Не вдалося перевірити початкову кількість акту.");
  if (!snapshot.Деталі) return 0;

  return snapshot.Деталі.reduce((total: number, detail: any) => {
    if (Number(detail.sclad_id) !== Number(sclad_id)) return total;
    const qtyRaw = detail.Кількість;
    const qty =
      typeof qtyRaw === "number"
        ? qtyRaw
        : parseFloat(String(qtyRaw).replace(/\s/g, "").replace(",", ".")) || 0;
    return total + qty;
  }, 0);
}

/* ===================== CORE CHECKS ===================== */
export async function updateCatalogWarningForRow(row: HTMLElement) {
  if (globalCache.isActClosed) {
    const qtyCell = row.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    if (qtyCell) {
      setWarningFlag(qtyCell, false);
      qtyCell.removeAttribute("title");
    }
    return;
  }

  const qtyCell = row.querySelector(
    '[data-name="id_count"]',
  ) as HTMLElement | null;
  if (!qtyCell) return;

  const catalogCell = row.querySelector(
    '[data-name="catalog"]',
  ) as HTMLElement | null;
  const sclad_id = catalogCell?.getAttribute("data-sclad-id")
    ? Number(catalogCell.getAttribute("data-sclad-id"))
    : null;

  if (!sclad_id) {
    setWarningFlag(qtyCell, false);
    qtyCell.removeAttribute("title");
    return;
  }

  await ensureSkladIdsLoaded([sclad_id]);
  if (!row.isConnected || Number(catalogCell?.getAttribute("data-sclad-id")) !== sclad_id) return;
  const picked = globalCache.skladParts.find(
    (p) => Number(p.sclad_id) === sclad_id,
  );
  if (!picked) {
    setWarningFlag(qtyCell, false);
    qtyCell.removeAttribute("title");
    return;
  }

  const currentTotal = getCurrentTableQtyForSclad(row, sclad_id);
  const checkingAct = globalCache.currentActId;
  const savedTotal = await getCurrentActDetailQty(sclad_id);
  if (!row.isConnected || checkingAct !== globalCache.currentActId || Number(catalogCell?.getAttribute("data-sclad-id")) !== sclad_id || currentTotal !== getCurrentTableQtyForSclad(row, sclad_id)) return;
  const delta = currentTotal - savedTotal;
  const availableAfterChange = Number(picked.quantity ?? 0) - delta;
  const warn = availableAfterChange < 0;

  setWarningFlag(qtyCell, warn);
  if (warn) {
    const needMore = Math.abs(availableAfterChange);
    qtyCell.title =
      `Не вистачає ${formatUA(needMore)} ${picked.unit ?? ""}`.trim();
  } else {
    qtyCell.removeAttribute("title");
  }
}

export async function updatePriceWarningForRow(row: HTMLElement) {
  if (globalCache.isActClosed) {
    const priceCell = row.querySelector(
      '[data-name="price"]',
    ) as HTMLElement | null;
    if (priceCell) {
      setPriceWarningFlag(priceCell, false);
      setPriceBelowCostFlag(priceCell, false);
      priceCell.removeAttribute("title");
      priceCell.style.backgroundColor = "";
    }
    return;
  }

  const priceCell = row.querySelector(
    '[data-name="price"]',
  ) as HTMLElement | null;
  const catalogCell = row.querySelector(
    '[data-name="catalog"]',
  ) as HTMLElement | null;
  if (!priceCell) return;

  const sclad_id = catalogCell?.getAttribute("data-sclad-id")
    ? Number(catalogCell.getAttribute("data-sclad-id"))
    : null;
  if (!sclad_id) {
    setPriceWarningFlag(priceCell, false);
    setPriceBelowCostFlag(priceCell, false);
    priceCell.removeAttribute("title");
    priceCell.style.backgroundColor = "";
    return;
  }

  await ensureSkladIdsLoaded([sclad_id]);
  if (!row.isConnected || Number(catalogCell?.getAttribute("data-sclad-id")) !== sclad_id) return;
  const picked = globalCache.skladParts.find(
    (p) => Number(p.sclad_id) === sclad_id,
  );
  if (!picked) {
    setPriceWarningFlag(priceCell, false);
    setPriceBelowCostFlag(priceCell, false);
    priceCell.removeAttribute("title");
    priceCell.style.backgroundColor = "";
    return;
  }

  // ✅ ВИПРАВЛЕНО: Спочатку беремо scladNomer з атрибуту DOM, потім з кешу, потім з бази
  const scladNomerAttr = catalogCell?.getAttribute("data-sclad-nomer");
  let scladNomer: number | null | undefined = scladNomerAttr
    ? Number(scladNomerAttr)
    : picked.scladNomer;

  // ✅ Fallback: якщо scladNomer відсутній - отримуємо напряму з бази по sclad_id
  if (scladNomer === null || scladNomer === undefined || scladNomer === 0) {
    try {
      const { data: scladData } = await supabase
        .from("sclad")
        .select('"scladNomer"')
        .eq("sclad_id", sclad_id)
        .single();
      if (scladData && scladData.scladNomer) {
        scladNomer = Number(scladData.scladNomer);
        // Зберігаємо в атрибут для наступних перевірок
        if (catalogCell && scladNomer > 0) {
          catalogCell.setAttribute("data-sclad-nomer", String(scladNomer));
        }
      }
    } catch (e) {
      // Ігноруємо помилку запиту
    }
  }

  const percentInfo = await loadPercentByWarehouse(scladNomer);
  const enteredPrice = parseNumFromNode(priceCell);
  const basePrice = Math.round(Number(picked.price) || 0);
  const minPrice = Math.ceil(basePrice * (1 + percentInfo.percent / 100));

  // ✅ СТИЛІЗАЦІЯ ПО СТАТУСУ СКЛАДУ
  if (percentInfo.status === "blocked") {
    // Склад заблокований — червоний фон
    setPriceWarningFlag(priceCell, false);
    priceCell.style.backgroundColor = "#ffcdd2";
    priceCell.title = `⛔ Склад ${scladNomer || 1} заблокований! Вхідна ціна: ${formatUA(basePrice)} грн`;
  } else if (percentInfo.status === "missing") {
    // Склад відсутній — синій фон
    setPriceWarningFlag(priceCell, false);
    priceCell.style.backgroundColor = "#bbdefb";
    priceCell.title = `⚠️ Склад ${scladNomer || "?"} відсутній, націнка 0%. Вхідна ціна: ${formatUA(basePrice)} грн`;
  } else {
    // Нормальний склад — перевіряємо ціну
    priceCell.style.backgroundColor = "";

    // Червоний warning — ціна нижче собівартості (вхідної ціни)
    const belowCost = enteredPrice > 0 && enteredPrice < basePrice;
    setPriceBelowCostFlag(priceCell, belowCost);

    if (belowCost) {
      // Нижче собівартості — червоний, жовтий не потрібен
      setPriceWarningFlag(priceCell, false);
      priceCell.title = `⛔ Ціна нижче собівартості! Вхідна: ${formatUA(basePrice)} грн, продаж: ${formatUA(enteredPrice)} грн`;
    } else {
      // Перевірка на мінімальну ціну з націнкою (жовтий, з допуском)
      const tolerance = Math.max(2, minPrice * 0.01);
      const warn = enteredPrice > 0 && enteredPrice < minPrice - tolerance;
      setPriceWarningFlag(priceCell, warn);
      if (warn)
        priceCell.title = `Мін. ціна: ${formatUA(minPrice)} грн (вхідна ${formatUA(basePrice)} + ${percentInfo.percent}%)`;
      else priceCell.removeAttribute("title");
    }
  }
}

export async function updateSlyusarSumWarningForRow(row: HTMLElement) {
  // ✅ Слюсар не бачить колонку "Сума", тому не показуємо йому попередження про зарплату
  if (userAccessLevel === "Слюсар") {
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement | null;
    if (slyusarSumCell) {
      setSlyusarSumWarningFlag(slyusarSumCell, false);
      slyusarSumCell.removeAttribute("title");
    }
    return;
  }

  if (globalCache.isActClosed) {
    const sumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement | null;
    if (sumCell) {
      setSlyusarSumWarningFlag(sumCell, false);
      sumCell.removeAttribute("title");
    }
    return;
  }

  const nameCell = row.querySelector(
    '[data-name="name"]',
  ) as HTMLElement | null;
  const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement | null;
  const slyusarSumCell = row.querySelector(
    '[data-name="slyusar_sum"]',
  ) as HTMLElement | null;

  if (!slyusarSumCell || !sumCell) return;

  const typeFromCell = nameCell?.getAttribute("data-type");
  if (typeFromCell !== "works") {
    setSlyusarSumWarningFlag(slyusarSumCell, false);
    slyusarSumCell.removeAttribute("title");
    return;
  }

  const sum = parseNumFromNode(sumCell);
  const slyusarSum = parseNumFromNode(slyusarSumCell);
  const warn = slyusarSum > sum;

  setSlyusarSumWarningFlag(slyusarSumCell, warn);
  if (warn) {
    slyusarSumCell.title = `⛔ Зарплата (${formatUA(slyusarSum)} грн) більша за суму роботи (${formatUA(sum)} грн)`;
  } else {
    slyusarSumCell.removeAttribute("title");
  }
}

/* ===================== CLEAR CELLS ON NAME CHANGE ===================== */
async function clearCellsOnNameChange(
  row: HTMLElement,
  prevNameLength: number,
  currentNameLength: number,
) {
  if (currentNameLength >= prevNameLength) return;

  // Визначаємо тип рядка (works = робота, інше = запчастина)
  const nameCell = row.querySelector(
    '[data-name="name"]',
  ) as HTMLElement | null;
  const rowType = nameCell?.getAttribute("data-type") || "";
  const nameText = nameCell?.textContent?.trim() || "";

  // Перевіряємо чи це робота: або за data-type, або за наявністю в списку робіт
  const isWork = rowType === "works" || globalCache.works.includes(nameText);

  // Для робіт очищаємо тільки каталог, для запчастин - все як раніше
  const cellsToClear = isWork
    ? ['[data-name="catalog"]']
    : [
        '[data-name="catalog"]',
        '[data-name="id_count"]',
        '[data-name="price"]',
        '[data-name="sum"]',
        '[data-name="slyusar_sum"]',
        '[data-name="pib_magazin"]',
      ];

  for (const selector of cellsToClear) {
    const cell = row.querySelector(selector) as HTMLElement | null;
    if (!cell) continue;
    cell.textContent = "";
    cell.removeAttribute("data-sclad-id");
    cell.removeAttribute("data-type");
    cell.removeAttribute("title");
    if (selector === '[data-name="id_count"]') setWarningFlag(cell, false);
    if (selector === '[data-name="price"]') setPriceWarningFlag(cell, false);
    if (selector === '[data-name="slyusar_sum"]')
      setSlyusarSumWarningFlag(cell, false);
  }

  updateCalculatedSumsInFooter();
  await updateCatalogWarningForRow(row);
  await updatePriceWarningForRow(row);
  await updateSlyusarSumWarningForRow(row);
}

/* ===================== MASS REFRESH ===================== */
export async function refreshQtyWarningsIn(containerId: string, stockIds?: ReadonlySet<number>) {
  ensureWarningStyles();
  if (globalCache.isActClosed) return;


  if (actQuantitySnapshot.quantity(globalCache.currentActId || 0, 0) === undefined) await loadCurrentActData();

  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = Array.from(
    container.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ).filter(row => !stockIds || stockIds.has(Number(row.querySelector('[data-sclad-id]')?.getAttribute("data-sclad-id"))));
  if (!rows.length) return;
  await ensureSkladIdsLoaded(rows.map(row => Number(row.querySelector('[data-sclad-id]')?.getAttribute("data-sclad-id"))));
  for (const tr of rows) {
    const row = tr as HTMLElement;
    await Promise.all([
      updateCatalogWarningForRow(row),
      updatePriceWarningForRow(row),
      updateSlyusarSumWarningForRow(row),
    ]);
  }
  updateCalculatedSumsInFooter();
}

/* ===================== LISTENERS ===================== */
export function setupQtyWarningListeners(containerId: string) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Initialize cache for name cells
  container
    .querySelectorAll<HTMLElement>('tbody tr [data-name="name"]')
    .forEach((cell) => {
      nameLengthCache.set(cell, getNodeTextLen(cell));
      nameClearedOnce.set(cell, false);
    });

  const onKeyDownName = (e: KeyboardEvent) => {
    const cell = (e.target as HTMLElement)?.closest(
      '[data-name="name"]',
    ) as HTMLElement | null;
    if (!cell || (e.key !== "Backspace" && e.key !== "Delete")) return;

    const prev = nameLengthCache.get(cell) ?? 0;
    setTimeout(async () => {
      const cur = getNodeTextLen(cell);
      if (cur < prev && !nameClearedOnce.get(cell)) {
        const row = cell.closest("tr") as HTMLElement | null;
        if (row) {
          await clearCellsOnNameChange(row, prev, cur);
          nameClearedOnce.set(cell, true);
        }
      }
      nameLengthCache.set(cell, cur);
      if (cur > prev) nameClearedOnce.set(cell, false);
    }, 0);
  };

  const onInputName = async (e: Event) => {
    const cell = (e.target as HTMLElement)?.closest(
      '[data-name="name"]',
    ) as HTMLElement | null;
    if (!cell) return;
    const row = cell.closest("tr") as HTMLElement | null;
    if (!row) return;

    const prev = nameLengthCache.get(cell) ?? 0;
    const cur = getNodeTextLen(cell);
    if (cur < prev && !nameClearedOnce.get(cell)) {
      await clearCellsOnNameChange(row, prev, cur);
      nameClearedOnce.set(cell, true);
    }
    if (cur > prev) nameClearedOnce.set(cell, false);
    nameLengthCache.set(cell, cur);
  };

  const onInput = async (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest("tr") as HTMLElement | null;
    if (!row) return;

    const cell = target.closest('[data-name="id_count"]') as HTMLElement | null;
    if (cell) await updateCatalogWarningForRow(row);

    const priceCell = target.closest(
      '[data-name="price"]',
    ) as HTMLElement | null;
    if (priceCell) await updatePriceWarningForRow(row);

    const slyusarSumCell = target.closest(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement | null;
    if (slyusarSumCell) await updateSlyusarSumWarningForRow(row);

    if (cell || priceCell || slyusarSumCell) updateCalculatedSumsInFooter();
  };

  const onBlur = async (e: Event) => {
    const cell = (e.target as HTMLElement)?.closest(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    if (!cell) return;
    const row = cell.closest("tr") as HTMLElement | null;
    if (row) await updateCatalogWarningForRow(row);
  };

  const onPointerDownPreCommit = async (e: Event) => {
    const active = (document.activeElement as HTMLElement | null)?.closest(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    if (!active) return;
    const clickTarget = e.target as Node;
    if (!active.contains(clickTarget)) {
      const row = active.closest("tr") as HTMLElement | null;
      if (row) await updateCatalogWarningForRow(row);
    }
  };

  const onKeyDownPreCommit = async (e: KeyboardEvent) => {
    if (!["Enter", "Tab", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const active = (document.activeElement as HTMLElement | null)?.closest(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    if (active) {
      const row = active.closest("tr") as HTMLElement | null;
      if (row) await updateCatalogWarningForRow(row);
    }
  };

  container.addEventListener("keydown", onKeyDownName, { capture: true });
  container.addEventListener("input", onInputName, { capture: true });
  container.addEventListener("input", onInput, { capture: true });
  container.addEventListener("blur", onBlur, true);
  container.addEventListener("pointerdown", onPointerDownPreCommit, {
    capture: true,
  });
  container.addEventListener("keydown", onKeyDownPreCommit, { capture: true });
}

/* ===================== INIT / SAVE HOOK / AUTO REFRESH ===================== */
export function initializeActWarnings(
  containerId: string,
  actId: number,
  enableAutoRefresh = false,
) {
  globalCache.currentActId = actId;
  resetActDataCache();
  actQuantitySnapshot.seed(actId, globalCache.oldNumbers);
  setupQtyWarningListeners(containerId);
  if (enableAutoRefresh) startAutoRefresh(containerId);
}

export async function onActSaved(containerId: string, quantities?: ReadonlyMap<number, number>) {
  resetActDataCache();
  if (quantities && globalCache.currentActId) actQuantitySnapshot.seed(globalCache.currentActId, quantities);
  else await loadCurrentActData();
  await refreshQtyWarningsIn(containerId);
}

export function startAutoRefresh(containerId: string) {
  stopAutoRefresh();
  autoRefreshInterval = setInterval(async () => {
    await refreshQtyWarningsIn(containerId);
  }, 2000);
}

export function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("sto:editor-scope-reset", resetActDataCache);
  window.addEventListener("sto:act-saved", ((event: CustomEvent) => {
    if (!event.detail?.actId || Number(event.detail.actId) === globalCache.currentActId) resetActDataCache();
  }) as EventListener);
  let stockRefresh: ReturnType<typeof setTimeout> | undefined;
  const pendingStockWarnings = new Set<number>();
  window.addEventListener("sto:stock-updated", (event: Event) => {
    const id = Number((event as CustomEvent).detail?.id);
    if (!id || !document.querySelector(`#act-items-table-container [data-sclad-id="${id}"]`)) return;
    pendingStockWarnings.add(id);
    clearTimeout(stockRefresh);
    stockRefresh = setTimeout(() => {
      const ids = new Set(pendingStockWarnings); pendingStockWarnings.clear();
      if (globalCache.currentActId && document.getElementById("act-items-table-container")) void refreshQtyWarningsIn("act-items-table-container", ids).catch(() => {});
    }, 120);
  });
}
