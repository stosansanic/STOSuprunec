// src/ts/roboha/zakaz_naraudy/inhi/knopka_zamok.ts
import { supabase } from "../../../vxid/supabaseClient";
import { trackPayrollData, savePayrollData, fetchPayrollEmployees, payrollActorScope } from "../../../utils/payrollSafeWrite";
import { logAction } from "../../../utils/auditLogger";
import { showNotification } from "./vspluvauhe_povidomlenna";
import {
  showViknoPidtverdchennayZakruttiaAkty,
  checkForWarnings,
} from "./vikno_pidtverdchennay_zakruttia_akty";
import { showViknoVvodyParolu } from "./vikno_vvody_parolu";
import {
  globalCache,
  invalidateEditorActStaffHistory,
  invalidateEditorStockRows,
  ACT_ITEMS_TABLE_CONTAINER_ID,
  ZAKAZ_NARAYD_MODAL_ID,
  ZAKAZ_NARAYD_BODY_ID,
} from "../globalCache";
import { applyActStatusToTable } from "../../tablucya/tablucya";
import { isActWritePending, setActWritePending } from "../../../utils/actEditorGuard";
import { deleteActNotificationsOnClose } from "../../tablucya/mark_notification_deleted";
import {
  getSavedUserDataFromLocalStorage,
  userAccessLevel,
  canUserCloseActsNormal,
  canUserCloseActsWithWarnings,
  canUserOpenClosedActs,
  canSlusarCompleteTasks,
  userName,
} from "../../tablucya/users";
import { showSlusarConfirm } from "./vikno_slusar_confirm";
import { formatLocalDateTimeForDB } from "./formatuvannya_datu";

// Імпортуємо функцію показу модального вікна
import { applyActStatusToModal } from "../modalMain";

type ConfirmedActStatus = {
  payroll_pending?: boolean;
  date_off: string | null;
  date_on?: string | null;
  slusarsOn?: boolean;
  pruimalnyk?: string | null;
  frozen?: boolean;
  data?: any;
};
const ACT_STATUS_RECEIPT = 'act_id,date_on,date_off,slusarsOn,pruimalnyk,frozen:data->"Заморожений"';

type ActTransitionState = ConfirmedActStatus & { act_id: number; frozen: boolean; checksum: string; revision: string | null; total?: unknown; freeze_payroll_version?: number };
function assertTransitionActor(actor: string): void {
  if (actor !== payrollActorScope()) throw new Error("Користувач змінився під час зміни стану акту");
}
async function readActTransitionState(actId: number, actor: string): Promise<ActTransitionState> {
  assertTransitionActor(actor);
  const { data, error } = await supabase.rpc("traffic_act_transition_state", { p_act_id: actId });
  assertTransitionActor(actor);
  if (error) throw error;
  if (!data || Number(data.act_id) !== actId || typeof data.frozen !== "boolean" || !/^[a-f0-9]{32}$/.test(data.checksum || "")) {
    throw new Error("Не вдалося підтвердити стан акту");
  }
  return data;
}
async function commitActFrozen(act: ActTransitionState, frozen: boolean, actor: string): Promise<ConfirmedActStatus> {
  assertTransitionActor(actor);
  // Require the atomic stock/payroll migration before sending any status write.
  if (act.freeze_payroll_version !== 1) {
    throw new Error("Для замороження та розмороження встановіть SQL-файл act-freeze-payroll.sql, а потім повторіть дію.");
  }
  const revision = crypto.randomUUID();
  const { data, error } = await supabase.rpc("guarded_set_act_frozen", {
    p_act_id: act.act_id, p_frozen: frozen, p_checksum: act.checksum,
    p_revision: revision, p_lock_owner: userName || "",
  });
  assertTransitionActor(actor);
  if (error) throw error;
  if (!data || data.freeze_payroll_version !== 1 || Number(data.act_id) !== act.act_id || data.frozen !== frozen || typeof data.payroll_pending !== "boolean" ||
      !["updated", "unchanged"].includes(data.status) ||
      !(data.revision === revision || (data.status === "unchanged" && data.revision === act.revision)) ||
      !Array.isArray(data.stock_ids) || data.stock_ids.some((id: unknown) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error("Не вдалося підтвердити зміну стану акту");
  }
  invalidateEditorStockRows(data.stock_ids.map(Number));
  invalidateEditorActStaffHistory(act.act_id);
  if (data.status === "updated" && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId: act.act_id, revision } }));
  }
  return data;
}

// Reuse the confirmed write response. Status changes do not reopen the editor
// or reload its directories, customer, car and the whole acts page.
function applyConfirmedActStatus(actId: number, status: ConfirmedActStatus, currentModal: boolean): void {
  // Fence any earlier recovery read before its stale result can replace this receipt.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-status-committed", { detail: { actId } }));
  applyActStatusToTable(actId, status);
  if (currentModal) applyActStatusToModal(actId, status);
}

