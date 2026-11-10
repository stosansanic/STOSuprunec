// src/ts/roboha/ai/voiceInput.ts
// 🎙️ Голосове введення в акт — ключові фрази визначають ціль
// Формат: "[ключ] [значення]"
// Наприклад: "пробіг 150000", "рядок 2 найменування заміна масла"

import { supabase } from "../../vxid/supabaseClient";
import {
  globalCache,
  loadEditorReferences,
  ACT_ITEMS_TABLE_CONTAINER_ID,
} from "../zakaz_naraudy/globalCache";
import {
  updateCalculatedSumsInFooter,
  addNewRow,
} from "../zakaz_naraudy/modalUI";
import { showNotification } from "../zakaz_naraudy/inhi/vspluvauhe_povidomlenna";
import { handleItemSelection } from "./aiPriceHelper";

// ============================================================
// ТИПИ
// ============================================================

/** Куди записати голосові дані */
type VoiceTarget =
  | { kind: "field"; fieldId: string; label: string }
  | { kind: "cell"; rowIndex: number; column: string; label: string };

/** Результат парсингу повного рядка (Найменування) через Gemini */
interface ParsedFullRow {
  type: "work" | "detail";
  name: string;
  price: number | null;
  quantity: number | null;
  slyusar: string | null;
  slyusarSum: number | null;
}

/** Результат інтелектуального парсингу натуральної команди */
interface ParsedNaturalCommand {
  action: "ADD" | "DELETE" | "EDIT" | "FIELD";
  items?: Array<{
    type: "work" | "detail";
    name: string;
    price: number | null;
    quantity: number | null;
    slyusar: string | null;
    slyusarSum: number | null;
  }>;
  targetRow?: number | null;
  field?: { fieldId: string; value: string } | null;
}

type VoiceState = "idle" | "listening" | "processing";

// ============================================================
// СТАН
// ============================================================

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

let voiceState: VoiceState = "idle";
let recognition: any = null;
let geminiApiKeys: string[] = [];
let currentKeyIndex = 0;
let keysLoaded = false;

// Активне розпізнавання AI-чату (для зупинки ззовні)
let _activeChatRec: any = null;

// ============================================================
// ДЕТЕКЦІЯ МОБІЛЬНОГО ПРИСТРОЮ
// ============================================================

const IS_MOBILE = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
  navigator.userAgent,
);

// ============================================================
// КЛЮЧІ GEMINI
// ============================================================

