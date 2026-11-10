import { deleteDirectory, directoryId, writeDirectory, type DirectoryKind } from "./inhi/directoryRead";
import { supabase } from "../../vxid/supabaseClient";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { all_bd, CRUD, updateAllBd } from "./dodatu_inchi_bazu_danux";
import { resetShopState, resetDetailState } from "./inhi/scladMagasunDetal";
import { tryHandleStockReferencesCrud } from "./db_shops_details";
import { handleScladCrud } from "./db_sclad";
import { getSlusarAdditionalData, saveSlusarData } from "./inhi/slusar";
import { logAction } from "../../utils/auditLogger";

export const savePromptModalId = "save-prompt-modal-all-other-bases";
let activeConfirmation: Promise<boolean> | null = null;
export const isOtherBasesSavePending = (): boolean => activeConfirmation !== null;

export function createSavePromptModal(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = savePromptModalId;
  overlay.className = "modal-overlay-save";
  Object.assign(overlay.style, {
    display: "none", position: "fixed", inset: "0", width: "100vw", height: "100vh",
    background: "rgba(0, 0, 0, 0.4)", alignItems: "center", justifyContent: "center",
    zIndex: "10000000", pointerEvents: "auto",
  });
  const modal = document.createElement("div");
  modal.className = "modal-content-save";
  Object.assign(modal.style, {
    background: "white", padding: "20px 30px", borderRadius: "12px",
    boxShadow: "0 5px 20px rgba(0,0,0,0.3)", textAlign: "center", minWidth: "280px", pointerEvents: "auto",
  });
  modal.innerHTML = `<p id="other-base-confirmation-title">Підтвердіть дію</p>
    <div class="save-buttons">
      <button id="save-confirm" class="btn-save-confirm" type="button">Так</button>
      <input type="password" id="save-password-input" class="save-password-input" placeholder="Пароль" autocomplete="current-password" />
      <button id="save-cancel" class="btn-save-cancel" type="button">Ні</button>
    </div>`;
  overlay.appendChild(modal);
  return overlay;
}

export let currentTableName = "";
export const loadDatabaseData = async (buttonText: string) => { currentTableName = buttonText; };

/** Rebuild only the active form. Its lookups stay lazy and reuse the directory cache. */
export const clearInputAndReloadData = async () => {
  updateAllBd(null);
  resetShopState();
  resetDetailState();
  document.dispatchEvent(new CustomEvent("reload-active-other-base-section"));
};

