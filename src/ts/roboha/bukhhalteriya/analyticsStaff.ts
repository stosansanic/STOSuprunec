import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";

/** Analytics projection only; never pass these rows into payroll persistence. */
export async function readAnalyticsStaff(client = supabase): Promise<any[]> {
  const rows: any[] = [];
  let after: number | null = null;
  while (true) {
    const result = await client.rpc("traffic_analytics_staff", { p_after: after });
    if (result.error) throw missingAccountingRpc('traffic_analytics_staff', result.error);
    const data: { items: any[]; has_more: boolean; next_cursor: number | null } = result.data;
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean" ||
        (data.has_more && (!data.items.length || !Number.isSafeInteger(data.next_cursor) || data.next_cursor! <= (after ?? 0)))) {
      throw new Error("Некоректна сторінка аналітики працівників");
    }
    rows.push(...data.items);
    if (!data.has_more) return rows;
    after = data.next_cursor;
  }
}
