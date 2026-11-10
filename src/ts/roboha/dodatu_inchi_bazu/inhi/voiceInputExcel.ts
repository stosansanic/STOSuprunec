// src/ts/roboha/dodatu_inchi_bazu/inhi/voiceInputExcel.ts
// 🎙️ Голосове введення для модального вікна Excel (batchImportSclad)
// Команди: заповнення полів, фільтрація/сортування, додавання рядків
// 🧠 Gemini Intelligent Parser — для натурального голосу

import { showNotification } from "../../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { showVoiceOverlay, hideVoiceOverlay } from "../../ai/voiceInput";
import { supabase } from "../../../vxid/supabaseClient";
import { globalCache } from "../../zakaz_naraudy/globalCache";

// ============================================================
// ТИПИ ТА СТАН
// ============================================================

type VoiceExcelState = "idle" | "listening";

let voiceState: VoiceExcelState = "idle";
let recognition: any = null;

// Gemini стан
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
let geminiApiKeys: string[] = [];
let currentKeyIndex = 0;
let geminiKeysLoaded = false;

/** Результат інтелектуального парсингу */
interface ParsedExcelCommand {
  action: "ADD" | "FILL" | "DEL";
  rowIndex?: number | null;
  fields: {
    date?: string;
    shop?: string;
    catno?: string;
    detail?: string;
    qty?: number;
    price?: number;
    clientPrice?: number;
    warehouse?: string;
    invoice?: string;
    actNo?: string;
    unit?: string;
    orderStatus?: string;
    notes?: string;
    action?: string;
  };
}

// Зовнішні колбеки — встановлюються з batchImportSclad
let onAddRow: (() => number) | null = null; // повертає індекс нового рядка
let onSortColumn: ((col: string) => void) | null = null;
let getParsedData: (() => any[]) | null = null;

// ============================================================
// МАППІНГ КОЛОНОК — ключові слова → data-field / data-col
// ============================================================

const COLUMN_KEYWORDS: { keywords: string[]; field: string; label: string }[] =
  [
    { keywords: ["дата", "дату"], field: "date", label: "Дата" },
    {
      keywords: ["магазин", "магазину", "магащзин", "магазін", "магаз"],
      field: "shop",
      label: "Магазин",
    },
    {
      keywords: [
        "каталожний номер",
        "каталог номер",
        "каталожний",
        "каталог",
        "артикул",
        "номер каталог",
      ],
      field: "catno",
      label: "Каталог номер",
    },
    {
      keywords: ["деталь", "деталі", "запчастина", "запчастину"],
      field: "detail",
      label: "Деталь",
    },
    {
      keywords: ["кількість", "к-ть", "штук", "штуки", "кількості"],
      field: "qty",
      label: "К-ть",
    },
    { keywords: ["ціна", "ціну", "вартість"], field: "price", label: "Ціна" },
    {
      keywords: ["клієнта", "ціна клієнта", "клієнту"],
      field: "clientPrice",
      label: "Клієнта",
    },
    { keywords: ["склад", "складу"], field: "warehouse", label: "Склад" },
    {
      keywords: ["рахунок номер", "рахунок", "рах номер", "рах", "рахунку"],
      field: "invoice",
      label: "Рах. №",
    },
    {
      keywords: ["акт номер", "акт", "акту"],
      field: "actNo",
      label: "Акт №",
    },
    {
      keywords: ["одиниця", "одиниці", "о-ця"],
      field: "unit",
      label: "О-ця",
    },
    {
      keywords: [
        "статус",
        "замовити",
        "замовлено",
        "замовлена",
        "замовлене",
        "прибула",
        "прибуло",
      ],
      field: "orderStatus",
      label: "Статус",
    },
    {
      keywords: ["примітка", "примітку", "нотатка"],
      field: "notes",
      label: "Примітка",
    },
    {
      keywords: ["дія", "записати", "видалити"],
      field: "action",
      label: "Дія",
    },
  ];

// Значення для випадаючих списків
const STATUS_VALUES: Record<string, string> = {
  замовити: "Замовити",
  замовлено: "Замовлено",
  замовлена: "Замовлено",
  замовлене: "Замовлено",
  прибула: "Прибула",
  прибуло: "Прибула",
};

const ACTION_VALUES: Record<string, string> = {
  записати: "Записати",
  видалити: "Видалити",
};

// ============================================================
// ІНІЦІАЛІЗАЦІЯ
// ============================================================

/**
 * Ініціалізація голосового введення для Excel-модалки
 * @param callbacks - зовнішні колбеки для взаємодії з batchImportSclad
 */
export function initVoiceInputExcel(callbacks: {
  addRow: () => number; // повертає індекс нового рядка
  sortColumn: (col: string) => void;
  getParsedData: () => any[];
  renderTable: (data: any[]) => void;
}): void {
  onAddRow = callbacks.addRow;
  onSortColumn = callbacks.sortColumn;
  getParsedData = callbacks.getParsedData;

  const btn = document.getElementById(
    "voice-input-btn-Excel",
  ) as HTMLButtonElement | null;
  if (!btn) return;

  // 🎙️ Перевіряємо налаштування видимості мікрофона
  try {
    const storedSettings = localStorage.getItem("stoGeneralSettings");
    if (storedSettings) {
      const parsed = JSON.parse(storedSettings);
      if (parsed.voiceInputEnabled === false) {
        btn.style.display = "none";
      }
    }
  } catch {
    /* silent */
  }

  btn.onclick = () => {
    if (voiceState === "listening") {
      stopVoiceExcel();
    } else {
      startVoiceExcel();
    }
  };
}

// ============================================================
// WEB SPEECH API
// ============================================================

function isSpeechSupported(): boolean {
  return !!(
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );
}

