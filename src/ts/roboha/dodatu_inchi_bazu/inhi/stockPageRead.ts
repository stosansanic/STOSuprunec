import { supabase } from "../../../vxid/supabaseClient";
import { stockReadRevision } from "./stockReadRevision";

/** Short, bounded, actor-scoped cache. Callers receive copies to protect row snapshots. */
export function createStockPageReader(client = supabase, now = Date.now, getRevision = stockReadRevision) {
  const pending = new Map<string, Promise<any>>();
  const cache = new Map<string, { expires: number; value: any }>();
  let revision = getRevision();
  let owner: string | undefined;
  let epoch = 0;
  return async (args: { p_status: string; p_from: string | null; p_to: string | null; p_query: string; p_before: number | null; p_limit?: number }, scope: string): Promise<any> => {
    const current = getRevision();
    if (revision !== current || owner !== scope) {
      revision = current; owner = scope; epoch++; pending.clear(); cache.clear();
    }
    const started = epoch;
    const key = JSON.stringify([scope, args]);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return structuredClone(hit.value);
    cache.delete(key);
    let request = pending.get(key);
    if (!request) {
      request = Promise.resolve(client.rpc("traffic_stock_page_v2", { ...args, p_limit: args.p_limit ?? 20 }));
      pending.set(key, request);
    }
    try {
      const result = await request;
      if (getRevision() !== current || owner !== scope || epoch !== started) throw new Error("Склад змінився під час читання. Повторіть запит.");
      if (!result.error && Array.isArray(result.data?.items) && typeof result.data?.has_more === "boolean") {
        cache.set(key, { expires: now() + 15_000, value: structuredClone(result) });
        while (cache.size > 20) cache.delete(cache.keys().next().value!);
      }
      return structuredClone(result);
    } finally { if (pending.get(key) === request) pending.delete(key); }
  };
}
export const readStockPage = createStockPageReader();
