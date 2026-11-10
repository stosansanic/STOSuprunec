import { accountingIso, periodContains } from "./accountingPeriod";
import type { ShopReportFilter, ShopReportPage } from "./shopReportRead";
import type { PayrollReportFilters, PayrollReportPage } from "./payrollReportRead";
import { getPayrollPaymentState, getPayrollPaymentInPeriod } from "../../utils/payrollPayments";
import { payrollReportWork } from "./payrollReportFragments";

const containsText = (value: unknown, query: string) => String(value ?? "").toLowerCase().includes(query.toLowerCase());
const sameOrAll = (old: string, next: string) => !old || old === "all" || old === next;
const catalogKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Join already cached adjacent pieces even when the requested page size changed. */
export function cachedReportRange<P>(entries: Array<[string, P]>, actor: string, filter: unknown, offset: number, limit: number,
  length: (page: P) => number, total: (page: P) => number, signature: (page: P) => string): Array<{page: P; from: number; count: number}> | null {
  const key = JSON.stringify(filter);
  const parts = entries.flatMap(([savedKey, page]) => {
    const [who, previous, start] = JSON.parse(savedKey);
    return who === actor && JSON.stringify(previous) === key ? [{start: Number(start), page}] : [];
  });
  const result: Array<{page: P; from: number; count: number}> = [];
  let cursor = offset, end = offset + limit, baseline: string | undefined;
  while (cursor < end) {
    const part = parts.filter(part => part.start <= cursor && part.start + length(part.page) > cursor)
      .sort((a,b) => b.start + length(b.page) - a.start - length(a.page))[0];
    if (!part) return null;
    const nextBaseline = JSON.stringify([total(part.page), signature(part.page)]);
    if (baseline !== undefined && baseline !== nextBaseline) return null;
    baseline = nextBaseline; end = Math.min(end, total(part.page));
    const count = Math.min(part.start + length(part.page), end) - cursor;
    if (count <= 0) return null;
    result.push({page: part.page, from: cursor - part.start, count}); cursor += count;
  }
  return result.length ? result : null;
}
export function shopFilterCovered(old: ShopReportFilter, next: ShopReportFilter): boolean {
  return old.dateMode === next.dateMode && periodContains(old, next) &&
    (!old.item || containsText(next.item, old.item)) && (!old.catalog || old.catalog === next.catalog) &&
    sameOrAll(old.status, next.status) && sameOrAll(old.payment, next.payment) && (old.warehouse === null || old.warehouse === next.warehouse);
}
export function filterShopPage(source: ShopReportPage, filter: ShopReportFilter, offset: number, limit = 100): ShopReportPage {
  const matches = source.items.filter(row => {
    const day = accountingIso(filter.dateMode === "close" ? row.dateClose : filter.dateMode === "paid" ? row.paymentDate : row.dateOpen);
    return day >= filter.from && day <= filter.to && containsText(row.item, filter.item) &&
      (!filter.catalog || containsText(row.catalog, filter.catalog) || (!!catalogKey(filter.catalog) && catalogKey(row.catalog || "").includes(catalogKey(filter.catalog)))) &&
      (filter.status === "all" || (filter.status === "closed") === !!row.isClosed) &&
      (filter.payment === "all" || (filter.payment === "paid") === !!row.isPaid);
  });
  const items = matches.filter(row => filter.warehouse === null || row.scladNomer === filter.warehouse);
  return { ...source, items: items.slice(offset, offset + limit), totalCount: items.length,
    totals: items.reduce((sum, row) => ({sale: sum.sale + (row.total || 0), purchase: sum.purchase + (row.purchasePrice || 0) * row.quantity, margin: sum.margin + (row.margin || 0)}), {sale: 0, purchase: 0, margin: 0}),
    warehouses: [...new Set<number>(matches.map(row => row.scladNomer).filter(Boolean))].sort((a,b) => a-b) };
}

function sameJsonValue(left: any, right: any): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
}

