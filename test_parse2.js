import * as fs from 'fs';

const text = `На зображенні — Свідоцтво про реєстрацію транспортного засобу (техпаспорт) з такими даними:

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
📋 Внести в картку`;

function extractField(text, regexps) {
  for (const rx of regexps) {
    const match = text.match(rx);
    if (match && match[1]) {
      return match[1].trim().replace(/^\*+|\*+$/g, "").trim();
    }
  }
  return undefined;
}

function parseClientDataFromAI(text) {
  const result = {};

  const SEP = `(?:\\s*\\([^)]+\\))?\\s*[:：—–\\-=]\\s*`;
  const LABEL_SEP = `(?:\\s*\\([^)]+\\))?\\s*(?:[:：—–\\-=]|\\s)\\s*`;

  const extractTechCodeLine = (codePattern) => {
    let rx = new RegExp(
      `(?:^|\\n)\\s*[*•\\-–—]?\\s*(?:${codePattern})\\s*(?:\\([^)]+\\))?\\s*[:：—–\\-=]?\\s*([^\\n]+)`,
      "im",
    );
    let m = text.match(rx);
    if (m?.[1])
      return m[1].trim().replace(/^\*+|\*+$/g, "").trim();

    rx = new RegExp(
      `(?:^|\\n)[^\\n]*\\(\\s*(?:${codePattern})\\s*\\)\\s*[:：—–\\-=]\\s*([^\\n]+)`,
      "im",
    );
    m = text.match(rx);
    if (!m?.[1]) return undefined;
    return m[1].trim().replace(/^\*+|\*+$/g, "").trim();
  };

  const extractByLabels = (labels, valuePattern = "(.+)") => {
    if (!labels.length) return undefined;
    const rx = new RegExp(
      `(?:^|\\n)\\s*[*•\\-–—]?\\s*(?:${labels.join("|")})${LABEL_SEP}${valuePattern}`,
      "im",
    );
    const m = text.match(rx);
    if (!m?.[1]) return undefined;
    return m[1].trim().replace(/^\*+|\*+$/g, "").trim();
  };

  const c11OwnerSurname = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*1|c11`);
  const c12OwnerName = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*2|c12`);
  const c13OwnerAddress = extractTechCodeLine(`c\\.?\\s*1\\.?\\s*3|c13`);
  
  const ownerByKeyword = extractByLabels([
    `п[іi][бb](?:\\s*власника)?`,
    `власник(?:\\s*(?:тз|транспортного\\s*засобу))?`,
    `прізвище\\s*(?:або\\s*найменування\\s*)?(?:власника|особи)`,
    `(?:holder|owner|registered\\s*owner)(?:\\s*name)?`,
  ]);

  {
    const pibFromCodes =
      [c11OwnerSurname, c12OwnerName].filter(Boolean).join(" ").trim() ||
      undefined;

    const threeWordPib = (() => {
      const rx =
        /\b([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]{1,})\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]{1,})\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\u2019-]+(?:[оО][вВ][иИіі][чЧ]|[іІ][вВ][нН][аА]|[єЄ][вВ][нН][аА]|[оО][вВ][нН][аА]|[аА][вВ][нН][аА]))\b/;
      const m = text.match(rx);
      return m ? `${m[1]} ${m[2]} ${m[3]}` : undefined;
    })();

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
  return result;
}

console.log(JSON.stringify(parseClientDataFromAI(text), null, 2));
