// =============================================================================
// 🔍 РОЗУМНИЙ ПОШУК ПО АКТАХ — клієнтський NLP-парсер (безкоштовно)
// =============================================================================
// Розуміє природну мову українською:
//   "акти Іваненка за зиму"   → ПІБ=Іваненк + дата=грудень-лютий
//   "масло BMW"               → робота=масло + машина=BMW
//   "несплачені цього місяця" → статус=несплачені + дата=поточний місяць
//   "гальма Toyota > 5000"   → робота=гальма + машина=Toyota + сума>5000
// =============================================================================

// ---------- Типи ----------

export interface SmartFilter {
  type:
    | "pib"
    | "phone"
    | "car"
    | "carNumber"
    | "act"
    | "date"
    | "amount"
    | "status"
    | "work"
    | "detail"
    | "text"
    | "slusar"
    | "pruimalnyk"
    | "raxunok"
    | "actDoc";
  value: string;
  /** Для date — готовий діапазон */
  dateFrom?: Date;
  dateTo?: Date;
  /** Для amount — оператор порівняння */
  amountOp?: ">=" | "<=" | "=" | ">" | "<";
  amountVal?: number;
  /** Мітка для UI-чіпа */
  label: string;
}

// ---------- Словники ----------

const MONTH_MAP: Record<string, number> = {
  січень: 0,
  січня: 0,
  січ: 0,
  лютий: 1,
  лютого: 1,
  лют: 1,
  березень: 2,
  березня: 2,
  бер: 2,
  квітень: 3,
  квітня: 3,
  кві: 3,
  травень: 4,
  травня: 4,
  тра: 4,
  червень: 5,
  червня: 5,
  чер: 5,
  липень: 6,
  липня: 6,
  лип: 6,
  серпень: 7,
  серпня: 7,
  сер: 7,
  вересень: 8,
  вересня: 8,
  вер: 8,
  жовтень: 9,
  жовтня: 9,
  жов: 9,
  листопад: 10,
  листопада: 10,
  лис: 10,
  грудень: 11,
  грудня: 11,
  гру: 11,
};

const SEASON_MAP: Record<string, number[]> = {
  зима: [11, 0, 1],
  зиму: [11, 0, 1],
  зимою: [11, 0, 1],
  зимові: [11, 0, 1],
  весна: [2, 3, 4],
  весну: [2, 3, 4],
  весною: [2, 3, 4],
  весняні: [2, 3, 4],
  літо: [5, 6, 7],
  літа: [5, 6, 7],
  влітку: [5, 6, 7],
  літні: [5, 6, 7],
  осінь: [8, 9, 10],
  осені: [8, 9, 10],
  восени: [8, 9, 10],
  осінні: [8, 9, 10],
};

const CAR_BRANDS = [
  "bmw",
  "toyota",
  "volkswagen",
  "vw",
  "mercedes",
  "audi",
  "honda",
  "ford",
  "chevrolet",
  "hyundai",
  "kia",
  "nissan",
  "mazda",
  "subaru",
  "mitsubishi",
  "peugeot",
  "renault",
  "citroen",
  "fiat",
  "opel",
  "skoda",
  "seat",
  "volvo",
  "lexus",
  "infiniti",
  "jeep",
  "land rover",
  "range rover",
  "porsche",
  "daewoo",
  "suzuki",
  "dacia",
  "lada",
  "ваз",
  "заз",
  "газ",
  "уаз",
  "chery",
  "geely",
  "byd",
  "haval",
  "great wall",
  "jac",
  "faw",
  "dong feng",
  "acura",
  "alfa romeo",
  "aston martin",
  "bentley",
  "bugatti",
  "cadillac",
  "chrysler",
  "dodge",
  "ferrari",
  "genesis",
  "jaguar",
  "lamborghini",
  "lincoln",
  "maserati",
  "mini",
  "ram",
  "rolls-royce",
  "saab",
  "smart",
  "ssangyong",
  "tesla",
  "buick",
  "gmc",
  "pontiac",
  "isuzu",
  "ravon",
  "bogdan",
  "богдан",
];

