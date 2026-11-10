//src\ts\roboha\zakaz_naraudy\inhi\save_work.ts
import { supabase } from "../../../vxid/supabaseClient";
import { trackPayrollData, savePayrollData, fetchPayrollEmployees, payrollActBucket, type PayrollWriteSession } from "../../../utils/payrollSafeWrite";
import { showNotification } from "./vspluvauhe_povidomlenna";
import { globalCache, ACT_ITEMS_TABLE_CONTAINER_ID } from "../globalCache";
import { safeParseJSON } from "./ctvorennia_papku_googleDrive.";
import { formatLocalDateTimeForDB } from "./formatuvannya_datu";
import { PAYROLL_PAYMENTS_KEY, preservePayrollPaymentHistory } from "../../../utils/payrollPayments";

/* ===================== ХЕЛПЕРИ ДЛЯ SLYUSARS ===================== */

type SlyusarRow = { slyusar_id?: number; data: any };

export interface WorkPayrollOptions {
  session?: PayrollWriteSession;
  context?: { date_on: string; date_off: string | null; clientInfo: string; carInfo: string };
  strictSavedRows?: boolean;
}

function employeeKey(row: { slyusarName: string; slyusar_id?: number | null }): string {
  return row.slyusar_id ? `#employee:${row.slyusar_id}` : row.slyusarName.trim();
}

function toISODateOnly(dt: string | Date | null | undefined): string | null {
  if (!dt) return null;
  const d = typeof dt === "string" ? new Date(dt) : dt;
  if (!d || isNaN(+d)) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function fetchActDates(
  actId: number,
): Promise<{ date_on: string | null; date_off: string | null }> {
  const { data, error } = await supabase
    .from("acts")
    .select("date_on, date_off")
    .eq("act_id", actId)
    .single();
  if (error) {
    // console.warn("Не вдалося прочитати дати акту:", error.message);
    return { date_on: null, date_off: null };
  }
  return { date_on: data?.date_on ?? null, date_off: data?.date_off ?? null };
}

async function fetchActClientAndCarData(actId: number): Promise<{
  clientInfo: string;
  carInfo: string;
}> {
  try {
    const { data: act, error: actError } = await supabase
      .from("acts")
      .select("client_id, cars_id")
      .eq("act_id", actId)
      .single();

    if (actError || !act) {
      // console.warn("Не вдалося отримати дані акту:", actError?.message);
      return { clientInfo: "—", carInfo: "—" };
    }

    let clientInfo = "—";
    if (act.client_id) {
      const { data: client } = await supabase
        .from("clients")
        .select("data")
        .eq("client_id", act.client_id)
        .single();

      if (client?.data) {
        const clientData = safeParseJSON(client.data);
        clientInfo = clientData?.["ПІБ"] || clientData?.fio || "—";
      }
    }

    let carInfo = "—";
    if (act.cars_id) {
      const { data: car } = await supabase
        .from("cars")
        .select("data")
        .eq("cars_id", act.cars_id)
        .single();

      if (car?.data) {
        const carData = safeParseJSON(car.data);
        const auto = carData?.["Авто"] || "";
        const year = carData?.["Рік"] || "";
        const nomer = carData?.["Номер авто"] || "";
        carInfo = `${auto} ${year} ${nomer}`.trim() || "—";
      }
    }

    return { clientInfo, carInfo };
  } catch (error) {
    // console.warn("Помилка при отриманні даних клієнта та авто:", error);
    return { clientInfo: "—", carInfo: "—" };
  }
}

async function fetchSlyusarByName(name: string, actId: number, session?: PayrollWriteSession): Promise<SlyusarRow | null> {
  const selector = name.startsWith('#employee:') ? {id:Number(name.slice(10))} : {name};
  const rows = session ? await session.fetchEmployees(selector) : await fetchPayrollEmployees([actId], selector);
  if(rows.length>1)throw new Error('Не вдалося однозначно визначити працівника «'+name+'»');
  const data=rows[0];
  if(!data)return null;
  return {slyusar_id:data.slyusar_id,data:trackPayrollData(data.slyusar_id,data.data)};
}

async function updateSlyusarJson(row: SlyusarRow, session?: PayrollWriteSession): Promise<void> {
  if (!row.slyusar_id) throw new Error("Немає ідентифікатора працівника");
  if (session) await session.save(row.data);
  else await savePayrollData(row.data);
}

function ensureSlyusarHistoryRoot(row: SlyusarRow): any {
  if (!row.data || typeof row.data !== "object") row.data = {};
  if (!row.data["Історія"] || typeof row.data["Історія"] !== "object")
    row.data["Історія"] = {};
  return row.data["Історія"];
}

const cleanText = (s?: string | null) =>
  (s ?? "").replace(/\u00A0/g, " ").trim();
const parseNum = (s?: string | null) => {
  const v = cleanText(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
};

/**
 * ✅ НОВА ФУНКЦІЯ: Отримує попередні роботи акту НАПРЯМУЮ з бази slyusars
 * Це гарантує що при видаленні робіт, вони також видаляються з slyusars.Історія
 */
async function fetchPrevWorksFromSlyusars(actId: number, session?: PayrollWriteSession): Promise<
  Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string;
    recordId?: string;
  }>
> {
  const out: Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string;
    recordId?: string;
  }> = [];

  try {
    // Отримуємо всіх слюсарів (тільки з роллю Слюсар)
    const slyusars = session ? await session.fetchEmployees() : await fetchPayrollEmployees([actId]);

    for (const slyusar of slyusars) {
      const slyusarData =
        typeof slyusar.data === "string"
          ? JSON.parse(slyusar.data)
          : slyusar.data;
      if (!slyusarData || !slyusarData.Name) continue;

      // Перевіряємо чи це Слюсар (бо інші ролі не мають робіт в історії)
      if (slyusarData.Доступ !== "Слюсар") continue;

      const slyusarName = slyusarData.Name;
      const history = slyusarData.Історія || {};

      // Перебираємо всі дати в історії
      for (const dateKey of Object.keys(history)) {
        const dayBucket = history[dateKey];
        if (!Array.isArray(dayBucket)) continue;

        // Шукаємо запис з цим актом
        const actEntry = dayBucket.find(
          (e: any) => String(e?.["Акт"]) === String(actId),
        );
        if (!actEntry) continue;

        // Знайшли запис акту - додаємо всі роботи
        const zapisи = actEntry["Записи"] || [];
        for (const zap of zapisи) {
          out.push({
            slyusarName,
            slyusar_id: slyusar.slyusar_id,
            Найменування: zap.Робота || "",
            recordId: zap.recordId,
          });
        }
      }
    }
  } catch (err) {
    throw err;
  }

  return out;
}

