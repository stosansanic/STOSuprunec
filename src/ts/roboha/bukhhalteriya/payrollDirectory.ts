import { supabase } from "../../vxid/supabaseClient";

export async function readPayrollDirectory(client: Pick<typeof supabase, "rpc"> = supabase): Promise<{ rows: any[]; pendingCount: number }> {
  const rows: any[] = [];
  let after: number | null = null;
  let pendingCount = 0;
  while (true) {
    const response: any = await client.rpc("traffic_payroll_directory", { p_after: after });
    const data: any = response.data;
    const error: any = response.error;
    if (error) throw error;
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") throw new Error("Некоректний довідник зарплати");
    if (after === null) {
      pendingCount = Number(data.pending_count);
      if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) throw new Error("Некоректний лічильник розрахунків");
    }
    rows.push(...data.items);
    if (!data.has_more) return { rows, pendingCount };
    const cursor: number = Number(data.next_cursor);
    if (!Number.isSafeInteger(cursor) || !data.items.length || (after !== null && cursor <= after)) throw new Error("Некоректна сторінка довідника зарплати");
    after = cursor;
  }
}