const STATUS_KEYWORDS: Record<string, { label: string; statusType: string }> = {
  відкриті: { label: "Відкриті", statusType: "open" },
  відкритий: { label: "Відкриті", statusType: "open" },
  відкрита: { label: "Відкриті", statusType: "open" },
  незакриті: { label: "Відкриті", statusType: "open" },
  незакритий: { label: "Відкриті", statusType: "open" },
  "в роботі": { label: "В роботі", statusType: "open" },

  закриті: { label: "Закриті", statusType: "closed" },
  закритий: { label: "Закриті", statusType: "closed" },
  закрита: { label: "Закриті", statusType: "closed" },
  завершені: { label: "Закриті", statusType: "closed" },
  завершений: { label: "Закриті", statusType: "closed" },

  несплачені: { label: "Несплачені", statusType: "unpaid" },
  несплачений: { label: "Несплачені", statusType: "unpaid" },
  несплачена: { label: "Несплачені", statusType: "unpaid" },
  "без оплати": { label: "Несплачені", statusType: "unpaid" },
  неоплачені: { label: "Несплачені", statusType: "unpaid" },

  сплачені: { label: "Сплачені", statusType: "paid" },
  сплачений: { label: "Сплачені", statusType: "paid" },
  оплачені: { label: "Сплачені", statusType: "paid" },
  оплачений: { label: "Сплачені", statusType: "paid" },

  "з авансом": { label: "З авансом", statusType: "withAdvance" },
  авансовані: { label: "З авансом", statusType: "withAdvance" },
  аванс: { label: "З авансом", statusType: "withAdvance" },

  "зі знижкою": { label: "Зі знижкою", statusType: "withDiscount" },
  знижка: { label: "Зі знижкою", statusType: "withDiscount" },
};

// Шаблони українських прізвищ (суфікси)
const SURNAME_SUFFIXES = [
  "енко",
  "ченко",
  "овський",
  "евський",
  "івський",
  "ської",
  "ський",
  "ська",
  "ович",
  "евич",
  "ейчук",
  "авець",
  "евець",
  "івець",
  "ець",
  "ов",
  "ев",
  "єв",
  "ів",
  "ук",
  "юк",
  "чук",
  "ко",
  "як",
  "ак",
  "ик",
  "ін",
  "він",
  "ий",
  "ій",
];

// «Шумові» слова, які видаляємо
const NOISE_WORDS = new Set([
  "акти",
  "акт",
  "актів",
  "за",
  "по",
  "від",
  "до",
  "на",
  "в",
  "у",
  "із",
  "зі",
  "з",
  "та",
  "і",
  "й",
  "або",
  "де",
  "як",
  "показати",
  "покажи",
  "знайти",
  "знайди",
  "шукати",
  "шукай",
  "пошук",
  "фільтр",
  "фільтруй",
  "вибрати",
  "всі",
  "все",
  "усі",
]);

// ---------- Головна функція парсингу ----------

export function parseSmartSearch(input: string): SmartFilter[] {
  if (!input || !input.trim()) return [];

  const raw = input.trim();
  const filters: SmartFilter[] = [];

  // 0) Якщо це класичний key:value → повертаємо порожній масив (fallback на старий парсер)
  if (/^[а-яіїєґa-z]+:[\S]+$/i.test(raw)) return [];

  let remaining = raw;

  // 1) Спеціальні префікси СФ- / ОУ-
  remaining = extractSpecialPrefixes(remaining, filters);

  // 1.5) Префікси слюсар: / приймальник:
  remaining = extractPersonPrefixes(remaining, filters);

  // 2) Номер акту (#123 або "акт 123")
  remaining = extractActNumber(remaining, filters);

  // 3) Суми (>5000, <1000, >=3000, від 1000, до 5000, більше 2000, "сума 5000")
  remaining = extractAmount(remaining, filters);

  // 4) Дати та періоди
  remaining = extractDates(remaining, filters);

  // 5) Статуси (відкриті, закриті, несплачені, з авансом, зі знижкою)
  remaining = extractStatuses(remaining, filters);

  // 6) Марки авто
  remaining = extractCarBrands(remaining, filters);

  // 7) Номер авто (АА1234ВВ, AA 1234 BB)
  remaining = extractCarNumber(remaining, filters);

  // 8) Телефон
  remaining = extractPhone(remaining, filters);

  // 9) Прізвище (українські паттерни)
  // 10) Залишок → текстовий пошук по всіх полях
  extractRemainingTokens(remaining, filters);

  return filters;
}

