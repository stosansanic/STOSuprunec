export const saveModalIdCreate = "save-prompt-modal-create";
import {
  closeModalCreateSakazNarad, getModalFormValues, transferredActComment,
  setTransferredActComment, clientRecordBaseline, carRecordBaseline,
} from "./vikno_klient_machuna";
import { supabase } from "../../vxid/supabaseClient";
import { getSavedUserDataFromLocalStorage, userAccessLevel } from "../tablucya/users";
import { logAction } from "../../utils/auditLogger";
import { getPlannerRecord, publishPlannerChange } from "../planyvannya/plannerRecordStore";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";

export function createSaveModalCreate(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = saveModalIdCreate;
  overlay.className = "modal-create-overlay";
  overlay.style.display = "none";
  const modal = document.createElement("div");
  modal.className = "modal-content-save";
  modal.innerHTML = `<p>Створити заказ наряд?</p><div class="save-buttons">
    <button id="save-confirm-create" class="btn-save-confirm">Так</button>
    <button id="save-cancel-create" class="btn-save-cancel">Ні</button></div>`;
  overlay.appendChild(modal);
  return overlay;
}

function getCurrentDateTimeLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

let createRetry: { key: string; token: string; dateOn: string } | null = null;
let activeCreate: { key: string; promise: Promise<number | null> } | null = null;
export function isActCreatePending(): boolean { return activeCreate !== null; }

export function createActInDatabase(
  clientId: number, carsId: number, reason = "", postArxivId?: number,
): Promise<number | null> {
  if (!Number.isSafeInteger(clientId) || clientId <= 0 || !Number.isSafeInteger(carsId) || carsId <= 0) {
    showNotification("Оберіть клієнта та автомобіль зі списку перед створенням акта.", "warning");
    return Promise.resolve(null);
  }
  const actor = localStorage.getItem("userAuthData");
  const receiver = userAccessLevel === "Слюсар" ? null : getSavedUserDataFromLocalStorage?.()?.name || null;
  const key = JSON.stringify([actor, clientId, carsId, reason, receiver, postArxivId]);
  if (activeCreate) return activeCreate.key === key ? activeCreate.promise : Promise.resolve(null);
  if (createRetry?.key !== key) createRetry = { key, token: crypto.randomUUID(), dateOn: getCurrentDateTimeLocal() };
  const attempt = createRetry;
  const client = clientRecordBaseline, car = carRecordBaseline;
  const promise = (async () => {
    let actId: number;
    let replayed = false;
    try {
      // The server verifies the current owner and active car while inserting the act.
      const { data, error } = await supabase.rpc("traffic_client_car_create_act", { p_request: {
        client_id: clientId, cars_id: carsId, reason, pruimalnyk: receiver,
        date_on: attempt.dateOn, request_id: attempt.token,
      } });
      if (error) throw error;
      actId = Number(data?.act_id);
      replayed = data?.replayed === true;
      if (!Number.isSafeInteger(actId) || actId <= 0) throw new Error("База не підтвердила створення акта. Повторіть спробу.");
    } catch (error: any) {
      showNotification(error?.code === "PGRST202" || error?.code === "42883"
        ? "Встановіть SQL-пакет client-car-modal-repair.sql для створення акта."
        : error?.message || "Не вдалося створити акт", "error");
      return null;
    }
    createRetry = null;
    const actData = {
      Деталі: [{ Сума: 0, Ціна: 0, Деталь: "", Магазин: "", Кількість: 0 }],
      Пробіг: 0, Роботи: [{ Сума: 0, Ціна: 0, Робота: "", Слюсар: "", Кількість: 0 }],
      "За деталі": 0, "За роботу": 0, Приймальник: "", Рекомендації: "", Примітки: "",
      "Загальна сума": 0, "Причина звернення": reason, "Прибуток за деталі": 0, "Прибуток за роботу": 0,
    };
    if (actor === localStorage.getItem("userAuthData")) {
      window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: {
        actId, affectedCarIds: [carsId], created: true,
        record: { act_id: actId, client_id: clientId, cars_id: carsId, date_on: attempt.dateOn,
          date_off: null, avans: 0, pruimalnyk: receiver, data: actData },
        client: String(client?.client_id) === String(clientId) ? client : null,
        car: String(car?.cars_id) === String(carsId) ? car : null,
      } }));
      if (!replayed) {
        try { await logAction("act_create", actId, { client_id: clientId, cars_id: carsId, reason }, "order"); }
        catch { /* The act already exists; keep its ID even when audit logging fails. */ }
      }
    }
    if (postArxivId && actor === localStorage.getItem("userAuthData")) {
      try {
        const previous = getPlannerRecord(postArxivId);
        const { data: receipt, error } = await supabase.from("post_arxiv")
          .update({ act_id: actId }).eq("post_arxiv_id", postArxivId)
          .or(`act_id.is.null,act_id.eq.${actId}`)
          .select("post_arxiv_id").maybeSingle();
        if (error || !receipt) throw error || new Error("Відсутнє підтвердження планувальника");
        if (actor === localStorage.getItem("userAuthData")) publishPlannerChange("UPDATE", { post_arxiv_id: postArxivId, act_id: actId }, previous);
      } catch {
        showNotification(`Акт №${actId} створено, але не вдалося прив'язати його до запису в планувальнику. Оберіть цей акт у записі та збережіть його.`, "warning");
      }
    }
    return actId;
  })();
  activeCreate = { key, promise };
  void promise.finally(() => { if (activeCreate?.promise === promise) activeCreate = null; });
  return promise;
}