async function loadGeminiKeys(): Promise<string[]> {
  if (keysLoaded && geminiApiKeys.length > 0) return geminiApiKeys;

  const keys: string[] = [];
  let activeIndex = 0;

  try {
    const envKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
    if (envKey) keys.push(envKey);

    // Завантажуємо ВСІ ключі динамічно (setting_id >= 20, без ліміту в 10)
    const { data } = await supabase
      .from("settings")
      .select('setting_id, "Загальні", "API"')
      .gte("setting_id", 20)
      .not("Загальні", "is", null)
      .order("setting_id");

    if (data) {
      let idx = keys.length;
      for (const row of data) {
        const val = (row as any)["Загальні"];
        const isActive = (row as any)["API"];
        if (val && typeof val === "string" && val.trim()) {
          const key = val.trim();
          if (/^gsk_/i.test(key) || /^sk-or-/i.test(key)) continue;
          if (!keys.includes(key)) {
            keys.push(key);
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
  keysLoaded = true;
  currentKeyIndex = activeIndex;
  return keys;
}

// ============================================================
// WEB SPEECH API
// ============================================================

export function isSpeechRecognitionSupported(): boolean {
  return !!(
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );
}

export function stopListening(): void {
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    recognition = null;
  }
}

// ============================================================
// ПАРСИНГ КЛЮЧОВИХ ФРАЗ — визначення КУДИ вводити
// ============================================================

/**
 * Ключові фрази для верхніх полів акту.
 * Порядок важливий — довші фрази першими!
 */
const FIELD_KEYWORDS: { keywords: string[]; fieldId: string; label: string }[] =
  [
    {
      keywords: ["причина звернення", "причина"],
      fieldId: "editable-reason",
      label: "Причина звернення",
    },
    {
      keywords: ["рекомендації", "рекомендація"],
      fieldId: "editable-recommendations",
      label: "Рекомендації",
    },
    {
      keywords: ["примітки", "примітка", "нотатки", "замітки"],
      fieldId: "editable-notes",
      label: "Примітки",
    },
    {
      keywords: ["пробіг", "пробег", "кілометраж"],
      fieldId: "editable-probig",
      label: "Пробіг",
    },
    { keywords: ["аванс"], fieldId: "editable-avans", label: "Аванс" },
    {
      keywords: ["знижка", "скидка", "скідка"],
      fieldId: "editable-discount",
      label: "Знижка",
    },
  ];

/**
 * Ключові фрази для колонок таблиці.
 * Порядок важливий — довші фрази першими!
 */
const COLUMN_KEYWORDS: { keywords: string[]; column: string; label: string }[] =
  [
    {
      keywords: ["найменування", "назва", "робота", "деталь", "запчастина"],
      column: "name",
      label: "Найменування",
    },
    {
      keywords: ["каталог", "каталожний", "артикул"],
      column: "catalog",
      label: "Каталог",
    },
    {
      keywords: ["кількість", "штук", "штуки"],
      column: "id_count",
      label: "К-ть",
    },
    {
      keywords: ["ціна", "вартість", "коштує", "прайс"],
      column: "price",
      label: "Ціна",
    },
    {
      keywords: ["зарплата", "зарплатня", "зп"],
      column: "slyusar_sum",
      label: "Зар-та",
    },
    {
      keywords: [
        "піб",
        "пі ",
        "слюсар",
        "виконавець",
        "прізвище",
        "фамілія",
        "магазин",
      ],
      column: "pib_magazin",
      label: "ПІБ",
    },
  ];

/**
 * Парсить голосову фразу → визначає КУДИ і ЩО записати.
 * Формати:
 *   "пробіг 150000"
 *   "причина звернення ТО"
 *   "рядок 2 найменування заміна масла"
 *   "2 ціна тисяча"
 *   "рядок 3 кількість два"
 *   "додати рядок заміна масла" — додає новий рядок і заповнює
 */
function parseVoiceCommand(
  transcript: string,
): { target: VoiceTarget; value: string } | null {
  const text = transcript.trim().toLowerCase();
  if (!text) return null;

  // --- 0. Визначаємо чи це складна команда з кількома полями → Gemini
  //    Якщо в тексті 2+ різних ключових слів колонок — це мульти-поле, Gemini краще справиться
  let matchedKeywordGroups = 0;
  const checkedGroups = new Set<string>();
  for (const col of COLUMN_KEYWORDS) {
    if (checkedGroups.has(col.column)) continue;
    for (const kw of col.keywords) {
      if (text.includes(kw)) {
        matchedKeywordGroups++;
        checkedGroups.add(col.column);
        break;
      }
    }
  }
  for (const f of FIELD_KEYWORDS) {
    if (checkedGroups.has(f.fieldId)) continue;
    for (const kw of f.keywords) {
      if (text.includes(kw)) {
        matchedKeywordGroups++;
        checkedGroups.add(f.fieldId);
        break;
      }
    }
  }
  // Якщо знайдено 3+ різних ключових груп — точно складна команда → null для Gemini
  if (matchedKeywordGroups >= 3) return null;

  // --- 1. Перевірка полів акту (Пробіг, Причина звернення, Рекомендації, Примітки, Аванс, Знижка)
  for (const field of FIELD_KEYWORDS) {
    for (const kw of field.keywords) {
      if (text.startsWith(kw)) {
        const value = transcript.trim().substring(kw.length).trim();
        return {
          target: { kind: "field", fieldId: field.fieldId, label: field.label },
          value: value || "",
        };
      }
    }
  }

  // --- 2. Перевірка рядків таблиці: "рядок N [колонка] [значення]" або "N [колонка] [значення]"
  // Формат: "рядок 2 найменування заміна масла", "3 ціна 500", "рядок 1 піб Петренко"
  const rowPatterns = [
    /^(?:рядок|строка|строчка|ряд)\s+(\d+)\s+(.+)$/i,
    /^(\d+)\s+(.+)$/i,
  ];

  for (const pattern of rowPatterns) {
    const match = text.match(pattern);
    if (match) {
      const rowIndex = parseInt(match[1], 10);
      const rest = match[2].trim();

      // Шукаємо ключову колонку в rest
      for (const col of COLUMN_KEYWORDS) {
        for (const kw of col.keywords) {
          if (rest.startsWith(kw)) {
            // Залишок після ключового слова = значення
            const valueStart = rest.indexOf(kw) + kw.length;
            const value = rest.substring(valueStart).trim();
            return {
              target: {
                kind: "cell",
                rowIndex,
                column: col.column,
                label: col.label,
              },
              value: value || "",
            };
          }
        }
      }

      // Якщо колонка не вказана — за замовчуванням "Найменування"
      return {
        target: {
          kind: "cell",
          rowIndex,
          column: "name",
          label: "Найменування",
        },
        value: rest,
      };
    }
  }

  // --- 3. Колонка БЕЗ номера рядка: "найменування заміна масла", "ціна 500", "піб Петренко"
  // → знаходимо перший порожній рядок в цій колонці, або останній рядок
  for (const col of COLUMN_KEYWORDS) {
    for (const kw of col.keywords) {
      if (text.startsWith(kw)) {
        const value = transcript.trim().substring(kw.length).trim();
        const targetRow = findFirstEmptyRowForColumn(col.column);
        return {
          target: {
            kind: "cell",
            rowIndex: targetRow,
            column: col.column,
            label: col.label,
          },
          value: value || "",
        };
      }
    }
  }

  // --- 4. "додати/додай рядок [найменування]" — додає порожній рядок і вписує
  const addRowMatch = text.match(
    /^(?:додати рядок|додай рядок|додати стрічку|додай стрічку|новий рядок|нова стрічка|додати|додай)\s*(.*)$/i,
  );
  if (addRowMatch) {
    const value = addRowMatch[1].trim();
    // Додаємо рядок та отримуємо його номер
    return {
      target: {
        kind: "cell",
        rowIndex: -1,
        column: "name",
        label: "Новий рядок",
      },
      value: value || "",
    };
  }

  // --- 5. Не розпізнано як ключову команду → повертаємо null для обробки Gemini
  return null;
}

/**
 * Перевіряє чи фраза є неповною командою-префіксом,
 * яка потребує продовження (наприклад "додай", "додай рядок", "рядок 2").
 * На мобільному isFinal приходить по одному слову — тому такі фрагменти
 * не треба обробляти одразу, а чекати продовження.
 */
function isIncompleteCommandPrefix(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;

  // Чисті префікси дій без значення
  const prefixes = [
    "додай",
    "додати",
    "додай рядок",
    "додати рядок",
    "додай стрічку",
    "додати стрічку",
    "новий рядок",
    "нова стрічка",
    "видали",
    "видалити",
    "видали рядок",
    "видалити рядок",
    "зміни",
    "змінити",
    "зміни рядок",
    "змінити рядок",
    "рядок",
    "строка",
    "строчка",
  ];
  if (prefixes.includes(t)) return true;

  // "рядок N" без колонки/значення (наприклад "рядок 2")
  if (/^(?:рядок|строка|строчка|ряд)\s+\d+$/i.test(t)) return true;

  // "додай рядок в ...", "додай рядок в рядку ...", "в рядку напиши" — незавершені фрази
  if (/^(?:додай|додати)\s+(?:рядок\s+)?(?:в|у)\s*$/i.test(t)) return true;
  if (
    /^(?:додай|додати)\s+(?:рядок\s+)?(?:в|у)\s+(?:рядку|рядок|стрічку)\s*$/i.test(
      t,
    )
  )
    return true;
  if (
    /^(?:додай|додати)\s+(?:рядок\s+)?(?:в|у)\s+(?:рядку|рядок|стрічку)\s+(?:напиши|запиши|введи)\s*$/i.test(
      t,
    )
  )
    return true;

  return false;
}

// ============================================================
// ДОПОМІЖНА УТИЛІТА: знайти рядок таблиці за номером
// ============================================================

function getTableRow(rowIndex: number): HTMLTableRowElement | null {
  const tbody = document.querySelector(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tbody) return null;

  const rows = tbody.querySelectorAll("tr");
  // rowIndex починається з 1, rows від 0
  if (rowIndex < 1 || rowIndex > rows.length) return null;
  return rows[rowIndex - 1] as HTMLTableRowElement;
}

function getRowCount(): number {
  const tbody = document.querySelector(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tbody) return 0;
  return tbody.querySelectorAll("tr").length;
}

/** Знайти перший рядок де колонка порожня. Якщо всі заповнені — повертає -1 (додати новий) */
function findFirstEmptyRowForColumn(column: string): number {
  const tbody = document.querySelector(
    `#${ACT_ITEMS_TABLE_CONTAINER_ID} tbody`,
  );
  if (!tbody) return -1;

  const rows = tbody.querySelectorAll("tr");
  if (rows.length === 0) return -1;

  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i].querySelector(
      `[data-name="${column}"]`,
    ) as HTMLElement;
    if (cell) {
      const text = cell.textContent?.trim() || "";
      if (!text) return i + 1; // 1-based
    }
  }

  // Всі заповнені → останній рядок якщо це не name, інакше додати новий
  if (column === "name") return -1;
  return rows.length;
}

// ============================================================
// ЛОКАЛЬНИЙ ПАРСИНГ ЧИСЕЛ
// ============================================================

const UKR_NUMBERS: Record<string, number> = {
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
  шістнадцять: 16,
  сімнадцять: 17,
  вісімнадцять: 18,
  "дев'ятнадцять": 19,
  двадцять: 20,
  тридцять: 30,
  сорок: 40,
  "п'ятдесят": 50,
  пятдесят: 50,
  шістдесят: 60,
  сімдесят: 70,
  вісімдесят: 80,
  "дев'яносто": 90,
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
  тисяча: 1000,
  тисячі: 1000,
  тисяч: 1000,
};

function tryParseNumberLocally(text: string): number | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[.,;!?]/g, "");

  const numMatch = cleaned.match(/^(\d+)$/);
  if (numMatch) return parseInt(numMatch[1], 10);

  const numSuffix = cleaned.match(/^(\d+)\s*(грн|грив|шт|штук|км)?$/);
  if (numSuffix) return parseInt(numSuffix[1], 10);

  const words = cleaned.split(/[\s-]+/);
  let total = 0;
  let current = 0;
  let hasNumber = false;

  for (const word of words) {
    if (
      ["грн", "гривень", "штук", "штуки", "штука", "км", "кілометрів"].includes(
        word,
      )
    )
      continue;
    const val = UKR_NUMBERS[word];
    if (val !== undefined) {
      hasNumber = true;
      if (val === 1000) {
        current = current === 0 ? 1000 : current * 1000;
        total += current;
        current = 0;
      } else if (val >= 100) {
        current += val;
      } else {
        current += val;
      }
    } else {
      const digitMatch = word.match(/^\d+$/);
      if (digitMatch) {
        hasNumber = true;
        current += parseInt(digitMatch[0], 10);
      }
    }
  }

  total += current;
  return hasNumber && total > 0 ? total : null;
}

// ============================================================
// ФІЛЬТРАЦІЯ ІМЕН ДЛЯ GEMINI (зменшення токенів)
// ============================================================

/**
 * Попередньо фільтрує список імен по релевантності до транскрипту.
 * Замість 200 імен відправляємо ~50-80 найрелевантніших → економія токенів.
 */
