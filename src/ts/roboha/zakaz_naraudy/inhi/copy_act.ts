// src/ts/roboha/zakaz_naraudy/inhi/copy_act.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Створити схожий акт" — вибір клієнта → вибір авто → копіює роботи/деталі
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../../../vxid/supabaseClient";
import { showNotification } from "./vspluvauhe_povidomlenna";
import { logAction } from "../../../utils/auditLogger";
import { refreshActsTable } from "../../tablucya/tablucya";
import { showModal } from "../modalMain";
import { closeZakazNaraydModal } from "../modalUI";
import {
  getSavedUserDataFromLocalStorage,
  userAccessLevel,
} from "../../tablucya/users";

// ── Час ────────────────────────────────────────────────────────────────────
function getCurrentDateTimeLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ── Інтерфейси ─────────────────────────────────────────────────────────────
interface ClientRow {
  client_id: number;
  data: any;
}
interface CarRow {
  cars_id: number;
  data: any;
}

// ── Глобальний стан модалки вибору ─────────────────────────────────────────
let _selectedClientId: number | null = null;
let _selectedCarId: number | null = null;
let _allClients: ClientRow[] = [];

// ── Завантажити клієнтів з кешу або БД ────────────────────────────────────
async function loadClients(): Promise<ClientRow[]> {
  if (_allClients.length > 0) return _allClients;
  const { data } = await supabase
    .from("clients")
    .select("client_id, data")
    .order("client_id", { ascending: false });
  _allClients = (data || []) as ClientRow[];
  return _allClients;
}

// ── Загрузити авто конкретного клієнта ─────────────────────────────────────
async function loadCarsForClient(clientId: number): Promise<CarRow[]> {
  const { data } = await supabase
    .from("cars")
    .select("cars_id, data")
    .eq("client_id", clientId)
    .not("is_deleted", "is", true)
    .order("cars_id", { ascending: false });
  return (data || []) as CarRow[];
}

// ── Отримати назву клієнта ─────────────────────────────────────────────────
function clientName(c: ClientRow): string {
  const d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
  return (d?.["ПІБ"] || `Клієнт #${c.client_id}`).trim();
}

