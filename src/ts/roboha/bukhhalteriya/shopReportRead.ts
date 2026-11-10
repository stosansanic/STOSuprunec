import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";
import { accountingSearchScope, requireAccountingPeriod } from "./accountingPeriod";
import { cachedReportRange, filterShopPage, mergeHistoryRows, shopFilterCovered } from "./reportCacheFilter";
import type { DetailPaymentReceipt } from './shopPaymentWrite';

export interface ShopReportFilter {
  dateMode: "open" | "close" | "paid";
  from: string; to: string; item: string; catalog: string;
  status: "all" | "open" | "closed";
  payment: "all" | "paid" | "unpaid";
  warehouse: number | null;
}
export interface ShopReportPage {
  revision: string;
  items: any[]; shops: Array<{shop_id: number; data: any}>;
  totalCount: number;
  totals: {sale: number; purchase: number; margin: number};
  warehouses: number[];
}
const pages = new Map<string, {at: number; value: ShopReportPage}>();
const controllers = new Map<string, AbortController>();
const pending = new Map<string, Promise<ShopReportPage>>();
let revision = 0;
let owner = "";
function scope(): string {
  return accountingSearchScope('shops');
}
export function invalidateShopReport(): void {
  revision++; controllers.forEach(c => c.abort()); controllers.clear(); pages.clear(); pending.clear();
}
/** A successful write changes the server revision; retain displayed rows in the UI,
 * but require a fresh report baseline before downloading another page. */
