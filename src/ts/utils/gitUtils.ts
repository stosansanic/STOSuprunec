// src/ts/utils/gitUtils.ts
// 🔧 УТИЛІТИ для роботи з гітом

import { getBaseUrl, DEPLOY_URLS } from "../../config/project.config";

const CACHE_KEY = "gitName_cache";

/**
 * Визначення gitName з кешу або URL (fallback коли база недоступна)
 * @returns string - назва гіта з кешу/URL
 */
function getGitNameFallback(): string {
  try {
    // Спочатку перевіряємо кеш
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      return cached;
    }

    // Якщо кешу немає - беремо з URL
    const hostname = window.location.hostname; // наприклад: "
    if (hostname.endsWith(".github.io")) {
      return hostname.replace(".github.io", ""); // ""
    }

    // Для localhost - повертаємо з кешу або пустий рядок
    return cached || "";
  } catch {
    return "";
  }
}

/**
 * Отримання назви гіта з бази даних (setting_id: 1, стовпець infaGit)
 * @returns Promise<string> - назва гіта (наприклад, ")
 */
export async function getGitName(): Promise<string> {
  // 🔥 Для Vercel/localhost не потрібно отримувати gitName з БД
  // URL формується динамічно через window.location.origin
  return getGitNameFallback();
}

/**
 * Формування повного URL
 * @param gitName - назва гіта (для GitHub Pages) або ігнорується для Vercel
 * @param path - додатковий шлях (опціонально)
 * @returns string - повний URL
 */
export function buildGitUrl(gitName: string, path: string = ""): string {
  // 🔥 Використовуємо поточний origin (домен) замість захардкодженого GitHub URL
  const hostname = window.location.hostname;

  let baseUrl: string;

  if (hostname.endsWith(".github.io")) {
    // GitHub Pages - repo з .env
    baseUrl = `https://${gitName}.github.io/${DEPLOY_URLS.githubRepo}`;
  } else {
    // Vercel, localhost або інший хостинг - використовуємо origin
    baseUrl = window.location.origin;
  }

  return path ? `${baseUrl}/${path}` : `${baseUrl}/`;
}

/**
 * Отримання повного гіт URL з бази даних
 * @param path - додатковий шлях (опціонально)
 * @returns Promise<string> - повний URL
 */
export async function getGitUrl(path: string = ""): Promise<string> {
  const gitName = await getGitName();
  return buildGitUrl(gitName, path);
}

/**
 * Отримання fallback URL (з обробкою помилок)
 * @param path - додатковий шлях (опціонально)
 * @returns Promise<string> - повний URL або fallback
 */
export async function getFallbackUrl(path: string = ""): Promise<string> {
  try {
    return await getGitUrl(path);
  } catch (error) {
    // console.error("❌ Помилка отримання URL, використовую fallback:", error);
    return buildGitUrl(getGitNameFallback(), path);
  }
}

/**
 * 🔄 Редірект на сторінку з урахуванням середовища (Vercel/GitHub/localhost)
 * @param page - назва сторінки (наприклад, "main.html", "index.html")
 */
export function redirectTo(page: string = "index.html"): void {
  // 🔧 Використовуємо централізований конфіг
  const baseUrl = getBaseUrl();
  window.location.href = `${baseUrl}/${page}`;
}

/**
 * 🔄 Редірект на головну сторінку (index.html)
 */
export function redirectToIndex(): void {
  redirectTo("index.html");
}

/**
 * 🔄 Редірект на main.html
 */
export function redirectToMain(): void {
  redirectTo("main.html");
}