function holdActStatusWrite(): () => void {
  if (isActWritePending()) throw new Error("Зачекайте завершення збереження акту.");
  const body = document.getElementById(ZAKAZ_NARAYD_BODY_ID);
  const wasInert = body?.inert ?? false;
  setActWritePending(true);
  if (body) body.inert = true;
  return () => {
    if (body) body.inert = wasInert;
    setActWritePending(false);
  };
}

/* ======================== Локальні утиліти для синхронізації shops ======================== */



function cleanText(s?: string | null) {
  return (s ?? "").replace(/\u00A0/g, " ").trim();
}

function parseNum(s?: string | null) {
  const v = cleanText(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

function toISODateOnly(dt: string | Date | null | undefined): string | null {
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(+d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function collectDetailRowsFromDom(): Array<{
  shopName: string;
  sclad_id: number | null;
  Найменування: string;
  Каталог: string | null;
  Кількість: number;
  Ціна: number;
}> {
  const rows: Array<{
    shopName: string;
    sclad_id: number | null;
    Найменування: string;
    Каталог: string | null;
    Кількість: number;
    Ціна: number;
  }> = [];

  const tableRows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr`,
  );
  tableRows.forEach((tr) => {
    const nameCell = tr.querySelector(
      '[data-name="name"]',
    ) as HTMLElement | null;
    if (!nameCell) return;

    let type = nameCell.getAttribute("data-type");
    const name = cleanText(nameCell.textContent);
    if (!name) return;

    if (!type || (type !== "details" && type !== "works")) {
      const isInWorks = new Set(globalCache.works).has(name);
      const isInDetails = new Set(globalCache.details).has(name);
      type = isInWorks && !isInDetails ? "works" : "details";
      nameCell.setAttribute("data-type", type);
    }
    if (type !== "details") return;

    const qtyCell = tr.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    const priceCell = tr.querySelector(
      '[data-name="price"]',
    ) as HTMLElement | null;
    const catalogCell = tr.querySelector(
      '[data-name="catalog"]',
    ) as HTMLElement | null;
    const pibMagazinCell = tr.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement | null;

    const Каталог = cleanText(catalogCell?.textContent) || null;
    const Кількість = parseNum(qtyCell?.textContent);
    const Ціна = parseNum(priceCell?.textContent);
    const shopName = cleanText(pibMagazinCell?.textContent);

    const scladIdAttr = catalogCell?.getAttribute("data-sclad-id");
    const sclad_id = scladIdAttr ? Number(scladIdAttr) : null;

    // Добавляємо рядок незалежно від наявності магазину для валідації
    rows.push({
      shopName,
      sclad_id,
      Найменування: name,
      Каталог,
      Кількість,
      Ціна,
    });
  });

  return rows;
}

/** Зібрати з DOM рядки робіт (🛠️) з модального вікна */
function collectWorkRowsFromDom(): Array<{
  slyusarName: string;
  Найменування: string;
  Кількість: number;
  Ціна: number;
  Зарплата: number;
}> {
  const rows: Array<{
    slyusarName: string;
    Найменування: string;
    Кількість: number;
    Ціна: number;
    Зарплата: number;
  }> = [];

  const tableRows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr`,
  );
  tableRows.forEach((tr) => {
    const nameCell = tr.querySelector(
      '[data-name="name"]',
    ) as HTMLElement | null;
    if (!nameCell) return;

    let type = nameCell.getAttribute("data-type");
    const name = cleanText(nameCell.textContent);
    if (!name) return;

    if (!type || (type !== "details" && type !== "works")) {
      const isInWorks = new Set(globalCache.works).has(name);
      const isInDetails = new Set(globalCache.details).has(name);
      type = isInWorks && !isInDetails ? "works" : "details";
      nameCell.setAttribute("data-type", type);
    }
    if (type !== "works") return;

    const qtyCell = tr.querySelector(
      '[data-name="id_count"]',
    ) as HTMLElement | null;
    const priceCell = tr.querySelector(
      '[data-name="price"]',
    ) as HTMLElement | null;
    const slyusarSumCell = tr.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement | null;
    const pibMagazinCell = tr.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement | null;

    const Кількість = parseNum(qtyCell?.textContent);
    const Ціна = parseNum(priceCell?.textContent);
    const Зарплата = parseNum(slyusarSumCell?.textContent);
    const slyusarName = cleanText(pibMagazinCell?.textContent);

    // Добавляємо рядок незалежно від наявності слюсара для валідації
    rows.push({
      slyusarName,
      Найменування: name,
      Кількість,
      Ціна,
      Зарплата,
    });
  });

  return rows;
}

/** Валідація таблиці перед закриттям акту */
function validateActTableBeforeClosing(): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  const detailRows = collectDetailRowsFromDom();
  const workRows = collectWorkRowsFromDom();

  // Перевірка робіт (🛠️)
  for (const row of workRows) {
    const rowName = `"${row.Найменування}"`;

    if (!row.Кількість || row.Кількість === 0) {
      errors.push(`Робота ${rowName}: К-ть - не порожній і не дорівнює 0`);
    }

    if (!row.Ціна || row.Ціна === 0) {
      errors.push(`Робота ${rowName}: Ціна - не порожня і не дорівнює 0`);
    }

    // Сума розраховується як Кількість * Ціна
    const sum = row.Кількість * row.Ціна;
    if (!sum || sum === 0) {
      errors.push(`Робота ${rowName}: Сума - не порожня і не дорівнює 0`);
    }

    // Перевірка Зарплати тільки якщо стовпець відображається
    const slyusarSumCell = document.querySelector(
      `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr [data-name="slyusar_sum"]`,
    ) as HTMLElement | null;
    if (slyusarSumCell && slyusarSumCell.offsetParent !== null) {
      if (!row.Зарплата || row.Зарплата === 0) {
        errors.push(`Робота ${rowName}: Зар-та - не порожня і не дорівнює 0`);
      }
    }

    // Перевірка ПІБ (Слюсара) тільки якщо стовпець відображається
    const pibMagazinCell = document.querySelector(
      `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr [data-name="pib_magazin"]`,
    ) as HTMLElement | null;
    if (pibMagazinCell && pibMagazinCell.offsetParent !== null) {
      if (!row.slyusarName || row.slyusarName.trim() === "") {
        errors.push(`Робота ${rowName}: ПІБ (Слюсар) - не порожній`);
      }
    }
  }

  // Перевірка деталей (⚙️)
  for (const row of detailRows) {
    const rowName = `"${row.Найменування}"`;

    if (!row.Кількість || row.Кількість === 0) {
      errors.push(`Деталь ${rowName}: К-ть - не порожній і не дорівнює 0`);
    }

    if (!row.Ціна || row.Ціна === 0) {
      errors.push(`Деталь ${rowName}: Ціна - не порожня і не дорівнює 0`);
    }

    // Сума розраховується як Кількість * Ціна
    const sum = row.Кількість * row.Ціна;
    if (!sum || sum === 0) {
      errors.push(`Деталь ${rowName}: Сума - не порожня і не дорівнює 0`);
    }

    // Перевірка ПІБ_Магазину тільки якщо стовпець відображається
    const pibMagazinCell = document.querySelector(
      `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr [data-name="pib_magazin"]`,
    ) as HTMLElement | null;
    if (pibMagazinCell && pibMagazinCell.offsetParent !== null) {
      if (!row.shopName || row.shopName.trim() === "") {
        errors.push(`Деталь ${rowName}: ПІБ_Магазин - не порожній`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/** Синхронізувати у shops.data.Історія для 1 акту (групування по магазинах) */
async function syncShopsHistoryForAct(params: {
  actId: number; dateKey: string; dateClose: string | null;
  detailRows: Array<{shopName: string; sclad_id: number | null; Найменування: string; Каталог: string | null; Кількість: number; Ціна: number}>;
}): Promise<void> {
  const names = [...new Set(params.detailRows.map(row => row.shopName.trim()).filter(Boolean))];
  if (!names.length) return;
  // Server patches only the close date from acts; no detail/payment history is downloaded or rebuilt.
  const {data, error} = await supabase.rpc('write_shop_act_status', {p_act_id: params.actId, p_date_key: params.dateKey, p_shop_names: names});
  if (error) throw new Error(error.message || 'Не вдалося синхронізувати статус історії магазину.');
  if (!Number.isSafeInteger(data) || data < 0) throw new Error('Немає підтвердження синхронізації статусу магазину.');
}

/** Синхронізувати у slyusars.data.Історія для 1 акту (оновлення ДатаЗакриття) */
async function syncSlyusarsHistoryForAct(params: {
  actId: number;
  dateKey: string;
  dateClose: string | null;
}): Promise<void> {
  try {
    // Отримуємо всіх приймальників з таблиці slyusars
    const slyusarsData = await fetchPayrollEmployees([params.actId]);

    if (!slyusarsData || slyusarsData.length === 0) {
      return;
    }

    // Спочатку виводимо всі доступні ключі для діагностики
    const availableKeys = Object.keys(slyusarsData[0] || {});

    // Визначаємо первинний ключ - перевіряємо всі можливі варіанти
    const primaryKeyCandidates = [
      "slyusar_id",
      "id",
      "slyusars_id",
      "uid",
      "pk",
    ];

    let primaryKey: string | null = null;
    for (const candidate of primaryKeyCandidates) {
      if (availableKeys.includes(candidate)) {
        primaryKey = candidate;
        break;
      }
    }

    if (!primaryKey) {
      // console.error("❌ Не вдалося визначити первинний ключ для slyusars");
      // console.error("💡 Доступні ключі:", availableKeys);
      // console.error("💡 Шукали:", primaryKeyCandidates);
      return;
    }

    let updatedCount = 0;
    let receiverCount = 0;

    // Проходимо по всіх приймальниках
    for (const slyusarRow of slyusarsData) {
      let slyusarData: any = {};

      // Парсимо JSON дані
      if (typeof slyusarRow.data === "string") {
        try {
          slyusarData = JSON.parse(slyusarRow.data);
        } catch (e) {
          // console.warn(
          // `⚠️ Не вдалося розпарсити дані для запису ${slyusarRow[primaryKey]}`,
          // );
          continue;
        }
      } else if (
        typeof slyusarRow.data === "object" &&
        slyusarRow.data !== null
      ) {
        slyusarData = slyusarRow.data;
      } else {
        // console.warn(`⚠️ Невалідні дані для запису ${slyusarRow[primaryKey]}`);
        continue;
      }

      slyusarData = trackPayrollData(slyusarRow.slyusar_id, slyusarData);
      // Перевіряємо чи це приймальник
      const access = slyusarData["Доступ"] || "";
      const normalizedAccess = access.toLowerCase().normalize("NFKC").trim();

      if (normalizedAccess !== "приймальник") {
        continue;
      }

      receiverCount++;

      // Перевіряємо наявність історії
      if (
        !slyusarData["Історія"] ||
        typeof slyusarData["Історія"] !== "object"
      ) {
        continue;
      }

      const history = slyusarData["Історія"];

      let actFound = false;

      // Шукаємо акт по ВСІХ датах в історії (не тільки по dateKey)
      for (const dateKey in history) {
        if (!Array.isArray(history[dateKey])) {
          continue;
        }

        const dayBucket = history[dateKey];

        // Шукаємо запис з потрібним актом
        for (const actEntry of dayBucket) {
          const actNumber = actEntry?.["Акт"];

          if (Number(actNumber) === Number(params.actId)) {
            // Оновлюємо дату закриття

            actEntry["ДатаЗакриття"] = params.dateClose;
            actFound = true;
            break;
          }
        }

        if (actFound) break; // Якщо знайшли - виходимо з циклу по датах
      }

      if (actFound) {
        // Зберігаємо оновлені дані назад у базу
        await savePayrollData(slyusarData);
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      showNotification(
        `✅ Історія приймальника оновлена (${updatedCount})`,
        "success",
        2000,
      );
    } else {
      // console.warn(
      // `⚠️ Акт ${params.actId} не знайдено в історії жодного приймальника`,
      // );
      showNotification(
        `⚠️ Акт ${params.actId} не знайдено у приймальників`,
        "info",
        3000,
      );
    }
  } catch (err) {
    // console.error("❌ Помилка синхронізації slyusars:", err);
    showNotification("❌ Помилка синхронізації історії приймальника", "error");
  }
}

const FULL_ACCESS_ALIASES = [
  "адміністратор",
  "адміністатор",
  "full",
  "admin",
  "administrator",
];

function getCurrentAccessLevel(): string {
  const fromVar =
    (typeof userAccessLevel === "string" ? userAccessLevel : "") || "";
  const fromLS = getSavedUserDataFromLocalStorage?.() || null;
  const level = (fromVar || fromLS?.access || (fromLS as any)?.["Доступ"] || "")
    .toString()
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  return level;
}

function hasFullAccess(): boolean {
  return FULL_ACCESS_ALIASES.includes(getCurrentAccessLevel());
}

/* =============================== Основний обробник =============================== */

let __statusLockDelegationAttached = false;

export function initStatusLockDelegation(): void {
  if (__statusLockDelegationAttached) return;
  __statusLockDelegationAttached = true;

  document.addEventListener("click", async (ev) => {
    const target = ev.target as HTMLElement | null;
    const btn = target?.closest?.(
      "#status-lock-btn",
    ) as HTMLButtonElement | null;
    if (!btn) return;

    const actIdAttr = btn.getAttribute("data-act-id");
    const actId = actIdAttr ? Number(actIdAttr) : NaN;
    if (!Number.isFinite(actId)) {
      // console.error("data-act-id на кнопці відсутній/некоректний");
      showNotification("Помилка: не визначено ID акту", "error");
      return;
    }

    if (btn.disabled) return;
    if (isActWritePending()) {
      showNotification("Зачекайте завершення збереження акту.", "info");
      return;
    }
    const actor = payrollActorScope();
    const accessLevel = userAccessLevel;
    const modal = btn.closest<HTMLElement>(`#${ZAKAZ_NARAYD_MODAL_ID}`);
    const isActorCurrent = () => actor === payrollActorScope();
    const isCurrentOpening = () => isActorCurrent()
      && modal === document.getElementById(ZAKAZ_NARAYD_MODAL_ID)
      && !!modal && !modal.classList.contains("hidden")
      && modal.getAttribute("data-act-id") === String(actId)
      && globalCache.currentActId === actId
      && btn.isConnected && modal.querySelector("#status-lock-btn") === btn;
    if (!isCurrentOpening()) return;
    btn.disabled = true;
    let finishStatusWrite: (() => void) | undefined;
    const beginStatusWrite = () => {
      finishStatusWrite = holdActStatusWrite();
    };

    try {
      let actStatus: { date_off: string | null; slusarsOn: boolean | null; pruimalnyk: string | null; frozen?: unknown };
      // ☀️ РОЗМОРОЗКА — якщо акт заморожений і натиснули ☀️
      {
        const status = await readActTransitionState(actId, actor);
        if (!isCurrentOpening()) return;
        actStatus = { ...status, slusarsOn: status.slusarsOn ?? null, pruimalnyk: status.pruimalnyk ?? null };
        if (status.frozen) {
          const level = getCurrentAccessLevel();
          if (!FULL_ACCESS_ALIASES.includes(level) && level !== "приймальник") {
            showNotification(
              "❌ Розморозка доступна лише Адміністратору або Приймальнику",
              "warning",
            );
            btn.disabled = false;
            return;
          }

          const confirmed = await showSlusarConfirm(
            "☀️ Розморозити акт?\n\nДеталі будуть списані зі складу знову.",
          );
          if (!isCurrentOpening()) return;
          if (!confirmed) {
            btn.disabled = false;
            return;
          }

          showNotification("☀️ Розморожування акту...", "info");
          beginStatusWrite();
          await unfreezeAct(status, actor, status => {
            if (isActorCurrent()) applyConfirmedActStatus(actId, status, isCurrentOpening());
          });
          if (!isCurrentOpening()) return;
          showNotification("☀️ Акт розморожено. Натисніть «Зберегти зміни», щоб завершити нарахування зарплати.", "success", 6000);
          btn.disabled = false;
          return;
        }
      }

      // 🔵 СПЕЦІАЛЬНА ЛОГІКА ДЛЯ СЛЮСАРЯ - НЕ ЗАКРИВАТИ АКТ, А ЗАПИСУВАТИ slusarsOn
      if (accessLevel === "Слюсар") {
        // ⚠️ ПЕРЕВІРКА: Чи акт закритий?
        if (actStatus.date_off) {
          showNotification(
            "Акт закритий. У Вас відсутні права доступу на відкриття акту. Зверніться до Адміністратора.",
            "warning",
            4000,
          );
          btn.disabled = false;
          return;
        }

        // Перевірка права через settings (setting_id = 3)
        let canToggleSlusarsOn = false;
        try {
          canToggleSlusarsOn = await canSlusarCompleteTasks();
        } catch (err) {
          // console.error("Помилка перевірки прав Слюсаря:", err);
        }
        if (!isCurrentOpening()) return;

        if (!canToggleSlusarsOn) {
          showNotification(
            "❌ У вас немає права для цієї функції. Зверніться до адміністратора.",
            "warning",
            4000,
          );
          btn.disabled = false;
          return;
        }

        // Reuse the fresh status checked above; no second read of the same act.
        const currentSlusarsOn = actStatus.slusarsOn === true;

        // 🎨 КРАСИВЕ МОДАЛЬНЕ ВІКНО ЗАМІСТЬ window.confirm()
        let confirmed = false;
        if (!currentSlusarsOn) {
          confirmed = await showSlusarConfirm(
            "Підтвердити виконання всіх робіт?",
          );
        } else {
          confirmed = await showSlusarConfirm("Відмінити завершення робіт?");
        }
        if (!isCurrentOpening()) return;

        if (!confirmed) {
          showNotification("Скасовано", "warning");
          btn.disabled = false;
          return;
        }

        // Запис в базу даних
        const newSlusarsOn = !currentSlusarsOn;
        if (!isCurrentOpening()) return;
        let updateQuery = supabase
          .from("acts")
          .update({ slusarsOn: newSlusarsOn })
          .eq("act_id", actId)
          .is("date_off", null)
          .or("data->>Заморожений.is.null,data->>Заморожений.neq.true");
        updateQuery = actStatus.slusarsOn == null
          ? updateQuery.is("slusarsOn", null)
          : updateQuery.eq("slusarsOn", actStatus.slusarsOn);
        const { data: completion, error: updateError } = await updateQuery
          .select("act_id,slusarsOn,date_off,pruimalnyk")
          .maybeSingle();
        if (!isActorCurrent()) return;

        if (updateError || !completion || completion.slusarsOn !== newSlusarsOn) {
          // console.error("Помилка оновлення slusarsOn:", updateError);
          if (isCurrentOpening()) showNotification(updateError ? "Помилка збереження" : "Стан акта вже змінився. Відкрийте акт повторно перед підтвердженням.", "error");
          btn.disabled = false;
          return;
        }

        // The confirmed acts row drives the local UI and the receiver's Realtime
        // notification. No separate completion-notification table is required.
        if (isCurrentOpening()) {
          modal?.querySelector(".zakaz_narayd-header")?.classList.toggle(
            "zakaz_narayd-header-slusar-on", newSlusarsOn,
          );
          showNotification(
            newSlusarsOn ? "✅ Роботи завершено" : "✅ Завершення робіт відмінено",
            "success", 2000,
          );
        }
        window.dispatchEvent(new CustomEvent("sto:act-completion-changed", { detail: completion }));

        btn.disabled = false;
        return; // ⚠️ ВАЖЛИВО: виходимо з функції, не закриваємо акт
      }

      // ======================= ВІДКРИТТЯ АКТУ =======================
      if (globalCache.isActClosed) {
        // Перевіряємо право відкриття акту через settings
        // Адміністратор завжди має право, інші ролі перевіряються через БД
        let canOpen = true;

        if (!hasFullAccess()) {
          try {
            canOpen = await canUserOpenClosedActs();
          } catch (permErr) {
            // console.error("Помилка перевірки прав відкриття акту:", permErr);
            // Якщо помилка при читанні settings — блокуємо доступ для безпеки
            canOpen = false;
          }

          if (!canOpen) {
            showNotification(
              "❌ У вас ця функція недоступна. Зверніться до адміністратора.",
              "warning",
              4000,
            );
            btn.disabled = false;
            return;
          }
        }

        const passwordCorrect = await showViknoVvodyParolu(actId);
        if (!isCurrentOpening()) return;
        if (!passwordCorrect) {
          showNotification("Скасовано відкриття акту", "warning");
          btn.disabled = false;
          return;
        }

        showNotification("Відкриття акту...", "info");
        beginStatusWrite();
        const detailRows = collectDetailRowsFromDom();

        // Статус acts — єдине джерело істини. Змінюємо його першим, а
        // допоміжні таблиці синхронізуємо best-effort після успіху.
        const { data: openedRows, error: actError } = await supabase
          .from("acts")
          .update({ date_off: null, tupOplatu: null })
          .eq("act_id", actId)
          .not("date_off", "is", null)
          .select(ACT_STATUS_RECEIPT);
        if (actError || !openedRows?.length)
          throw new Error(
            "Не вдалося відкрити акт: " +
              (actError?.message || "стан акту вже змінився"),
          );

        const openedAct = openedRows[0] as unknown as ConfirmedActStatus;
        if (isActorCurrent()) applyConfirmedActStatus(actId, openedAct, isCurrentOpening());
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId } }));

        try {
          await supabase.from("sclad").update({ time_off: null }).eq("akt", actId);
        } catch {}

        // ✅ ЛОГУВАННЯ ДІЇ
        try {
          await logAction("open_act", actId);
        } catch {}

        const dateKey = toISODateOnly(openedAct.date_on);
        if (dateKey) {
          try {
            if (detailRows.length) {
              await syncShopsHistoryForAct({ actId, dateKey, dateClose: null, detailRows });
            }
            await syncSlyusarsHistoryForAct({ actId, dateKey, dateClose: null });
          } catch {
            showNotification(
              "Акт відкрито, але допоміжну історію синхронізовано не повністю",
              "warning",
              3500,
            );
          }
        } else {
          showNotification(
            "Не вдалось визначити дату відкриття акту — Історія в shops не оновлена",
            "warning",
            2000,
          );
        }

        if (isCurrentOpening()) showNotification("Акт успішно відкрито", "success");
      } else {
        // ======================= ЗАКРИТТЯ АКТУ =======================

        // 1️⃣ Перевіряємо право закриття акту через settings (Приймальник/Слюсар/Запчастист/Складовщик)
        //    Адміністратор завжди має право незалежно від settings.
        //    🔹 ЛОГІКА:
        //       - Акти БЕЗ попереджень → перевіряємо налаштування "Закриття акту 🗝️"
        //       - Акти ІЗ попередженнями → перевіряємо налаштування "Закриття акту із зауваженнями ⚠️"
        let canClose = true;
        if (!hasFullAccess()) {
          // Перевіряємо чи є попередження в таблиці акту
          const noWarnings = checkForWarnings(); // true = без попереджень

          if (noWarnings) {
            // Немає попереджень - перевіряємо право на звичайне закриття
            try {
              canClose = await canUserCloseActsNormal();
            } catch (permErr) {
              // console.error("Помилка перевірки прав закриття акту:", permErr);
              canClose = true;
            }

            if (!canClose) {
              showNotification(
                "У вас немає права закривати акти. Зверніться до адміністратора.",
                "warning",
                4000,
              );
              btn.disabled = false;
              return;
            }
          } else {
            // Є попередження - перевіряємо налаштування "Закриття акту із зауваженнями"
            try {
              canClose = await canUserCloseActsWithWarnings();
            } catch (permErr) {
              // console.error("Помилка перевірки прав закриття акту:", permErr);
              // Якщо щось пішло не так при читанні settings — МИ НЕ БЛОКУЄМО,
              // щоб не покласти роботу. Але це можна змінити, якщо хочеш.
              canClose = true;
            }

            if (!canClose) {
              showNotification(
                "У вас немає права закривати акти із зауваженнями. Зверніться до адміністратора.",
                "warning",
                4000,
              );
              btn.disabled = false;
              return;
            }
          }
        }

        // 2️⃣ Валідація всіх полів таблиці перед закриттям
        // ⚠️ Адміністратор може закрити акт без валідації
        if (!hasFullAccess()) {
          const validationResult = validateActTableBeforeClosing();
          if (!validationResult.isValid) {
            showNotification(
              "❌ Закриття відмінено, заповніть всі поля таблиці",
              "error",
              5000,
            );
            // console.warn(
            // "Помилки валідації таблиці перед закриттям:",
            // validationResult.errors,
            // );
            validationResult.errors.forEach((_err) => {
              // console.warn(`  • ${_err}`);
            });
            btn.disabled = false;
            return;
          }
        } else {
        }

        // 3️⃣ Вікно підтвердження закриття (як в адміна, з попередженнями)
        // Автозбереження тепер відбувається всередині вікна підтвердження при натисканні "Так"
        const closeConfirmation =
          await showViknoPidtverdchennayZakruttiaAkty(actId);
        if (!isCurrentOpening()) return;
        if (!closeConfirmation.confirmed) {
          showNotification("Скасовано закриття акту", "warning");
          btn.disabled = false;
          return;
        }

        showNotification("Закриття акту...", "info");
        beginStatusWrite();
        const detailRows = collectDetailRowsFromDom();

        // 5️⃣ Оновлюємо статус в БД та допоміжну історію
        const currentDateTime = formatLocalDateTimeForDB(new Date());
        const { data: closedRows, error: actError } = await supabase
          .from("acts")
          .update({
            date_off: currentDateTime,
            tupOplatu: closeConfirmation.paymentType || "Готівка",
            slusarsOn: false, // ✅ АВТОМАТИЧНЕ СКИДАННЯ slusarsOn ПРИ ЗАКРИТТІ АКТУ
          })
          .eq("act_id", actId)
          .is("date_off", null)
          .select(ACT_STATUS_RECEIPT);
        if (actError || !closedRows?.length)
          throw new Error(
            "Не вдалося закрити акт: " +
              (actError?.message || "стан акту вже змінився"),
          );

        const closedAct = closedRows[0] as unknown as ConfirmedActStatus;
        if (isActorCurrent()) applyConfirmedActStatus(actId, closedAct, isCurrentOpening());
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId } }));

        try {
          await supabase
            .from("sclad")
            .update({ time_off: currentDateTime })
            .eq("akt", actId);
        } catch {}

        // ✅ ЛОГУВАННЯ ДІЇ — з загальною сумою
        let totalSum = 0;
        try {
          const summary = await readActTransitionState(actId, actor);
          totalSum = Number(summary.total) || 0;
        } catch {}
        try {
          await logAction("close_act", actId, {
            date_off: currentDateTime,
            totalSum,
          });
        } catch {
          // Аудит є супутньою операцією і не повинен скасовувати вже виконане
          // закриття акту.
        }

        // 🗑️ ВИДАЛЕННЯ ПОВІДОМЛЕНЬ ПРО ЗМІНИ В АКТІ (act_changes_notifications)
        try {
          await deleteActNotificationsOnClose(actId);
        } catch (deleteNotifError) {
          // console.error(
          // "⚠️ Помилка видалення повідомлень про зміни (не критично):",
          // deleteNotifError,
          // );
        }

        // Используем то же время, что и для записи в БД, чтобы избежать рассинхрона
        const dateKey = toISODateOnly(closedAct.date_on);
        const dateClose = toISODateOnly(currentDateTime); // Генеруємо напряму з currentDateTime

        if (dateKey) {
          try {
            if (detailRows.length) {
              await syncShopsHistoryForAct({ actId, dateKey, dateClose, detailRows });
            }
            // Оновлюємо дату закриття в історії приймальників
            await syncSlyusarsHistoryForAct({ actId, dateKey, dateClose });
          } catch {
            // Основний запис acts.date_off вже успішно збережений. Помилка
            // допоміжної історії не повинна показувати користувачу, що акт не
            // закрився, і не залежить від кількості позицій чи віку акту.
            showNotification(
              "Акт закрито, але частину допоміжної історії не синхронізовано",
              "warning",
              3500,
            );
          }
        } else {
          showNotification(
            "Не вдалось визначити дату відкриття акту — Історія в shops не оновлена",
            "warning",
            2000,
          );
        }

        if (isCurrentOpening()) showNotification("Акт успішно закрито", "success");
      }
    } catch (err: any) {
      // console.error("Помилка в обробнику статус-замка:", err);
      if (isCurrentOpening()) showNotification("Помилка: " + (err?.message || err), "error");
    } finally {
      finishStatusWrite?.();
      btn.disabled = false;
    }
  });
}

