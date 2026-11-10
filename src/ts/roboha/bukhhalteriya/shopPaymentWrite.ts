import { missingAccountingRpc } from "./accountingRequests";
import { supabase } from "../../vxid/supabaseClient";

export interface DetailPaymentTarget {
  rowId: string; shopId: number; dateOpen: string; act: string;
  entryOrdinal: number; detailOrdinal: number; paymentFingerprint: string;
  paymentDate?: string; isPaid: boolean;
}
export interface DetailPaymentReceipt { rowId: string; paidAt: string | null; fingerprint: string }
export interface StockPaymentReceipt { id: number; paidAt: string | null; fingerprint: string }
const validFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireBatch(count: number): void {
  if (!count || count > 2000) throw new Error('Оберіть від 1 до 2000 завантажених позицій. Звузьте період або фільтр.');
}
export async function saveDetailPayments(rows: DetailPaymentTarget[], desired: string | null, client = supabase): Promise<DetailPaymentReceipt[]> {
  requireBatch(rows.length);
  const changes = rows.map(row => {
    if (!row.rowId || !Number.isSafeInteger(row.shopId) || row.shopId <= 0 || !Number.isSafeInteger(row.entryOrdinal) || row.entryOrdinal <= 0 ||
      !Number.isSafeInteger(row.detailOrdinal) || row.detailOrdinal <= 0 || !validFingerprint(row.paymentFingerprint)) throw new Error('Оновіть SQL бухгалтерії та повторіть пошук.');
    return {shopId: row.shopId, date: row.dateOpen, act: row.act, entryOrdinal: row.entryOrdinal, detailOrdinal: row.detailOrdinal,
      fingerprint: row.paymentFingerprint, expected: row.paymentDate || null, desired};
  });
  if (new Set(rows.map(row => row.rowId)).size !== rows.length) throw new Error('Повторні позиції розрахунку.');
  const {data, error} = await client.rpc('write_shop_detail_payments', {p_changes: changes});
  if (error) throw missingAccountingRpc('write_shop_detail_payments', error);
  if (!Array.isArray(data) || data.length !== rows.length || new Set(data.map(row => row.rowId)).size !== rows.length ||
    rows.some(row => !data.some(receipt => receipt.rowId === row.rowId && receipt.paidAt === desired && receipt.fingerprint === row.paymentFingerprint)))
    throw new Error('Немає підтвердження розрахунку деталей. Повторіть пошук.');
  return data;
}
export async function saveStockPayments(rows: Record<string, any>[], desired: string | null, client = supabase): Promise<StockPaymentReceipt[]> {
  requireBatch(rows.length);
  const changes = rows.map(row => {
    const id = Number(row.sclad_id);
    if (!Number.isSafeInteger(id) || id <= 0 || !validFingerprint(row.paymentFingerprint)) throw new Error('Оновіть SQL бухгалтерії та повторіть пошук.');
    return {id, fingerprint: row.paymentFingerprint, expected: row.rosraxovano ?? null, desired};
  });
  if (new Set(changes.map(row => row.id)).size !== rows.length) throw new Error('Повторні позиції розрахунку.');
  const {data, error} = await client.rpc('write_stock_payment_rows', {p_changes: changes});
  if (error) throw missingAccountingRpc('write_stock_payment_rows', error);
  if (!Array.isArray(data) || data.length !== rows.length || new Set(data.map(row => Number(row.id))).size !== rows.length ||
    changes.some(row => !data.some(receipt => Number(receipt.id) === row.id && receipt.paidAt === desired && receipt.fingerprint === row.fingerprint)))
    throw new Error('Немає підтвердження розрахунку складу. Повторіть пошук.');
  return data;
}