// ---------- Видобувачі (extractors) ----------

function extractSpecialPrefixes(text: string, filters: SmartFilter[]): string {
  // СФ-123 або ОУ-456
  return text.replace(/\b(СФ|ОУ)-(\d+)/gi, (_match, prefix, num) => {
    const p = prefix.toUpperCase();
    filters.push({
      type: p === "СФ" ? "raxunok" : "actDoc",
      value: num,
      label: `${p}-${num}`,
    });
    return "";
  });
}

/**
 * Витягує префікси "слюсар:Ім'я" та "приймальник:Ім'я"
 * Підтримує формати: слюсар:Петренко, слюсар: Петренко, слюсар Петренко
 */
function extractPersonPrefixes(text: string, filters: SmartFilter[]): string {
  // Формат з двокрапкою: слюсар:Петренко або слюсар: Петренко
  let result = text.replace(
    /(?:слюсар[яьіу]?|механік[аіу]?)\s*:\s*(\S+)/gi,
    (_match, name) => {
      filters.push({
        type: "slusar",
        value: name,
        label: `Слюсар: ${name}`,
      });
      return "";
    },
  );

  result = result.replace(
    /(?:приймальник[аіу]?)\s*:\s*(\S+)/gi,
    (_match, name) => {
      filters.push({
        type: "pruimalnyk",
        value: name,
        label: `Приймальник: ${name}`,
      });
      return "";
    },
  );

  return result;
}

function extractActNumber(text: string, filters: SmartFilter[]): string {
  // #123 або "акт 123" або "акт №123"
  let result = text.replace(/#(\d+)/g, (_m, num) => {
    filters.push({ type: "act", value: num, label: `Акт #${num}` });
    return "";
  });
  result = result.replace(/\bакт(?:у|і|ів)?\s*(?:№\s*)?(\d+)/gi, (_m, num) => {
    filters.push({ type: "act", value: num, label: `Акт #${num}` });
    return "";
  });
  return result;
}

function extractAmount(text: string, filters: SmartFilter[]): string {
  let result = text;

  // ">5000", ">=5000", "<5000", "<=5000", "=5000"
  result = result.replace(/(>=?|<=?|=)\s*(\d+(?:[.,]\d+)?)/g, (_m, op, num) => {
    const val = parseFloat(num.replace(",", "."));
    filters.push({
      type: "amount",
      value: `${op}${val}`,
      amountOp: op as SmartFilter["amountOp"],
      amountVal: val,
      label: `Сума ${op} ${val}`,
    });
    return "";
  });

  // "від 1000" / "від 1000 до 5000"
  result = result.replace(
    /\bвід\s+(\d+(?:[.,]\d+)?)\s*(?:до\s+(\d+(?:[.,]\d+)?))?\b/gi,
    (_m, from, to) => {
      const fromVal = parseFloat(from.replace(",", "."));
      if (to) {
        const toVal = parseFloat(to.replace(",", "."));
        filters.push({
          type: "amount",
          value: `>=${fromVal}`,
          amountOp: ">=",
          amountVal: fromVal,
          label: `Сума від ${fromVal}`,
        });
        filters.push({
          type: "amount",
          value: `<=${toVal}`,
          amountOp: "<=",
          amountVal: toVal,
          label: `до ${toVal}`,
        });
      } else {
        filters.push({
          type: "amount",
          value: `>=${fromVal}`,
          amountOp: ">=",
          amountVal: fromVal,
          label: `Сума від ${fromVal}`,
        });
      }
      return "";
    },
  );

  // "до 5000" (standalone)
  result = result.replace(/\bдо\s+(\d+(?:[.,]\d+)?)\b/gi, (_m, num) => {
    const val = parseFloat(num.replace(",", "."));
    // Перевіряємо, що це не дата "до"
    if (val > 31) {
      filters.push({
        type: "amount",
        value: `<=${val}`,
        amountOp: "<=",
        amountVal: val,
        label: `Сума до ${val}`,
      });
      return "";
    }
    return _m; // залишаємо
  });

  // "більше 2000", "менше 1000", "дорожче 3000", "дешевше 500"
  result = result.replace(
    /\b(більше|понад|дорожче|вище)\s+(\d+(?:[.,]\d+)?)\b/gi,
    (_m, _word, num) => {
      const val = parseFloat(num.replace(",", "."));
      filters.push({
        type: "amount",
        value: `>=${val}`,
        amountOp: ">=",
        amountVal: val,
        label: `Сума > ${val}`,
      });
      return "";
    },
  );

  result = result.replace(
    /\b(менше|дешевше|нижче)\s+(\d+(?:[.,]\d+)?)\b/gi,
    (_m, _word, num) => {
      const val = parseFloat(num.replace(",", "."));
      filters.push({
        type: "amount",
        value: `<=${val}`,
        amountOp: "<=",
        amountVal: val,
        label: `Сума < ${val}`,
      });
      return "";
    },
  );

  // "сума 5000" без оператора → точна
  result = result.replace(/\bсум[аиу]\s+(\d+(?:[.,]\d+)?)\b/gi, (_m, num) => {
    const val = parseFloat(num.replace(",", "."));
    filters.push({
      type: "amount",
      value: `>=${val}`,
      amountOp: ">=",
      amountVal: val,
      label: `Сума ≥ ${val}`,
    });
    return "";
  });

  return result;
}

