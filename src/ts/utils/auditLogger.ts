import { supabase } from "../vxid/supabaseClient";

/**
 * Категорії аудиту — для фільтрації та візуального відрізнення
 */
export type AuditCategory =
  | "act" // 🔧 Акти (відкрити, закрити, заморозити, зміни рядків)
  | "order" // 📋 Наряд (створення замовлення)
  | "client" // 👥 Клієнт / Авто
  | "planning" // 📅 Планувальник
  | "settings" // ⚙️ Налаштування (бази, категорії, пости)
  | "warehouse"; // 📦 Склад (імпорт, зміни)

export async function logAction(
  action: string,
  actId: number | null,
  details: any = {},
  category: AuditCategory = "act",
): Promise<void> {
  try {
    const storedData = localStorage.getItem("userAuthData");
    if (!storedData) return;

    const userData = JSON.parse(storedData);
    const userLogin = userData?.Name || "Невідомо";
    const userRole = userData?.["Доступ"] || "Невідомо";

    const { error } = await supabase.from("audit_logs").insert({
      user_login: userLogin,
      user_role: userRole,
      action,
      act_id: actId,
      details: { ...details, _category: category },
    });

    if (error) {
      // console.error("❌ Помилка при записі логу:", error.message);
    }
  } catch (err) {
    // console.error("❌ Помилка логування дії:", err);
  }
}

/**
 * Хелпер: порівняти два обʼєкти і повернути список змін "поле: було → стало"
 */
export function diffChanges(
  oldObj: Record<string, any>,
  newObj: Record<string, any>,
  fieldLabels?: Record<string, string>,
): string[] {
  const changes: string[] = [];
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    const oldVal = oldObj[key] ?? "";
    const newVal = newObj[key] ?? "";
    if (String(oldVal) !== String(newVal)) {
      const label = fieldLabels?.[key] || key;
      changes.push(`${label}: «${oldVal}» → «${newVal}»`);
    }
  }
  return changes;
}
