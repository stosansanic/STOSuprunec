import { supabase } from "../../vxid/supabaseClient";

interface SearchPage {
  items: { car: any; client: any }[];
  has_more: boolean;
  next_cursor: number | null;
}
const pages = new Map<string, { at: number; page: SearchPage }>();
const pending = new Map<string, Promise<SearchPage>>();
const scope = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let owner = scope();
let generation = 0;

export function clearServiceSearchCache(): void {
  generation++;
  pages.clear();
  pending.clear();
}
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange(clearServiceSearchCache);
  for (const name of ["online", "focus", "sto:client-saved", "sto:car-saved"])
    window.addEventListener(name, clearServiceSearchCache);
  window.addEventListener("storage", event => {
    if (!event.key || event.key === "userAuthData") clearServiceSearchCache();
  });
}

/** Bounded, actor-scoped read cache. Never use a search result as a write baseline. */
export async function readServiceSearchPage(query: string, after: number | null = null): Promise<SearchPage> {
  const q = query.trim();
  if (!q) return { items: [], has_more: false, next_cursor: null };
  const current = scope();
  if (owner !== current) { clearServiceSearchCache(); owner = current; }
  // Keep case as entered: PostgreSQL and browser lowercase rules need not match.
  const key = JSON.stringify([q, after]);
  const cached = pages.get(key);
  if (current && cached && Date.now() - cached.at < 15_000) return structuredClone(cached.page);
  const started = generation;
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const { data, error } = await supabase.rpc("sto_service_book_search_v1", { p_query: q, p_after: after });
      if (error) {
        if (error.code === "PGRST202" || error.code === "42883")
          throw new Error("Для сервісної книжки встановіть SQL-пакет оптимізації трафіку.");
        throw error;
      }
      if (!data || !Array.isArray(data.items) || data.items.length > 20 || typeof data.has_more !== "boolean" ||
        data.items.some((item: any) => !item?.car || !item?.client) ||
        (data.has_more && (!data.items.length || data.next_cursor == null || data.next_cursor === after)))
        throw new Error("Некоректна відповідь пошуку.");
      if (generation !== started || current !== scope())
        throw new Error("Дані пошуку змінилися. Повторіть пошук.");
      if (current) {
        pages.delete(key);
        pages.set(key, { at: Date.now(), page: structuredClone(data) });
        while (pages.size > 20) pages.delete(pages.keys().next().value!);
      }
      return data as SearchPage;
    })();
    pending.set(key, request);
  }
  try { return structuredClone(await request); }
  finally { if (pending.get(key) === request) pending.delete(key); }
}
