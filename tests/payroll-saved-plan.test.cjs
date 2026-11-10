// Real payroll planners and session guards with local data only: no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const copy = structuredClone;
const savePath = 'src/ts/roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu.ts';
const paidConflictMessage = /вже оплачене нарахування|оплачена робота/;

function load(file, dependencies) {
  const context = { exports: {}, require: name => {
    if (name.endsWith('/payrollPayments')) return load('src/ts/utils/payrollPayments.ts', {});
    assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name), `Missing fixture dependency: ${name}`);
    return dependencies[name];
  }, structuredClone, crypto: { randomUUID } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context.exports;
}

function addFunctions(context, file, names) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(declarations.length, names.length, `Every requested planner is extracted from ${file}`);
  const source = declarations.map(node => node.getText(ast).replace(/^export\s+/, '')).join('\n');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
}

async function fixture(seed = {}) {
  const employees = copy(seed.employees || [
    { slyusar_id: 1, data: { Name: 'Шелест О. Г.', Доступ: 'Приймальник', Склад: 1, ПроцентРоботи: 20, ПроцентЗапчастин: 10, Історія: {} } },
    { slyusar_id: 2, data: { Name: 'Рак', Доступ: 'Слюсар', ПроцентРоботи: 30, Історія: {} } },
    { slyusar_id: 3, data: { Name: 'Запчастист', Доступ: 'Запчастист', Склад: 2, ПроцентЗапчастин: 50, Історія: {} } },
  ]);
  const stock = [{ sclad_id: 10, price: 50, scladNomer: 3, xto_zamovuv: 3 }];
  const requests = [];
  const supabase = {
    auth: { onAuthStateChange() {} },
    async rpc(name, args) {
      requests.push({ name, args: copy(args) });
      assert.equal(name, 'traffic_payroll_employees', 'Planning must not commit any payroll');
      return { data: copy(employees), error: null };
    },
    from(table) {
      assert.equal(table, 'sclad', 'The snapshot supplies act context; null client/car IDs require no lookup');
      return { select() { return this; }, async in(key, ids) {
        assert.equal(key, 'sclad_id');
        requests.push({ table, ids: copy(ids) });
        return { data: copy(stock.filter(row => ids.includes(row.sclad_id))), error: null };
      } };
    },
  };
  const act = load('src/ts/utils/actSafeWrite.ts', { '../vxid/supabaseClient': { supabase } });
  const payroll = load('src/ts/utils/payrollSafeWrite.ts', { '../vxid/supabaseClient': { supabase }, './actSafeWrite': act });
  const validation = load('src/ts/utils/payrollValidation.ts', {});
  const payments = load('src/ts/utils/payrollPayments.ts', {});
  const context = vm.createContext({ ...payroll, ...act, ...validation, ...payments, supabase, structuredClone,
    safeParseJSON: value => typeof value === 'string' ? JSON.parse(value) : copy(value),
    isActFrozen: value => value.data?.Заморожений === true,
    globalCache: { works: [], details: [] },
    showNotification() { throw new Error('Strict saved planning must propagate failures'); },
  });
  addFunctions(context, 'src/ts/roboha/zakaz_naraudy/inhi/save_work.ts', [
    'employeeKey', 'toISODateOnly', 'fetchSlyusarByName', 'updateSlyusarJson', 'ensureSlyusarHistoryRoot',
    'fetchPrevWorksFromSlyusars', 'syncSlyusarsHistoryForAct', 'syncSlyusarsOnActSave',
  ]);
  addFunctions(context, savePath, [
    'fetchPayrollEmployeesForAct', 'persistPayrollData', 'readSavedPayrollLabels', 'payrollErrorMessage',
    'syncAllZapchastystyHistoryForAct', 'syncPruimalnikHistory', 'planSavedActPayroll',
  ]);
  const snapshot = copy(seed.snapshot || {
    act_id: 1514, date_on: '2026-10-09T15:57:00', date_off: null, pruimalnyk: 'Шелест О. Г.',
    client_id: null, cars_id: null, checksum: 'a'.repeat(32), revision: 'test-revision',
    data: { __payroll_pending: true, Знижка: 0, Деталі: [], Роботи: [
      { recordId: 'w1', Робота: 'Рихтовка К/В', Слюсар: 'Рак', slyusar_id: 2, Кількість: 1, Ціна: 900, Сума: 900, Зарплата: 300 },
      { recordId: 'w2', Робота: 'Поліровка К/В', Слюсар: 'Рак', slyusar_id: 2, Кількість: 1, Ціна: 400, Сума: 400, Зарплата: 300 },
    ] },
  });
  const session = await payroll.PayrollWriteSession.create(snapshot.act_id);
  return { snapshot, employees, stock, requests, session,
    plan: () => context.planSavedActPayroll(snapshot, session),
    entry: id => session.fragments().find(fragment => fragment.id === id)?.desired[0]?.value,
    async editEmployee(id, edit) {
      const [row] = await session.fetchEmployees({ id });
      const data = payroll.trackPayrollData(id, row.data);
      edit(data);
      await session.save(data);
    },
  };
}

// Model an acknowledged server write by seeding a NEW public session with its
// desired fragments. No private PayrollWriteSession fields are inspected.
function acknowledgedSeed(first) {
  const employees = copy(first.employees);
  for (const fragment of first.session.fragments()) {
    const employee = employees.find(row => row.slyusar_id === fragment.id);
    employee.data.Історія = {};
    for (const item of fragment.desired) {
      (employee.data.Історія[item.date] ||= []).push(copy(item.value));
    }
  }
  return { employees, snapshot: copy(first.snapshot) };
}

function employeeAct(seed, id) {
  return Object.values(seed.employees.find(row => row.slyusar_id === id).data.Історія).flat()[0];
}