const baseline = new WeakMap<object, { id: number; data: any }>();
const copy = <T>(value: T): T => structuredClone(value);
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function trackShopPaymentData(id: number, data: any): any {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Відсутній ID магазину");
  baseline.set(data, { id, data: copy(data) });
  return data;
}
/** Restore only the latest acknowledged state, including earlier successful shops in a bulk write. */
export function restoreShopPaymentSnapshot(data: any): void {
  const snapshot = baseline.get(data);
  if (!snapshot) return;
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, copy(snapshot.data));
}
function payment(entry: any): string | null {
  if (entry.Розрахунок == null) return null;
  if (typeof entry.Розрахунок !== "string") throw new Error("Некоректна дата розрахунку");
  return entry.Розрахунок;
}
function entries(data: any): Map<string, { date: string; act: string; value: any }> {
  const result = new Map<string, { date: string; act: string; value: any }>();
  for (const [date, rows] of Object.entries(data.Історія || {})) {
    if (!Array.isArray(rows)) throw new Error("Некоректна історія магазину");
    for (const value of rows) {
      if (value?.Акт == null) throw new Error("Запис історії без акта");
      const act = String(value.Акт), key = JSON.stringify([date, act]);
      if (result.has(key)) throw new Error("Повторний акт в історії магазину: оновіть дані");
      result.set(key, { date, act, value });
    }
  }
  return result;
}

/** Merge only settlement fields. Other concurrent shop fields/history stay intact. */
export function mergeShopPayments(base: any, next: any, fresh: any): any {
  const before = entries(base), after = entries(next);
  const result = copy(fresh), current = entries(result);
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) throw new Error("Новий запис не можна зберігати через зміну оплати");
    const desired = payment(entry.value), previous = payment(old.value);
    if (desired === previous) continue;
    const target = current.get(key);
    if (!target) throw new Error("Запис переміщено або видалено: оновіть дані");
    const actual = payment(target.value);
    if (actual !== desired && actual !== previous) throw new Error("Розрахунок уже змінено: оновіть дані");
    const originalRecord = { ...old.value }, currentRecord = { ...target.value };
    delete originalRecord.Розрахунок; delete currentRecord.Розрахунок;
    if (canonical(originalRecord) !== canonical(currentRecord)) throw new Error("Деталі акта змінилися: перевірте суму перед оплатою");
    if (desired === null) delete target.value.Розрахунок;
    else target.value.Розрахунок = desired;
  }
  return result;
}

export async function saveShopPayments(shops: object[], client = supabase): Promise<void> {
  const updates = shops.flatMap(shop => {
    const snapshot = baseline.get(shop);
    if (!snapshot) throw new Error('Оновіть історію перед зміною оплати');
    const desired = copy(shop), before = entries(snapshot.data);
    const changes = [...entries(desired).values()].flatMap(entry => {
      const previous = before.get(JSON.stringify([entry.date, entry.act]));
      if (!previous) throw new Error('Новий запис не можна зберігати через зміну оплати');
      if (payment(entry.value) === payment(previous.value)) return [];
      const fingerprint = previous.value.__payment_fingerprint;
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Оновіть SQL бухгалтерії та повторно відкрийте звіт');
      return [{date: entry.date, act: entry.act, fingerprint, expected: payment(previous.value), desired: payment(entry.value)}];
    });
    return changes.length ? [{snapshot, desired, id: snapshot.id, changes}] : [];
  });
  for (let offset = 0; offset < updates.length; offset += 50) {
    const batch = updates.slice(offset, offset + 50);
    const {data, error} = await client.rpc('write_shop_payment_fragments', {p_shops: batch.map(({id, changes}) => ({id, changes}))});
    if (error) throw missingAccountingRpc('write_shop_payment_fragments', error);
    if (!Array.isArray(data) || data.length !== batch.length || batch.some(item => !data.some(row => Number(row.id) === item.id && row.status === 'saved'))) throw new Error('Немає підтвердження розрахунку магазину. Оновіть звіт.');
    for (const item of batch) item.snapshot.data = item.desired;
  }
}