function extractDates(text: string, filters: SmartFilter[]): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let result = text;

  // --- Конкретна дата DD.MM.YY або DD.MM.YYYY ---
  result = result.replace(
    /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/g,
    (_m, d, m, y) => {
      let fullYear = parseInt(y, 10);
      if (fullYear < 100) fullYear += 2000;
      const from = new Date(
        fullYear,
        parseInt(m, 10) - 1,
        parseInt(d, 10),
        0,
        0,
        0,
      );
      const to = new Date(
        fullYear,
        parseInt(m, 10) - 1,
        parseInt(d, 10),
        23,
        59,
        59,
      );
      filters.push({
        type: "date",
        value: _m,
        dateFrom: from,
        dateTo: to,
        label: `Дата ${_m}`,
      });
      return "";
    },
  );

  // --- "сьогодні" ---
  result = result.replace(/\bсьогодн[іi]\b/gi, () => {
    const from = new Date(year, month, now.getDate(), 0, 0, 0);
    const to = new Date(year, month, now.getDate(), 23, 59, 59);
    filters.push({
      type: "date",
      value: "сьогодні",
      dateFrom: from,
      dateTo: to,
      label: "Сьогодні",
    });
    return "";
  });

  // --- "вчора" ---
  result = result.replace(/\bвчора\b/gi, () => {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    filters.push({
      type: "date",
      value: "вчора",
      dateFrom: from,
      dateTo: to,
      label: "Вчора",
    });
    return "";
  });

  // --- "цього тижня" / "цей тиждень" / "тиждень" ---
  result = result.replace(
    /\b(?:цього\s+тижн[яю]|цей\s+тиждень|(?:за\s+)?тиждень)\b/gi,
    () => {
      const dayOfWeek = now.getDay() || 7; // Пн=1
      const monday = new Date(now);
      monday.setDate(now.getDate() - dayOfWeek + 1);
      const from = new Date(
        monday.getFullYear(),
        monday.getMonth(),
        monday.getDate(),
        0,
        0,
        0,
      );
      const to = new Date(year, month, now.getDate(), 23, 59, 59);
      filters.push({
        type: "date",
        value: "тиждень",
        dateFrom: from,
        dateTo: to,
        label: "Цього тижня",
      });
      return "";
    },
  );

  // --- "минулого тижня" ---
  result = result.replace(/\bминулого\s+тижн[яю]\b/gi, () => {
    const dayOfWeek = now.getDay() || 7;
    const thisMon = new Date(now);
    thisMon.setDate(now.getDate() - dayOfWeek + 1);
    const prevMon = new Date(thisMon);
    prevMon.setDate(thisMon.getDate() - 7);
    const prevSun = new Date(thisMon);
    prevSun.setDate(thisMon.getDate() - 1);
    const from = new Date(
      prevMon.getFullYear(),
      prevMon.getMonth(),
      prevMon.getDate(),
      0,
      0,
      0,
    );
    const to = new Date(
      prevSun.getFullYear(),
      prevSun.getMonth(),
      prevSun.getDate(),
      23,
      59,
      59,
    );
    filters.push({
      type: "date",
      value: "минулий тиждень",
      dateFrom: from,
      dateTo: to,
      label: "Минулого тижня",
    });
    return "";
  });

  // --- "цього місяця" / "цей місяць" ---
  result = result.replace(/\b(?:цього\s+місяц[яю]|цей\s+місяць)\b/gi, () => {
    const from = new Date(year, month, 1, 0, 0, 0);
    const to = new Date(year, month, now.getDate(), 23, 59, 59);
    filters.push({
      type: "date",
      value: "цього місяця",
      dateFrom: from,
      dateTo: to,
      label: "Цього місяця",
    });
    return "";
  });

  // --- "минулого місяця" ---
  result = result.replace(/\bминулого\s+місяц[яю]\b/gi, () => {
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const from = new Date(prevYear, prevMonth, 1, 0, 0, 0);
    const to = new Date(prevYear, prevMonth + 1, 0, 23, 59, 59);
    filters.push({
      type: "date",
      value: "минулого місяця",
      dateFrom: from,
      dateTo: to,
      label: "Минулого місяця",
    });
    return "";
  });

  // --- "цього року" ---
  result = result.replace(/\b(?:цього\s+р[оі]ку|цей\s+рік)\b/gi, () => {
    const from = new Date(year, 0, 1, 0, 0, 0);
    const to = new Date(year, month, now.getDate(), 23, 59, 59);
    filters.push({
      type: "date",
      value: "цього року",
      dateFrom: from,
      dateTo: to,
      label: "Цього року",
    });
    return "";
  });

  // --- "минулого року" ---
  result = result.replace(/\bминулого\s+р[оі]ку\b/gi, () => {
    const from = new Date(year - 1, 0, 1, 0, 0, 0);
    const to = new Date(year - 1, 11, 31, 23, 59, 59);
    filters.push({
      type: "date",
      value: "минулого року",
      dateFrom: from,
      dateTo: to,
      label: "Минулого року",
    });
    return "";
  });

  // --- Сезони: "за зиму", "зимою", "зимові" ---
  const seasonPattern = Object.keys(SEASON_MAP).join("|");
  const seasonRe = new RegExp(`\\b(?:за\\s+)?(${seasonPattern})\\b`, "gi");
  result = result.replace(seasonRe, (_m, season) => {
    const key = season.toLowerCase();
    const months = SEASON_MAP[key];
    if (!months) return _m;

    // Визначаємо рік для сезону
    const seasonLabel = key.charAt(0).toUpperCase() + key.slice(1);
    const [m0, , m2] = months;
    let startYear = year;
    let endYear = year;

    // Для зими: грудень попереднього року → лютий поточного
    if (m0 === 11 && m2 === 1) {
      if (month < 3) {
        startYear = year - 1;
        endYear = year;
      } else {
        startYear = year;
        endYear = year + 1;
      }
    }

    const from = new Date(startYear, m0, 1, 0, 0, 0);
    const lastMonth = m0 > m2 ? m2 : m2; // для зими m2=1, для решти — порядковий
    const to = new Date(endYear, lastMonth + 1, 0, 23, 59, 59);

    filters.push({
      type: "date",
      value: key,
      dateFrom: from,
      dateTo: to,
      label: seasonLabel,
    });
    return "";
  });

  // --- Конкретний місяць: "за лютий", "у березні", "червень" ---
  const monthPattern = Object.keys(MONTH_MAP).join("|");
  const monthRe = new RegExp(`\\b(?:за|у|в|на)?\\s*(${monthPattern})\\b`, "gi");
  result = result.replace(monthRe, (_m, monthWord) => {
    const monthIndex = MONTH_MAP[monthWord.toLowerCase()];
    if (monthIndex === undefined) return _m;

    // Перевіряємо, що ще не додали такий місяць (міг бути частиною сезону)
    const alreadyHasDate = filters.some(
      (f) => f.type === "date" && f.dateFrom?.getMonth() === monthIndex,
    );
    if (alreadyHasDate) return "";

    const targetYear = monthIndex > month ? year - 1 : year;
    const from = new Date(targetYear, monthIndex, 1, 0, 0, 0);
    const to = new Date(targetYear, monthIndex + 1, 0, 23, 59, 59);

    const monthNames = [
      "Січень",
      "Лютий",
      "Березень",
      "Квітень",
      "Травень",
      "Червень",
      "Липень",
      "Серпень",
      "Вересень",
      "Жовтень",
      "Листопад",
      "Грудень",
    ];

    filters.push({
      type: "date",
      value: monthWord.toLowerCase(),
      dateFrom: from,
      dateTo: to,
      label: monthNames[monthIndex],
    });
    return "";
  });

  return result;
}

