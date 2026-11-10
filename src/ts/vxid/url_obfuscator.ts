// src/ts/vxid/url_obfuscator.ts

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function obfuscateCurrentUrl(): void {
  // Генеруємо фейкові дані
  const sessionId = generateRandomString(30);
  const token = generateRandomString(100);
  const ts = Date.now();

  // Формуємо "страшний" URL
  // ?data=...&session=...&token=...
  const queryParams = `?s_id=${sessionId}&auth_token=${token}&timestamp=${ts}&secure_mode=true`;

  const currentPath = window.location.pathname;
  const newUrl = `${currentPath}${queryParams}`;

  // Підміняємо адресу без перезавантаження
  window.history.replaceState({ path: newUrl }, '', newUrl);
}

// 👇 2. ДОДАЙ ЦЕЙ КОД В САМИЙ НИЗ
// document.addEventListener("DOMContentLoaded", () => {
//   obfuscateCurrentUrl();
// });
