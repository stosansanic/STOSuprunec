import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";
import { accountingSearchScope, requireAccountingPeriod } from "./accountingPeriod";
import { cachedReportRange, filterPayrollPage, payrollFilterCovered } from "./reportCacheFilter";
import { mergePayrollReportEmployees, validatePayrollReportFragments } from "./payrollReportFragments";
import type { ActAccountingStatus } from "./actAccountingStatus";

export interface PayrollReportPage {
  revision: string;
  employees: Array<{ slyusar_id: number; data: any }>;
  keys: Array<[number, string, string, number | null]>;
  statuses: ActAccountingStatus[];
  total: number; revenue: number; salary: number; has_more: boolean;
  paidAmount: number; due: number; overpaid: number; paidInPeriod: number;
  acts: string[]; works: string[];
}
export type PayrollReportFilters = Record<string, string>;
const options = new Map<string, {acts: string[]; works: string[]}>();
const controllers = new Map<string, AbortController>();
const pending = new Map<string, Promise<PayrollReportPage>>();
const cache = new Map<string, { at: number; page: PayrollReportPage }>();
let generation = 0;
let cacheOwner = "";
export function clearPayrollReportCache(): void { generation++; controllers.forEach(c => c.abort()); controllers.clear(); options.clear(); pending.clear(); cache.clear(); }
function owner(): string { return accountingSearchScope('payroll'); }
const payrollTotals = (page: PayrollReportPage) => JSON.stringify([
  page.revision, page.revenue, page.salary, page.paidAmount, page.due, page.overpaid, page.paidInPeriod,
]);
export async function readPayrollReport(filters: PayrollReportFilters, offset = 0, client: Pick<typeof supabase, "rpc"> = supabase, limit = 50): Promise<PayrollReportPage> {
  limit = Math.max(1, Math.min(200, Math.floor(limit)));
  filters = {...filters, ...requireAccountingPeriod(filters.from, filters.to)};
  const actor = owner();
  if (actor !== cacheOwner) { clearPayrollReportCache(); cacheOwner = actor; }
  const version = generation;
  const key = JSON.stringify([actor, filters, offset, limit]);
  for (const [other, controller] of controllers) if (other !== key) { controller.abort(); controllers.delete(other); pending.delete(other); }
  const cached = cache.get(key);
  if (cached) return structuredClone(cached.page);
  const range = cachedReportRange([...cache].map(([key, value]) => [key, value.page]), actor, filters, offset, limit,
    page => page.keys.length, page => page.total, payrollTotals);
  if (range) {
    const employees = mergePayrollReportEmployees(range.flatMap(part => part.page.employees));
    const keys = range.flatMap(part => part.page.keys.slice(part.from, part.from + part.count));
    if (employees && new Set(keys.map(key => JSON.stringify(key))).size === keys.length) return structuredClone({...range[0].page,
      keys, employees, statuses: [...new Map(range.flatMap(part => part.page.statuses).map(row => [String(row.actId), row])).values()],
      has_more: offset + keys.length < range[0].page.total});
  }
  for (const [savedKey, saved] of cache) {
    const [savedActor, previous, start] = JSON.parse(savedKey);
    if (savedActor === actor && JSON.stringify(previous) === JSON.stringify(filters) && start <= offset &&
        start + saved.page.keys.length >= Math.min(offset + limit, saved.page.total)) {
      return structuredClone({...saved.page, keys: saved.page.keys.slice(offset - start, offset - start + limit), has_more: offset + limit < saved.page.total});
    }
  }
  for (const [savedKey, saved] of cache) {
    const [savedActor, previous, start] = JSON.parse(savedKey) as [string, PayrollReportFilters, number];
    if (savedActor !== actor || start !== 0 || !payrollFilterCovered(previous, filters)) continue;
    const parts = [saved.page];
    for (let at = saved.page.keys.length; at > 0 && at < saved.page.total;) {
      const part = [...cache].find(([key]) => { const [who, filter, start] = JSON.parse(key); return who === actor && start === at && JSON.stringify(filter) === JSON.stringify(previous); })?.[1].page;
      if (!part || part.total !== saved.page.total || payrollTotals(part) !== payrollTotals(saved.page)) break;
      if (!part.keys.length) break;
      parts.push(part);
      at += part.keys.length;
    }
    const keys = parts.flatMap(part => part.keys);
    if (keys.length !== saved.page.total || new Set(keys.map(key => JSON.stringify(key))).size !== keys.length) continue;
    const employees = mergePayrollReportEmployees(parts.flatMap(part => part.employees));
    if (!employees) continue;
    const statuses = [...new Map(parts.flatMap(part => part.statuses).map(row => [row.actId, row])).values()];
    const result = filterPayrollPage({...saved.page, keys, employees, statuses}, filters, offset, limit);
    if (result) return structuredClone(result);
  }
  let request = pending.get(key);
  if (!request) {
    const controller = new AbortController(); controllers.set(key, controller);
    request = (async () => {
      const optionsKey = JSON.stringify([actor, filters.from, filters.to, filters.mode, filters.name]);
      let savedOptions = options.get(optionsKey);
      const baseline = [...cache].find(([key]) => {
        const [who, savedFilters] = JSON.parse(key);
        return who === actor && JSON.stringify(savedFilters) === JSON.stringify(filters);
      })?.[1].page;
      if (!baseline) savedOptions = undefined;
      const {data, error}: any = await client.rpc('traffic_payroll_report_v4', {p_filters: {...filters, page_size: limit}, p_offset: offset,
        p_options: !savedOptions, p_summary: !baseline, p_expected_revision: baseline?.revision ?? null}).abortSignal(controller.signal);
      controller.signal.throwIfAborted();
      if (error && ['PGRST202','42883'].includes(error.code)) throw missingAccountingRpc('traffic_payroll_report_v4', error);
      if (data && baseline) {
        if (data.revision !== baseline.revision) throw new Error('ACCOUNTING_REPORT_STALE');
        for (const key of ['total','revenue','salary','paidAmount','due','overpaid','paidInPeriod'] as const) data[key] = baseline[key];
      }
      if (data && savedOptions) Object.assign(data, savedOptions);
      if (error) {
        // PostgREST errors are plain objects; String(error) hid the server reason as [object Object].
        const reason = typeof error.message === "string" ? error.message : "Невідома помилка сервера";
        const code = typeof error.code === "string" ? error.code : "";
        throw Object.assign(new Error(`Не вдалося завантажити зарплату${code ? ` (${code})` : ""}: ${reason}`), {
          code: error.code, details: error.details, hint: error.hint,
        });
      }
      if (owner() !== actor || version !== generation) throw new Error("Дані зарплати змінилися. Повторіть пошук.");
      if (data?.format_version !== 4 || data?.page_size !== limit || !/^[a-f0-9]{32}$/.test(data?.revision || '')) throw new Error('Оновіть SQL бухгалтерії для підвантаження зарплати.');
      if (data && ["paidAmount", "due", "overpaid", "paidInPeriod"].some(field =>
        typeof data[field] !== "number" || !Number.isFinite(data[field]) || data[field] < 0)) {
        throw new Error("Оновіть SQL traffic_payroll_payments для обліку виплат, доплат і переплат зарплати.");
      }
      if (!data || !Array.isArray(data.employees) || !Array.isArray(data.keys) || data.keys.length > limit ||
          !Array.isArray(data.statuses) || !Array.isArray(data.acts) || !Array.isArray(data.works) ||
          !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isFinite(data.revenue) || !Number.isFinite(data.salary) ||
          typeof data.has_more !== "boolean" || (data.has_more && data.keys.length !== limit)) throw new Error("Некоректна сторінка зарплати");
      validatePayrollReportFragments(data.employees, data.keys);
      if (!savedOptions) { options.set(optionsKey, {acts: data.acts, works: data.works}); while (options.size > 20) options.delete(options.keys().next().value!); }
      cache.delete(key); cache.set(key, { at: Date.now(), page: data });
      while (cache.size > 200) cache.delete(cache.keys().next().value!);
      return data as PayrollReportPage;
    })();
    pending.set(key, request);
    void request.finally(() => { if (controllers.get(key) === controller) controllers.delete(key); if (pending.get(key) === request) pending.delete(key); }).catch(() => {});
  }
  return structuredClone(await request);
}