function startVoiceExcel(): void {
  if (!isSpeechSupported()) {
    showNotification("Браузер не підтримує розпізнавання мови", "error");
    return;
  }

  const btn = document.getElementById(
    "voice-input-btn-Excel",
  ) as HTMLButtonElement;
  if (!btn) return;

  const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;

  recognition = new SpeechRecognition();
  recognition.lang = "uk-UA";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let fullTranscript = "";
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Кодові слова для зупинки
  const STOP_PHRASES = [
    "це все",
    "це всі",
    "усе",
    "все",
    "готово",
    "стоп",
    "кінець",
  ];

  voiceState = "listening";
  btn.classList.add("ai-chat-voice-btn--listening");
  btn.innerHTML = `<span class="ai-voice-pulse">🔴</span>`;
  showVoiceOverlay("Говоріть команду...");
  showNotification("Слухаю команду...", "info", 2000);

  function finishAndProcess() {
    if (silenceTimer) clearTimeout(silenceTimer);
    clearTimeout(maxTimeout);
    hideVoiceOverlay();
    try {
      recognition?.stop();
    } catch {
      /* ignore */
    }

    let result = fullTranscript.trim();
    const lower = result.toLowerCase();
    for (const phrase of STOP_PHRASES) {
      if (lower.endsWith(phrase)) {
        result = result
          .slice(0, -phrase.length)
          .trim()
          .replace(/[,.\s]+$/, "");
        break;
      }
    }

    voiceState = "idle";
    btn.classList.remove("ai-chat-voice-btn--listening");
    btn.innerHTML = "🎙️";
    recognition = null;

    if (result.trim()) {
      processVoiceCommand(result.trim()).catch((_err) => {
        // console.error("Voice command error:", _err);
        showNotification("❌ Помилка обробки команди", "error", 2000);
      });
    } else {
      showNotification("Мову не виявлено. Спробуйте ще раз.", "error", 2000);
    }
  }

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => finishAndProcess(), 2500);
  }

  // Максимум 30 секунд
  const maxTimeout = setTimeout(() => finishAndProcess(), 30000);

  recognition.onresult = (event: any) => {
    for (let i = 0; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const seg = event.results[i][0].transcript;
        fullTranscript += seg;

        if (seg.trim()) {
          const lower = seg.toLowerCase().trim();
          let isStop = false;
          for (const phrase of STOP_PHRASES) {
            if (lower.includes(phrase)) {
              isStop = true;
              break;
            }
          }

          if (isStop) {
            setTimeout(() => finishAndProcess(), 300);
            return;
          }

          showVoiceOverlay(`⚙️ Виконую: "${seg.trim()}"`);
          processVoiceCommand(seg.trim())
            .then(() => {
              if (voiceState === "listening") {
                showVoiceOverlay("🎙️  наступну команду...");
              }
            })
            .catch(() => {});
        }
      }
    }

    resetSilenceTimer();
  };

  recognition.onerror = (event: any) => {
    if (event.error === "no-speech") return;
    voiceState = "idle";
    btn.classList.remove("ai-chat-voice-btn--listening");
    btn.innerHTML = "🎙️";
    hideVoiceOverlay();

    if (fullTranscript.trim()) {
      finishAndProcess();
      return;
    }

    if (event.error === "audio-capture") {
      showNotification("Мікрофон не знайдено.", "error", 2000);
    } else if (event.error === "not-allowed") {
      showNotification("Доступ до мікрофона заборонений.", "error", 2000);
    } else {
      showNotification(`Помилка: ${event.error}`, "error", 2000);
    }
    recognition = null;
  };

  recognition.onend = () => {
    if (voiceState === "listening") {
      try {
        recognition!.start();
      } catch {
        finishAndProcess();
      }
    }
  };

  // Початковий таймер тиші — 7с
  silenceTimer = setTimeout(() => {
    if (!fullTranscript.trim()) {
      voiceState = "idle";
      btn.classList.remove("ai-chat-voice-btn--listening");
      btn.innerHTML = "🎙️";
      hideVoiceOverlay();
      clearTimeout(maxTimeout);
      try {
        recognition?.stop();
      } catch {
        /* ignore */
      }
      recognition = null;
      showNotification("Мову не виявлено. Спробуйте ще раз.", "error", 2000);
    }
  }, 7000);

  recognition.start();
}

function stopVoiceExcel(): void {
  const btn = document.getElementById(
    "voice-input-btn-Excel",
  ) as HTMLButtonElement | null;
  if (btn) {
    btn.classList.remove("ai-chat-voice-btn--listening");
    btn.innerHTML = "🎙️";
  }
  voiceState = "idle";
  hideVoiceOverlay();
  try {
    recognition?.stop();
  } catch {
    /* ignore */
  }
  recognition = null;
}

// ============================================================
// GEMINI — ЗАВАНТАЖЕННЯ КЛЮЧІВ
// ============================================================

