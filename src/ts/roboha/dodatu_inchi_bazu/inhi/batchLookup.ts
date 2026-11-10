import { supabase } from "../../../vxid/supabaseClient";
import { stockSuggestionRevision as stockReadRevision } from "./stockReadRevision";
let lookupSession = 0;
const clearSessionCaches = new Set<() => void>();
export type BatchLookupKind = "shops" | "details" | "catalogs" | "acts";
export interface BatchLookupPage { items: Array<{ value: string; name?: string; label?: string; date_off?: string | null }>; has_more: boolean }
// Must match the bounded page returned by traffic_batch_suggestions.
const BATCH_LOOKUP_PAGE_SIZE = 20;
export function createBatchLookup(client = supabase, now = Date.now, revision = stockReadRevision, signal?: AbortSignal) {
  const entries = new Map<string, { until: number; request: Promise<BatchLookupPage> }>();
  const complete = new Map<string, {until:number; page:BatchLookupPage}>();
  const loadedPages = new Map<string, Map<number, BatchLookupPage>>();
  let scope = "";
  const clear = () => { entries.clear(); complete.clear(); loadedPages.clear(); };
  clearSessionCaches.add(clear);
  signal?.addEventListener("abort", () => { clear(); clearSessionCaches.delete(clear); }, { once: true });
  return async (kind: BatchLookupKind, query: string, offset = 0, exact = false): Promise<BatchLookupPage> => {
    if (signal?.aborted) throw new Error("Вікно підказок закрито");
    const current = JSON.stringify([lookupSession,revision(), typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData")]);
    if (current !== scope) { scope = current; clear(); }
    query = query.trim();
    if (!exact) query = query.toLowerCase();
    const catalogKey = (v:string) => v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!exact && kind !== "acts") {
      for (const [savedKey, saved] of complete) {
        const [savedKind, prefix] = JSON.parse(savedKey);
        if (savedKind !== kind || saved.until <= now() || !query.startsWith(prefix)) continue;
        if (kind === "catalogs" && prefix && (!catalogKey(prefix) || !catalogKey(query).startsWith(catalogKey(prefix)))) continue;
        const matches = saved.page.items.filter(item => item.value.toLowerCase().includes(query) ||
          (kind === "catalogs" && !!catalogKey(query) && catalogKey(item.value).includes(catalogKey(query))));
        return structuredClone({items:matches.slice(offset, offset + BATCH_LOOKUP_PAGE_SIZE),
          has_more:matches.length > offset + BATCH_LOOKUP_PAGE_SIZE});
      }
    }
    const key = JSON.stringify([kind,query,offset,exact]);
    let entry = entries.get(key);
    if (!entry || entry.until <= now()) {
      const request = (async () => {
        const queryRequest = client.rpc("traffic_batch_suggestions",{p_kind:kind,p_query:query.trim(),p_offset:offset,p_exact:exact});
        const {data,error} = await (signal ? queryRequest.abortSignal(signal) : queryRequest);
        if (error) throw error;
        if (!data || !Array.isArray(data.items) || data.items.some((v:any)=>typeof v?.value !== "string") || typeof data.has_more !== "boolean") throw new Error("Некоректні підказки складу");
        return data as BatchLookupPage;
      })();
      entry = {until:Infinity,request}; entries.set(key,entry);
    }
    try {
      const result = await entry.request;
      if (signal?.aborted) throw new Error("Вікно підказок закрито");
      if (current !== JSON.stringify([lookupSession,revision(), typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData")])) throw new Error("Довідник змінився. Повторіть запит.");
      if (!exact && kind !== "acts" && entries.get(key) === entry) {
        const queryKey = JSON.stringify([kind,query]);
        let pages = loadedPages.get(queryKey);
        if (!pages) { pages = new Map(); loadedPages.set(queryKey, pages); }
        pages.set(offset, structuredClone(result));
        // A partial list must never be used to rule out matches. Only reuse a
        // broader search after the user has loaded every contiguous page.
        const items: BatchLookupPage["items"] = [];
        let cursor = 0;
        while (pages.has(cursor)) {
          const page = pages.get(cursor)!;
          items.push(...page.items);
          if (!page.has_more) {
            complete.set(queryKey, {until:entry.until,page:{items,has_more:false}});
            break;
          }
          if (!page.items.length) break;
          cursor += page.items.length;
        }
      }
      return structuredClone(result);
    } catch(error) { if(entries.get(key)===entry) entries.delete(key); throw error; }
  };
}
export const readBatchLookup = createBatchLookup();
/** Coalesce all OCR row lookups in one render turn into <=100 unique catalogs. */
export function createInvoiceCatalogReader(client=supabase, now=Date.now, revision=stockReadRevision, signal?: AbortSignal) {
  const cache=new Map<string,{until:number;promise:Promise<string[]>}>();
  let scope='', scheduled=false;
  let queue=new Map<string,{resolve:(names:string[])=>void;reject:(error:unknown)=>void}>();
  const clear = () => { cache.clear(); for(const request of queue.values()) request.reject(new Error("Вікно складу закрито")); queue.clear(); };
  clearSessionCaches.add(clear);
  signal?.addEventListener("abort", () => { clear(); clearSessionCaches.delete(clear); }, { once: true });
  const currentScope=()=>JSON.stringify([lookupSession,revision(),typeof localStorage==='undefined'?'':localStorage.getItem('userAuthData')]);
  const flush=async()=>{
    scheduled=false;const requests=queue;queue=new Map();const captured=scope;
    const catalogs=[...requests.keys()];
    try {
      const names=new Map<string,Set<string>>(catalogs.map(value=>[value,new Set()]));
      for(let start=0;start<catalogs.length;start+=100) {
        const chunk=catalogs.slice(start,start+100);
        for(let offset=0;;offset+=200) {
          if(signal?.aborted || captured!==currentScope()) throw new Error('Зіставлення скасовано');
          const queryRequest=client.rpc('traffic_invoice_catalogs',{p_catalogs:chunk,p_offset:offset});
          const {data,error}=await (signal ? queryRequest.abortSignal(signal) : queryRequest);
          if(error)throw error;
          if(!data||!Array.isArray(data.items)||typeof data.has_more!=='boolean')throw new Error('Некоректне зіставлення каталогів');
          for(const row of data.items){if(!names.has(row.catalog)||typeof row.name!=='string')throw new Error('Некоректний каталог');names.get(row.catalog)!.add(row.name);}
          if(!data.has_more)break;
          if(data.items.length!==200)throw new Error('Неповне зіставлення каталогів');
        }
      }
      if(signal?.aborted || captured!==currentScope())throw new Error('Склад змінився. Повторіть зіставлення.');
      for(const [catalog,request] of requests)request.resolve([...names.get(catalog)!]);
    }catch(error){for(const [catalog,request] of requests){if(scope===captured)cache.delete(catalog);request.reject(error);}}
  };
  return (catalog:string):Promise<string[]>=>{
    if(signal?.aborted)return Promise.reject(new Error('Вікно накладної закрито'));
    catalog=catalog.trim();if(!catalog)return Promise.resolve([]);
    const current=currentScope();
    if(scope!==current){for(const request of queue.values())request.reject(new Error('Склад змінився'));queue.clear();cache.clear();scope=current;}
    const hit=cache.get(catalog);if(hit&&hit.until>now())return hit.promise.then(names=>[...names]);
    const promise=new Promise<string[]>((resolve,reject)=>queue.set(catalog,{resolve,reject}));
    cache.set(catalog,{until:Infinity,promise});
    if(!scheduled){scheduled=true;queueMicrotask(()=>void flush());}
    return promise.then(names=>[...names]);
  };
}
export const readBatchCatalogNames=createInvoiceCatalogReader();

const actChecks = new Map<string, { until: number; rows: Array<{ act_id: number; date_off: string | null }> }>();
let actScope = "";
export async function readBatchActValidity(values: string[], force = false): Promise<Array<{ act_id: number; date_off: string | null }>> {
  const scope=JSON.stringify([lookupSession,stockReadRevision(), localStorage.getItem("userAuthData")]);
  if(scope!==actScope) {actScope=scope;actChecks.clear();}
  const ids=[...new Set(values.filter(value=>/^[1-9]\d*$/.test(value)))].sort();
  const key=JSON.stringify(ids), hit=actChecks.get(key);
  if(!force && hit && hit.until>Date.now()) return structuredClone(hit.rows);
  const rows:Array<{act_id:number;date_off:string|null}>=[];
  for(let offset=0;offset<ids.length;offset+=200) {
    const {data,error}=await supabase.from('acts').select('act_id,date_off').in('act_id',ids.slice(offset,offset+200));
    if(error) throw error;
    rows.push(...(data||[]));
  }
  if(scope!==JSON.stringify([lookupSession,stockReadRevision(),localStorage.getItem("userAuthData")])) throw new Error('Акти змінилися. Повторіть перевірку.');
  actChecks.set(key,{until:Infinity,rows:structuredClone(rows)});
  while(actChecks.size>20) actChecks.delete(actChecks.keys().next().value!);
  return rows;
}

type ReferenceCheck = {kind:'shops'|'details';name:string;id:number|null};
const referenceChecks = new Map<string,{until:number;promise:Promise<ReferenceCheck>}>();
let referenceScope = '';
export async function readBatchReferenceValidity(items:Array<{kind:'shops'|'details';name:string}>): Promise<ReferenceCheck[]> {
  const unique=[...new Map(items.filter(x=>x.name.trim()).map(x=>[JSON.stringify(x),x])).values()];
  const scope=JSON.stringify([lookupSession,stockReadRevision(),localStorage.getItem('userAuthData')]);
  if (scope !== referenceScope) {referenceScope=scope;referenceChecks.clear();}
  const keyOf=(x:{kind:string;name:string})=>JSON.stringify([x.kind,x.name]);
  const needed=unique.filter(x=>!referenceChecks.has(keyOf(x))||referenceChecks.get(keyOf(x))!.until<=Date.now());
  for(let offset=0;offset<needed.length;offset+=100){
    const batch=needed.slice(offset,offset+100);
    const request=(async()=>{
      const {data,error}=await supabase.rpc('traffic_reference_ids',{p_items:batch});
      if(error)throw error;
      if(!Array.isArray(data))throw new Error('Некоректна перевірка назв');
      return data as ReferenceCheck[];
    })();
    for(const item of batch){
      const key=keyOf(item);
      const promise=request.then(rows=>{
        const row=rows.find(row=>row.kind===item.kind&&row.name===item.name);
        if(!row)throw new Error('Неповна перевірка назв');return row;
      });
      const entry={until:Infinity,promise};referenceChecks.set(key,entry);
      void promise.catch(()=>{if(referenceChecks.get(key)===entry)referenceChecks.delete(key);});
    }
  }
  const result=await Promise.all(unique.map(x=>referenceChecks.get(keyOf(x))!.promise));
  if(scope!==JSON.stringify([lookupSession,stockReadRevision(),localStorage.getItem('userAuthData')]))throw new Error('Довідники змінилися. Повторіть перевірку.');

  return structuredClone(result);
}

export function invalidateBatchLookupCaches(): void {
  lookupSession++;
  for (const clear of clearSessionCaches) clear();
  actChecks.clear(); referenceChecks.clear();
}