let pendingPrompt: Promise<number | null> | null = null;
let cancelPrompt: (() => void) | null = null;
export function cancelSaveModalCreate(): void { cancelPrompt?.(); }

export function showSaveModalCreate(postArxivId?: number): Promise<number | null> {
  if (pendingPrompt) return pendingPrompt;
  let modal = document.getElementById(saveModalIdCreate) as HTMLDivElement | null;
  if (!modal) { modal = createSaveModalCreate(); document.body.appendChild(modal); }
  const root = modal;
  const confirmBtn = root.querySelector<HTMLButtonElement>("#save-confirm-create");
  const cancelBtn = root.querySelector<HTMLButtonElement>("#save-cancel-create");
  if (!confirmBtn || !cancelBtn) return Promise.resolve(null);
  const actor = localStorage.getItem("userAuthData");
  const expectedForm = JSON.stringify(getModalFormValues());
  root.classList.add("active");
  root.style.display = "flex";
  let busy = false;
  pendingPrompt = new Promise<number | null>(resolve => {
    const finish = (actId: number | null) => {
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      root.remove(); pendingPrompt = null; cancelPrompt = null; resolve(actId);
    };
    const onCancel = () => { if (!busy) finish(null); };
    const onConfirm = async () => {
      if (busy) return;
      if (actor !== localStorage.getItem("userAuthData")) { finish(null); return; }
      const values = getModalFormValues();
      if (JSON.stringify(values) !== expectedForm) {
        showNotification("Дані форми змінилися. Перевірте вибір клієнта та авто і повторіть створення.", "warning");
        finish(null); return;
      }
      if (!values.client_id || !values.cars_id) {
        showNotification("Оберіть клієнта та автомобіль зі списку перед створенням акта.", "warning");
        return;
      }
      busy = true; confirmBtn.disabled = true; cancelBtn.disabled = true; confirmBtn.textContent = "Створюємо...";
      const ownerModal = document.getElementById("custom-modal-create-sakaz_narad");
      const wasInert = ownerModal?.inert ?? false;
      if (ownerModal) ownerModal.inert = true;
      try {
        const actId = await createActInDatabase(Number(values.client_id), Number(values.cars_id), transferredActComment, postArxivId);
        if (actId) {
          finish(actId);
          if (actor === localStorage.getItem("userAuthData")) {
            setTransferredActComment("");
            closeModalCreateSakazNarad();
            showNotification(`Заказ наряд №${actId} створено`, "success");
          }
        }
      } finally {
        if (ownerModal?.isConnected) ownerModal.inert = wasInert;
        busy = false; confirmBtn.disabled = false; cancelBtn.disabled = false; confirmBtn.textContent = "Так";
      }
    };
    cancelPrompt = onCancel;
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
  return pendingPrompt;
}