function collectCurrentWorkSlyusarsFromTable(): string[] {
  const names = new Set<string>();
  const rows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr`,
  );
  rows.forEach((row) => {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    if (!nameCell) return;
    const typeFromCell = nameCell.getAttribute("data-type");
    if (typeFromCell !== "works") return;
    const pibCell = row.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement;
    const slyusarName = cleanText(pibCell?.textContent);
    if (slyusarName) names.add(slyusarName);
  });
  return Array.from(names);
}

/* ============================= ОСНОВНА СИНХРОНІЗАЦІЯ ============================= */

export interface WorkRow {
  slyusarName: string;
  slyusar_id?: number | null;
  Найменування: string;
  Кількість: number;
  Ціна: number;
  Зарплата: number;
  recordId?: string; // ✅ Унікальний ID для точного пошуку
}

async function syncSlyusarsHistoryForAct(params: {
  actId: number;
  dateKey: string;
  dateClose: string | null;
  clientInfo: string;
  carInfo: string;
  currentRows: Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string;
    Кількість: number;
    Ціна: number;
    Зарплата: number;
    recordId?: string; // ✅ Додано recordId
  }>;
  prevRows: Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string; // ✅ Додано для порівняння
    recordId?: string; // ✅ Додано recordId
  }>;
  options?: WorkPayrollOptions;
}): Promise<void> {
  const session = params.options?.session;
  const resolved = new Map<string, number>();
  for (const row of params.currentRows) {
    // A saved employee ID remains authoritative after a rename or when names
    // repeat. Resolve by name only for legacy rows without an employee ID.
    const employeeId = row.slyusar_id == null ? null : Number(row.slyusar_id);
    if (employeeId !== null && (!Number.isSafeInteger(employeeId) || employeeId <= 0)) {
      throw new Error(`Некоректний ідентифікатор працівника «${row.slyusarName}»`);
    }
    const lookup = employeeId === null ? row.slyusarName : `#employee:${employeeId}`;
    if (!resolved.has(lookup)) {
      const employee = await fetchSlyusarByName(lookup, params.actId, session);
      if (!employee?.slyusar_id || (employeeId !== null && employee.slyusar_id !== employeeId)) {
        throw new Error(`Працівника «${row.slyusarName}»${employeeId === null ? "" : ` (ID ${employeeId})`} не знайдено`);
      }
      resolved.set(lookup, employee.slyusar_id);
    }
    row.slyusar_id = resolved.get(lookup)!;
  }
  const group = (rows: any[]) => {
    const m = new Map<string, any[]>();
    for (const r of rows) {
      const k = employeeKey(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };

  const curBySlyusar = group(params.currentRows);
  const prevBySlyusar = group(params.prevRows);

  /**
   * Розгортає скорочену назву для збереження
   */
  function expandNameForSave(shortenedName: string): string {
    if (!shortenedName || !shortenedName.includes("....."))
      return shortenedName;

    const allNames = [...globalCache.works, ...globalCache.details];
    const [firstPart, lastPart] = shortenedName.split(".....");

    const fullName = allNames.find((name) => {
      const sentences = name
        .split(/(?<=\.)\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (sentences.length < 2) return false;
      const lastSentence = sentences[sentences.length - 1];
      return (
        name.startsWith(firstPart) &&
        (name.endsWith(lastPart) || lastSentence === lastPart)
      );
    });

    return fullName || shortenedName;
  }

  // Reconcile each employee independently. A transferred work earns wages for
  // its current employee while its payment history stays with the original one.
  const allEmployeeKeys = new Set([...curBySlyusar.keys(), ...prevBySlyusar.keys()]);
  for (const slyusarName of allEmployeeKeys) {
    const rows = curBySlyusar.get(slyusarName) || [];
    const slyRow = await fetchSlyusarByName(slyusarName, params.actId, session);
    if (!slyRow) {
      if (!rows.length) continue;
      if (!params.options?.strictSavedRows) showNotification(
        `Слюсар "${slyusarName}" не знайдений у slyusars — пропущено`,
        "warning",
        1800,
      );
      throw new Error(`Слюсар «${slyusarName}» не знайдений. Зарплату не синхронізовано.`);
    }

    const history = ensureSlyusarHistoryRoot(slyRow);
    const dayBucket = payrollActBucket(history, params.actId, params.dateKey);
    let actEntry = dayBucket.find(
      (e: any) => String(e?.["Акт"]) === String(params.actId),
    );
    if (!actEntry) {
      if (!rows.length) continue;
      actEntry = {
        Акт: String(params.actId),
        Записи: [],
        СуммаРоботи: 0,
        ДатаЗакриття: null,
        Клієнт: "",
        Автомобіль: "",
      };
      dayBucket.push(actEntry);
    }

    const prevWorks: any[] = Array.isArray(actEntry["Записи"])
      ? actEntry["Записи"]
      : [];
    const recordKey = (value: unknown): string =>
      value == null ? "" : String(value).trim();
    const owns = (record: any, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(record || {}, key);
    const markedPaid = (value: unknown): boolean => value != null && value !== false && value !== "";
    const isProtected = (record: any): boolean =>
      owns(record, PAYROLL_PAYMENTS_KEY) || markedPaid(record?.Розраховано);
    const protectedHeader = isProtected(actEntry);
    const protectedWork = (record: any): boolean => protectedHeader || isProtected(record);
    const comparableNumber = (value: unknown): number | null => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && !value.trim()) return null;
      const number = typeof value === "number"
        ? value
        : Number(value.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(number) ? number : null;
    };
    const currentWorkName = (row: any): string => {
      const name = row.Найменування || "";
      return !params.options?.strictSavedRows && name.includes(".....")
        ? expandNameForSave(name)
        : name;
    };
    const sameWork = (previous: any, current: any): boolean =>
      typeof previous?.Робота === "string" &&
      previous.Робота.trim() === currentWorkName(current).trim() &&
      ["Кількість", "Ціна", "Зарплата"].every(key => {
        const before = comparableNumber(previous[key]);
        const after = comparableNumber(current[key]);
        return before !== null && after !== null && before === after;
      });
    const ambiguousWork = (name: string): Error => new Error(
      `Акт №${params.actId}, «${slyRow.data.Name}»: неоднозначні записи роботи «${name}». ` +
      "Кілька рядків мають однакову назву або ідентифікатор; неможливо однозначно відновити відповідність виплати. Виплати збережено; потрібна перевірка записів.",
    );

    const prevWorksById = new Map<string, any>();
    for (const previous of prevWorks) {
      const key = recordKey(previous.recordId);
      if (!key) continue;
      if (prevWorksById.has(key)) {
        throw new Error(`Акт №${params.actId}: повторний ідентифікатор роботи «${key}» в історії зарплати.`);
      }
      prevWorksById.set(key, previous);
    }
    const previousByRow = new Map<any, any>();
    const usedPrevious = new Set<any>();
    const match = (row: any, previous: any): void => {
      previousByRow.set(row, previous);
      usedPrevious.add(previous);
    };
    const currentIds = new Set<string>();
    // Reserve immutable IDs for every row before trying aliases or names.
    for (const row of rows) {
      const key = recordKey(row.recordId);
      if (key && currentIds.has(key)) {
        throw new Error(`Акт №${params.actId}: повторний ідентифікатор роботи «${key}».`);
      }
      if (key) currentIds.add(key);
      const previous = key ? prevWorksById.get(key) : undefined;
      if (previous) match(row, previous);
    }
    for (const row of rows) {
      if (previousByRow.has(row)) continue;
      const key = recordKey(row.recordId);
      if (!key) continue;
      const candidates = prevWorks.filter(previous => recordKey(previous.recordId) &&
        recordKey(previous.__payroll_act_record_id) === key);
      if (candidates.length > 1 || (candidates.length === 1 && usedPrevious.has(candidates[0]))) {
        throw ambiguousWork(currentWorkName(row));
      }
      if (candidates.length === 1) match(row, candidates[0]);
    }

    // Deleting and re-adding a paid work gives the act a new ID. A unique name
    // within this employee is the only fallback that can safely restore it.
    const unmatchedRows = rows.filter(row => !previousByRow.has(row));
    const unmatchedProtected = prevWorks.filter(previous =>
      !usedPrevious.has(previous) && recordKey(previous.recordId) && protectedWork(previous));
    for (const row of unmatchedRows) {
      const name = currentWorkName(row).trim();
      const candidates = unmatchedProtected.filter(previous =>
        typeof previous.Робота === "string" && previous.Робота.trim() === name);
      if (!candidates.length) continue;
      if (candidates.length !== 1 ||
          unmatchedRows.filter(candidate => currentWorkName(candidate).trim() === name).length !== 1) {
        throw ambiguousWork(name);
      }
      match(row, candidates[0]);
    }
    // ID-less legacy rows can only be reused when the full work is unchanged.
    // Protected legacy rows must keep their exact JSON shape for the guard.
    const unmatchedLegacy = prevWorks.filter(previous =>
      !usedPrevious.has(previous) && !recordKey(previous.recordId));
    const remainingRows = rows.filter(row => !previousByRow.has(row));
    for (const row of remainingRows) {
      const candidates = unmatchedLegacy.filter(previous => sameWork(previous, row));
      if (!candidates.length) continue;
      if (candidates.length !== 1 ||
          remainingRows.filter(candidate => sameWork(candidates[0], candidate)).length !== 1 ||
          usedPrevious.has(candidates[0])) {
        throw ambiguousWork(currentWorkName(row));
      }
      match(row, candidates[0]);
    }

    const zapis: any[] = [];
    let summaRob = 0;
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const qty = comparableNumber(row.Кількість) ?? 0;
      const price = comparableNumber(row.Ціна) ?? 0;
      const wage = comparableNumber(row.Зарплата) ?? 0;
      const name = currentWorkName(row);
      const currentRecordId = recordKey(row.recordId);
      const previous: any = previousByRow.get(row) || null;

      if (previous && protectedWork(previous)) {
        if (!["Кількість", "Ціна", "Зарплата"].every(key => comparableNumber(row[key]) !== null) ||
            price < 0 || wage < 0 || (qty < 0 && qty !== comparableNumber(previous.Кількість)) ||
            !Number.isFinite(price * qty) || typeof previous.Робота !== "string") {
          throw new Error(`Акт №${params.actId}, «${slyRow.data.Name}»: некоректні суми роботи «${name}». Виплати збережено; перевірте кількість, ціну та зарплату.`);
        }
        const next = structuredClone(previous);
        if (recordKey(previous.recordId)) {
          // Preserve equivalent legacy numeric strings and all unknown fields.
          for (const [key, value] of Object.entries({ Ціна: price, Кількість: qty, Зарплата: wage })) {
            if (comparableNumber(previous[key]) !== value) next[key] = value;
          }
          if (previous.Робота.trim() !== name.trim()) next.Робота = name;
          if (owns(previous, "Сума") && comparableNumber(previous.Сума) !== price * qty) next.Сума = price * qty;
          delete next.__payroll_removed;
          if (currentRecordId && currentRecordId !== recordKey(previous.recordId)) {
            next.__payroll_act_record_id = currentRecordId;
          } else if (currentRecordId) {
            delete next.__payroll_act_record_id;
          }
        }
        // The payment seed uses the old wage, before an edit or restoration.
        zapis.push(preservePayrollPaymentHistory(previous, next, actEntry));
      } else {
        const next: any = previous ? { ...previous } : {};
        next.recordId = currentRecordId || previous?.recordId || `${params.actId}_${slyusarName}_${idx}_${Date.now()}`;
        next.Ціна = price;
        next.Кількість = qty;
        next.Робота = name;
        next.Зарплата = wage;
        if (owns(next, "Сума")) next.Сума = price * qty;
        delete next.__payroll_removed;
        if (!next.Записано) {
          const now = new Date();
          const day = String(now.getDate()).padStart(2, "0");
          const month = String(now.getMonth() + 1).padStart(2, "0");
          next.Записано = `${day}.${month}.${now.getFullYear()}`;
        }
        // An explicit empty ledger prevents a newly added work inheriting the
        // paid act header's legacy marker and appearing paid without a payment.
        if (!previous && markedPaid(actEntry.Розраховано)) next[PAYROLL_PAYMENTS_KEY] = [];
        zapis.push(next);
      }
      summaRob += price * qty;
    }

    for (const previous of prevWorks) {
      if (usedPrevious.has(previous) || !protectedWork(previous)) continue;
      if (!recordKey(previous.recordId)) {
        throw new Error(`Акт №${params.actId}, «${slyRow.data.Name}»: оплачена робота «${previous.Робота}» не має стабільного ідентифікатора. Виплати збережено; перед зміною або видаленням потрібна перевірка старого запису.`);
      }
      const removed: any = { ...previous, Кількість: 0, Зарплата: 0, __payroll_removed: true };
      if (owns(previous, "Сума")) removed.Сума = 0;
      // Retain the immutable payroll ID, payment events and original employee.
      // A zero accrual exposes any overpayment without erasing its history.
      zapis.push(preservePayrollPaymentHistory(previous, removed, actEntry));
    }

    // A tombstone-only act remains in history; an empty unpaid act is removed.
    if (!zapis.length && !protectedHeader) {
      dayBucket.splice(dayBucket.indexOf(actEntry), 1);
      await updateSlyusarJson(slyRow, session);
      continue;
    }
    const newSumma = Math.max(0, Math.round((summaRob + Number.EPSILON) * 100) / 100);
    const zapisChanged =
      JSON.stringify(prevWorks) !== JSON.stringify(zapis) ||
      actEntry["СуммаРоботи"] !== newSumma ||
      actEntry["ДатаЗакриття"] !== params.dateClose ||
      actEntry["Клієнт"] !== params.clientInfo ||
      actEntry["Автомобіль"] !== params.carInfo;
    if (zapisChanged) {
      actEntry["Записи"] = zapis;
      actEntry["СуммаРоботи"] = newSumma;
      actEntry["ДатаЗакриття"] = params.dateClose;
      actEntry["Клієнт"] = params.clientInfo;
      actEntry["Автомобіль"] = params.carInfo;
      await updateSlyusarJson(slyRow, session);
    }
  }
}

export async function syncSlyusarsOnActSave(
  actId: number,
  workRowsForSlyusars: Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string;
    Кількість: number;
    Ціна: number;
    Зарплата: number;
    recordId?: string; // ✅ Додано recordId
  }>,
  options: WorkPayrollOptions = {},
): Promise<void> {
  try {
    if (options.strictSavedRows && !options.context) throw new Error("Немає підтверджених дат і даних клієнта для нарахування.");
    const { date_on, date_off } = options.context || await fetchActDates(actId);
    const dateKey = toISODateOnly(date_on);
    const dateClose = toISODateOnly(date_off);

    if (!dateKey) {
      if (!options.strictSavedRows) showNotification(
        "Не вдалось визначити дату відкриття акту — Історія в slyusars не оновлена",
        "warning",
        2000,
      );
      throw new Error("Не вдалося визначити дату акта для зарплати");
    }

    const { clientInfo, carInfo } = options.context || await fetchActClientAndCarData(actId);

    // ✅ ВИПРАВЛЕНО: Отримуємо попередні роботи НАПРЯМУЮ з бази slyusars, а не з кешу
    // Це гарантує синхронізацію навіть якщо кеш порожній
    const prevWorkRows = await fetchPrevWorksFromSlyusars(actId, options.session);

    await syncSlyusarsHistoryForAct({
      actId,
      dateKey,
      dateClose,
      clientInfo,
      carInfo,
      currentRows: workRowsForSlyusars,
      prevRows: prevWorkRows,
      options,
    });
  } catch (error: any) {
    // console.error("Помилка синхронізації з slyusars:", error);
    if (!options.strictSavedRows) showNotification(
      "Помилка синхронізації з ПІБ (слюсарями): " + (error?.message || error),
      "error",
      3000,
    );
    throw error;
  }
}

