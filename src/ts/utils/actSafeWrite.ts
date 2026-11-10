import { supabase } from "../vxid/supabaseClient";

// Stored inside the existing JSONB, not a new column or RPC. The filter stays
// short even for very large acts. All frontend writes of acts.data use this token.
export const ACT_REVISION_KEY = "__act_revision";
export interface ActWriteReceipt { act_id: number; status: "updated" | "unchanged"; revision: string; checksum: string; cars_id?: number | null; }
function checkedActReceipt(value: any, actId: number, revision: string): ActWriteReceipt {
  if (!value || Number(value.act_id) !== actId || value.revision !== revision || !/^[a-f0-9]{32}$/.test(value.checksum || "") || !["updated", "unchanged"].includes(value.status)) throw new Error("Некоректна квитанція збереження акту");
  return value;
}
function receiptError(error: any): never {
  if (["40001", "55000", "55P03"].includes(error?.code)) throw new ActWriteConflict(error.message);
  if (["PGRST202", "42883"].includes(error?.code)) throw new Error("Встановіть міграцію act_save_receipts перед збереженням акту. Введені дані не втрачено.");
  throw error;
}
export async function readSavedActPayrollContext(receipt: ActWriteReceipt, lockOwner: string): Promise<{ pruimalnyk: string | null; date_off: string | null }> {
  const { data, error } = await supabase.rpc("guarded_act_payroll_context", { p_act_id: receipt.act_id, p_checksum: receipt.checksum, p_revision: receipt.revision, p_lock_owner: lockOwner });
  if (error) receiptError(error);
  if (!data || data.revision !== receipt.revision || data.checksum !== receipt.checksum) throw new ActWriteConflict();
  return data;
}
export async function finishActPayroll(receipt: ActWriteReceipt, snapshot: any, lockOwner: string) {
  if (snapshot?.[ACT_REVISION_KEY] !== receipt.revision) throw new ActWriteConflict();
  const acknowledged = structuredClone(readActJson(snapshot));
  const revision = crypto.randomUUID();
  const { data: raw, error } = await supabase.rpc("guarded_finish_act_payroll", { p_act_id: receipt.act_id, p_checksum: receipt.checksum, p_revision: receipt.revision, p_next_revision: revision, p_lock_owner: lockOwner });
  if (error) receiptError(error);
  const savedReceipt = checkedActReceipt(raw, receipt.act_id, revision);
  const data = { ...acknowledged, __payroll_pending: false, [ACT_REVISION_KEY]: revision };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId: receipt.act_id, revision,
    affectedCarIds: savedReceipt.cars_id ? [savedReceipt.cars_id] : undefined } }));
  return { act_id: receipt.act_id, data, receipt: savedReceipt };
}
export class ActWriteConflict extends Error {
  constructor(message = "Акт змінився. Дані не перезаписано. Збережіть введений текст окремо та відкрийте акт повторно.") {
    super(message);
    this.name = "ActWriteConflict";
  }
}

export function readActJson(value: any): Record<string, any> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Некоректні дані акту: запис зупинено");
  }
  return parsed;
}

export function stableActJson(value: any): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}

export interface ActDelta { path: string[]; remove?: true; value?: any; }
export function buildActDelta(before: any, after: any, path: string[] = []): ActDelta[] {
  if (!path.length) { before = JSON.parse(JSON.stringify(before)); after = JSON.parse(JSON.stringify(after)); }
  if (stableActJson(before) === stableActJson(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return after.flatMap((value, index) => buildActDelta(before[index], value, [...path, String(index)]));
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key =>
      !Object.prototype.hasOwnProperty.call(after, key) ? [{ path: [...path, key], remove: true } as ActDelta]
        : !Object.prototype.hasOwnProperty.call(before, key) ? [{ path: [...path, key], value: after[key] }]
          : buildActDelta(before[key], after[key], [...path, key]));
  }
  return [{ path, value: after }];
}

