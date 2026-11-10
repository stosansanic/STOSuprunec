import { invalidateStockReads } from "./inhi/stockReadRevision";
import { supabase } from "../../vxid/supabaseClient";
import { CRUD } from "./dodatu_inchi_bazu_danux";
import { getCurrentScladId, getOriginalScladRecord, updateOriginalScladRecord,
  getSlyusarIdByPib, shopEditState, detailEditState } from "./inhi/scladMagasunDetal";
import { resolveStockReferences, type ReferenceInput } from "./inhi/referenceWrite";
import { logAction } from "../../utils/auditLogger";

const fieldMap: Record<string, string> = {
  time_on: "sclad_date", shops: "sclad_shop", part_number: "sclad_detail_catno",
  name: "sclad_detail", kilkist_on: "sclad_qty_in", price: "sclad_price", rahunok: "sclad_invoice_no",
  unit_measurement: "sclad_unit", akt: "sclad_akt", scladNomer: "sclad_procent",
  statys: "sclad_statys", prumitka: "sclad_prumitka", kilkist_off: "sclad_kilkist_off", client_price: "sclad_client_price",
};
const numericFields = new Set(["kilkist_on", "price", "scladNomer", "kilkist_off", "client_price"]);
const pick = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value?.trim() || "";

/** Only controls present in this form may contribute fields; hidden batch fields remain supported. */
export function readScladFormValues(): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const [key, id] of Object.entries(fieldMap)) {
    if (!document.getElementById(id)) continue;
    const text = pick(id);
    if (numericFields.has(key)) {
      const value = text ? Number(text.replace(/\s/g, "").replace(",", ".")) : null;
      if (value !== null && !Number.isFinite(value)) throw new Error(`Некоректне числове значення: ${key}.`);
      payload[key] = value;
    } else payload[key] = text || null;
  }
  if (CRUD === "Додати" && !Object.prototype.hasOwnProperty.call(payload, "kilkist_off")) payload.kilkist_off = 0;
  const baseline = getOriginalScladRecord();
  const employee = document.getElementById("sclad_zapchastyst_pib") as HTMLInputElement | null;
  const hiddenEmployee = document.getElementById("sclad_xto_zamovuv");
  if (hiddenEmployee) {
    const hiddenId = pick("sclad_xto_zamovuv");
    const id = hiddenId ? Number(hiddenId) : null;
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new Error("Некоректний запчастист.");
    payload.xto_zamovuv = id;
  } else if (employee) {
    const name = employee.value.trim();
    const selectedId = Number(employee.dataset.slyusarId);
    if (Number.isSafeInteger(selectedId) && selectedId > 0) payload.xto_zamovuv = selectedId;
    else if (baseline && name === String(baseline.employee_name || "").trim()) payload.xto_zamovuv = baseline.xto_zamovuv;
    else if (name) {
      const id = getSlyusarIdByPib(name);
      if (!id) throw new Error("Оберіть запчастиста зі списку, щоб визначити його ID.");
      payload.xto_zamovuv = id;
    } else if (baseline) payload.xto_zamovuv = baseline.xto_zamovuv;
    else {
      const actor = JSON.parse(localStorage.getItem("userAuthData") || "null");
      if (Number.isSafeInteger(Number(actor?.slyusar_id)) && Number(actor.slyusar_id) > 0) payload.xto_zamovuv = Number(actor.slyusar_id);
    }
  }
  return payload;
}

function validateScladPayload(p: Record<string, any>): void {
  const labels: Record<string, string> = { time_on: "Дата", shops: "Магазин", part_number: "Каталог номер", name: "Деталь", rahunok: "Рахунок №", unit_measurement: "Одиниця виміру" };
  const missing = Object.entries(labels).filter(([key]) => !p[key]).map(([, label]) => label);
  if (!Number.isFinite(p.kilkist_on) || p.kilkist_on <= 0) missing.push("Кількість надходження");
  if (!Number.isFinite(p.price) || p.price <= 0) missing.push("Ціна");
  if (missing.length) throw new Error(`Заповніть обов'язкові поля: ${missing.join(", ")}`);
}

/** Date inputs intentionally show only the date; unchanged time-of-day is preserved. */
export function changedScladFields(payload: Record<string, any>, baseline: Record<string, any>): Record<string, any> {
  const changes: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!Object.prototype.hasOwnProperty.call(baseline, key)) throw new Error("Оновіть SQL та повторно оберіть складську позицію: неповні початкові дані.");
    const old = baseline[key];
    const equal = key === "time_on" ? String(old || "").split("T")[0] === String(value || "")
      : numericFields.has(key) || key === "xto_zamovuv" ? (old == null && value == null) || (old != null && value != null && Number(old) === Number(value))
      : String(old ?? "") === String(value ?? "");
    if (!equal) changes[key] = value;
  }
  return changes;
}

async function resolvePayloadReferences(payload: Record<string, any>, baseline: Record<string, any> | null): Promise<void> {
  const items: ReferenceInput[] = [];
  for (const [kind, field, state, id] of [
    ["shops", "shops", shopEditState, shopEditState.baseShopId],
    ["details", "name", detailEditState, detailEditState.baseDetailId],
  ] as const) {
    const name = String(payload[field] || "").trim();
    if (!name || baseline?.[field] === name || (id && state.originalName === name)) continue;
    items.push({ key: field, kind, name });
  }
  if (!items.length) return;
  const results = await resolveStockReferences(items);
  for (const row of results) {
    if (row.status === "ambiguous") throw new Error(`Знайдено кілька записів «${row.name}». Оберіть потрібний запис зі списку.`);
    payload[row.key] = row.canonical;
  }
}

