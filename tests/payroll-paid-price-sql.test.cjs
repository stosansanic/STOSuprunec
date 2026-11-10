// PostgreSQL guard checks in a local WASM database; no production/network calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const migration = fs.readFileSync('supabase/migrations/20261020055020_payroll_paid_price_correction.sql', 'utf8');
const previousMigration = fs.readFileSync('supabase/migrations/20261013105659_payroll_pending_recovery.sql', 'utf8');
const previousStart = previousMigration.indexOf('create or replace function public.assert_payroll_paid_preserved');
const previousEnd = previousMigration.indexOf('create or replace function public.commit_act_payroll', previousStart);
let db;

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  assert.ok(previousStart >= 0 && previousEnd > previousStart, 'Install the actual prior guard before replacing it');
  await db.exec(previousMigration.slice(previousStart, previousEnd));
  await db.exec(migration);
});
after(async () => { if (db) await db.close(); });

function priceCorrection({ headerPaid = false, existingSum = false } = {}) {
  const row = {
    recordId: 'row_new_1792221176241_vkc469iqi', Робота: 'Полоскання блоку циліндрів',
    Кількість: 1, Ціна: 1, Зарплата: 25, Розраховано: '17.10.2026',
    Записано: '14.08.2026', Примітка: 'Історична позначка',
  };
  if (existingSum) row.Сума = 1;
  const value = { Акт: '1274', Записи: [row], СуммаРоботи: 1, ДатаЗакриття: null };
  if (headerPaid) value.Розраховано = '17.10.2026';
  const expected = [{ date: '2026-08-14', value }];
  const desired = structuredClone(expected);
  desired[0].value.Записи[0].Ціна = 50;
  if (existingSum) desired[0].value.Записи[0].Сума = 50;
  desired[0].value.СуммаРоботи = 50;
  return { expected, desired };
}

async function guard(expected, desired) {
  await db.query('select public.assert_payroll_paid_preserved($1::jsonb, $2::jsonb)',
    [JSON.stringify(expected), JSON.stringify(desired)]);
}
async function rejectGuard(expected, desired) {
  await assert.rejects(guard(expected, desired), error => {
    assert.equal(error.code, '55000', `The paid-payroll guard must reject, not a SQL/runtime failure: ${error.message}`);
    return true;
  });
}

for (const headerPaid of [false, true]) for (const existingSum of [false, true]) {
  test(`SQL accepts act 1274 customer price correction and its exact retry (paid header=${headerPaid}, sum=${existingSum})`, async () => {
    const { expected, desired } = priceCorrection({ headerPaid, existingSum });
    await guard(expected, desired);
    await guard(desired, desired);
    desired[0].value.ДатаЗакриття = '2026-10-20';
    desired[0].value.Клієнт = 'Уточнений підпис';
    await guard(expected, desired);
    assert.equal(desired[0].value.Записи[0].Зарплата, 25);
    assert.equal(desired[0].value.Записи[0].Розраховано, '17.10.2026');
  });
}

test('SQL accepts corrected numeric customer price while retaining historical wage and quantity strings', async () => {
  const { expected, desired } = priceCorrection({ headerPaid: true, existingSum: true });
  Object.assign(expected[0].value.Записи[0], { Ціна: '1', Сума: '1', Кількість: '1', Зарплата: '25' });
  Object.assign(desired[0].value.Записи[0], { Кількість: '1', Зарплата: '25' });
  expected[0].value.СуммаРоботи = '1';
  await guard(expected, desired);
});

for (const quantity of [3, -3]) test(`SQL preserves JavaScript product precision and rounded header total for quantity ${quantity}`, async () => {
  const { expected, desired } = priceCorrection({ headerPaid: true, existingSum: true });
  Object.assign(expected[0].value.Записи[0], { Кількість: quantity, Сума: quantity });
  expected[0].value.СуммаРоботи = Math.max(0, quantity);
  Object.assign(desired[0].value.Записи[0], { Кількість: quantity, Ціна: 0.1, Сума: 0.1 * quantity });
  desired[0].value.СуммаРоботи = Math.max(0, Math.round((0.1 * quantity + Number.EPSILON) * 100) / 100);
  await guard(expected, desired);
});

for (const [name, change] of [
  ['salary', row => { row.Зарплата = 26; }],
  ['quantity', row => { row.Кількість = 2; }],
  ['work name', row => { row.Робота = 'Інша робота'; }],
  ['record ID', row => { row.recordId = 'different-work'; }],
  ['paid date', row => { row.Розраховано = '18.10.2026'; }],
  ['paid flag deletion', row => { delete row.Розраховано; }],
  ['recorded date', row => { row.Записано = '20.10.2026'; }],
  ['unknown metadata', row => { row.Примітка = 'Змінено'; }],
]) test(`SQL rejects price correction that also changes ${name}`, async () => {
  const { expected, desired } = priceCorrection();
  change(desired[0].value.Записи[0]);
  await rejectGuard(expected, desired);
});

