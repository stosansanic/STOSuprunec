import { supabase } from "../vxid/supabaseClient";
import { readActJson, stableActJson } from "./actSafeWrite";
import { applyPayrollPayment, getPayrollEarned, getPayrollPaymentState, PAYROLL_PAYMENTS_KEY, preservePayrollPaymentHistory } from "./payrollPayments";

let authOwner: string | null | undefined;
let authGeneration = 0;
supabase.auth.onAuthStateChange((event, session) => {
  const nextOwner = session?.user?.id || null;
  if ((authOwner !== undefined && authOwner !== nextOwner) || event === "SIGNED_OUT" || event === "USER_UPDATED") authGeneration++;
  authOwner = nextOwner;
});
export function payrollActorScope(): string {
  return JSON.stringify([authGeneration, typeof localStorage === "undefined" ? "" : localStorage.getItem("userAuthData")]);
}

// The server locks current rows and merges affected history fragments.
const snapshots = new WeakMap<object, { id: number; data: any }>();
export class PayrollConflict extends Error {
  constructor(message = "Зарплату змінено в іншій вкладці або є неоднозначні записи. Оновіть дані та повторіть операцію; чужі нарахування не перезаписано.") {
    super(message);
    this.name = "PayrollConflict";
  }
}

export function trackPayrollData(id: number, value: any): any {
  const data = structuredClone(readActJson(value));
  snapshots.set(data, { id, data: structuredClone(data) });
  return data;
}

export function payrollEmployeeId(data: object): number | undefined {
  return snapshots.get(data)?.id;
}

/** Restore only the acknowledged history after a partial multi-employee failure. */
export function restorePayrollSnapshot(data: any): void {
  const snapshot = snapshots.get(data);
  if (!snapshot) return;
  if (Object.prototype.hasOwnProperty.call(snapshot.data, "Історія")) data.Історія = structuredClone(snapshot.data.Історія);
  else delete data.Історія;
}

export function payrollActBucket(history: any, actId: number, defaultDate: string): any[] {
  const matches = Object.keys(history).filter(date => Array.isArray(history[date]) &&
    history[date].some((entry: any) => String(entry.Акт) === String(actId)));
  if (matches.length > 1) throw new PayrollConflict(`Акт №${actId} повторений у кількох датах історії зарплат.`);
  return history[matches[0] || defaultDate] ||= [];
}

type Entry = { date: string; value: any };
function hasLegacyPayrollPayment(entry: any): boolean {
  return entry?.Розраховано != null && entry.Розраховано !== false && entry.Розраховано !== "";
}

/** Only the explicit payment operation may introduce a legacy paid marker. */
function assertNoAccrualPaymentCreation(before: Entry[], after: Entry[]): void {
  const previous = before[0]?.value, next = after[0]?.value;
  if (!next) return;
  const reject = () => { throw new PayrollConflict("Збереження акта не може позначати зарплату виплаченою. Скористайтеся дією виплати в бухгалтерії."); };
  if (hasLegacyPayrollPayment(next) && !hasLegacyPayrollPayment(previous)) reject();
  for (const row of next.Записи || []) {
    if (!hasLegacyPayrollPayment(row)) continue;
    const key = String(row.recordId ?? "").trim();
    const matches = (previous?.Записи || []).filter((old: any) => key
      ? String(old.recordId ?? "").trim() === key
      : stableActJson(old) === stableActJson(row));
    if (matches.length !== 1 || !hasLegacyPayrollPayment(matches[0])) reject();
  }
}

function indexHistory(data: any): Map<string, Entry[]> {
  const result = new Map<string, Entry[]>();
  for (const [date, entries] of Object.entries(data.Історія || {})) {
    if (!Array.isArray(entries)) throw new PayrollConflict("Некоректна історія зарплат: запис зупинено.");
    for (const value of entries) {
      if (value?.Акт == null) throw new PayrollConflict("Запис зарплати без номера акта: потрібна перевірка історії.");
      const key = String(value.Акт);
      result.set(key, [...(result.get(key) || []), { date, value }]);
    }
  }
  return result;
}

