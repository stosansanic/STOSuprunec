const fs = require('fs');
let code = fs.readFileSync('extract_eval.js', 'utf8');

const testStr1 = `* ПІБ власника: КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;
const testStr2 = `* **ПІБ власника:** КОЛЕСНИК ЛЮДМИЛА ІВАНІВНА`;

const fullScript = `
${code}
console.log("PIB IS 1:", parseClientDataFromAI(\`${testStr1}\`).pib);
console.log("PIB IS 2:", parseClientDataFromAI(\`${testStr2}\`).pib);
`;

fs.writeFileSync('real_eval2.js', fullScript);
