import { supabase } from "../../vxid/supabaseClient";
export interface EditorReference { kind: "work" | "detail" | "stock" | "shop"; id: string; name: string; catalog: string }
export interface EditorReferenceQuery { query?: string; names?: string[]; workIds?: string[]; detailIds?: number[]; voice?: boolean }
const pending = new Map<string, Promise<EditorReference[]>>();
const cache = new Map<string, { at: number; rows: EditorReference[] }>();
const CACHE_TTL = Infinity; // Lifetime of the open act; explicitly cleared on close.
const stockCache = new Map<string, { at: number; ids: number[] }>();
const stockPending = new Map<string, Promise<number[]>>();
const catalogCache = new Map<string, number[]>();
const catalogPending = new Map<string, Promise<number[]>>();
let generation = 0;
let stockGeneration = 0;
const scope = () => typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData") || "";
let owner = scope();
export function invalidateEditorReferences(): void { generation++;stockGeneration++;pending.clear();cache.clear();stockCache.clear();stockPending.clear();catalogCache.clear();catalogPending.clear(); }
/** Quantities/prices do not change names. Stock catalogue changes affect only stock searches. */
export function invalidateEditorStockReferences(): void {
  stockGeneration++; stockCache.clear(); stockPending.clear();
  catalogCache.clear(); catalogPending.clear();
  for (const key of cache.keys()) if (JSON.parse(key).p_voice) cache.delete(key);
  for (const key of pending.keys()) if (JSON.parse(key).p_voice) pending.delete(key);
}
export async function readEditorReferences(input: EditorReferenceQuery, stockRetries = 1): Promise<EditorReference[]> {
  const actor = scope();
  if (actor !== owner) { invalidateEditorReferences();owner=actor; }
  const args={p_query:(input.query || "").trim().toLowerCase(),p_names:input.names || [],p_work_ids:input.workIds || [],p_detail_ids:input.detailIds || [],p_voice:input.voice || false};
  const key=JSON.stringify(args),hit=cache.get(key);
  if(hit && Date.now()-hit.at<CACHE_TTL) return structuredClone(hit.rows);
  const plain = !args.p_voice && !args.p_names.length && !args.p_work_ids.length && !args.p_detail_ids.length;
  if (plain && args.p_query.length >= 3) {
    for (const [parentKey, entry] of cache) {
      const parent = JSON.parse(parentKey) as typeof args;
      if (Date.now()-entry.at >= CACHE_TTL || parent.p_voice || parent.p_names.length || parent.p_work_ids.length || parent.p_detail_ids.length ||
          parent.p_query.length < 3 || !args.p_query.startsWith(parent.p_query)) continue;
      // A 50-row kind may be truncated. Only complete responses are safe to refine locally.
      if (["work", "detail", "shop"].some(kind => entry.rows.filter(row => row.kind === kind).length >= 50)) continue;
      return structuredClone(entry.rows.filter(row => row.name.toLowerCase().includes(args.p_query) ||
        (row.kind === "work" && row.id.toLowerCase().includes(args.p_query))));
    }
  }
  let request=pending.get(key);
  if(!request){
    const started=generation, stockStarted=stockGeneration;
    request=(async()=>{
      const {data,error}=await supabase.rpc("traffic_editor_references",args);
      if(error) throw error;
      if(!Array.isArray(data) || data.some(row=>!['work','detail','stock','shop'].includes(row.kind)||typeof row.id!=='string'||typeof row.name!=='string')) throw new Error("Некоректні підказки редактора");
      if(started!==generation || actor!==scope()) throw new Error("Контекст довідника змінився. Повторіть пошук.");
      if(args.p_voice && stockStarted!==stockGeneration) {
        if(stockRetries > 0) return readEditorReferences(input, stockRetries - 1);
        throw new Error("Каталог складу оновлено. Повторіть пошук.");
      }
      cache.set(key,{at:Date.now(),rows:structuredClone(data)});

      return data;
    })();pending.set(key,request);
  }
  try{return structuredClone(await request)}finally{if(pending.get(key)===request)pending.delete(key)}
}

