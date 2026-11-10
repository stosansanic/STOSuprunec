import { CRUD } from "./dodatu_inchi_bazu_danux";
import { shopEditState, detailEditState } from "./inhi/scladMagasunDetal";
import { writeDirectory, deleteDirectory, clearDirectoryReads } from "./inhi/directoryRead";
import { invalidateStockReads } from "./inhi/stockReadRevision";
import { logAction } from "../../utils/auditLogger";
import { supabase } from "../../vxid/supabaseClient";

/** Explicit directory actions send only the selected ID, old name and new name. */
async function changeReference(kind: "shops" | "details"): Promise<boolean | null> {
  const state = kind === "shops" ? shopEditState : detailEditState;
  if (!state.touched) return null;
  const currentName = state.currentName.trim();
  const originalName = state.originalName;
  const id = kind === "shops" ? shopEditState.baseShopId : detailEditState.baseDetailId;
  const field = kind === "shops" ? "Name" : "data";
  const title = kind === "shops" ? "магазин" : "деталь";
  if (!currentName && CRUD !== "Видалити") throw new Error(`Введіть назву: ${title}.`);
  if (CRUD !== "Додати" && (!id || originalName === null)) {
    throw new Error(`Спочатку оберіть ${title} зі списку для ${CRUD === "Видалити" ? "видалення" : "редагування"}.`);
  }
  if (CRUD === "Редагувати" && originalName === currentName) return true;
  if (CRUD === "Видалити") {
    await deleteDirectory(kind, id!, { [field]: originalName });
  } else if (CRUD === "Редагувати" || CRUD === "Додати") {
    const result = await writeDirectory(kind, CRUD === "Додати" ? null : id!,
      { [field]: currentName }, CRUD === "Додати" ? null : { [field]: originalName });
    if (result.status === "existing") throw new Error(`Такий ${title} вже існує. Оберіть його зі списку.`);
  } else throw new Error("Оберіть дію для довідника.");
  invalidateStockReads();
  // An audit failure must not turn a committed mutation into a retry/duplicate.
  const action = CRUD === "Додати" ? "add" : CRUD === "Видалити" ? "delete" : "edit";
  try { await logAction(`warehouse_${action}_${kind === "shops" ? "shop" : "detail"}`, null,
    { id, name: currentName }, "warehouse"); } catch { /* mutation already confirmed */ }
  return true;
}

export function tryHandleShopsCrud(): Promise<boolean | null> { return changeReference("shops"); }
export function tryHandleDetailsCrud(): Promise<boolean | null> { return changeReference("details"); }

/** Two name fields in the stock form commit together or roll back together. */
export async function tryHandleStockReferencesCrud(): Promise<boolean> {
  const mode = CRUD === "Додати" ? "add" : CRUD === "Редагувати" ? "edit" : CRUD === "Видалити" ? "delete" : null;
  if (!mode) throw new Error("Оберіть дію для довідника.");
  const changes: Array<{ kind: "shops" | "details"; mode: string; id: number | null; patch: Record<string, string>; expected: Record<string, string | null> | null }> = [];
  let touched = false;
  for (const kind of ["shops", "details"] as const) {
    const state = kind === "shops" ? shopEditState : detailEditState;
    if (!state.touched) continue;
    touched = true;
    const id = kind === "shops" ? shopEditState.baseShopId : detailEditState.baseDetailId;
    const name = state.currentName.trim();
    const field = kind === "shops" ? "Name" : "data";
    if (!name && mode !== "delete") throw new Error(kind === "shops" ? "Введіть назву магазину." : "Введіть назву деталі.");
    if (mode !== "add" && (!id || state.originalName === null)) throw new Error(kind === "shops" ? "Оберіть магазин зі списку." : "Оберіть деталь зі списку.");
    if (mode === "edit" && state.originalName === name) continue;
    changes.push({ kind, mode, id: mode === "add" ? null : id, patch: { [field]: name }, expected: mode === "add" ? null : { [field]: state.originalName } });
  }
  if (!touched) throw new Error("Введіть назву магазину або деталі чи оберіть запис зі списку.");
  if (!changes.length) return true;
  const { data, error } = await supabase.rpc("traffic_directory_reference_batch", { p_changes: changes });
  clearDirectoryReads();
  if (error) throw error;
  if (!Array.isArray(data) || data.length !== changes.length || data.some(row => !["created", "existing", "updated", "unchanged", "deleted"].includes(row?.status))) {
    throw new Error("Не отримано повне підтвердження зміни довідників. Оновіть список перед повтором.");
  }
  for (const change of changes) {
    const receipts = data.filter(row => row.kind === change.kind);
    const receipt = receipts[0];
    const idField = change.kind === "shops" ? "shop_id" : "detail_id";
    const id = receipt?.status === "deleted" ? receipt.id : receipt?.row?.[idField];
    if (receipts.length !== 1 || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || (change.id !== null && Number(id) !== change.id) ||
      (change.mode === "delete" ? receipt.status !== "deleted" : receipt.status === "deleted")) {
      throw new Error("База не підтвердила вибрані записи довідників. Оновіть список.");
    }
  }
  invalidateStockReads();
  try { await logAction(`warehouse_${mode}_references`, null, { changes: changes.map(({ kind, id, patch }) => ({ kind, id, ...patch })) }, "warehouse"); }
  catch { /* Both changes are already committed. */ }
  return true;
}