async function paidSeed({ parts = false } = {}) {
  const first = await fixture();
  if (parts) first.snapshot.data.Деталі.push({
    recordId: 'p1', Деталь: 'Підшипник', sclad_id: 10, Кількість: 2, Ціна: 100, Сума: 200,
  });
  await first.plan();
  return acknowledgedSeed(first);
}

function paidFinancialShape(value) {
  return Object.fromEntries(Object.entries(copy(value)).filter(([key]) =>
    !['Клієнт', 'Автомобіль', 'ДатаЗакриття', '__payroll_input'].includes(key)));
}

async function act1274PriceCorrectionSeed({ headerPaid = false, existingSum = false } = {}) {
  // Sanitized values supplied by the user; no database or personal client data.
  const first = await fixture({ snapshot: {
    act_id: 1274, date_on: '2026-08-14T10:00:00', date_off: null, pruimalnyk: 'Шелест О. Г.',
    client_id: null, cars_id: null, checksum: 'b'.repeat(32), revision: 'act-1274-fixture',
    data: { __payroll_pending: true, Знижка: 0, Деталі: [], Роботи: [{
      recordId: 'row_new_1792221176241_vkc469iqi', Робота: 'Полоскання блоку циліндрів',
      Слюсар: 'Рак', slyusar_id: 2, Кількість: 1, Ціна: 1, Сума: 1, Зарплата: 25,
    }] },
  } });
  await first.plan();
  const seed = acknowledgedSeed(first);
  const entry = employeeAct(seed, 2);
  const row = entry.Записи[0];
  row.Розраховано = '17.10.2026';
  row.Записано = '14.08.2026';
  row.Примітка = 'Збережена історична позначка';
  if (existingSum) row.Сума = 1;
  if (headerPaid) entry.Розраховано = '17.10.2026';
  Object.assign(seed.snapshot.data.Роботи[0], { Ціна: 50, Сума: 50 });
  return seed;
}

for (const headerPaid of [false, true]) for (const existingSum of [false, true]) {
  test(`act 1274 price 1→50 preserves salary 25 and payment (paid header=${headerPaid}, existing sum=${existingSum})`, async () => {
    const seed = await act1274PriceCorrectionSeed({ headerPaid, existingSum });
    const before = copy(employeeAct(seed, 2).Записи[0]);
    const f = await fixture(seed);
    await f.plan();
    const corrected = f.entry(2);
    assert.deepEqual(copy(corrected.Записи), [{
      ...before, Ціна: 50, ...(existingSum ? { Сума: 50 } : {}),
    }]);
    assert.equal(corrected.СуммаРоботи, 50);
    assert.equal(corrected.Записи[0].Зарплата, 25);
    assert.equal(corrected.Записи[0].Розраховано, '17.10.2026');
    assert.equal(Object.hasOwn(corrected.Записи[0], 'Сума'), existingSum);
    assert.equal(corrected.Розраховано, headerPaid ? '17.10.2026' : undefined);
    assert.equal(f.requests.length, 1, 'Correction uses the existing employee projection');

    const repeated = await fixture(acknowledgedSeed(f));
    await repeated.plan();
    assert.deepEqual(copy(repeated.entry(2)), copy(corrected), 'Retry keeps one paid row and the original payment metadata');
    assert.equal(repeated.entry(2).Записи.length, 1);
    assert.equal(repeated.requests.length, 1);
  });
}

test('price correction preserves legacy numeric wage and quantity strings exactly', async () => {
  const seed = await act1274PriceCorrectionSeed({ headerPaid: true, existingSum: true });
  const entry = employeeAct(seed, 2);
  const row = entry.Записи[0];
  Object.assign(row, { Ціна: '1', Сума: '1', Кількість: '1', Зарплата: '25' });
  entry.СуммаРоботи = '1';
  const before = copy(row);
  const f = await fixture(seed);
  await f.plan();
  assert.deepEqual(copy(f.entry(2).Записи[0]), { ...before, Ціна: 50, Сума: 50 });
  assert.equal(f.entry(2).СуммаРоботи, 50);
});

for (const salary of [0, 10, 40]) for (const headerPaid of [false, true]) {
  test(`act 1274 correction to wage ${salary}, paid header ${headerPaid}, preserves actual 25 and retries without writes`, async () => {
    const seed = await act1274PriceCorrectionSeed({ headerPaid, existingSum: true });
    if (headerPaid) delete employeeAct(seed, 2).Записи[0].Розраховано;
    seed.snapshot.data.Роботи[0].Зарплата = salary;
    seed.snapshot.data.Роботи[0].Кількість = 2;
    seed.snapshot.data.Роботи[0].Сума = 100;
    const f = await fixture(seed); await f.plan();
    const row = f.entry(2).Записи[0];
    assert.equal(row.Зарплата, salary); assert.equal(row.Кількість, 2); assert.equal(row.Сума, 100);
    assert.deepEqual(copy(row.__payroll_payments), [{ id: 'legacy', amount: 25, date: '17.10.2026' }]);
    assert.equal(row.Розраховано, headerPaid ? undefined : '17.10.2026');
    const repeated = await fixture(acknowledgedSeed(f)); await repeated.plan();
    assert.deepEqual(copy(repeated.entry(2)), copy(f.entry(2)));
    assert.ok(repeated.session.fragments().every(fragment => JSON.stringify(fragment.expected) === JSON.stringify(fragment.desired)));
    assert.equal(f.requests.length, 1);
  });
}

test('paid receiver commission recalculates after one mechanic wage changes and retains actual payment', async () => {
  const seed = await paidSeed();
  employeeAct(seed, 1).Розраховано = '17.10.2026';
  employeeAct(seed, 2).Записи[0].Розраховано = '17.10.2026';
  const previousReceiver = copy(employeeAct(seed, 1));
  seed.snapshot.data.Роботи[0].Зарплата = 350;
  const f = await fixture(seed); await f.plan();
  const next = f.entry(1);
  assert.equal(next.ЗарплатаРоботи, previousReceiver.ЗарплатаРоботи - 10);
  assert.deepEqual(copy(next.__payroll_payments), [{
    id: 'legacy', amount: previousReceiver.ЗарплатаРоботи + previousReceiver.ЗарплатаЗапчастин, date: '17.10.2026',
  }]);
  assert.equal(next.Розраховано, '17.10.2026');
  assert.equal(f.requests.length, 1);
});