// ── Отримати назву авто ────────────────────────────────────────────────────
function carLabel(car: CarRow): string {
  const d = typeof car.data === "string" ? JSON.parse(car.data) : car.data;
  const auto = d?.["Авто"] || "";
  const nomer = d?.["Номер авто"] || "";
  const year = d?.["Рік"] || "";
  return (
    [auto, year, nomer].filter(Boolean).join(" · ") || `Авто #${car.cars_id}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// МОДАЛКА ВИБОРУ КЛІЄНТА + АВТО
// ══════════════════════════════════════════════════════════════════════════════
function buildPickerModal(): { el: HTMLElement; destroy: () => void } {
  document.getElementById("copy-act-picker-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "copy-act-picker-modal";
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:10200;
    background:rgba(0,0,0,0.55);
    display:flex; align-items:center; justify-content:center;
    animation:fadeIn .15s ease;
  `;

  overlay.innerHTML = `
    <div id="copy-picker-box" style="
      background:#fff; border-radius:16px;
      width:460px; max-width:95vw; max-height:85vh;
      display:flex; flex-direction:column;
      box-shadow:0 12px 50px rgba(0,0,0,0.3);
      overflow:hidden;
    ">
      <!-- Хедер -->
      <div style="
        background:linear-gradient(135deg,#177245,#0f5132);
        padding:18px 24px; color:#fff;
        display:flex; align-items:center; justify-content:space-between;
      ">
        <div>
          <div style="font-size:20px; font-weight:700;">📋 Схожий акт</div>
          <div style="font-size:12px; opacity:.8; margin-top:2px;">
            Роботи і деталі перенесуться до нового акту
          </div>
        </div>
        <button id="copy-picker-close" style="
          background:rgba(255,255,255,.15); border:none; color:#fff;
          width:32px; height:32px; border-radius:50%; font-size:18px;
          cursor:pointer; display:flex; align-items:center; justify-content:center;
        ">×</button>
      </div>

      <!-- Крок 1: пошук клієнта -->
      <div id="copy-step-client" style="padding:20px 24px; flex:1; overflow-y:auto;">
        <div style="font-size:13px; color:#555; margin-bottom:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;">
          Крок 1 — Оберіть клієнта
        </div>
        <div style="position:relative;">
          <input id="copy-client-search" type="text"
            placeholder="🔍 Пошук по ПІБ або телефону..."
            style="
              width:100%; box-sizing:border-box;
              padding:10px 14px; border-radius:10px;
              border:1.5px solid #ddd; font-size:14px;
              outline:none; transition:border .2s;
            "
          />
        </div>
        <div id="copy-client-list" style="
          margin-top:8px; max-height:320px; overflow-y:auto;
          border:1px solid #eee; border-radius:10px;
        "></div>
      </div>

      <!-- Крок 2: вибір авто (прихований спочатку) -->
      <div id="copy-step-car" style="padding:20px 24px; display:none; flex:1; overflow-y:auto;">
        <button id="copy-back-to-client" style="
          background:none; border:none; color:#177245;
          font-size:13px; cursor:pointer; margin-bottom:12px;
          display:flex; align-items:center; gap:4px; padding:0;
        ">← Назад до клієнтів</button>
        <div style="font-size:13px; color:#555; margin-bottom:10px; font-weight:600; text-transform:uppercase; letter-spacing:.5px;">
          Крок 2 — Оберіть авто
        </div>
        <div id="copy-client-name-display" style="
          padding:10px 14px; background:#f0f9f4; border-radius:8px;
          color:#177245; font-weight:600; margin-bottom:12px; font-size:14px;
        "></div>
        <div id="copy-car-list" style="
          max-height:280px; overflow-y:auto;
          border:1px solid #eee; border-radius:10px;
        "></div>
        <div id="copy-no-cars" style="display:none; text-align:center; padding:20px; color:#888; font-size:14px;">
          😔 У цього клієнта немає авто.<br>
          <button id="copy-create-anyway" style="
            margin-top:12px; padding:8px 20px; border-radius:8px;
            background:#177245; color:#fff; border:none; cursor:pointer;
            font-size:14px; font-weight:600;
          ">Все одно створити акт</button>
        </div>
      </div>

      <!-- Кнопка підтвердження (показується після вибору авто) -->
      <div id="copy-footer" style="
        display:none; padding:14px 24px;
        border-top:1px solid #eee;
        display:none; flex-direction:column; gap:10px;
        background:#fafafa;
      ">
        <div id="copy-summary" style="font-size:13px; color:#555; line-height:1.5;"></div>
        <button id="copy-confirm-final" style="
          padding:12px; border-radius:10px; border:none;
          background:linear-gradient(135deg,#177245,#0f5132);
          color:#fff; font-size:15px; font-weight:700;
          cursor:pointer; transition:opacity .2s;
        ">✅ Створити схожий акт</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const destroy = () => overlay.remove();
  return { el: overlay, destroy };
}

// ── Рендер списку клієнтів ─────────────────────────────────────────────────
function renderClientList(clients: ClientRow[], query: string): void {
  const list = document.getElementById("copy-client-list")!;
  const q = query.toLowerCase().trim();

  const filtered = clients
    .filter((c) => {
      const name = clientName(c).toLowerCase();
      const d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
      const phone = (d?.["Телефон"] || "").toLowerCase();
      return !q || name.includes(q) || phone.includes(q);
    })
    .slice(0, 50);

  if (filtered.length === 0) {
    list.innerHTML = `<div style="padding:20px; text-align:center; color:#888; font-size:14px;">Нічого не знайдено</div>`;
    return;
  }

  list.innerHTML = filtered
    .map((c) => {
      const d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
      const name = clientName(c);
      const phone = d?.["Телефон"] || "";
      return `
      <div class="copy-client-item" data-id="${c.client_id}" style="
        padding:12px 16px; cursor:pointer; border-bottom:1px solid #f0f0f0;
        transition:background .15s;
      ">
        <div style="font-weight:600; font-size:14px; color:#1a1a2e;">${name}</div>
        ${phone ? `<div style="font-size:12px; color:#177245; margin-top:2px;">${phone}</div>` : ""}
      </div>
    `;
    })
    .join("");
}

// ── Рендер списку авто ─────────────────────────────────────────────────────
function renderCarList(cars: CarRow[]): void {
  const list = document.getElementById("copy-car-list")!;
  const noCars = document.getElementById("copy-no-cars")!;

  if (cars.length === 0) {
    list.style.display = "none";
    noCars.style.display = "block";
    return;
  }

  noCars.style.display = "none";
  list.style.display = "block";

  list.innerHTML = cars
    .map((car) => {
      const label = carLabel(car);
      return `
      <div class="copy-car-item" data-id="${car.cars_id}" style="
        padding:12px 16px; cursor:pointer; border-bottom:1px solid #f0f0f0;
        transition:background .15s; display:flex; align-items:center; gap:10px;
      ">
        <span style="font-size:22px;">🚗</span>
        <span style="font-weight:600; font-size:14px; color:#1a1a2e;">${label}</span>
      </div>
    `;
    })
    .join("");
}

// ══════════════════════════════════════════════════════════════════════════════
// ГОЛОВНА ФУНКЦІЯ — відкрити модалку вибору клієнта
// ══════════════════════════════════════════════════════════════════════════════
export async function openCopyActPicker(sourceActId: number): Promise<void> {
  _selectedClientId = null;
  _selectedCarId = null;

  showNotification("⏳ Завантажую клієнтів...", "info", 1500);
  const clients = await loadClients();

  const { el, destroy } = buildPickerModal();

  const stepClient = el.querySelector<HTMLElement>("#copy-step-client")!;
  const stepCar = el.querySelector<HTMLElement>("#copy-step-car")!;
  const footer = el.querySelector<HTMLElement>("#copy-footer")!;
  const searchInput = el.querySelector<HTMLInputElement>(
    "#copy-client-search",
  )!;
  const clientList = el.querySelector<HTMLElement>("#copy-client-list")!;
  const carList = el.querySelector<HTMLElement>("#copy-car-list")!;
  const clientNameEl = el.querySelector<HTMLElement>(
    "#copy-client-name-display",
  )!;
  const summaryEl = el.querySelector<HTMLElement>("#copy-summary")!;

  // Hover ефекти через CSS-клас
  const style = document.createElement("style");
  style.textContent = `
    .copy-client-item:hover { background:#f0f9f4 !important; }
    .copy-car-item:hover    { background:#f0f9f4 !important; }
    #copy-client-search:focus { border-color:#177245 !important; }
  `;
  document.head.appendChild(style);

  // Початковий рендер
  renderClientList(clients, "");

  // ── Пошук ────────────────────────────────────────────────────────────────
  searchInput.addEventListener("input", () => {
    renderClientList(clients, searchInput.value);
  });

  // ── Вибір клієнта ─────────────────────────────────────────────────────────
  clientList.addEventListener("click", async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(
      ".copy-client-item",
    );
    if (!item) return;

    _selectedClientId = Number(item.dataset.id);
    const client = clients.find((c) => c.client_id === _selectedClientId);
    if (!client) return;

    // Перехід до кроку 2
    stepClient.style.display = "none";
    stepCar.style.display = "block";
    clientNameEl.textContent = `👤 ${clientName(client)}`;

    // Завантажуємо авто
    const cars = await loadCarsForClient(_selectedClientId!);
    renderCarList(cars);
  });

  // ── Повернутись до клієнтів ───────────────────────────────────────────────
  el.querySelector("#copy-back-to-client")!.addEventListener("click", () => {
    _selectedClientId = null;
    _selectedCarId = null;
    stepCar.style.display = "none";
    stepClient.style.display = "block";
    footer.style.display = "none";
  });

  // ── Вибір авто ────────────────────────────────────────────────────────────
  carList.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(
      ".copy-car-item",
    );
    if (!item) return;

    _selectedCarId = Number(item.dataset.id);

    // Підсвітити вибрану
    carList.querySelectorAll(".copy-car-item").forEach((el) => {
      (el as HTMLElement).style.background = "";
    });
    item.style.background = "#e8f5e9";

    // Показати футер
    const client = clients.find((c) => c.client_id === _selectedClientId);
    const carText = item.querySelector("span:last-child")?.textContent || "";
    summaryEl.innerHTML = `
      <b>Клієнт:</b> ${client ? clientName(client) : "—"}<br>
      <b>Авто:</b> ${carText}
    `;
    footer.style.display = "flex";
  });

  // ── Створити без авто ──────────────────────────────────────────────────────
  el.querySelector("#copy-create-anyway")?.addEventListener("click", () => {
    _selectedCarId = null;
    const client = clients.find((c) => c.client_id === _selectedClientId);
    summaryEl.innerHTML = `<b>Клієнт:</b> ${client ? clientName(client) : "—"}<br><b>Авто:</b> не вказано`;
    footer.style.display = "flex";
  });

  // ── Фінальне створення ────────────────────────────────────────────────────
  el.querySelector("#copy-confirm-final")!.addEventListener(
    "click",
    async () => {
      if (!_selectedClientId) return;
      const btn = el.querySelector<HTMLButtonElement>("#copy-confirm-final")!;
      btn.disabled = true;
      btn.textContent = "⏳ Створюємо...";

      await createCopiedAct(sourceActId, _selectedClientId, _selectedCarId);
      destroy();
      style.remove();
    },
  );

  // ── Закрити ───────────────────────────────────────────────────────────────
  el.querySelector("#copy-picker-close")!.addEventListener("click", () => {
    destroy();
    style.remove();
  });
  el.addEventListener("click", (e) => {
    if (e.target === el) {
      destroy();
      style.remove();
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// СТВОРЕННЯ СКОПІЙОВАНОГО АКТУ
// ══════════════════════════════════════════════════════════════════════════════
async function createCopiedAct(
  sourceActId: number,
  clientId: number,
  carsId: number | null,
): Promise<void> {
  try {
    showNotification("⏳ Копіюємо акт...", "info", 2500);

    // 1) Читаємо дані джерельного акту
    const { data: sourceAct, error } = await supabase
      .from("acts")
      .select("data")
      .eq("act_id", sourceActId)
      .single();

    if (error || !sourceAct) {
      showNotification("❌ Помилка читання акту", "error");
      return;
    }

    const sd = sourceAct.data;

    // 2) Копіюємо Деталі (без recordId)
    const newDetails = (sd?.["Деталі"] || [])
      .filter((d: any) => d["Деталь"]?.trim())
      .map((d: any) => ({
        Деталь: d["Деталь"] || "",
        Магазин: d["Магазин"] || "",
        Кількість: d["Кількість"] || 0,
        Ціна: d["Ціна"] || 0,
        Сума: d["Сума"] || 0,
        Каталог: d["Каталог"] || "",
        sclad_id: d["sclad_id"] || null,
        detail_id: d["detail_id"] || null,
      }));

    // 3) Копіюємо Роботи (без recordId)
    const newWorks = (sd?.["Роботи"] || [])
      .filter((w: any) => w["Робота"]?.trim())
      .map((w: any) => ({
        Робота: w["Робота"] || "",
        Слюсар: w["Слюсар"] || "",
        Кількість: w["Кількість"] || 0,
        Ціна: w["Ціна"] || 0,
        Сума: w["Сума"] || 0,
        Каталог: w["Каталог"] || "",
        slyusar_id: w["slyusar_id"] || null,
        work_id: w["work_id"] || null,
      }));

    if (newDetails.length === 0) {
      newDetails.push({
        Деталь: "",
        Магазин: "",
        Кількість: 0,
        Ціна: 0,
        Сума: 0,
        Каталог: "",
        sclad_id: null,
        detail_id: null,
      });
    }
    if (newWorks.length === 0) {
      newWorks.push({
        Робота: "",
        Слюсар: "",
        Кількість: 0,
        Ціна: 0,
        Сума: 0,
        Каталог: "",
        slyusar_id: null,
        work_id: null,
      });
    }

    // Розраховуємо суми з скопійованих деталей та робіт
    const totalDetailsSum = newDetails.reduce(
      (sum: number, d: any) => sum + (Number(d["Сума"]) || 0),
      0,
    );
    const totalWorksSum = newWorks.reduce(
      (sum: number, w: any) => sum + (Number(w["Сума"]) || 0),
      0,
    );
    const grandTotalSum = totalDetailsSum + totalWorksSum;

    const newActData = {
      Деталі: newDetails,
      Роботи: newWorks,
      Пробіг: 0,
      "За деталі": totalDetailsSum,
      "За роботу": totalWorksSum,
      Приймальник: "",
      Рекомендації: sd?.["Рекомендації"] || "",
      Примітки: sd?.["Примітки"] || "",
      "Загальна сума": grandTotalSum,
      "Причина звернення": sd?.["Причина звернення"] || "",
      "Прибуток за деталі": 0,
      "Прибуток за роботу": 0,
      copied_from_act_id: sourceActId,
    };

    // 4) Вставляємо новий акт
    const { data: newAct, error: insertError } = await supabase
      .from("acts")
      .insert([
        {
          date_on: getCurrentDateTimeLocal(),
          client_id: clientId,
          cars_id: carsId,
          data: newActData,
          avans: 0,
        },
      ])
      .select("act_id")
      .single();

    if (insertError || !newAct) {
      showNotification("❌ Помилка створення акту", "error");
      return;
    }

    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId: newAct.act_id, affectedCarIds: [Number(carsId)] } }));

    // 5) Записуємо приймальника
    if (userAccessLevel !== "Слюсар") {
      const userData = getSavedUserDataFromLocalStorage?.();
      if (userData?.name) {
        await supabase
          .from("acts")
          .update({ pruimalnyk: userData.name })
          .eq("act_id", newAct.act_id);
      }
    }

    await logAction(
      "act_copy",
      newAct.act_id,
      { source_act_id: sourceActId, totalSum: grandTotalSum },
      "act",
    );

    // 6) Успіх → оновлюємо таблицю, відкриваємо новий акт
    showNotification(`✅ Акт №${newAct.act_id} створено!`, "success", 4000);

    // Закриваємо старий модал (акт-джерело) правильно через системну функцію
    await closeZakazNaraydModal();

    // Оновлюємо таблицю (зберігає поточний фільтр)
    await refreshActsTable();

    // Відкриваємо новий акт
    await showModal(newAct.act_id, "client");

    // Подальші зміни й нарахування підтверджуються кнопкою збереження
    // або закриття акта, без відкладеного збереження відкритої форми.
  } catch {
    showNotification("❌ Внутрішня помилка", "error");
  }
}

// ── Ініціалізація кнопки ───────────────────────────────────────────────────
export function initCopyActButton(actId: number): void {
  const btn = document.getElementById("copy-act-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    openCopyActPicker(actId);
  });
}