async function loadGeminiKeysExcel(): Promise<string[]> {
  if (geminiKeysLoaded && geminiApiKeys.length > 0) return geminiApiKeys;

  const keys: string[] = [];
  let activeIndex = 0;

  try {
    const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (envKey) keys.push(envKey);

    const { data } = await supabase
      .from("settings")
      .select('setting_id, "Загальні", "API"')
      .in(
        "setting_id",
        Array.from({ length: 10 }, (_, i) => 20 + i),
      )
      .order("setting_id");

    if (data) {
      let idx = keys.length;
      for (const row of data) {
        const val = (row as any)["Загальні"];
        const isActive = (row as any)["API"];
        if (val && typeof val === "string" && val.trim()) {
          if (!keys.includes(val.trim())) {
            keys.push(val.trim());
            if (isActive === true) activeIndex = idx;
            idx++;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  geminiApiKeys = keys;
  geminiKeysLoaded = true;
  currentKeyIndex = activeIndex;
  return keys;
}

// ============================================================
// GEMINI — ІНТЕЛЕКТУАЛЬНИЙ ПАРСИНГ КОМАНДИ
// ============================================================

/**
 * 🧠 Парсинг натуральної голосової команди для Excel-таблиці через Gemini.
 * Приклади:
 * - "Додай стрічку магазин Автотехнікс деталь поршні ціна 3300 кількість 4"
 * - "Магазин автозапчастини деталь фільтр масляний ціна 250"
 * - "Дата 27.02.26 деталь колодки статус замовити"
 */
async function parseNaturalExcelCommandWithGemini(
  transcript: string,
): Promise<ParsedExcelCommand | null> {
  const keys = await loadGeminiKeysExcel();
  if (keys.length === 0) return null;

  // Динамічні дані з кешу
  const shopNames = globalCache.shops.map((s) => s.Name).filter(Boolean);
  const detailNames = globalCache.details.slice(0, 150);
  const shopsLine =
    shopNames.length > 0
      ? shopNames.join(", ")
      : "Автотехнікс, АвтоЗІП, Еліт, Інтеркарс, Омега, Лоял, Форнетті";
  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `Ти — інтелектуальний голосовий парсер для автосервісу "Атлас" (Атлас, Україна).
Механік диктує природною мовою (іноді суржиком або з помилками розпізнавання).
Твоє завдання: розпізнати КОМАНДУ та повернути ТІЛЬКИ чистий JSON.

📅 СЬОГОДНІ: ${today}

━━━━━━━━━━━━━━━━━━━━━━━━
🏪 МАГАЗИНИ / ПОСТАЧАЛЬНИКИ (звіряйся з цим списком — вибирай НАЙБЛИЖЧУ назву):
${shopsLine}
━━━━━━━━━━━━━━━━━━━━━━━━

📋 ПОЛЯ РЯДКА ТАБЛИЦІ ЗАПЧАСТИН:
- date      → Дата (YYYY-MM-DD). "Сьогодні" = ${today}. "27 лютого" = "2026-02-27"
- shop      → Магазин/постачальник. "від Еліта" = "Еліт", "з Інтеркарсу" = "Інтеркарс"
- catno     → Каталожний номер / артикул. Прибирай пробіли: "OC 90" → "OC90"
- detail    → Назва деталі (технічно правильна, українською)
- qty       → Кількість (число). "чотири" = 4, "пара" = 2
- price     → Ціна ЗА ОДИНИЦЮ. Якщо сказано ЗАГАЛЬНУ СУМУ + qty → порахуй ціну: сума ÷ qty
- clientPrice → Ціна для клієнта
- warehouse → Склад (Основний / Запасний)
- invoice   → Номер рахунку: "рахунок 1234" → "1234"
- actNo     → Номер акту: "акт 567" → "567"
- unit      → Одиниця: "штук/шт" → "шт", "літр/л" → "л", "комплект/к-т" → "к-т", "метр/м" → "м"
- orderStatus → ТІЛЬКИ одне з: "Замовити" | "Замовлено" | "Прибула"
- notes     → Примітка
- action    → "Записати" | "Видалити"

🔧 ДІЇ JSON:
- action: "ADD"  → додати НОВИЙ рядок (ключові слова: "додай", "добав", "дай", "нова стрічка")
- action: "FILL" → заповнити ІСНУЮЧИЙ рядок (ключові слова: "рядок N", "стрічка N", "третій", "п'ятий")
- action: "DEL"  → видалити рядок (ключові слова: "видали", "прибери", "видалити рядок N")

🗣️ ВИПРАВЛЕННЯ СУРЖИКУ / ЖАРГОНУ → ТЕХНІЧНО ПРАВИЛЬНА НАЗВА:
"кольца" → "поршневі кільця"
"вкладиші корінні" → "вкладиші корінні шатунні" (або "вкладиші корінні" якщо тільки корінні)
"прокладка голови" → "прокладка головки блоку"
"сальник клапана" → "сальник клапана"
"помпа" → "насос охолодження"
"термостат" → "термостат"
"ролик" → уточни: "ролик натяжний" або "ролик напрямний"
"шатун" → "шатун" (правильно)
"підшипник маточини" → "підшипник маточини"
"ШРУС" → "шарнір рівних кутових швидкостей (ШРУС)"
"піввісь" → "піввісь привідна"

🔑 ПРАВИЛА:
1. Якщо кілька полів — витягни ВСІ: "від Еліта сальник 24 штуки на 3144 гривні" → shop:"Еліт", detail:"Сальник клапана", qty:24, price:131 (3144÷24)
2. "по 500" / "за 500" / "ціна 500" / "коштує 500" → price: 500
3. "24 штуки по 131" → qty:24, price:131
4. "24 штуки на 3144 грн" → qty:24, price:131 (ПОРАХУЙ: 3144÷24)
5. Числа словами: "тисяча двісті" = 1200, "три" = 3, "двадцять п'ять" = 25
6. Відмінки магазинів: "від Еліта" = "Еліт", "в Омезі" = "Омега", "з Інтеркарсу" = "Інтеркарс"
7. "замовити" → orderStatus: "Замовити"; "замовлено/замовлена" → "Замовлено"; "прибула/прийшла" → "Прибула"
8. Не включай qty якщо не вказана кількість
9. Не включай orderStatus якщо не вказано статус

⚠️ ПОМИЛКИ РОЗПІЗНАВАННЯ (мовний рушій обрізає початок слова):
"апиши" → "запиши", "агазин" → "магазин", "еталь" → "деталь"
"ільтр" → "фільтр", "асло" → "масло", "емонт" → "ремонт"
"то дай" / "дай" → "додай" (ADD)
"стрічку" = "рядок" (ADD)
Завжди відновлюй слово повністю!

📦 ВІДОМІ ДЕТАЛІ (для звірки назви):
${detailNames.slice(0, 80).join(", ")}

Відповідь — ТІЛЬКИ JSON без коментарів:
{"action":"ADD","rowIndex":null,"fields":{"shop":"Еліт","detail":"Сальник клапана","qty":24,"price":131}}`;

  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: `Команда: "${transcript}"` }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const triedIndices = new Set<number>();
  let startIndex = currentKeyIndex;

  while (triedIndices.size < keys.length) {
    const keyIdx = startIndex % keys.length;
    triedIndices.add(keyIdx);
    const apiKey = keys[keyIdx];

    try {
      const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      if (response.ok) {
        currentKeyIndex = keyIdx;
        const data = await response.json();
        const allParts = data?.candidates?.[0]?.content?.parts || [];
        const text = allParts.map((p: any) => p.text || "").join("");
        if (!text) return null;

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.action && parsed.fields)
              return parsed as ParsedExcelCommand;
          } catch {
            /* fallthrough */
          }
        }
        return null;
      }

      if (response.status === 429) {
        currentKeyIndex = (keyIdx + 1) % keys.length;
        startIndex = keyIdx + 1;
        continue;
      }
      return null;
    } catch {
      startIndex = keyIdx + 1;
    }
  }
  return null;
}

/**
 * Виконує команду від Gemini — заповнює поля рядка Excel-таблиці
 */
function executeExcelCommand(result: ParsedExcelCommand): void {
  const data = getParsedData ? getParsedData() : [];

  // === DEL — видалити рядок ===
  if (result.action === "DEL") {
    const rowNum = result.rowIndex ?? data.length;
    const delIndex = rowNum - 1;
    if (delIndex < 0 || delIndex >= data.length) {
      showNotification(
        `Рядок ${rowNum} не існує (всього ${data.length})`,
        "error",
        2000,
      );
      return;
    }
    const tbody = document.querySelector("#batch-table-Excel tbody");
    if (!tbody) return;
    const tr = tbody.querySelectorAll("tr")[delIndex];
    if (tr) {
      // Спроба натиснути кнопку видалення
      const delBtn = tr.querySelector(
        ".delete-row-btn, .remove-row-btn, [data-action='delete']",
      ) as HTMLElement;
      if (delBtn) {
        delBtn.click();
      } else {
        tr.remove();
        data.splice(delIndex, 1);
      }
      showNotification(`🗑️ Видалено рядок ${rowNum}`, "success", 2000);
    } else {
      showNotification(`Рядок ${rowNum} не знайдено`, "error", 2000);
    }
    return;
  }

  let rowIndex: number;

  if (result.action === "ADD") {
    // Додаємо новий рядок
    if (onAddRow) {
      rowIndex = onAddRow();
      showNotification(`➕ Додано рядок №${rowIndex + 1}`, "success", 1500);
    } else {
      rowIndex = data.length > 0 ? data.length - 1 : 0;
    }
  } else {
    // FILL — заповнюємо існуючий рядок
    if (result.rowIndex && result.rowIndex >= 1) {
      rowIndex = result.rowIndex - 1;
      if (rowIndex >= data.length) {
        showNotification(
          `Рядок ${result.rowIndex} не існує (всього ${data.length})`,
          "error",
          2000,
        );
        return;
      }
    } else {
      rowIndex = data.length > 0 ? data.length - 1 : 0;
    }
  }

  // Заповнюємо всі поля з fields
  const fields = result.fields;
  const appliedFields: string[] = [];

  const fieldEntries: [string, any][] = Object.entries(fields);
  for (const [field, value] of fieldEntries) {
    if (value === null || value === undefined || value === "") continue;

    const strValue = String(value);
    applyFieldValue(rowIndex, field, strValue);
    const label = getColumnLabel(field);
    appliedFields.push(`${label}: ${strValue}`);
  }

  if (appliedFields.length > 0) {
    showNotification(
      `✅ Рядок ${rowIndex + 1}:\n${appliedFields.join("\n")}`,
      "success",
      3000,
    );
  }
}

// ============================================================
// ОБРОБКА ГОЛОСОВОЇ КОМАНДИ
// ============================================================

async function processVoiceCommand(transcript: string): Promise<void> {
  const text = transcript.toLowerCase().trim();

  // 1. Команда «Додати рядок» (можливо з даними після)
  const addRowResult = matchAddRow(text);
  if (addRowResult.matched) {
    if (onAddRow) {
      const newRowIndex = onAddRow();
      showNotification(`➕ Додано рядок №${newRowIndex + 1}`, "success", 1500);

      // Якщо є дані після "додати рядок" — заповнюємо новий рядок
      if (addRowResult.rest) {
        const restText = addRowResult.rest;
        const restOriginal = transcript.substring(
          transcript.toLowerCase().indexOf(restText.toLowerCase()),
        );

        // Спроба розпарсити декілька полів з решти тексту
        const fieldsApplied = applyMultipleFields(
          newRowIndex,
          restText,
          restOriginal,
        );
        if (!fieldsApplied) {
          // Спроба як одне поле
          const parsed = parseColumnAndValue(
            restText,
            transcript,
            restOriginal,
          );
          if (parsed) {
            applyFieldValue(newRowIndex, parsed.field, parsed.value);
          }
        }
      }
    }
    return;
  }

  // 2. Команда «Фільтр / Відфільтрувати [колонка]»
  const filterResult = matchFilter(text);
  if (filterResult) {
    if (onSortColumn) {
      onSortColumn(filterResult);
      showNotification(
        `🔽 Фільтр по: ${getColumnLabel(filterResult)}`,
        "info",
        1500,
      );
    }
    return;
  }

  // 3. Заповнення поля — «[рядок N / № N] [колонка] [значення]»
  const fieldResult = matchFieldCommand(text, transcript);
  if (fieldResult) {
    applyFieldValue(fieldResult.rowIndex, fieldResult.field, fieldResult.value);
    return;
  }

  // 4. Якщо тільки значення статусу або дії для останнього рядка
  const directStatus = matchDirectStatusOrAction(text);
  if (directStatus) {
    const data = getParsedData ? getParsedData() : [];
    const lastIdx = data.length > 0 ? data.length - 1 : 0;
    applyFieldValue(lastIdx, directStatus.field, directStatus.value);
    return;
  }

  // 5. 🧠 Gemini Intelligent Parser — спроба розпарсити через ШІ
  showNotification(`🧠 Аналізую: "${transcript}"`, "info", 2500);
  try {
    const geminiResult = await parseNaturalExcelCommandWithGemini(transcript);
    if (
      geminiResult &&
      geminiResult.fields &&
      Object.keys(geminiResult.fields).length > 0
    ) {
      executeExcelCommand(geminiResult);
      return;
    }
  } catch (err) {
    // console.warn("🎙️ Gemini Excel parse failed:", err);
  }

  showNotification(
    `🎙️ Не розпізнано: "${transcript}"\n\nСпробуйте:\n• "Додай рядок магазин Автотехнікс"\n• "Деталь фільтр масляний ціна 250"\n• "Рядок 3 кількість 4"`,
    "error",
    4000,
  );
}

// ============================================================
// ПАРСИНГ КОМАНД
// ============================================================

/** Перевірка: команда "додати рядок" (з можливими даними після) */
function matchAddRow(text: string): { matched: boolean; rest: string } {
  const patterns = [
    /^(?:(?:додати|додай|добрати|добрай|добавити|добавити)\s+(?:рядок|стрічку|стрічка|стрічок|строку|запис)|новий\s+(?:рядок|стрічку|стрічка|строку|запис)|нова\s+(?:стрічка|строка))\s*(.*)/i,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { matched: true, rest: (match[1] || "").trim() };
    }
  }
  return { matched: false, rest: "" };
}

