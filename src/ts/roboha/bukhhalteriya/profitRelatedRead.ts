import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";

type ProfitRelatedTable = "clients" | "cars";

/** Read only compact labels for the requested IDs; never entire directories. */
export async function readProfitRelated(
  table: ProfitRelatedTable, values: number[], client = supabase, signal?: AbortSignal,
): Promise<Map<number, any>> {
  const ids = [...new Set(values.filter(id => Number.isSafeInteger(id) && id > 0))];
  const result = new Map<number, any>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const query = client.rpc('traffic_profit_labels', {p_resource: table, p_ids: batch});
    const response = await (signal ? query.abortSignal(signal) : query);
    signal?.throwIfAborted();
    if (response.error) throw missingAccountingRpc('traffic_profit_labels', response.error);
    if (!Array.isArray(response.data)) throw new Error("Не вдалося прочитати підписи звіту");
    for (const row of response.data) {
      const id = row.id;
      result.set(Number(id), row.data);
    }
  }
  return result;
}

/** A report-session cache, separate from financial operands and scoped to the caller. */
export function createProfitRelatedCache() {
  let owner: string | undefined;
  let revision = 0;
  const values = {clients: new Map<number, any>(), cars: new Map<number, any>()};
  const pending = new Map<ProfitRelatedTable, Promise<void>>();
  const controllers = new Set<AbortController>();
  const clear = () => {
    revision++; owner = undefined;
    controllers.forEach(controller => controller.abort()); controllers.clear(); pending.clear();
    values.clients.clear(); values.cars.clear();
  };
  return {
    clear,
    async read(table: ProfitRelatedTable, requested: number[], scope: string, isCurrent: () => boolean): Promise<Map<number, any>> {
      if (owner !== scope) { clear(); owner = scope; }
      const generation = revision;
      const ids = [...new Set(requested.filter(id => Number.isSafeInteger(id) && id > 0))];
      const assertCurrent = () => {
        if (revision !== generation || owner !== scope || !isCurrent())
          throw new DOMException("Пошук змінився", "AbortError");
      };
      // Wait for an overlapping request, then request only IDs it did not cover.
      // Checkbox changes can therefore share the same small request in flight.
      while (ids.some(id => !values[table].has(id))) {
        assertCurrent();
        const active = pending.get(table);
        if (active) { await active; continue; }
        const missing = ids.filter(id => !values[table].has(id));
        const controller = new AbortController(); controllers.add(controller);
        const job = (async () => {
          const result = await readProfitRelated(table, missing, supabase, controller.signal);
          assertCurrent();
          // Cache missing/RLS-hidden records too, without inventing their labels.
          for (const id of missing) values[table].set(id, result.get(id) ?? null);
        })();
        pending.set(table, job);
        try { await job; }
        finally {
          controllers.delete(controller);
          if (pending.get(table) === job) pending.delete(table);
        }
      }
      assertCurrent();
      return new Map(ids.map(id => [id, structuredClone(values[table].get(id))]));
    },
  };
}
