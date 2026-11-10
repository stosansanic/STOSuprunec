const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const context = { exports: {}, structuredClone };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/utils/payrollPayments.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const api = context.exports;
const copy = structuredClone;
const old = () => ({ recordId: 'row_new_1792221176241_vkc469iqi', Робота: 'Полоскання блоку циліндрів',
  Ціна: 1, Кількість: 1, Зарплата: 25, Розраховано: '17.10.2026', Записано: '17.10.2026' });
const corrected = salary => api.preservePayrollPaymentHistory(old(), { ...old(), Ціна: 50, Зарплата: salary });

test('accrual accepts identical payment events with JSON object keys in a different order', () => {
  const previous = corrected(40);
  const next = { ...previous, Зарплата: 50, __payroll_payments: [
    { date: '17.10.2026', amount: 25, id: 'legacy' },
  ] };
  const result = api.preservePayrollPaymentHistory(previous, next);
  assert.deepEqual(copy(result.__payroll_payments), copy(previous.__payroll_payments));
  assert.equal(api.getPayrollPaymentState(result).due, 25);
});

test('changing earned wage 25→40 preserves paid 25 and yields only 15 due', () => {
  const row = corrected(40), state = api.getPayrollPaymentState(row);
  assert.deepEqual(copy(row.__payroll_payments), [{ id: 'legacy', amount: 25, date: '17.10.2026' }]);
  assert.equal(state.earned, 40); assert.equal(state.paidAmount, 25); assert.equal(state.due, 15);
  assert.equal(state.overpaid, 0); assert.equal(state.isPaid, false);
  assert.equal(row.Розраховано, '17.10.2026');
});

test('lower earned wage shows overpayment without a fabricated refund', () => {
  const state = api.getPayrollPaymentState(corrected(10));
  assert.equal(state.paidAmount, 25); assert.equal(state.due, 0); assert.equal(state.overpaid, 15);
  assert.equal(state.isPaid, true); assert.equal(state.payments.length, 1);
});

test('same earnings after price and quantity changes do not invent a ledger', () => {
  const row = api.preservePayrollPaymentHistory(old(), { ...old(), Ціна: 50, Кількість: 2 });
  assert.equal(row.__payroll_payments, undefined);
  assert.equal(api.getPayrollPaymentState(row).paidAmount, 25);
});

test('pay remainder appends exactly one payment and retains original paid date', () => {
  const row = api.applyPayrollPayment(corrected(40), null, '20.10.2026', 'pay-2', 'pay');
  assert.deepEqual(copy(row.__payroll_payments[1]), { id: 'pay-2', amount: 15, date: '20.10.2026' });
  assert.equal(api.getPayrollPaymentState(row).due, 0);
  assert.equal(row.Розраховано, '17.10.2026');
  assert.throws(() => api.applyPayrollPayment(row, null, '20.10.2026', 'pay-3', 'pay'), /суми/);
});

test('void appends an audit event and restores due without erasing payments', () => {
  const paid = api.applyPayrollPayment(corrected(40), null, '20.10.2026', 'pay-2', 'pay');
  const row = api.applyPayrollPayment(paid, null, '20.10.2026', 'void-2', 'void');
  assert.equal(row.__payroll_payments.length, 3);
  assert.deepEqual(copy(row.__payroll_payments[2]), { id: 'void-2', voids: 'pay-2', date: '20.10.2026' });
  assert.equal(api.getPayrollPaymentState(row).paidAmount, 25);
  assert.equal(api.getPayrollPaymentState(row).due, 15);
});

test('fully voided ledger remains attached through later accrual changes', () => {
  const row = api.applyPayrollPayment(corrected(40), null, '20.10.2026', 'void-legacy', 'void');
  const updated = api.preservePayrollPaymentHistory(row, { ...row, Зарплата: 50 });
  assert.deepEqual(copy(updated.__payroll_payments), copy(row.__payroll_payments));
  assert.equal(api.getPayrollPaymentState(updated).hasLedger, true);
  assert.equal(api.getPayrollPaymentState(updated).hasPayments, false);
  assert.equal(api.getPayrollPaymentState(updated).due, 50);
});