// Full reads require an explicit export or mass-payment action.
export async function readAllPayrollReport(filters: PayrollReportFilters, client: Pick<typeof supabase, "rpc"> = supabase, fresh = true,
  checkPage?: (page: PayrollReportPage) => void): Promise<PayrollReportPage> {
  // Payment must refresh its baselines; export may reuse the same report as the screen.
  if (fresh) clearPayrollReportCache();
  const actor = owner();
  const first = await readPayrollReport(filters, 0, client);
  checkPage?.(first);
  const result = structuredClone(first);
  let employees: PayrollReportPage['employees'] = [];
  const merge = (page: PayrollReportPage) => {
    const merged = mergePayrollReportEmployees([...employees, ...page.employees]);
    if (!merged) throw new Error("Зарплата змінилася під час завантаження. Повторіть пошук.");
    employees = merged;
  };
  merge(first);
  for (let offset = 50; result.has_more; offset += 50) {
    if (owner() !== actor) throw new Error("Користувач змінився. Повторіть пошук.");
    const page = await readPayrollReport(filters, offset, client);
    if (page.total !== first.total || payrollTotals(page) !== payrollTotals(first)) throw new Error("Зарплата змінилася під час завантаження. Повторіть пошук.");
    checkPage?.(page);
    merge(page); result.keys.push(...page.keys); result.statuses.push(...page.statuses); result.has_more = page.has_more;
  }
  if (new Set(result.keys.map(key => JSON.stringify(key))).size !== first.total || result.keys.length !== first.total) throw new Error("Неповний звіт зарплати. Повторіть пошук.");
  result.employees = employees;
  if (owner() !== actor) throw new Error("Користувач змінився. Повторіть пошук.");
  return result;
}

