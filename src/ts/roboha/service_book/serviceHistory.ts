import { supabase } from "../../vxid/supabaseClient";

export interface HistoryCursor { date_on: string | null; act_id: number }
export interface HistoryPage { items: any[]; has_more: boolean; next_cursor: HistoryCursor | null }

const pages = new Map<string, { at: number; page: HistoryPage }>();
const pending = new Map<string, Promise<HistoryPage>>();
let generation = 0;
const scope = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let owner = scope();
export function clearServiceHistoryCache(): void {
  generation++;
  pages.clear();
  pending.clear();
}
/** The caller must include both cars when moving an act between cars. */
export function invalidateServiceHistoryCars(carIds: number[]): void {
  const affected = new Set(carIds);
  for (const key of pages.keys()) if (affected.has(JSON.parse(key)[0])) pages.delete(key);
  for (const key of pending.keys()) if (affected.has(JSON.parse(key)[0])) pending.delete(key);
}
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange(clearServiceHistoryCache);
  for (const event of ["online", "focus"]) window.addEventListener(event, clearServiceHistoryCache);
  window.addEventListener("sto:act-saved", event => {
    const detail = (event as CustomEvent).detail;
    // Unknown legacy writes can also reassign the car: never guess from a cached act.
    if (Array.isArray(detail?.affectedCarIds) && detail.affectedCarIds.length &&
      detail.affectedCarIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)) {
      invalidateServiceHistoryCars(detail.affectedCarIds);
    } else clearServiceHistoryCache();
  });
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "userAuthData") clearServiceHistoryCache();
  });
}

/** Read models only. Never use these projections as an act write baseline. */
export async function readServiceHistoryPage(carId: number, before: HistoryCursor | null, summary = false): Promise<HistoryPage> {
  const current = scope();
  if (owner !== current) { clearServiceHistoryCache(); owner = current; }
  const key = JSON.stringify([carId, before, summary]);
  const cached = pages.get(key);
  if (current && cached && Date.now() - cached.at < 15_000) return structuredClone(cached.page);
  const started = generation;
  let request = pending.get(key);
  if (!request) {
    request = fetchServiceHistoryPage(carId, before, summary).then(page => {
      if (generation !== started || current !== scope() || pending.get(key) !== request) throw new Error("Історія змінилася. Виберіть автомобіль повторно.");
      if (current) {
        pages.delete(key);
        pages.set(key, { at: Date.now(), page: structuredClone(page) });
        while (pages.size > 20) pages.delete(pages.keys().next().value!);
      }
      return page;
    });
    pending.set(key, request);
  }
  try { return structuredClone(await request); }
  finally { if (pending.get(key) === request) pending.delete(key); }
}

async function fetchServiceHistoryPage(carId: number, before: HistoryCursor | null, summary: boolean): Promise<HistoryPage> {
  const { data, error } = await supabase.rpc("traffic_service_history", {
    p_car: carId, p_before: before, p_summary: summary,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new Error("Для історії встановіть SQL-пакет оптимізації трафіку.");
    }
    throw error;
  }
  if (!data || !Array.isArray(data.items) || typeof data.has_more !== "boolean") {
    throw new Error("Некоректна відповідь історії.");
  }
  if (data.has_more && (!data.items.length || !data.next_cursor ||
    JSON.stringify(data.next_cursor) === JSON.stringify(before))) throw new Error("Некоректна сторінка історії.");
  return data;
}

export async function readServiceHistorySummary(carId: number, isCurrent: () => boolean): Promise<any[]> {
  const rows: any[] = [];
  let before: HistoryCursor | null = null;
  while (isCurrent()) {
    const page = await readServiceHistoryPage(carId, before, true);
    if (!isCurrent()) return [];
    rows.push(...page.items);
    if (!page.has_more) return rows;
    before = page.next_cursor;
  }
  return [];
}