type OperationMode = "Додати" | "Редагувати" | "Видалити";
interface OperationSnapshot {
  mode: OperationMode;
  table: string;
  draft: any;
  rawDraft: string | null;
  name: string;
  catalog: string;
  actor: string;
  form: string;
}
const simpleTables = new Set<DirectoryKind>(["works", "details", "shops", "incomes", "receivers", "slyusars"]);
const sectionTables: Record<string, string> = {
  Склад: "sclad", Робота: "works", Співробітники: "slyusars", Приймальник: "receivers", Джерело: "incomes", Контрагент: "faktura",
};
function valueOf(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() || "";
}
function formFingerprint(panel: HTMLElement): string {
  return JSON.stringify(Array.from(panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"))
    .map(input => [input.id, input.value, "checked" in input ? input.checked : null]));
}
function captureOperation(panel: HTMLElement): OperationSnapshot {
  if (panel.dataset?.otherBasesLoading === "true" || panel.dataset?.otherBasesReady === "false") {
    throw new Error("Зачекайте завершення відкриття розділу. Якщо завантаження не вдалося — натисніть його ще раз.");
  }
  if (panel.dataset?.otherBasesActor !== undefined && panel.dataset.otherBasesActor !== (localStorage.getItem("userAuthData") || "")) {
    throw new Error("Користувач змінився. Повторно відкрийте вікно й оберіть запис.");
  }
  if (!["Додати", "Редагувати", "Видалити"].includes(CRUD)) throw new Error("Оберіть дію: додати, редагувати або видалити.");
  const draft = all_bd ? JSON.parse(all_bd) : {};
  const activeSection = panel.querySelector(".toggle-button-all_other_bases.active-all_other_bases")?.textContent?.trim() || "";
  const activeTable = sectionTables[activeSection];
  const table = activeTable || draft.table;
  if (!table) throw new Error("Спочатку оберіть розділ довідника.");
  // A late result from another section must never choose the write target.
  if (draft.table && table !== draft.table) throw new Error("Форма змінилася. Повторно оберіть запис у поточному розділі.");
  const name = valueOf("search-input-all_other_bases");
  if (simpleTables.has(table as DirectoryKind)) {
    if (CRUD !== "Видалити" && !name) throw new Error("Введіть назву або ПІБ.");
    if (CRUD !== "Додати") {
      const id = Number(draft[directoryId(table as DirectoryKind)]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Спочатку оберіть запис із випадаючого списку.");
      if (table === "slyusars" && CRUD === "Видалити" && id === 1) throw new Error("Видалення адміністраторського акаунту заборонено.");
    }
  }
  return {
    mode: CRUD as OperationMode, table, draft, rawDraft: all_bd, name,
    catalog: table === "sclad" ? valueOf("sclad_detail_catno") : "",
    actor: localStorage.getItem("userAuthData") || "", form: formFingerprint(panel),
  };
}
function assertOperationCurrent(snapshot: OperationSnapshot, panel: HTMLElement): void {
  if (!panel.isConnected || panel.classList.contains("hidden-all_other_bases") ||
      snapshot.actor !== (localStorage.getItem("userAuthData") || "") || snapshot.mode !== CRUD ||
      snapshot.rawDraft !== all_bd || snapshot.form !== formFingerprint(panel)) {
    throw new Error("Форма або користувач змінилися. Скасуйте підтвердження й повторно оберіть запис.");
  }
}
function originalName(snapshot: OperationSnapshot): string {
  const data = snapshot.draft.data;
  return snapshot.table === "works" || snapshot.table === "details"
    ? String(typeof data === "object" ? data?.data ?? "" : data ?? "")
    : String(data?.Name ?? "");
}
function unchangedSimpleEdit(snapshot: OperationSnapshot): boolean {
  return snapshot.mode === "Редагувати" && snapshot.table !== "slyusars" && simpleTables.has(snapshot.table as DirectoryKind) &&
    snapshot.name === originalName(snapshot);
}
async function performSimpleOperation(snapshot: OperationSnapshot): Promise<boolean> {
  const kind = snapshot.table as DirectoryKind;
  if (!simpleTables.has(kind)) throw new Error("Невідомий розділ довідника.");
  if (kind === "slyusars" && snapshot.mode === "Редагувати") return saveSlusarData();
  const id = snapshot.mode === "Додати" ? null : Number(snapshot.draft[directoryId(kind)]);
  const expected = kind === "works" || kind === "details" ? { data: originalName(snapshot) } : snapshot.draft.data;
  if (snapshot.mode === "Видалити") {
    await deleteDirectory(kind, id!, expected);
  } else {
    const patch: Record<string, any> = kind === "works" || kind === "details" ? { data: snapshot.name } : { Name: snapshot.name };
    if (kind === "slyusars") {
      const extra = getSlusarAdditionalData();
      if (![extra.percent, extra.percentParts].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
        throw new Error("Відсотки зарплати мають бути числом від 0 до 100.");
      }
      Object.assign(patch, {
        ПроцентЗапчастин: extra.percentParts, ПроцентРоботи: extra.access === "Запчастист" ? 0 : extra.percent,
        Склад: extra.warehouse, Пароль: extra.password || "1111", Доступ: extra.access,
      });
    }
    const result = await writeDirectory(kind, id, patch, id === null ? null : expected);
    if (result.status === "existing") throw new Error("Запис із такою назвою вже існує. Оберіть його зі списку для редагування.");
    if (result.status === "unchanged") return true;
  }
  const action = { Додати: "add", Редагувати: "edit", Видалити: "delete" }[snapshot.mode];
  await logAction(`db_${action}_${kind}`, null, { table: kind, id, name: snapshot.name || originalName(snapshot) },
    ["works", "details", "shops"].includes(kind) ? "warehouse" : "settings");
  return true;
}
async function performOperation(snapshot: OperationSnapshot): Promise<boolean> {
  if (snapshot.table === "faktura") {
    const { tryHandleFakturaCrud } = await import("./inhi/contragent");
    return tryHandleFakturaCrud();
  }
  if (snapshot.table === "sclad") {
    // Stock rows resolve their own references. Do not rename/delete global references here.
    if (snapshot.catalog) return handleScladCrud();
    return tryHandleStockReferencesCrud();
  }
  return performSimpleOperation(snapshot);
}
function errorText(error: unknown): string {
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error || "");
  return message || "Не вдалося виконати операцію. Дані форми збережено; перевірте поля та повторіть.";
}

/** A single confirmation owns the frozen form until cancellation or successful completion. */
export function showSavePromptModal(): Promise<boolean> {
  if (activeConfirmation) return activeConfirmation;
  const modal = document.getElementById(savePromptModalId);
  const panel = document.querySelector<HTMLElement>(".modal-overlay-all_other_bases:not(.hidden-all_other_bases)");
  const confirmBtn = modal?.querySelector<HTMLButtonElement>("#save-confirm");
  const cancelBtn = modal?.querySelector<HTMLButtonElement>("#save-cancel");
  const passwordInput = modal?.querySelector<HTMLInputElement>("#save-password-input");
  if (!modal || !panel || !confirmBtn || !cancelBtn || !passwordInput) return Promise.resolve(false);
  let snapshot: OperationSnapshot;
  try { snapshot = captureOperation(panel); }
  catch (error) { showNotification(errorText(error), "warning"); return Promise.resolve(false); }
  if (unchangedSimpleEdit(snapshot)) {
    showNotification("Змін немає — запис уже актуальний.", "info");
    return Promise.resolve(true);
  }
  const controls = Array.from(panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea"));
  const disabledBefore = controls.map(control => control.disabled);
  const inertBefore = panel.inert;
  controls.forEach(control => { control.disabled = true; });
  panel.inert = true;
  modal.style.display = "flex";
  passwordInput.value = "";
  const title = modal.querySelector("#other-base-confirmation-title");
  if (title) title.textContent = snapshot.mode === "Видалити" ? "Підтвердити видалення вибраного запису?" : "Підтвердити збереження змін?";
  activeConfirmation = new Promise<boolean>(resolve => {
    let isSaving = false;
    const setBusy = (busy: boolean) => {
      isSaving = busy;
      confirmBtn.disabled = busy;
      cancelBtn.disabled = busy;
      passwordInput.disabled = busy;
      confirmBtn.textContent = busy ? "Зберігаю..." : "Так";
    };
    const finish = (success: boolean) => {
      modal.style.display = "none";
      setBusy(false);
      passwordInput.value = "";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      passwordInput.removeEventListener("keydown", onPasswordKey);
      controls.forEach((control, index) => { if (control.isConnected) control.disabled = disabledBefore[index]; });
      panel.inert = inertBefore;
      activeConfirmation = null;
      resolve(success);
    };
    const onConfirm = async () => {
      if (isSaving) return;
      setBusy(true);
      try {
        assertOperationCurrent(snapshot, panel);
        const actor = JSON.parse(snapshot.actor || "null");
        if (!actor?.Name || !actor?.slyusar_id) throw new Error("Дані користувача не знайдено. Увійдіть повторно.");
        const password = passwordInput.value.trim();
        if (!password) throw new Error("Введіть пароль.");
        const { data: valid, error } = await supabase.rpc("verify_slyusar_password_by_id", {
          input_slyusar_id: actor.slyusar_id, input_password: password,
        });
        if (error) throw new Error(`Не вдалося перевірити пароль: ${error.message || "помилка з’єднання"}`);
        if (valid !== true) throw new Error("Невірний пароль.");
        assertOperationCurrent(snapshot, panel);
        const success = await performOperation(snapshot);
        if (!success) throw new Error("Операцію не завершено. Перевірте повідомлення та поля; дані форми збережено.");
        finish(true);
        showNotification("Операцію виконано успішно", "success");
        // Refresh only our still-open form, never a newly opened section/account.
        if (snapshot.actor === (localStorage.getItem("userAuthData") || "") && !panel.classList.contains("hidden-all_other_bases")) {
          document.dispatchEvent(new CustomEvent("other-base-data-updated", { detail: { table: snapshot.table } }));
          await clearInputAndReloadData();
        }
      } catch (error) {
        showNotification(errorText(error), "error");
        setBusy(false);
      }
    };
    const onCancel = () => { if (!isSaving) finish(false); };
    const onPasswordKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") { event.preventDefault(); void onConfirm(); }
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    };
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    passwordInput.addEventListener("keydown", onPasswordKey);
    passwordInput.focus();
  });
  return activeConfirmation;
}