export function patchPayrollReportPayments(_employees: Array<{id: number; data: any}>): void {
  // Other pages must not be reused after a payment changes membership/offsets.
  clearPayrollReportCache();
}

/** Apply an acknowledged payment to the loaded prefix without fetching history.
 * Whole-period totals change only by the contribution of these exact keys.
 */
export function reconcilePayrollReportPayments(
  previous: PayrollReportPage, employees: Array<{slyusar_id: number; data: any}>, filters: PayrollReportFilters,
): PayrollReportPage {
  const before = filterPayrollPage(previous, filters, 0, previous.keys.length);
  const source = {...previous, employees: structuredClone(employees)};
  const after = filterPayrollPage(source, filters, 0, previous.keys.length);
  if (!before || !after || before.keys.length !== previous.keys.length) {
    throw new Error('Не вдалося звірити завантажені виплати. Повторіть пошук.');
  }
  // The target receipt proves these local edits, not a new whole-report snapshot.
  const next = {...source, revision: "", keys: after.keys, total: previous.total + after.total - before.total};
  for (const field of ['revenue', 'salary', 'paidAmount', 'due', 'overpaid', 'paidInPeriod'] as const) {
    const value = previous[field] + after[field] - before[field];
    if (!Number.isFinite(value) || value < -0.000001) throw new Error('Підсумки зарплати змінилися. Повторіть пошук.');
    next[field] = Math.max(0, Math.round(value * 100000000) / 100000000);
  }
  next.has_more = next.keys.length < next.total;
  return next;
}