test('paid mechanic header cannot be reinterpreted as a receiver by adding salary fields', async () => {
  const seed = await paidSeed(); employeeAct(seed, 2).Розраховано = '17.10.2026';
  const f = await fixture(seed);
  await f.editEmployee(2, data => { Object.values(data.Історія).flat()[0].Зарплата = 999; });
  assert.throws(() => f.session.fragments(), paidConflictMessage);
});

test('new work cannot forge a payment ledger in an accrual', async () => {
  const seed = await paidSeed(), f = await fixture(seed);
  await f.editEmployee(2, data => Object.values(data.Історія).flat()[0].Записи.push({
    recordId: 'forged', Робота: 'Work', Зарплата: 50, Ціна: 100, Кількість: 1,
    __payroll_payments: [{ id: 'forged-payment', amount: 50, date: '20.10.2026' }],
  }));
  assert.throws(() => f.session.fragments(), /виплат/);
});

test('deleting a fully voided paid work retains the complete ledger on a zero-earned tombstone', async () => {
  const seed = await paidSeed();
  Object.assign(employeeAct(seed, 2).Записи[0], { __payroll_payments: [
    { id: 'legacy', amount: 300, date: '17.10.2026' }, { id: 'void', voids: 'legacy', date: '20.10.2026' },
  ] });
  seed.snapshot.data.Роботи.shift();
  const f = await fixture(seed);
  await f.plan();
  const removed = f.entry(2).Записи.find(row => row.recordId === 'w1');
  assert.equal(removed.__payroll_removed, true);
  assert.equal(removed.Кількість, 0);
  assert.equal(removed.Зарплата, 0);
  assert.deepEqual(copy(removed.__payroll_payments), employeeAct(seed, 2).Записи[0].__payroll_payments);
});

for (const [field, value] of [['Робота', 'Інша робота']]) {
  test(`same-ID correction can rename paid ${field} while preserving its payment`, async () => {
    const seed = await act1274PriceCorrectionSeed();
    seed.snapshot.data.Роботи[0][field] = value;
    const f = await fixture(seed);
    await f.plan();
    assert.equal(f.entry(2).Записи[0][field], value);
    assert.equal(f.entry(2).Записи[0].recordId, employeeAct(seed, 2).Записи[0].recordId);
    assert.equal(f.entry(2).Записи[0].Розраховано, '17.10.2026');
    assert.equal(employeeAct({ employees: f.employees }, 2).Записи[0].Розраховано, '17.10.2026');
    assert.equal(f.requests.length, 1);
  });
}

test('price correction cannot rewrite the paid date', async () => {
  const seed = await act1274PriceCorrectionSeed();
  const f = await fixture(seed);
  await f.editEmployee(2, data => {
    const entry = Object.values(data.Історія).flat()[0];
    entry.Записи[0].Ціна = 50;
    entry.Записи[0].Розраховано = '18.10.2026';
    entry.СуммаРоботи = 50;
  });
  assert.throws(() => f.session.fragments(), paidConflictMessage);
});

test('price correction without a matching legacy row identifier remains blocked', async () => {
  const seed = await act1274PriceCorrectionSeed();
  delete employeeAct(seed, 2).Записи[0].recordId;
  const f = await fixture(seed);
  await assert.rejects(async () => { await f.plan(); f.session.fragments(); }, paidConflictMessage);
});

test('legacy paid mechanic numbers retain their original JSON and payment after an unchanged save', async () => {
  const seed = await paidSeed();
  const row = employeeAct(seed, 2).Записи[0];
  Object.assign(row, { Ціна: '900', Кількість: '1', Зарплата: '300', Розраховано: '14.10.2026' });
  const expected = copy(row);
  const f = await fixture(seed);
  await f.plan();
  assert.deepEqual(copy(f.entry(2).Записи[0]), expected);
  assert.equal(f.requests.length, 1, 'Only the current-act employee projection is read');
});

test('equivalent string and numeric record IDs preserve the original paid row identifier', async () => {
  const seed = await paidSeed();
  const row = employeeAct(seed, 2).Записи[0];
  row.recordId = 101;
  row.Розраховано = '14.10.2026';
  seed.snapshot.data.Роботи[0].recordId = '101';
  const expected = copy(row);
  const f = await fixture(seed);
  await f.plan();
  assert.deepEqual(copy(f.entry(2).Записи[0]), expected);
});

test('a uniquely matching legacy paid row without recordId is preserved without inventing metadata', async () => {
  const seed = await paidSeed();
  const row = employeeAct(seed, 2).Записи[0];
  delete row.recordId;
  delete row.Записано;
  row.Розраховано = '14.10.2026';
  row.Примітка = 'Історичний платіж';
  const expected = copy(row);
  const f = await fixture(seed);
  await f.plan();
  const next = f.entry(2).Записи[0];
  assert.deepEqual(copy(next), expected);
  assert.equal(Object.hasOwn(next, 'recordId'), false);
  assert.equal(Object.hasOwn(next, 'Записано'), false);
  assert.equal(f.entry(2).Записи.length, 2);
});

test('an existing paid row missing its recorded date does not gain a fabricated date on save', async () => {
  const seed = await paidSeed();
  const row = employeeAct(seed, 2).Записи[0];
  delete row.Записано;
  row.Розраховано = '14.10.2026';
  const expected = copy(row);
  const f = await fixture(seed);
  await f.plan();
  assert.deepEqual(copy(f.entry(2).Записи[0]), expected);
});

