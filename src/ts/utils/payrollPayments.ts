/** Local payroll arithmetic. This module never reads or writes the database. */
export const PAYROLL_PAYMENTS_KEY = "__payroll_payments";
export type PayrollPayment = { id: string; amount: number; date: string };
export type PayrollPaymentVoid = { id: string; voids: string; date: string };
export type PayrollPaymentEvent = PayrollPayment | PayrollPaymentVoid;

const owns = (value: any, key: string): boolean => Object.prototype.hasOwnProperty.call(value || {}, key);
const markedPaid = (value: any): boolean => value != null && value !== false && value !== "";

function number(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Некоректна сума зарплати.");
  const normalized = String(value).replace(/\s/g, "").replace(",", ".");
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(normalized)) throw new Error("Некоректна сума зарплати.");
  const result = Number(normalized);
  if (!Number.isFinite(result)) throw new Error("Некоректна сума зарплати.");
  return result;
}

export function roundPayrollMoney(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Некоректна сума зарплати.");
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getPayrollEarned(target: any): number {
  let earned = 0;
  if (owns(target, "Зарплата")) earned = number(target.Зарплата);
  else if (owns(target, "ЗарплатаРоботи") || owns(target, "ЗарплатаЗапчастин")) {
    const work = number(target.ЗарплатаРоботи), parts = number(target.ЗарплатаЗапчастин);
    earned = owns(target, "СуммаРоботи") ? (number(target.СуммаРоботи) > 0 ? work : 0) + parts
      : owns(target, "СуммаЗапчастин") ? (number(target.СуммаЗапчастин) > 0 ? parts : 0) : work + parts;
  } else if (Array.isArray(target?.Записи)) {
    earned = target.Записи.reduce((sum: number, row: any) => sum + getPayrollEarned(row), 0);
  }
  if (!Number.isFinite(earned) || earned < 0) throw new Error("Некоректна сума зарплати.");
  return earned;
}

function legacyDate(target: any, parent?: any): string | null {
  const value = markedPaid(target?.Розраховано) ? target.Розраховано
    : markedPaid(parent?.Розраховано) ? parent.Розраховано : null;
  return value === null ? null : String(value);
}

function readLedger(target: any): PayrollPaymentEvent[] {
  const ledger = target[PAYROLL_PAYMENTS_KEY];
  if (!Array.isArray(ledger)) throw new Error("Некоректна історія виплат.");
  const ids = new Set<string>(), active = new Map<string, PayrollPayment>();
  for (const event of ledger) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        typeof event.id !== "string" || !event.id.trim() || ids.has(event.id) ||
        typeof event.date !== "string" || !event.date.trim()) throw new Error("Некоректна історія виплат.");
    ids.add(event.id);
    const keys = Object.keys(event).sort().join(",");
    if (keys === "amount,date,id") {
      if (typeof event.amount !== "number" || !Number.isFinite(event.amount) || event.amount < 0) {
        throw new Error("Некоректна сума виплати.");
      }
      active.set(event.id, event);
    } else if (keys === "date,id,voids") {
      const activeIds = [...active.keys()];
      if (typeof event.voids !== "string" || !active.has(event.voids) ||
          activeIds[activeIds.length - 1] !== event.voids) throw new Error("Некоректне скасування виплати.");
      active.delete(event.voids);
    } else throw new Error("Некоректна історія виплат.");
  }
  return structuredClone(ledger);
}

function activePayments(events: PayrollPaymentEvent[]): PayrollPayment[] {
  const voids = new Set(events.filter((event): event is PayrollPaymentVoid => "voids" in event).map(event => event.voids));
  return events.filter((event): event is PayrollPayment => "amount" in event && !voids.has(event.id));
}