/* ========================== ЗАКРИТТЯ / ВІДКРИТТЯ АКТУ ========================== */

export async function closeActAndMarkSlyusars(actId: number): Promise<void> {
  try {
    const now = new Date();
    const nowISO = formatLocalDateTimeForDB(now);
    const nowDateOnly = toISODateOnly(now)!;

    const { error: upErr } = await supabase
      .from("acts")
      .update({ date_off: nowISO })
      .eq("act_id", actId);
    if (upErr)
      throw new Error(
        "Не вдалося оновити дату закриття акту: " + upErr.message,
      );

    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId } }));

    const { date_on } = await fetchActDates(actId);
    const dateKey = toISODateOnly(date_on);
    if (!dateKey) return;

    const { clientInfo, carInfo } = await fetchActClientAndCarData(actId);

    const slyusarNames = collectCurrentWorkSlyusarsFromTable();
    for (const name of slyusarNames) {
      const row = await fetchSlyusarByName(name, actId);
      if (!row) continue;
      const history = ensureSlyusarHistoryRoot(row);
      const dayBucket = (history[dateKey] as any[]) || [];
      const actEntry = dayBucket.find(
        (e: any) => String(e?.["Акт"]) === String(actId),
      );
      if (actEntry) {
        actEntry["ДатаЗакриття"] = nowDateOnly;
        actEntry["Клієнт"] = clientInfo;
        actEntry["Автомобіль"] = carInfo;

        if (actEntry["Записи"] && Array.isArray(actEntry["Записи"])) {
          actEntry["Записи"].forEach((zap: any) => {
            if (!("Зарплата" in zap)) {
              zap["Зарплата"] = 0;
            }
          });
        }

        await updateSlyusarJson(row);
      }
    }

    // --- Оновлення ДатаЗакриття для Приймальника ---
    const { data: actDataForClose } = await supabase
      .from("acts")
      .select("pruimalnyk")
      .eq("act_id", actId)
      .single();

    if (actDataForClose?.pruimalnyk) {
      const pruimRow = await fetchSlyusarByName(actDataForClose.pruimalnyk, actId);
      if (pruimRow) {
        const pruimHistory = ensureSlyusarHistoryRoot(pruimRow);
        for (const dk of Object.keys(pruimHistory)) {
          const bucket = pruimHistory[dk];
          if (!Array.isArray(bucket)) continue;
          const entry = bucket.find(
            (e: any) => String(e?.["Акт"]) === String(actId),
          );
          if (entry) {
            entry["ДатаЗакриття"] = nowDateOnly;
            await updateSlyusarJson(pruimRow);
            break;
          }
        }
      }
    }

    // --- Оновлення ДатаЗакриття для Запчастистів ---
    const allZapchForClose = await fetchPayrollEmployees([actId]);

    if (allZapchForClose) {
      for (const zRow of allZapchForClose) {
        const zd = trackPayrollData(zRow.slyusar_id, zRow.data);
        if (!zd || zd["Доступ"] !== "Запчастист") continue;
        const zHist = zd["Історія"] || {};
        let zModified = false;
        for (const dk of Object.keys(zHist)) {
          const bucket = zHist[dk];
          if (!Array.isArray(bucket)) continue;
          const entry = bucket.find(
            (e: any) => String(e?.["Акт"]) === String(actId),
          );
          if (entry) {
            entry["ДатаЗакриття"] = nowDateOnly;
            zModified = true;
            break;
          }
        }
        if (zModified) {
          zd["Історія"] = zHist;
          await savePayrollData(zd);
        }
      }
    }

    showNotification(
      "Акт закрито. Дату закриття та дані клієнта оновлено у ПІБ.",
      "success",
      1800,
    );
  } catch (e: any) {
    // console.error(e);
    showNotification(
      "Помилка при закритті акту: " + (e?.message || e),
      "error",
      2500,
    );
  }
}