export function assertPayrollHistory(data: any): void {
  for (const [act, entries] of indexHistory(data)) {
    if (entries.length !== 1) throw new PayrollConflict(`Дублікати зарплати за актом №${act}, працівник «${data.Name}». Потрібна перевірка; виплати не змінено.`);
    const ids = (entries[0].value.Записи || []).map((row: any) => String(row.recordId ?? "").trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new PayrollConflict(`Повторні роботи з одним ідентифікатором в акті №${act}.`);
    const rows = entries[0].value.Записи || [];
    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(row, "__payroll_act_record_id") &&
          (typeof row.__payroll_act_record_id !== "string" || !row.__payroll_act_record_id.trim() ||
            row.__payroll_act_record_id !== row.__payroll_act_record_id.trim())) {
        throw new PayrollConflict(`Некоректна відповідність роботи акта №${act} зарплатній історії.`);
      }
      if (Object.prototype.hasOwnProperty.call(row, "__payroll_removed") &&
          (row.__payroll_removed !== true || row.Кількість !== 0 || row.Зарплата !== 0 ||
            (Object.prototype.hasOwnProperty.call(row, "Сума") && row.Сума !== 0))) {
        throw new PayrollConflict(`Видалена робота акта №${act} має ненульове нарахування.`);
      }
    }
    const sourceIds = rows.map((row: any) => String(row.__payroll_act_record_id ?? row.recordId ?? "").trim()).filter(Boolean);
    if (new Set(sourceIds).size !== sourceIds.length || rows.some((row: any) =>
      row.__payroll_act_record_id != null && rows.some((other: any) => other !== row &&
        String(other.recordId ?? "").trim() === String(row.__payroll_act_record_id).trim()))) {
      throw new PayrollConflict(`Неоднозначна відповідність робіт акта №${act} зарплатній історії.`);
    }
  }
}

// Merge only affected acts, never overwrite another act or employee settings.
// A conflict within the SAME act is deliberately rejected, including payments.
export function mergePayrollHistory(base: any, next: any, fresh: any): any {
  const before = indexHistory(base), after = indexHistory(next), current = indexHistory(fresh);
  const result = structuredClone(fresh);
  result.Історія ||= {};
  for (const act of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(act) || [], n = after.get(act) || [], c = current.get(act) || [];
    if (stableActJson(b) === stableActJson(n)) continue;
    if (b.length > 1 || n.length > 1 || c.length > 1) {
      throw new PayrollConflict(`Дублікати зарплати за актом №${act}. Автоматичне перезаписування зупинено.`);
    }
    if (stableActJson(c) === stableActJson(n)) continue; // idempotent retry
    if (stableActJson(c) !== stableActJson(b)) throw new PayrollConflict();
    for (const entry of n) {
      const ids = (entry.value.Записи || []).map((row: any) => row.recordId).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw new PayrollConflict(`Повторні ідентифікатори робіт в акті №${act}.`);
    }
    if (c[0] && n[0] && c[0].date === n[0].date) {
      const bucket = result.Історія[c[0].date];
      const index = bucket.findIndex((entry: any) => String(entry.Акт) === act);
      bucket[index] = structuredClone(n[0].value);
      continue;
    }
    if (c[0]) {
      const bucket = result.Історія[c[0].date];
      result.Історія[c[0].date] = bucket.filter((entry: any) => String(entry.Акт) !== act);
      if (!result.Історія[c[0].date].length) delete result.Історія[c[0].date];
    }
    if (n[0]) (result.Історія[n[0].date] ||= []).push(structuredClone(n[0].value));
  }
  return result;
}

