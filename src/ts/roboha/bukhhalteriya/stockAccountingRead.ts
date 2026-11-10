import { supabase } from '../../vxid/supabaseClient';
import { accountingSearchScope, requireAccountingPeriod } from './accountingPeriod';
import { missingAccountingRpc } from './accountingRequests';

export interface StockAccountingFilter {
  from: string; to: string; dateMode: 'open' | 'paid';
  shop: string; bill: string; item: string; catalog: string;
  payment: number; availability: number; warehouse: number | null; requester: number | null;
  exclude: number[];
}
export interface StockAccountingSummary {
  totalCount: number; totalAmount: number; remainingAmount: number;
  payableCount: number; payableAmount: number; payableBaseline: string;
}
export interface StockAccountingCursor { day: string; id: number; filter: string }
export interface StockAccountingPage {
  items: Record<string, any>[]; next_cursor: StockAccountingCursor | null; has_more: boolean; revision: string;
  summary?: StockAccountingSummary;
  facets?: {warehouses: number[]; requesters: Array<{id: number; name: string}>};
}
export interface StockAccountingSuggestions {items: string[]; has_more: boolean}
const pages = new Map<string, StockAccountingPage>();
const suggestions = new Map<string, StockAccountingSuggestions>();
const pending = new Map<string, Promise<unknown>>();
const controllers = new Set<AbortController>();
const pageControllers = new Map<string, AbortController>();
let owner = '', generation = 0;

export function invalidateStockAccounting(): void {
  generation++; controllers.forEach(controller => controller.abort()); controllers.clear();
  pages.clear(); suggestions.clear(); pending.clear();
  pageControllers.clear();
}
export function cancelStockAccountingPages(): void {
  for (const [key, controller] of pageControllers) { controller.abort(); pending.delete(key); }
  pageControllers.clear();
}
function currentScope(): string {
  const scope = accountingSearchScope('stock');
  if (owner !== scope) { invalidateStockAccounting(); owner = scope; }
  return scope;
}
export function stockAccountingStale(error: unknown): boolean {
  return String((error as any)?.message || error).includes('ACCOUNTING_REPORT_STALE');
}
async function request<T>(key: string, rpc: string, args: Record<string, unknown>, validate: (value: any) => T): Promise<T> {
  const scope = currentScope(), version = generation;
  const active = pending.get(key);
  if (active) return structuredClone(await active as T);
  const controller = new AbortController(); controllers.add(controller);
  if (rpc === 'traffic_stock_accounting_page') pageControllers.set(key,controller);
  const job = (async () => {
    const {data, error} = await supabase.rpc(rpc, args).abortSignal(controller.signal);
    controller.signal.throwIfAborted();
    if (scope !== accountingSearchScope('stock') || version !== generation) throw new DOMException('Пошук змінився', 'AbortError');
    if (error) throw missingAccountingRpc(rpc, error);
    return validate(data);
  })();
  pending.set(key, job);
  try { return structuredClone(await job); }
  finally {
    controllers.delete(controller);
    if (pageControllers.get(key) === controller) pageControllers.delete(key);
    if (pending.get(key) === job) pending.delete(key);
  }
}
export async function readStockAccountingPage(filter: StockAccountingFilter, cursor: StockAccountingCursor | null = null,
  revision: string | null = null, limit = 40): Promise<StockAccountingPage> {
  filter = {...filter, ...requireAccountingPeriod(filter.from, filter.to)};
  const scope = currentScope(), version = generation;
  const key = JSON.stringify(['page', scope, filter, cursor, revision, limit]);
  const saved = pages.get(key);
  if (saved) return structuredClone(saved);
  const page = await request<StockAccountingPage>(key, 'traffic_stock_accounting_page', {
    p_filter: filter, p_cursor: cursor, p_limit: limit, p_include_summary: cursor === null, p_expected_revision: revision,
  }, value => {
    if (!value || !Array.isArray(value.items) || value.items.length > limit || typeof value.has_more !== 'boolean' ||
      typeof value.revision !== 'string' || (revision !== null && value.revision !== revision) ||
      value.items.some((row: any) => !Number.isSafeInteger(Number(row?.sclad_id)) || Number(row.sclad_id) <= 0) ||
      (value.has_more && (!value.next_cursor || !value.items.length || Number(value.next_cursor.id) !== Number(value.items[value.items.length-1].sclad_id))))
      throw new Error('Некоректна сторінка бухгалтерського складу');
    if (cursor === null && (!value.summary || !Number.isSafeInteger(value.summary.totalCount) || value.summary.totalCount < value.items.length ||
      ![value.summary.totalAmount,value.summary.remainingAmount,value.summary.payableCount,value.summary.payableAmount].every(Number.isFinite) ||
      !/^[a-f0-9]{32}$/.test(value.summary.payableBaseline) || !Array.isArray(value.facets?.warehouses) || !Array.isArray(value.facets?.requesters)))
      throw new Error('Некоректні підсумки бухгалтерського складу');
    return value;
  });
  if (generation === version && scope === accountingSearchScope('stock')) {
    pages.set(key, structuredClone(page));
    while (pages.size > 150) pages.delete(pages.keys().next().value!);
  }
  return page;
}
export async function readStockAccountingSuggestions(filter: StockAccountingFilter, field: 'bill' | 'item' | 'catalog', query: string,
  itemExact: string | null = null, after: string | null = null): Promise<StockAccountingSuggestions> {
  filter = {...filter, ...requireAccountingPeriod(filter.from, filter.to)};
  const scope = currentScope(), version = generation;
  const hintFilter = {from: filter.from, to: filter.to, dateMode: filter.dateMode, shop: filter.shop};
  const key = JSON.stringify(['suggest',scope,hintFilter,field,query,itemExact,after]);
  const saved = suggestions.get(key); if (saved) return structuredClone(saved);
  const value = await request<StockAccountingSuggestions>(key,'traffic_stock_accounting_suggest',{
    p_filter: hintFilter,p_field: field,p_query: query,p_item_exact: itemExact,p_after: after,
  }, value => {
    if (!value || !Array.isArray(value.items) || value.items.length > 50 || value.items.some((item: unknown) => typeof item !== 'string') || typeof value.has_more !== 'boolean')
      throw new Error('Некоректні підказки складу');
    return value;
  });
  if (generation === version && scope === accountingSearchScope('stock')) {
    suggestions.set(key, structuredClone(value));
    while (suggestions.size > 80) suggestions.delete(suggestions.keys().next().value!);
  }
  return value;
}