function extractStatuses(text: string, filters: SmartFilter[]): string {
  let result = text;

  // Спочатку двослівні фрази
  const twoWordStatuses = Object.keys(STATUS_KEYWORDS).filter((k) =>
    k.includes(" "),
  );
  for (const phrase of twoWordStatuses) {
    const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
    if (re.test(result)) {
      const info = STATUS_KEYWORDS[phrase];
      filters.push({
        type: "status",
        value: info.statusType,
        label: info.label,
      });
      result = result.replace(re, "");
    }
  }

  // Потім однослівні
  const oneWordStatuses = Object.keys(STATUS_KEYWORDS).filter(
    (k) => !k.includes(" "),
  );
  for (const word of oneWordStatuses) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, "gi");
    if (re.test(result)) {
      // Не дублюємо однаковий statusType
      const info = STATUS_KEYWORDS[word];
      if (
        !filters.some((f) => f.type === "status" && f.value === info.statusType)
      ) {
        filters.push({
          type: "status",
          value: info.statusType,
          label: info.label,
        });
      }
      result = result.replace(re, "");
    }
  }

  return result;
}

function extractCarBrands(text: string, filters: SmartFilter[]): string {
  let result = text;

  for (const brand of CAR_BRANDS) {
    const re = new RegExp(`\\b${escapeRegex(brand)}\\b`, "gi");
    const match = result.match(re);
    if (match) {
      filters.push({
        type: "car",
        value: match[0],
        label: `Авто: ${match[0]}`,
      });
      result = result.replace(re, "");
    }
  }

  return result;
}