function cas(query: any, baseline: Record<string, any>, fields: string[]): any {
  for (const key of new Set(fields)) {
    if (!Object.prototype.hasOwnProperty.call(baseline, key)) throw new Error("Оновіть SQL та повторно оберіть складську позицію перед зміною.");
    query = baseline[key] == null ? query.is(key, null) : query.eq(key, baseline[key]);
  }
  return query;
}

/** Shared by the single-position form and batch editor; one guarded delete receipt. */
export async function deleteScladSnapshot(baseline: Record<string, any>, client = supabase): Promise<void> {
  if (baseline.sclad_id == null || !Object.prototype.hasOwnProperty.call(baseline, "akt") || !Object.prototype.hasOwnProperty.call(baseline, "kilkist_off")) {
    throw new Error("Оновіть SQL і повторно оберіть позицію перед видаленням.");
  }
  if (Number(baseline.kilkist_off || 0) !== 0 || String(baseline.akt || "").trim()) throw new Error("Не можна видалити позицію, яка вже використана або прив'язана до акта.");
  const guards = Object.keys(baseline).filter(key => key in fieldMap || key === "xto_zamovuv");
  const response = await cas(client.from("sclad").delete().eq("sclad_id", baseline.sclad_id), baseline, guards).select("sclad_id");
  if (response.error) throw response.error;
  if (response.data?.length !== 1 || String(response.data[0]?.sclad_id) !== String(baseline.sclad_id)) throw new Error("Позицію вже змінено або видалено іншим користувачем. Повторно оберіть її.");
}

export async function handleScladCrud(options: { referencesResolved?: boolean; skipAuditLog?: boolean; onInserted?: (id: string | number, submittedSnapshot?: Record<string, any>) => void } = {}): Promise<boolean> {
  const mode = CRUD;
  const baseline = getOriginalScladRecord();
  // Delete the explicitly selected saved row; unsaved/invalid form edits are irrelevant.
  const payload = mode === "Видалити" ? baseline || {} : readScladFormValues();
  let changed: Record<string, any> = payload;
  let id: string | number | null = null;
  if (mode === "Додати") {
    validateScladPayload(payload);
    if (!options.referencesResolved) await resolvePayloadReferences(payload, null);
    const invoiceOrigin = /\[atlas-invoice:[0-9a-f]{64}:[1-9][0-9]*\]/.test(String(payload.prumitka || ""));
    const response = invoiceOrigin ? await supabase.rpc("stock_insert_invoice", { p_payload: payload })
      : await supabase.from("sclad").insert(payload).select("sclad_id");
    if (response.error) throw response.error;
    const rows = invoiceOrigin ? (response.data ? [response.data] : []) : response.data;
    if (rows?.length !== 1 || rows[0]?.sclad_id == null) throw new Error("Не отримано підтвердження додавання складської позиції.");
    id = rows[0].sclad_id;
    // An idempotent reuse can have newer usage/act links than the submitted invoice.
    const submittedSnapshot = !invoiceOrigin || rows[0].status === "created" ? { ...payload, sclad_id: id } : undefined;
    options.onInserted?.(id!, submittedSnapshot);
  } else {
    id = getCurrentScladId();
    if (!id || !baseline || String(baseline.sclad_id) !== String(id)) throw new Error("Спочатку оберіть складську позицію зі списку за назвою або каталогом.");
    if (mode === "Редагувати") {
      validateScladPayload(payload);
      changed = changedScladFields(payload, baseline);
      if (!Object.keys(changed).length) return true;
      const guards = Object.keys(changed);
      if (Object.prototype.hasOwnProperty.call(changed, "kilkist_on")) {
        if (Number(baseline.kilkist_off || 0) > Number(changed.kilkist_on)) throw new Error("Кількість надходження не може бути меншою за вже використану кількість.");
        guards.push("kilkist_off");
      }
      await resolvePayloadReferences(payload, baseline);
      changed = changedScladFields(payload, baseline);
      if (!Object.keys(changed).length) return true;
      const response = await cas(supabase.from("sclad").update(changed).eq("sclad_id", id), baseline, guards).select("sclad_id");
      if (response.error) throw response.error;
      if (response.data?.length !== 1) throw new Error("Позицію вже змінено або видалено іншим користувачем. Повторно оберіть її перед редагуванням.");
      updateOriginalScladRecord(changed);
    } else if (mode === "Видалити") {
      await deleteScladSnapshot(baseline);
      changed = {};
    } else throw new Error("Оберіть дію зі складською позицією.");
  }
  invalidateStockReads();
  if (!options.skipAuditLog) {
    const action = mode === "Додати" ? "add" : mode === "Видалити" ? "delete" : "edit";
    const changes = Object.entries(changed).map(([field, value]) => ({ field, old: String(baseline?.[field] ?? ""), new: String(value ?? "") }));
    try { await logAction(`warehouse_${action}`, null, { sclad_id: id, part_number: payload.part_number, name: payload.name, shops: payload.shops, ...(mode === "Редагувати" ? { changes } : {}) }, "warehouse"); }
    catch { /* The mutation is committed; a log failure must not cause a repeated insert. */ }
  }
  return true;
}
