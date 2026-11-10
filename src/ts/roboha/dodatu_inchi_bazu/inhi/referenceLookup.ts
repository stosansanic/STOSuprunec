import { supabase } from "../../../vxid/supabaseClient";

/** Compact legacy-compatible directories. No persistent cache across users/roles.
 * undefined is strictly a missing optional migration, never a failed request.
 */
export async function readStockDirectory<T>(kind: "shops" | "details" | "staff" | "catalogs"): Promise<T[] | undefined> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.rpc("traffic_stock_directory", { p_kind: kind, p_offset: offset });
    if (error) {
      if (offset === 0 && (error.code === "PGRST202" || error.code === "42883")) return undefined;
      throw error;
    }
    if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") {
      throw new Error("Некоректна відповідь довідника складу");
    }
    rows.push(...data.items);
    if (!data.has_more) return rows;
    if (data.items.length !== 500) throw new Error("Неповна сторінка довідника складу");
  }
}

/** undefined means the optional read-only RPC is not installed; null means absent. */
export async function findReferenceId(kind: "shops" | "details", name: string): Promise<number | null | undefined> {
  const { data, error } = await supabase.rpc("traffic_reference_id", { p_kind: kind, p_name: name.trim() });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return undefined;
    // A failed lookup must not become permission to create a duplicate.
    throw error;
  }
  if (data == null) return null;
  const id = Number(data);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Некоректний ID довідника");
  return id;
}