for (const price of [-1, null, 'NaN', 'Infinity', '-Infinity', 'invalid']) {
  test(`SQL rejects an invalid corrected customer price ${JSON.stringify(price)}`, async () => {
    const { expected, desired } = priceCorrection();
    desired[0].value.Записи[0].Ціна = price;
    await rejectGuard(expected, desired);
  });
}

test('SQL requires a matching nonempty ID for a price correction', async () => {
  const { expected, desired } = priceCorrection();
  delete expected[0].value.Записи[0].recordId;
  delete desired[0].value.Записи[0].recordId;
  await rejectGuard(expected, desired);
});

test('SQL rejects a paid row removal, transfer, or duplicate', async () => {
  const { expected, desired } = priceCorrection();
  await rejectGuard(expected, []);
  await rejectGuard(expected, [{ ...desired[0], value: { ...desired[0].value, Записи: [] } }]);
  desired[0].value.Записи.push(structuredClone(desired[0].value.Записи[0]));
  await rejectGuard(expected, desired);
});

test('SQL preserves an existing customer total and forbids inventing a missing total', async () => {
  let { expected, desired } = priceCorrection({ existingSum: true });
  desired[0].value.Записи[0].Сума = 49;
  await rejectGuard(expected, desired);
  delete desired[0].value.Записи[0].Сума;
  await rejectGuard(expected, desired);
  ({ expected, desired } = priceCorrection());
  desired[0].value.Записи[0].Сума = 50;
  await rejectGuard(expected, desired);
});

test('SQL cannot repair a row total without a customer price correction', async () => {
  const { expected, desired } = priceCorrection({ existingSum: true });
  desired[0].value.Записи[0].Ціна = 1;
  await rejectGuard(expected, desired);
});

test('SQL cannot change the paid-header customer total while all rows remain unchanged', async () => {
  const { expected } = priceCorrection({ headerPaid: true });
  const desired = structuredClone(expected);
  desired[0].value.СуммаРоботи = 50;
  await rejectGuard(expected, desired);
});

test('SQL rejects paid-header salary, payment, unknown metadata, or inconsistent customer total changes', async () => {
  for (const change of [
    value => { value.Зарплата = 30; },
    value => { value.Розраховано = false; },
    value => { value.Примітка = 'Змінено'; },
    value => { value.СуммаРоботи = 51; },
  ]) {
    const { expected, desired } = priceCorrection({ headerPaid: true });
    change(desired[0].value);
    await rejectGuard(expected, desired);
  }
});

test('SQL cannot use customer-price exception to recalculate a paid receiver commission', async () => {
  const expected = [{ date: '2026-08-14', value: {
    Акт: '1274', СуммаРоботи: 1, ЗарплатаРоботи: 0, __payroll_percent_work: 20, Розраховано: '17.10.2026',
  } }];
  const desired = structuredClone(expected);
  Object.assign(desired[0].value, { СуммаРоботи: 50, ЗарплатаРоботи: 5 });
  await rejectGuard(expected, desired);
});

test('SQL keeps the original date bucket immutable for every paid correction', async () => {
  const { expected, desired } = priceCorrection();
  desired[0].date = '2026-10-20';
  await rejectGuard(expected, desired);
});

test('SQL rejects malformed legacy IDs and unknown paid wages instead of guessing their meaning', async () => {
  for (const invalidId of [true, { id: 'w1' }, ['w1'], '']) {
    const { expected, desired } = priceCorrection();
    expected[0].value.Записи[0].recordId = invalidId;
    desired[0].value.Записи[0].recordId = structuredClone(invalidId);
    await rejectGuard(expected, desired);
  }
  for (const unknownWage of [null, 'NaN', 'Infinity', -1]) {
    const { expected, desired } = priceCorrection();
    expected[0].value.Записи[0].Зарплата = unknownWage;
    desired[0].value.Записи[0].Зарплата = unknownWage;
    await rejectGuard(expected, desired);
  }
});

test('SQL grants authenticated callers the guard and its helpers without granting anonymous execution', async () => {
  const { expected, desired } = priceCorrection();
  try {
    await db.exec('set role authenticated');
    await guard(expected, desired);
    desired[0].value.Записи[0].Зарплата = 26;
    await rejectGuard(expected, desired);
  } finally {
    await db.exec('reset role');
  }
  try {
    await db.exec('set role anon');
    await assert.rejects(guard(expected, desired), error => {
      assert.equal(error.code, '42501');
      return true;
    });
  } finally {
    await db.exec('reset role');
  }
});

test('SQL migration can be reapplied and keeps the payment protection active', async () => {
  await db.exec(migration);
  const { expected, desired } = priceCorrection();
  await guard(expected, desired);
  desired[0].value.Записи[0].Розраховано = false;
  await rejectGuard(expected, desired);
});
