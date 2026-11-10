import { supabase } from "../../vxid/supabaseClient";

// Only for rendering the act editor; financial writes fetch their own full baseline.
type StaffRow = { slyusar_id: number; data: any };
type StaffPage = { items: StaffRow[]; has_more: boolean; next_cursor: number | null };
type StaffRequest = { actId: number | null; promise: Promise<StaffRow[]> };
const pending = new Map<string, StaffRequest>();
let cached: { actId: number | null; key: string; rows: StaffRow[]; at: number } | null = null;

/** A status transaction moves only this act's payroll. Keep other cached reads. */
export function invalidateActStaffHistory(actId: number): void {
  if (!Number.isSafeInteger(actId) || actId <= 0) return;
  if (cached?.actId === actId) cached = null;
  // Detach old requests so they cannot be reused or repopulate the cache.
  // The editor's request generation separately fences their waiting callers.
  for (const [key, request] of pending) {
    if (request.actId === actId) pending.delete(key);
  }
}

export async function readActStaffHistory(
  actId: number | null, generation: number, force = false,
): Promise<StaffRow[]> {
  const key = JSON.stringify([actId, generation]);
  const existing = pending.get(key);
  if (!force && existing) return existing.promise;
  if (!force && cached?.key === key && Date.now() - cached.at < 300_000) return cached.rows;
  const request: StaffRequest = { actId, promise: readRows(actId) };
  pending.set(key, request);
  try {
    const rows = await request.promise;
    if (pending.get(key) === request) cached = { actId, key, rows, at: Date.now() };
    return rows;
  } finally {
    if (pending.get(key) === request) pending.delete(key);
  }
}

async function readRows(actId: number | null): Promise<StaffRow[]> {
  const rows: StaffRow[] = [];
  let after: number | null = null;
  while (true) {
    const response = await supabase.rpc("traffic_act_staff", { p_act_id: actId, p_after: after });
    const page: StaffPage | null = response.data;
    if (response.error) {
      if (["PGRST202", "42883"].includes(response.error.code || "")) {
        throw new Error("Для історії працівників встановіть міграцію traffic_act_staff. Повні історії не завантажуються.");
      }
      throw response.error;
    }
    if (!page || !Array.isArray(page.items)) throw new Error("Invalid staff history page");
    rows.push(...page.items);
    if (!page.has_more) return rows;
    const next: number = Number(page.next_cursor);
    if (!Number.isSafeInteger(next) || (after !== null && next <= after)) throw new Error("Invalid staff cursor");
    after = next;
  }
}