test('parent-paid work seeds its own old wage and preserves absent row marker', () => {
  const previous = old(); delete previous.Розраховано;
  const parent = { Розраховано: '17.10.2026' };
  const row = api.preservePayrollPaymentHistory(previous, { ...previous, Зарплата: 30 }, parent);
  assert.equal(row.Розраховано, undefined);
  assert.equal(api.getPayrollPaymentState(row, parent).paidAmount, 25);
  const voided = api.applyPayrollPayment(previous, parent, '20.10.2026', 'void', 'void');
  assert.equal(voided.Розраховано, undefined); assert.equal(api.getPayrollPaymentState(voided, parent).paidAmount, 0);
});

test('legacy payment buttons keep their original date-only shape', () => {
  const unpaid = old(); delete unpaid.Розраховано;
  const paid = api.applyPayrollPayment(unpaid, null, '20.10.2026', 'id', 'pay');
  assert.equal(paid.__payroll_payments, undefined); assert.equal(paid.Розраховано, '20.10.2026');
  const voided = api.applyPayrollPayment(paid, null, '20.10.2026', 'void', 'void');
  assert.equal(Object.hasOwn(voided, 'Розраховано'), false);
});

test('period totals count active payments only and choose the latest matching date', () => {
  let row = api.applyPayrollPayment(corrected(40), null, '20.10.2026', 'pay-2', 'pay');
  assert.deepEqual(copy(api.getPayrollPaymentInPeriod(row, null, '2026-10-18', '2026-10-20')), { amount: 15, date: '20.10.2026' });
  row = api.applyPayrollPayment(row, null, '20.10.2026', 'void', 'void');
  assert.deepEqual(copy(api.getPayrollPaymentInPeriod(row, null, '2026-10-18', '2026-10-20')), { amount: 0, date: null });
});

test('recipient earnings preserve historical role formulas and ignore other employee expense', () => {
  assert.equal(api.getPayrollEarned({ СуммаРоботи: 100, ЗарплатаРоботи: 20, ЗарплатаЗапчастин: 5, ЗарплатаЗапчастистів: 90 }), 25);
  assert.equal(api.getPayrollEarned({ СуммаРоботи: -100, ЗарплатаРоботи: 20, ЗарплатаЗапчастин: 5 }), 5);
  assert.equal(api.getPayrollEarned({ СуммаЗапчастин: -100, ЗарплатаЗапчастин: 5 }), 0);
  assert.equal(api.getPayrollEarned({ ЗарплатаРоботи: 20, ЗарплатаЗапчастин: 5 }), 25);
});

test('money rounds balances to kopecks but retains original exact legacy payment amount', () => {
  const previous = { ...old(), Зарплата: 0.105 };
  const row = api.preservePayrollPaymentHistory(previous, { ...previous, Зарплата: 0.3 });
  assert.equal(row.__payroll_payments[0].amount, 0.105);
  assert.equal(api.getPayrollPaymentState(row).paidAmount, 0.11);
  assert.equal(api.getPayrollPaymentState(row).due, 0.19);
});

for (const ledger of [
  [{ id: 'p', amount: 25, date: '17.10.2026', extra: true }],
  [{ id: 'p', amount: -25, date: '17.10.2026' }],
  [{ id: 'p', amount: 25, date: '17.10.2026' }, { id: 'p', amount: 5, date: '17.10.2026' }],
  [{ id: 'v', voids: 'missing', date: '20.10.2026' }],
  [{ id: 'p1', amount: 25, date: '17.10.2026' }, { id: 'p2', amount: 5, date: '17.10.2026' }, { id: 'v', voids: 'p1', date: '20.10.2026' }],
]) test('malformed or reordered payment events are rejected: ' + JSON.stringify(ledger), () => {
  assert.throws(() => api.getPayrollPaymentState({ ...old(), __payroll_payments: ledger }), /Некоректн/);
});

test('accrual cannot remove, append, or rewrite acknowledged payment events', () => {
  const previous = corrected(40);
  const removed = { ...previous }; delete removed.__payroll_payments;
  assert.throws(() => api.preservePayrollPaymentHistory(previous, removed), /виплат/);
  assert.throws(() => api.preservePayrollPaymentHistory(previous, { ...previous, __payroll_payments: [] }), /виплат/);
  assert.throws(() => api.preservePayrollPaymentHistory(previous, { ...previous, __payroll_payments: [{ id: 'legacy', amount: 40, date: '17.10.2026' }] }), /виплат/);
});

test('new payment dates must be actual calendar dates', () => {
  for (const date of ['31.02.2026', '2026-13-10', 'today', '']) {
    assert.throws(() => api.applyPayrollPayment(corrected(40), null, date, 'pay', 'pay'), /дата/);
  }
});
