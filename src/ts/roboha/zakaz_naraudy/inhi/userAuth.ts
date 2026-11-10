// src/ts/vxid/userAuth.ts

/**
 * Модуль для керування даними автентифікації користувача
 */

export let userAccessLevel: string | null = null;
export let userName: string | null = null;
export let isAuthenticated = false;

/**
 * Встановлення даних користувача
 */
export function setUserData(name: string, access: string): void {
  userName = name;
  userAccessLevel = access;
  isAuthenticated = true;
}

/**
 * Очищення даних користувача
 */
export function clearUserData(): void {
  userName = null;
  userAccessLevel = null;
  isAuthenticated = false;
}

/**
 * Ініціалізація даних користувача з localStorage
 */
export function initUserFromLocalStorage(): void {
  try {
    const user = localStorage.getItem("user");
    if (user) {
      const userData = JSON.parse(user);
      
      // Підтримка різних форматів збереження
      const name = userData.Name || userData.name || userData["Ім'я"] || "Користувач";
      const access = userData.Доступ || userData.access || "Адміністратор";
      
      setUserData(name, access);
    }
  } catch (error) {
    // console.error("❌ Помилка ініціалізації користувача з localStorage:", error);
  }
}

/**
 * Перевірка чи користувач є адміністратором
 */
export function isAdmin(): boolean {
  return userAccessLevel === "Адміністратор";
}

/**
 * Перевірка чи користувач є слюсарем
 */
export function isSlyusar(): boolean {
  return userAccessLevel === "Слюсар";
}

// Автоматична ініціалізація при імпорті модуля
initUserFromLocalStorage();