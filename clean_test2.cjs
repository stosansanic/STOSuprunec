function extractField(text, regexps) {
  for (const rx of regexps) {
    const match = text.match(rx);
    if (match && match[1]) {
      return match[1].trim().replace(/^\*+|\*+$/g, "").trim();
    }
  }
  return undefined;
}

function parseClientDataFromAI(rawText) {
  const text = rawText.replace(/\*\*/g, "").replace(/__/g, "");
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
        /\\b([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\\u2019-]{1,})\\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\\u2019-]{1,})\\s+([А-ЯІЇЄҐ][А-ЯІЇЄҐа-яіїєґ'ʼ\\u2019-]+(?:[оО][вВ][иИіі][чЧ]|[іІ][вВ][нН][аА]|[єЄ][вВ][нН][аА]|[оО][вВ][нН][аА]|[аА][вВ][нН][аА]))\\b/;
      const m = text.match(rx);
      return m ? `${m[1]} ${m[2]} ${m[3]}` : undefined;
    })();

    const pibFromExtract = extractField(text, [
      new RegExp(`п[іi][бb]${SEP}(.+)`, "im"),
      new RegExp(
        `(?:прізвище|surname)(?:\\s*(?:та|і|,)\\s*(?:ім['ʼ\\u2019]?я|name))?${SEP}(.+)`,
        "im",
      ),
      new RegExp(`власник${SEP}(.+)`, "im"),
      new RegExp(`клієнт${SEP}(.+)`, "im"),
      new RegExp(`(?:ім['ʼ\\u2019]?я|given\\s*name|name)${SEP}(.+)`, "im"),
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

const testStr1 = `* ПІБ власника: КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;
const testStr2 = `* **ПІБ власника:** КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;
const testStr3 = `* ПІБ власника: **КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА**`;

console.log("PIB IS 1:", parseClientDataFromAI(testStr1).pib);
console.log("PIB IS 2:", parseClientDataFromAI(testStr2).pib);
console.log("PIB IS 3:", parseClientDataFromAI(testStr3).pib);