function extractCarNumber(text: string, filters: SmartFilter[]): string {
  // Українські номери: АА1234ВВ, AA 1234 BB, ВС1234АН тощо
  return text.replace(
    /\b([А-ЯA-Z]{2})\s*(\d{4})\s*([А-ЯA-Z]{2})\b/gi,
    (_m, p1, num, p2) => {
      const plate = `${p1.toUpperCase()}${num}${p2.toUpperCase()}`;
      filters.push({
        type: "carNumber",
        value: plate,
        label: `Номер: ${plate}`,
      });
      return "";
    },
  );
}

function extractPhone(text: string, filters: SmartFilter[]): string {
  // +380..., 0XX..., (0XX)...
  return text.replace(
    /(?:\+?38)?0\d{9}|\(\d{3}\)\s*\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
    (match) => {
      const phone = match.replace(/[\s\(\)\-]/g, "");
      filters.push({
        type: "phone",
        value: phone,
        label: `Тел: ${match.trim()}`,
      });
      return "";
    },
  );
}

function extractRemainingTokens(text: string, filters: SmartFilter[]): void {
  const tokens = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    const lower = token.toLowerCase();

    // Пропускаємо шумові слова
    if (NOISE_WORDS.has(lower)) continue;

    // Чисте число → можливо номер акту
    if (/^\d+$/.test(token) && !filters.some((f) => f.type === "act")) {
      if (parseInt(token, 10) < 100000) {
        filters.push({ type: "act", value: token, label: `Акт #${token}` });
        continue;
      }
    }

    // Перевіряємо чи схоже на прізвище
    if (looksLikeSurname(token)) {
      filters.push({ type: "pib", value: token, label: `ПІБ: ${token}` });
      continue;
    }

    // Інакше → текстовий пошук по всіх полях (роботи, деталі, ПІБ, авто…)
    filters.push({ type: "text", value: token, label: token });
  }
}