function preFilterNames(
  names: string[],
  transcript: string,
  limit: number = 60,
): string[] {
  const words = transcript
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return names.slice(0, limit);

  const scored = names.map((name) => {
    const nameLower = name.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (nameLower.includes(word)) score += 2;
      else if (
        word.length > 3 &&
        nameLower.includes(word.substring(0, word.length - 1))
      )
        score += 1;
    }
    return { name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).map((s) => s.name);
  if (matched.length >= limit) return matched.slice(0, limit);

  const rest = scored.filter((s) => s.score === 0).map((s) => s.name);
  return [...matched, ...rest.slice(0, limit - matched.length)];
}

// ============================================================
// ПОШУК В КЕШІ
// ============================================================

function findBestMatch(
  parsedName: string,
  type: "work" | "detail",
): { name: string; workId?: string; scladId?: number } | null {
  const nameLower = parsedName.toLowerCase().trim();
  if (!nameLower) return null;

  if (type === "work") {
    const exact = globalCache.worksWithId.find(
      (w) => w.name.toLowerCase() === nameLower,
    );
    if (exact) return { name: exact.name, workId: exact.work_id };

    const partial = globalCache.worksWithId.find(
      (w) =>
        w.name.toLowerCase().includes(nameLower) ||
        nameLower.includes(w.name.toLowerCase()),
    );
    if (partial) return { name: partial.name, workId: partial.work_id };

    // Fuzzy — обрізаний початок
    for (const w of globalCache.worksWithId) {
      const wL = w.name.toLowerCase();
      for (const ww of wL.split(/\s+/)) {
        if (ww.length > 3 && ww.endsWith(nameLower))
          return { name: w.name, workId: w.work_id };
      }
    }

    // По словах
    const searchWords = nameLower.split(/\s+/).filter((w) => w.length > 2);
    let best: { name: string; workId: string; score: number } | null = null;
    for (const w of globalCache.worksWithId) {
      const wL = w.name.toLowerCase();
      const score = searchWords.filter((sw) => wL.includes(sw)).length;
      if (score >= 1 && (!best || score > best.score)) {
        best = { name: w.name, workId: w.work_id, score };
      }
    }
    if (best) return { name: best.name, workId: best.workId };
    return null;
  } else {
    const exactS = globalCache.skladParts.find(
      (p) => p.name.toLowerCase() === nameLower,
    );
    if (exactS) return { name: exactS.name, scladId: exactS.sclad_id };

    const partS = globalCache.skladParts.find(
      (p) =>
        p.name.toLowerCase().includes(nameLower) ||
        nameLower.includes(p.name.toLowerCase()),
    );
    if (partS) return { name: partS.name, scladId: partS.sclad_id };

    const exactD = globalCache.details.find(
      (d) => d.toLowerCase() === nameLower,
    );
    if (exactD) return { name: exactD };

    const partD = globalCache.details.find(
      (d) =>
        d.toLowerCase().includes(nameLower) ||
        nameLower.includes(d.toLowerCase()),
    );
    if (partD) return { name: partD };
    return null;
  }
}

function findSlyusarOrShop(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  for (const s of globalCache.slyusars) {
    if (s.Name.toLowerCase() === t) return s.Name;
  }
  for (const s of globalCache.slyusars) {
    if (s.Name.toLowerCase().includes(t) || t.includes(s.Name.toLowerCase()))
      return s.Name;
  }
  for (const s of globalCache.shops) {
    if (s.Name.toLowerCase() === t) return s.Name;
  }
  for (const s of globalCache.shops) {
    if (s.Name.toLowerCase().includes(t) || t.includes(s.Name.toLowerCase()))
      return s.Name;
  }
  return null;
}

// ============================================================
// GEMINI: ПАРСИНГ РЯДКА (Найменування)
// ============================================================

async function parseFullRowWithGemini(
  transcript: string,
): Promise<ParsedFullRow | null> {
  const keys = await loadGeminiKeys();
  if (keys.length === 0) throw new Error("Немає API ключів Gemini.");

  const workNames = preFilterNames(globalCache.works, transcript, 80);
  const detailNames = preFilterNames(globalCache.details, transcript, 80);
  const slyusarNames = globalCache.slyusars.map((s) => s.Name).filter(Boolean);

  const systemPrompt = `Ти — парсер голосових команд для автомобільного СТО (Україна).
Механік каже фразу яка описує рядок в акті: назву роботи/деталі та характеристики.

ГОЛОВНЕ ПРАВИЛО: Знайди НАЙБІЛЬШ СХОЖУ назву з доступних списків.
НАВІТЬ якщо сказано одне слово ("заміна", "фільтр") — знайди роботу/деталь зі списку що МІСТИТЬ це слово.
НІКОЛИ не повертай порожнє name ("") та НІКОЛИ не додавай "..." до назви.

⚠️ ТИПОВІ ПОМИЛКИ РОЗПІЗНАВАННЯ (Голосове рушій часто обрізає початок):
- "аміна" → "заміна", "ільтр" → "фільтр", "асло" → "масло"
- "емонт" → "ремонт", "іагностика" → "діагностика"
Завжди відновлюй повне слово!

КЛЮЧОВІ СЛОВА:
- "кількість"/"штук" + число → quantity
- "ціна"/"за"/"по"/"коштує" → price
- "зарплата"/"зп" + число → slyusarSum
- Прізвище слюсаря → slyusar
- Числа словами: "тисяча двісті" = 1200

РОБОТИ:
${workNames.join("\n")}

ДЕТАЛІ:
${detailNames.join("\n")}

СЛЮСАРІ:
${slyusarNames.join(", ")}

Відповідь — ТІЛЬКИ JSON:
{"type":"work","name":"Точна назва зі списку","price":null,"quantity":1,"slyusar":null,"slyusarSum":null}`;

  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: `Розбери: "${transcript}"` }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  return await callGeminiForObject(requestBody);
}

/**
 * 🧠 Інтелектуальний парсинг натуральної голосової команди через Gemini.
 * Приклади: "Додай поршні 4 штуки по 3300 гривень", "Видали другий рядок",
 * "Запиши фільтр масляний і колодки гальмівні передні 2 штуки по 450"
 */
