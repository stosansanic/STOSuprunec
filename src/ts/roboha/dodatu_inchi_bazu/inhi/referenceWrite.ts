import { supabase } from "../../../vxid/supabaseClient";
import { invalidateStockReads } from "./stockReadRevision";
export interface ReferenceInput { key: string; kind: "shops"|"details"; name: string; id?: number }
export interface ReferenceResult extends ReferenceInput { id: number; canonical: string; status: "created"|"existing"|"ambiguous" }
/** One transaction per <=100 names. Missing migration never falls back to racing INSERTs. */
export async function resolveStockReferences(items: ReferenceInput[], client=supabase): Promise<ReferenceResult[]> {
  if(items.length>100) throw new Error("За один запит дозволено до 100 назв");
  if(!items.length)return [];
  const {data,error}=await client.rpc("stock_resolve_references",{p_items:items});
  if(error) throw error;
  invalidateStockReads();
  if(!Array.isArray(data)||data.length!==items.length)throw new Error("Неповний результат створення назв. Повторіть перевірку.");
  const byKey=new Map(data.map(row=>[row.key,row]));
  for(const input of items) {
    const row=byKey.get(input.key);
    if(!row||row.kind!==input.kind||row.name!==input.name.trim()||!Number.isSafeInteger(Number(row.id))||Number(row.id)<=0||typeof row.canonical!=="string"||!["existing","created","ambiguous"].includes(row.status))throw new Error("Некоректний результат визначення назв");
    row.id=Number(row.id);
  }
  return items.map(item=>byKey.get(item.key));
}