export type PayrollWriteMode = "accrual" | "payment";
export function payrollChanges(base: any, next: any, mode: PayrollWriteMode): any[] {
  // Retain existing ambiguity validation before any remote mutation.
  mergePayrollHistory(base, next, base);
  const before=indexHistory(base), after=indexHistory(next), changes:any[]=[];
  const withoutPaid=(value:any)=>{const copy={...value};delete copy.Розраховано;delete copy[PAYROLL_PAYMENTS_KEY];return copy;};
  const header=(value:any)=>{const copy={...value};delete copy.Записи;return copy;};
  for(const act of new Set([...before.keys(),...after.keys()])) {
    const expected=before.get(act)||[], desired=after.get(act)||[];
    if(stableActJson(expected)===stableActJson(desired))continue;
    if(!/^[1-9][0-9]*$/.test(act)||!Number.isSafeInteger(Number(act)))throw new PayrollConflict("Некоректний номер акта в зарплаті.");
    if(mode==='accrual') {assertNoAccrualPaymentCreation(expected,desired);changes.push({act_id:Number(act),expected,desired});continue;}
    const old=expected[0],updated=desired[0];
    if(!old||!updated||old.date!==updated.date)throw new PayrollConflict("Виплата не може додавати або переносити нарахування.");
    const oldHeader=header(old.value),newHeader=header(updated.value);
    if(stableActJson(withoutPaid(oldHeader))!==stableActJson(withoutPaid(newHeader)))throw new PayrollConflict("Виплата може змінювати лише стан розрахунку.");
    const append=(target:any,original:any,replacement:any,parent?:any)=>{
      const oldState=getPayrollPaymentState(original,parent), newState=getPayrollPaymentState(replacement,parent);
      if(oldState.hasLedger || newState.hasLedger) {
        const event=newState.payments[newState.payments.length-1];
        if(!event)throw new PayrollConflict("Виплата повинна додавати одну подію.");
        const planned=applyPayrollPayment(original,parent,event.date,event.id,"voids" in event?"void":"pay");
        if(stableActJson(planned)!==stableActJson(replacement))throw new PayrollConflict("Історія виплат не може бути перезаписана.");
      }
      const payment=Object.fromEntries(Object.entries(replacement).filter(([key])=>key==="Розраховано"||key===PAYROLL_PAYMENTS_KEY));
      changes.push({act_id:Number(act),date:old.date,...target,expected:original,desired:payment});
    };
    if(stableActJson(oldHeader)!==stableActJson(newHeader))append({target:'act'},oldHeader,newHeader);
    const oldRows=old.value.Записи||[],newRows=updated.value.Записи||[];
    if(!Array.isArray(oldRows)||!Array.isArray(newRows)||oldRows.length!==newRows.length)throw new PayrollConflict("Склад нарахувань змінився.");
    for(let index=0;index<oldRows.length;index++) {
      const oldRow=oldRows[index],newRow=newRows[index];
      if(stableActJson(withoutPaid(oldRow))!==stableActJson(withoutPaid(newRow)))throw new PayrollConflict("Виплата не може змінювати роботу або суму.");
      if(stableActJson(oldRow)!==stableActJson(newRow))append({target:'record',index,record_id:oldRow.recordId == null ? null : String(oldRow.recordId)},oldRow,newRow,old.value);
    }
  }
  return changes;
}

export async function savePayrollData(data: any, mode: PayrollWriteMode = "accrual"): Promise<void> {
  const snapshot=snapshots.get(data);
  if(!snapshot)throw new PayrollConflict("Відсутній початковий стан зарплати. Оновіть сторінку.");
  const desired=structuredClone(data);
  const changes=payrollChanges(snapshot.data,desired,mode);
  if(!changes.length)return;
  const {data:receipt,error}=await supabase.rpc("write_payroll_fragments",{p_employee_id:snapshot.id,p_mode:mode,p_changes:changes});
  if(error?.code==='40001'||error?.code==='55000')throw new PayrollConflict(error.message);
  if(error?.code==='PGRST202'||error?.code==='42883')throw new Error("Встановіть міграцію payroll_fragments перед збереженням зарплати. Чернетка не втрачена.");
  if(error)throw error;
  if(!receipt||Number(receipt.slyusar_id)!==snapshot.id||!['updated','unchanged'].includes(receipt.status))throw new PayrollConflict("Немає підтвердження запису зарплати. Повторіть операцію.");
  snapshot.data=desired;
}

export async function fetchPayrollEmployees(actIds?: number[], selector?: { id?: number; name?: string }): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = actIds ? 200 : 500;
  if(actIds && (!actIds.length || actIds.length>200 || actIds.some(id=>!Number.isSafeInteger(id)||id<=0)))throw new Error("Некоректні номери актів зарплати");
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = actIds
      ? await supabase.rpc("traffic_payroll_employees",{p_act_ids:actIds,p_offset:offset,p_employee_id:selector?.id??null,p_name:selector?.name??null})
      : await supabase.from("slyusars").select("slyusar_id, data").order("slyusar_id").range(offset, offset + pageSize - 1);
    if (error || !data) throw error || new Error("Не вдалося прочитати працівників");
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

/** One act's payroll is calculated locally, then committed in one transaction.
 * Each session owns its snapshots; simultaneous editors/payments cannot share them.
 */
