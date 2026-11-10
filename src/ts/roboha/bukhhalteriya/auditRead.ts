import { supabase } from "../../vxid/supabaseClient";
import { accountingSearchScope } from "./accountingPeriod";
import { missingAccountingRpc } from "./accountingRequests";

export interface AuditFilter { category: string; user: string; role: string; from: string; to: string }
interface AuditPage { rows: any[]; more: boolean; users: string[]; roles: string[] }
const pages = new Map<string, AuditPage>();
const details = new Map<string, any>();
let owner = "";
let controller: AbortController | undefined;
export function cancelAuditRead(): void { controller?.abort(); }
function scope(): string {
  const next = accountingSearchScope();
  if (next !== owner) { cancelAuditRead(); pages.clear(); details.clear(); owner = next; }
  return next;
}
export function cachedAuditDetails(id: string): any { scope(); return details.get(id); }
export async function readAuditDetails(id: string): Promise<any> {
  const actor = scope();
  if (details.has(id)) return details.get(id);
  const {data, error} = await supabase.from("audit_logs").select("details").eq("id", id).single();
  if (error) throw error;
  if (actor !== scope()) throw new Error("Користувач або дані змінилися");
  details.set(id, data.details); while (details.size > 100) details.delete(details.keys().next().value!);
  return data.details;
}
export async function readAuditPage(filter: AuditFilter, force = false, more = false, limit = 50): Promise<AuditPage> {
  limit = Math.max(1, Math.min(200, Math.floor(limit)));
  const actor = scope(), key = JSON.stringify([actor, filter]);
  cancelAuditRead();
  const cached = force ? undefined : pages.get(key);
  if (cached && (!more || !cached.more)) return cached;
  const request = new AbortController(); controller = request;
  const last = more ? cached?.rows[cached.rows.length - 1] : undefined;
  const {data, error} = await supabase.rpc("traffic_audit_page", {p_filter: {...filter, page_size: limit}, p_before: last?.created_at || null, p_before_id: last?.id || null}).abortSignal(request.signal);
  request.signal.throwIfAborted();
  if (error) throw missingAccountingRpc("traffic_audit_page", error);
  if (data?.page_size !== limit) throw new Error('Оновіть SQL traffic_accounting_lazy_rows для підвантаження бухгалтерії.');
  if (!data || !Array.isArray(data.items) || data.items.length > limit || typeof data.has_more !== "boolean" || (data.has_more && data.items.length !== limit) || !Array.isArray(data.users) || !Array.isArray(data.roles)) throw new Error("Некоректна сторінка журналу");
  if (actor !== scope()) throw new Error("Дані змінилися. Повторіть пошук.");
  const page: AuditPage = {rows: more && cached ? [...cached.rows, ...data.items] : data.items, more: data.has_more,
    users: more && cached ? cached.users : data.users, roles: more && cached ? cached.roles : data.roles};
  pages.set(key, page); while (pages.size > 10) pages.delete(pages.keys().next().value!);
  return page;
}