/**
 * Спроба застосувати декілька полів з тексту.
 * Наприклад: "додати рядок деталь фільтр масла ціна 500 кількість 2"
 */
function applyMultipleFields(
  rowIndex: number,
  text: string,
  _originalText: string,
): boolean {
  // Шукаємо всі ключові слова колонок у тексті та їхні позиції
  const normalized = text.toLowerCase();
  const positions: { pos: number; field: string; kwLen: number }[] = [];

  const sorted = [...COLUMN_KEYWORDS].sort(
    (a, b) =>
      Math.max(...b.keywords.map((k) => k.length)) -
      Math.max(...a.keywords.map((k) => k.length)),
  );

  for (const col of sorted) {
    for (const kw of col.keywords) {
      let searchFrom = 0;
      while (searchFrom < normalized.length) {
        const idx = normalized.indexOf(kw, searchFrom);
        if (idx === -1) break;
        // Перевіряємо що це початок слова
        if (idx > 0 && /\p{L}/u.test(normalized[idx - 1])) {
          searchFrom = idx + 1;
          continue;
        }
        // Перевіряємо що ця позиція не зайнята довшим ключовим словом
        const alreadyCovered = positions.some(
          (p) => idx >= p.pos && idx < p.pos + p.kwLen,
        );
        if (!alreadyCovered) {
          positions.push({ pos: idx, field: col.field, kwLen: kw.length });
        }
        break;
      }
    }
  }

  if (positions.length === 0) return false;

  // Сортуємо за позицією
  positions.sort((a, b) => a.pos - b.pos);

  // Витягуємо значення між ключовими словами
  let applied = 0;
  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];
    const valueStart = current.pos + current.kwLen;
    const valueEnd =
      i + 1 < positions.length ? positions[i + 1].pos : text.length;
    let value = text.substring(valueStart, valueEnd).trim();

    if (!value) continue;

    // Спеціальна обробка для різних типів полів
    const field = current.field;

    if (field === "orderStatus") {
      const mapped = mapStatusValue(
        text.substring(current.pos, current.pos + current.kwLen),
        value,
      );
      if (mapped) {
        applyFieldValue(rowIndex, field, mapped);
        applied++;
      }
      continue;
    }

    if (field === "action") {
      const mapped = mapActionValue(
        text.substring(current.pos, current.pos + current.kwLen),
        value,
      );
      if (mapped) {
        applyFieldValue(rowIndex, field, mapped);
        applied++;
      }
      continue;
    }

    if (["qty", "price", "clientPrice"].includes(field)) {
      value = convertWordsToNumber(value);
    }

    if (field === "catno") {
      value = value.replace(/\s+/g, "").toUpperCase();
    }

    applyFieldValue(rowIndex, field, value);
    applied++;
  }

  return applied > 0;
}