for (const id of [1, 3]) test(`unchanged legacy paid ${id === 1 ? 'receiver' : 'parts employee'} retains financial data without a baseline fingerprint`, async () => {
  const seed = await paidSeed({ parts: true });
  const entry = employeeAct(seed, id);
  delete entry.__payroll_input;
  for (const key of Object.keys(entry)) {
    if (key.startsWith('__payroll_percent')) delete entry[key];
  }
  entry.Розраховано = '14.10.2026';
  for (const key of ['СуммаРоботи', 'СуммаЗапчастин', 'МаржаДляЗарплати', 'ЗарплатаРоботи',
    'ЗарплатаЗапчастин', 'ЗарплатаЗапчастистів', 'Зарплата', 'Знижка']) {
    if (Object.hasOwn(entry, key)) entry[key] = String(entry[key]);
  }
  const expected = paidFinancialShape(entry);
  const f = await fixture(seed);
  await f.plan();
  assert.deepEqual(paidFinancialShape(f.entry(id)), expected);
  assert.equal(f.entry(id).Розраховано, '14.10.2026');
  assert.equal(f.requests.length, 2, 'One employee projection and one batched stock snapshot');
});

test('modern paid headers preserve original numeric JSON while permitting display metadata updates', async () => {
  const seed = await paidSeed({ parts: true });
  const original = employeeAct(seed, 1);
  original.Розраховано = '14.10.2026';
  const numericKeys = ['СуммаРоботи', 'СуммаЗапчастин', 'МаржаДляЗарплати', 'ЗарплатаРоботи',
    'ЗарплатаЗапчастин', 'ЗарплатаЗапчастистів', 'Зарплата', 'Знижка',
    '__payroll_percent_work', '__payroll_percent_parts'];
  for (const key of numericKeys) if (Object.hasOwn(original, key)) original[key] = String(original[key]);
  const expected = paidFinancialShape(original);
  const f = await fixture(seed);
  await f.editEmployee(1, data => {
    const next = Object.values(data.Історія).flat()[0];
    for (const key of numericKeys) if (Object.hasOwn(next, key)) next[key] = Number(next[key]);
    next.Акт = Number(next.Акт);
    next.Клієнт = 'Уточнене ПІБ';
    next.ДатаЗакриття = '2026-10-20';
  });
  assert.deepEqual(paidFinancialShape(f.entry(1)), expected);
  assert.equal(f.entry(1).Клієнт, 'Уточнене ПІБ');
  assert.equal(f.entry(1).ДатаЗакриття, '2026-10-20');
});

for (const [name, change] of [
  ['payment flag', entry => { entry.Розраховано = false; }],
  ['unknown financial metadata', entry => { entry.ПідставаВиплати = 'інша'; }],
]) test(`paid header rejects changed ${name} even if the other totals match`, async () => {
  const seed = await paidSeed({ parts: true });
  employeeAct(seed, 1).Розраховано = '14.10.2026';
  employeeAct(seed, 1).ПідставаВиплати = 'історична';
  const before = copy(seed.employees);
  const f = await fixture(seed);
  await f.editEmployee(1, data => change(Object.values(data.Історія).flat()[0]));
  assert.throws(() => f.session.fragments(), paidConflictMessage);
  assert.deepEqual(f.employees, before);
  assert.equal(f.requests.length, 1);
});

test('a uniquely re-added work keeps its paid payroll ID and records the current act ID as an alias', async () => {
  const seed = await paidSeed();
  employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
  seed.snapshot.data.Роботи[0].recordId = 'different-work';
  const f = await fixture(seed);
  await f.plan();
  const row = f.entry(2).Записи.find(row => row.recordId === 'w1');
  assert.equal(row.__payroll_act_record_id, 'different-work');
  assert.equal(row.Розраховано, '14.10.2026');
  assert.equal(f.entry(2).Записи.length, 2);
  assert.equal(employeeAct({ employees: f.employees }, 2).Записи[0].Розраховано, '14.10.2026');
  assert.equal(f.requests.length, 1, 'Relinking reuses the current-act employee snapshot');
  const repeated = await fixture(acknowledgedSeed(f));
  await repeated.plan();
  assert.deepEqual(copy(repeated.entry(2)), copy(f.entry(2)));
});

test('a new work with the same name as a paid work creates a separate unpaid row', async () => {
  const seed = await paidSeed();
  const old = employeeAct(seed, 2).Записи[0];
  old.Розраховано = '14.10.2026';
  const expected = copy(old);
  seed.snapshot.data.Роботи.push({ ...copy(seed.snapshot.data.Роботи[0]), recordId: 'additional-work' });
  const f = await fixture(seed);
  await f.plan();
  const rows = f.entry(2).Записи;
  assert.equal(rows.length, 3);
  assert.deepEqual(copy(rows.find(row => row.recordId === 'w1')), expected);
  assert.equal(rows.find(row => row.recordId === 'additional-work').Розраховано, undefined);
});

for (const [field, value] of [['Зарплата', 301], ['Кількість', 2]]) {
  test(`a correction to paid mechanic ${field} retains actual cash and affects only the selected work`, async () => {
    const seed = await paidSeed();
    employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
    const oldEmployees = copy(seed.employees);
    seed.snapshot.data.Роботи[0][field] = value;
    const f = await fixture(seed);
    await f.plan();
    const row=f.entry(2).Записи[0];
    assert.equal(row[field], value);
    assert.equal(row.Розраховано, '14.10.2026');
    if(field==='Зарплата') assert.deepEqual(copy(row.__payroll_payments),[{id:'legacy',amount:300,date:'14.10.2026'}]);
    else assert.equal(row.__payroll_payments,undefined);
    assert.deepEqual(copy(f.entry(2).Записи[1]), employeeAct(seed,2).Записи[1]);
    assert.deepEqual(f.employees,oldEmployees);
    assert.equal(f.requests.length,1,'One existing current-act snapshot, no extra payment reads');
  });
}

