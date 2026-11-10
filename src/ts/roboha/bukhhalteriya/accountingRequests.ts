import { nextAccountingDay, periodContains, type AccountingPeriod } from "./accountingPeriod";

export function missingAccountingRpc(name: string, error: any): Error {
  if (error?.code === "PGRST202" && /^traffic_(stock|profit)_accounting_/.test(name))
    return new Error("Потрібно оновити бухгалтерію в базі даних: виконайте accounting-pages.sql у Supabase → SQL Editor, потім повторіть пошук.");
  if (error?.code === "PGRST202")
    return new Error(`Для цього звіту встановіть SQL-функцію ${name}. Оновіть міграції бухгалтерії.`);
  if (error?.code === "42883")
    return new Error(`Помилка SQL у звіті ${name} (42883): ${error.message || "Несумісні типи даних або відсутня залежність функції."}`);
  return error instanceof Error ? error : new Error(error?.message || "Не вдалося завантажити звіт");
}
export function isCancelled(error: any): boolean {
  return error?.name === "AbortError" || String(error?.message || "").includes("AbortError");
}
function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** One complete interval per view. Never treats an incomplete page as a full report. */
export function createAccountingPeriodCache<T>(id: (row: T) => string | number) {
  let saved: { key: string; period: AccountingPeriod; rows: T[] } | undefined;
  let active: { key: string; controller: AbortController; promise: Promise<T[]> } | undefined;
  return {
    clear() { saved = undefined; active?.controller.abort(); active = undefined; },
    cancel() { active?.controller.abort(); active = undefined; },
    commit(key: string, period: AccountingPeriod, rows: T[]) {
      saved = { key, period: {...period}, rows: structuredClone(rows) };
    },
    async read(key: string, period: AccountingPeriod, load: (period: AccountingPeriod, signal: AbortSignal) => Promise<T[]>, isCurrent: () => boolean = () => true): Promise<T[]> {
      const requestKey = JSON.stringify([key, period]);
      if (active?.key === requestKey) return structuredClone(await active.promise);
      active?.controller.abort(); active = undefined;
      if (saved?.key === key && periodContains(saved.period, period)) return structuredClone(saved.rows);
      const controller = new AbortController();
      const base = saved?.key === key && saved.period.from <= nextAccountingDay(period.to) && period.from <= nextAccountingDay(saved.period.to) ? saved : undefined;
      const coverage = base ? {from: base.period.from < period.from ? base.period.from : period.from, to: base.period.to > period.to ? base.period.to : period.to} : {...period};
      const gaps: AccountingPeriod[] = base ? [
        ...(period.from < base.period.from ? [{from: period.from, to: previousDay(base.period.from)}] : []),
        ...(period.to > base.period.to ? [{from: nextAccountingDay(base.period.to), to: period.to}] : []),
      ] : [period];
      const promise = (async () => {
        const rows = new Map((base?.rows || []).map(row => [id(row), row]));
        for (const gap of gaps) {
          controller.signal.throwIfAborted();
          for (const row of await load(gap, controller.signal)) rows.set(id(row), row);
        }
        controller.signal.throwIfAborted();
        if (!isCurrent()) throw new Error("Дані змінилися. Повторіть пошук.");
        saved = {key, period: coverage, rows: [...rows.values()]};
        return saved.rows;
      })();
      active = {key: requestKey, controller, promise};
      try { return structuredClone(await promise); }
      finally { if (active?.promise === promise) active = undefined; }
    },
    coverage(key: string): AccountingPeriod | null { return saved?.key === key ? {...saved.period} : null; },
  };
}