async function parseNaturalCommandWithGemini(
  transcript: string,
): Promise<ParsedNaturalCommand | null> {
  const keys = await loadGeminiKeys();
  if (keys.length === 0) return null;

  const workNames = preFilterNames(globalCache.works, transcript, 80);
  const detailNames = preFilterNames(globalCache.details, transcript, 80);
  const slyusarNames = globalCache.slyusars.map((s) => s.Name).filter(Boolean);

  // Список полів акту для FIELD команд
  const fieldsList = FIELD_KEYWORDS.map(
    (f) => `"${f.keywords[0]}" → fieldId: "${f.fieldId}"`,
  ).join("\n");

  const shopNames = globalCache.shops.map((s) => s.Name).filter(Boolean);
  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `Ти — голосовий помічник механіка автосервісу "A-Service" (A-Service, Україна).
Механік диктує природною мовою (суржик, жаргон, помилки розпізнавання).
Твоє завдання: визначити ДІЮ та повернути ТІЛЬКИ чистий JSON.

📅 СЬОГОДНІ: ${today}

━━━━━━━━━━━━━━━━━━━━━━━━
🔧 ДІЇ JSON:
1. "ADD"    → додати НОВІ рядки в таблицю акту (слова: "додай", "добав", "запиши", "дай", "є")
2. "DELETE" → видалити рядок (слова: "видали", "прибери", "стирай", "видалити рядок N")
3. "EDIT"   → змінити існуючий рядок (слова: "зміни рядок N", "виправ рядок N")
4. "FIELD"  → заповнити поле акту (пробіг, причина, рекомендації, аванс, знижка)
━━━━━━━━━━━━━━━━━━━━━━━━

📋 ПОЛЯ АКТУ (action=FIELD):
${fieldsList}

📦 ВИЗНАЧЕННЯ ТИПУ (work / detail):
▸ type: "work"   — ПОСЛУГА: заміна, ремонт, діагностика, розбирання, шліфування, регулювання, промивка, перевірка
▸ type: "detail" — ДЕТАЛЬ/ЗАПЧАСТИНА: фільтр, масло, колодки, поршні, кільця, вкладиші, ремінь, свічки, сальник, прокладка, підшипник, ШРУС, піввісь

🗣️ СУРЖИК / ЖАРГОН → ПРАВИЛЬНА НАЗВА:
"кольца" → "Поршневі кільця"
"прокладка голови" → "Прокладка головки блоку"
"помпа" → "Насос охолодження"
"вкладиші" → "Вкладиші корінні" або "Вкладиші шатунні" (за контекстом)
"ШРУС" → "ШРУС привідний"
"піввісь" → "Піввісь привідна"
"термік" → "Термостат"
"ролик" → "Ролик натяжний ременя"
"бронебойки" → "Свічки запалювання"
"прокладка кришки" → "Прокладка кришки клапанів"

🔑 ПРАВИЛА:
- Може бути КІЛЬКА позицій: "заміна масла і фільтр" → 2 items
- "по 500" / "за 500" / "ціна 500" / "коштує 500" → price: 500
- "24 штуки по 131" → quantity:24, price:131
- "24 штуки на 3144 грн" → quantity:24, price:131 (ПОРАХУЙ: 3144÷24)
- "3 штуки" / "кількість 3" → quantity:3; якщо не вказано → quantity:1
- "слюсар Петренко" / "зп 300" → slyusar, slyusarSum
- Числа словами: "тисяча двісті" = 1200, "три" = 3
- "видали рядок 3" / "видалити третій" → DELETE, targetRow:3
- "зміни рядок 2 ціну на 500" → EDIT, targetRow:2
- Якщо не сказано "рядок N" → action=ADD

⚠️ ПОМИЛКИ РОЗПІЗНАВАННЯ:
"апоршні" → "поршні", "аміна" → "заміна", "ільтр" → "фільтр"
"емонт" → "ремонт", "іагностика" → "діагностика", "ечення" → "обслуговування"
Завжди відновлюй слово повністю!

━━ МАГАЗИНИ / ПОСТАЧАЛЬНИКИ ━━
${shopNames.length > 0 ? shopNames.join(", ") : "Автотехнікс, АвтоЗІП, Еліт, Інтеркарс, Омега, Лоял, Форнетті"}
Відмінки: "від Еліта" = "Еліт", "з Інтеркарсу" = "Інтеркарс"

━━ РОБОТИ (знайди НАЙБІЛЬШ СХОЖУ) ━━
${workNames.join("\n")}

━━ ДЕТАЛІ ━━
${detailNames.join("\n")}

━━ СЛЮСАРІ ━━
${slyusarNames.join(", ")}

Відповідь — ТІЛЬКИ JSON:
{"action":"ADD","items":[{"type":"detail","name":"Точна назва зі списку","price":3300,"quantity":4,"slyusar":null,"slyusarSum":null}],"targetRow":null,"field":null}`;

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
            if (parsed.action) return parsed as ParsedNaturalCommand;
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
 * Обробляє результат інтелектуального парсингу — виконує дії з таблицею
 */
async function executeNaturalCommand(
  result: ParsedNaturalCommand,
): Promise<void> {
  switch (result.action) {
    case "FIELD": {
      if (!result.field) {
        showNotification("⚠️ Не вдалося визначити поле", "warning", 3000);
        return;
      }
      fillField(result.field.fieldId, result.field.value);
      const fieldLabel =
        FIELD_KEYWORDS.find((f) => f.fieldId === result.field!.fieldId)
          ?.label || result.field.fieldId;
      showNotification(
        `✅ ${fieldLabel}: ${result.field.value}`,
        "success",
        3000,
      );
      return;
    }

    case "DELETE": {
      if (!result.targetRow || result.targetRow < 1) {
        showNotification(
          "⚠️ Вкажіть номер рядка для видалення",
          "warning",
          3000,
        );
        return;
      }
      const row = getTableRow(result.targetRow);
      if (!row) {
        showNotification(
          `❌ Рядок ${result.targetRow} не існує`,
          "error",
          3000,
        );
        return;
      }
      const delBtn = row.querySelector(".remove-row-btn") as HTMLElement;
      if (delBtn) {
        delBtn.click();
        showNotification(
          `🗑️ Видалено рядок ${result.targetRow}`,
          "success",
          3000,
        );
      } else {
        row.remove();
        updateCalculatedSumsInFooter();
        showNotification(
          `🗑️ Видалено рядок ${result.targetRow}`,
          "success",
          3000,
        );
      }
      return;
    }

    case "EDIT": {
      if (!result.targetRow || !result.items?.length) {
        showNotification(
          "⚠️ Не вдалося визначити рядок для редагування",
          "warning",
          3000,
        );
        return;
      }
      const editRow = getTableRow(result.targetRow);
      if (!editRow) {
        showNotification(
          `❌ Рядок ${result.targetRow} не існує`,
          "error",
          3000,
        );
        return;
      }
      fillFullRow(editRow, result.items[0] as ParsedFullRow);
      showNotification(
        `✏️ Рядок ${result.targetRow} оновлено`,
        "success",
        3000,
      );
      return;
    }

    case "ADD": {
      if (!result.items?.length) {
        showNotification("⚠️ Не вдалося визначити що додати", "warning", 3000);
        return;
      }

      const addedNames: string[] = [];

      for (const item of result.items) {
        // Додаємо новий рядок
        addNewRow(ACT_ITEMS_TABLE_CONTAINER_ID);
        const newCount = getRowCount();
        const newRow = getTableRow(newCount);
        if (!newRow) continue;

        // Заповнюємо
        const parsed: ParsedFullRow = {
          type: item.type || "work",
          name: item.name || "",
          price: item.price ?? null,
          quantity: item.quantity ?? 1,
          slyusar: item.slyusar ?? null,
          slyusarSum: item.slyusarSum ?? null,
        };

        fillFullRow(newRow, parsed);

        const match = findBestMatch(parsed.name, parsed.type);
        const finalName = match?.name || parsed.name;
        const icon = parsed.type === "work" ? "🛠️" : "⚙️";
        const priceStr = parsed.price
          ? ` × ${parsed.quantity ?? 1} = ${(parsed.price * (parsed.quantity ?? 1)).toLocaleString("uk-UA")} грн`
          : "";
        addedNames.push(`${icon} ${finalName}${priceStr}`);
      }

      if (addedNames.length === 1) {
        showNotification(`✅ Додано: ${addedNames[0]}`, "success", 4000);
      } else {
        showNotification(
          `✅ Додано ${addedNames.length} позицій:\n${addedNames.join("\n")}`,
          "success",
          5000,
        );
      }
      return;
    }
  }
}

async function callGeminiForObject(
  requestBody: string,
): Promise<ParsedFullRow | null> {
  const keys = geminiApiKeys;
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
            return JSON.parse(jsonMatch[0]);
          } catch {
            /* fallthrough */
          }
        }

        // Спроба відновити JSON
        return tryRepairJson(text);
      }

      if (response.status === 429) {
        currentKeyIndex = (keyIdx + 1) % keys.length;
        startIndex = keyIdx + 1;
        continue;
      }
      return null;
    } catch (err) {
      if (triedIndices.size >= keys.length) throw err;
      startIndex = keyIdx + 1;
    }
  }
  return null;
}

