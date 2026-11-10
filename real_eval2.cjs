
function extractField(text, regexps) {
  for (const rx of regexps) {
    const match = text.match(rx);
    if (match && match[1]) {
      return match[1].trim().replace(/^\*+|\*+$/g, "").trim();
    }
  }
  return undefined;
}
import * as fs from 'fs';

const content = fs.readFileSync('src/ts/roboha/ai/aiChat.ts', 'utf8');

// evaluate parseClientDataFromAI
const startIdx = content.indexOf('function parseClientDataFromAI(text: string): ParsedClientData {');
if (startIdx === -1) throw new Error("Could not find function");

let braces = 0;
let endIndex = startIdx;
for (let i = startIdx; i < content.length; i++) {
  if (content[i] === '{') braces++;
  if (content[i] === '}') {
    braces--;
    if (braces === 0) {
      endIndex = i + 1;
      break;
    }
  }
}

let fnCode = content.substring(startIdx, endIndex);
fnCode = fnCode.replace(/: string \| undefined/g, '');
fnCode = fnCode.replace(/: string/g, '');
fnCode = fnCode.replace(/: ParsedClientData/g, '');
fnCode = fnCode.replace(/: RegExp\[\]/g, '');
fnCode = fnCode.replace(/type AIContextLevel.*/, '');

// also need extractField!
const extractFieldIdx = content.indexOf('function extractField(text: string, regexps: RegExp[]): string | undefined {');
let braces2 = 0;
let extractFieldEnd = extractFieldIdx;
for (let i = extractFieldIdx; i < content.length; i++) {
  if (content[i] === '{') braces2++;
  if (content[i] === '}') {
    braces2--;
    if (braces2 === 0) {
      extractFieldEnd = i + 1;
      break;
    }
  }
}

let extractFieldCode = content.substring(extractFieldIdx, extractFieldEnd);
extractFieldCode = extractFieldCode.replace(/: string \| undefined/g, '');
extractFieldCode = extractFieldCode.replace(/: string/g, '');
extractFieldCode = extractFieldCode.replace(/: RegExp\[\]/g, '');

const testStr = `На зображенні — Свідоцтво про реєстрацію транспортного засобу (техпаспорт) з такими даними:

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

const fullScript = `
${extractFieldCode}
${fnCode}
console.log("PIB IS:", parseClientDataFromAI(\`${testStr}\`).pib);
`;

fs.writeFileSync('real_eval.js', fullScript);
console.log("Wrote temp test script");

console.log("PIB IS 1:", parseClientDataFromAI(`* ПІБ власника: КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`).pib);
console.log("PIB IS 2:", parseClientDataFromAI(`* **ПІБ власника:** КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`).pib);