export async function reopenActAndClearSlyusars(actId: number): Promise<void> {
  try {
    const { error: upErr } = await supabase
      .from("acts")
      .update({ date_off: null })
      .eq("act_id", actId);
    if (upErr)
      throw new Error("Не вдалося зняти дату закриття акту: " + upErr.message);

    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId } }));

    const { date_on } = await fetchActDates(actId);
    const dateKey = toISODateOnly(date_on);
    if (!dateKey) return;

    const { clientInfo, carInfo } = await fetchActClientAndCarData(actId);

    const slyusarNames = collectCurrentWorkSlyusarsFromTable();
    for (const name of slyusarNames) {
      const row = await fetchSlyusarByName(name, actId);
      if (!row) continue;
      const history = ensureSlyusarHistoryRoot(row);
      const dayBucket = (history[dateKey] as any[]) || [];
      const actEntry = dayBucket.find(
        (e: any) => String(e?.["Акт"]) === String(actId),
      );
      if (actEntry) {
        actEntry["ДатаЗакриття"] = null;
        actEntry["Клієнт"] = clientInfo;
        actEntry["Автомобіль"] = carInfo;

        if (actEntry["Записи"] && Array.isArray(actEntry["Записи"])) {
          actEntry["Записи"].forEach((zap: any) => {
            if (!("Зарплата" in zap)) {
              zap["Зарплата"] = 0;
            }
          });
        }

        await updateSlyusarJson(row);
      }
    }

    // --- Очищення ДатаЗакриття для Приймальника ---
    const { data: actDataForReopen } = await supabase
      .from("acts")
      .select("pruimalnyk")
      .eq("act_id", actId)
      .single();

    if (actDataForReopen?.pruimalnyk) {
      const pruimRow = await fetchSlyusarByName(actDataForReopen.pruimalnyk, actId);
      if (pruimRow) {
        const pruimHistory = ensureSlyusarHistoryRoot(pruimRow);
        for (const dk of Object.keys(pruimHistory)) {
          const bucket = pruimHistory[dk];
          if (!Array.isArray(bucket)) continue;
          const entry = bucket.find(
            (e: any) => String(e?.["Акт"]) === String(actId),
          );
          if (entry) {
            entry["ДатаЗакриття"] = null;
            await updateSlyusarJson(pruimRow);
            break;
          }
        }
      }
    }

    // --- Очищення ДатаЗакриття для Запчастистів ---
    const allZapchForReopen = await fetchPayrollEmployees([actId]);

    if (allZapchForReopen) {
      for (const zRow of allZapchForReopen) {
        const zd = trackPayrollData(zRow.slyusar_id, zRow.data);
        if (!zd || zd["Доступ"] !== "Запчастист") continue;
        const zHist = zd["Історія"] || {};
        let zModified = false;
        for (const dk of Object.keys(zHist)) {
          const bucket = zHist[dk];
          if (!Array.isArray(bucket)) continue;
          const entry = bucket.find(
            (e: any) => String(e?.["Акт"]) === String(actId),
          );
          if (entry) {
            entry["ДатаЗакриття"] = null;
            zModified = true;
            break;
          }
        }
        if (zModified) {
          zd["Історія"] = zHist;
          await savePayrollData(zd);
        }
      }
    }

    showNotification(
      "Акт відкрито. Дату закриття очищено, дані клієнта оновлено у ПІБ.",
      "success",
      1800,
    );
  } catch (e: any) {
    // console.error(e);
    showNotification(
      "Помилка при відкритті акту: " + (e?.message || e),
      "error",
      2500,
    );
  }
}

