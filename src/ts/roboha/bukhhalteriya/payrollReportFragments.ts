import { stableActJson } from "../../utils/actSafeWrite";

export const PAYROLL_REPORT_INDEXES = "__report_work_indexes";
export const PAYROLL_REPORT_REVISION = "__report_entry_revision";
export type PayrollReportEmployee = { slyusar_id: number; data: any };

/** Report metadata is never part of the persisted payment target. */
export function payrollReportHeader(entry: any): any {
  const header = {...entry};
  delete header.Записи;
  delete header[PAYROLL_REPORT_INDEXES];
  delete header[PAYROLL_REPORT_REVISION];
  return header;
}

export function payrollReportWorkIndex(entry: any, localIndex: number): number {
  return entry[PAYROLL_REPORT_INDEXES]?.[localIndex] ?? localIndex;
}

export function payrollReportWork(entry: any, originalIndex: number): any | undefined {
  const indexes = entry?.[PAYROLL_REPORT_INDEXES];
  return entry?.Записи?.[Array.isArray(indexes) ? indexes.indexOf(originalIndex) : originalIndex];
}

/** Every downloaded work must belong to this page; no hidden sibling history. */
export function validatePayrollReportFragments(employees: PayrollReportEmployee[], keys: Array<[number, string, string, number | null]>): void {
  const expected = new Set(keys.map(key => JSON.stringify(key)));
  const seen = new Set<string>();
  if (expected.size !== keys.length) throw new Error("Повторні позиції зарплати");
  for (const employee of employees) {
    if (!Number.isSafeInteger(employee.slyusar_id) || employee.slyusar_id <= 0 || !employee.data?.Історія) throw new Error("Некоректний працівник звіту");
    for (const [day, entries] of Object.entries(employee.data.Історія)) {
      if (!Array.isArray(entries)) throw new Error("Некоректна історія зарплати");
      for (const entry of entries) {
        if (!entry || !/^[a-f0-9]{32}$/.test(entry[PAYROLL_REPORT_REVISION] || "")) throw new Error("Відсутня версія нарахування");
        const works = entry.Записи;
        const indexes = entry[PAYROLL_REPORT_INDEXES];
        if (Array.isArray(works) && works.length) {
          if (!Array.isArray(indexes) || indexes.length !== works.length || new Set(indexes).size !== indexes.length ||
              indexes.some(index => !Number.isSafeInteger(index) || index < 0)) throw new Error("Некоректні індекси робіт");
        } else if (indexes !== undefined) throw new Error("Некоректний фрагмент зарплати");
        for (const index of Array.isArray(works) && works.length ? indexes : [null]) {
          const key = JSON.stringify([employee.slyusar_id, day, String(entry.Акт), index]);
          if (!expected.has(key) || seen.has(key)) throw new Error("Невідповідність позицій зарплати");
          seen.add(key);
        }
      }
    }
  }
  if (seen.size !== expected.size) throw new Error("Неповна сторінка зарплати");
}

/** Merge selected works only when the complete server entry has the same revision. */
export function mergePayrollReportEmployees(rows: PayrollReportEmployee[]): PayrollReportEmployee[] | null {
  const merged = new Map<number, PayrollReportEmployee>();
  for (const row of rows) {
    let target = merged.get(row.slyusar_id);
    if (!target) {
      target = {...row, data: {...structuredClone(row.data), Історія: {}}};
      merged.set(row.slyusar_id, target);
    } else if (target.data.Name !== row.data.Name || stableActJson(target.data.ПроцентРоботи) !== stableActJson(row.data.ПроцентРоботи)) return null;
    for (const [day, entries] of Object.entries(row.data.Історія || {}) as [string, any[]][]) {
      const bucket: any[] = target.data.Історія[day] ||= [];
      for (const entry of entries) {
        const previous = bucket.find(value => String(value.Акт) === String(entry.Акт));
        if (!previous) { bucket.push(structuredClone(entry)); continue; }
        if (previous[PAYROLL_REPORT_REVISION] !== entry[PAYROLL_REPORT_REVISION] ||
            stableActJson(payrollReportHeader(previous)) !== stableActJson(payrollReportHeader(entry))) return null;
        const first = previous[PAYROLL_REPORT_INDEXES], next = entry[PAYROLL_REPORT_INDEXES];
        if (!Array.isArray(first) || !Array.isArray(next)) {
          if (stableActJson(previous) !== stableActJson(entry)) return null;
          continue;
        }
        const works = new Map<number, any>(first.map((index: number, local: number) => [index, previous.Записи[local]]));
        for (let local = 0; local < next.length; local++) {
          const index = next[local], value = entry.Записи[local];
          if (works.has(index) && stableActJson(works.get(index)) !== stableActJson(value)) return null;
          works.set(index, structuredClone(value));
        }
        previous[PAYROLL_REPORT_INDEXES] = [...works.keys()].sort((a, b) => a - b);
        previous.Записи = previous[PAYROLL_REPORT_INDEXES].map((index: number) => works.get(index));
      }
    }
  }
  return [...merged.values()];
}