export function getPayrollPaymentState(target: any, parent?: any): {
  earned: number; paidAmount: number; due: number; overpaid: number; isPaid: boolean;
  hasPayments: boolean; paymentDate: string | null; payments: PayrollPaymentEvent[]; hasLedger: boolean;
} {
  const earned = getPayrollEarned(target), hasLedger = owns(target, PAYROLL_PAYMENTS_KEY);
  const date = legacyDate(target, parent);
  const payments: PayrollPaymentEvent[] = hasLedger ? readLedger(target)
    : date === null ? [] : [{ id: "legacy", amount: earned, date }];
  const active = activePayments(payments);
  const paidAmount = roundPayrollMoney(active.reduce((sum, event) => sum + event.amount, 0));
  const balance = roundPayrollMoney(earned - paidAmount);
  const due = Math.max(0, balance), overpaid = Math.max(0, -balance);
  return { earned, paidAmount, due, overpaid, isPaid: active.length > 0 && due === 0,
    hasPayments: active.length > 0, paymentDate: active[active.length - 1]?.date || null, payments, hasLedger };
}

function dateKey(value: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value.slice(0, 10);
}

export function getPayrollPaymentInPeriod(target: any, parent?: any, from?: string | null, to?: string | null): { amount: number; date: string | null } {
  const state = getPayrollPaymentState(target, parent);
  const included = activePayments(state.payments).filter(event => {
    const day = dateKey(event.date);
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== day) return false;
    return (!from || day >= dateKey(from)) && (!to || day <= dateKey(to));
  });
  included.sort((left, right) => dateKey(left.date).localeCompare(dateKey(right.date)));
  return { amount: roundPayrollMoney(included.reduce((sum, event) => sum + event.amount, 0)),
    date: included[included.length - 1]?.date || null };
}

/** A recalculation can preserve payments or seed their old acknowledged amount. */
export function preservePayrollPaymentHistory(previous: any, next: any, parent?: any): any {
  const result = structuredClone(next);
  const old = getPayrollPaymentState(previous, parent);
  const canonical = (events: PayrollPaymentEvent[]): string => JSON.stringify(events.map(event =>
    "voids" in event ? [event.id, event.date, "void", event.voids] : [event.id, event.date, "payment", event.amount]));
  const equal = (left: PayrollPaymentEvent[], right: PayrollPaymentEvent[]): boolean => canonical(left) === canonical(right);
  if (old.hasLedger) {
    if (!owns(next, PAYROLL_PAYMENTS_KEY) || !equal(readLedger(next), old.payments)) {
      throw new Error("Історія виплат не може бути змінена під час нарахування.");
    }
    result[PAYROLL_PAYMENTS_KEY] = structuredClone(previous[PAYROLL_PAYMENTS_KEY]);
  }
  else if (old.hasPayments && old.earned !== getPayrollEarned(next)) {
    if (owns(next, PAYROLL_PAYMENTS_KEY) && !equal(readLedger(next), old.payments)) {
      throw new Error("Історія виплат не може бути змінена під час нарахування.");
    }
    result[PAYROLL_PAYMENTS_KEY] = structuredClone(old.payments);
  } else if (owns(next, PAYROLL_PAYMENTS_KEY)) {
    throw new Error("Нарахування не може додавати виплати.");
  }
  return result;
}

/** Explicit user payment or cancellation; accrual calculations never call this. */
export function applyPayrollPayment(target: any, parent: any, date: string, id: string, operation: "pay" | "void"): any {
  const state = getPayrollPaymentState(target, parent), result = structuredClone(target);
  const day = dateKey(date), parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day || !id.trim() || state.payments.some(event => event.id === id)) {
    throw new Error("Некоректний ідентифікатор або дата виплати.");
  }
  if (!state.hasLedger && !markedPaid(parent?.Розраховано)) {
    if (operation === "pay") {
      if (state.isPaid) throw new Error("Зарплата вже виплачена.");
      result.Розраховано = date;
    } else {
      if (!state.hasPayments) throw new Error("Немає виплати для скасування.");
      delete result.Розраховано;
    }
    return result;
  }
  const payments = state.payments;
  if (operation === "pay") {
    if (state.due <= 0) throw new Error("Немає суми до виплати.");
    payments.push({ id, amount: state.due, date });
  } else {
    const active = activePayments(payments), last = active[active.length - 1];
    if (!last) throw new Error("Немає виплати для скасування.");
    payments.push({ id, voids: last.id, date });
  }
  result[PAYROLL_PAYMENTS_KEY] = payments;
  return result;
}
