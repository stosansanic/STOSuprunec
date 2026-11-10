import { missingAccountingRpc } from "./accountingRequests";
import { requireAccountingPeriod } from "./accountingPeriod";
import { supabase } from "../../vxid/supabaseClient";

/** A report projection; must never be used as a baseline for writing acts.data. */
export async function readProfitActs(
  mode: "open" | "close" | "paid", from: string, to: string,
  client = supabase, signal?: AbortSignal,
): Promise<any[]> {
  const period = requireAccountingPeriod(from, to);
  from = period.from; to = `${period.to}T23:59:59.999999`;
  const rows: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const query = client.rpc("traffic_profit_acts", {
      p_mode: mode, p_from: from || null, p_to: to || null, p_offset: offset,
    });
    const result = await (signal ? query.abortSignal(signal) : query);
    signal?.throwIfAborted();
    if (result.error) throw missingAccountingRpc('traffic_profit_acts', result.error);
    const page = result.data;
    if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean" ||
        page.items.length > 200 || (page.has_more && page.items.length !== 200)) {
      throw new Error("Некоректна сторінка актів звіту");
    }
    rows.push(...page.items);
    if (!page.has_more) return rows;
  }
}
