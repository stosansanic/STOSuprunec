import { supabase } from "../../vxid/supabaseClient";
import { parseSmartSearch } from "./smartSearch";

export type ActSearchSort = "id" | "open" | "created" | "closed";
export interface ActSearchPage {
  items: any[]; clients: any[]; cars: any[]; total: number; matched: number;
  has_more: boolean; next_offset: number | null;
}
export interface ActSearchInput {
  from: string | null; to: string | null; mode: "open" | "closed" | "frozen" | null;
  query: string; offset: number; sort: ActSearchSort; limit?: 5 | 50;
}
export function serializeActSearch(query: string): any[] {
  if (!query) return [];
  const smart = parseSmartSearch(query);
  if (smart.length) return JSON.parse(JSON.stringify(smart));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return query.split(" ").filter(Boolean).map(part => {
    const [key, value] = part.split(":");
    return { type: "legacy", key: key && value ? key : "", value: key && value ? value : part, timezone };
  });
}
const pending = new Map<string, Promise<ActSearchPage>>();
const cache = new Map<string, { at: number; page: ActSearchPage }>();
let generation = 0;
const scope = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let owner = scope();
export function clearActSearchPages(): void { generation++;pending.clear();cache.clear(); }
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange(clearActSearchPages);
  for (const event of ["sto:act-saved", "sto:car-saved", "sto:client-saved", "focus", "online"])
    window.addEventListener(event, clearActSearchPages);
  window.addEventListener("storage", event => { if (!event.key || event.key === "userAuthData") clearActSearchPages(); });
}
export async function readActSearchPage(input: ActSearchInput, reuse = true): Promise<ActSearchPage> {
  const current = scope();
  if (current !== owner) { clearActSearchPages();owner = current; }
  const filters = serializeActSearch(input.query);
  const limit = input.limit ?? 50;
  const args = { p_from: input.from, p_to: input.to, p_mode: input.mode, p_filters: filters, p_offset: input.offset, p_sort: input.sort, p_limit: limit };
  const key = JSON.stringify(args);
  const saved = cache.get(key);
  if (reuse && current && saved && Date.now() - saved.at < 10_000) return structuredClone(saved.page);
  let request = pending.get(key);
  if (!request) {
    const started = generation;
    request = (async () => {
      const { data, error } = await supabase.rpc("traffic_act_search_page_v2", args);
      if (error?.code === "PGRST202" || error?.code === "42883") throw new Error("Встановіть SQL-міграцію traffic_act_infinite_scroll для підвантаження актів.");
      if (error) throw error;
      if (!data || !Array.isArray(data.items) || data.items.length > limit || !Array.isArray(data.clients) || !Array.isArray(data.cars) ||
        !Number.isSafeInteger(data.total) || !Number.isSafeInteger(data.matched) || data.matched < 0 || data.total < data.matched ||
        typeof data.has_more !== "boolean" || (data.has_more && (data.items.length !== limit || data.next_offset !== input.offset + limit))) throw new Error("Некоректна сторінка актів.");
      if (started !== generation || current !== scope()) throw new Error("Контекст пошуку змінився. Оновіть таблицю.");
      if (current) {
        cache.delete(key);cache.set(key,{at:Date.now(),page:structuredClone(data)});
        while (cache.size>20) cache.delete(cache.keys().next().value!);
      }
      return data as ActSearchPage;
    })();
    pending.set(key,request);
  }
  try { return structuredClone(await request); }
  finally { if (pending.get(key) === request) pending.delete(key); }
}
