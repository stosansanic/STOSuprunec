import { supabase } from '../../vxid/supabaseClient';
import type { FinancialOverview, FinancialPeriodTotals } from './financialOverviewTypes';

const moneyFields: ReadonlyArray<keyof FinancialPeriodTotals> = [
  'turnover', 'workRevenue', 'partsRevenue', 'partsCost', 'workPayroll', 'partsPayroll',
  'payrollAccrued', 'grossEarnings', 'operatingExpenses', 'profit', 'settledReceipts',
  'payrollPaid', 'suppliersPaid', 'expensesPaid', 'totalPaid', 'netKnownMovement',
  'closedActs', 'avgCheck', 'excludedExpenses', 'excludedExpensesPaid',
];
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Reject incomplete server responses instead of displaying missing money as zero. */
export function validateFinancialOverview(value: any, from: string, to: string): asserts value is FinancialOverview {
  const totals = (row: any) => row && moneyFields.every(key => isNumber(row[key])) &&
    Number.isSafeInteger(row.closedActs) && row.closedActs >= 0;
  const employees = value?.employees;
  if (value?.formatVersion !== 1 || value.complete !== true || value.from !== from || value.to !== to ||
      !isDay(value.previousFrom) || !isDay(value.previousTo) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      typeof value.revision !== 'string' || !value.revision || !totals(value.current) || !totals(value.previous) ||
      !Array.isArray(employees) || !Number.isSafeInteger(value.employeeCount) || value.employeeCount < employees.length ||
      !employees.every((employee: any) => Number.isSafeInteger(employee.id) && employee.id > 0 &&
        typeof employee.name === 'string' && typeof employee.role === 'string' &&
        ['accrued', 'paidInPeriod', 'due', 'overpaid'].every(key => isNumber(employee[key]))) ||
      new Set(employees.map((employee: any) => employee.id)).size !== employees.length ||
      !Array.isArray(value.expenseCategories) || !value.expenseCategories.every((row: any) =>
        typeof row.category === 'string' && isNumber(row.accrued) && isNumber(row.paid) &&
        typeof row.included === 'boolean' && typeof row.cashIncluded === 'boolean') ||
      !Array.isArray(value.paymentChannels) || !value.paymentChannels.every((row: any) =>
        typeof row.method === 'string' && isNumber(row.incoming) && isNumber(row.outgoing)) ||
      value.balances?.basis !== 'reconstructed_current_records' || value.balances.asOf !== to ||
      !['receivables', 'suppliers', 'payroll', 'expenses', 'totalLiabilities', 'undatedAdvances'].every(key => isNumber(value.balances[key])) ||
      value.balances.cashBalance !== null || value.balances.freeCash !== null ||
      value.inventory?.asOf !== 'current' || !isNumber(value.inventory.value) || !Number.isSafeInteger(value.inventory.count) ||
      !Number.isFinite(Date.parse(value.inventory.measuredAt)) || typeof value.quality?.estimates !== 'boolean' ||
      !Array.isArray(value.quality.warnings) || !value.quality.warnings.every((warning: any) =>
        typeof warning.code === 'string' && typeof warning.message === 'string' && isNumber(warning.count) &&
        isNumber(warning.amount) && ['info', 'warning'].includes(warning.severity))) {
    throw new Error('Фінансове зведення повернуло неповні дані. Оновіть SQL фінансового зведення.');
  }
}

/** Explicit search revalidates one compact revision; tab changes require no request. */
export function createFinancialOverviewRead(client: Pick<typeof supabase, 'rpc'> = supabase) {
  const cache = new Map<string, FinancialOverview>();
  let owner = '';
  let generation = 0;
  let active: { key: string; controller: AbortController; promise: Promise<FinancialOverview> } | undefined;
  function cancel(): void { generation++; active?.controller.abort(); active = undefined; }
  function clear(): void { cancel(); cache.clear(); }
  return {
    cancel, clear,
    async read(from: string, to: string, actor: string, isCurrent: () => boolean = () => true): Promise<FinancialOverview> {
      if (!isDay(from) || !isDay(to) || from > to) throw new Error('Оберіть коректний період «Від» і «До».');
      if (owner !== actor) { clear(); owner = actor; }
      const key = JSON.stringify([from, to]);
      if (active?.key === key) return structuredClone(await active.promise);
      cancel();
      const requestGeneration = generation;
      const controller = new AbortController();
      const cached = cache.get(key);
      const promise = (async () => {
        const { data, error } = await client.rpc('traffic_financial_overview', {
          p_from: from, p_to: to, p_known_revision: cached?.revision ?? null,
        }).abortSignal(controller.signal);
        controller.signal.throwIfAborted();
        if (generation !== requestGeneration || owner !== actor || !isCurrent()) {
          throw new DOMException('Фінансовий звіт змінився під час завантаження.', 'AbortError');
        }
        if (error) {
          if (error.code === 'PGRST202') throw new Error('Встановіть financial-overview.sql у Supabase → SQL Editor, потім повторіть пошук.');
          throw new Error(error.message || 'Не вдалося завантажити фінансове зведення.');
        }
        if (data?.not_modified === true) {
          if (!cached || data.formatVersion !== 1 || data.revision !== cached.revision) {
            throw new Error('Не вдалося підтвердити актуальність фінансового звіту.');
          }
          return cached;
        }
        validateFinancialOverview(data, from, to);
        cache.delete(key);
        cache.set(key, data);
        while (cache.size > 8) cache.delete(cache.keys().next().value!);
        return data;
      })();
      active = { key, controller, promise };
      try { return structuredClone(await promise); }
      finally { if (active?.promise === promise) active = undefined; }
    },
  };
}
