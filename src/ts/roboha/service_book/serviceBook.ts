// src/ts/roboha/service_book/serviceBook.ts
// 📖 Історія обслуговування авто (Service Book)
// Повна хронологія: акти, роботи, деталі, пробіг по конкретному авто
// Графіки пробігу та тренд витрат
// VIN-декодер (NHTSA API)

import ApexCharts from "apexcharts";
import { clearServiceSearchCache, readServiceSearchPage } from "./serviceSearch";
import { supabase } from "../../vxid/supabaseClient";
import { isActFrozen } from "../../utils/actFrozenState";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { decodeVin, isValidVin, type VinDecodedInfo } from "./vinDecoder";
import { showModal } from "../zakaz_naraudy/modalMain";
import { readWorkshop, recommendationStates } from "../workshop/model";
import { clearServiceHistoryCache, readServiceHistoryPage, readServiceHistorySummary, type HistoryCursor } from "./serviceHistory";

// ===================== ІНТЕРФЕЙСИ =====================

interface CarRecord {
  cars_id: number;
  client_id: number;
  data: {
    Авто?: string;
    "Номер авто"?: string;
    Обʼєм?: string;
    Пальне?: string;
    Vincode?: string;
    КодДВЗ?: string;
    Рік?: number | string;
  } | null;
  is_deleted?: boolean;
}

interface ClientRecord {
  client_id: number;
  data: {
    ПІБ?: string;
    Телефон?: string;
  } | null;
}

interface ActRecord {
  act_id: number;
  date_on: string | null;
  date_off: string | null;
  frozen?: boolean;
  data: any;
  client_id: number | null;
  cars_id: number | null;
}

interface ServiceHistoryEntry {
  actId: number;
  dateOn: string;
  dateOff: string | null;
  mileage: number;
  works: { name: string; qty: number; price: number }[];
  details: { name: string; qty: number; price: number }[];
  totalWork: number;
  totalDetails: number;
  totalSum: number;
  frozen: boolean;
  recommendation?: string;
  recommendationSummary?: string;
  reason?: string;
}

// ===================== СТАН МОДУЛЯ =====================

let mileageChart: ApexCharts | null = null;
let expenseTrendChart: ApexCharts | null = null;
let serviceBookOverlay: HTMLDivElement | null = null;
let serviceBookHistoryGeneration = 0;

// ===================== ПОШУК АВТО =====================

/**
 * Відкриває Service Book — модальне вікно пошуку авто
 */
export function openServiceBook(): void {
  if (serviceBookOverlay) {
    serviceBookOverlay.style.display = "flex";
    return;
  }
  createServiceBookModal();
}

function createServiceBookModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "sb-overlay";
  overlay.id = "service-book-overlay";

  overlay.innerHTML = `
    <div class="sb-modal">
      <button class="sb-close" id="sb-close-btn">&times;</button>
      <div class="sb-header">
        <h2>📖 Сервісна книжка</h2>
      </div>

      <!-- Пошук авто -->
      <div class="sb-search-section" id="sb-search-section">
        <div class="sb-search-row">
          <input type="text" id="sb-search-input" class="sb-input" 
                 placeholder="Пошук: номер авто, VIN, марка, ПІБ клієнта..." autocomplete="off" />
          <button id="sb-search-btn" class="sb-btn sb-btn-primary">🔍</button>
        </div>
        <div id="sb-search-results" class="sb-search-results"></div>
      </div>

      <!-- Контент авто (прихований до вибору) -->
      <div class="sb-content" id="sb-content" style="display: none;">
        <!-- Картка авто -->
        <div class="sb-car-card" id="sb-car-card"></div>

        <!-- VIN-декодер -->
        <div class="sb-vin-section" id="sb-vin-section" style="display: none;"></div>

        <!-- Табс: Хронологія / Графіки -->
        <div class="sb-tabs">
          <button class="sb-tab sb-tab-active" data-tab="history">📋 Хронологія</button>
          <button class="sb-tab" data-tab="charts">📊 Графіки</button>
        </div>

        <!-- Хронологія -->
        <div class="sb-tab-content sb-tab-history" id="sb-tab-history"></div>

        <!-- Графіки -->
        <div class="sb-tab-content sb-tab-charts" id="sb-tab-charts" style="display: none;">
          <div class="sb-chart-container">
            <h3>📈 Графік пробігу</h3>
            <div id="sb-mileage-chart"></div>
          </div>
          <div class="sb-chart-container">
            <h3>💰 Тренд витрат</h3>
            <div id="sb-expense-chart"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  serviceBookOverlay = overlay;

  // Обробники
  const closeBtn = overlay.querySelector("#sb-close-btn") as HTMLButtonElement;
  closeBtn.addEventListener("click", closeServiceBook);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeServiceBook();
  });

  const searchInput = overlay.querySelector(
    "#sb-search-input",
  ) as HTMLInputElement;
  const searchBtn = overlay.querySelector(
    "#sb-search-btn",
  ) as HTMLButtonElement;

  searchBtn.addEventListener("click", () => performSearch(searchInput.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") performSearch(searchInput.value);
  });

  // Табс
  overlay.querySelectorAll(".sb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = (tab as HTMLElement).dataset.tab;
      switchTab(tabName || "history");
    });
  });

  // Авто-фокус
  setTimeout(() => searchInput.focus(), 100);
}

function closeServiceBook(): void {
  clearServiceHistoryCache();
  clearServiceSearchCache();
  serviceBookHistoryGeneration++;
  serviceBookSearchGeneration++;
  serviceBookSearchPending = false;
  if (serviceBookOverlay) {
    serviceBookOverlay.style.display = "none";
  }
  destroyCharts();
}

function switchTab(tabName: string): void {
  if (!serviceBookOverlay) return;

  serviceBookOverlay.querySelectorAll(".sb-tab").forEach((t) => {
    t.classList.toggle(
      "sb-tab-active",
      (t as HTMLElement).dataset.tab === tabName,
    );
  });

  const historyTab = serviceBookOverlay.querySelector(
    "#sb-tab-history",
  ) as HTMLElement;
  const chartsTab = serviceBookOverlay.querySelector(
    "#sb-tab-charts",
  ) as HTMLElement;

  if (tabName === "history") {
    historyTab.style.display = "";
    chartsTab.style.display = "none";
  } else {
    historyTab.style.display = "none";
    chartsTab.style.display = "";
  }
}

// ===================== ПОШУК =====================

let serviceBookSearchGeneration = 0;
let serviceBookSearchPending = false;
let serviceBookActiveQuery = "";

async function performSearch(query: string, after: number | null = null): Promise<void> {
  const q = query.trim();
  if (!q) return;
  const queryKey = JSON.stringify([q, after]);
  if (serviceBookSearchPending && serviceBookActiveQuery === queryKey) return;
  serviceBookActiveQuery = queryKey;
  const generation = ++serviceBookSearchGeneration;

  const resultsContainer = serviceBookOverlay?.querySelector(
    "#sb-search-results",
  ) as HTMLElement;
  if (!resultsContainer) return;

  resultsContainer.innerHTML = `<div class="sb-loading">⏳ Пошук...</div>`;

  try {
    serviceBookSearchPending = true;
    let matches: CarRecord[] = [];
    const clientMap = new Map<number, ClientRecord>();
    let hasMore = false;
    let nextCursor: number | null = null;
    const page = await readServiceSearchPage(q, after);
    if (generation !== serviceBookSearchGeneration) return;
    for (const item of page.items) {
      matches.push(item.car as CarRecord);
      clientMap.set(item.client.client_id, item.client as ClientRecord);
    }
    hasMore = page.has_more;
    nextCursor = page.next_cursor;
    if (generation !== serviceBookSearchGeneration || !resultsContainer.isConnected) return;

    if (matches.length === 0) {
      resultsContainer.innerHTML = `<div class="sb-no-results">Нічого не знайдено за запитом «${escapeHtml(q)}»</div>`;
      return;
    }

    resultsContainer.innerHTML = matches
      .slice(0, 20)
      .map((car) => {
        const d = car.data || {};
        const client = clientMap.get(car.client_id);
        const pib = client?.data?.ПІБ || "—";
        const plate = d["Номер авто"] || "—";
        const carName = d.Авто || "Невідоме авто";
        const year = d.Рік || "";

        return `
          <div class="sb-search-item" data-car-id="${car.cars_id}">
            <div class="sb-search-item-car">🚗 ${escapeHtml(carName)} ${year ? `(${year})` : ""}</div>
            <div class="sb-search-item-info">
              <span>🔢 ${escapeHtml(plate)}</span>
              <span>👤 ${escapeHtml(pib)}</span>
            </div>
          </div>
        `;
      })
      .join("");

    if (hasMore && nextCursor !== null) {
      const nextButton = document.createElement("button");
      nextButton.type = "button";
      nextButton.textContent = "Наступні результати →";
      nextButton.addEventListener("click", () => {
        if (!serviceBookSearchPending) void performSearch(q, nextCursor);
      });
      resultsContainer.appendChild(nextButton);
    }

    // Кліки по результатам
    resultsContainer.querySelectorAll(".sb-search-item").forEach((el) => {
      el.addEventListener("click", () => {
        const carId = Number((el as HTMLElement).dataset.carId);
        const car = matches.find((c) => c.cars_id === carId);
        const client = car ? clientMap.get(car.client_id) : undefined;
        if (car) {
          selectCar(car, client || null);
        }
      });
    });
  } catch (err: any) {
    if (generation !== serviceBookSearchGeneration || !resultsContainer.isConnected) return;
    resultsContainer.innerHTML = `<div class="sb-error">❌ Помилка пошуку: ${escapeHtml(err.message)}</div>`;
  } finally {
    if (generation === serviceBookSearchGeneration) serviceBookSearchPending = false;
  }
}

// ===================== ВИБІР АВТО =====================

async function selectCar(
  car: CarRecord,
  client: ClientRecord | null,
): Promise<void> {
  const searchSection = serviceBookOverlay?.querySelector(
    "#sb-search-section",
  ) as HTMLElement;
  const content = serviceBookOverlay?.querySelector(
    "#sb-content",
  ) as HTMLElement;

  if (searchSection) searchSection.style.display = "none";
  if (content) content.style.display = "";

  // Кнопка "Назад"
  const header = serviceBookOverlay?.querySelector(".sb-header") as HTMLElement;
  if (header && !header.querySelector(".sb-back-btn")) {
    const backBtn = document.createElement("button");
    backBtn.className = "sb-back-btn";
    backBtn.textContent = "← Пошук";
    backBtn.addEventListener("click", () => {
      serviceBookHistoryGeneration++;
      if (searchSection) searchSection.style.display = "";
      if (content) content.style.display = "none";
      backBtn.remove();
      destroyCharts();
    });
    header.prepend(backBtn);
  }

  const selection = ++serviceBookHistoryGeneration;
  renderCarCard(car, client);
  await loadAndRenderHistory(car);
  if (selection !== serviceBookHistoryGeneration) return;

  // VIN-декодер
  const vin = car.data?.Vincode || "";
  if (isValidVin(vin)) {
    renderVinDecoder(vin, car);
  } else {
    const vinSection = serviceBookOverlay?.querySelector(
      "#sb-vin-section",
    ) as HTMLElement;
    if (vinSection) vinSection.style.display = "none";
  }
}

// ===================== КАРТКА АВТО =====================

function renderCarCard(car: CarRecord, client: ClientRecord | null): void {
  const container = serviceBookOverlay?.querySelector(
    "#sb-car-card",
  ) as HTMLElement;
  if (!container) return;

  const d = car.data || {};
  const pib = client?.data?.ПІБ || "—";
  const phone = client?.data?.Телефон || "";

  container.innerHTML = `
    <div class="sb-card-header">
      <div class="sb-card-title">🚗 ${escapeHtml(d.Авто || "Невідоме авто")}</div>
      <div class="sb-card-year">${d.Рік || ""}</div>
    </div>
    <div class="sb-card-grid">
      <div class="sb-card-field">
        <span class="sb-card-label">Номер</span>
        <span class="sb-card-value">${escapeHtml(d["Номер авто"] || "—")}</span>
      </div>
      <div class="sb-card-field">
        <span class="sb-card-label">VIN</span>
        <span class="sb-card-value sb-vin-value">${escapeHtml(d.Vincode || "—")}</span>
      </div>
      <div class="sb-card-field">
        <span class="sb-card-label">Двигун</span>
        <span class="sb-card-value">${escapeHtml(d.Обʼєм || "—")} ${escapeHtml(d.Пальне || "")}</span>
      </div>
      <div class="sb-card-field">
        <span class="sb-card-label">Код ДВЗ</span>
        <span class="sb-card-value">${escapeHtml(d.КодДВЗ || "—")}</span>
      </div>
      <div class="sb-card-field">
        <span class="sb-card-label">Власник</span>
        <span class="sb-card-value">👤 ${escapeHtml(pib)}</span>
      </div>
      ${
        phone
          ? `
      <div class="sb-card-field">
        <span class="sb-card-label">Телефон</span>
        <span class="sb-card-value">📞 ${escapeHtml(phone)}</span>
      </div>
      `
          : ""
      }
    </div>
  `;
}

// ===================== VIN-ДЕКОДЕР =====================

async function renderVinDecoder(vin: string, car: CarRecord): Promise<void> {
  const section = serviceBookOverlay?.querySelector(
    "#sb-vin-section",
  ) as HTMLElement;
  if (!section) return;

  section.style.display = "";
  section.innerHTML = `
    <div class="sb-vin-header">
      <span>🔍 VIN-декодер</span>
      <button class="sb-btn sb-btn-small" id="sb-vin-decode-btn">Декодувати VIN</button>
    </div>
    <div id="sb-vin-result" class="sb-vin-result"></div>
  `;

  const decodeBtn = section.querySelector(
    "#sb-vin-decode-btn",
  ) as HTMLButtonElement;
  decodeBtn.addEventListener("click", async () => {
    const resultDiv = section.querySelector("#sb-vin-result") as HTMLElement;
    resultDiv.innerHTML = `<span class="sb-loading-inline">⏳ Декодування...</span>`;
    decodeBtn.disabled = true;

    const decoded = await decodeVin(vin);
    decodeBtn.disabled = false;

    if (decoded.errorText && !decoded.make) {
      resultDiv.innerHTML = `<div class="sb-vin-error">⚠️ ${escapeHtml(decoded.errorText)}</div>`;
      return;
    }

    resultDiv.innerHTML = `
      <div class="sb-vin-grid">
        ${vinField("Марка", decoded.make)}
        ${vinField("Модель", decoded.model)}
        ${vinField("Рік", decoded.year)}
        ${vinField("Двигун", decoded.engineSize)}
        ${vinField("Пальне", decoded.fuelType)}
        ${vinField("Кузов", decoded.bodyType)}
        ${vinField("Привід", decoded.driveType)}
        ${vinField("КПП", decoded.transmission)}
        ${vinField("Код двигуна", decoded.engineCode)}
      </div>
      ${decoded.errorText ? `<div class="sb-vin-warning">⚠️ ${escapeHtml(decoded.errorText)}</div>` : ""}
      <button class="sb-btn sb-btn-small sb-btn-autofill" id="sb-vin-autofill">✨ Автозаповнити картку</button>
    `;

    // Автозаповнення
    const autofillBtn = resultDiv.querySelector(
      "#sb-vin-autofill",
    ) as HTMLButtonElement;
    autofillBtn.addEventListener("click", () => applyVinData(car, decoded));
  });
}

function vinField(label: string, value: string): string {
  if (!value) return "";
  return `
    <div class="sb-vin-field">
      <span class="sb-vin-label">${escapeHtml(label)}</span>
      <span class="sb-vin-value">${escapeHtml(value)}</span>
    </div>
  `;
}

async function applyVinData(
  car: CarRecord,
  decoded: VinDecodedInfo,
): Promise<void> {
  try {
    // Search results can be cached. Read a fresh write baseline only for this
    // explicit edit, and do not overwrite concurrent changes to the car.
    const { data: fresh, error: readError } = await supabase.from("cars")
      .select("cars_id, data").eq("cars_id", car.cars_id).single();
    if (readError) throw readError;
    if (!fresh) throw new Error("Автомобіль не знайдено.");
    const currentData = typeof fresh.data === "string" ? JSON.parse(fresh.data) : fresh.data ?? {};
    if (!currentData || typeof currentData !== "object" || Array.isArray(currentData))
      throw new Error("Некоректні дані автомобіля. Збереження зупинено.");
    const updatedData: Record<string, any> = { ...currentData };

    // Автозаповнення тільки порожніх полів
    if (!updatedData.Авто && decoded.make && decoded.model) {
      updatedData.Авто = `${decoded.make} ${decoded.model}`;
    }
    if (!updatedData.Рік && decoded.year) {
      updatedData.Рік = parseInt(decoded.year) || decoded.year;
    }
    if (!updatedData.Обʼєм && decoded.engineSize) {
      updatedData.Обʼєм = decoded.engineSize;
    }
    if (!updatedData.Пальне && decoded.fuelType) {
      updatedData.Пальне = decoded.fuelType;
    }
    if (!updatedData.КодДВЗ && decoded.engineCode) {
      updatedData.КодДВЗ = decoded.engineCode;
    }

    let update = supabase
      .from("cars")
      .update({ data: updatedData })
      .eq("cars_id", car.cars_id);
    update = fresh.data == null ? update.is("data", null)
      : update.eq("data", JSON.stringify(fresh.data));
    const { data: saved, error } = await update.select("cars_id");

    if (error) throw error;
    if (saved?.length !== 1) {
      clearServiceSearchCache();
      throw new Error("Дані автомобіля змінилися. Повторіть пошук перед збереженням.");
    }

    clearServiceSearchCache();
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:car-saved", { detail: { carId: car.cars_id } }));
    // Оновити локальний обʼєкт
    car.data = updatedData as CarRecord["data"];

    showNotification("Дані авто оновлено з VIN-декодера", "success");

    // Перемалювати картку
    renderCarCard(car, null);
  } catch (err: any) {
    showNotification(`Помилка збереження: ${err.message}`, "error");
  }
}

// ===================== ХРОНОЛОГІЯ =====================

async function loadAndRenderHistory(car: CarRecord): Promise<void> {
  const historyTab = serviceBookOverlay?.querySelector(
    "#sb-tab-history",
  ) as HTMLElement;
  if (!historyTab) return;

  const historyGeneration = serviceBookHistoryGeneration;
  historyTab.innerHTML = `<div class="sb-loading">⏳ Завантаження історії...</div>`;

  try {
    const generation = serviceBookHistoryGeneration;
    const isCurrent = () => generation === serviceBookHistoryGeneration && historyTab.isConnected;
    const [firstPage, summary] = await Promise.all([
      readServiceHistoryPage(car.cars_id, null), readServiceHistorySummary(car.cars_id, isCurrent),
    ]);
    if (!isCurrent()) return;
    const entries = summary.map(parseActToHistory).filter(Boolean) as ServiceHistoryEntry[];
    const visits = firstPage.items.map(parseActToHistory).filter(Boolean) as ServiceHistoryEntry[];
    let cursor: HistoryCursor | null = firstPage.has_more ? firstPage.next_cursor : null;

    if (entries.length === 0) {
      historyTab.innerHTML = `<div class="sb-no-data">📭 Немає записів обслуговування для цього авто</div>`;
      renderCharts([]);
      return;
    }

    // Статистика
    const totalVisits = entries.length;
    const totalSpent = entries.reduce((s, e) => s + e.totalSum, 0);
    const lastMileage = entries.find((e) => e.mileage > 0)?.mileage || 0;
    const avgCheck = totalVisits > 0 ? Math.round(totalSpent / totalVisits) : 0;

    historyTab.innerHTML = `
      <div class="sb-stats">
        <div class="sb-stat">
          <div class="sb-stat-value">${totalVisits}</div>
          <div class="sb-stat-label">Візитів</div>
        </div>
        <div class="sb-stat">
          <div class="sb-stat-value">${formatMoney(totalSpent)}</div>
          <div class="sb-stat-label">Всього витрат</div>
        </div>
        <div class="sb-stat">
          <div class="sb-stat-value">${lastMileage > 0 ? formatNumber(lastMileage) + " км" : "—"}</div>
          <div class="sb-stat-label">Останній пробіг</div>
        </div>
        <div class="sb-stat">
          <div class="sb-stat-value">${formatMoney(avgCheck)}</div>
          <div class="sb-stat-label">Середній чек</div>
        </div>
      </div>

      <div class="sb-timeline">
        ${visits.map(renderTimelineEntry).join("")}
      </div>
    `;

    // Delegate once; rows appended by pagination use the same listeners.
    historyTab.onclick = async event => {
      const target = event.target as HTMLElement;
      const recommendation = target.closest<HTMLButtonElement>(".workshop-history-button");
      if (recommendation) {
        event.stopPropagation();
        try { const { openWorkshop } = await import("../workshop/workshopUI"); if (isCurrent()) await openWorkshop(Number(recommendation.dataset.actId), "recommendations"); }
        catch { if (isCurrent()) showNotification("Не вдалося відкрити рекомендації", "error"); }
        return;
      }
      const entry = target.closest<HTMLElement>(".sb-timeline-entry[data-act-id]");
      if (entry?.dataset.actId && isCurrent()) void showModal(Number(entry.dataset.actId), "client");
    };
    if (cursor) {
      const more = document.createElement("button");
      more.type = "button"; more.textContent = "Показати ще 50 візитів";
      more.onclick = async event => {
        event.stopPropagation();
        if (more.disabled || !cursor || !isCurrent()) return;
        more.disabled = true;
        try {
          const page = await readServiceHistoryPage(car.cars_id, cursor);
          if (!isCurrent()) return;
          const rows = page.items.map(parseActToHistory).filter(Boolean) as ServiceHistoryEntry[];
          historyTab.querySelector(".sb-timeline")?.insertAdjacentHTML("beforeend", rows.map(renderTimelineEntry).join(""));
          cursor = page.has_more ? page.next_cursor : null;
          more.hidden = !cursor;
        } catch (error: any) { if (isCurrent()) showNotification(error?.message || "Не вдалося завантажити візити", "error"); }
        finally { more.disabled = false; }
      };
      historyTab.appendChild(more);
    }

    // Графіки
    renderCharts(entries);
  } catch (err: any) {
    if (historyGeneration !== serviceBookHistoryGeneration) return;
    historyTab.innerHTML = `<div class="sb-error">❌ Помилка: ${escapeHtml(err.message)}</div>`;
  }
}

function parseActToHistory(act: ActRecord): ServiceHistoryEntry | null {
  const data =
    typeof act.data === "string" ? safeParseJSON(act.data) : act.data;
  if (!data) return null;

  const works = (data.Роботи || []).map((w: any) => ({
    name: w.Робота || "",
    qty: w.Кількість || 1,
    price: w.Ціна || 0,
  }));

  const details = (data.Деталі || []).map((d: any) => ({
    name: d.Деталь || "",
    qty: d.Кількість || 1,
    price: d.Ціна || 0,
  }));

  const totalWork =
    data["За роботу"] ||
    works.reduce((s: number, w: any) => s + w.price * w.qty, 0);
  const totalDetails =
    data["За деталі"] ||
    details.reduce((s: number, d: any) => s + d.price * d.qty, 0);

  return {
    actId: act.act_id,
    dateOn: act.date_on || "",
    dateOff: act.date_off || null,
    mileage: parseInt(data["Пробіг"]) || 0,
    works,
    details,
    totalWork,
    totalDetails,
    totalSum: totalWork + totalDetails,
    frozen: isActFrozen(act),
    recommendation: data["Рекомендації"] || "",
    recommendationSummary: (() => {
      try { return readWorkshop(data).recommendations.map(r => `${recommendationStates[r.state] || "Невідомий стан"}: ${r.text}`).join("\n"); }
      catch { return "Не вдалося прочитати стани рекомендацій."; }
    })(),
    reason: data["Причина звернення"] || "",
  };
}

function renderTimelineEntry(entry: ServiceHistoryEntry): string {
  const dateOn = formatDateShort(entry.dateOn);
  const dateOff = entry.dateOff ? formatDateShort(entry.dateOff) : null;
  const isClosed = !!entry.dateOff;

  return `
    <div class="sb-timeline-entry ${entry.frozen ? "sb-frozen" : ""} ${isClosed ? "sb-closed" : "sb-open"}" 
         data-act-id="${entry.actId}" title="Натисніть щоб відкрити акт №${entry.actId}">
      <div class="sb-timeline-dot ${isClosed ? "sb-dot-closed" : "sb-dot-open"}"></div>
      <div class="sb-timeline-card">
        <div class="sb-timeline-header">
          <div class="sb-timeline-date">
            📅 ${dateOn}${dateOff ? ` → ${dateOff}` : " (відкритий)"}
          </div>
          <div class="sb-timeline-act">Акт №${entry.actId}</div>
          ${entry.mileage > 0 ? `<div class="sb-timeline-mileage">🏎️ ${formatNumber(entry.mileage)} км</div>` : ""}
          ${entry.frozen ? `<span class="sb-badge-frozen">❄️</span>` : ""}
        </div>

        ${entry.reason ? `<div class="sb-timeline-reason">💬 ${escapeHtml(entry.reason)}</div>` : ""}

        ${
          entry.works.length > 0
            ? `
        <div class="sb-timeline-section">
          <div class="sb-timeline-section-title">🔧 Роботи</div>
          <div class="sb-timeline-items">
            ${entry.works
              .map(
                (w) => `
              <div class="sb-timeline-item">
                <span>${escapeHtml(w.name)}</span>
                <span>${w.qty > 1 ? `${w.qty}×` : ""}${formatMoney(w.price)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>`
            : ""
        }

        ${
          entry.details.length > 0
            ? `
        <div class="sb-timeline-section">
          <div class="sb-timeline-section-title">📦 Деталі</div>
          <div class="sb-timeline-items">
            ${entry.details
              .map(
                (d) => `
              <div class="sb-timeline-item">
                <span>${escapeHtml(d.name)}</span>
                <span>${d.qty > 1 ? `${d.qty}×` : ""}${formatMoney(d.price)}</span>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>`
            : ""
        }

        <div class="sb-timeline-footer">
          <span>🔧 ${formatMoney(entry.totalWork)}</span>
          <span>📦 ${formatMoney(entry.totalDetails)}</span>
          <span class="sb-timeline-total">Σ ${formatMoney(entry.totalSum)}</span>
        </div>

        ${entry.recommendation ? `<div class="sb-timeline-rec">💡 ${escapeHtml(entry.recommendation)}</div>` : ""}
        ${entry.recommendationSummary ? `<div class="sb-timeline-rec" style="white-space:pre-wrap">${escapeHtml(entry.recommendationSummary)}</div>` : ""}
        <button type="button" class="workshop-history-button" data-act-id="${entry.actId}">💡 Стани рекомендацій</button>
      </div>
    </div>
  `;
}

// ===================== ГРАФІКИ =====================

function renderCharts(entries: ServiceHistoryEntry[]): void {
  destroyCharts();

  // Сортуємо по даті (від старих до нових)
  const sorted = [...entries]
    .filter((e) => e.dateOn)
    .sort(
      (a, b) => new Date(a.dateOn).getTime() - new Date(b.dateOn).getTime(),
    );

  if (sorted.length < 2) {
    const chartsTab = serviceBookOverlay?.querySelector(
      "#sb-tab-charts",
    ) as HTMLElement;
    if (chartsTab) {
      chartsTab.innerHTML = `<div class="sb-no-data">📊 Потрібно мінімум 2 записи для побудови графіків</div>`;
    }
    return;
  }

  renderMileageChart(sorted);
  renderExpenseTrendChart(sorted);
}

function renderMileageChart(entries: ServiceHistoryEntry[]): void {
  const container = serviceBookOverlay?.querySelector(
    "#sb-mileage-chart",
  ) as HTMLElement;
  if (!container) return;

  const withMileage = entries.filter((e) => e.mileage > 0);

  if (withMileage.length < 2) {
    container.innerHTML = `<div class="sb-no-data">Недостатньо записів з пробігом</div>`;
    return;
  }

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "line",
      height: 280,
      toolbar: { show: false },
      zoom: { enabled: false },
      background: "transparent",
    },
    series: [
      {
        name: "Пробіг (км)",
        data: withMileage.map((e) => ({
          x: new Date(e.dateOn).getTime(),
          y: e.mileage,
        })),
      },
    ],
    xaxis: {
      type: "datetime",
      labels: {
        format: "dd.MM.yy",
        style: { colors: "#888" },
      },
    },
    yaxis: {
      labels: {
        formatter: (v: number) => formatNumber(Math.round(v)),
        style: { colors: ["#888"] },
      },
      title: { text: "км", style: { color: "#888" } },
    },
    stroke: { curve: "smooth", width: 3 },
    colors: ["#3b82f6"],
    markers: { size: 5, hover: { size: 7 } },
    tooltip: {
      x: { format: "dd.MM.yyyy" },
      y: { formatter: (v: number) => `${formatNumber(v)} км` },
    },
    theme: { mode: "dark" },
    grid: { borderColor: "#333" },
  };

  mileageChart = new ApexCharts(container, options);
  mileageChart.render();
}

function renderExpenseTrendChart(entries: ServiceHistoryEntry[]): void {
  const container = serviceBookOverlay?.querySelector(
    "#sb-expense-chart",
  ) as HTMLElement;
  if (!container) return;

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "bar",
      height: 280,
      toolbar: { show: false },
      background: "transparent",
      stacked: true,
    },
    series: [
      {
        name: "Роботи",
        data: entries.map((e) => ({
          x: new Date(e.dateOn).getTime(),
          y: e.totalWork,
        })),
      },
      {
        name: "Деталі",
        data: entries.map((e) => ({
          x: new Date(e.dateOn).getTime(),
          y: e.totalDetails,
        })),
      },
    ],
    xaxis: {
      type: "datetime",
      labels: {
        format: "dd.MM.yy",
        style: { colors: "#888" },
      },
    },
    yaxis: {
      labels: {
        formatter: (v: number) => formatMoney(Math.round(v)),
        style: { colors: ["#888"] },
      },
      title: { text: "грн", style: { color: "#888" } },
    },
    colors: ["#10b981", "#f59e0b"],
    plotOptions: {
      bar: { borderRadius: 4, columnWidth: "60%" },
    },
    tooltip: {
      x: { format: "dd.MM.yyyy" },
      y: { formatter: (v: number) => formatMoney(v) },
    },
    legend: {
      position: "top",
      labels: { colors: "#888" },
    },
    theme: { mode: "dark" },
    grid: { borderColor: "#333" },
  };

  expenseTrendChart = new ApexCharts(container, options);
  expenseTrendChart.render();
}

function destroyCharts(): void {
  if (mileageChart) {
    mileageChart.destroy();
    mileageChart = null;
  }
  if (expenseTrendChart) {
    expenseTrendChart.destroy();
    expenseTrendChart = null;
  }
}

// ===================== УТИЛІТИ =====================

function safeParseJSON(data: any): any {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data;
}

function formatDateShort(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1)
      .toString()
      .padStart(2, "0")}.${d.getFullYear().toString().slice(-2)}`;
  } catch {
    return iso;
  }
}

function formatNumber(val: number): string {
  return Math.floor(val)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatMoney(val: number): string {
  return formatNumber(Math.round(val)) + " ₴";
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