/** Перевірка: команда "фільтр / відфільтрувати [колонка]" */
function matchFilter(text: string): string | null {
  const filterPatterns = [
    /(?:фільтр|відфільтрувати|фільтрувати|сортувати|сортування|відсортувати|відсортуй|фільтруй)\s+(?:по\s+)?(.+)/i,
    /(?:фільтр|відфільтрувати|фільтрувати|сортувати|сортування)\s+(.+)/i,
  ];

  for (const pattern of filterPatterns) {
    const match = text.match(pattern);
    if (match) {
      const colText = match[1].trim();
      const col = findColumnByKeyword(colText);
      if (col) return col;
    }
  }

  return null;
}

/** Знаходження колонки за ключовим словом */
function findColumnByKeyword(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  // Довші ключові слова першими
  const sorted = [...COLUMN_KEYWORDS].sort(
    (a, b) =>
      Math.max(...b.keywords.map((k) => k.length)) -
      Math.max(...a.keywords.map((k) => k.length)),
  );
  for (const col of sorted) {
    for (const kw of col.keywords) {
      if (normalized.includes(kw)) {
        return col.field;
      }
    }
  }
  return null;
}

/** Отримати мітку колонки */
function getColumnLabel(field: string): string {
  const found = COLUMN_KEYWORDS.find((c) => c.field === field);
  return found ? found.label : field;
}