export async function readEditorActForDelta(actId: number, lockOwner: string) {
  const { data, error } = await supabase.rpc("guarded_read_act_delta", { p_act_id: actId, p_lock_owner: lockOwner });
  if (error) {
    if (["PGRST202", "42883"].includes(error.code)) throw new Error("Встановіть міграцію act_delta_save. Введені дані залишаються у вікні.");
    receiptError(error);
  }
  if (!data || !/^[a-f0-9]{32}$/.test(data.checksum || "")) throw new Error("Некоректна версія акту");
  readActJson(data.data);
  return data as { data: Record<string, any>; date_off: string | null; checksum: string; avans: number | null; pruimalnyk: string | null };
}

export async function writeEditorActDelta(actId: number, expected: any, next: any,
  options: { checksum: string; lockOwner: string; avans?: number }) {
  const acknowledged = structuredClone(readActJson(next));
  const changes = buildActDelta(readActJson(expected), acknowledged);
  const revision = crypto.randomUUID();
  const { data: raw, error } = await supabase.rpc("guarded_patch_act_with_stock", {
    p_act_id: actId, p_checksum: options.checksum, p_changes: changes,
    p_revision: revision, p_lock_owner: options.lockOwner, p_avans: options.avans ?? null,
  });
  if (error) {
    if (["PGRST202", "42883"].includes(error.code)) throw new Error("Встановіть міграцію act_delta_save. Введені дані залишаються у вікні.");
    receiptError(error);
  }
  const receipt = checkedActReceipt(raw, actId, raw?.status === "unchanged" ? (expected?.[ACT_REVISION_KEY] ?? "") : revision);
  const data = receipt.status === "unchanged" ? acknowledged : { ...acknowledged, [ACT_REVISION_KEY]: revision };
  if (receipt.status === "updated" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", {
    detail: { actId, revision, affectedCarIds: receipt.cars_id ? [receipt.cars_id] : undefined },
  }));
  return { act_id: actId, data, receipt };
}

// Match the modal renderer: unnamed legacy/template rows are not positions.
// New acts currently contain one empty detail and one empty work in JSON.
export function countNamedActRows(data: Record<string, any>): number {
  return ([ ["Деталі", "Деталь"], ["Роботи", "Робота"] ] as const).reduce((count, [key, name]) => {
    const rows = data[key] ?? [];
    if (!Array.isArray(rows)) throw new Error(`Некоректний список «${key}» в акті`);
    return count + rows.filter(row => String(row?.[name] ?? "").trim() !== "").length;
  }, 0);
}

export async function readActSnapshot(actId: number) {
  const { data, error } = await supabase.from("acts")
    .select("act_id, data, date_off, avans, cars_id").eq("act_id", actId).single();
  if (error || !data) throw new Error("Не вдалося прочитати акт із бази. Перевірте з’єднання та повторіть збереження; введені дані залишаються у вікні.");
  readActJson(data.data); // Never replace malformed JSON with an empty act.
  return data;
}

export async function writeActSnapshot(
  actId: number, expected: any, next: any,
  options: { allowClosed?: boolean; allowFrozen?: boolean; avans?: number; lockOwner?: string } = {},
) {
  const fresh = await readActSnapshot(actId);
  return commitActSnapshot(actId, fresh, expected, next, options);
}

