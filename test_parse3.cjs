const fs = require('fs');

const extractFieldCode = `function extractField(text, regexps) {
  for (const rx of regexps) {
    const match = text.match(rx);
    if (match && match[1]) {
      return match[1].trim().replace(/^\\*+|\\*+$/g, "").trim();
    }
  }
  return undefined;
}`;

let code = fs.readFileSync('extract_eval.js', 'utf8');

// replace the export and function bits so it runs natively in my script
code = code.replace(/function parseClientDataFromAI\(text\)/, 'function parseClientDataFromAI(text)');

const testStr1 = `* ПІБ власника: КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;
const testStr2 = `* **ПІБ власника:** КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;

const fullScript = `
${extractFieldCode}
${code}
console.log("PIB IS 1:", parseClientDataFromAI(\`${testStr1}\`).pib);
console.log("PIB IS 2:", parseClientDataFromAI(\`${testStr2}\`).pib);
`;

fs.writeFileSync('real_eval2.cjs', fullScript);
