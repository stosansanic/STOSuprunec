// Real PostgreSQL functions in local WASM. No production data/network calls.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const sql = name => fs.readFileSync(`supabase/migrations/${name}`, 'utf8');
const readMigration = sql('20261020061759_traffic_payroll_payments.sql');
const writeMigration = sql('20261020061804_payroll_payment_ledger.sql');
const expectedEntry = value => [{ date: '2026-08-14', value }];
const originalRow = () => ({
  recordId: 'row_new_1792221176241_vkc469iqi', Робота: 'Полоскання блоку циліндрів',
  Ціна: 50, Кількість: 1, Зарплата: 25, Записано: '17.10.2026', Розраховано: '17.10.2026',
});
const originalEntry = () => ({ Акт: '1274', Записи: [originalRow()], СуммаРоботи: 50, ДатаЗакриття: null });
const seed = () => [{ id: 'legacy', amount: 25, date: '17.10.2026' }];
let db;
let paymentHelpers;

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;
    create table acts(act_id integer primary key,data jsonb,date_on timestamp,date_off timestamp,
      pruimalnyk text,client_id integer,cars_id integer);
    create table slyusars(slyusar_id bigint primary key,data jsonb);
    create table act_locks(act_id integer primary key,heartbeat_at timestamptz);
    create table sclad(sclad_id bigint primary key,price numeric,"scladNomer" text,xto_zamovuv text);
    create function assert_editor_act_lease(integer,text) returns void language plpgsql as $$begin return;end$$;`);
  await db.exec(sql('20261011080000_payroll_fragments.sql'));
  await db.exec(sql('20261011090000_traffic_payroll_employees.sql'));
  await db.exec(sql('20261013105659_payroll_pending_recovery.sql'));
  const originalReport = sql('20261011130000_traffic_payroll_report.sql');
  await db.exec(originalReport.slice(0, originalReport.indexOf('create or replace function public.traffic_payroll_validate')));
  const search = sql('20261011040000_traffic_act_search.sql');
  await db.exec(search.slice(search.indexOf('create or replace function public.traffic_search_truthy'),
    search.indexOf('create or replace function public.traffic_search_trim')));
  await db.exec(readMigration);
  await db.exec(writeMigration);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/payrollPayments.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, structuredClone, Number, Date, Map, Set, JSON });
  paymentHelpers = exports;
});
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec('truncate acts,slyusars,act_locks,sclad;');
  await db.query('insert into acts values(1274,$1,\'2026-08-14 10:10:05\',null,\'Приймальник\',1,1)',
    [JSON.stringify({ __payroll_pending: false, __act_revision: 'r0', Роботи: [originalRow()], Деталі: [] })]);
  await db.query('insert into slyusars values(1,$1),(2,$2)', [
    JSON.stringify({ Name: 'Артем Д', Доступ: 'Слюсар', Телефон: 'private', Історія: {
      '2026-08-14': [originalEntry()], '2026-07-01': [{ Акт: '1200', Записи: [{ recordId: 'other', Зарплата: 999 }] }],
    } }),
    JSON.stringify({ Name: 'Інший слюсар', Доступ: 'Слюсар', Історія: {} }),
  ]);
});

async function readEmployee(id = 1) {
  return (await db.query('select data from slyusars where slyusar_id=$1', [id])).rows[0].data;
}
async function readEntry() { return (await readEmployee()).Історія['2026-08-14'][0]; }
async function writer(mode, changes, id = 1) {
  return (await db.query('select write_payroll_fragments($1,$2,$3::jsonb) r',
    [id, mode, JSON.stringify(changes)])).rows[0].r;
}
async function accrue(beforeValue, afterValue) {
  return writer('accrual', [{ act_id: 1274, expected: expectedEntry(beforeValue),
    desired: afterValue === null ? [] : expectedEntry(afterValue) }]);
}
async function summary(target, parent = null, from = '2026-01-01', to = '2026-12-31') {
  return (await db.query('select traffic_payroll_payment_summary($1::jsonb,$2::jsonb,$3,$4) r',
    [JSON.stringify(target), parent ? JSON.stringify(parent) : null, from, to])).rows[0].r;
}
function corrected(earned = 40, quantity = 1) {
  const entry = originalEntry();
  entry.Записи[0].Зарплата = earned;
  entry.Записи[0].Кількість = quantity;
  entry.Записи[0].__payroll_payments = seed();
  entry.СуммаРоботи = 50 * quantity;
  return entry;
}
function paymentChange(target, event, header = false) {
  const desired = { __payroll_payments: [...target.__payroll_payments, event] };
  if (Object.hasOwn(target, 'Розраховано')) desired.Розраховано = target.Розраховано;
  return { act_id: 1274, date: '2026-08-14', target: header ? 'act' : 'record',
    ...(header ? {} : { record_id: target.recordId, index: 0 }), expected: structuredClone(target), desired };
}
async function report(filters = {}) {
  return (await db.query('select traffic_payroll_report_v2($1::jsonb,0,true) r', [JSON.stringify({
    from: '2026-08-01', to: '2026-10-31', mode: 'open', page_size: 10, ...filters,
  })])).rows[0].r;
}

test('actual RPC corrects wage 25→40 and quantity, preserves paid25, pays only due15 and retries once', async () => {
  const unchangedEmployee = await readEmployee(2);
  const next = corrected(40, 2);
  assert.equal((await accrue(originalEntry(), next)).status, 'updated');
  assert.equal((await accrue(originalEntry(), next)).status, 'unchanged');
  let row = (await readEntry()).Записи[0];
  assert.deepEqual(await summary(row), {
    earned: 40, paidAmount: 25, due: 15, overpaid: 0, paidInPeriod: 25,
    hasPayment: true, hasPeriodPayment: true, lastActiveId: 'legacy', paidDate: '17.10.2026', paidIso: '2026-10-17',
  });
  const change = paymentChange(row, { id: 'payment-1', amount: 15, date: '20.10.2026' });
  assert.equal((await writer('payment', [change])).status, 'updated');
  assert.equal((await writer('payment', [change])).status, 'unchanged');
  row = (await readEntry()).Записи[0];
  assert.equal(row.Розраховано, '17.10.2026');
  assert.equal(row.__payroll_payments.length, 2);
  assert.equal((await summary(row)).paidAmount, 40);
  assert.equal((await summary(row)).due, 0);
  await assert.rejects(writer('payment', [{ ...change, desired: {
    ...change.desired, __payroll_payments: [...seed(), { id: 'payment-2', amount: 15, date: '20.10.2026' }],
  } }]), error => error.code === '40001');
  assert.deepEqual(await readEmployee(2), unchangedEmployee);
  assert.equal((await readEmployee()).Історія['2026-07-01'][0].Записи[0].Зарплата, 999);
  assert.equal((await readEmployee()).Телефон, 'private');
});

test('lowering wage 25→10 preserves paid25 and exposes overpayment15 without refund', async () => {
  const next = corrected(10);
  await accrue(originalEntry(), next);
  const row = (await readEntry()).Записи[0];
  const state = await summary(row);
  assert.equal(state.paidAmount, 25); assert.equal(state.overpaid, 15); assert.equal(state.due, 0);
  await assert.rejects(writer('payment', [paymentChange(row, { id: 'extra', amount: 1, date: '20.10.2026' })]),
    error => error.code === '55000');
  assert.deepEqual((await readEntry()).Записи[0].__payroll_payments, seed());
});

test('quantity-only corrections preserve old paid marker and need no ledger seed', async () => {
  const next = originalEntry();
  next.Записи[0].Кількість = 3; next.СуммаРоботи = 150;
  await accrue(originalEntry(), next);
  assert.equal((await summary((await readEntry()).Записи[0])).paidAmount, 25);
  assert.equal(Object.hasOwn((await readEntry()).Записи[0], '__payroll_payments'), false);
});

test('legacy whole mechanic payment seeds only affected child and protects root marker', async () => {
  const before = originalEntry();
  delete before.Записи[0].Розраховано; before.Розраховано = '17.10.2026';
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(before)]);
  const next = structuredClone(before);
  next.Записи[0].Зарплата = 40; next.Записи[0].__payroll_payments = seed();
  await accrue(before, next);
  const saved = await readEntry();
  assert.equal(Object.hasOwn(saved, '__payroll_payments'), false);
  assert.equal(Object.hasOwn(saved.Записи[0], 'Розраховано'), false);
  assert.equal((await summary(saved.Записи[0], saved)).due, 15);
  const whole = { act_id: 1274, date: '2026-08-14', target: 'act',
    expected: Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'Записи')), desired: {} };
  await assert.rejects(writer('payment', [whole]), error => error.code === '55000');
});

test('paid receiver correction seeds old earned commission and settles only remaining commission', async () => {
  const before = { Акт: '1274', СуммаРоботи: 100, СуммаЗапчастин: 0,
    ЗарплатаРоботи: 25, ЗарплатаЗапчастин: 0, __payroll_percent_work: 25, Розраховано: '17.10.2026' };
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(before)]);
  const next = { ...before, СуммаРоботи: 160, ЗарплатаРоботи: 40, __payroll_payments: seed() };
  await accrue(before, next);
  assert.equal((await summary(await readEntry())).due, 15);
  await writer('payment', [paymentChange(next, { id: 'commission-2', amount: 15, date: '20.10.2026' }, true)]);
  assert.equal((await summary(await readEntry())).paidAmount, 40);
});

test('explicit void appends audit event only to last active payment and leaves fully voided history protected', async () => {
  await accrue(originalEntry(), corrected());
  let row = (await readEntry()).Записи[0];
  await writer('payment', [paymentChange(row, { id: 'top-up', amount: 15, date: '20.10.2026' })]);
  row = (await readEntry()).Записи[0];
  await assert.rejects(writer('payment', [paymentChange(row, { id: 'wrong-void', voids: 'legacy', date: '20.10.2026' })]),
    error => error.code === '55000');
  const voidLast = paymentChange(row, { id: 'void-top-up', voids: 'top-up', date: '20.10.2026' });
  await writer('payment', [voidLast]); assert.equal((await writer('payment', [voidLast])).status, 'unchanged');
  row = (await readEntry()).Записи[0]; assert.equal((await summary(row)).due, 15);
  await writer('payment', [paymentChange(row, { id: 'void-legacy', voids: 'legacy', date: '20.10.2026' })]);
  const entry = await readEntry(); row = entry.Записи[0];
  assert.equal((await summary(row)).paidAmount, 0); assert.equal(row.__payroll_payments.length, 4);
  await assert.rejects(accrue(entry, null), error => error.code === '55000');
  const erase = structuredClone(entry); delete erase.Записи[0].__payroll_payments;
  await assert.rejects(accrue(entry, erase), error => error.code === '55000');
});

test('stale legacy payment clients cannot erase ledger, and malformed/surplus payment append fails', async () => {
  await accrue(originalEntry(), corrected());
  const row = (await readEntry()).Записи[0];
  const base = paymentChange(row, { id: 'pay', amount: 15, date: '20.10.2026' });
  for (const desired of [{}, { Розраховано: '20.10.2026' }, { Розраховано: false }]) {
    await assert.rejects(writer('payment', [{ ...base, desired }]), error => error.code === '55000');
  }
  for (const event of [
    { id: 'pay', amount: 40, date: '20.10.2026' },
    { id: 'pay', amount: -15, date: '20.10.2026' },
    { id: 'pay', amount: 15, date: '31.02.2026' },
    { id: 'legacy', amount: 15, date: '20.10.2026' },
    { id: 'pay', amount: 15, date: '20.10.2026', extra: true },
  ]) await assert.rejects(writer('payment', [paymentChange(row, event)]), error => error.code === '55000');
  assert.deepEqual((await readEntry()).Записи[0], row);
});

test('accrual rejects injected, changed, deleted or transferred payment history and rejects changing work identity', async () => {
  const unpaid = originalEntry(); delete unpaid.Записи[0].Розраховано;
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(unpaid)]);
  const fake = structuredClone(unpaid); fake.Записи[0].__payroll_payments = seed();
  await assert.rejects(accrue(unpaid, fake), error => error.code === '55000');
  await assert.rejects(writer('accrual', [{ act_id: 1274, expected: [], desired: expectedEntry(fake) }], 2),
    error => error.code === '55000');
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(originalEntry())]);
  for (const mutate of [
    row => { row.recordId = 'another'; }, row => { row.Робота = 'Another work'; },
    row => { row.Розраховано = '20.10.2026'; }, row => { row.__payroll_payments[0].amount = 40; },
  ]) {
    const next = corrected(); mutate(next.Записи[0]);
    await assert.rejects(accrue(originalEntry(), next), error => error.code === '55000');
  }
  const newRow = originalEntry(); newRow.Записи.push({ ...originalRow(), recordId: 'injected', __payroll_payments: seed() });
  await assert.rejects(accrue(originalEntry(), newRow), error => error.code === '55000');
});

test('accrual cannot forge legacy paid markers on new acts, new works, or existing unpaid wages', async () => {
  const unpaid = originalEntry(); delete unpaid.Записи[0].Розраховано;
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(unpaid)]);
  for (const mutate of [
    next => { next.Розраховано = '20.10.2026'; },
    next => { next.Записи[0].Розраховано = '20.10.2026'; },
    next => { next.Записи.push({ ...originalRow(), recordId: 'forged' }); },
  ]) {
    const next = structuredClone(unpaid); mutate(next);
    await assert.rejects(accrue(unpaid, next), error => error.code === '55000');
    await assert.rejects(writer('accrual', [{ act_id: 1274, expected: [], desired: expectedEntry(next) }], 2),
      error => error.code === '55000');
  }
  const normalized = structuredClone(unpaid);
  normalized.Розраховано = false; normalized.Записи[0].Розраховано = null;
  await accrue(unpaid, normalized);
  assert.equal((await summary(normalized.Записи[0], normalized)).hasPayment, false);
});

test('paid accrual validates both old and new numbers and only accepts numeric changed fields', async () => {
  for (const mutate of [
    row => { row.Кількість = -1; },
    row => { row.Кількість = '2'; },
    row => { row.Ціна = '60'; },
    row => { row.Зарплата = '40'; },
  ]) {
    const next = corrected(); mutate(next.Записи[0]);
    await assert.rejects(accrue(originalEntry(), next), error => error.code === '55000');
  }
  const malformed = originalEntry(); malformed.Записи[0].Ціна = 'invalid';
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(malformed)]);
  await assert.rejects(accrue(malformed, corrected()), error => error.code === '55000');
  const negative = originalEntry(); negative.Записи[0].Кількість = -1; negative.СуммаРоботи = 0;
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(negative)]);
  const next = structuredClone(negative); next.Записи[0].Зарплата = 40; next.Записи[0].__payroll_payments = seed();
  await accrue(negative, next);
  assert.equal((await summary((await readEntry()).Записи[0])).due, 15);
});

test('paid header cannot change role discriminator, inject work salary, or exceed discount bounds', async () => {
  const mechanic = originalEntry(); mechanic.Розраховано = '17.10.2026';
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(mechanic)]);
  await assert.rejects(accrue(mechanic, { ...mechanic, Зарплата: 999 }), error => error.code === '55000');
  const missingTotal = structuredClone(mechanic); delete missingTotal.СуммаРоботи;
  await assert.rejects(accrue(mechanic, missingTotal), error => error.code === '55000');
  const header = Object.fromEntries(Object.entries(mechanic).filter(([key]) => key !== 'Записи'));
  await assert.rejects(writer('payment', [{
    act_id: 1274, date: '2026-08-14', target: 'act', expected: header,
    desired: { Розраховано: '17.10.2026', __payroll_payments: [{ id: 'header-pay', amount: 25, date: '20.10.2026' }] },
  }]), error => error.code === '55000');
  const receiver = { Акт: '1274', СуммаРоботи: 100, ЗарплатаРоботи: 25, Знижка: 0, Розраховано: '17.10.2026' };
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(receiver)]);
  await assert.rejects(accrue(receiver, { ...receiver, Знижка: 101 }), error => error.code === '55000');
  await assert.rejects(accrue(receiver, { ...receiver, Зарплата: 25 }), error => error.code === '55000');
});

test('report keeps earned amount while paid periods and balance filters use actual active payments', async () => {
  await accrue(originalEntry(), corrected());
  let result = await report({ payment: 'unpaid' });
  assert.equal(result.total, 1); assert.equal(result.salary, 40); assert.equal(result.paidAmount, 25);
  assert.equal(result.due, 15); assert.equal(result.overpaid, 0);
  const row = (await readEntry()).Записи[0];
  await writer('payment', [paymentChange(row, { id: 'pay-20', amount: 15, date: '20.10.2026' })]);
  result = await report({ mode: 'paid', from: '2026-10-17', to: '2026-10-17' });
  assert.equal(result.total, 1); assert.equal(result.salary, 40); assert.equal(result.paidInPeriod, 25);
  result = await report({ mode: 'paid', from: '2026-10-20', to: '2026-10-20' });
  assert.equal(result.total, 1); assert.equal(result.paidInPeriod, 15);
  assert.equal(result.employees[0].data.Історія['2026-08-14'][0].Записи[0].__payroll_payments.length, 2);
  assert.equal((await report({ payment: 'unpaid' })).total, 0);
  assert.equal((await report({ payment: 'paid' })).total, 1);
  const paidRow = (await readEntry()).Записи[0];
  await writer('payment', [paymentChange(paidRow, { id: 'undo-20', voids: 'pay-20', date: '20.10.2026' })]);
  assert.equal((await report({ mode: 'paid', from: '2026-10-20', to: '2026-10-20' })).total, 0);
});

test('zero quantity and earned salary retain previously paid money and overpayment in report', async () => {
  await accrue(originalEntry(), corrected(0, 0));
  const result = await report();
  assert.equal(result.total, 1); assert.equal(result.salary, 0);
  assert.equal(result.paidAmount, 25); assert.equal(result.overpaid, 25);
});

test('zero amount legacy payment still counts as a payment when quantity and wage are zero', async () => {
  const zero = originalEntry(); zero.Записи[0].Кількість = 0; zero.Записи[0].Зарплата = 0; zero.СуммаРоботи = 0;
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-08-14,0}',$1) where slyusar_id=1", [JSON.stringify(zero)]);
  const result = await report({ mode: 'paid', from: '2026-10-17', to: '2026-10-17', payment: 'paid' });
  assert.equal(result.total, 1); assert.equal(result.salary, 0); assert.equal(result.paidInPeriod, 0);
});

test('signed money rounding and earned formulas match browser helpers', async () => {
  for (const target of [
    { Зарплата: 0.005, __payroll_payments: [{ id: 'legacy', amount: 0.01, date: '17.10.2026' }] },
    { Зарплата: 0.015, __payroll_payments: [{ id: 'legacy', amount: 0.01, date: '17.10.2026' }] },
    { СуммаРоботи: -1, ЗарплатаРоботи: 10, ЗарплатаЗапчастин: 5, Розраховано: '17.10.2026' },
    { СуммаЗапчастин: 0, ЗарплатаЗапчастин: 10, Розраховано: '17.10.2026' },
    { ЗарплатаРоботи: 10, ЗарплатаЗапчастин: 5, Розраховано: '17.10.2026' },
  ]) {
    const browser = paymentHelpers.getPayrollPaymentState(target);
    const server = await summary(target);
    for (const key of ['earned', 'paidAmount', 'due', 'overpaid']) assert.equal(server[key], browser[key], key);
  }
});

test('commit_act_payroll retains atomic baseline/employee completeness and only changes affected employee', async () => {
  await db.exec("update acts set data=data||'{\"__payroll_pending\":true}'::jsonb where act_id=1274");
  const context = (await db.query('select payroll_recovery_context(1274) r')).rows[0].r;
  const next = corrected();
  const employees = [
    { id: 1, settings: { Name: 'Артем Д', Доступ: 'Слюсар' }, expected: expectedEntry(originalEntry()), desired: expectedEntry(next) },
    { id: 2, settings: { Name: 'Інший слюсар', Доступ: 'Слюсар' }, expected: [], desired: [] },
  ];
  const commit = async entries => (await db.query(
    'select commit_act_payroll(1274,$1,$2,$3,$4,$5::jsonb,null,\'[]\'::jsonb) r',
    [context.checksum, context.context_checksum, context.revision, 'r1', JSON.stringify(entries)])).rows[0].r;
  await assert.rejects(commit([employees[0]]), error => error.code === '40001');
  const stale = structuredClone(employees); stale[0].expected[0].value.СуммаРоботи = 999;
  await assert.rejects(commit(stale), error => error.code === '40001');
  assert.deepEqual(await readEntry(), originalEntry());
  const unchangedEmployee = await readEmployee(2);
  const receipt = await commit(employees);
  assert.equal(receipt.employees_changed, 1);
  assert.deepEqual(await readEmployee(2), unchangedEmployee);
  assert.equal((await db.query('select data from acts where act_id=1274')).rows[0].data.__payroll_pending, false);
  assert.equal((await commit(employees)).status, 'unchanged');
});

test('RLS denied update rolls back the ledger and authentic read/report respects existing policies', async () => {
  await db.exec(`grant select,update on acts,slyusars to authenticated;
    alter table slyusars enable row level security;
    create policy payroll_read_test on slyusars for select to authenticated using(slyusar_id=1);
    create policy payroll_write_test on slyusars for update to authenticated using(true) with check(false);
    set role authenticated;`);
  try {
    await assert.rejects(accrue(originalEntry(), corrected()), /row-level security/);
    const result = await report();
    assert.equal(result.employees.length, 1); assert.equal(result.employees[0].slyusar_id, 1);
  } finally {
    await db.exec('reset role;drop policy payroll_read_test on slyusars;drop policy payroll_write_test on slyusars;alter table slyusars disable row level security;');
  }
  assert.deepEqual(await readEntry(), originalEntry());
});

test('both migrations can be reapplied without data changes or downgrading ledger report/writer', async () => {
  await accrue(originalEntry(), corrected());
  const employee = await readEmployee();
  await db.exec(readMigration); await db.exec(writeMigration);
  assert.deepEqual(await readEmployee(), employee);
  assert.equal((await report()).due, 15);
  const row = (await readEntry()).Записи[0];
  await writer('payment', [paymentChange(row, { id: 'after-reinstall', amount: 15, date: '20.10.2026' })]);
  assert.equal((await report()).due, 0);
});

test('complete generated repair bundle installs and reapplies without modifying data', async () => {
  const repair = fs.readFileSync('supabase/setup/traffic-optimization/payroll-payment-ledger-repair.sql', 'utf8');
  await accrue(originalEntry(), corrected());
  const employee = await readEmployee();
  await db.exec(repair); await db.exec(repair);
  assert.deepEqual(await readEmployee(), employee);
  assert.equal((await report()).due, 15);
  const row = (await readEntry()).Записи[0];
  await writer('payment', [paymentChange(row, { id: 'after-full-repair', amount: 15, date: '20.10.2026' })]);
  assert.equal((await report()).due, 0);
});
