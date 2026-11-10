// Auxiliary records only. Never store these in Роботи/Деталі or payroll fields.
export const WORKSHOP_KEY = "__workshop_v1";
export const recommendationStates = {
  proposed: "Рекомендовано", approved: "Погоджено", completed: "Виконано", declined: "Клієнт відмовився",
} as const;
export const defectStates = { inspect: "Перевірити", good: "Справне", repair: "Ремонтувати", replace: "Замінити" } as const;
export interface EntryMeta { id: string; updatedAt: string; author: string }
export interface Defect extends EntryMeta {
  assembly: string; component: string; before: string; after: string;
  tolerance: string; finding: string; operation: string; photoUrl: string;
  state: keyof typeof defectStates;
}
export interface Recommendation extends EntryMeta {
  text: string; state: keyof typeof recommendationStates; sourceDefectId?: string;
}
export interface WorkshopData { version: 1; defects: Defect[]; recommendations: Recommendation[] }
export type Entry = Defect | Recommendation;
export type Collection = "defects" | "recommendations";

export function readWorkshop(data: Record<string, any>): WorkshopData {
  const value = data[WORKSHOP_KEY];
  if (value == null) return { version: 1, defects: [], recommendations: [] };
  if (value.version !== 1 || !Array.isArray(value.defects) || !Array.isArray(value.recommendations)) {
    throw new Error("Невідомий формат картки. Дані не перезаписано.");
  }
  for (const key of ["defects", "recommendations"] as const) {
    const ids = new Set<string>();
    for (const item of value[key]) {
      if (!item || typeof item.id !== "string" || ids.has(item.id)) throw new Error("Пошкоджені записи картки. Збереження зупинено.");
      ids.add(item.id);
    }
  }
  return structuredClone(value);
}

export function safePhotoUrl(value: string): string {
  if (!value.trim()) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Для фото вкажіть посилання https:// без пароля.");
  return url.href;
}

export function validateEntry(collection: Collection, entry: Entry): void {
  if (!entry.id || !entry.author || !entry.updatedAt) throw new Error("Не визначено автора запису.");
  for (const value of Object.values(entry)) {
    if (typeof value !== "string" || value.length > 12000) throw new Error("Некоректне або надто довге поле картки.");
  }
  if (collection === "defects") {
    const d = entry as Defect;
    if (!d.component?.trim() || !Object.prototype.hasOwnProperty.call(defectStates, d.state)) throw new Error("Вкажіть вузол і стан дефектування.");
    safePhotoUrl(d.photoUrl);
  } else {
    const r = entry as Recommendation;
    if (!r.text?.trim() || !Object.prototype.hasOwnProperty.call(recommendationStates, r.state)) throw new Error("Вкажіть рекомендацію та її стан.");
  }
}

// Compare the edited record, not the entire document: unrelated colleagues' edits survive.
export function replaceWorkshopEntry(
  data: Record<string, any>, collection: Collection, expected: Entry | null, next: Entry,
  same: (a: unknown, b: unknown) => boolean,
): void {
  validateEntry(collection, next);
  const section = readWorkshop(data);
  const rows = section[collection] as Entry[];
  const index = rows.findIndex(row => row.id === next.id);
  const current = index < 0 ? null : rows[index];
  if (!same(current, expected)) throw new Error("Цей запис уже змінив інший працівник. Ваш текст залишено у формі; відкрийте актуальну картку для порівняння.");
  if (collection === "recommendations" && !expected && (next as Recommendation).sourceDefectId && rows.some(r => (r as Recommendation).sourceDefectId === (next as Recommendation).sourceDefectId)) {
    throw new Error("Рекомендацію для цього дефекту вже створено іншим працівником. Оновіть картку.");
  }
  if (index < 0) rows.push(structuredClone(next));
  else rows[index] = structuredClone(next);
  data[WORKSHOP_KEY] = section;
}