/** PostgreSQL JSONB may reorder object keys; array order and all values still must match. */
export function mergeHistoryRows<T extends {data: any}>(rows: T[], id: (row: T) => number): T[] | null {
  const merged = new Map<number, T>();
  for (const row of rows) {
    let target = merged.get(id(row));
    if (!target) { target = {...row, data: {...row.data, Історія: {}}}; merged.set(id(row), target); }
    for (const [day, entries] of Object.entries(row.data.Історія || {}) as [string, any[]][]) {
      const bucket: any[] = target.data.Історія[day] ||= [];
      for (const entry of entries) {
        const previous = bucket.find(value => String(value.Акт) === String(entry.Акт));
        if (previous && !sameJsonValue(previous, entry)) return null;
        if (!previous) bucket.push(entry);
      }
    }
  }
  return [...merged.values()];
}
export function payrollFilterCovered(old: PayrollReportFilters, next: PayrollReportFilters): boolean {
  return old.mode === next.mode && periodContains({from: old.from, to: old.to}, {from: next.from, to: next.to}) &&
    (!old.name || old.name === next.name) && (!old.act || old.act === next.act) && (!old.work || containsText(next.work, old.work)) &&
    ["payment", "status", "percentage"].every(key => sameOrAll(old[key], next[key]));
}
export function filterPayrollPage(source: PayrollReportPage, filters: PayrollReportFilters, offset: number, limit = 50): PayrollReportPage | null {
  const employees = new Map(source.employees.map(row => [row.slyusar_id, row.data]));
  const statuses = new Map(source.statuses.map(row => [String(row.actId), row]));
  const number = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const rows = [];
  for (const key of source.keys) {
    const [id, day, act, index] = key;
    const employee = employees.get(id);
    const entry = employee?.Історія?.[day]?.find((value: any) => String(value.Акт) === String(act));
    if (!entry) return null;
    const work = index === null ? null : payrollReportWork(entry, index);
    if (index !== null && !work) return null;
    const receiver = !work && Object.prototype.hasOwnProperty.call(entry, "СуммаРоботи");
    const payment = getPayrollPaymentState(work || entry, work ? entry : undefined);
    const periodPayment = getPayrollPaymentInPeriod(work || entry, work ? entry : undefined, filters.from, filters.to);
    const status = statuses.get(String(act));
    const closed = status ? status.isClosed : !!entry.ДатаЗакриття;
    const date = accountingIso(filters.mode === "paid" ? periodPayment.date : filters.mode === "close" ? (status ? status.dateOff : entry.ДатаЗакриття) : day);
    const workName = work ? String(work.Робота ?? "") : receiver ? "-" : "Запчастини";
    const parts = number(entry.СуммаЗапчастин), workSum = number(entry.СуммаРоботи);
    const revenue = work ? number(work.Ціна) * number(work.Кількість) : receiver ? workSum + parts : parts;
    const salary = payment.earned;
    if (!date || date < filters.from || date > filters.to || (filters.name && employee.Name !== filters.name) ||
      (filters.act && String(act) !== filters.act) || !containsText(workName, filters.work || "") ||
      (filters.payment === "paid" && !payment.isPaid) || (filters.payment === "unpaid" && payment.due <= 0) ||
      (filters.status !== "all" && (filters.status === "closed") !== closed)) continue;
    if (filters.percentage !== "all") {
      const percent = number(employee.ПроцентРоботи), actual = revenue > 0 ? salary / revenue * 100 : 0;
      if (!work || !salary || !percent || !(filters.percentage === "higher" ? actual > percent : actual < percent)) continue;
    }
    rows.push({key, revenue, salary, payment, periodPayment, date: filters.mode === "paid" ? date : accountingIso(day)});
  }
  rows.sort((a,b) => number(b.key[2]) - number(a.key[2]) || b.date.localeCompare(a.date) ||
    a.key[0] - b.key[0] || a.key[1].localeCompare(b.key[1]) || (a.key[3] ?? -1) - (b.key[3] ?? -1));
  return {...source, keys: rows.slice(offset, offset + limit).map(row => row.key), total: rows.length, has_more: rows.length > offset + limit,
    revenue: rows.reduce((sum,row) => sum + row.revenue,0), salary: rows.reduce((sum,row) => sum + row.salary,0),
    paidAmount: rows.reduce((sum,row) => sum + row.payment.paidAmount,0),
    due: rows.reduce((sum,row) => sum + row.payment.due,0),
    overpaid: rows.reduce((sum,row) => sum + row.payment.overpaid,0),
    paidInPeriod: rows.reduce((sum,row) => sum + row.periodPayment.amount,0)};
}
