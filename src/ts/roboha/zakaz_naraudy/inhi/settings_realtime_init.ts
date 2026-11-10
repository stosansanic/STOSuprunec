// src/ts/roboha/zakaz_naraudy/inhi/settings_realtime_init.ts
/**
 * Автоматична ініціалізація підписки на зміни settings
 * при завантаженні сторінки для всіх користувачів.
 * Підтримує Capacitor Android/iOS — перепідключення при поверненні з фону.
 */

import {
  initializeSettingsSubscription,
  disconnectSettingsSubscription,
} from "./settings_subscription";

// Ініціалізуємо підписку автоматично при імпорті модуля
initializeSettingsSubscription();

// ─── LIFECYCLE: Перепідключення при поверненні з фону (Android/iOS) ───

let wasHidden = false;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    wasHidden = true;
    // Відключаємо підписку — Android вб'є WebSocket у фоні
    disconnectSettingsSubscription();
  } else if (document.visibilityState === "visible" && wasHidden) {
    wasHidden = false;
    // Повернулись — оновлюємо кеш і перепідключаємо
    initializeSettingsSubscription(true);
  }
});

// Перепідключення при відновленні мережі
window.addEventListener("online", () => {
  // Якщо підписка була втрачена — перезавантажуємо кеш і перепідключаємо
  initializeSettingsSubscription(true);
});