// A narrow patch has already read its baseline. Reuse that exact snapshot and
// retain the conditional revision/date update below; another read adds traffic
// without making the read-to-write interval atomic.
async function commitActSnapshot(
  actId: number, fresh: Awaited<ReturnType<typeof readActSnapshot>>, expected: any, next: any,
  options: { allowClosed?: boolean; allowFrozen?: boolean; avans?: number; lockOwner?: string },
) {
  const current = readActJson(fresh.data);
  if (stableActJson(current) !== stableActJson(readActJson(expected))) throw new ActWriteConflict();
  if (!options.allowClosed && fresh.date_off) throw new ActWriteConflict("Акт уже закритий. Дані не перезаписано.");
  if (!options.allowFrozen && current["Заморожений"] === true) throw new ActWriteConflict("Акт заморожений. Дані не перезаписано.");
  const data = { ...readActJson(next), [ACT_REVISION_KEY]: crypto.randomUUID() };
  let rows: any[] | null;
  let error: any;
  if (options.lockOwner !== undefined) {
    const response = await supabase.rpc("guarded_write_act_json", {
      p_act_id: actId, p_expected: current, p_next: data, p_lock_owner: options.lockOwner,
      p_allow_closed: options.allowClosed ?? false, p_allow_frozen: options.allowFrozen ?? false, p_avans: options.avans ?? null,
    });
    error = response.error;
    rows = response.data ? [response.data] : [];
    if(error?.code === "PGRST202" || error?.code === "42883") throw new Error("Встановіть міграцію act_editor_lease_guard перед збереженням акту. Введені дані не втрачено.");
    if(["40001","55000","55P03"].includes(error?.code)) throw new ActWriteConflict(error.message);
  } else {
  let query = supabase.from("acts").update({ data, ...(options.avans !== undefined ? { avans: options.avans } : {}) })
    .eq("act_id", actId);
  const revision = current[ACT_REVISION_KEY];
  query = revision == null ? query.is(`data->>${ACT_REVISION_KEY}`, null)
    : query.eq(`data->>${ACT_REVISION_KEY}`, revision);
  query = fresh.date_off == null ? query.is("date_off", null) : query.eq("date_off", fresh.date_off);
  const response = await query.select("act_id, data, cars_id");
  rows = response.data;
  error = response.error;
  }
  if (error) throw error;
  if (rows?.length !== 1) throw new ActWriteConflict();
  // Both sides matter if the car was reassigned during this read/write interval.
  // Reuse returned metadata; no extra request merely to invalidate a cache.
  const carIds = [fresh.cars_id, rows[0].cars_id];
  const affectedCarIds = carIds.every(id => id != null && Number.isSafeInteger(Number(id)) && Number(id) > 0)
    ? [...new Set(carIds.map(Number))] : undefined;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId, affectedCarIds, revision: data[ACT_REVISION_KEY] } }));
  return rows[0];
}

// Retry only a narrow field edit, never a stale full table snapshot.
export async function patchActData(
  actId: number, edit: (data: Record<string, any>) => void,
  options: { allowClosed?: boolean; allowFrozen?: boolean } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const act = await readActSnapshot(actId);
    const next = structuredClone(readActJson(act.data));
    edit(next);
    try { return await commitActSnapshot(actId, act, act.data, next, options); }
    catch (error) { if (!(error instanceof ActWriteConflict) || attempt === 2) throw error; }
  }
  throw new ActWriteConflict();
}

// Commit quantities and stock together for imports, editor saves and offline replay.
export async function writeActSnapshotWithStock(
  actId: number, expected: any, next: any, options: { avans?: number; lockOwner?: string } = {},
) {
  const data = { ...structuredClone(readActJson(next)), [ACT_REVISION_KEY]: crypto.randomUUID() };
  const { data: saved, error } = await supabase.rpc(options.lockOwner !== undefined ? "guarded_write_act_with_stock_receipt" : "write_act_with_stock", {
    ...(options.lockOwner !== undefined ? {p_lock_owner: options.lockOwner} : {}),
    p_act_id: actId,
    p_expected: readActJson(expected),
    p_next: data,
    p_avans: options.avans ?? null,
  });
  if (options.lockOwner !== undefined && (error?.code === "PGRST202" || error?.code === "42883")) throw new Error("Встановіть міграцію act_save_receipts перед збереженням акту. Введені дані не втрачено.");
  if (error?.code === "40001" || error?.code === "55000" || error?.code === "55P03") {
    throw new ActWriteConflict(error.message);
  }
  if (error) throw error;
  if (!saved) throw new ActWriteConflict();
  const receipt = options.lockOwner !== undefined ? checkedActReceipt(saved, actId, data[ACT_REVISION_KEY]) : undefined;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: { actId, revision: data[ACT_REVISION_KEY] } }));
  return { act_id: actId, data: receipt ? data : saved, receipt };
}