/** Парсинг команди поля: «[рядок N] [колонка] [значення]» */
function matchFieldCommand(
  text: string,
  originalTranscript: string,
): { rowIndex: number; field: string; value: string } | null {
  // Патерни:
  // "рядок 2 деталь фільтр масла"
  // "рядок дев'ять змінити статус на замовлено"
  // "3 ціна 500"
  // "дата 25.02.2026"
  // "магазин Автозапчастини"

  const data = getParsedData ? getParsedData() : [];
  const lastRowIndex = data.length > 0 ? data.length - 1 : 0;

  // 1. З номером рядка (цифрою): "рядок 9 ...", "9 ...", "восьма стрічка ..."
  const rowPatternsDigit = [
    /^(?:рядок|стрічка|стрічку|стрічок|строка|ряд|номер|№)\s+(\d+)\s+(.+)$/i,
    /^(\d+)\s+(?:рядок|стрічка|стрічку|стрічок|строка|ряд)\s+(.+)$/i,
    /^(\d+)\s+(.+)$/i,
  ];

  for (const pattern of rowPatternsDigit) {
    const match = text.match(pattern);
    if (match) {
      const rowNum = parseInt(match[1], 10);
      const rest = match[2].trim();
      const rowIndex = rowNum - 1;

      if (rowIndex < 0 || rowIndex >= data.length) {
        showNotification(
          `Рядок ${rowNum} не існує (всього ${data.length})`,
          "error",
          2000,
        );
        return null;
      }

      const parsed = parseColumnAndValue(rest, originalTranscript, match[2]);
      if (parsed) {
        return { rowIndex, field: parsed.field, value: parsed.value };
      }
    }
  }

  // 2. З номером рядка (словом): "рядок дев'ять ...", "восьма стрічка ..."
  // Патерн А: "рядок/стрічка <слово-число> <решта>"
  const rowWordMatch = text.match(
    /^(?:рядок|стрічка|стрічку|стрічок|строка|ряд|номер|№)\s+(\S+)\s+(.+)$/i,
  );
  if (rowWordMatch) {
    const wordNum = wordToRowNumber(rowWordMatch[1]);
    if (wordNum > 0) {
      const rest = rowWordMatch[2].trim();
      const rowIndex = wordNum - 1;

      if (rowIndex >= data.length) {
        showNotification(
          `Рядок ${wordNum} не існує (всього ${data.length})`,
          "error",
          2000,
        );
        return null;
      }

      const parsed = parseColumnAndValue(
        rest,
        originalTranscript,
        rowWordMatch[2],
      );
      if (parsed) {
        return { rowIndex, field: parsed.field, value: parsed.value };
      }
    }
  }

  // 2b. Зворотний порядок: "<слово-число> стрічка/рядок <решта>"
  // Наприклад: "восьма стрічка статус замовлена"
  const reversedMatch = text.match(
    /^(\S+)\s+(?:рядок|стрічка|стрічку|стрічок|строка|ряд)\s+(.+)$/i,
  );
  if (reversedMatch) {
    const wordNum = wordToRowNumber(reversedMatch[1]);
    if (wordNum > 0) {
      const rest = reversedMatch[2].trim();
      const rowIndex = wordNum - 1;

      if (rowIndex >= data.length) {
        showNotification(
          `Рядок ${wordNum} не існує (всього ${data.length})`,
          "error",
          2000,
        );
        return null;
      }

      const parsed = parseColumnAndValue(
        rest,
        originalTranscript,
        reversedMatch[2],
      );
      if (parsed) {
        return { rowIndex, field: parsed.field, value: parsed.value };
      }
    }
  }

  // 3. Без номера рядка — останній рядок
  const parsed = parseColumnAndValue(
    text,
    originalTranscript,
    originalTranscript,
  );
  if (parsed) {
    return { rowIndex: lastRowIndex, field: parsed.field, value: parsed.value };
  }

  return null;
}

/**
 * Конвертація слова-числа в номер рядка (1-99)
 * "дев'ять" → 9, "двадцять" → 20
 */
