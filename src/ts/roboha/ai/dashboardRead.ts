import { supabase } from "../../vxid/supabaseClient";

/** Only a concurrent request is reused; a new dashboard opening checks fresh data. */
export function createDashboardReader(client: Pick<typeof supabase, "rpc"> = supabase) {
  const pending = new Map<string, Promise<any[] | undefined>>();
  const read = async (from: string, to: string, scope: string): Promise<any[] | undefined> => {
    const key = JSON.stringify([from, to, scope]);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = (async () => {
      const rows: any[] = [];
      let before: number | null = null;
      let rpc = "traffic_dashboard_page_v2";
      while (true) {
        const { data, error }: { data: any; error: any } = await client.rpc(rpc, {
          p_from: from, p_to: to, p_before: before,
        });
        if (error) {
          if (before === null && rpc === "traffic_dashboard_page_v2" && ["PGRST202", "42883"].includes(error.code)) {
            rpc = "traffic_dashboard_page";
            continue;
          }
          if (before === null && ["PGRST202", "42883"].includes(error.code)) return undefined;
          throw error;
        }
        if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") throw new Error("Invalid dashboard page");
        rows.push(...data.items);
        if (!data.has_more) return rows;
        if (!data.items.length || !Number.isFinite(data.next_cursor) || (before !== null && data.next_cursor >= before)) {
          throw new Error("Invalid dashboard cursor");
        }
        before = data.next_cursor;
      }
    })();
    pending.set(key, request);
    try { return await request; } finally { if (pending.get(key) === request) pending.delete(key); }
  };
  return Object.assign(read, { invalidate: () => pending.clear() });
}

export const readDashboardRows = createDashboardReader();