export function patchShopDetailPayments(_receipts: DetailPaymentReceipt[]): void {
  invalidateShopReport();
}
export async function readShopReportPage(filter: ShopReportFilter, offset = 0, force = false, client = supabase, limit = 100): Promise<ShopReportPage> {
  limit = Math.max(1, Math.min(200, Math.floor(limit)));
  filter = {...filter, ...requireAccountingPeriod(filter.from, filter.to)};
  const actor = scope();
  if (owner !== actor) { invalidateShopReport(); owner = actor; }
  if (force) invalidateShopReport();
  const key = JSON.stringify([actor, filter, offset, limit]);
  for (const [other, controller] of controllers) if (other !== key) { controller.abort(); controllers.delete(other); pending.delete(other); }
  const cached = pages.get(key);
  if (cached) return structuredClone(cached.value);
  const range = cachedReportRange([...pages].map(([key, value]) => [key, value.value]), actor, filter, offset, limit,
    page => page.items.length, page => page.totalCount, page => JSON.stringify([page.revision, page.totals]));
  if (range) {
    const shops = mergeHistoryRows(range.flatMap(part => part.page.shops), row => row.shop_id);
    const items = range.flatMap(part => part.page.items.slice(part.from, part.from + part.count));
    if (shops && new Set(items.map(row => row.rowId)).size === items.length) return structuredClone({...range[0].page, items, shops});
  }
  for (const [savedKey, saved] of pages) {
    const [savedActor, previous, start] = JSON.parse(savedKey);
    if (savedActor === actor && JSON.stringify(previous) === JSON.stringify(filter) && start <= offset &&
        start + saved.value.items.length >= Math.min(offset + limit, saved.value.totalCount)) {
      return structuredClone({...saved.value, items: saved.value.items.slice(offset - start, offset - start + limit)});
    }
  }
  // Reuse only a complete, contiguous result; a visible page is not the whole report.
  for (const [savedKey, saved] of pages) {
    const [savedActor, previous, start] = JSON.parse(savedKey) as [string, ShopReportFilter, number];
    if (savedActor !== actor || start !== 0 || !shopFilterCovered(previous, filter)) continue;
    const parts = [saved.value];
    for (let at = saved.value.items.length; at > 0 && at < saved.value.totalCount;) {
      const part = [...pages].find(([key]) => { const [who, filter, start] = JSON.parse(key); return who === actor && start === at && JSON.stringify(filter) === JSON.stringify(previous); })?.[1].value;
      if (!part || part.revision !== saved.value.revision || part.totalCount !== saved.value.totalCount || JSON.stringify(part.totals) !== JSON.stringify(saved.value.totals)) break;
      if (!part.items.length) break;
      parts.push(part);
      at += part.items.length;
    }
    const items = parts.flatMap(part => part.items);
    if (items.length !== saved.value.totalCount || new Set(items.map(row => row.rowId)).size !== items.length) continue;
    const shops = mergeHistoryRows(parts.flatMap(part => part.shops), row => row.shop_id);
    if (!shops) continue;
    const result = filterShopPage({...saved.value, items, shops}, filter, offset, limit);
    if (previous.warehouse !== null) result.warehouses = saved.value.warehouses;
    return structuredClone(result);
  }
  const active = pending.get(key);
  if (active) return structuredClone(await active);
  const generation = revision;
  const controller = new AbortController(); controllers.set(key, controller);
  const job = (async () => {
    const baseline = [...pages].find(([key]) => {
      const [who, savedFilter] = JSON.parse(key);
      return who === actor && JSON.stringify(savedFilter) === JSON.stringify(filter);
    })?.[1].value;
    const response = await client.rpc("traffic_shop_report_v4", {p_filter: filter, p_offset: offset, p_limit: limit,
      p_summary: !baseline, p_expected_revision: baseline?.revision ?? null}).abortSignal(controller.signal);
    controller.signal.throwIfAborted();
    if (response.error) throw missingAccountingRpc("traffic_shop_report_v4", response.error);
    const page = response.data as ShopReportPage;
    if (page && baseline) {
      if (page.revision !== baseline.revision) throw new Error('ACCOUNTING_REPORT_STALE');
      page.totalCount = baseline.totalCount; page.totals = structuredClone(baseline.totals); page.warehouses = [...baseline.warehouses];
    }
    if (!page || !/^[a-f0-9]{32}$/.test(page.revision || '') || !Array.isArray(page.items) || page.items.length > limit || !Array.isArray(page.shops) ||
        !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || page.items.length !== Math.max(0, Math.min(limit, page.totalCount - offset)) || !Array.isArray(page.warehouses) ||
        !page.totals || ![page.totals.sale,page.totals.purchase,page.totals.margin].every(Number.isFinite)) {
      throw new Error("Некоректна сторінка звіту магазинів");
    }
    if (scope() !== actor || revision !== generation) throw new Error("Звіт змінився: повторіть пошук");
    pages.set(key, {at: Date.now(), value: structuredClone(page)});
    while (pages.size > 200) pages.delete(pages.keys().next().value!);
    return page;
  })();
  pending.set(key, job);
  try { return structuredClone(await job); }
  finally { if (controllers.get(key) === controller) controllers.delete(key); if (pending.get(key) === job) pending.delete(key); }
}

export async function readShopReport(client = supabase): Promise<any[]> {
  const rows: any[] = [];
  let after: number | null = null;
  for (;;) {
    const response: { data: any; error: any } = await client.rpc("traffic_shop_report", { p_after: after });
    if (response.error) {
      if (after !== null || !["42883", "PGRST202"].includes(response.error.code)) throw response.error;
      for (let offset = 0; ; offset += 200) {
        const page = await client.from("shops").select("shop_id,data").order("shop_id").range(offset, offset + 199);
        if (page.error) throw page.error;
        if (!Array.isArray(page.data)) throw new Error("Некоректна історія магазинів");
        rows.push(...page.data);
        if (page.data.length < 200) return rows;
      }
    }
    const page: any = response.data;
    if (!page || !Array.isArray(page.items) || typeof page.has_more !== "boolean") throw new Error("Некоректна сторінка історії магазинів");
    rows.push(...page.items);
    if (!page.has_more) return rows;
    const next: number = Number(page.next_cursor);
    if (!Number.isSafeInteger(next) || next <= (after ?? 0) || page.items.length !== 200) throw new Error("Некоректний курсор історії магазинів");
    after = next;
  }
}

/** Legacy whole-act receipts also require a fresh resource revision. */
export function patchShopReportPayments(_shops: Array<{shopId?: number; Історія: Record<string, any[]>}>): void {
  invalidateShopReport();
}