function wordToRowNumber(word: string): number {
  const w = word.toLowerCase().replace(/['’]/g, "'");
  const map: Record<string, number> = {
    один: 1,
    одна: 1,
    перший: 1,
    перша: 1,
    перше: 1,
    два: 2,
    дві: 2,
    другий: 2,
    друга: 2,
    друге: 2,
    три: 3,
    третій: 3,
    третя: 3,
    третє: 3,
    чотири: 4,
    четвертий: 4,
    четверта: 4,
    четверте: 4,
    "p'ять": 5,
    "п'ять": 5,
    пять: 5,
    "п'ятий": 5,
    "п'ята": 5,
    пятий: 5,
    пята: 5,
    шість: 6,
    шостий: 6,
    шоста: 6,
    шосте: 6,
    сім: 7,
    сьомий: 7,
    сьома: 7,
    сьоме: 7,
    вісім: 8,
    восьмий: 8,
    восьма: 8,
    восьме: 8,
    "дев'ять": 9,
    девять: 9,
    "дев'ятий": 9,
    "дев'ята": 9,
    девятий: 9,
    девята: 9,
    десять: 10,
    десятий: 10,
    десята: 10,
    одинадцять: 11,
    дванадцять: 12,
    тринадцять: 13,
    чотирнадцять: 14,
    "п'ятнадцять": 15,
    пятнадцять: 15,
    шістнадцять: 16,
    сімнадцять: 17,
    вісімнадцять: 18,
    "дев'ятнадцять": 19,
    девятнадцять: 19,
    двадцять: 20,
    тридцять: 30,
    сорок: 40,
    "п'ятдесят": 50,
    пятдесят: 50,
  };
  // Якщо цифра
  const num = parseInt(w, 10);
  if (!isNaN(num) && num > 0) return num;
  // Якщо слово
  if (map[w] !== undefined) return map[w];
  return 0;
}

/** Парсинг «колонка значення» з тексту */
function parseColumnAndValue(
  text: string,
  _fullOriginal: string,
  restOriginal: string,
): { field: string; value: string } | null {
  const normalized = text.toLowerCase().trim();

  // === Патерн: "змінити/поставити/встановити [колонка] на [значення]" ===
  const changeMatch = normalized.match(
    /^(?:змінити|поставити|встановити|зміни|постав)\s+(.+?)\s+на\s+(.+)$/i,
  );
  if (changeMatch) {
    const colText = changeMatch[1].trim();
    const valueText = changeMatch[2].trim();
    const col = findColumnByKeyword(colText);
    if (col) {
      // Маппінг для статусу/дії
      if (col === "orderStatus") {
        const mapped = mapStatusValue(valueText, "");
        if (mapped) return { field: col, value: mapped };
      }
      if (col === "action") {
        const mapped = mapActionValue(valueText, "");
        if (mapped) return { field: col, value: mapped };
      }
      return { field: col, value: valueText };
    }
  }

  // === Патерн: "[колонка] на [значення]" (без "змінити") ===
  const simpleChangeMatch = normalized.match(/^(.+?)\s+на\s+(.+)$/i);
  if (simpleChangeMatch) {
    const colText = simpleChangeMatch[1].trim();
    const valueText = simpleChangeMatch[2].trim();
    const col = findColumnByKeyword(colText);
    if (col) {
      if (col === "orderStatus") {
        const mapped = mapStatusValue(valueText, "");
        if (mapped) return { field: col, value: mapped };
      }
      if (col === "action") {
        const mapped = mapActionValue(valueText, "");
        if (mapped) return { field: col, value: mapped };
      }
      return { field: col, value: valueText };
    }
  }

  // === Стандартний патерн: "[колонка] [значення]" ===
  // Довші ключові слова першими
  const sorted = [...COLUMN_KEYWORDS].sort(
    (a, b) =>
      Math.max(...b.keywords.map((k) => k.length)) -
      Math.max(...a.keywords.map((k) => k.length)),
  );

  for (const col of sorted) {
    for (const kw of col.keywords) {
      if (normalized.startsWith(kw)) {
        let value = text.substring(kw.length).trim();

        // Для статусу — маппінг на конкретні значення
        if (col.field === "orderStatus") {
          const mapped = mapStatusValue(kw, value);
          if (mapped) return { field: col.field, value: mapped };
          continue;
        }

        // Для дії — маппінг на конкретні значення
        if (col.field === "action") {
          const mapped = mapActionValue(kw, value);
          if (mapped) return { field: col.field, value: mapped };
          continue;
        }

        // Для числових полів — конвертація словесних чисел
        if (["qty", "price", "clientPrice"].includes(col.field)) {
          value = convertWordsToNumber(value);
        }

        // Для каталог номеру — зберігаємо оригінальний регістр (є англ. літери)
        if (col.field === "catno") {
          // Спроба знайти оригінальне value у повному тексті
          const origIdx = restOriginal.toLowerCase().indexOf(kw);
          if (origIdx >= 0) {
            value = restOriginal.substring(origIdx + kw.length).trim();
          }
          // Прибираємо пробіли, які SpeechRecognition додає між літерами
          value = value.replace(/\s+/g, "").toUpperCase();
        }

        if (value) {
          return { field: col.field, value };
        }
      }
    }
  }

  return null;
}

/** Маппінг статусу */
function mapStatusValue(keyword: string, extraValue: string): string | null {
  const combined = (keyword + " " + extraValue).toLowerCase().trim();
  for (const [key, val] of Object.entries(STATUS_VALUES)) {
    if (combined.includes(key)) return val;
  }
  // Якщо ключове слово само є статусом
  if (STATUS_VALUES[keyword.toLowerCase()]) {
    return STATUS_VALUES[keyword.toLowerCase()];
  }
  return null;
}

/** Маппінг дії */
function mapActionValue(keyword: string, extraValue: string): string | null {
  const combined = (keyword + " " + extraValue).toLowerCase().trim();
  for (const [key, val] of Object.entries(ACTION_VALUES)) {
    if (combined.includes(key)) return val;
  }
  if (ACTION_VALUES[keyword.toLowerCase()]) {
    return ACTION_VALUES[keyword.toLowerCase()];
  }
  return null;
}

/** Пряме розпізнавання статусу або дії */
function matchDirectStatusOrAction(
  text: string,
): { field: string; value: string } | null {
  const normalized = text.toLowerCase().trim();

  // Статус
  for (const [key, val] of Object.entries(STATUS_VALUES)) {
    if (normalized === key || normalized.startsWith(key)) {
      return { field: "orderStatus", value: val };
    }
  }

  // Дія
  for (const [key, val] of Object.entries(ACTION_VALUES)) {
    if (normalized === key || normalized.startsWith(key)) {
      return { field: "action", value: val };
    }
  }

  return null;
}

// ============================================================
// ЗАСТОСУВАННЯ ЗНАЧЕННЯ ДО КОМІРКИ
// ============================================================

function applyFieldValue(rowIndex: number, field: string, value: string): void {
  const tbody = document.querySelector("#batch-table-Excel tbody");
  if (!tbody) {
    showNotification("Таблиця не знайдена", "error", 2000);
    return;
  }

  const tr = tbody.querySelectorAll("tr")[rowIndex];
  if (!tr) {
    showNotification(`Рядок ${rowIndex + 1} не знайдено`, "error", 2000);
    return;
  }

  // Шукаємо input по data-field
  const input = tr.querySelector(`[data-field="${field}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;

  if (!input) {
    showNotification(
      `Поле "${getColumnLabel(field)}" не знайдено`,
      "error",
      2000,
    );
    return;
  }

  // Для статусу й дії — клікаємо для зміни через вбудований механізм
  if (field === "orderStatus" || field === "action") {
    // Встановлюємо значення безпосередньо
    input.value = value;
    // Оновлюємо дані в масиві
    const data = getParsedData ? getParsedData() : [];
    if (data[rowIndex]) {
      data[rowIndex][field] = value;
    }

    // Оновлюємо стилі для статусу
    if (field === "orderStatus") {
      const td = input.closest("td");
      if (td) {
        td.style.backgroundColor = getOrderStatusBg(value);
        input.style.color = getOrderStatusColor(value);
      }
    }

    // Оновлюємо стилі для дії
    if (field === "action") {
      input.style.color = value === "Видалити" ? "#ef4444" : "#2D7244";
    }

    // Тригеримо подію для ревалідації
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    showNotification(
      `✅ Рядок ${rowIndex + 1}: ${getColumnLabel(field)} → ${value}`,
      "success",
      1500,
    );
    return;
  }

  // Для дати
  if (field === "date") {
    // Спроба конвертувати в ISO формат
    const isoDate = parseDateInput(value);
    input.value = isoDate || value;
  } else {
    input.value = value;
  }

  // Оновлюємо дані в масиві
  const data = getParsedData ? getParsedData() : [];
  if (data[rowIndex]) {
    if (["qty", "price", "clientPrice"].includes(field)) {
      data[rowIndex][field] = parseFloat(value) || 0;
    } else {
      data[rowIndex][field] = input.value;
    }
  }

  // Тригеримо подію input для ревалідації
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  showNotification(
    `✅ Рядок ${rowIndex + 1}: ${getColumnLabel(field)} → ${value}`,
    "success",
    1500,
  );
}

// ============================================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ============================================================

/** Конвертація словесних чисел в цифри */
function convertWordsToNumber(text: string): string {
  const trimmed = text.trim().toLowerCase();

  // Якщо вже число — повертаємо
  if (/^\d+([.,]\d+)?$/.test(trimmed)) {
    return trimmed.replace(",", ".");
  }

  const units: Record<string, number> = {
    нуль: 0,
    один: 1,
    одна: 1,
    одне: 1,
    два: 2,
    дві: 2,
    три: 3,
    чотири: 4,
    "п'ять": 5,
    пять: 5,
    шість: 6,
    сім: 7,
    вісім: 8,
    "дев'ять": 9,
    девять: 9,
    десять: 10,
    одинадцять: 11,
    дванадцять: 12,
    тринадцять: 13,
    чотирнадцять: 14,
    "п'ятнадцять": 15,
    пятнадцять: 15,
    шістнадцять: 16,
    сімнадцять: 17,
    вісімнадцять: 18,
    "дев'ятнадцять": 19,
    девятнадцять: 19,
    двадцять: 20,
    тридцять: 30,
    сорок: 40,
    "п'ятдесят": 50,
    пятдесят: 50,
    шістдесят: 60,
    сімдесят: 70,
    вісімдесят: 80,
    "дев'яносто": 90,
    девяносто: 90,
    сто: 100,
    двісті: 200,
    триста: 300,
    чотириста: 400,
    "п'ятсот": 500,
    пятсот: 500,
    шістсот: 600,
    сімсот: 700,
    вісімсот: 800,
    "дев'ятсот": 900,
    девятсот: 900,
  };

  const multipliers: Record<string, number> = {
    тисяча: 1000,
    тисячі: 1000,
    тисяч: 1000,
  };

  // Простий парсинг
  if (units[trimmed] !== undefined) return String(units[trimmed]);
  if (multipliers[trimmed] !== undefined) return String(multipliers[trimmed]);

  // Спроба скласти числа: "двісті п'ятдесят" → 250
  const words = trimmed.split(/\s+/);
  let result = 0;
  let currentGroup = 0;
  let hasNumber = false;

  for (const word of words) {
    if (units[word] !== undefined) {
      currentGroup += units[word];
      hasNumber = true;
    } else if (multipliers[word] !== undefined) {
      if (currentGroup === 0) currentGroup = 1;
      result += currentGroup * multipliers[word];
      currentGroup = 0;
      hasNumber = true;
    }
  }

  result += currentGroup;

  if (hasNumber && result > 0) return String(result);

  // Якщо не розпізнано — повертаємо як є
  return text.trim();
}

/** Парсинг дати з голосу */
function parseDateInput(text: string): string | null {
  const trimmed = text.trim();

  // Вже ISO формат: 2026-02-25
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // dd.mm.yyyy або dd.mm.yy
  const dotMatch = trimmed.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (dotMatch) {
    const day = dotMatch[1].padStart(2, "0");
    const month = dotMatch[2].padStart(2, "0");
    let year = dotMatch[3];
    if (year.length === 2) year = "20" + year;
    return `${year}-${month}-${day}`;
  }

  // Словесний формат: "двадцять п'яте лютого" — занадто складно, залишаємо як є
  return null;
}

/** Колір фону статусу замовлення */
function getOrderStatusBg(status: string): string {
  switch (status) {
    case "Замовити":
      return "rgba(248, 113, 113, 0.15)";
    case "Замовлено":
      return "rgba(59, 130, 246, 0.15)";
    case "Прибула":
      return "rgba(45, 114, 68, 0.15)";
    default:
      return "";
  }
}

/** Колір тексту статусу */
function getOrderStatusColor(status: string): string {
  switch (status) {
    case "Замовити":
      return "#f87171";
    case "Замовлено":
      return "#3b82f6";
    case "Прибула":
      return "#2D7244";
    default:
      return "inherit";
  }
}
