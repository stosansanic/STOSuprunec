import { supabase } from "../../vxid/supabaseClient";
import { PAYROLL_PAYMENTS_KEY } from "../../utils/payrollPayments";
import { payrollActorScope, payrollEmployeeId } from "../../utils/payrollSafeWrite";
import { missingAccountingRpc } from "./accountingRequests";
import { PAYROLL_REPORT_REVISION, payrollReportHeader } from "./payrollReportFragments";

export interface PayrollReportPaymentPlan {
  record: {employeeId?: number; act: string; dateOpen: string; workIndex?: number};
  before: any; next: any; parent: any;
}

/** Compact report fragments may only be saved as exact selected payment targets. */
export async function savePayrollReportPayments(plans: PayrollReportPaymentPlan[], employees: object[]): Promise<void> {
  const actor = payrollActorScope();
  const grouped = new Map<number, any[]>(), fragments = new Map<string, any>();
  const targets = new Set<string>();
  for (const plan of plans) {
    const id = plan.record.employeeId, actId = Number(plan.record.act), index = plan.record.workIndex;
    if (!Number.isSafeInteger(id) || Number(id) <= 0 || !Number.isSafeInteger(actId) || actId <= 0 ||
        (plan.parent && (!Number.isSafeInteger(index) || Number(index) < 0))) throw new Error("Некоректна позиція виплати");
    const employee = employees.find(value => payrollEmployeeId(value) === id) as any;
    const entry = employee?.Історія?.[plan.record.dateOpen]?.find((value: any) => String(value.Акт) === String(plan.record.act));
    if (!entry || !/^[a-f0-9]{32}$/.test(entry[PAYROLL_REPORT_REVISION] || "")) throw new Error("Нарахування більше не завантажене");
    const targetKey = JSON.stringify([id, actId, plan.parent ? index : null]);
    if (targets.has(targetKey)) throw new Error("Повторна позиція виплати");
    targets.add(targetKey);
    const changes = grouped.get(id!) || [];
    const expected = plan.parent ? plan.before : payrollReportHeader(plan.before);
    const desired = Object.fromEntries(Object.entries(plan.next).filter(([key]) => key === "Розраховано" || key === PAYROLL_PAYMENTS_KEY));
    changes.push({act_id: actId, date: plan.record.dateOpen, entry_revision: entry[PAYROLL_REPORT_REVISION], target: plan.parent ? "record" : "act",
      ...(plan.parent ? {index, record_id: plan.before.recordId == null ? null : String(plan.before.recordId)} : {}), expected, desired});
    grouped.set(id!, changes);
    fragments.set(JSON.stringify([id, plan.record.dateOpen, String(actId)]), entry);
  }
  if (!grouped.size || grouped.size > 50 || [...grouped.values()].some(changes => changes.length > 2000)) throw new Error("Звузьте вибір виплат");
  if (actor !== payrollActorScope()) throw new Error("Користувач змінився. Повторіть пошук.");
  const {data, error} = await supabase.rpc("write_payroll_report_payment_batch", {
    p_employees: [...grouped].map(([id, changes]) => ({id, changes})),
  });
  if (error) throw missingAccountingRpc("write_payroll_report_payment_batch", error);
  if (!Array.isArray(data?.receipts) || data.receipts.length !== grouped.size ||
      new Set(data.receipts.map((row: any) => Number(row.slyusar_id))).size !== grouped.size ||
      data.receipts.some((row: any) => !grouped.has(Number(row.slyusar_id)) || !["updated", "unchanged"].includes(row.status)) ||
      !Array.isArray(data.fragments) || data.fragments.length !== fragments.size) throw new Error("Немає підтвердження пакетної виплати");
  const acknowledged = new Set<string>();
  for (const receipt of data.fragments) {
    const key = JSON.stringify([Number(receipt.id), receipt.date, String(receipt.act)]);
    if (!fragments.has(key) || acknowledged.has(key) || !/^[a-f0-9]{32}$/.test(receipt.revision || "")) throw new Error("Некоректне підтвердження нарахування");
    acknowledged.add(key);
  }
  for (const receipt of data.fragments) fragments.get(JSON.stringify([Number(receipt.id), receipt.date, String(receipt.act)]))[PAYROLL_REPORT_REVISION] = receipt.revision;
}