test('deleting a paid work keeps its original payment and zeroes only its current accrual', async () => {
  const seed = await paidSeed();
  employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
  seed.snapshot.data.Роботи.shift();
  const f = await fixture(seed);
  await f.plan();
  const row = f.entry(2).Записи.find(row => row.recordId === 'w1');
  assert.equal(row.__payroll_removed, true);
  assert.equal(row.Кількість, 0); assert.equal(row.Зарплата, 0);
  assert.deepEqual(copy(row.__payroll_payments), [{ id: 'legacy', amount: 300, date: '14.10.2026' }]);
  assert.equal(f.entry(2).СуммаРоботи, 400);
  assert.equal(employeeAct({ employees: f.employees }, 2).Записи[0].Розраховано, '14.10.2026');
});

test('moving a paid work to another employee never transfers its payment', async () => {
  const seed = await paidSeed();
  employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
  seed.employees.push({ slyusar_id: 4, data: { Name: 'Інший слюсар', Доступ: 'Слюсар', Історія: {} } });
  Object.assign(seed.snapshot.data.Роботи[0], { slyusar_id: 4, Слюсар: 'Інший слюсар' });
  const f = await fixture(seed);
  await f.plan();
  const removed = f.entry(2).Записи.find(row => row.recordId === 'w1');
  const assigned = f.entry(4).Записи.find(row => row.recordId === 'w1');
  assert.equal(removed.__payroll_removed, true);
  assert.deepEqual(copy(removed.__payroll_payments), [{ id: 'legacy', amount: 300, date: '14.10.2026' }]);
  assert.equal(assigned.Зарплата, 300);
  assert.equal(assigned.Розраховано, undefined);
  assert.equal(assigned.__payroll_payments, undefined);
  assert.equal(employeeAct({ employees: f.employees }, 2).Записи[0].Розраховано, '14.10.2026');
  assert.deepEqual(f.employees.find(row => row.slyusar_id === 4).data.Історія, {});
});

test('ambiguous duplicate legacy works without IDs cannot silently inherit a paid marker', async () => {
  const first = await fixture();
  first.snapshot.data.Роботи[1] = { ...copy(first.snapshot.data.Роботи[0]), recordId: 'w2' };
  await first.plan();
  const seed = acknowledgedSeed(first);
  const rows = employeeAct(seed, 2).Записи;
  rows.forEach(row => { delete row.recordId; });
  rows[0].Розраховано = '14.10.2026';
  const f = await fixture(seed);
  await assert.rejects(async () => { await f.plan(); f.session.fragments(); },
    /вже оплачене нарахування|однозначн|неоднозначн/);
  assert.equal(employeeAct({ employees: f.employees }, 2).Записи[0].Розраховано, '14.10.2026');
});

