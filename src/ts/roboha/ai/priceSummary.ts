import { supabase } from "../../vxid/supabaseClient";
import type { PriceSuggestion } from "./aiService";

const cache = new Map<string, { at: number; value: PriceSuggestion | null }>();
const pending = new Map<string, Promise<PriceSuggestion | null>>();
const REVISION_KEY = "sto:ai-price-revision";
let generation = 0;
let authUser = "";
export function invalidatePriceSummaries(): void { generation++; cache.clear(); pending.clear(); }
window.addEventListener("sto:act-saved", () => {
  invalidatePriceSummaries();
  try { localStorage.setItem(REVISION_KEY, crypto.randomUUID()); } catch { /* TTL remains bounded. */ }
});
window.addEventListener("online", invalidatePriceSummaries);
window.addEventListener("storage", event => {
  if (!event.key || event.key === "userAuthData" || event.key === REVISION_KEY) invalidatePriceSummaries();
});
supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id || "";
  if (authUser !== next) { authUser = next; invalidatePriceSummaries(); }
});

export async function readPriceSummary(name: string, type: "work" | "detail"): Promise<PriceSuggestion | null> {
  const owner = localStorage.getItem("userAuthData") || "";
  const key = JSON.stringify([authUser, owner, type, name.toLowerCase()]);
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < (saved.value ? 30_000 : 10_000)) return structuredClone(saved.value);
  let request = pending.get(key);
  if (!request) {
    const version = generation;
    request = (async () => {
      const { data, error } = await supabase.rpc("traffic_ai_price_summary", { p_name: name, p_type: type });
      if (error) throw error;
      if (version !== generation || owner !== (localStorage.getItem("userAuthData") || "")) throw new Error("Дані акту змінилися. Повторіть вибір роботи.");
      if (data !== null && (!data || !Number.isFinite(data.minPrice) || !Number.isFinite(data.maxPrice) || !Number.isSafeInteger(data.count) || data.count < 1)) throw new Error("Некоректна відповідь історії цін");
      const value: PriceSuggestion | null = data === null ? null : {
        avgPrice: data.minPrice, minPrice: data.minPrice, maxPrice: data.maxPrice, count: data.count,
        source: "history", confirmed: false,
        ...(data.avgQuantity !== null ? { avgQuantity: data.avgQuantity } : {}),
        ...(data.avgSalary !== null ? { avgSalary: data.avgSalary } : {}),
        ...(data.mostFrequentSlyusar ? { mostFrequentSlyusar: data.mostFrequentSlyusar } : {}),
      };
      cache.set(key, { at: Date.now(), value });
      while (cache.size > 100) cache.delete(cache.keys().next().value!);
      return value;
    })();
    pending.set(key, request);
    const active = request;
    void request.finally(() => { if (pending.get(key) === active) pending.delete(key); }).catch(() => {});
  }
  return structuredClone(await request);
}