export async function readEditorStockNameIds(query: string, names: Map<number, string[]>, retries = 1): Promise<number[]> {
  const actor = scope();
  if (actor !== owner) { invalidateEditorReferences(); owner = actor; }
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const hit = stockCache.get(q);
  if (hit && Date.now()-hit.at < CACHE_TTL) return [...hit.ids];
  for (const [prefix, entry] of stockCache) {
    if (Date.now()-entry.at < CACHE_TTL && q.startsWith(prefix) && entry.ids.length < 50 && entry.ids.every(id => names.has(id))) {
      return entry.ids.filter(id => names.get(id)!.some(value => value.toLowerCase().includes(q)));
    }
  }
  let request = stockPending.get(q);
  if (!request) {
    const started = stockGeneration, scopeStarted = generation;
    request = (async () => {
      const { data, error } = await supabase.rpc("traffic_editor_name_ids", { p_query: q });
      if (error) throw error;
      if (!Array.isArray(data) || data.length > 50 || data.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error("Некоректна відповідь пошуку складу");
      if (scopeStarted !== generation || actor !== scope()) throw new Error("Контекст довідника змінився. Повторіть пошук.");
      if (started !== stockGeneration) {
        if (retries > 0) return readEditorStockNameIds(query, names, retries - 1);
        throw new Error("Каталог складу оновлено. Повторіть пошук.");
      }
      const ids = data.map(Number);
      stockCache.set(q, { at: Date.now(), ids });

      return ids;
    })();
    stockPending.set(q, request);
  }
  try { return [...await request]; }
  finally { if (stockPending.get(q) === request) stockPending.delete(q); }
}
/** Complete ID results are reused across repeated focus/input until a catalog event or actor change. */
export async function readEditorCatalogIds(query: string, byName: boolean, retries = 1): Promise<number[]> {
  const actor = scope();
  if (actor !== owner) { invalidateEditorReferences(); owner = actor; }
  const q = query.trim().toLocaleLowerCase("uk-UA");
  if (!q) return [];
  const key = JSON.stringify([q, byName]);
  const cachedIds = catalogCache.get(key);
  if (cachedIds) return [...cachedIds];
  let request = catalogPending.get(key);
  if (!request) {
    const started = generation, stockStarted = stockGeneration;
    request = (async () => {
      const ids: number[] = [];
      let after: number | null = null;
      do {
        const { data, error }: { data: any; error: any } = await supabase.rpc("traffic_editor_stock_search", {
          p_query: q, p_by_name: byName, p_after: after,
        });
        if (error) throw error;
        if (started !== generation || actor !== scope()) throw new Error("Контекст довідника змінився. Повторіть пошук.");
        if (stockStarted !== stockGeneration) {
          if (retries > 0) return readEditorCatalogIds(query, byName, retries - 1);
          throw new Error("Каталог складу оновлено. Повторіть пошук.");
        }
        if (!data || !Array.isArray(data.ids) || data.ids.length > 50 || typeof data.has_more !== "boolean" ||
            data.ids.some((id: unknown, index: number) => !Number.isSafeInteger(Number(id)) || Number(id) <= (index ? Number(data.ids[index - 1]) : after ?? 0)) ||
            (data.has_more && (!data.ids.length || Number(data.next_cursor) !== Number(data.ids[data.ids.length - 1])))) {
          throw new Error("Некоректна сторінка підказок складу");
        }
        ids.push(...data.ids.map(Number));
        // Preserve all batches for a selected name; typed catalogue suggestions remain capped at 50.
        if (!byName || !data.has_more) break;
        after = Number(data.next_cursor);
      } while (true);
      if (catalogCache.size >= 100) catalogCache.delete(catalogCache.keys().next().value!);
      catalogCache.set(key, ids);
      return ids;
    })();
    catalogPending.set(key, request);
  }
  try { return [...await request]; }
  finally { if (catalogPending.get(key) === request) catalogPending.delete(key); }
}
if(typeof window!=="undefined"){
  supabase.auth.onAuthStateChange(invalidateEditorReferences);
  window.addEventListener('sto:stock-catalog-updated',invalidateEditorStockReferences);
  document.addEventListener('other-base-data-updated',invalidateEditorReferences);
}
