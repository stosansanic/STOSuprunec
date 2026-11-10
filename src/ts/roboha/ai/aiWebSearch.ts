// src/ts/roboha/ai/aiWebSearch.ts
// 🌐 Модуль інтернет-пошуку для AI Атлас
// Єдиний метод: Gemini Search Grounding (обробляється в aiChat.ts)

// ============================================================
// ТИПИ
// ============================================================

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string; // домен сайту
}

export interface WebSearchResponse {
  success: boolean;
  results: WebSearchResult[];
  query: string;
  error?: string;
  source: "grounding" | "fallback";
}

// ============================================================
// GEMINI FUNCTION DECLARATION ДЛЯ search_internet
// ============================================================

/**
 * Повертає Gemini function declaration для інструменту search_internet
 */
export function getSearchInternetToolDeclaration(): any {
  return {
    name: "search_internet",
    description: `Пошук в інтернеті. Коли питають запчастини/ціни/артикули → auto_parts_mode=true. Пріоритет: elit.ua,exist.ua,avtopro.ua,dok.ua,omega.page,intercars.com.ua`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Пошуковий запит (назва+марка+модель+рік)",
        },
        auto_parts_mode: {
          type: "boolean",
          description: "true=запчастини/ціни, false=загальний пошук",
        },
        vin_code: {
          type: "string",
          description: "VIN-код (17 символів)",
        },
        sites: {
          type: "array",
          description: "Конкретні сайти: ['elit.ua','exist.ua']",
          items: { type: "string" },
        },
      },
      required: ["query"],
    },
  };
}

/**
 * Форматує результати пошуку в текст для AI
 */
export function formatSearchResults(response: WebSearchResponse): string {
  if (!response.success || response.results.length === 0) {
    return response.error
      ? `🔍 Пошук "${response.query}": ${response.error}`
      : `🔍 Нічого не знайдено за запитом "${response.query}"`;
  }

  let text = `🔍 Результати пошуку "${response.query}" (Gemini Search):\n\n`;

  response.results.forEach((r, i) => {
    text += `${i + 1}. **${r.title}**\n`;
    text += `   🔗 ${r.url}\n`;
    if (r.snippet) text += `   ${r.snippet}\n`;
    text += "\n";
  });

  return text;
}

/**
 * Скидає кеш ключів пошуку (заглушка — кешу немає)
 */
export function resetSearchKeyCache(): void {
  // Нічого не робимо — пошук через Gemini Grounding не потребує окремих ключів
}
