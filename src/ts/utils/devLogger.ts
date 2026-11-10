// src/ts/utils/devLogger.ts
// ─────────────────────────────────────────────────────────────────────────────
// Централізований логер: у production мовчить, в dev і localhost — пише в консоль
// ─────────────────────────────────────────────────────────────────────────────

const isDev: boolean = (() => {
  try {
    // Vite: import.meta.env.DEV = true під час розробки
    if (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV) {
      return true;
    }
  } catch {
    /* */
  }
  // Fallback: localhost або 127.0.0.1
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname.startsWith("192.168.")
  );
})();

/** 🔵 Інформаційний лог — лише в dev */
export function devLog(...args: unknown[]): void {
  if (isDev) console.log(...args);
}

/** 🟡 Попередження — лише в dev */
export function devWarn(...args: unknown[]): void {
  if (isDev) console.warn(...args);
}

/** 🔴 Помилка — завжди (критично важливо знати навіть у production) */
export function devError(...args: unknown[]): void {
  console.error(...args);
}

/** ✅ Успіх / підтвердження — лише в dev */
export function devInfo(...args: unknown[]): void {
  if (isDev) console.info(...args);
}