function looksLikeSurname(word: string): boolean {
  if (word.length < 3) return false;
  const lower = word.toLowerCase();

  // Перша буква велика → ймовірно прізвище (пошук по ПІБ клієнта)
  // Якщо з малої → НЕ прізвище → буде "text" пошук по всіх полях
  const isCapitalized =
    word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
  if (!isCapitalized) return false;

  // Перевіряємо суфікси прізвищ
  for (const suffix of SURNAME_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 1) {
      const isBrand = CAR_BRANDS.some((b) => b.toLowerCase() === lower);
      if (!isBrand) return true;
    }
  }

  // Якщо з великої букви і довжина >= 4 і це не марка авто
  if (word.length >= 4) {
    const isBrand = CAR_BRANDS.some((b) => b.toLowerCase() === lower);
    if (!isBrand) return true;
  }

  return false;
}

// ---------- Застосування фільтрів до актів ----------

export function applySmartFilters(
  acts: any[],
  filters: SmartFilter[],
  clients: any[],
  cars: any[],
  helpers: {
    safeParseJSON: (v: any) => any;
    getClientInfo: (act: any, clients: any[]) => { pib: string; phone: string };
    getCarInfo: (act: any, cars: any[]) => { number: string; name: string };
    getActAmount: (act: any) => number;
    getActDateAsDate: (act: any) => Date | null;
    isActClosed: (act: any) => boolean;
    getActDiscount: (act: any) => number;
  },
): any[] {
  if (!filters.length) return acts;

  return acts.filter((act) => {
    return filters.every((filter) =>
      matchFilter(act, filter, clients, cars, helpers),
    );
  });
}

