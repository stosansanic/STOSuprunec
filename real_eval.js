
// src/ts/roboha/ai/aiChat.ts
// 🤖 AI-Чат Асистент "Атлас" — Google Gemini + Groq + аналіз даних СТО
// 🔧 Підтримка: Function Calling (query_database, search_internet, call_rpc, get_analytics), Google Search Grounding

import { supabase }
function parseClientDataFromAI(text) {
  const result = {};

  // Універсальний роздільник між полем і значенням (допускає текст у дужках типу "(P.1)" перед двокрапкою)
  const SEP = `(?:\\s*\\([^)]+\\))?\\s*[:：—–\\-=]\\s*`;
  const LABEL_SEP = `(?:\\s*\\([^)]+\\))?\\s*(?:[:：—–\\-=]|\\s)\\s*`;

  const extractTechCodeLine = (codePattern) => {
    // Формат 1: код на початку рядка — "C.1.1: КОЛЕСНИК" або "* C.1.1 КОЛЕСНИК"
    let rx = new RegExp(
      `(?:^|\\n)\\s*[*•\\-–—]?\\s*(?:${codePattern})\\s*(?:\\([^)]+\\))?\\s*[:：—–\\-=]?\\s*([^\\n]+)`,
      "im",
    );
    let m = text.match(rx);
    if (m?.[1])
      return m[1]
        .trim()
        .replace(/^\*+|\*+$/g, "")
        .trim();

    // Формат 2: код у дужках після мітки — "Прізвище або організація (C.1.1): КОЛЕСНИК"
    rx = new RegExp(
      `(?:^|\\n)[^\\n]*\\(\\s*(?:${codePattern})\\s*\\)\\s*[:：—–\\-=]\\s*([^\\n]+)`,
      "im",
    );
    m = text.match(rx);
    if (!m?.[1]) return undefined;
    return m[1]
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .trim();
  };

  const extractByLabels = (
    labels[],
    valuePattern = "(.+)",
  ) => {
    if (!labels.length) return undefined;
    const rx = new RegExp(
      `(?:^|\\n)\\s*[*•\\-–—]?\\s*(?:${labels.join("|")})${LABEL_SEP}${valuePattern}`,
      "im",
    );
    const m = text.match(rx);
    if (!m?.[1]) return undefined;
    return m[1]
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .trim();
  };

  const c11OwnerSurname = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*1|c11`);
  const c12OwnerName = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*2|c12`);
  const c13OwnerAddress = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*3|c13`);
  const b2ManufactureYear = extractTechCodeLine(`b\\.?\\s*2|b2`);
  const p1EngineVolume = extractTechCodeLine(`p\\.?\\s*1|p1`);
  const p2MaxPower = extractTechCodeLine(`p\\.?\\s*2|p2`);
  const ownerByKeyword = extractByLabels([
    `п[іi][бb](?:\\s*власника)?`,
    `власник(?:\\s*(?:тз|транспортного\\s*засобу))?`,
    `прізвище\\s*(?:або\\s*найменування\\s*)?(?:власника|особи)`,
    `(?:holder|owner|registered\\s*owner)(?:\\s*name)?`,
  ]);
  const yearByKeyword = extractByLabels(
    [
      `рік\\s*(?:випуску?|виробництва?)`,
      `year\\s*(?:of\\s*)?(?:manufacture|production|make)`,
    ],
    `(\\d{4})`,
  );
  const engineByKeyword = extractByLabels(
    [
      `об['ʼ’]?(?:є|е)?м\\s*(?:двигуна?|циліндрів)?`,
      `робочий\\s*об['ʼ’]?(?:є|е)?м`,
      `(?:engine\\s*(?:capacity|volume|displacement|size)|displacement)`,
    ],
    `(\\d[\\d.,]*)`,
  );
  const modelByKeyword = extractByLabels([
    `модель(?:\\s*(?:тз|авто|автомобіля|транспортного\\s*засобу))?`,
    `комерційний\\s*опис`,
    `commercial\\s*description`,
    `type`,
  ]);
  const vinByKeyword = extractByLabels(
    [
      `vin(?:\\s*код)?`,
      `він[\\s-]?код`,
      `ідентифікаційний\\s*номер\\s*(?:транспортного\\s*засобу|кузова|шасі|рами)?`,
      `номер\\s*(?:кузова|шасі|рами)`,
      `vehicle\\s*identification\\s*number`,
      `chassis\\s*number`,
    ],
    `([A-ZА-ЯІЇЄҐ0-9\\s\\-]{10,40})`,
  );
  const fuelByKeyword = extractByLabels([
    `тип\\s*(?:пального|палива)`,
    `вид\\s*(?:пального|палива)`,
    `пальне`,
    `паливо`,
    `fuel\\s*type`,
    `type\\s*of\\s*fuel`,
  ]);
  const plateByKeyword = extractByLabels(
    [
      `номер\\s*авто`,
      `держ\\.?\\s*номер`,
      `реєстр(?:аційний)?\\s*номер`,
      `номерний\\s*знак`,
      `license\\s*plate`,
      `plate\\s*(?:number|no\\.?)`,
      `registration\\s*(?:number|no\\.?)`,
    ],
    `([A-ZА-ЯІЇЄҐ0-9\\s\\-]{5,20})`,
  );

  const normalizeVinCandidate = (
    raw,
  ) => {
    if (!raw) return undefined;
    const cyrToLatMap: Record<string, string> = {
      А: "A",
      В: "B",
      С: "C",
      Е: "E",
      Н: "H",
      К: "K",
      М: "M",
      О: "O",
      Р: "P",
      Т: "T",
      Х: "X",
      І: "I",
      Ї: "I",
      Є: "E",
      Ґ: "G",
    };
    let s = raw.toUpperCase();
    s = s
      .split("")
      .map((ch) => cyrToLatMap[ch] || ch)
      .join("");
    s = s.replace(/[^A-Z0-9]/g, "");
    // У VIN символи I/O/Q не використовуються, тож це часті OCR-помилки для 1/0
    s = s.replace(/I/g, "1").replace(/[OQ]/g, "0");

    if (s.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(s)) return s;
    const chunk = s.match(/[A-HJ-NPR-Z0-9]{17}/);
    return chunk?.[0];
  };

  const normalizePlateCandidate = (
    raw,
  ) => {
    if (!raw) return undefined;
    const mapToLatin: Record<string, string> = {
      А: "A",
      В: "B",
      С: "C",
      Е: "E",
      Н: "H",
      І: "I",
      К: "K",
      М: "M",
      О: "O",
      Р: "P",
      Т: "T",
      Х: "X",
      Y: "Y",
    };

    const cleaned = raw
      .toUpperCase()
      .split("")
      .map((ch) => mapToLatin[ch] || ch)
      .join("")
      .replace(/[^A-Z0-9]/g, "");

    // UA формат: AA1234BB
    if (/^[A-Z]{2}\d{4}[A-Z]{2}$/.test(cleaned)) return cleaned;

    // Витягуємо номер з довшого OCR-рядка
    const embedded = cleaned.match(/[A-Z]{2}\d{4}[A-Z]{2}/);
    return embedded?.[0];
  };

  // ── ПІБ / Власник / Прізвище / Name / Surname / C.1.1 + C.1.2 ──
  {
    // Пріоритет 1: C.1.1 + C.1.2 із технічного паспорта
    const pibFromCodes =
      [c11OwnerSurname, c12OwnerName].filter(Boolean).join(" ").trim() ||
      undefined;

    // Пріоритет 3: три слова de facto ПІБ — Прізвище Ім'я По-батькові
    // Третє слово ОБОВ'ЯЗКОВО з суфіксом по батькові (-ович/-івна/-євна тощо)
    const threeWordPib = (() => {
      const rx =
        /\b([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]{1,})\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]{1,})\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]+(?:[оО][вВ][иИіі][чЧ]|[іІ][вВ][нН][аА]|[єЄ][вВ][нН][аА]|[оО][вВ][нН][аА]|[аА][вВ][нН][аА]))\b/;
      const m = text.match(rx);
      return m ? `${m[1]} ${m[2]} ${m[3]}` : undefined;
    })();

    // Пріоритет 4: generic extractField (найменш надійний)
    const pibFromExtract = extractField(text, [
      new RegExp(`п[іi][бb]${SEP}(.+)`, "im"),
      new RegExp(
        `(?:прізвище|surname)(?:\\s*(?:та|і|,)\\s*(?:ім['ʼ\u2019]?я|name))?${SEP}(.+)`,
        "im",
      ),
      new RegExp(`власник${SEP}(.+)`, "im"),
      new RegExp(`клієнт${SEP}(.+)`, "im"),
      new RegExp(`(?:ім['ʼ\u2019]?я|given\\s*name|name)${SEP}(.+)`, "im"),
      new RegExp(`(?:по\\s*батькові|отчество|patronymic)${SEP}(.+)`, "im"),
      new RegExp(`(?:c\\.?\\s*1\\.?\\s*1)${SEP}(.+)`, "im"),
      new RegExp(`(?:c\\.?\\s*1\\.?\\s*2)${SEP}(.+)`, "im"),
      new RegExp(`(?:holder|owner|registered\\s*owner)${SEP}(.+)`, "im"),
    ]);

    result.pib =
      pibFromCodes || ownerByKeyword || threeWordPib || pibFromExtract;
  }

  // ── Телефон ──
  result.phone = extractField(text, [
    new RegExp(`(?:телефон|тел\\.?|phone|mobile|моб\\.?)${SEP}(.+)`, "im"),
    new RegExp(`(?:контакт|contact)${SEP}(.+)`, "im"),
    new RegExp(`(?:номер\\s*телефон[уа]?)${SEP}(.+)`, "im"),
  ]);
  if (!result.phone) {
    const phoneRx = /(\+?\d[\d\s\-()]{8,14}\d)/;
    const phoneMatch = text.match(phoneRx);
    if (phoneMatch) result.phone = phoneMatch[1].trim();
  }

  // ── Модель ──
  result.model =
    modelByKeyword ||
    extractField(text, [
      new RegExp(`модель${SEP}(.+)`, "im"),
      new RegExp(`model${SEP}(.+)`, "im"),
      new RegExp(`(?:d\\.?\\s*3|d3)${SEP}(.+)`, "im"), // D.3 — модель у техпаспорті
    ]);
  // Витягуємо тип авто з моделі якщо є в дужках: "E 200 K (ЛЕГКОВИЙ СЕДАН-В)"
  if (result.model) {
    const typeInParens = result.model.match(/\(([^)]+)\)/);
    if (typeInParens) {
      if (!result.carType) {
        result.carType = toCamelCasePIB(typeInParens[1].trim());
      }
      result.model = result.model.replace(/\s*\([^)]+\)/, "").trim();
    }
  }

  // ── Марка ──
  result.brand = extractField(text, [
    new RegExp(`марка${SEP}(.+)`, "im"),
    new RegExp(`(?:make|brand|manufacturer|виробник)${SEP}(.+)`, "im"),
    new RegExp(`(?:d\\.?\\s*1|d1)${SEP}(.+)`, "im"), // D.1 — марка у техпаспорті
  ]);

  // ── Авто (марка + модель разом) ──
  result.car = extractField(text, [
    new RegExp(`авто(?:мобіль)?${SEP}(.+)`, "im"),
    new RegExp(
      `(?:транспорт(?:ний)?\\s*засіб|т\\.?\\s*з\\.?|vehicle)${SEP}(.+)`,
      "im",
    ),
    new RegExp(`(?:марка\\s*(?:та|і|\\/)\\s*модель)${SEP}(.+)`, "im"),
    new RegExp(`(?:make\\s*(?:and|\\/|&)\\s*model)${SEP}(.+)`, "im"),
    new RegExp(`(?:d\\.?\\s*2|d2)${SEP}(.+)`, "im"), // D.2 — марка+тип у техпаспорті
  ]);

  // ── Номер авто / Держ. номер / Реєстраційний номер ──
  result.carNumber = normalizePlateCandidate(
    plateByKeyword ||
      extractField(text, [
        new RegExp(
          `(?:номер\\s*авто|держ\\.?\\s*номер|реєстр(?:аційний)?\\.?\\s*номер|номерний\\s*знак|д\\.?\\s*н\\.?\\s*з\\.?|license\\s*plate|plate\\s*(?:number|no\\.?)|registration\\s*(?:number|no\\.?))${SEP}(.+)`,
          "im",
        ),
        new RegExp(
          `(?:номер)${SEP}([A-ZА-ЯІЇЄҐ]{2}\\d{4}[A-ZА-ЯІЇЄҐ]{2})`,
          "im",
        ),
        new RegExp(
          `(?:a\\b)${SEP}([A-ZА-ЯІЇЄҐ]{2}\\d{4}[A-ZА-ЯІЇЄҐ]{2}.*)`,
          "im",
        ), // поле "A" у техпаспорті
      ]),
  );
  // Резервний пошук номера авто (UA формат: AB1234CD)
  if (!result.carNumber) {
    const plateRx = /\b([A-ZА-ЯІЇЄҐ]{2}[\s-]?\d{4}[\s-]?[A-ZА-ЯІЇЄҐ]{2})\b/;
    const plateMatch = text.match(plateRx);
    if (plateMatch) {
      result.carNumber =
        normalizePlateCandidate(plateMatch[1]) ||
        plateMatch[1].replace(/[\s-]/g, "");
    }
  }

  // ── VIN / Ідентифікаційний номер / Номер кузова / E ──
  result.vin = normalizeVinCandidate(
    vinByKeyword ||
      extractField(text, [
        new RegExp(`vin\\s*[-:]?\\s*код${SEP}(.+)`, "im"),
        new RegExp(`vin${SEP}(.+)`, "im"),
        new RegExp(`він[\\s-]?код${SEP}(.+)`, "im"),
        new RegExp(
          `(?:ідентифікаційн(?:ий|а)?\\s*(?:номер|код)|номер\\s*(?:кузова|шасі|рами)|chassis(?:\\s*no\\.?)?|body\\s*no\\.?|frame\\s*no\\.?)${SEP}(.+)`,
          "im",
        ),
        new RegExp(`(?:e\\b)${SEP}([A-HJ-NPR-Z0-9]{17})`, "im"), // поле "E" у техпаспорті
      ]),
  );
  if (!result.vin) {
    const vinRx = /\b([A-HJ-NPR-Z0-9]{17})\b/;
    const vinMatch = text.match(vinRx);
    if (vinMatch) result.vin = vinMatch[1];
  }

  // ── Рік випуску / Рік виробництва / B.2 ──
  // Резервний fallback: найстаріший рік у тексті = рік виготовлення
  // (реєстрація завжди >= рік виготовлення, тому мінімум = рік з-під заводу)
  const allYearsInText = [...text.matchAll(/\b(19[7-9]\d|20[0-3]\d)\b/g)].map(
    (m) => parseInt(m[1]),
  );
  const oldestYearStr =
    allYearsInText.length > 0 ? String(Math.min(...allYearsInText)) : undefined;

  result.year =
    b2ManufactureYear?.match(/\b(19[7-9]\d|20[0-3]\d)\b/)?.[1] ||
    yearByKeyword ||
    extractField(text, [
      new RegExp(
        `(?:рік\\s*(?:випуск[у]?|вироб\\w*)?|р\\.?\\s*в\\.?|year(?:\\s*of)?(?:\\s*(?:manufacture|production|make))?)${SEP}(\\d{4})`,
        "im",
      ),
      new RegExp(`рік${SEP}(\\d{4})`, "im"),
      /(?:^|\n)\s*(?:рік\s*(?:випуску?|виробництва?)|year\s*(?:of\s*)?(?:manufacture|production|make))\s*(\d{4})\b/im,
      new RegExp(`(?:b\\.?\\s*2|b2)${SEP}(\\d{4})`, "im"), // B.2 — рік випуску (рік)
      /(?:^|\n)\s*(?:b\.?\s*2|b2)\s*(\d{4})\b/im,
      /(?:рік\s*(?:випуск[у]?|вироб\w*)?\s+)(\d{4})/im,
    ]) ||
    oldestYearStr; // якщо нічого не спрацювало — беремо найстаріший рік у тексті

  // ── Об'єм двигуна / Робочий об'єм / P.1 ──
  result.engine =
    p1EngineVolume ||
    engineByKeyword ||
    extractField(text, [
      new RegExp(
        `(?:об['ʼ]?єм\\s*(?:двигуна?)?|робочий\\s*об['ʼ]?єм|engine\\s*(?:capacity|volume|displacement|size)|displacement|p\\.?\\s*1|p1)${SEP}(.+)`,
        "im",
      ),
      /(?:^|\n)\s*(?:об['ʼ’]?(?:є|е)?м\s*(?:двигуна?|циліндрів)?|робочий\s*об['ʼ’]?(?:є|е)?м|engine\s*(?:capacity|volume|displacement|size)|displacement)\s*(\d[\d.,]*)\b/im,
      /(?:^|\n)\s*(?:p\.?\s*1|p1)\s*(\d[\d.,]*)\b/im,
      new RegExp(`двигун${SEP}(.+)`, "im"),
      new RegExp(`об['ʼ]?єм${SEP}(\\d[\\d.,]+\\s*л?)`, "im"),
    ]);
  if (result.engine) {
    result.engine = result.engine
      .replace(
        /\s*(?:см[³3]?|куб\.?\s*см|cm[³3]?|cc|л(?:ітр(?:ів)?)?)\s*/gi,
        "",
      )
      .trim();
  }

  // Якщо в об'єм помилково потрапила потужність (P.2), віддаємо пріоритет P.1
  const p1VolumeNumber = p1EngineVolume?.match(/\d[\d.,]*/)?.[0];
  const p2PowerNumber = p2MaxPower?.match(/\d[\d.,]*/)?.[0];
  const currentEngineNumber = result.engine?.match(/\d[\d.,]*/)?.[0];
  if (
    p1VolumeNumber &&
    (!currentEngineNumber || currentEngineNumber === p2PowerNumber)
  ) {
    result.engine = p1VolumeNumber.replace(/,/g, ".");
  }

  // ── Пальне / Паливо / Тип пального / P.3 ──
  result.fuel =
    fuelByKeyword ||
    extractField(text, [
      new RegExp(
        `(?:пальне|паливо|тип\\s*(?:пального|палива)|вид\\s*палив[а]?|fuel(?:\\s*type)?|p\\.?\\s*3|p3)${SEP}(.+)`,
        "im",
      ),
    ]);
  if (result.fuel) {
    result.fuel = normalizeFuel(result.fuel) || undefined;
  }
  if (!result.fuel) {
    const detected = normalizeFuel(text);
    if (detected) result.fuel = detected;
  }

  // ── Код ДВЗ / Код двигуна / P.2 ──
  result.engineCode = extractField(text, [
    new RegExp(`(?:код\\s*(?:двз|двигуна)|двз|engine\\s*code)${SEP}(.+)`, "im"),
  ]);

  // ── Джерело / Звідки ──
  result.source = extractField(text, [
    new RegExp(
      `(?:джерело|звідки|рекомендація|source|referral)${SEP}(.+)`,
      "im",
    ),
  ]);

  // ── Адреса / Місце реєстрації / Місце проживання / C.1.3 (адресне) ──
  result.address =
    c13OwnerAddress ||
    extractField(text, [
      new RegExp(
        `(?:адреса\\s*(?:власника|проживання|реєстрації|клієнта)?|місце\\s*(?:проживання|реєстрації)|місцезнаходження|address|residence)${SEP}(.+)`,
        "im",
      ),
      new RegExp(`(?:c\\.?\\s*1\\.?\\s*3|c13)${SEP}(.+)`, "im"), // C.1.3 — адреса власника
      new RegExp(`(?:c\\.?\\s*4|c4)${SEP}(.+)`, "im"), // C.4 — адреса у техпаспорті
    ]);
  // Fallback: шукаємо рядок що містить ознаки адреси (обл., м., р-н, вул., буд.)
  if (!result.address) {
    const addrLine = text.match(
      /^[^:：\n]*[:：]\s*(.+(?:обл\.|р-н|м\.\s*\S+|вул\.|буд\.|пров\.|район|область|місто).+)$/im,
    );
    if (addrLine) result.address = addrLine[1].trim();
  }

  // ── Додатково / Примітка ──
  result.extra = extractField(text, [
    new RegExp(
      `(?:додаткова?\\s*(?:інформація|дані)?|примітка|коментар|notes?|remarks?|additional)${SEP}(.+)`,
      "im",
    ),
  ]);

  // ── Тип авто / Тип ТЗ / Тип кузова / J ──
  if (!result.carType) {
    result.carType = extractField(text, [
      new RegExp(
        `(?:тип\\s*(?:авто(?:мобіля)?|транспорт\\w*|кузов[а]?|т\\.?\\s*з\\.?)?|body\\s*(?:type|style)|type|category|j\\b)${SEP}(.+)`,
        "im",
      ),
    ]);
  }

  // ── Колір / Color / R ──
  result.color = extractField(text, [
    new RegExp(`(?:колір|колор|цвет|colo[u]?r|r\\b)${SEP}(.+)`, "im"),
  ]);

  // ── Кількість місць / Місця для сидіння / S.1 ──
  result.seats = extractField(text, [
    new RegExp(
      `(?:(?:кількість\\s*)?(?:сидячих\\s*)?місць(?:\\s*(?:для\\s*сидіння|сидячих))?|seats?|s\\.?\\s*1|s1|к[\\-]?ть\\s*місць)${SEP}(\\d+)`,
      "im",
    ),
  ]);

  // ── Дата першої реєстрації / B.1 ──
  result.firstRegDate = extractField(text, [
    new RegExp(
      `(?:дата\\s*першої\\s*реєстрації|перша\\s*реєстрація|first\\s*registr|date\\s*of\\s*first\\s*registr|b\\.?\\s*1|b1\\b)${SEP}(.+)`,
      "im",
    ),
  ]);

  // ── Дата реєстрації / I ──
  result.regDate = extractField(text, [
    new RegExp(
      `(?:дата\\s*реєстрації|реєстрація|date\\s*of\\s*registr|registration\\s*date|i\\b)${SEP}(.+)`,
      "im",
    ),
  ]);

  // Якщо B.2 відсутній, уникаємо підстановки року з дат реєстрації (B.1/I)
  if (!result.year || !/^(19[7-9]\d|20[0-3]\d)$/.test(result.year)) {
    const firstRegYear = result.firstRegDate?.match(
      /\b(19[7-9]\d|20[0-3]\d)\b/,
    )?.[1];
    const regYear = result.regDate?.match(/\b(19[7-9]\d|20[0-3]\d)\b/)?.[1];
    const years = Array.from(text.matchAll(/\b(19[7-9]\d|20[0-3]\d)\b/g)).map(
      (m) => m[1],
    );
    const candidates = years.filter((y) => y !== firstRegYear && y !== regYear);
    if (candidates.length > 0) {
      result.year = candidates.sort()[0];
    }
  }

  return result;
}
console.log("PIB IS:", parseClientDataFromAI(`На зображенні — Свідоцтво про реєстрацію транспортного засобу (техпаспорт) з такими даними:

* Реєстраційний номер: AB0211BC
* Дата першої реєстрації: 13.08.2009
* Дата реєстрації: 26.07.2017
* Рік випуску: 2009
* ПІБ власника: КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА
* Адреса: ВІННИЦЬКА ОБЛ., М. ВІННИЦЯ, ЛЕНІНСЬКИЙ РАЙОН, ПРОСП. ЮНОСТІ, 31 58
* Власність: є власником
* Видано: ТСЦ 0546
* Дійсний до: 26.07.2018
* Марка: MITSUBISHI
* Модель: LANCER
* Тип кузова: ЗАГАЛЬНИЙ ЛЕГКОВИЙ СЕДАН-В
* VIN: JMBSNCSS3A9U000803
* Повна маса: 1770 кг
* Маса без навантаження: 1315 кг
* Об'єм двигуна: 1584 см³
* Тип пального: БЕНЗИН
* Колір: ЧЕРВОНИЙ
* Кількість місць для сидіння: 5
* Кількість стоячих місць: 2
* Особливі відмітки: ВСТАН. ГБО НА ЗМІ. СВ-ВО СХМ 680171 ВІД 20.07.2017. ДОД.ДРУКОВАНИЙ НИЖЧЕ 27.04.2017.
* СТР №: СХМ 658084
📋 Внести в картку`).pib);
