import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";
import { isActFrozen, parseActData } from "../../utils/actFrozenState";

export interface ActAccountingStatus {
  actId: string;
  dateOff: string | null;
  calculatedAt: string | null;
  isClosed: boolean;
  isCalculated: boolean;
  isFrozen: boolean;
  payrollPending?: boolean;
  discountPercent?: number;
}

interface ActStatusRow {
  act_id: number | string;
  date_off: string | null;
  rosraxovano: string | null;
  data: any;
}

const PAGE_SIZE = 200;

/**
 * Завантажує статус кожного акту без залежності від стандартного ліміту
 * Supabase у 1000 рядків. acts є єдиним джерелом правди для закриття акту
 * (date_off) і загального бухгалтерського розрахунку (rosraxovano).
 */
export async function fetchAllActAccountingStatuses(ids?: Array<string | number>): Promise<
  Map<string, ActAccountingStatus>
> {
  const result = new Map<string, ActAccountingStatus>();
  const uniqueIds = ids ? [...new Set(ids.map(String))] : undefined;
  if (uniqueIds?.length === 0) return result;
  if (uniqueIds && uniqueIds.length > PAGE_SIZE) {
    for (let offset = 0; offset < uniqueIds.length; offset += PAGE_SIZE) {
      const page = await fetchAllActAccountingStatuses(uniqueIds.slice(offset, offset + PAGE_SIZE));
      for (const [id, status] of page) result.set(id, status);
    }
    return result;
  }

  // RPC returns one JSON array, avoiding PostgREST's row cap on set-returning functions.
  let after: string | number | null = null;
  while (true) {
    const response = await supabase.rpc("traffic_accounting_statuses", {
      p_ids: uniqueIds ?? null, p_after: after, p_limit: 200,
    });
    if (response.error) {
      throw missingAccountingRpc("traffic_accounting_statuses", response.error);
    }
    if (!Array.isArray(response.data)) throw new Error("Некоректна відповідь статусів актів");
    const rows = response.data as ActStatusRow[];
    for (const row of rows) addRow(row);
    if (rows.length < 200) return result;
    after = rows[rows.length - 1].act_id;
  }

  function addRow(row: ActStatusRow): void {
    const actId = String(row.act_id);
    const body = parseActData(row.data);
    result.set(actId, { actId, dateOff: row.date_off || null,
      calculatedAt: row.rosraxovano || null, isClosed: Boolean(row.date_off),
      isCalculated: Boolean(row.rosraxovano), isFrozen: isActFrozen(row),
      payrollPending: body.__payroll_pending === true,
      discountPercent: Number(body["Знижка"]) || 0 });
  }

}

export function resolveActDateClose(
  statuses: Map<string, ActAccountingStatus>,
  actId: string | number,
  legacyDate: string | null | undefined,
): string {
  const status = statuses.get(String(actId));
  if (status) return status.dateOff || "";
  return legacyDate || "";
}

export function resolveIsActClosed(
  statuses: Map<string, ActAccountingStatus>,
  actId: string | number,
  legacyDate: string | null | undefined,
): boolean {
  const status = statuses.get(String(actId));
  if (status) return status.isClosed;
  return Boolean(legacyDate);
}