/* =========================== ДОДАТКОВО: ЗБІР З DOM =========================== */

export function buildWorkRowsForSlyusarsFromDOM(): Array<{
  slyusarName: string;
  Найменування: string;
  Кількість: number;
  Ціна: number;
  Зарплата: number;
  recordId?: string; // ✅ Додано recordId для точного пошуку
}> {
  const out: Array<{
    slyusarName: string;
    slyusar_id?: number | null;
    Найменування: string;
    Кількість: number;
    Ціна: number;
    Зарплата: number;
    recordId?: string; // ✅ Додано recordId для точного пошуку
  }> = [];
  const rows = document.querySelectorAll(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody tr`,
  );

  rows.forEach((row) => {
    const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
    if (!nameCell) return;
    const typeFromCell = nameCell.getAttribute("data-type");
    if (typeFromCell !== "works") return;

    const workName = cleanText(nameCell?.textContent);
    if (!workName) return;

    const qtyCell = row.querySelector('[data-name="id_count"]') as HTMLElement;
    const priceCell = row.querySelector('[data-name="price"]') as HTMLElement;
    const pibCell = row.querySelector(
      '[data-name="pib_magazin"]',
    ) as HTMLElement;
    const slyusarSumCell = row.querySelector(
      '[data-name="slyusar_sum"]',
    ) as HTMLElement;

    const qty = parseNum(qtyCell?.textContent);
    const price = parseNum(priceCell?.textContent);
    const slyusarName = cleanText(pibCell?.textContent);
    const zp = parseNum(slyusarSumCell?.textContent);

    // ✅ Зчитуємо recordId з атрибута рядка
    const recordId =
      (row as HTMLElement).getAttribute("data-record-id") || undefined;

    if (!slyusarName) return;
    out.push({
      slyusarName,
      Найменування: workName,
      Кількість: qty,
      Ціна: price,
      Зарплата: zp,
      recordId, // ✅ Передаємо recordId
    });
  });

  return out;
}
