import { supabase } from "../vxid/supabaseClient";
import { ACT_REVISION_KEY, readActJson, type ActWriteReceipt } from "./actSafeWrite";
import { PayrollWriteSession, payrollActorScope } from "./payrollSafeWrite";

export interface PayrollRecoverySnapshot {
  act_id: number;
  data: Record<string, any>;
  date_on: string | null;
  date_off: string | null;
  pruimalnyk: string | null;
  client_id: number | null;
  cars_id: number | null;
  checksum: string;
  context_checksum: string;
  revision: string | null;
}
export type PendingPayrollAct = Pick<PayrollRecoverySnapshot, "act_id" | "date_on" | "date_off" | "pruimalnyk">;

function recoveryError(error: any): Error {
  if (["PGRST202", "42883"].includes(error?.code)) return new Error("Встановіть SQL-міграцію payroll_pending_recovery у Supabase → SQL Editor. Акти та виплати не змінено.");
  return new Error(error?.message || "Не вдалося відновити нарахування. Повторіть операцію.");
}
const owner = payrollActorScope;

export async function readPendingPayrollActs(after?: number): Promise<{ rows: PendingPayrollAct[]; hasMore: boolean; nextAfter: number | null }> {
  const actor = owner();
  const { data, error } = await supabase.rpc("payroll_pending_acts", { p_before: after ?? null });
  if (actor !== owner()) throw new Error("Користувач змінився. Відкрийте перелік повторно.");
  if (error) throw recoveryError(error);
  if (!data || !Array.isArray(data.rows) || data.rows.length > 50 || typeof data.hasMore !== "boolean"
    || data.rows.some((row: any) => !Number.isSafeInteger(row.act_id) || row.act_id <= 0)
    || (data.hasMore && (!Number.isSafeInteger(data.nextAfter) || data.nextAfter <= 0 || (after != null && data.nextAfter >= after)))) {
    throw new Error("Некоректна сторінка незавершених нарахувань.");
  }
  return data;
}

export async function readPayrollRecoveryContext(actId: number): Promise<PayrollRecoverySnapshot> {
  if (!Number.isSafeInteger(actId) || actId <= 0) throw new Error("Некоректний номер акта.");
  const actor = owner();
  const { data, error } = await supabase.rpc("payroll_recovery_context", { p_act_id: actId });
  if (actor !== owner()) throw new Error("Користувач змінився. Відновлення зупинено.");
  if (error) throw recoveryError(error);
  if (!data || Number(data.act_id) !== actId || !/^[a-f0-9]{32}$/.test(data.checksum || "")
    || !/^[a-f0-9]{32}$/.test(data.context_checksum || "")) throw new Error("Немає підтвердженої версії акта для відновлення.");
  data.data = readActJson(data.data);
  return data;
}

/** Payroll fragments and pending clearance either all commit, or all roll back. */
export async function commitPayrollSession(snapshot: PayrollRecoverySnapshot, session: PayrollWriteSession, lockOwner?: string) {
  session.assertOwner();
  if (snapshot.act_id !== session.actId || snapshot.data.__payroll_pending !== true) throw new Error("Акт не очікує завершення нарахувань.");
  const revision = crypto.randomUUID();
  const { data: receipt, error } = await supabase.rpc("commit_act_payroll", {
    p_act_id: snapshot.act_id, p_checksum: snapshot.checksum, p_context_checksum: snapshot.context_checksum,
    p_revision: snapshot.revision, p_next_revision: revision, p_employees: session.fragments(), p_lock_owner: lockOwner || null,
    p_stock: session.stockInputs(),
  });
  if (error) throw recoveryError(error);
  session.assertOwner();
  if (!receipt || Number(receipt.act_id) !== snapshot.act_id || receipt.revision !== revision
    || !/^[a-f0-9]{32}$/.test(receipt.checksum || "") || !["updated", "unchanged"].includes(receipt.status)) {
    throw new Error("Немає квитанції завершення зарплати. Оновіть перелік актів, щоб перевірити результат.");
  }
  const data = { ...snapshot.data, __payroll_pending: false, [ACT_REVISION_KEY]: revision };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("sto:act-saved", { detail: {
    actId: snapshot.act_id, revision, affectedCarIds: snapshot.cars_id ? [snapshot.cars_id] : undefined,
  } }));
  return { act_id: snapshot.act_id, data, receipt: receipt as ActWriteReceipt };
}

const recovering = new Set<number>();
export async function recoverSavedActPayroll(actId: number): Promise<void> {
  if (recovering.has(actId)) throw new Error("Цей акт уже відновлюється.");
  recovering.add(actId);
  try {
    const actor = owner();
    const snapshot = await readPayrollRecoveryContext(actId);
    if (snapshot.data.__payroll_pending !== true) return;
    const session = await PayrollWriteSession.create(actId, { protectLegacy: true });
    // Share the editor's formulas; recovery starts only on an explicit click.
    const { planSavedActPayroll } = await import("../roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu");
    await planSavedActPayroll(snapshot, session);
    if (actor !== owner()) throw new Error("Користувач змінився. Нарахування не записано.");
    await commitPayrollSession(snapshot, session);
  } finally {
    recovering.delete(actId);
  }
}
