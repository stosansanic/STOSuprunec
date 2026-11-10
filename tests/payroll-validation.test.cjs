// Pure local validation fixtures: no database, browser, or network calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/payrollValidation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: api });

const work = (overrides = {}) => ({
  Робота: 'Рихтовка К/В', Кількість: 1, Ціна: 900, Сума: 900,
  Зарплата: 300, Слюсар: 'Рак', recordId: 'work-1', ...overrides,
});
const act = (rows = [work()]) => ({ Роботи: rows, Деталі: [], Знижка: 0 });
const errors = data => api.validateActPayrollData(data);

test('act 1514 accepts the unassigned 150 грн draft without changing Rak 300 + 300 or the act', () => {
  const data = act([
    work(),
    work({ Робота: 'Поліровка К/В', Ціна: 400, Сума: 400, recordId: 'work-2' }),
    work({ Робота: 'Шліфовка сальника колінвалу', Ціна: 0, Сума: 0, Зарплата: 150, Слюсар: '', recordId: 'work-3' }),
  ]);
  const before = JSON.stringify(data);
  assert.equal(errors(data).length, 0);
  const issues = api.getActPayrollDrafts(data);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'work');
  assert.equal(issues[0].index, 2);
  assert.equal(issues[0].field, 'Слюсар');
  assert.equal(issues[0].recordId, 'work-3');
  assert.equal(issues[0].code, 'missing_employee');
  assert.match(issues[0].message, /№3.*Шліфовка сальника колінвалу.*150 грн.*чернетку.*після вибору працівника/);
  assert.equal(data.Роботи.filter(row => row.Слюсар === 'Рак').reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.doesNotThrow(() => api.assertValidActPayrollData(data));
  assert.equal(JSON.stringify(data), before);
});

test('explicit assignment or zero salary resolves the issue; employee ID is authoritative', () => {
  for (const row of [work({ Слюсар: '', slyusar_id: 12 }), work({ Слюсар: '', Зарплата: 0 }), work({ Слюсар: 'Рак', Ціна: 0, Сума: 0 })]) {
    assert.equal(errors(act([row])).length, 0);
    assert.equal(api.getActPayrollDrafts(act([row])).length, 0);
    assert.doesNotThrow(() => api.assertValidActPayrollData(act([row])));
  }
});

test('skips empty drafts and uses a separate named-row index for works and details', () => {
  const data = act([{ Робота: '', Зарплата: 500 }, work(), { Робота: '  ' }, work({ Слюсар: '' })]);
  data.Деталі = [{ Деталь: '' }, { Деталь: 'Фільтр', Кількість: 1, Ціна: -1, recordId: 'part-1' }];
  const issues = errors(data);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'detail'); assert.equal(issues[0].index, 0); assert.equal(issues[0].recordId, 'part-1');
  const drafts = api.getActPayrollDrafts(data);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].kind, 'work'); assert.equal(drafts[0].index, 1);
});

test('keeps the existing numeric rules, allowing zero prices and negative quantities/sums', () => {
  const data = act([work({ Кількість: -2, Ціна: 0, Сума: -50, Зарплата: '0', Слюсар: '' })]);
  data.Деталі = [{ Деталь: 'Повернення', Кількість: '-1.5', Ціна: '20', Сума: -30 }];
  assert.equal(errors(data).length, 0);
  for (const [field, values] of [
    ['Кількість', [undefined, null, '', ' ', NaN, Infinity, 'abc', false]],
    ['Ціна', [undefined, '', -1, Infinity, '1,5']],
    ['Сума', ['', NaN, Infinity]],
    ['Зарплата', [undefined, null, '', -1, Infinity, true]],
  ]) {
    for (const value of values) assert.ok(errors(act([work({ [field]: value })])).some(issue => issue.field === field), `${field}: ${String(value)}`);
  }
  assert.equal(errors(act([work({ Сума: undefined })])).length, 0);
  const invalidSalary = act([work({ Слюсар: '', Зарплата: -150 })]);
  assert.equal(api.getActPayrollDrafts(invalidSalary).length, 0);
  assert.throws(() => api.assertValidActPayrollData(invalidSalary), error => error.name === 'PayrollValidationError'
    && error.issues.length === 1 && error.issues[0].field === 'Зарплата');
});

test('validates optional discount boundaries and positive safe employee/stock IDs', () => {
  for (const value of [undefined, null, 0, '100']) assert.equal(errors({ ...act(), Знижка: value }).length, 0);
  for (const value of ['', -1, 101, NaN, Infinity, false]) assert.ok(errors({ ...act(), Знижка: value }).some(issue => issue.field === 'Знижка'));
  for (const value of [0, -1, 1.2, '', 'abc', Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(errors(act([work({ slyusar_id: value })])).some(issue => issue.field === 'slyusar_id'));
    const data = act(); data.Деталі = [{ Деталь: 'Фільтр', Кількість: 1, Ціна: 10, sclad_id: value }];
    assert.ok(errors(data).some(issue => issue.field === 'sclad_id'));
  }
  assert.equal(errors(act([work({ slyusar_id: '12' })])).length, 0);
});

test('legacy JSON data is readable and invalid/missing act arrays fail with actionable local errors', () => {
  assert.equal(errors(JSON.stringify(act())).length, 0);
  for (const value of [undefined, null, [], '{broken']) assert.equal(errors(value)[0].code, 'invalid_data');
  const issues = errors({});
  assert.equal(issues.length, 2);
  assert.equal(issues[0].kind, 'act'); assert.equal(issues[0].index, null);
  assert.match(issues[0].message, /Відкрийте акт повторно/);
});