function tryRepairJson(text: string): ParsedFullRow | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let jsonStr = text
    .substring(start)
    .replace(/```[\s\S]*$/g, "")
    .trim();

  if (!jsonStr.endsWith("}")) {
    let braceCount = 0;
    for (const ch of jsonStr) {
      if (ch === "{") braceCount++;
      if (ch === "}") braceCount--;
    }
    const lastComma = jsonStr.lastIndexOf(",");
    const lastColon = jsonStr.lastIndexOf(":");
    const lastNull = jsonStr.lastIndexOf("null");
    const lastQuote = jsonStr.lastIndexOf('"');
    if (
      lastColon > lastComma &&
      lastColon > lastNull &&
      lastColon > lastQuote
    ) {
      jsonStr = jsonStr.substring(0, lastComma > 0 ? lastComma : lastColon);
    }
    while (braceCount > 0) {
      jsonStr += "}";
      braceCount--;
    }
  }

  jsonStr = jsonStr.replace(/,\s*}/g, "}");

  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.type && typeof parsed.name === "string") {
      return {
        type: parsed.type === "detail" ? "detail" : "work",
        name: parsed.name || "",
        price: typeof parsed.price === "number" ? parsed.price : null,
        quantity: typeof parsed.quantity === "number" ? parsed.quantity : null,
        slyusar: parsed.slyusar || null,
        slyusarSum:
          typeof parsed.slyusarSum === "number" ? parsed.slyusarSum : null,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Парсить одне значення через Gemini (число, ПІБ, каталог)
 */
async function parseSingleFieldWithGemini(
  transcript: string,
  column: string,
): Promise<string | number | null> {
  if (["id_count", "price", "slyusar_sum"].includes(column)) {
    const localNum = tryParseNumberLocally(transcript);
    if (localNum !== null) return localNum;
  }

  if (column === "pib_magazin") {
    const localMatch = findSlyusarOrShop(transcript);
    if (localMatch) return localMatch;
  }

  const keys = await loadGeminiKeys();
  if (keys.length === 0) throw new Error("Немає API ключів Gemini.");

  const columnLabel: Record<string, string> = {
    id_count: "КІЛЬКІСТЬ (ціле число)",
    price: "ЦІНА (число в гривнях)",
    slyusar_sum: "ЗАРПЛАТА слюсаря (число)",
    pib_magazin: "ПІБ слюсаря або магазин",
    catalog: "Каталожний номер",
  };

  let contextList = "";
  if (column === "pib_magazin") {
    const names = [
      ...globalCache.slyusars.map((s) => s.Name),
      ...globalCache.shops.map((s) => s.Name),
    ].filter(Boolean);
    contextList = `\nДОСТУПНІ ІМЕНА:\n${names.join(", ")}`;
  }

  const systemPrompt = `Ти парсер голосового введення. Потрібно значення для: ${columnLabel[column] || column}.${contextList}
Відповідай ТІЛЬКИ значенням — без пояснень. Числа словами → цифри. Імена → найближче з доступних.`;

  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: transcript }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
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
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) return null;

        if (["id_count", "price", "slyusar_sum"].includes(column)) {
          const num = parseFloat(
            text.replace(/[^\d.,]/g, "").replace(",", "."),
          );
          return isNaN(num) ? null : Math.round(num);
        }
        return text;
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

// ============================================================
// ЗАПОВНЕННЯ ПОЛІВ / КЛІТИНОК
// ============================================================

/** Записує значення у верхнє поле акту (Пробіг, Причина, тощо) */
function fillField(fieldId: string, value: string): void {
  const el = document.getElementById(fieldId);
  if (!el) return;

  // Для input — value, для contenteditable — textContent/innerText
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // contenteditable span
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Заповнює повний рядок (Найменування + всі поля) */
function fillFullRow(row: HTMLTableRowElement, parsed: ParsedFullRow): void {
  const match = findBestMatch(parsed.name, parsed.type);
  const finalName = match?.name || parsed.name;
  const isWork = parsed.type === "work";

  const nameCell = row.querySelector('[data-name="name"]') as HTMLElement;
  if (nameCell && finalName) {
    nameCell.textContent = finalName;
    nameCell.setAttribute("data-full-name", finalName);
    nameCell.setAttribute("data-type", isWork ? "works" : "details");
  }

  const indexCell = row.querySelector(".row-index");
  if (indexCell) {
    const icon = isWork ? "🛠️" : "⚙️";
    const idx = indexCell.textContent?.match(/\d+/)?.[0] || "1";
    indexCell.innerHTML = `${icon} ${idx}`;
  }

  if (isWork && match?.workId) {
    const catCell = row.querySelector('[data-name="catalog"]') as HTMLElement;
    if (catCell) catCell.textContent = match.workId;
  }
  if (!isWork && match?.scladId) {
    const catCell = row.querySelector('[data-name="catalog"]') as HTMLElement;
    if (catCell) catCell.setAttribute("data-sclad-id", String(match.scladId));
  }

  const qtyCell = row.querySelector('[data-name="id_count"]') as HTMLElement;
  if (qtyCell) qtyCell.textContent = String(parsed.quantity ?? 1);

  const priceCell = row.querySelector('[data-name="price"]') as HTMLElement;
  if (priceCell && parsed.price !== null)
    priceCell.textContent = String(parsed.price);

  const sumCell = row.querySelector('[data-name="sum"]') as HTMLElement;
  if (sumCell && parsed.price !== null)
    sumCell.textContent = String(parsed.price * (parsed.quantity ?? 1));

  if (parsed.slyusar) {
    const found = findSlyusarOrShop(parsed.slyusar);
    if (found) {
      const pibCell = row.querySelector(
        '[data-name="pib_magazin"]',
      ) as HTMLElement;
      if (pibCell) {
        pibCell.textContent = found;
        pibCell.setAttribute("data-type", "slyusars");
      }
    }
  }

  if (parsed.slyusarSum !== null) {
    const sCell = row.querySelector('[data-name="slyusar_sum"]') as HTMLElement;
    if (sCell) sCell.textContent = String(parsed.slyusarSum);
  }

  if (parsed.price === null && finalName) {
    handleItemSelection(row, finalName, parsed.type).catch(() => {});
  }

  updateCalculatedSumsInFooter();
}

/**
 * Локальний парсер переліку полів:
 * "найменування шарова кількість 15 ціна 8 зарплата 5 піб Брацлавець"
 * заповнює відповідні клітинки рядка без Gemini.
 */
function fillMultiFieldsFromText(
  row: HTMLTableRowElement,
  text: string,
): boolean {
  const normalized = text.toLowerCase().trim();

  // Сортуємо по довжині ключового слова (довші першими)
  const sorted = [...COLUMN_KEYWORDS].sort(
    (a, b) =>
      Math.max(...b.keywords.map((k) => k.length)) -
      Math.max(...a.keywords.map((k) => k.length)),
  );

  const positions: { pos: number; column: string; kwLen: number }[] = [];

  for (const col of sorted) {
    for (const kw of col.keywords) {
      const kw2 = kw.trim(); // "пі " → "пі"
      let searchFrom = 0;
      while (searchFrom < normalized.length) {
        const idx = normalized.indexOf(kw2, searchFrom);
        if (idx === -1) break;
        // Перевіряємо що перед нім не буква (початок слова)
        if (idx > 0 && /[\u0400-\u04FFa-z]/i.test(normalized[idx - 1])) {
          searchFrom = idx + 1;
          continue;
        }
        // Перевіряємо що після ключового слова не йде буква (напр. "пі" ≠ "після")
        const charAfter = normalized[idx + kw2.length];
        if (charAfter && /[\u0400-\u04FFa-z]/i.test(charAfter)) {
          searchFrom = idx + 1;
          continue;
        }
        const alreadyCovered = positions.some(
          (p) => idx >= p.pos && idx < p.pos + p.kwLen,
        );
        if (!alreadyCovered) {
          positions.push({ pos: idx, column: col.column, kwLen: kw2.length });
        }
        break;
      }
    }
  }

  if (positions.length === 0) return false;
  positions.sort((a, b) => a.pos - b.pos);

  let applied = 0;
  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];
    const valueStart = current.pos + current.kwLen;
    const valueEnd =
      i + 1 < positions.length ? positions[i + 1].pos : text.length;
    let rawValue = text.substring(valueStart, valueEnd).trim();
    if (!rawValue) continue;

    if (["id_count", "price", "slyusar_sum"].includes(current.column)) {
      const num = tryParseNumberLocally(rawValue);
      if (num !== null) rawValue = String(num);
    }

    fillSingleCell(row, current.column, rawValue);
    applied++;
  }

  updateCalculatedSumsInFooter();
  return applied > 0;
}
function fillSingleCell(
  row: HTMLTableRowElement,
  column: string,
  value: string | number,
): void {
  const cell = row.querySelector(`[data-name="${column}"]`) as HTMLElement;
  if (!cell) return;

  if (column === "pib_magazin") {
    const found = findSlyusarOrShop(String(value));
    cell.textContent = found || String(value);
    if (found) {
      const isSlyusar = globalCache.slyusars.some((s) => s.Name === found);
      cell.setAttribute("data-type", isSlyusar ? "slyusars" : "shops");
    }
  } else {
    cell.textContent = String(value);
  }

  if (column === "price" || column === "id_count") {
    const priceEl = row.querySelector('[data-name="price"]') as HTMLElement;
    const qtyEl = row.querySelector('[data-name="id_count"]') as HTMLElement;
    const sumEl = row.querySelector('[data-name="sum"]') as HTMLElement;
    const price = parseFloat(priceEl?.textContent?.replace(/\s/g, "") || "0");
    const qty = parseFloat(qtyEl?.textContent?.replace(/\s/g, "") || "1");
    if (sumEl && !isNaN(price) && !isNaN(qty)) {
      sumEl.textContent = String(Math.round(price * qty));
    }
  }

  updateCalculatedSumsInFooter();
}

// ============================================================
// КНОПКА МІКРОФОНА — UI
// ============================================================

function updateMicButton(btn: HTMLElement, state: VoiceState): void {
  voiceState = state;
  btn.classList.remove("ai-chat-voice-btn--listening");

  switch (state) {
    case "idle":
      btn.innerHTML = "🎙️";
      btn.title = "Голосове введення";
      break;
    case "listening":
      btn.classList.add("ai-chat-voice-btn--listening");
      btn.innerHTML = `<span class="ai-voice-pulse">🔴</span>`;
      btn.title = "Слухаю... Натисніть для зупинки";
      break;
    case "processing":
      btn.innerHTML = `<span class="ai-voice-pulse">⚙️</span>`;
      btn.title = "Обробка...";
      break;
  }
}

// ============================================================
// ГОЛОВНИЙ ОБРОБНИК
// ============================================================

// ============================================================
// OVERLAY — плаваюча панель під час диктування
// ============================================================

function createVoiceOverlay(): HTMLElement {
  let overlay = document.getElementById("voice-realtime-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "voice-realtime-overlay";
  overlay.style.cssText = `
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(20,20,30,0.92);
    color: #fff;
    border-radius: 16px;
    padding: 14px 22px;
    font-size: 15px;
    max-width: 480px;
    min-width: 240px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    z-index: 99999;
    pointer-events: none;
    display: none;
    text-align: center;
    border: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(8px);
    transition: opacity 0.2s;
  `;
  document.body.appendChild(overlay);
  return overlay;
}

export function showVoiceOverlay(text: string): void {
  const overlay = createVoiceOverlay();
  overlay.innerHTML = `<span style="color:#f87171;margin-right:8px;">🎙️</span><span>${text}</span>`;
  overlay.style.display = "block";
}

export function hideVoiceOverlay(): void {
  const overlay = document.getElementById("voice-realtime-overlay");
  if (overlay) overlay.style.display = "none";
}

/**
 * Слухає мікрофон з real-time колбеком.
 * onFinalSegment — викликається щоразу коли браузер «закріплює» шматок тексту (isFinal).
 * Повертає Promise «весь текст за сесію» (для fallback).
 */
function startListeningRealtime(
  onFinalSegment: (segment: string, accumulated: string) => void,
  onInterimUpdate: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      reject(new Error("Браузер не підтримує розпізнавання мови"));
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = "uk-UA";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let accumulated = "";
    let segmentBuffer = "";
    let segmentFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;
    // На мобільному isFinal приходить по 1-2 слова — даємо більше часу на накопичення
    const SEGMENT_DEBOUNCE = IS_MOBILE ? 2500 : 1500;
    const SILENCE_TIMEOUT = IS_MOBILE ? 5000 : 3500;
    const STOP_PHRASES = [
      "це все",
      "це всі",
      "усе",
      "готово",
      "стоп",
      "кінець",
    ];

    function flushSegmentBuffer() {
      if (segmentFlushTimer) clearTimeout(segmentFlushTimer);
      segmentFlushTimer = null;
      if (segmentBuffer.trim()) {
        onFinalSegment(segmentBuffer.trim(), accumulated);
        segmentBuffer = "";
      }
    }

    function finish() {
      if (resolved) return;
      resolved = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      if (segmentFlushTimer) clearTimeout(segmentFlushTimer);
      clearTimeout(maxTimeout);
      flushSegmentBuffer();
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      resolve(accumulated.trim());
    }

    function resetSilence() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish(), SILENCE_TIMEOUT);
    }

    const maxTimeout = setTimeout(() => finish(), 30000);

    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const seg = event.results[i][0].transcript;
          accumulated += seg;
          segmentBuffer += seg;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      onInterimUpdate((accumulated + " " + interim).trim());

      // Перевірка стоп-слів
      const lower = accumulated.toLowerCase().trim();
      for (const phrase of STOP_PHRASES) {
        if (lower.endsWith(phrase) || lower.endsWith(phrase + ".")) {
          accumulated = accumulated
            .replace(new RegExp(phrase + "[.,]?\\s*$", "i"), "")
            .trim();
          segmentBuffer = segmentBuffer
            .replace(new RegExp(phrase + "[.,]?\\s*$", "i"), "")
            .trim();
          setTimeout(() => finish(), 300);
          return;
        }
      }

      // Debounce: чекаємо 1.5с на продовження фрази перед обробкою
      if (segmentFlushTimer) clearTimeout(segmentFlushTimer);
      if (segmentBuffer.trim()) {
        segmentFlushTimer = setTimeout(
          () => flushSegmentBuffer(),
          SEGMENT_DEBOUNCE,
        );
      }
      resetSilence();
    };

    rec.onerror = (event: any) => {
      if (resolved) return;
      if (event.error === "no-speech") return;
      clearTimeout(maxTimeout);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (accumulated.trim()) {
        finish();
        return;
      }
      if (event.error === "audio-capture")
        reject(new Error("Мікрофон не знайдено."));
      else if (event.error === "not-allowed")
        reject(new Error("Доступ до мікрофона заборонено."));
      else reject(new Error(`Помилка: ${event.error}`));
    };

    rec.onend = () => {
      // continuous=true може зупинитись по таймауту браузера — перезапускаємо
      if (!resolved) {
        setTimeout(() => {
          if (!resolved) {
            try {
              rec.start();
            } catch {
              finish();
            }
          }
        }, 100);
      }
    };

    silenceTimer = setTimeout(() => {
      if (!accumulated.trim()) {
        resolved = true;
        if (segmentFlushTimer) clearTimeout(segmentFlushTimer);
        clearTimeout(maxTimeout);
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        reject(new Error("Мову не виявлено. Спробуйте ще раз."));
      }
    }, 7000);

    // Зберігаємо refs щоб зовні можна зупинити
    recognition = rec;
    rec.start();
  });
}

export async function handleVoiceButtonClick(btn: HTMLElement): Promise<void> {
  if (voiceState === "listening") {
    stopListening();
    updateMicButton(btn, "idle");
    hideVoiceOverlay();
    return;
  }
  if (voiceState === "processing") return;

  if (!isSpeechRecognitionSupported()) {
    showNotification(
      "❌ Браузер не підтримує розпізнавання мови. Використовуйте Chrome.",
      "error",
      4000,
    );
    return;
  }

  try {
    // The editor no longer downloads the full warehouse on open. Voice matching uses the complete dictionary only on demand.
    const openingActId = globalCache.currentActId;
    updateMicButton(btn, "processing");

    if (!btn.isConnected || openingActId !== globalCache.currentActId) return;
    updateMicButton(btn, "listening");
    showVoiceOverlay("Говоріть команду...");
    showNotification(
      `Говоріть команду, наприклад:\n• "Додай поршні 4 штуки по 3300"\n• "Фільтр масляний і колодки гальмівні"\n• "пробіг 150000"\n• "рядок 2 ціна 500"\n• "видали рядок 3"`,
      "info",
      5000,
    );

    // Буфер для сегментів що ще обробляються (не дати race condition)
    let processingSegment = false;
    const pendingSegments: string[] = [];
    let handledAnyRealtimeSegment = false;
    // Буфер для неповних команд: збираємо фрагменти поки не стане повною командою
    let incompleteBuffer = "";
    let incompleteFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const INCOMPLETE_WAIT = IS_MOBILE ? 3000 : 2000;

    async function processSegment(
      segment: string,
      forceProcess = false,
    ): Promise<void> {
      if (!segment.trim()) return;

      // Об'єднуємо з попереднім неповним буфером
      const fullSegment = incompleteBuffer
        ? (incompleteBuffer + " " + segment).trim()
        : segment.trim();

      // Якщо це неповна команда-префікс І НЕ примусова обробка — накопичуємо
      if (!forceProcess && isIncompleteCommandPrefix(fullSegment)) {
        incompleteBuffer = fullSegment;
        showVoiceOverlay(`🎙️ ${fullSegment}...`);

        // Таймер: якщо нічого не додається — обробляємо примусово
        if (incompleteFlushTimer) clearTimeout(incompleteFlushTimer);
        incompleteFlushTimer = setTimeout(() => {
          incompleteFlushTimer = null;
          if (incompleteBuffer) {
            const buf = incompleteBuffer;
            incompleteBuffer = "";
            processSegment(buf, true); // forceProcess = true щоб не зациклити
          }
        }, INCOMPLETE_WAIT);
        return;
      }

      // Скидаємо incomplete буфер — маємо повну команду
      incompleteBuffer = "";
      if (incompleteFlushTimer) {
        clearTimeout(incompleteFlushTimer);
        incompleteFlushTimer = null;
      }

      if (processingSegment) {
        pendingSegments.push(fullSegment);
        return;
      }
      processingSegment = true;
      showVoiceOverlay(`⚙️ Виконую: "${fullSegment}"`);

      try {
        await loadEditorReferences({query:fullSegment, voice:true});
        if (!btn.isConnected || openingActId !== globalCache.currentActId) return;
        // Спочатку швидкий локальний парсер
        const cmd = parseVoiceCommand(fullSegment);
        if (cmd) {
          const didExecute = await executeParsedCommand(cmd);
          if (didExecute) handledAnyRealtimeSegment = true;
        } else {
          // Gemini для складних/натуральних команд
          const naturalResult =
            await parseNaturalCommandWithGemini(fullSegment);
          if (naturalResult?.action) {
            await executeNaturalCommand(naturalResult);
            handledAnyRealtimeSegment = true;
          } else {
            // Фолбек — пошук по кешу
            const localMatch =
              findBestMatch(fullSegment, "work") ||
              findBestMatch(fullSegment, "detail");
            if (localMatch) {
              addNewRow(ACT_ITEMS_TABLE_CONTAINER_ID);
              const newRow = getTableRow(getRowCount());
              if (newRow) {
                fillFullRow(newRow, {
                  type: localMatch.workId ? "work" : "detail",
                  name: localMatch.name,
                  price: null,
                  quantity: 1,
                  slyusar: null,
                  slyusarSum: null,
                });
                const icon = localMatch.workId ? "🛠️" : "⚙️";
                showNotification(
                  `✅ Додано: ${icon} ${localMatch.name}`,
                  "success",
                  3000,
                );
                handledAnyRealtimeSegment = true;
              }
            }
          }
        }
      } catch {
        /* ignore per-segment errors */
      }

      processingSegment = false;
      // Обробити наступний очікуючий сегмент
      if (pendingSegments.length > 0) {
        const next = pendingSegments.shift()!;
        await processSegment(next);
      }
    }

    const transcript = await startListeningRealtime(
      // onFinalSegment — негайне виконання при кожному закріпленому шматку
      (segment) => {
        processSegment(segment);
      },
      // onInterimUpdate — оновлення overlay
      (text) => {
        if (voiceState === "listening") showVoiceOverlay(`🎙️ ${text}`);
      },
    );

    hideVoiceOverlay();

    if (!transcript?.trim()) {
      showNotification("🎙️ Мову не розпізнано. Спробуйте ще.", "warning", 2500);
      updateMicButton(btn, "idle");
      return;
    }

    // Зливаємо залишки неповного буфера (мобільне: останній фрагмент міг не дочекатися)
    if (incompleteBuffer) {
      if (incompleteFlushTimer) clearTimeout(incompleteFlushTimer);
      incompleteFlushTimer = null;
      const buf = incompleteBuffer;
      incompleteBuffer = "";
      await processSegment(buf, true); // forceProcess
    }

    // Якщо пройшов режим реального часу — але щось ще не обробилось через race
    // Чекаємо поки обробиться останній сегмент
    await new Promise<void>((r) => {
      const check = () => {
        if (!processingSegment && pendingSegments.length === 0) {
          r();
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    // Якщо команди вже були виконані по сегментах у real-time,
    // не запускаємо повторний прохід по повному transcript (уникнення дублювання).
    if (handledAnyRealtimeSegment) {
      updateMicButton(btn, "idle");
      return;
    }

    updateMicButton(btn, "processing");

    // Парсимо ключову фразу
    const command = parseVoiceCommand(transcript);

    // === Якщо ключовий парсер не розпізнав → Gemini "інтелектуальний парсер" ===
    if (!command) {
      showNotification(`🧠 Аналізую: "${transcript}"`, "info", 2500);

      try {
        const naturalResult = await parseNaturalCommandWithGemini(transcript);

        if (naturalResult && naturalResult.action) {
          await executeNaturalCommand(naturalResult);
          updateMicButton(btn, "idle");
          return;
        }
      } catch (err) {
        // console.warn("🎙️ Gemini natural parse failed, using fallback:", err);
      }

      // Останній фолбек — спробувати як назву деталі/роботи
      const localMatch =
        findBestMatch(transcript, "work") ||
        findBestMatch(transcript, "detail");

      if (localMatch) {
        addNewRow(ACT_ITEMS_TABLE_CONTAINER_ID);
        const newCount = getRowCount();
        const newRow = getTableRow(newCount);
        if (newRow) {
          const parsed: ParsedFullRow = {
            type: localMatch.workId ? "work" : "detail",
            name: localMatch.name,
            price: null,
            quantity: 1,
            slyusar: null,
            slyusarSum: null,
          };
          fillFullRow(newRow, parsed);
          const icon = parsed.type === "work" ? "🛠️" : "⚙️";
          showNotification(
            `✅ Додано: ${icon} ${localMatch.name}`,
            "success",
            3000,
          );
          updateMicButton(btn, "idle");
          return;
        }
      }

      // Фолбек 2: "додай рядок [поле значення поле значення...]" — локальний парсер переліку полів
      const addRowMultiMatch = transcript
        .trim()
        .match(
          /^(?:додай рядок|додати рядок|додай стрічку|додати стрічку|новий рядок|нова стрічка|додай|додати)\s+(.+)$/i,
        );
      if (addRowMultiMatch) {
        addNewRow(ACT_ITEMS_TABLE_CONTAINER_ID);
        const newCount = getRowCount();
        const newRow = getTableRow(newCount);
        if (newRow) {
          const restText = addRowMultiMatch[1];
          const filled = fillMultiFieldsFromText(newRow, restText);
          if (filled) {
            const nameCell = newRow.querySelector(
              '[data-name="name"]',
            ) as HTMLElement;
            const nameFilled = nameCell?.textContent?.trim() || "";
            showNotification(
              `✅ Додано рядок ${newCount}${nameFilled ? ": " + nameFilled : ""}`,
              "success",
              3000,
            );
            updateMicButton(btn, "idle");
            return;
          }
        }
      }

      showNotification(
        `❌ Не розпізнано: "${transcript}"\n\nСпробуйте:\n• "Додай поршні 4 штуки по 3300"\n• "пробіг 150000"\n• "рядок 2 ціна 500"`,
        "warning",
        5000,
      );
      updateMicButton(btn, "idle");
      return;
    }

    // Виконуємо розпізнану команду через єдиний обробник (без дублювання)
    await executeParsedCommand(command);
  } catch (err: any) {
    showNotification(
      `❌ ${err.message || "Помилка голосового введення"}`,
      "error",
      3500,
    );
  } finally {
    hideVoiceOverlay();
    updateMicButton(btn, "idle");
  }
}

// ============================================================
// СТВОРЕННЯ ТА ІНІЦІАЛІЗАЦІЯ
// ============================================================

/**
 * Виконує результат локального parseVoiceCommand.
 * Використовується і в real-time режимі (на льоту), і у fallback.
 * Повертає true якщо команда реально виконалась (щось змінилось в DOM).
 */
async function executeParsedCommand(command: {
  target: VoiceTarget;
  value: string;
}): Promise<boolean> {
  const { target, value } = command;

  if (target.kind === "field") {
    let finalValue = value;
    if (
      target.fieldId === "editable-probig" ||
      target.fieldId === "editable-avans" ||
      target.fieldId === "editable-discount"
    ) {
      const num = tryParseNumberLocally(value);
      if (num !== null) finalValue = String(num);
    }
    if (!finalValue) return false;
    fillField(target.fieldId, finalValue);
    showNotification(`✅ ${target.label}: ${finalValue}`, "success", 3000);
    return true;
  }

  if (target.kind === "cell") {
    let row: HTMLTableRowElement | null = null;

    if (target.rowIndex === -1) {
      addNewRow(ACT_ITEMS_TABLE_CONTAINER_ID);
      row = getTableRow(getRowCount());
      if (!row) return false;
    } else {
      row = getTableRow(target.rowIndex);
      if (!row) {
        showNotification(
          `❌ Рядок ${target.rowIndex} не існує. Є ${getRowCount()} рядків.`,
          "error",
          3000,
        );
        return false;
      }
    }

    if (target.column === "name") {
      if (!value) return false;
      const localMatch =
        findBestMatch(value, "work") || findBestMatch(value, "detail");
      let parsed = await parseFullRowWithGemini(value);
      if (
        parsed &&
        (!parsed.name || parsed.name.includes("...") || parsed.name.length < 3)
      ) {
        if (localMatch) {
          parsed.name = localMatch.name;
          parsed.type = localMatch.workId ? "work" : "detail";
        }
      }
      if (!parsed && localMatch) {
        parsed = {
          type: localMatch.workId ? "work" : "detail",
          name: localMatch.name,
          price: null,
          quantity: 1,
          slyusar: null,
          slyusarSum: null,
        };
      }
      if (!parsed) {
        parsed = {
          type: "work",
          name: value,
          price: null,
          quantity: 1,
          slyusar: null,
          slyusarSum: null,
        };
      }
      fillFullRow(row, parsed);
      const finalName =
        findBestMatch(parsed.name, parsed.type)?.name || parsed.name;
      const icon = parsed.type === "work" ? "🛠️" : "⚙️";
      const rowIdx = target.rowIndex === -1 ? getRowCount() : target.rowIndex;
      showNotification(
        `✅ Рядок ${rowIdx}: ${icon} ${finalName}`,
        "success",
        3000,
      );
    } else {
      if (!value) return false;
      let finalValue: string | number | null = null;
      if (["id_count", "price", "slyusar_sum"].includes(target.column)) {
        finalValue = tryParseNumberLocally(value);
      }
      if (target.column === "pib_magazin") {
        finalValue = findSlyusarOrShop(value);
      }
      if (finalValue === null) {
        finalValue = await parseSingleFieldWithGemini(value, target.column);
      }
      if (finalValue === null) finalValue = value;
      fillSingleCell(row, target.column, finalValue);
      const rowIdx = target.rowIndex === -1 ? getRowCount() : target.rowIndex;
      showNotification(
        `✅ Рядок ${rowIdx}, ${target.label}: ${finalValue}`,
        "success",
        3000,
      );
    }
    return true;
  }
  return false;
}

export function createVoiceButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = "voice-input-button";
  btn.className = "ai-chat-voice-btn";
  btn.type = "button";
  btn.innerHTML = "🎙️";
  btn.title = "Голосове введення";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleVoiceButtonClick(btn);
  });

  return btn;
}

/**
 * Ініціалізує голосове введення — кнопка 🎙️
 * Без трекінгу фокусу, команди визначаються ключовими словами
 * Видимість кнопки визначається налаштуванням voiceInputEnabled
 */
export function initVoiceInput(): void {
  if (globalCache.isActClosed) return;

  if (!isSpeechRecognitionSupported()) return;

  const container = document.querySelector(".zakaz_narayd-buttons-container");
  if (!container) return;
  if (document.getElementById("voice-input-button")) return;

  const voiceBtn = createVoiceButton();

  // 🎙️ Перевіряємо налаштування видимості
  if (!globalCache.generalSettings.voiceInputEnabled) {
    voiceBtn.style.display = "none";
  }

  const saveBtn = document.getElementById("save-act-data");
  if (saveBtn) {
    container.insertBefore(voiceBtn, saveBtn);
  } else {
    container.appendChild(voiceBtn);
  }
}

// ============================================================
// 🎙️ ШВИДКЕ ГОЛОСОВЕ ВВЕДЕННЯ ДЛЯ ЧАТУ
// ============================================================

/**
 * Розпізнавання голосу для AI чату.
 * continuous: true — слухає довгі фрази.
 * Зупинка: кодове слово "це все" або 2 секунди тиші.
 */
export function startChatVoiceInput(): Promise<string> {
  return startChatVoiceInputRealtime(null);
}

/**
 * Зупиняє активне розпізнавання ззовні (коли користувач натискає Стоп)
 */
export function stopChatVoiceInput(): void {
  if (_activeChatRec) {
    try {
      _activeChatRec.abort();
    } catch {
      /* ignore */
    }
    _activeChatRec = null;
  }
}

/**
 * 🎙️ Real-time голосовий ввід для AI-чату.
 * onInterim(text) — викликається на КОЖЕН проміжний результат (для відображення в textarea).
 * Повертає фінальний текст після тиші/стоп-слова.
 */
export function startChatVoiceInputRealtime(
  onInterim: ((text: string) => void) | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      reject(new Error("Браузер не підтримує розпізнавання мови"));
      return;
    }

    // Зупиняємо попереднє розпізнавання якщо є (фікс подвійного запуску)
    if (_activeChatRec) {
      try {
        _activeChatRec.abort();
      } catch {
        /* ignore */
      }
      _activeChatRec = null;
    }

    const rec = new SpeechRecognition();
    _activeChatRec = rec;
    rec.lang = "uk-UA";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let fullTranscript = "";
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const STOP_PHRASES = [
      "це все",
      "це всі",
      "усе",
      "все",
      "готово",
      "стоп",
      "кінець",
    ];

    function finish() {
      if (resolved) return;
      resolved = true;
      _activeChatRec = null;
      if (silenceTimer) clearTimeout(silenceTimer);
      clearTimeout(maxTimeout);
      try {
        rec.stop();
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
      resolve(result || "");
    }

    function resetSilenceTimer() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish(), 3000);
    }

    // Максимум 30 секунд
    const maxTimeout = setTimeout(() => finish(), 30000);

    rec.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          fullTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (onInterim) onInterim((fullTranscript + " " + interim).trim());

      const currentText = fullTranscript.toLowerCase().trim();

      for (const phrase of STOP_PHRASES) {
        if (
          currentText.endsWith(phrase) ||
          currentText.endsWith(phrase + ".") ||
          currentText.endsWith(phrase + ",")
        ) {
          setTimeout(() => finish(), 300);
          return;
        }
      }
      resetSilenceTimer();
    };

    rec.onerror = (event: any) => {
      if (resolved) return;
      if (event.error === "no-speech") return;
      clearTimeout(maxTimeout);
      if (silenceTimer) clearTimeout(silenceTimer);

      if (fullTranscript.trim()) {
        finish();
        return;
      }

      if (event.error === "audio-capture")
        reject(new Error("Мікрофон не знайдено"));
      else if (event.error === "not-allowed")
        reject(new Error("Доступ до мікрофона заборонено"));
      else reject(new Error(event.error));
    };

    rec.onend = () => {
      // continuous=true може зупинитись — перезапускаємо
      if (!resolved) {
        setTimeout(() => {
          if (!resolved) {
            try {
              rec.start();
            } catch {
              finish();
            }
          }
        }, 100);
      }
    };

    // Початковий таймер — 7с якщо нічого не сказано
    silenceTimer = setTimeout(() => {
      if (!fullTranscript.trim()) {
        resolved = true;
        clearTimeout(maxTimeout);
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
        reject(new Error("Мову не виявлено"));
      }
    }, 7000);

    rec.start();
  });
}
