import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";

/** Only report operands; never a payroll-write baseline. */
export async function readReceipterSalaryRecords(values: number[], client = supabase, signal?: AbortSignal): Promise<any[]> {
  const ids = [...new Set(values.filter(id => Number.isSafeInteger(id) && id > 0))];
  const rows: any[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const query = client.rpc("traffic_receipter_salaries", { p_ids: batch });
    const {data, error} = await (signal ? query.abortSignal(signal) : query);
    signal?.throwIfAborted();
    if (error) throw missingAccountingRpc('traffic_receipter_salaries', error);
    if (!Array.isArray(data)) throw new Error("Некоректна відповідь зарплатного звіту");
    const wanted = new Set(batch);
    rows.push(...data.filter(row => wanted.has(Number(row?.Акт))));
  }
  return rows;
}