export class PayrollWriteSession {
  readonly actId: number;
  private readonly protectLegacy: boolean;
  private readonly original = new Map<number, any>();
  private readonly staged = new Map<number, any>();
  private readonly stock = new Map<number, any>();
  private readonly actor = payrollActorScope();
  private constructor(actId: number, rows: any[], protectLegacy: boolean) {
    this.actId = actId;
    this.protectLegacy = protectLegacy;
    for (const row of rows) {
      const id = Number(row.slyusar_id), data = structuredClone(readActJson(row.data));
      if (!Number.isSafeInteger(id) || id <= 0 || this.original.has(id)) throw new PayrollConflict("Неоднозначний довідник працівників.");
      assertPayrollHistory(data);
      this.original.set(id, data);
      this.staged.set(id, structuredClone(data));
    }
  }
  static async create(actId: number, options: { protectLegacy?: boolean } = {}): Promise<PayrollWriteSession> {
    const actor = payrollActorScope();
    const rows = await fetchPayrollEmployees([actId]);
    if (actor !== payrollActorScope()) throw new PayrollConflict("Користувач змінився. Відновлення зупинено.");
    return new PayrollWriteSession(actId, rows, options.protectLegacy === true);
  }
  assertOwner(): void {
    if (this.actor !== payrollActorScope()) throw new PayrollConflict("Користувач змінився. Відновлення зупинено.");
  }
  captureStock(rows: any[]): void {
    this.assertOwner();
    for (const row of rows) {
      const id = Number(row.sclad_id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new PayrollConflict("Некоректний складський запис для зарплати.");
      const expected = { price: row.price, scladNomer: row.scladNomer, xto_zamovuv: row.xto_zamovuv };
      if (Object.values(expected).some(value => value === undefined)) throw new PayrollConflict("Неповні дані складу для розрахунку.");
      if (this.stock.has(id) && stableActJson(this.stock.get(id)) !== stableActJson(expected)) throw new PayrollConflict("Складські дані змінилися під час розрахунку.");
      this.stock.set(id, structuredClone(expected));
    }
  }
  stockInputs(): Array<{ id: number; expected: any }> {
    this.assertOwner();
    return [...this.stock].sort(([a], [b]) => a - b).map(([id, expected]) => ({ id, expected }));
  }
  async fetchEmployees(selector?: { id?: number; name?: string }): Promise<any[]> {
    this.assertOwner();
    return [...this.staged].filter(([id, data]) =>
      (selector?.id == null || selector.id === id) && (selector?.name == null || selector.name === data.Name))
      .map(([slyusar_id, data]) => ({ slyusar_id, data: structuredClone(data) }));
  }
  async save(data: any): Promise<void> {
    this.assertOwner();
    const snapshot = snapshots.get(data);
    if (!snapshot || !this.staged.has(snapshot.id)) throw new PayrollConflict("Немає початкового стану працівника.");
    const current = this.staged.get(snapshot.id);
    const merged = mergePayrollHistory(snapshot.data, data, current);
    // A calculation for one act must never alter a different act.
    if (payrollChanges(current, merged, "accrual").some(change => change.act_id !== this.actId)) throw new PayrollConflict("Нарахування містить інший акт.");
    this.staged.set(snapshot.id, merged);
    snapshot.data = structuredClone(data);
  }
  /** Send only this act's fragments and compact employee settings, not histories. */
  fragments(): Array<{ id: number; settings: any; expected: Entry[]; desired: Entry[] }> {
    this.assertOwner();
    return [...this.original].sort(([a], [b]) => a - b).map(([id, original]) => {
      const desired = this.staged.get(id);
      assertPayrollHistory(desired);
      const settings = Object.fromEntries(Object.entries(original).filter(([key]) => ["Name", "Доступ", "Склад", "ПроцентРоботи", "ПроцентЗапчастин"].includes(key)));
      const expectedEntries = indexHistory(original).get(String(this.actId)) || [];
      let desiredEntries = indexHistory(desired).get(String(this.actId)) || [];
      if (this.protectLegacy && ["Приймальник", "Адміністратор", "Запчастист"].includes(original.Доступ)) {
        const previous = expectedEntries[0]?.value, next = desiredEntries[0]?.value;
        const money = ["СуммаРоботи", "СуммаЗапчастин", "МаржаДляЗарплати", "ЗарплатаРоботи", "ЗарплатаЗапчастин", "ЗарплатаЗапчастистів", "Зарплата", "Знижка"];
        if (previous && !previous.__payroll_input && !isPayrollPaid(previous)) {
          const knownRates = ["__payroll_percent", "__payroll_percent_work", "__payroll_percent_parts"].filter(key => Object.prototype.hasOwnProperty.call(previous, key));
          if (!next || [...money, ...knownRates].some(key => payrollNumber(previous[key]) !== payrollNumber(next[key]))) {
            throw new PayrollConflict(`Акт №${this.actId}, «${original.Name}»: старе нарахування не має даних для перевірки початкових ставок. Автоматичний перерахунок зупинено. Перевірте суми в акті перед повторним збереженням.`);
          }
          // Matching amounts do not justify inventing old rates or changing the
          // shape of a paid record. Preserve its original financial fields.
          const preserved = structuredClone(previous);
          for (const key of ["Клієнт", "Автомобіль", "ДатаЗакриття", "__payroll_input"]) {
            if (Object.prototype.hasOwnProperty.call(next, key)) preserved[key] = next[key];
          }
          desiredEntries = [{ date: desiredEntries[0].date, value: preserved }];
        }
      }
      const previous = expectedEntries[0]?.value, next = desiredEntries[0]?.value;
      if (isPayrollPaid(previous) && next) {
        desiredEntries = [{ ...desiredEntries[0], value: preserveEquivalentPaidHeader(previous, next) }];
      }
      if (previous && desiredEntries[0]) {
        const normalized = structuredClone(desiredEntries[0].value);
        if (String(normalized.Акт) === String(previous.Акт)) normalized.Акт = previous.Акт;
        if (Array.isArray(previous.Записи) && Array.isArray(normalized.Записи)) {
          if (stableActJson(previous[PAYROLL_PAYMENTS_KEY]) !== stableActJson(normalized[PAYROLL_PAYMENTS_KEY])) {
            throw new PayrollConflict("Нарахування не може змінювати історію виплат.");
          }
          normalized.Записи = normalized.Записи.map((row: any) => {
            const matches = previous.Записи.filter((candidate: any) => String(candidate.recordId ?? "") !== ""
              ? String(candidate.recordId) === String(row.recordId) : stableActJson(candidate) === stableActJson(row));
            if (!matches.length && Object.prototype.hasOwnProperty.call(row, PAYROLL_PAYMENTS_KEY) &&
                !isNewUnpaidMechanicWork(row, previous)) {
              throw new PayrollConflict("Нова робота не може містити виплат.");
            }
            return matches.length === 1 ? preservePayrollPaymentHistory(matches[0], row, previous) : row;
          });
          desiredEntries = [{ ...desiredEntries[0], value: normalized }];
        } else {
          desiredEntries = [{ ...desiredEntries[0], value: preservePayrollPaymentHistory(previous, normalized) }];
        }
      } else if (!previous && next && (Object.prototype.hasOwnProperty.call(next, PAYROLL_PAYMENTS_KEY) ||
          (next.Записи || []).some((row: any) => Object.prototype.hasOwnProperty.call(row, PAYROLL_PAYMENTS_KEY)))) {
        throw new PayrollConflict("Нове нарахування не може містити виплат.");
      }
      assertPaidPayrollPreserved(expectedEntries, desiredEntries, this.actId, original.Name);
      return { id, settings, expected: expectedEntries, desired: desiredEntries };
    });
  }
}

function isPayrollPaid(entry: any): boolean {
  return Object.prototype.hasOwnProperty.call(entry || {}, PAYROLL_PAYMENTS_KEY) ||
    (entry?.Розраховано != null && entry.Розраховано !== false && entry.Розраховано !== "");
}

/**
 * Keep an equivalent acknowledged accrual in its original JSON shape. The
 * server intentionally compares paid records exactly, including payment marks.
 * Only numeric representation and newly calculated rate metadata may differ;
 * an actual amount, known rate, payment, row or unknown field change still fails.
 */
function preserveEquivalentPaidHeader(previous: any, next: any): any {
  const money = ["СуммаРоботи", "СуммаЗапчастин", "МаржаДляЗарплати", "ЗарплатаРоботи",
    "ЗарплатаЗапчастин", "ЗарплатаЗапчастистів", "Зарплата", "Знижка"];
  const rates = ["__payroll_percent", "__payroll_percent_work", "__payroll_percent_parts"];
  const display = ["Клієнт", "Автомобіль", "ДатаЗакриття", "__payroll_input"];
  const knownRates = rates.filter(key => Object.prototype.hasOwnProperty.call(previous, key));
  if ([...money, ...knownRates].some(key => payrollNumber(previous[key]) !== payrollNumber(next[key]))) return next;
  if (String(previous.Акт) !== String(next.Акт)) return next;
  const remaining = (entry: any) => Object.fromEntries(Object.entries(entry)
    .filter(([key]) => ![...money, ...rates, ...display, "Акт"].includes(key)));
  if (stableActJson(remaining(previous)) !== stableActJson(remaining(next))) return next;
  const preserved = structuredClone(previous);
  for (const key of display) {
    if (Object.prototype.hasOwnProperty.call(next, key)) preserved[key] = next[key];
  }
  return preserved;
}

function paidWorkNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(String(value).replace(/\s/g, "").replace(",", "."))) return null;
  try { return payrollNumber(value); } catch { return null; }
}

