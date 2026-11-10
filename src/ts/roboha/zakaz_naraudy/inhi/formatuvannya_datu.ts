// formatuvannya_datu.ts - Функції для форматування дати та часу

/**
 * Функція для форматування локальної дати та часу у формат 'YYYY-MM-DD HH:MM:SS'
 * для збереження в базі даних з колонкою 'timestamp without time zone'.
 * @param date Об'єкт Date, що представляє локальний час.
 * @returns Рядок дати та часу у форматі 'YYYY-MM-DD HH:MM:SS'.
 */
export function formatLocalDateTimeForDB(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // Місяці від 0 до 11
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Функція для форматування рядка дати з бази даних для відображення у локальному форматі.
 * Припускає, що рядок з БД є локальним часом, оскільки колонка 'timestamp without time zone'.
 * @param dateString Рядок дати з бази даних (наприклад, "2025-07-23 22:27:38").
 * @returns Відформатований рядок дати та часу або null.
 */
export const formatDate = (dateString: string | null): string | null => {
  if (!dateString) {
    return null;
  }
  // Створюємо Date об'єкт з рядка.
  // НЕ ДОДАЄМО 'Z', оскільки рядок з БД вже є локальним часом.
  const date = new Date(dateString);

  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Форматує об'єкт Date в об'єкт з властивостями date та time.
 * @param date Об'єкт Date.
 * @returns Об'єкт з відформатованими датою та часом.
 */
export function formatDateTime(date: Date): { date: string; time: string } {
  const d = date.getDate().toString().padStart(2, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const y = date.getFullYear();
  const h = date.getHours().toString().padStart(2, "0");
  const min = date.getMinutes().toString().padStart(2, "0");

  return {
    date: `${d}.${m}.${y}`,
    time: `${h}:${min}`,
  };
}
