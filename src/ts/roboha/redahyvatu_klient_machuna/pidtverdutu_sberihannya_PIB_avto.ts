export const savePromptModalId = "save-prompt-modal";
import { supabase } from "../../vxid/supabaseClient";
import {
  getModalFormValues, userConfirmation, formSnapshot,
  clientRecordBaseline, carRecordBaseline,
} from "./vikno_klient_machuna";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { logAction, diffChanges } from "../../utils/auditLogger";

export function createSavePromptModal(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = savePromptModalId;
  overlay.className = "modal-overlay-save";
  overlay.style.display = "none";
  const modal = document.createElement("div");
  modal.className = "modal-content-save";
  modal.innerHTML = `<p>Зберегти зміни?</p><div class="save-buttons">
    <button id="save-confirm" class="btn-save-confirm">Так</button>
    <button id="save-cancel" class="btn-save-cancel">Ні</button></div>`;
  overlay.appendChild(modal);
  return overlay;
}

let pendingPrompt: Promise<boolean> | null = null;
let cancelPrompt: (() => void) | null = null;
export function cancelSavePromptModal(): void { cancelPrompt?.(); }

export function showSavePromptModal(): Promise<boolean> {
  if (pendingPrompt) return pendingPrompt;
  const modal = document.getElementById(savePromptModalId);
  const confirmBtn = modal?.querySelector<HTMLButtonElement>("#save-confirm");
  const cancelBtn = modal?.querySelector<HTMLButtonElement>("#save-cancel");
  if (!modal || !confirmBtn || !cancelBtn) return Promise.resolve(false);
  const expectedForm = JSON.stringify(getModalFormValues());
  const expectedMode = userConfirmation;
  const expectedActor = localStorage.getItem("userAuthData");
  modal.style.display = "flex";
  pendingPrompt = new Promise<boolean>(resolve => {
    const finish = (confirmed: boolean) => {
      modal.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      pendingPrompt = null;
      cancelPrompt = null;
      resolve(confirmed);
    };
    const onConfirm = () => {
      if (expectedActor !== localStorage.getItem("userAuthData") || expectedMode !== userConfirmation ||
        expectedForm !== JSON.stringify(getModalFormValues())) {
        showNotification("Дані форми змінилися. Перевірте їх і повторіть збереження.", "warning");
        finish(false);
      } else finish(true);
    };
    const onCancel = () => finish(false);
    cancelPrompt = onCancel;
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
  return pendingPrompt;
}

type Values = ReturnType<typeof getModalFormValues>;
type DataRecord = Record<string, unknown>;
type ClientRecord = { client_id: string | number; data: DataRecord };
type CarRecord = { cars_id: string | number; client_id: string | number; is_deleted: boolean | null; data: DataRecord };
export type SaveClientCarResult = {
  client_id: string | null; cars_id: string | null; saved: boolean;
  client?: ClientRecord; car?: CarRecord;
  client_created?: boolean; car_created?: boolean; car_restored?: boolean;
  client_changed?: boolean; car_changed?: boolean;
  replayed?: boolean;
};
type WriteRequest = {
  operation: "add" | "edit" | "delete";
  client_id: string | null; cars_id: string | null;
  client_patch: DataRecord; car_patch: DataRecord;
  client_expected: DataRecord; car_expected: DataRecord;
  request_id?: string;
};

const text = (value: unknown): string => String(value ?? "").trim();
const id = (value: unknown): string | null => text(value) || null;
function clientFields(values: Partial<Values>): DataRecord {
  return { ПІБ: text(values.fullName), Телефон: text(values.phone), Джерело: text(values.income), Додаткові: text(values.extra) };
}
function carFields(values: Partial<Values>): DataRecord {
  return {
    Авто: text(values.carModel), "Номер авто": text(values.carNumber).toUpperCase(),
    Обʼєм: text(values.engine), Пальне: text(values.fuel), Vincode: text(values.vin).toUpperCase(),
    Рік: text(values.year), КодДВЗ: text(values.carCode).toUpperCase(),
  };
}
function changedFields(before: DataRecord, after: DataRecord, raw: DataRecord) {
  const patch: DataRecord = {}, expected: DataRecord = {};
  for (const key of Object.keys(after)) {
    if (before[key] === after[key]) continue;
    patch[key] = after[key];
    expected[key] = raw[key] ?? null;
  }
  return { patch, expected };
}
function patchChanges(expected: DataRecord, patch: DataRecord): string[] {
  const before: DataRecord = {};
  for (const key of Object.keys(patch)) before[key] = expected[key];
  return diffChanges(before, patch);
}

// Compare displayed values, but send original JSON values for field-level concurrency checks.
export function buildClientCarWriteRequest(
  values: Values,
  mode: "no" | "yes" | null,
  snapshot: Partial<Values> | null,
  client: ClientRecord | null,
  car: CarRecord | null,
): WriteRequest | null {
  const clientId = id(values.client_id), carId = id(values.cars_id);
  if (mode === "no") {
    if (!carId || !clientId || id(car?.cars_id) !== carId || id(car?.client_id) !== clientId)
      throw new Error("Оберіть автівку для видалення зі списку ще раз.");
    return { operation: "delete", client_id: clientId, cars_id: carId,
      client_patch: {}, car_patch: {}, client_expected: {}, car_expected: { ...car!.data } };
  }
  if (!text(values.fullName)) throw new Error("Заповніть ПІБ клієнта");
  if (!text(values.phone)) throw new Error("Заповніть номер телефону");
  if (mode === null && !clientId) throw new Error("Оберіть клієнта для редагування");
  if (clientId && (!snapshot || id(client?.client_id) !== clientId))
    throw new Error("Оберіть клієнта зі списку ще раз перед збереженням.");
  const addingCar = mode === "yes" || (!carId && !!text(values.carModel));
  const vin = text(values.vin).replace(/\s/g, "").toUpperCase();
  const restoringCar = addingCar && car?.is_deleted === true && id(car.cars_id) === carId && !!vin &&
    vin === text(car.data.Vincode || car.data.VIN).replace(/\s/g, "").toUpperCase();
  if ((addingCar || carId) && !text(values.carModel)) throw new Error("Заповніть автомобіль");
  if (!addingCar && carId && (id(car?.cars_id) !== carId || id(car?.client_id) !== clientId || car?.is_deleted))
    throw new Error("Оберіть актуальну автівку зі списку ще раз перед збереженням.");
  const clientDelta = clientId
    ? changedFields(clientFields(snapshot!), clientFields(values), client!.data)
    : { patch: clientFields(values), expected: {} };
  const carDelta = addingCar
    ? { patch: carFields(values), expected: restoringCar ? { ...car!.data } : {} }
    : carId ? changedFields(carFields(snapshot!), carFields(values), car!.data)
    : { patch: {}, expected: {} };
  if (car && (!addingCar || restoringCar)) {
    // Legacy aliases may still be read by older screens. Guard them alongside the canonical field.
    for (const [canonical, alias] of [["Vincode", "VIN"], ["КодДВЗ", "Код ДВЗ"]]) {
      if (Object.prototype.hasOwnProperty.call(carDelta.patch, canonical))
        carDelta.expected[alias] = car.data[alias] ?? null;
    }
  }
  if (!addingCar && !Object.keys(clientDelta.patch).length && !Object.keys(carDelta.patch).length) return null;
  return {
    operation: addingCar ? "add" : "edit", client_id: clientId,
    cars_id: addingCar && !restoringCar ? null : carId,
    client_patch: clientDelta.patch, car_patch: carDelta.patch,
    client_expected: clientDelta.expected, car_expected: carDelta.expected,
  };
}

let pendingSave: Promise<SaveClientCarResult> | null = null;
let retryRequest: { key: string; token: string } | null = null;
export function isClientCarSavePending(): boolean { return pendingSave !== null; }

export function saveClientAndCarToDatabase(): Promise<SaveClientCarResult> {
  if (pendingSave) return pendingSave;
  const promise = saveClientAndCarOnce();
  pendingSave = promise;
  void promise.finally(() => { if (pendingSave === promise) pendingSave = null; });
  return promise;
}

async function saveClientAndCarOnce(): Promise<SaveClientCarResult> {
  const values = getModalFormValues();
  const empty = { client_id: id(values.client_id), cars_id: id(values.cars_id), saved: false };
  try {
    const request = buildClientCarWriteRequest(values, userConfirmation, formSnapshot, clientRecordBaseline, carRecordBaseline);
    if (!request) { showNotification("Немає змін для збереження", "info"); return empty; }
    const actor = localStorage.getItem("userAuthData");
    if (request.operation === "add" || (!request.cars_id && Object.keys(request.car_patch).length)) {
      const key = JSON.stringify([actor, request]);
      if (retryRequest?.key !== key) retryRequest = { key, token: crypto.randomUUID() };
      request.request_id = retryRequest.token;
    }
    const { data, error } = await supabase.rpc("traffic_client_car_save", { p_request: request });
    if (error) throw error;
    if (!data?.saved || !id(data.client_id) || !data.client || !data.car && request.operation === "delete")
      throw new Error("База не підтвердила збереження. Дані у формі залишено; повторіть спробу.");
    const result: SaveClientCarResult = {
      ...data, client_id: id(data.client_id), cars_id: request.operation === "delete" ? null : id(data.cars_id), saved: true,
    };
    if (request.operation !== "delete" && Object.keys(request.car_patch).length && (!result.cars_id || !result.car))
      throw new Error("База не підтвердила автівку. Повторіть збереження.");
    retryRequest = null;
    if (localStorage.getItem("userAuthData") !== actor) return result;
    if (result.client_created || result.client_changed || result.replayed) window.dispatchEvent(new CustomEvent("sto:client-saved", {
      detail: { clientId: result.client_id, patch: result.client!.data, record: result.client },
    }));
    if (result.car_created || result.car_restored || result.car_changed || result.replayed || request.operation === "delete")
      window.dispatchEvent(new CustomEvent("sto:car-saved", {
        detail: { carId: id(result.car?.cars_id), clientId: result.client_id, patch: result.car?.data,
          is_deleted: result.car?.is_deleted, record: result.car },
      }));
    if (!result.replayed) {
      try {
        await logAction("client_car_" + request.operation, null, {
          client_id: result.client_id, cars_id: id(result.car?.cars_id),
          client_changes: patchChanges(request.client_expected, request.client_patch),
          car_changes: patchChanges(request.car_expected, request.car_patch),
          previous_client_id: id(data.previous_client_id),
          restored: !!result.car_restored,
        }, "client");
      } catch { /* A failed audit must not turn a confirmed transaction into a failed save. */ }
    }
    showNotification(request.operation === "delete" ? "Автівку приховано. Клієнт та історія збережені."
      : result.car_restored ? "Автівку відновлено та додано до клієнта. Історія збережена."
      : "Дані клієнта та автівки збережено", "success");
    return result;
  } catch (error: any) {
    const message = error?.code === "PGRST202" || error?.code === "42883"
      ? "Встановіть SQL-пакет client-car-modal-repair.sql для збереження клієнтів та автівок."
      : error?.message || "Не вдалося зберегти дані клієнта та автівки";
    showNotification(message, "error");
    return empty;
  }
}