/** An added work must not inherit a historical whole-act payment. */
function isNewUnpaidMechanicWork(row: any, parent: any): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !String(row.recordId ?? "").trim() || typeof row.Робота !== "string" || !row.Робота.trim() ||
      hasLegacyPayrollPayment(row) || Object.prototype.hasOwnProperty.call(row, "__payroll_removed") ||
      Object.prototype.hasOwnProperty.call(row, "__payroll_act_record_id")) return false;
  const values = [row.Ціна, row.Кількість, row.Зарплата].map(paidWorkNumber);
  if (values.some(value => value === null || value < 0) || !Number.isFinite(values[0]! * values[1]!)) return false;
  if (Object.prototype.hasOwnProperty.call(row, PAYROLL_PAYMENTS_KEY)) {
    return hasLegacyPayrollPayment(parent) && Array.isArray(row[PAYROLL_PAYMENTS_KEY]) && row[PAYROLL_PAYMENTS_KEY].length === 0;
  }
  return !hasLegacyPayrollPayment(parent);
}

/** Keep payroll identity and paid cash when editing or removing an act work. */
function isPaidWorkAccrualCorrection(previous: any, next: any, parent?: any): boolean {
  if (!previous || !next || !String(previous.recordId ?? "").trim() ||
      !["number", "string"].includes(typeof previous.recordId) ||
      typeof previous.Робота !== "string" || !previous.Робота.trim() ||
      typeof next.Робота !== "string" || !next.Робота.trim()) return false;
  const fields = ["Ціна", "Кількість", "Зарплата"];
  if (fields.some(key => paidWorkNumber(previous[key]) === null || paidWorkNumber(next[key]) === null)) return false;
  if (paidWorkNumber(next.Ціна)! < 0 || paidWorkNumber(next.Зарплата)! < 0 ||
      (paidWorkNumber(next.Кількість)! < 0 && paidWorkNumber(next.Кількість) !== paidWorkNumber(previous.Кількість))) return false;
  const product = paidWorkNumber(next.Ціна)! * paidWorkNumber(next.Кількість)!;
  if (!Number.isFinite(product)) return false;
  for (const field of fields) if (paidWorkNumber(previous[field]) !== paidWorkNumber(next[field]) && typeof next[field] !== "number") return false;
  const hasSum = Object.prototype.hasOwnProperty.call(previous, "Сума");
  if (hasSum !== Object.prototype.hasOwnProperty.call(next, "Сума")) return false;
  if (hasSum && (paidWorkNumber(next.Сума) !== product ||
      (paidWorkNumber(previous.Сума) !== product && typeof next.Сума !== "number"))) return false;
  if (Object.prototype.hasOwnProperty.call(next, "__payroll_removed") &&
      (next.__payroll_removed !== true || next.Кількість !== 0 || next.Зарплата !== 0 || (hasSum && next.Сума !== 0))) return false;
  if (Object.prototype.hasOwnProperty.call(next, "__payroll_act_record_id") &&
      (typeof next.__payroll_act_record_id !== "string" || !next.__payroll_act_record_id.trim() ||
        next.__payroll_act_record_id !== next.__payroll_act_record_id.trim())) return false;
  const fixed = (row: any) => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !fields.includes(key) && ![PAYROLL_PAYMENTS_KEY, "Робота", "__payroll_removed", "__payroll_act_record_id"].includes(key) && !(hasSum && key === "Сума")));
  if (stableActJson(fixed(previous)) !== stableActJson(fixed(next))) return false;
  try { return stableActJson(preservePayrollPaymentHistory(previous, next, parent)) === stableActJson(next); }
  catch { return false; }
}

