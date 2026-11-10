import { readActJson } from "../../utils/actSafeWrite";
import { isActFrozen } from "../../utils/actFrozenState";
import { readWorkshop } from "./model";
export interface AttentionItem { actId?: number; category: string; text: string; destination?: "planner" | "stock" }
export interface AttentionScope { role: string; name: string; prices: boolean }
export function isActInAttentionScope(act: any, scope: AttentionScope): boolean {
  if (scope.role === "Приймальник") return act.pruimalnyk === scope.name;
  if (scope.role === "Слюсар") {
    const data = readActJson(act.data);
    return Array.isArray(data.Роботи) && data.Роботи.some((w: any) => w.Слюсар === scope.name);
  }
  return ["Адміністратор", "Запчастист", "Складовщик"].includes(scope.role);
}
export function inspectActAttention(act: any, scope: AttentionScope): AttentionItem[] {
  if (!isActInAttentionScope(act, scope)) return [];
  const data = readActJson(act.data);
  const works = Array.isArray(data.Роботи) ? data.Роботи.filter((w: any) => String(w?.Робота || "").trim()) : [];
  if (scope.role === "Приймальник" && act.pruimalnyk !== scope.name) return [];
  if (scope.role === "Слюсар" && !works.some((w: any) => w.Слюсар === scope.name)) return [];
  if (isActFrozen(act)) return [];
  const result: AttentionItem[] = [];
  const push = (category: string, text: string) => result.push({ actId: act.act_id, category, text });
  const section = readWorkshop(data);
  const pending = section.recommendations.filter(r => r.state === "proposed" || r.state === "approved");
  if (pending.length) push("Рекомендації", `Незавершених рекомендацій: ${pending.length}`);
  if (!act.date_off) {
    const visibleWorks = scope.role === "Слюсар" ? works.filter((w: any) => w.Слюсар === scope.name) : works;
    const details = Array.isArray(data.Деталі) ? data.Деталі.filter((d: any) => String(d?.Деталь || "").trim()) : [];
    const missingWorker = visibleWorks.filter((w: any) => !String(w.Слюсар || "").trim()).length;
    if (missingWorker) push("Виконавці", `Робіт без призначеного виконавця: ${missingWorker}`);
    if (scope.prices && scope.role !== "Слюсар") {
      const price = (v: any) => Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
      const missingPrice = [...visibleWorks, ...details].filter((r: any) => !Number.isFinite(price(r.Ціна)) || price(r.Ціна) <= 0).length;
      if (missingPrice) push("Ціни", `Позицій без додатної ціни: ${missingPrice} — перевірте, чи це навмисно`);
    }
    if (act.slusarsOn === true && ["Адміністратор", "Приймальник"].includes(scope.role)) push("Завершення робіт", "Є позначка завершення робіт слюсарем. Перевірте готовність і зв’язок із клієнтом.");
    if (data.__payroll_pending === true && scope.role === "Адміністратор") push("Збереження", "В акті є позначка незавершеного оновлення нарахувань. Потрібна перевірка; огляд нічого не перераховує.");
  }
  return result;
}
