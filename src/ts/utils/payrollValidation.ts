/** Local checks shared by act saving and payroll recovery. Never reads or writes data. */
export interface PayrollValidationIssue {
  kind: "work" | "detail" | "act";
  /** Zero-based index among named rows of this kind; null for an act-level issue. */
  index: number | null;
  name: string;
  field: string;
  code: "invalid_data" | "missing_number" | "invalid_number" | "invalid_id" | "missing_employee";
  message: string;
  recordId?: string;
}

type RowLocation = Pick<PayrollValidationIssue, "kind" | "index" | "name" | "recordId">;

export class PayrollValidationError extends Error {
  readonly issues: PayrollValidationIssue[];

  constructor(issues: PayrollValidationIssue[]) {
    super(issues.map(issue => issue.message).join("\n"));
    this.name = "PayrollValidationError";
    this.issues = issues.map(issue => ({ ...issue }));
  }
}

function inspectActPayrollData(input: unknown): { issues: PayrollValidationIssue[]; drafts: PayrollValidationIssue[] } {
  const issues: PayrollValidationIssue[] = [];
  const drafts: PayrollValidationIssue[] = [];
  const act: RowLocation = { kind: "act", index: null, name: "Акт" };
  const label = (row: RowLocation): string => row.kind === "act" ? "Акт"
    : `${row.kind === "work" ? "Робота" : "Деталь"} №${(row.index ?? 0) + 1} «${row.name}»`;
  const add = (row: RowLocation, field: string, code: PayrollValidationIssue["code"], message: string) => {
    issues.push({ ...row, field, code, message: `${label(row)}: ${message}` });
  };

  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); }
    catch { value = null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(act, "data", "invalid_data", "не вдалося прочитати збережені дані. Відкрийте акт повторно перед збереженням.");
    return { issues, drafts };
  }
  const data = value as Record<string, unknown>;

  const number = (raw: unknown, row: RowLocation, field: string, minimum?: number): number | null => {
    if (raw == null || (typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "") {
      add(row, field, "missing_number", `вкажіть числове значення у полі «${field}».`);
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (minimum !== undefined && parsed < minimum)) {
      add(row, field, "invalid_number", `виправте значення у полі «${field}»${minimum === 0 ? ": потрібне число не менше 0" : ": потрібне скінченне число"}.`);
      return null;
    }
    return parsed;
  };

  if (data.Знижка != null) {
    const discount = number(data.Знижка, act, "Знижка", 0);
    if (discount !== null && discount > 100) {
      add(act, "Знижка", "invalid_number", "вкажіть знижку від 0 до 100%.");
    }
  }

  for (const [key, kind, nameField] of [
    ["Роботи", "work", "Робота"], ["Деталі", "detail", "Деталь"],
  ] as const) {
    if (!Array.isArray(data[key])) {
      add(act, key, "invalid_data", `відсутній повний список «${key}». Відкрийте акт повторно перед збереженням.`);
      continue;
    }
    let index = 0;
    for (const item of data[key] as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const name = String(row[nameField] ?? "").trim();
      if (!name) continue; // An empty editor row is not a saved payroll position.
      const recordId = row.recordId == null ? "" : String(row.recordId).trim();
      const location: RowLocation = { kind, index: index++, name, ...(recordId ? { recordId } : {}) };
      number(row.Кількість, location, "Кількість"); // Negative quantities are existing return/correction semantics.
      number(row.Ціна, location, "Ціна", 0); // A zero price is allowed by the existing planner.
      if (row.Сума != null) number(row.Сума, location, "Сума");

      if (kind === "detail") {
        if (row.sclad_id != null && (!Number.isSafeInteger(Number(row.sclad_id)) || Number(row.sclad_id) <= 0)) {
          add(location, "sclad_id", "invalid_id", "некоректний ідентифікатор складської деталі. Повторно оберіть деталь зі складу.");
        }
        continue;
      }

      const salary = number(row.Зарплата, location, "Зарплата", 0);
      if (row.slyusar_id != null) {
        // Match the planner's required number/string and positive safe integer checks.
        const raw = row.slyusar_id;
        if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === ""
          || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
          add(location, "slyusar_id", "invalid_id", "некоректний ідентифікатор слюсаря. Повторно оберіть працівника в «ПІБ / Магазин».");
        }
      }
      if (salary !== null && salary > 0 && !String(row.Слюсар || "").trim() && row.slyusar_id == null) {
        drafts.push({ ...location, field: "Слюсар", code: "missing_employee",
          message: `${label(location)}: ${salary} грн збережено як чернетку зарплати без слюсаря. Нарахування цієї роботи відбудеться після вибору працівника в «ПІБ / Магазин» і збереження акта.` });
      }
    }
  }
  return { issues, drafts };
}

export function validateActPayrollData(data: unknown): PayrollValidationIssue[] {
  return inspectActPayrollData(data).issues;
}

/** Unassigned wages remain in the act as drafts and do not block other employees. */
export function getActPayrollDrafts(data: unknown): PayrollValidationIssue[] {
  return inspectActPayrollData(data).drafts;
}

/** Throws before a save; the original draft and all financial values remain unchanged. */
export function assertValidActPayrollData(data: unknown): void {
  const issues = validateActPayrollData(data);
  if (issues.length) throw new PayrollValidationError(issues);
}