/** Paid employee totals may change, while their payment events stay fixed. */
function isPaidHeaderAccrualCorrection(previous: any, next: any): boolean {
  if (!next) return false;
  const financial = ["СуммаРоботи", "СуммаЗапчастин", "МаржаДляЗарплати", "ЗарплатаРоботи",
    "ЗарплатаЗапчастин", "ЗарплатаЗапчастистів", "Зарплата", "Знижка",
    "__payroll_percent", "__payroll_percent_work", "__payroll_percent_parts"];
  const fixed = (entry: any) => Object.fromEntries(Object.entries(entry).filter(([key]) =>
    ![...financial, "Записи", PAYROLL_PAYMENTS_KEY, "Клієнт", "Автомобіль", "ДатаЗакриття", "__payroll_input"].includes(key)));
  if (stableActJson(fixed(previous)) !== stableActJson(fixed(next))) return false;
  if (financial.some(key => Object.prototype.hasOwnProperty.call(next, key) && paidWorkNumber(next[key]) === null)) return false;
  for (const key of ["ЗарплатаРоботи", "ЗарплатаЗапчастин", "ЗарплатаЗапчастистів", "Зарплата", "Знижка",
    "__payroll_percent", "__payroll_percent_work", "__payroll_percent_parts"]) {
    if (next[key] != null && (paidWorkNumber(next[key])! < 0 || ((key.startsWith("__payroll_percent") || key === "Знижка") && paidWorkNumber(next[key])! > 100))) return false;
  }
  if (Array.isArray(previous.Записи)) {
    if (!Array.isArray(next.Записи) ||
        stableActJson(previous[PAYROLL_PAYMENTS_KEY]) !== stableActJson(next[PAYROLL_PAYMENTS_KEY])) return false;
    if (financial.filter(key => key !== "СуммаРоботи").some(key =>
        Object.prototype.hasOwnProperty.call(previous, key) !== Object.prototype.hasOwnProperty.call(next, key) ||
        stableActJson(previous[key]) !== stableActJson(next[key]))) return false;
    let total = 0;
    const matched = new Set<any>();
    for (const oldRow of previous.Записи) {
      const candidates = next.Записи.filter((row: any) => String(oldRow.recordId ?? "").trim()
        ? String(oldRow.recordId) === String(row.recordId) : stableActJson(oldRow) === stableActJson(row));
      if (candidates.length !== 1 || matched.has(candidates[0])) return false;
      const row = candidates[0];
      matched.add(row);
      if (stableActJson(oldRow) !== stableActJson(row) && !isPaidWorkAccrualCorrection(oldRow, row, previous)) return false;
    }
    for (const row of next.Записи) {
      if (!matched.has(row) && !isNewUnpaidMechanicWork(row, previous)) return false;
      const price = paidWorkNumber(row.Ціна), quantity = paidWorkNumber(row.Кількість);
      if (price === null || quantity === null || price < 0) return false;
      total += price * quantity;
    }
    return Number.isFinite(total) && paidWorkNumber(next.СуммаРоботи) === Math.max(0, Math.round((total + Number.EPSILON) * 100) / 100);
  }
  if (Object.prototype.hasOwnProperty.call(next, "Записи")) return false;
  for (const key of ["Зарплата", "СуммаРоботи", "СуммаЗапчастин"]) {
    if (Object.prototype.hasOwnProperty.call(previous, key) !== Object.prototype.hasOwnProperty.call(next, key)) return false;
  }
  if (!Object.prototype.hasOwnProperty.call(previous, "СуммаРоботи") &&
      Object.prototype.hasOwnProperty.call(previous, "СуммаЗапчастин") &&
      Object.prototype.hasOwnProperty.call(previous, "ЗарплатаРоботи") !== Object.prototype.hasOwnProperty.call(next, "ЗарплатаРоботи")) return false;
  try { getPayrollEarned(next); return stableActJson(preservePayrollPaymentHistory(previous, next)) === stableActJson(next); }
  catch { return false; }
}