/* =============================== ❄️ ЗАМОРОЗКА / РОЗМОРОЗКА АКТУ =============================== */

let __freezeDelegationAttached = false;

export function initFreezeDelegation(): void {
  if (__freezeDelegationAttached) return;
  __freezeDelegationAttached = true;

  // 1) Клік на ❄️ (заморозити) — делегація на freeze-act-btn
  document.addEventListener(
    "click",
    async (ev) => {
      const target = ev.target as HTMLElement | null;
      const freezeBtn = target?.closest?.(
        "#freeze-act-btn",
      ) as HTMLElement | null;
      if (!freezeBtn) return;

      ev.stopPropagation(); // Не пропускаємо клік до status-lock-btn

      // Доступ лише для Адміна та Приймальника
      const level = getCurrentAccessLevel();
      if (!FULL_ACCESS_ALIASES.includes(level) && level !== "приймальник") {
        showNotification(
          "❌ Заморозка доступна лише Адміністратору або Приймальнику",
          "warning",
        );
        return;
      }

      const lockBtn = freezeBtn.closest(
        "#status-lock-btn",
      ) as HTMLButtonElement | null;
      const actId = lockBtn?.getAttribute("data-act-id");
      if (!actId || !lockBtn || lockBtn.disabled) return;
      if (isActWritePending()) {
        showNotification("Зачекайте завершення збереження акту.", "info");
        return;
      }
      const actor = payrollActorScope();
      const modal = lockBtn.closest<HTMLElement>(`#${ZAKAZ_NARAYD_MODAL_ID}`);
      const isActorCurrent = () => actor === payrollActorScope();
      const isCurrentOpening = () => isActorCurrent()
        && !!modal && modal === document.getElementById(ZAKAZ_NARAYD_MODAL_ID)
        && !modal.classList.contains("hidden") && modal.getAttribute("data-act-id") === actId
        && globalCache.currentActId === Number(actId)
        && lockBtn.isConnected && modal.querySelector("#status-lock-btn") === lockBtn;
      if (!isCurrentOpening()) return;
      lockBtn.disabled = true;
      let finishStatusWrite: (() => void) | undefined;

      try {
        const confirmed = await showSlusarConfirm(
          "❄️ Заморозити акт?\n\nДеталі будуть повернуті на склад, а нарахування цього акта прибрані в усіх працівників. Уже виплачені суми збережуться та врахуються після розмороження.",
        );
        if (!confirmed || !isCurrentOpening()) return;
        finishStatusWrite = holdActStatusWrite();
        showNotification("❄️ Заморожування акту...", "info");
        await freezeAct(Number(actId), status => {
          if (isActorCurrent()) applyConfirmedActStatus(Number(actId), status, isCurrentOpening());
        });
        if (isCurrentOpening()) showNotification("❄️ Акт заморожено", "success");
      } catch (err: any) {
        if (isCurrentOpening()) showNotification("Помилка: " + (err?.message || err), "error");
      } finally {
        finishStatusWrite?.();
        lockBtn.disabled = false;
      }
    },
    true,
  ); // capture phase to intercept before status-lock-btn

  // 2) Клік на ☀️ (status-lock-btn з frozen=true) — розморозка
  //    Обробляється всередині initStatusLockDelegation через перевірку frozen
}

/**
 * Stock, all employees' act accruals and preserved payments move atomically
 * on the server. The browser receives only the compact status receipt.
 */
async function freezeAct(actId: number, onCommitted: (status: ConfirmedActStatus) => void): Promise<void> {
  const actor = payrollActorScope();
  const act = await readActTransitionState(actId, actor);
  if (act.date_off) throw new Error("Закритий акт не можна заморожувати");
  const saved = await commitActFrozen(act, true, actor);
  onCommitted(saved);
  try { await logAction("freeze_act", actId); } catch {}
}

async function unfreezeAct(act: ActTransitionState, actor: string, onCommitted: (status: ConfirmedActStatus) => void): Promise<void> {
  assertTransitionActor(actor);
  if (act.date_off) throw new Error("Закритий акт не можна розморожувати");
  if (!act.frozen) {
    onCommitted({ ...act, frozen: false });
    return;
  }

  // The server restores the archived baseline, including acknowledged payments.
  // Normal save reconciles current accruals; the checksum rejects stale state.
  const saved = await commitActFrozen(act, false, actor);
  onCommitted(saved);
  try { await logAction("unfreeze_act", act.act_id); } catch {}
}
