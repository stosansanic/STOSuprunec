// Actual PostgreSQL guards, writer and current report in local WASM only.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || '@electric-sql/pglite');
const sql = name => fs.readFileSync(`supabase/migrations/${name}`, 'utf8');
const migrationName = '20261106071013_payroll_work_edit_preserve_payments.sql';
const migration = () => sql(migrationName);
const copy = structuredClone;
const fragments = value => value == null ? [] : [{ date: '2026-10-09', value }];
const paidEvents = () => [{ id: 'legacy', amount: 100, date: '14.10.2026' }];
const paidRow = () => ({ recordId: 'artem-old', Робота: 'Полоскання блоку циліндрів', Ціна: 200,
  Кількість: 1, Зарплата: 100, Сума: 200, Записано: '09.10.2026', Розраховано: '14.10.2026' });
const entry = rows => ({ Акт: '1533', Записи: rows || [paidRow()],
  СуммаРоботи: (rows || [paidRow()]).reduce((sum, row) => sum + Number(row.Ціна) * Number(row.Кількість), 0), ДатаЗакриття: null });
const tombstone = () => ({ ...paidRow(), __payroll_removed: true, Кількість: 0, Зарплата: 0, Сума: 0,
  __payroll_payments: paidEvents() });
const correctedRow = () => ({ ...paidRow(), __payroll_act_record_id: 'artem-readded', Зарплата: 25,
  __payroll_payments: paidEvents() });
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;
    create table acts(act_id integer primary key,data jsonb,date_on timestamp,date_off timestamp,
      pruimalnyk text,client_id integer,cars_id integer);
    create table slyusars(slyusar_id bigint primary key,data jsonb);
    create table act_locks(act_id integer primary key,heartbeat_at timestamptz);
    create table sclad(sclad_id bigint primary key,price numeric,"scladNomer" text,xto_zamovuv text);
    create function assert_editor_act_lease(integer,text) returns void language plpgsql as $$begin return;end$$;
    create function traffic_resource_revision(text[]) returns text language sql stable as
      $$select md5(coalesce(string_agg(data::text,'' order by slyusar_id),'')) from slyusars$$;`);
  await db.exec(sql('20261011080000_payroll_fragments.sql'));
  await db.exec(sql('20261011090000_traffic_payroll_employees.sql'));
  await db.exec(sql('20261013105659_payroll_pending_recovery.sql'));
  const originalReport = sql('20261011130000_traffic_payroll_report.sql');
  await db.exec(originalReport.slice(0, originalReport.indexOf('create or replace function public.traffic_payroll_validate')));
  const search = sql('20261011040000_traffic_act_search.sql');
  await db.exec(search.slice(search.indexOf('create or replace function public.traffic_search_truthy'),
    search.indexOf('create or replace function public.traffic_search_trim')));
  await db.exec(sql('20261020061759_traffic_payroll_payments.sql'));
  await db.exec(sql('20261020061804_payroll_payment_ledger.sql'));
  const freeze = sql('20261025064857_act_freeze_payroll_archive.sql');
  const writerStart = freeze.indexOf('create or replace function public.write_payroll_fragments(');
  assert.ok(writerStart >= 0);
  await db.exec(freeze.slice(writerStart, freeze.indexOf("notify pgrst", writerStart)));
  const reports = sql('20261023083651_accounting_resource_revisions.sql');
  const reportStart = reports.indexOf('create or replace function public.traffic_payroll_report_v4(');
  assert.ok(reportStart >= 0);
  await db.exec(reports.slice(reportStart, reports.indexOf('create or replace function public.traffic_shop_report_v4(', reportStart)));
  await db.exec(migration()); // Also executes the migration's transactional self-checks.
});
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec('truncate acts,slyusars,act_locks,sclad;');
  await db.query("insert into acts values(1533,$1,'2026-10-09 10:00:00',null,'Приймальник',null,null)",
    [JSON.stringify({ __payroll_pending: false, __act_revision: 'r0', Роботи: [paidRow()], Деталі: [] })]);
  await db.query('insert into slyusars values(1,$1),(2,$2)', [
    JSON.stringify({ Name: 'Артем Д', Доступ: 'Слюсар', Історія: { '2026-10-09': [entry()] } }),
    JSON.stringify({ Name: 'Рак', Доступ: 'Слюсар', Історія: { '2026-10-09': [entry([{
      recordId: 'rak-work', Робота: 'Шліфування колінвала', Ціна: 200, Кількість: 1, Зарплата: 100,
    }])] } }),
  ]);
});

async function employee(id = 1) {
  return (await db.query('select data from slyusars where slyusar_id=$1', [id])).rows[0].data;
}
async function readEntry(id = 1) { return (await employee(id)).Історія['2026-10-09'][0]; }
async function storeEntry(value, id = 1) {
  await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-10-09,0}',$1::jsonb) where slyusar_id=$2",
    [JSON.stringify(value), id]);
}
async function guard(previous, next) {
  return db.query('select assert_payroll_paid_preserved($1::jsonb,$2::jsonb)',
    [JSON.stringify(fragments(previous)), JSON.stringify(fragments(next))]);
}
async function accrue(previous, next, id = 1) {
  return (await db.query("select write_payroll_fragments($1,'accrual',$2::jsonb) r", [id, JSON.stringify([
    { act_id: 1533, expected: fragments(previous), desired: fragments(next) },
  ])])).rows[0].r;
}
async function report(filters = {}) {
  return (await db.query('select traffic_payroll_report_v4($1::jsonb,0,true,true,null) r', [JSON.stringify({
    from: '2026-10-01', to: '2026-10-31', mode: 'open', page_size: 50, ...filters,
  })])).rows[0].r;
}
async function rejectUnchanged(previous, next, code = '55000') {
  const before = await employee();
  await assert.rejects(accrue(previous, next), error => {
    assert.equal(error.code, code, `Expected a financial guard failure, received: ${error.message}`);
    return true;
  });
  assert.deepEqual(await employee(), before);
}

test('act1533 correction preserves paid100, reports Artem25 plus Rak100 and retries without another mutation', async () => {
  const other = await employee(2), corrected = entry([correctedRow()]);
  assert.equal((await accrue(entry(), corrected)).status, 'updated');
  const acknowledged = await employee();
  assert.equal((await accrue(entry(), corrected)).status, 'unchanged');
  assert.deepEqual(await employee(), acknowledged); assert.deepEqual(await employee(2), other);
  const result = await report();
  assert.equal(result.salary, 125); assert.equal(result.paidAmount, 100);
  assert.equal(result.due, 100); assert.equal(result.overpaid, 75); assert.equal(result.revenue, 400);
  const paid = await report({ mode: 'paid', from: '2026-10-14', to: '2026-10-14' });
  assert.equal(paid.total, 1); assert.equal(paid.paidInPeriod, 100);
  assert.deepEqual((await readEntry()).Записи[0].__payroll_payments, paidEvents());
});

test('reported act1533 commits distinct Artem D and Artem atomically and never transfers the paid100', async () => {
  const old = { ...paidRow(), recordId: 'row_new_1792223113521_pup3qz32p', Робота: 'Миття ГБЦ', Ціна: 0, Сума: 0 };
  const pack = { recordId: 'pack-work', Робота: 'Пакування', Ціна: 200, Кількість: 1, Зарплата: 100 };
  const previous = entry([old, pack]); await storeEntry(previous);
  await db.query('update slyusars set data=$1::jsonb where slyusar_id=2', [JSON.stringify({ Name: 'Артем', Доступ: 'Слюсар', Історія: {} })]);
  const removed = { ...old, __payroll_removed: true, Кількість: 0, Зарплата: 0, Сума: 0, __payroll_payments: paidEvents() };
  const desiredOld = entry([pack, removed]);
  const newWork = { recordId: 'new-artem-washing', Робота: 'Миття ГБЦ', Ціна: 50, Сума: 50, Кількість: 1, Зарплата: 25 };
  const desiredNew = entry([newWork]);
  await db.query('update acts set data=data||$1::jsonb where act_id=1533', [JSON.stringify({
    __payroll_pending: true, Роботи: [
      { ...newWork, Слюсар: 'Артем', slyusar_id: 2 }, { ...pack, Слюсар: 'Артем Д', slyusar_id: 1 },
    ],
  })]);
  const context = (await db.query('select payroll_recovery_context(1533) r')).rows[0].r;
  const employees = [
    { id: 1, settings: { Name: 'Артем Д', Доступ: 'Слюсар' }, expected: fragments(previous), desired: fragments(desiredOld) },
    { id: 2, settings: { Name: 'Артем', Доступ: 'Слюсар' }, expected: [], desired: fragments(desiredNew) },
  ];
  const commit = async values => (await db.query('select commit_act_payroll(1533,$1,$2,$3,$4,$5::jsonb,null,\'[]\'::jsonb) r',
    [context.checksum, context.context_checksum, context.revision, 'distinct-employees-r1', JSON.stringify(values)])).rows[0].r;
  const malformed = copy(employees); malformed[1].desired[0].value.Записи[0].__payroll_payments = paidEvents();
  await assert.rejects(commit(malformed), error => error.code === '55000');
  assert.deepEqual(await readEntry(), previous, 'Failure on the recipient rolls back the old employee tombstone');
  assert.deepEqual((await employee(2)).Історія, {});
  assert.equal((await commit(employees)).employees_changed, 2);
  assert.equal((await commit(employees)).status, 'unchanged');
  assert.equal((await db.query('select data from acts where act_id=1533')).rows[0].data.__payroll_pending, false);
  const oldReport = await report({ name: 'Артем Д' }), nextReport = await report({ name: 'Артем' });
  assert.equal(oldReport.salary, 100); assert.equal(oldReport.paidAmount, 100); assert.equal(oldReport.overpaid, 100);
  assert.equal(nextReport.salary, 25); assert.equal(nextReport.paidAmount, 0); assert.equal(nextReport.due, 25);
  assert.equal((await report()).revenue, 250);
  assert.equal((await readEntry(2)).Записи[0].__payroll_payments, undefined);
});

test('paid removal preserves cash history with zero earned/revenue, and restoration reuses that ledger', async () => {
  const removed = entry([tombstone()]);
  await accrue(entry(), removed);
  let result = await report({ name: 'Артем Д' });
  assert.equal(result.total, 1); assert.equal(result.salary, 0); assert.equal(result.revenue, 0);
  assert.equal(result.paidAmount, 100); assert.equal(result.overpaid, 100); assert.equal(result.due, 0);
  const restored = entry([correctedRow()]);
  await accrue(removed, restored);
  result = await report({ name: 'Артем Д' });
  assert.equal(result.salary, 25); assert.equal(result.paidAmount, 100); assert.equal(result.overpaid, 75);
  assert.equal((await readEntry()).Записи[0].__payroll_removed, undefined);
});

test('same-ID rename and alias-only changes are allowed without adding a payment or changing numeric representations', async () => {
  const previous = entry(); Object.assign(previous.Записи[0], { Ціна: '200', Кількість: '1', Зарплата: '100', Сума: '200' });
  await storeEntry(previous);
  const next = copy(previous);
  Object.assign(next.Записи[0], { Робота: 'Уточнена назва', __payroll_act_record_id: 'new-editor-row' });
  await accrue(previous, next);
  assert.deepEqual(await readEntry(), next);
  assert.equal((await report({ name: 'Артем Д' })).paidAmount, 100);
});

test('paid header permits reordering, tombstones and a new child with an explicit empty ledger', async () => {
  const previous = entry(); delete previous.Записи[0].Розраховано; previous.Розраховано = '14.10.2026';
  await storeEntry(previous);
  const removed = tombstone(); delete removed.Розраховано;
  const added = { recordId: 'additional', Робота: 'Додаткова робота', Ціна: 50, Кількість: 1,
    Зарплата: 25, __payroll_payments: [] };
  const next = { ...entry([added, removed]), Розраховано: previous.Розраховано };
  await accrue(previous, next);
  const result = await report({ name: 'Артем Д' });
  assert.equal(result.salary, 25); assert.equal(result.paidAmount, 100);
  assert.equal(result.due, 25); assert.equal(result.overpaid, 100); assert.equal(result.revenue, 50);
  const reordered = { ...next, Записи: [...next.Записи].reverse() };
  await accrue(next, reordered); assert.deepEqual(await readEntry(), reordered);
});

test('new child cannot inherit parent paid marker or smuggle paid events', async () => {
  const previous = entry(); previous.Розраховано = '14.10.2026'; await storeEntry(previous);
  for (const payment of [{}, { __payroll_payments: paidEvents() }, { __payroll_payments: [], Розраховано: '14.10.2026' }]) {
    const added = { recordId: 'added', Робота: 'Додаткова робота', Ціна: 50, Кількість: 1, Зарплата: 25, ...payment };
    await rejectUnchanged(previous, { ...entry([...previous.Записи, added]), Розраховано: previous.Розраховано });
  }
});

test('employee transfer retains the old ledger and creates only a new unpaid accrual on its recipient', async () => {
  await accrue(entry(), entry([tombstone()]));
  const recipient = await readEntry(2), unpaid = paidRow(); delete unpaid.Розраховано;
  const next = entry([...recipient.Записи, unpaid]);
  await accrue(recipient, next, 2);
  assert.equal((await report({ name: 'Артем Д' })).paidAmount, 100);
  const result = await report({ name: 'Рак' });
  assert.equal(result.salary, 200); assert.equal(result.paidAmount, 0); assert.equal(result.due, 200);
  const forged = copy(next); forged.Записи[1].__payroll_payments = paidEvents();
  await assert.rejects(accrue(next, forged, 2), error => error.code === '55000');
});

for (const [label, mutate] of [
  ['missing protected row', next => { next.Записи = []; next.СуммаРоботи = 0; }],
  ['changed paid identity', next => { next.Записи[0].recordId = 'another'; }],
  ['changed payment amount', next => { next.Записи[0].__payroll_payments[0].amount = 999; }],
  ['changed payment date', next => { next.Записи[0].__payroll_payments[0].date = '15.10.2026'; }],
  ['changed legacy marker', next => { next.Записи[0].Розраховано = '15.10.2026'; }],
  ['malformed alias', next => { next.Записи[0].__payroll_act_record_id = 42; }],
  ['blank alias', next => { next.Записи[0].__payroll_act_record_id = ' '; }],
  ['string removed marker', next => { next.Записи[0].__payroll_removed = 'true'; }],
  ['nonzero removed work', next => { next.Записи[0].__payroll_removed = true; }],
]) test(`actual RPC denies ${label} without changing acknowledged data`, async () => {
  const next = entry([correctedRow()]); mutate(next);
  await rejectUnchanged(entry(), next);
});

test('active alias collisions and aliases stealing another paid identity fail in the direct guard and RPC', async () => {
  const previous = entry([paidRow(), { ...paidRow(), recordId: 'other-paid' }]);
  await storeEntry(previous);
  for (const collision of ['shared-alias', 'other-paid']) {
    const next = copy(previous); next.Записи[0].__payroll_act_record_id = collision;
    if (collision === 'shared-alias') next.Записи[1].__payroll_act_record_id = collision;
    await assert.rejects(guard(previous, next), error => error.code === '55000');
    await rejectUnchanged(previous, next);
  }
});

test('duplicate payroll IDs and a stale expected fragment are rejected before any write', async () => {
  const duplicate = entry([correctedRow(), correctedRow()]);
  await rejectUnchanged(entry(), duplicate, '40001');
  const stale = entry(); stale.СуммаРоботи = 999;
  await rejectUnchanged(stale, entry([correctedRow()]), '40001');
});

test('legacy paid rows lacking identity remain unchanged rather than receiving a guessed tombstone identity', async () => {
  const previous = entry(); delete previous.Записи[0].recordId; await storeEntry(previous);
  await guard(previous, previous);
  const next = entry([tombstone()]); delete next.Записи[0].recordId;
  await rejectUnchanged(previous, next);
});

test('fully voided ledger events survive a removal even when there is no active payment', async () => {
  const previous = entry(); previous.Записи[0].__payroll_payments = [
    ...paidEvents(), { id: 'void-100', voids: 'legacy', date: '15.10.2026' },
  ]; await storeEntry(previous);
  const next = entry([tombstone()]); next.Записи[0].__payroll_payments = copy(previous.Записи[0].__payroll_payments);
  await accrue(previous, next);
  assert.deepEqual((await readEntry()).Записи[0].__payroll_payments, previous.Записи[0].__payroll_payments);
  const forged = copy(next); forged.Записи[0].__payroll_payments = [];
  await rejectUnchanged(next, forged);
});

test('latest writer keeps frozen-act protection after installing and reinstalling the work-edit migration', async () => {
  await db.exec(migration());
  await db.exec("update acts set data=data||'{\"Заморожений\":true}'::jsonb where act_id=1533");
  await rejectUnchanged(entry(), entry([correctedRow()]));
});

test('migration and standalone SQL are idempotent and do not rewrite stored history', async () => {
  await accrue(entry(), entry([correctedRow()]));
  const previous = await employee();
  await db.exec(migration()); await db.exec(migration());
  await db.exec(fs.readFileSync('supabase/setup/traffic-optimization/payroll-work-edit-repair.sql', 'utf8'));
  assert.deepEqual(await employee(), previous);
  assert.equal((await report({ name: 'Артем Д' })).paidAmount, 100);
});
