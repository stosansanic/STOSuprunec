import { supabase } from "../../vxid/supabaseClient";

export interface PlannerOccupancyRow { day: string; post: number; minutes: number }

/** Same date grouping and per-record rounding as the existing calendar. */
export async function readPlannerOccupancy(start: Date, end: Date, client = supabase): Promise<PlannerOccupancyRow[]> {
  const { data, error } = await client.rpc("traffic_planner_occupancy", {
    p_start: start.toISOString(), p_end: end.toISOString(),
    p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  if (!error) {
    if (!Array.isArray(data)) throw new Error("Некоректна відповідь зайнятості");
    return data as PlannerOccupancyRow[];
  }
  if (!["PGRST202", "42883"].includes(error.code)) throw error;
  // Compatibility for installations that have not applied the read RPC yet.
  const result = await client.from("post_arxiv").select("data_on, data_off, name_post")
    .gte("data_on", start.toISOString()).lt("data_on", end.toISOString());
  if (result.error) throw result.error;
  const groups = new Map<string, PlannerOccupancyRow>();
  for (const record of result.data || []) {
    if (!record.name_post) continue;
    const on = new Date(record.data_on), off = new Date(record.data_off);
    const day = `${on.getFullYear()}-${String(on.getMonth() + 1).padStart(2, "0")}-${String(on.getDate()).padStart(2, "0")}`;
    const key = `${day}/${record.name_post}`;
    const row = groups.get(key) || { day, post: record.name_post, minutes: 0 };
    row.minutes += Math.round((off.getTime() - on.getTime()) / 60000);
    groups.set(key, row);
  }
  return [...groups.values()];
}