/** Fail before sending any fragment if recovery would change an acknowledged payment. */
function assertPaidPayrollPreserved(before: Entry[], after: Entry[], actId: number, employeeName?: string): void {
  assertNoAccrualPaymentCreation(before, after);
  const old = before[0]?.value, next = after[0]?.value;
  if (!old || stableActJson(before) === stableActJson(after)) return;
  const fail = (reason: string) => {
    throw new PayrollConflict(`Акт №${actId}${employeeName ? `, «${employeeName}»` : ""}: синхронізація змінює вже оплачене нарахування. ${reason} Виплати збережено.`);
  };
  const describeChange = (previous: any, desired: any): string => {
    const fields = ["Зарплата", "ЗарплатаРоботи", "ЗарплатаЗапчастин", "ЗарплатаЗапчастистів",
      "Ціна", "Кількість", "СуммаРоботи", "СуммаЗапчастин", "МаржаДляЗарплати", "Знижка",
      "__payroll_percent", "__payroll_percent_work", "__payroll_percent_parts"];
    const labels: Record<string, string> = { __payroll_percent: "Відсоток",
      __payroll_percent_work: "Відсоток за роботи", __payroll_percent_parts: "Відсоток за запчастини" };
    const key = fields.find(field => {
      try { return payrollNumber(previous?.[field]) !== payrollNumber(desired?.[field]); }
      catch { return stableActJson(previous?.[field] ?? null) !== stableActJson(desired?.[field] ?? null); }
    });
    return key ? `«${labels[key] || key}»: було ${String(previous?.[key] ?? "не вказано")}, стало ${String(desired?.[key] ?? "не вказано")}.`
      : "Змінилися дані або позначка виплати; перевірте оплачений запис.";
  };
  if ((isPayrollPaid(old) || (old.Записи || []).some(isPayrollPaid)) && before[0]?.date !== after[0]?.date) {
    fail(`Дата нарахування: ${before[0]?.date} → ${after[0]?.date ?? "запис відсутній"}.`);
  }
  const financial = (entry: any) => Object.fromEntries(Object.entries(entry || {}).filter(([key]) => !["Клієнт", "Автомобіль", "ДатаЗакриття", "__payroll_input"].includes(key)));
  if (isPayrollPaid(old) && (!next || (stableActJson(financial(old)) !== stableActJson(financial(next)) &&
      !isPaidHeaderAccrualCorrection(old, next)))) {
    fail(next ? describeChange(old, next) : "Оплачене нарахування видалено або змінено виконавця.");
  }
  for (const row of old.Записи || []) {
    if (!isPayrollPaid(row) && !isPayrollPaid(old)) continue;
    const matches = (next?.Записи || []).filter((candidate: any) => String(row.recordId ?? "") !== ""
      ? String(candidate.recordId) === String(row.recordId) : stableActJson(candidate) === stableActJson(row));
    const work = row.Робота ? `Робота «${row.Робота}»: ` : "";
    if (matches.length !== 1) fail(`${work}не вдалося однозначно зіставити оплачений рядок. Перевірте роботу та виконавця.`);
    if (stableActJson(matches[0]) !== stableActJson(row) && !isPaidWorkAccrualCorrection(row, matches[0], old)) {
      fail(work + describeChange(row, matches[0]));
    }
  }
}