test('screenshot: unassigned 150 stays a draft while Rak receives 600 and receiver margin reserves the draft cost', async () => {
  const f = await fixture();
  f.snapshot.data.Роботи.push({ recordId: 'w3', Робота: 'Шліфовка сальника колінвалу', Слюсар: '',
    Кількість: 1, Ціна: 0, Сума: 0, Зарплата: 150 });
  const original = copy(f.snapshot.data);
  await f.plan();
  assert.equal(f.entry(2).Записи.reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.equal(f.entry(2).Записи.length, 2);
  assert.equal(f.entry(1).ЗарплатаРоботи, 110); // (1300 - 600 - 150 reserved) * 20%
  assert.equal(f.entry(3), undefined);
  assert.deepEqual(f.snapshot.data, original, 'Planning never erases or assigns the draft 150');
  assert.equal(f.snapshot.data.__payroll_pending, true);
  assert.equal(f.requests.length, 1, 'Only the employee projection was read');
});

test('two completed screenshot rows accrue 600 to Rak and the configured receiver commission', async () => {
  const f = await fixture();
  await f.plan();
  const mechanic = f.entry(2);
  assert.deepEqual(copy(mechanic.Записи.map(row => row.Зарплата)), [300, 300]);
  assert.equal(mechanic.Записи.reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.equal(f.entry(1).ЗарплатаРоботи, 140); // (1300 - 600) * 20%
  assert.equal(f.entry(1).ЗарплатаЗапчастин, 0);
  assert.equal(f.entry(3), undefined);
  assert.equal(f.snapshot.data.__payroll_pending, true, 'Only the server commit may clear pending');
  assert.equal(f.requests.length, 1, 'All planners share the session employee projection');
});

test('assigning and completing the draft includes its salary exactly once', async () => {
  const f = await fixture();
  const draft = { recordId: 'w3', Робота: 'Шліфовка сальника колінвалу', Слюсар: '',
    Кількість: 1, Ціна: 0, Сума: 0, Зарплата: 150 };
  f.snapshot.data.Роботи.push(draft);
  await f.plan();
  assert.equal(f.entry(2).Записи.length, 2);
  Object.assign(draft, { Слюсар: 'Рак', slyusar_id: 2, Ціна: 200, Сума: 200 });
  await f.plan();
  await f.plan();
  assert.equal(f.entry(2).Записи.length, 3);
  assert.equal(f.entry(2).Записи.reduce((sum, row) => sum + row.Зарплата, 0), 750);
  assert.equal(f.entry(1).ЗарплатаРоботи, 150); // (1500 - 750) * 20%
});

test('one saved plan calculates mechanic, receiver and parts employee with discount and stock cost', async () => {
  const f = await fixture();
  f.snapshot.data.Знижка = 10;
  f.snapshot.data.Деталі.push({ recordId: 'p1', Деталь: 'Підшипник', sclad_id: 10, Кількість: 2, Ціна: 100, Сума: 200 });
  await f.plan();
  assert.equal(f.entry(2).Записи.reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.equal(f.entry(1).ЗарплатаРоботи, 114); // (1300 * .9 - 600) * 20%
  assert.equal(f.entry(1).ЗарплатаЗапчастин, 8); // (200 * .9 - 2 * 50) * 10%
  assert.equal(f.entry(3).ЗарплатаЗапчастин, 40); // (200 * .9 - 2 * 50) * 50%
  assert.equal(f.entry(1).ЗарплатаЗапчастистів, 40);
  assert.equal(f.session.stockInputs().length, 1);
  assert.equal(f.requests.length, 2, 'One employee projection and one batch stock read');
});

test('own-stock exclusion produces zero parts employee salary without blocking a valid act', async () => {
  const f = await fixture();
  // The parts employee owns stock 2; own-stock margin is deliberately excluded.
  f.stock[0].scladNomer = 2;
  f.snapshot.data.Деталі.push({ recordId: 'p1', Деталь: 'Підшипник', sclad_id: 10, Кількість: 1, Ціна: 100, Сума: 100 });
  await f.plan();
  assert.equal(f.entry(3).ЗарплатаЗапчастин, 0);
  assert.equal(f.entry(1).ЗарплатаЗапчастин, 5);
});

test('an unresolved named employee is not treated as an unassigned draft', async () => {
  const f = await fixture();
  f.snapshot.data.Роботи.push({ recordId: 'w3', Робота: 'Шліфовка сальника колінвалу', Слюсар: 'Невідомий слюсар',
    Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 150 });
  await assert.rejects(f.plan(), /не знайдено однозначно/);
  assert.ok(f.session.fragments().every(fragment => fragment.desired.length === 0));
  assert.equal(f.snapshot.data.__payroll_pending, true);
});

test('turning an acknowledged paid work into a draft retains its payment without assigning the draft', async () => {
  const first = await fixture();
  first.snapshot.data.Роботи.push({ recordId: 'w3', Робота: 'Шліфовка сальника колінвалу', Слюсар: 'Рак', slyusar_id: 2,
    Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 150 });
  await first.plan();
  const seed = acknowledgedSeed(first);
  const mechanic = seed.employees.find(row => row.slyusar_id === 2);
  const entry = Object.values(mechanic.data.Історія).flat()[0];
  entry.Записи.find(row => row.recordId === 'w3').Розраховано = '14.10.2026';
  const paidBefore = copy(mechanic.data);
  const draft = seed.snapshot.data.Роботи.find(row => row.recordId === 'w3');
  draft.Слюсар = '';
  delete draft.slyusar_id;
  const f = await fixture(seed);
  await f.plan();
  const removed = f.entry(2).Записи.find(row => row.recordId === 'w3');
  assert.equal(removed.__payroll_removed, true);
  assert.equal(removed.Кількість, 0); assert.equal(removed.Зарплата, 0);
  assert.deepEqual(copy(removed.__payroll_payments), [{ id: 'legacy', amount: 150, date: '14.10.2026' }]);
  assert.equal(f.entry(2).Записи.reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.deepEqual(f.employees.find(row => row.slyusar_id === 2).data, paidBefore);
  assert.equal(f.snapshot.data.Роботи.find(row => row.recordId === 'w3').Зарплата, 150);
  assert.equal(f.requests.length, 1, 'Planning stages the edit without a payroll write');
});

test('turning an unpaid work into a draft removes only its accrual and preserves the other 600 and paid markers', async () => {
  const first = await fixture();
  first.snapshot.data.Роботи.push({ recordId: 'w3', Робота: 'Шліфовка сальника колінвалу', Слюсар: 'Рак', slyusar_id: 2,
    Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 150 });
  await first.plan();
  const seed = acknowledgedSeed(first);
  const mechanic = seed.employees.find(row => row.slyusar_id === 2);
  const entry = Object.values(mechanic.data.Історія).flat()[0];
  entry.Записи.find(row => row.recordId === 'w1').Розраховано = '14.10.2026';
  const preservedRows = copy(entry.Записи.filter(row => row.recordId !== 'w3'));
  const draft = seed.snapshot.data.Роботи.find(row => row.recordId === 'w3');
  draft.Слюсар = '';
  delete draft.slyusar_id;
  const f = await fixture(seed);
  await f.plan();
  const next = f.entry(2);
  assert.deepEqual(copy(next.Записи), preservedRows);
  assert.equal(next.Записи.reduce((sum, row) => sum + row.Зарплата, 0), 600);
  assert.equal(next.Записи.some(row => row.recordId === 'w3'), false);
  assert.equal(f.entry(1).ЗарплатаРоботи, 150, 'The draft wage remains reserved in the receiver margin');
  assert.equal(f.snapshot.data.Роботи.find(row => row.recordId === 'w3').Зарплата, 150);
  assert.equal(f.requests.length, 1, 'A fresh session reads employees once and stages the changed fragments');
});

async function act1533PaidSeed() {
  const first = await fixture();
  first.snapshot.act_id = 1533;
  first.snapshot.revision = 'act-1533-regression';
  first.snapshot.data.Роботи = [
    { recordId: 'artem-old', Робота: 'Полоскання блоку циліндрів', Слюсар: 'Артем Д', slyusar_id: 4,
      Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 100 },
    { recordId: 'rak-work', Робота: 'Шліфування колінвала', Слюсар: 'Рак', slyusar_id: 2,
      Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 100 },
  ];
  // The session is bound to one act, so recreate it after changing the fixture.
  const seed = { snapshot: copy(first.snapshot), employees: copy(first.employees) };
  seed.employees.push({ slyusar_id: 4, data: { Name: 'Артем Д', Доступ: 'Слюсар', ПроцентРоботи: 30, Історія: {} } });
  const initial = await fixture(seed);
  await initial.plan();
  const acknowledged = acknowledgedSeed(initial);
  const paid = employeeAct(acknowledged, 4).Записи[0];
  paid.Розраховано = '14.10.2026'; paid.Записано = '09.10.2026'; paid.Сума = 200;
  return acknowledged;
}

test('same-employee act1533 re-add with a new row ID accrues Artem D25 and Rak100 while retaining Artem D paid100', async () => {
  const seed = await act1533PaidSeed();
  const source = copy(seed.snapshot.data);
  Object.assign(seed.snapshot.data.Роботи[0], { recordId: 'artem-readded', Зарплата: 25 });
  const f = await fixture(seed); await f.plan();
  const artem = f.entry(4).Записи;
  assert.equal(artem.length, 1);
  assert.equal(artem[0].recordId, 'artem-old');
  assert.equal(artem[0].__payroll_act_record_id, 'artem-readded');
  assert.equal(artem[0].Зарплата, 25);
  assert.deepEqual(copy(artem[0].__payroll_payments), [{ id: 'legacy', amount: 100, date: '14.10.2026' }]);
  const payments = load('src/ts/utils/payrollPayments.ts', {});
  const settlement = payments.getPayrollPaymentState(artem[0], f.entry(4));
  assert.equal(settlement.paidAmount, 100); assert.equal(settlement.overpaid, 75); assert.equal(settlement.due, 0);
  assert.equal(f.entry(2).Записи.length, 1); assert.equal(f.entry(2).Записи[0].Зарплата, 100);
  assert.deepEqual(copy(f.entry(2).Записи), employeeAct(seed, 2).Записи);
  assert.equal(f.snapshot.data.Роботи[0].recordId, 'artem-readded', 'Payroll matching does not rewrite the saved act identity');
  assert.equal(source.Роботи[0].recordId, 'artem-old');
  const repeat = await fixture(acknowledgedSeed(f)); await repeat.plan();
  assert.ok(repeat.session.fragments().every(fragment => JSON.stringify(fragment.expected) === JSON.stringify(fragment.desired)));
});

test('reported act1533 transfers washing from Artem D to distinct Artem without transferring the paid100', async () => {
  const base = await fixture();
  const seed = { snapshot: copy(base.snapshot), employees: copy(base.employees) };
  seed.snapshot.act_id = 1533; seed.snapshot.revision = 'act-1533-distinct-employees';
  seed.employees.push(
    { slyusar_id: 4, data: { Name: 'Артем Д', Доступ: 'Слюсар', ПроцентРоботи: 30, Історія: {} } },
    { slyusar_id: 5, data: { Name: 'Артем', Доступ: 'Слюсар', ПроцентРоботи: 30, Історія: {} } },
  );
  const oldId = 'row_new_1792223113521_pup3qz32p';
  seed.snapshot.data.Роботи = [
    { recordId: oldId, Робота: 'Миття ГБЦ', Слюсар: 'Артем Д', slyusar_id: 4,
      Кількість: 1, Ціна: 0, Сума: 0, Зарплата: 100 },
    { recordId: 'pack-work', Робота: 'Пакування', Слюсар: 'Артем Д', slyusar_id: 4,
      Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 100 },
  ];
  const initial = await fixture(seed); await initial.plan();
  const acknowledged = acknowledgedSeed(initial);
  employeeAct(acknowledged, 4).Записи.find(row => row.recordId === oldId).Розраховано = '14.10.2026';
  Object.assign(acknowledged.snapshot.data.Роботи[0], {
    recordId: 'new-artem-washing', Слюсар: 'Артем', slyusar_id: 5, Ціна: 50, Сума: 50, Зарплата: 25,
  });
  const f = await fixture(acknowledged); await f.plan();
  const originalEmployee = f.entry(4), recipient = f.entry(5);
  assert.equal(originalEmployee.Записи.length, 2);
  const removed = originalEmployee.Записи.find(row => row.recordId === oldId);
  assert.equal(removed.__payroll_removed, true); assert.equal(removed.Кількість, 0); assert.equal(removed.Зарплата, 0);
  assert.deepEqual(copy(removed.__payroll_payments), [{ id: 'legacy', amount: 100, date: '14.10.2026' }]);
  assert.equal(originalEmployee.Записи.find(row => row.recordId === 'pack-work').Зарплата, 100);
  assert.equal(originalEmployee.СуммаРоботи, 200);
  assert.equal(recipient.Записи.length, 1); assert.equal(recipient.Записи[0].recordId, 'new-artem-washing');
  const payments = load('src/ts/utils/payrollPayments.ts', {});
  const state = payments.getPayrollPaymentState(recipient.Записи[0], recipient);
  assert.equal(state.earned, 25); assert.equal(state.due, 25); assert.equal(state.paidAmount, 0);
  assert.equal(recipient.Записи[0].__payroll_payments, undefined); assert.equal(recipient.Записи[0].Розраховано, undefined);
  assert.equal(f.requests.length, 1, 'One employee projection supplies both distinct employees');
  const repeat = await fixture(acknowledgedSeed(f)); await repeat.plan();
  assert.ok(repeat.session.fragments().every(fragment => JSON.stringify(fragment.expected) === JSON.stringify(fragment.desired)));
  assert.equal(repeat.requests.length, 1);
});

test('a later re-add restores a paid tombstone, then its alias supports an ordinary rename', async () => {
  const seed = await act1533PaidSeed();
  const work = copy(seed.snapshot.data.Роботи[0]);
  seed.snapshot.data.Роботи.shift();
  const removed = await fixture(seed); await removed.plan();
  const tombstone = removed.entry(4).Записи[0];
  assert.equal(tombstone.__payroll_removed, true); assert.equal(tombstone.Сума, 0);
  const nextSeed = acknowledgedSeed(removed);
  nextSeed.snapshot.data.Роботи.push({ ...work, recordId: 'artem-restored', Зарплата: 25 });
  const restored = await fixture(nextSeed); await restored.plan();
  const row = restored.entry(4).Записи[0];
  assert.equal(row.__payroll_removed, undefined);
  assert.equal(row.__payroll_act_record_id, 'artem-restored');
  assert.equal(row.recordId, 'artem-old'); assert.equal(row.Кількість, 1); assert.equal(row.Сума, 200);
  assert.deepEqual(copy(row.__payroll_payments), copy(tombstone.__payroll_payments));
  const renamedSeed = acknowledgedSeed(restored);
  renamedSeed.snapshot.data.Роботи.find(row => row.recordId === 'artem-restored').Робота = 'Уточнена назва роботи';
  const renamed = await fixture(renamedSeed); await renamed.plan();
  assert.equal(renamed.entry(4).Записи[0].Робота, 'Уточнена назва роботи');
  assert.equal(renamed.entry(4).Записи[0].recordId, 'artem-old');
  assert.deepEqual(copy(renamed.entry(4).Записи[0].__payroll_payments), copy(tombstone.__payroll_payments));
});

test('removing all works retains only paid tombstones and their employee header', async () => {
  const seed = await paidSeed();
  employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
  seed.snapshot.data.Роботи = [];
  const f = await fixture(seed); await f.plan();
  const entry = f.entry(2);
  assert.equal(entry.Записи.length, 1); assert.equal(entry.Записи[0].recordId, 'w1');
  assert.equal(entry.Записи[0].__payroll_removed, true); assert.equal(entry.СуммаРоботи, 0);
  assert.deepEqual(copy(entry.Записи[0].__payroll_payments), [{ id: 'legacy', amount: 300, date: '14.10.2026' }]);
  const repeat = await fixture(acknowledgedSeed(f)); await repeat.plan();
  assert.deepEqual(copy(repeat.entry(2)), copy(entry));
});

test('a new child under a paid mechanic header starts unpaid using an empty ledger', async () => {
  const seed = await paidSeed(); employeeAct(seed, 2).Розраховано = '14.10.2026';
  seed.snapshot.data.Роботи.unshift({ recordId: 'new-under-paid-header', Робота: 'Додаткова робота',
    Слюсар: 'Рак', slyusar_id: 2, Кількість: 1, Ціна: 200, Сума: 200, Зарплата: 100 });
  const f = await fixture(seed); await f.plan();
  const entry = f.entry(2), row = entry.Записи.find(row => row.recordId === 'new-under-paid-header');
  assert.deepEqual(copy(row.__payroll_payments), []);
  assert.equal(row.Розраховано, undefined);
  assert.equal(entry.Розраховано, '14.10.2026');
  const payments = load('src/ts/utils/payrollPayments.ts', {});
  assert.equal(payments.getPayrollPaymentState(row, entry).due, 100);
  assert.equal(payments.getPayrollPaymentState(row, entry).paidAmount, 0);
  assert.equal(entry.Записи.reduce((sum, work) => sum + payments.getPayrollPaymentState(work, entry).paidAmount, 0), 600);
  const repeat = await fixture(acknowledgedSeed(f)); await repeat.plan();
  assert.deepEqual(copy(repeat.entry(2)), copy(entry));
});

test('two unmatched paid works with the same name cannot be relinked to one new ID', async () => {
  const seed = await paidSeed(), entry = employeeAct(seed, 2);
  entry.Записи.forEach(row => { row.Робота = 'Повторна робота'; row.Розраховано = '14.10.2026'; });
  seed.snapshot.data.Роботи = [{ ...seed.snapshot.data.Роботи[0], Робота: 'Повторна робота', recordId: 'replacement' }];
  const f = await fixture(seed);
  await assert.rejects(async () => { await f.plan(); f.session.fragments(); }, /однозначн|неоднозначн/i);
  assert.deepEqual(f.employees, seed.employees, 'Ambiguous matching never mutates the acknowledged source');
});

for (const [field, value] of [
  ['__payroll_act_record_id', ''], ['__payroll_act_record_id', 17],
  ['__payroll_act_record_id', ['w2']], ['__payroll_removed', 'true'], ['__payroll_removed', false],
]) test(`paid work rejects malformed ${field}=${JSON.stringify(value)}`, async () => {
  const seed = await paidSeed(); employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
  const f = await fixture(seed);
  await f.editEmployee(2, data => { Object.values(data.Історія).flat()[0].Записи[0][field] = value; });
  assert.throws(() => f.session.fragments(), /оплачен|ідентифікатор|зарплат|робот/i);
});

test('a removed marker cannot conceal a nonzero accrual or rewrite acknowledged payment events', async () => {
  for (const edit of [
    row => { row.__payroll_removed = true; },
    row => { row.__payroll_act_record_id = 'replacement'; row.__payroll_payments = [{ id: 'legacy', amount: 999, date: '14.10.2026' }]; },
  ]) {
    const seed = await paidSeed(); employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
    const f = await fixture(seed);
    await f.editEmployee(2, data => edit(Object.values(data.Історія).flat()[0].Записи[0]));
    assert.throws(() => f.session.fragments(), /оплачен|виплат|зарплат|робот/i);
  }
});

test('an alias cannot reuse another historical or current work identity, including a removed row', async () => {
  for (const removed of [false, true]) {
    const seed = await paidSeed(); employeeAct(seed, 2).Записи[0].Розраховано = '14.10.2026';
    const f = await fixture(seed);
    await f.editEmployee(2, data => {
      const row = Object.values(data.Історія).flat()[0].Записи[0];
      row.__payroll_act_record_id = 'w2';
      if (removed) Object.assign(row, { __payroll_removed: true, Кількість: 0, Зарплата: 0,
        __payroll_payments: [{ id: 'legacy', amount: 300, date: '14.10.2026' }] });
    });
    assert.throws(() => f.session.fragments(), /ідентифікатор|відповідн|робот|однозначн/i);
  }
});