function matchFilter(
  act: any,
  filter: SmartFilter,
  clients: any[],
  cars: any[],
  h: {
    safeParseJSON: (v: any) => any;
    getClientInfo: (act: any, clients: any[]) => { pib: string; phone: string };
    getCarInfo: (act: any, cars: any[]) => { number: string; name: string };
    getActAmount: (act: any) => number;
    getActDateAsDate: (act: any) => Date | null;
    isActClosed: (act: any) => boolean;
    getActDiscount: (act: any) => number;
  },
): boolean {
  switch (filter.type) {
    case "act":
      return act.act_id?.toString().includes(filter.value);

    case "pib": {
      const { pib } = h.getClientInfo(act, clients);
      return pib.toLowerCase().includes(filter.value.toLowerCase());
    }

    case "phone": {
      const { phone } = h.getClientInfo(act, clients);
      return phone.includes(filter.value);
    }

    case "car": {
      const { name } = h.getCarInfo(act, cars);
      return name.toLowerCase().includes(filter.value.toLowerCase());
    }

    case "carNumber": {
      const { number } = h.getCarInfo(act, cars);
      return number
        .replace(/\s/g, "")
        .toUpperCase()
        .includes(filter.value.toUpperCase());
    }

    case "date": {
      const actDate = h.getActDateAsDate(act);
      if (!actDate || !filter.dateFrom || !filter.dateTo) return false;
      return actDate >= filter.dateFrom && actDate <= filter.dateTo;
    }

    case "amount": {
      const amount = h.getActAmount(act);
      if (!filter.amountOp || filter.amountVal === undefined) return false;
      switch (filter.amountOp) {
        case ">=":
          return amount >= filter.amountVal;
        case "<=":
          return amount <= filter.amountVal;
        case ">":
          return amount > filter.amountVal;
        case "<":
          return amount < filter.amountVal;
        case "=":
          return amount === filter.amountVal;
        default:
          return true;
      }
    }

    case "status": {
      const closed = h.isActClosed(act);
      const actData = h.safeParseJSON(act.info || act.data || act.details);
      switch (filter.value) {
        case "open":
          return !closed;
        case "closed":
          return closed;
        case "unpaid":
          return !act.rosraxovano;
        case "paid":
          return !!act.rosraxovano;
        case "withAdvance":
          return Number(act.avans) > 0;
        case "withDiscount": {
          const discount = Number(actData?.["Знижка"] || 0);
          return discount > 0;
        }
        default:
          return true;
      }
    }

    case "work": {
      const actData = h.safeParseJSON(act.info || act.data || act.details);
      const works = Array.isArray(actData?.["Роботи"]) ? actData["Роботи"] : [];
      return works.some((w: any) =>
        (w["Робота"] || w["Назва"] || "")
          .toLowerCase()
          .includes(filter.value.toLowerCase()),
      );
    }

    case "detail": {
      const actData = h.safeParseJSON(act.info || act.data || act.details);
      const details = Array.isArray(actData?.["Деталі"])
        ? actData["Деталі"]
        : [];
      return details.some((d: any) =>
        (d["Деталь"] || d["Назва"] || "")
          .toLowerCase()
          .includes(filter.value.toLowerCase()),
      );
    }

    case "raxunok":
      return (act.contrAgent_raxunok || "").toString().includes(filter.value);

    case "actDoc":
      return (act.contrAgent_act || "").toString().includes(filter.value);

    case "slusar": {
      const actData = h.safeParseJSON(act.info || act.data || act.details);
      const works = Array.isArray(actData?.["Роботи"]) ? actData["Роботи"] : [];
      return works.some((w: any) =>
        (w["Слюсар"] || "").toLowerCase().includes(filter.value.toLowerCase()),
      );
    }

    case "pruimalnyk":
      return (act.pruimalnyk || "")
        .toLowerCase()
        .includes(filter.value.toLowerCase());

    case "text": {
      // Універсальний пошук по всіх полях включаючи роботи/деталі
      const val = filter.value.toLowerCase();
      const { pib, phone } = h.getClientInfo(act, clients);
      const { number: carNum, name: carName } = h.getCarInfo(act, cars);
      const actData = h.safeParseJSON(act.info || act.data || act.details);
      const works = Array.isArray(actData?.["Роботи"]) ? actData["Роботи"] : [];
      const details = Array.isArray(actData?.["Деталі"])
        ? actData["Деталі"]
        : [];

      // ПІБ, телефон, авто, номер авто, ID акту
      if (pib.toLowerCase().includes(val)) return true;
      if (phone.includes(filter.value)) return true;
      if (carNum.toLowerCase().includes(val)) return true;
      if (carName.toLowerCase().includes(val)) return true;
      if (act.act_id?.toString().includes(filter.value)) return true;

      // Роботи
      if (
        works.some((w: any) =>
          (w["Робота"] || w["Назва"] || "").toLowerCase().includes(val),
        )
      )
        return true;

      // Деталі
      if (
        details.some((d: any) =>
          (d["Деталь"] || d["Назва"] || "").toLowerCase().includes(val),
        )
      )
        return true;

      // Слюсар
      if (
        works.some((w: any) => (w["Слюсар"] || "").toLowerCase().includes(val))
      )
        return true;

      // Приймальник
      if ((act.pruimalnyk || "").toLowerCase().includes(val)) return true;

      // Рекомендації
      if ((actData?.["Рекомендації"] || "").toLowerCase().includes(val))
        return true;

      // Причина звернення
      if ((actData?.["Причина звернення"] || "").toLowerCase().includes(val))
        return true;

      // Примітки
      if ((actData?.["Примітки"] || "").toLowerCase().includes(val))
        return true;

      // Рахунки/акти документів
      if ((act.contrAgent_raxunok || "").toString().includes(filter.value))
        return true;
      if ((act.contrAgent_act || "").toString().includes(filter.value))
        return true;

      return false;
    }

    default:
      return true;
  }
}

// ---------- Утиліти ----------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- Формування підказки для UI ----------

export function getSmartSearchHint(filters: SmartFilter[]): string {
  if (!filters.length) return "";
  return filters.map((f) => f.label).join(" • ");
}