// Preserve the application's existing whole-hryvnia rounding, avoiding binary
// floating point errors (e.g. 100 * 29 / 100 must be 29, not 28).
export function payrollPercent(base: number, percent: number): number {
  if (!Number.isFinite(base) || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Некоректна сума або відсоток зарплати (допустимо 0–100).");
  }
  if (base <= 0) return 0;
  // Decimal integer arithmetic: strictly discard the fractional hryvnia,
  // without an epsilon that could accidentally round a value upwards.
  const fraction = (value: number): [bigint, bigint] => {
    const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
    const [integer, decimal = ""] = mantissa.split(".");
    const scale = decimal.length - Number(exponent);
    const numerator = BigInt(integer + decimal);
    return scale >= 0 ? [numerator, 10n ** BigInt(scale)]
      : [numerator * 10n ** BigInt(-scale), 1n];
  };
  const [b, bd] = fraction(base), [p, pd] = fraction(percent);
  return Number(b * p / (bd * pd * 100n));
}

export function floorPayrollSalary(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Некоректна зарплата");
  return Math.floor(value);
}

export function payrollNumber(value: unknown): number {
  if (value == null || value === "") return 0;
  const number = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(number)) throw new Error("Некоректне число в даних зарплати");
  return number;
}

export function payrollInputKey(value: any): string {
  return stableActJson(value);
}

/** Batch payment uses the same server baseline/act guards as individual writes. */
export async function savePayrollPayments(values: any[]): Promise<void> {
  const actor = payrollActorScope();
  const updates = values.flatMap(data => {
    const snapshot = snapshots.get(data);
    if (!snapshot) throw new PayrollConflict('Оновіть зарплату перед розрахунком.');
    const desired = structuredClone(data), changes = payrollChanges(snapshot.data, desired, 'payment');
    return changes.length ? [{snapshot, desired, id: snapshot.id, changes}] : [];
  });
  if (!updates.length) return;
  // One confirmed selection is one transaction: never commit it in chunks.
  if (updates.length > 50) throw new PayrollConflict('За один розрахунок можна обробити до 50 працівників. Звузьте фільтр; жодну виплату не змінено.');
  if (new Set(updates.map(item => item.id)).size !== updates.length) throw new PayrollConflict('Працівник повторюється в пакеті виплат. Оновіть пошук.');
  if (updates.some(item => item.changes.length > 2000)) throw new PayrollConflict('Забагато позицій одного працівника. Звузьте період; жодну виплату не змінено.');
  if (actor !== payrollActorScope()) throw new PayrollConflict('Користувач змінився. Повторіть пошук перед розрахунком.');
  const batch = updates;
  const {data, error} = await supabase.rpc('write_payroll_payment_batch', {p_employees: batch.map(({id, changes}) => ({id, changes}))});
  if (error) throw new PayrollConflict(['PGRST202','42883'].includes(error.code) ? 'Встановіть міграцію accounting_traffic_optimization.' : error.message);
  if (!Array.isArray(data) || data.length !== batch.length || batch.some(item => !data.some(receipt => Number(receipt.slyusar_id) === item.id && ['updated','unchanged'].includes(receipt.status)))) throw new PayrollConflict('Немає підтвердження пакетного розрахунку.');
  for (const item of batch) item.snapshot.data = item.desired;
}
