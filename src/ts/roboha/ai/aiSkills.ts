// src/ts/roboha/ai/aiSkills.ts
// 🧩 Система скілів для AI Атлас — динамічне завантаження промптів з БД
// Замість одного великого промпту → лише релевантні скіли за ключовими словами

import { supabase } from "../../vxid/supabaseClient";

// ─────────────────────────────────────────────────────────────────────
// ТИПИ
// ─────────────────────────────────────────────────────────────────────

export const SKILL_CATEGORIES = [
  { value: "general", label: "🌐 Загальний" },
  { value: "database", label: "🗄️ База даних" },
  { value: "rules", label: "📏 Правила" },
  { value: "format", label: "🎨 Формат" },
  { value: "tools", label: "🔧 Інструменти" },
  { value: "internet", label: "🌍 Інтернет" },
  { value: "technical", label: "⚙️ Технічний" },
  { value: "operational", label: "📋 Операційний" },
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number]["value"];

export function isSkillCategory(value: string): value is SkillCategory {
  return SKILL_CATEGORIES.some((category) => category.value === value);
}

export function getSkillCategoryLabel(category: string): string {
  return (
    SKILL_CATEGORIES.find((item) => item.value === category)?.label || category
  );
}

export interface AISkill {
  skill_id: number;
  name: string;
  category: SkillCategory;
  keywords: string[];
  prompt: string;
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ─────────────────────────────────────────────────────────────────────
// КЕШ — скіли завантажуються один раз і кешуються
// ─────────────────────────────────────────────────────────────────────

let skillsCache: AISkill[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 хвилин

/** Скинути кеш (після CRUD) */
export function invalidateSkillsCache(): void {
  skillsCache = null;
  cacheTimestamp = 0;
}

// ─────────────────────────────────────────────────────────────────────
// ЗАВАНТАЖЕННЯ СКІЛІВ
// ─────────────────────────────────────────────────────────────────────

/** Завантажити всі активні скіли з БД (з кешуванням) */
export async function loadSkills(): Promise<AISkill[]> {
  if (skillsCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return skillsCache;
  }

  const { data, error } = await supabase
    .from("ai_skills")
    .select("*")
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (error) return skillsCache || [];

  skillsCache = (data || []) as AISkill[];
  cacheTimestamp = Date.now();
  return skillsCache;
}

/** Завантажити ВСІ скіли (включаючи неактивні) — для CRUD UI */
export async function loadAllSkills(): Promise<AISkill[]> {
  const { data, error } = await supabase
    .from("ai_skills")
    .select("*")
    .order("priority", { ascending: false });

  if (error) return [];

  return (data || []) as AISkill[];
}

// ─────────────────────────────────────────────────────────────────────
// МАТЧІНГ СКІЛІВ ПО ЗАПИТУ КОРИСТУВАЧА
// ─────────────────────────────────────────────────────────────────────

/**
 * Знаходить релевантні скіли для запиту користувача.
 *
 * 3 рівні завантаження:
 *  🟢 ЯДРО (keywords=[], priority≥90) — завжди: Базовий, Заборони, Розмовний
 *  🟡 ДОВІДНИК (keywords=[], priority<90) — тільки коли спрацював хоч 1 keyword-скіл:
 *      Карта БД, Перекладач запитів, JSONB
 *  🔵 ДОМЕН (keywords=[...]) — по ключових словах: Акти, Клієнти, Склад і т.д.
 *
 *  Це економить токени: "привіт" → 3 скіли, "відкриті акти" → 3+3+1 = 7 скілів
 */
export async function matchSkills(userQuery: string): Promise<AISkill[]> {
  const skills = await loadSkills();
  const q = userQuery.toLowerCase();

  const coreSkills: AISkill[] = []; // ядро — завжди
  const referenceSkills: AISkill[] = []; // довідник — тільки якщо є match
  const keywordMatched: AISkill[] = []; // домен — по keywords

  for (const skill of skills) {
    if (skill.keywords.length === 0) {
      // Без keywords → ядро (≥90) або довідник (<90)
      if (skill.priority >= 90) {
        coreSkills.push(skill);
      } else {
        referenceSkills.push(skill);
      }
      continue;
    }

    // Перевіряємо кожне keyword
    for (const kw of skill.keywords) {
      // Підтримка regex-подібних keywords (наприклад "хто.*робить")
      try {
        const regex = new RegExp(kw, "i");
        if (regex.test(q)) {
          keywordMatched.push(skill);
          break;
        }
      } catch {
        // Якщо keyword не regex — простий пошук підрядка
        if (q.includes(kw.toLowerCase())) {
          keywordMatched.push(skill);
          break;
        }
      }
    }
  }

  // Збірка: ядро завжди + довідник тільки якщо є keyword-матч або запит про структуру/БД
  const isSystemQuery =
    /база|таблиц|схем|структур|поле|колонк|скіл|skill|sql|query|запит|audit|аудит|лог/i.test(
      q,
    );

  const matched = [...coreSkills];
  if (keywordMatched.length > 0 || isSystemQuery) {
    matched.push(...referenceSkills, ...keywordMatched);
  }

  // Сортуємо за priority (desc)
  matched.sort((a, b) => b.priority - a.priority);
  return matched;
}

/**
 * Будує об'єднаний промпт з відібраних скілів.
 * Це замінює величезний статичний systemPromptText.
 */
export async function buildSkillPrompt(userQuery: string): Promise<string> {
  const skills = await matchSkills(userQuery);

  if (skills.length === 0) {
    // Фолбек — мінімальний промпт
    return 'Ти — AI "Атлас" для СТО. ТІЛЬКИ українською. Тільки реальні дані.';
  }

  const parts = skills.map((s) => s.prompt);
  return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────
// CRUD ОПЕРАЦІЇ (для UI налаштувань)
// ─────────────────────────────────────────────────────────────────────

/** Створити новий скіл */
export async function createSkill(
  skill: Omit<AISkill, "skill_id" | "created_at" | "updated_at">,
): Promise<AISkill | null> {
  const { data, error } = await supabase
    .from("ai_skills")
    .insert({
      name: skill.name,
      category: skill.category,
      keywords: skill.keywords,
      prompt: skill.prompt,
      is_active: skill.is_active,
      priority: skill.priority,
    })
    .select()
    .single();

  if (error) return null;

  invalidateSkillsCache();
  return data as AISkill;
}

/** Оновити скіл */
export async function updateSkill(
  skillId: number,
  updates: Partial<Omit<AISkill, "skill_id" | "created_at">>,
): Promise<boolean> {
  const { error } = await supabase
    .from("ai_skills")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("skill_id", skillId);

  if (error) return false;

  invalidateSkillsCache();
  return true;
}

/** Видалити скіл */
export async function deleteSkill(skillId: number): Promise<boolean> {
  const { error } = await supabase
    .from("ai_skills")
    .delete()
    .eq("skill_id", skillId);

  if (error) return false;

  invalidateSkillsCache();
  return true;
}

/** Перемкнути активність скіла */
export async function toggleSkillActive(
  skillId: number,
  isActive: boolean,
): Promise<boolean> {
  return updateSkill(skillId, { is_active: isActive });
}
