// src/ts/roboha/ai/aiContextProvider.ts
// 📋 Модуль передачі контексту для AI Атлас
// Збирає та форматує контекст користувача, дату/час, роль, сесію

// ============================================================
// ТИПИ
// ============================================================

export interface UserContext {
  /** ПІБ користувача */
  name: string;
  /** Роль: Адміністратор, Слюсар, Приймальник, Запчастист */
  role: string;
  /** ID користувача (slyusar_id) */
  userId: string | number | null;
  /** ID сесії */
  sessionId: string | null;
}

export interface SystemContext {
  /** Повна дата та час (ISO) */
  datetime: string;
  /** Форматована дата: ДД.ММ.РРРР */
  dateFormatted: string;
  /** Форматований час: ГГ:ХХ */
  timeFormatted: string;
  /** День тижня */
  weekday: string;
  /** Часовий пояс */
  timezone: string;
  /** Платформа */
  platform: string;
  /** Мова інтерфейсу */
  locale: string;
}

export interface AIContext {
  user: UserContext;
  system: SystemContext;
  /** Форматований текстовий блок для вставки в prompt */
  formatted: string;
}

// ============================================================
// ЗБІР КОНТЕКСТУ КОРИСТУВАЧА
// ============================================================

/**
 * Отримує дані поточного користувача з localStorage
 */
function getUserContext(): UserContext {
  const defaultCtx: UserContext = {
    name: "Невідомий",
    role: "Невідомо",
    userId: null,
    sessionId: null,
  };

  try {
    // userAuthData зберігається при логіні
    const storedUser = localStorage.getItem("userAuthData");
    if (storedUser) {
      const userData = JSON.parse(storedUser);
      defaultCtx.name = userData?.["Name"] || userData?.["Ім'я"] || "Невідомий";
      defaultCtx.role = userData?.["Доступ"] || "Невідомо";
      defaultCtx.userId = userData?.["slyusar_id"] || userData?.["id"] || null;
    }

    // Сесія (якщо є)
    const sessionData = localStorage.getItem("sessionData");
    if (sessionData) {
      const session = JSON.parse(sessionData);
      defaultCtx.sessionId = session?.id || session?.sessionId || null;
    }
  } catch {
    /* ігноруємо помилки парсингу */
  }

  return defaultCtx;
}

// ============================================================
// ЗБІР СИСТЕМНОГО КОНТЕКСТУ
// ============================================================

/**
 * Отримує системний контекст (дата, час, платформа)
 */
function getSystemContext(): SystemContext {
  const now = new Date();

  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");

  const weekdays = [
    "Неділя",
    "Понеділок",
    "Вівторок",
    "Середа",
    "Четвер",
    "П'ятниця",
    "Субота",
  ];

  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* fallback */
  }

  let platform = "Веб";
  try {
    const ua = navigator.userAgent || "";
    if (/mobile|android|iphone|ipad/i.test(ua)) platform = "Мобільний";
    else if (/tablet|ipad/i.test(ua)) platform = "Планшет";
  } catch {
    /* fallback */
  }

  return {
    datetime: now.toISOString(),
    dateFormatted: `${dd}.${mm}.${yyyy}`,
    timeFormatted: `${hh}:${mi}`,
    weekday: weekdays[now.getDay()],
    timezone,
    platform,
    locale: "uk-UA",
  };
}

// ============================================================
// ФОРМУВАННЯ ПОВНОГО КОНТЕКСТУ
// ============================================================

/**
 * Збирає повний контекст для передачі в AI.
 * Використовується при кожному запиті.
 */
export function buildAIContext(): AIContext {
  const user = getUserContext();
  const system = getSystemContext();

  // 💡 ОПТИМІЗАЦІЯ: компактний формат без декоративних ліній (економія токенів)
  const lines: string[] = [
    `📅${system.dateFormatted} (${system.weekday}) 🕐${system.timeFormatted}`,
    `👤${user.name} 🔑${user.role}${user.userId ? ` ID:${user.userId}` : ""}`,
  ];

  return {
    user,
    system,
    formatted: lines.join("\n"),
  };
}

/**
 * Отримує компактний контекст (для light-режиму, менше токенів)
 */
export function buildCompactContext(): string {
  const user = getUserContext();
  const now = new Date();

  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");

  return `📅${dd}.${mm}.${yy} 🕐${hh}:${mi} 👤${user.name} 🔑${user.role}`;
}

/**
 * Перевіряє чи користувач має роль адміністратора
 */
export function isAdminUser(): boolean {
  const user = getUserContext();
  return /адміністратор|admin|адмін/i.test(user.role);
}

/**
 * Повертає реальне ПІБ користувача (для фільтрації даних по ролі)
 */
export function getCurrentUserName(): string {
  return getUserContext().name;
}

/**
 * Повертає роль поточного користувача
 */
export function getCurrentUserRole(): string {
  return getUserContext().role;
}
