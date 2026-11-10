// Isolated PostgreSQL/WASM checks. Only synthetic in-memory data; no network.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.STO_PGLITE_MODULE || 'C:/Users/Viktoriy/AppData/Local/Temp/sto-freeze-sql-check/package');
const root = path.resolve(__dirname, '../..');
const source = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const migration = source('20261025064857_act_freeze_payroll_archive.sql');
const passed = [];
const db = new PGlite();
const actId = 700;
const paidRows = [
  { recordId: 'synthetic-paid-a', Робота: 'Work A', Ціна: 900, Кількість: 1, Зарплата: 300, Розраховано: '01.07.2026' },
  { recordId: 'synthetic-paid-b', Робота: 'Work B', Ціна: 900, Кількість: 1, Зарплата: 300,
    __payroll_payments: [{ id: 'payment-b', amount: 300, date: '01.07.2026' }] },
];
const entry = { Акт: String(actId), Записи: paidRows, СуммаРоботи: 1800, ДатаЗакриття: null };
const other = { Акт: '699', Записи: [{ recordId: 'unrelated', Зарплата: 45 }] };
const noAct = { legacy: 'entry without act number', amount: 8 };
const originalEmployees = [
  { Name: 'Fixture mechanic', Доступ: 'Слюсар', profile: 'preserve', Історія: { '2026-06-22': [entry, other, noAct] } },
  { Name: 'Fixture receiver', Доступ: 'Приймальник', Історія: { '2026-06-22': [{ Акт: String(actId), ЗарплатаРоботи: 180, СуммаРоботи: 1800, Розраховано: '01.07.2026' }] } },
  { Name: 'Fixture parts', Доступ: 'Запчастист', Історія: { '2026-06-23': [{ Акт: String(actId), ЗарплатаЗапчастин: 80, СуммаЗапчастин: 800 }] } },
  { Name: 'Untouched employee', Доступ: 'Адміністратор', Історія: { '2026-06-22': [other] } },
];
const originalAct = {
  Заморожений: false, __payroll_pending: false, __act_revision: 'initial',
  Роботи: paidRows,
  Деталі: [{ sclad_id: 10, Кількість: 2 }, { sclad_id: '10', Кількість: 3 }, { sclad_id: 20, Кількість: 1 }],
};
async function readAct() { return (await db.query('select traffic_act_transition_state($1) r', [actId])).rows[0].r; }
async function rpc(frozen, rev, state) {
  const current = state || await readAct();
  return (await db.query('select guarded_set_act_frozen($1,$2,$3,$4,$5) r', [actId, frozen, current.checksum, rev, 'Fixture owner'])).rows[0].r;
}
async function employees() { return (await db.query('select slyusar_id,data from slyusars order by slyusar_id')).rows; }
async function stock() { return (await db.query('select sclad_id,kilkist_off from sclad order by sclad_id')).rows; }
async function snapshot() {
  return {
    act: (await db.query('select data from acts where act_id=$1', [actId])).rows[0].data,
    employees: await employees(), stock: await stock(),
    archive: (await db.query('select act_id,employee_id,fragments from sto_payroll_private.act_freeze_payroll order by employee_id')).rows,
    state: (await db.query('select * from sto_payroll_private.act_freeze_state order by act_id')).rows,
  };
}
async function seed() {
  await db.exec('reset role; truncate sto_payroll_private.act_freeze_payroll,sto_payroll_private.act_freeze_state,acts,slyusars,sclad;');
  await db.query('insert into acts(act_id,data,date_on,pruimalnyk) values($1,$2,\'2026-06-22\',\'Fixture receiver\')', [actId, JSON.stringify(originalAct)]);
  for (let i = 0; i < originalEmployees.length; i++) await db.query('insert into slyusars values($1,$2)', [i + 1, JSON.stringify(originalEmployees[i])]);
  await db.exec('insert into sclad(sclad_id,kilkist_off) values(10,12),(20,3); set role authenticated;');
}
async function unchangedAfterReject(action, pattern) {
  const before = await snapshot();
  await assert.rejects(action, pattern);
  assert.deepEqual(await snapshot(), before);
}
async function check(name, action) { await seed(); await action(); passed.push(name); console.log('PASS', name); }
async function main() {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table acts(act_id integer primary key,data jsonb not null,date_on timestamp,date_off timestamp,pruimalnyk text,"slusarsOn" boolean,client_id integer,cars_id integer);
    create table slyusars(slyusar_id integer primary key,data jsonb not null);
    create table sclad(sclad_id bigint primary key,kilkist_off numeric,price numeric,"scladNomer" text,xto_zamovuv text);
    create table act_locks(act_id integer primary key,heartbeat_at timestamptz);
    create function assert_editor_act_lease(integer,text) returns void language plpgsql as $$begin return;end$$;
    grant select,update on acts,slyusars,sclad to authenticated;
    alter table acts enable row level security; alter table acts force row level security;
    alter table slyusars enable row level security; alter table slyusars force row level security;
    alter table sclad enable row level security; alter table sclad force row level security;
    create policy acts_read on acts for select to authenticated using(true);
    create policy acts_write on acts for update to authenticated using(true) with check(true);
    create policy employees_read on slyusars for select to authenticated using(true);
    create policy employees_write on slyusars for update to authenticated using(true) with check(true);
    create policy stock_read on sclad for select to authenticated using(true);
    create policy stock_write on sclad for update to authenticated using(true) with check(true);`);
  await db.exec(source('20261011080000_payroll_fragments.sql'));
  const report = source('20261011130000_traffic_payroll_report.sql');
  await db.exec(report.slice(0, report.indexOf('create or replace function public.traffic_payroll_validate')));
  const search = source('20261011040000_traffic_act_search.sql');
  await db.exec(search.slice(search.indexOf('create or replace function public.traffic_search_truthy'), search.indexOf('create or replace function public.traffic_search_trim')));
  await db.exec(source('20261020061759_traffic_payroll_payments.sql'));
  await db.exec(source('20261020061804_payroll_payment_ledger.sql'));
  await db.exec(migration);
  await db.exec(migration); // Installation must be repeatable.
  passed.push('migration compiles and installs twice');
  await check('freeze clears all roles, keeps other acts and private profiles; thaw preserves paid amounts', async () => {
    const before = await employees();
    const result = await rpc(true, 'freeze-1');
    assert.equal(result.freeze_payroll_version, 1);
    assert.equal(result.employees_changed, 3);
    assert.equal(result.frozen, true);
    assert.deepEqual(result.stock_ids, [10,20]);
    assert.deepEqual(await stock(), [{sclad_id:10,kilkist_off:'7'}, {sclad_id:20,kilkist_off:'2'}]);
    const frozen = await snapshot();
    assert.equal(frozen.archive.length, 3);
    assert.deepEqual(frozen.employees[0].data.Історія['2026-06-22'], [other,noAct]);
    assert.deepEqual(frozen.employees[1].data.Історія, {});
    assert.deepEqual(frozen.employees[2].data.Історія, {});
    assert.deepEqual(frozen.employees[3], before[3]);
    assert.equal(frozen.employees[0].data.profile, 'preserve');
    const thawed = await rpc(false, 'thaw-1');
    assert.equal(thawed.employees_changed, 3);
    assert.equal(thawed.payroll_pending, true);
    const after = await snapshot();
    assert.equal(after.archive.length, 0); assert.equal(after.state.length, 0);
    assert.deepEqual(after.stock, [{sclad_id:10,kilkist_off:'12'}, {sclad_id:20,kilkist_off:'3'}]);
    for (let i = 0; i < 3; i++) {
      const fragments = (await db.query('select sto_payroll_private.act_fragments($1::jsonb,$2) r', [JSON.stringify(after.employees[i].data.Історія),String(actId)])).rows[0].r;
      const originalFragments = (await db.query('select sto_payroll_private.act_fragments($1::jsonb,$2) r', [JSON.stringify(originalEmployees[i].Історія),String(actId)])).rows[0].r;
      assert.deepEqual(fragments, originalFragments);
    }
    for (const row of paidRows) {
      const payment = (await db.query('select traffic_payroll_payment_summary($1::jsonb) r',[JSON.stringify(row)])).rows[0].r;
      assert.equal(payment.paidAmount, 300); assert.equal(payment.due, 0);
    }
  });
  await check('same revision retry and fresh no-op leave stock and payroll untouched; stale revision fails', async () => {
    const initial = await readAct();
    await rpc(true,'freeze-2',initial);
    const frozen = await snapshot();
    const repeated = await rpc(true,'freeze-2',initial);
    assert.equal(repeated.status,'unchanged'); assert.equal(repeated.revision,'freeze-2');
    assert.deepEqual(await snapshot(),frozen);
    await unchangedAfterReject(() => rpc(true,'stale-different',initial), /змінився/);
    const noOp = await rpc(true,'unused');
    assert.equal(noOp.revision,'freeze-2'); assert.deepEqual(await snapshot(),frozen);
    const priorThaw = await readAct(); await rpc(false,'thaw-2',priorThaw);
    const restored = await snapshot();
    assert.equal((await rpc(false,'thaw-2',priorThaw)).status,'unchanged');
    assert.deepEqual(await snapshot(),restored);
  });
  await check('insufficient allocated stock rolls back earlier stock writes and all status/payroll', async () => {
    await db.exec('reset role; update sclad set kilkist_off=0 where sclad_id=20; set role authenticated;');
    await unchangedAfterReject(() => rpc(true,'bad-stock'), /кількість менша/);
  });
  await check('employee update rejection rolls back prior stock and archive writes', async () => {
    await db.exec(`reset role; create function fixture_reject_employee() returns trigger language plpgsql as $$begin if NEW.slyusar_id=2 then raise exception 'fixture denied'; end if; return NEW;end$$;
      create trigger fixture_reject before update on slyusars for each row execute function fixture_reject_employee(); set role authenticated;`);
    await unchangedAfterReject(() => rpc(true,'bad-employee'), /fixture denied/);
    await db.exec('reset role; drop trigger fixture_reject on slyusars; drop function fixture_reject_employee(); set role authenticated;');
  });
  await check('thaw live-payroll conflict preserves archived payments and stock', async () => {
    await rpc(true,'freeze-conflict');
    await db.exec(`reset role; update slyusars set data=jsonb_set(data,'{Історія}', '{"2026-06-22":[{"Акт":"700","Зарплата":2}]}'::jsonb) where slyusar_id=2; set role authenticated;`);
    await unchangedAfterReject(() => rpc(false,'thaw-conflict'), /інші нарахування/);
  });
  await check('thaw changed detail allocation rejects without consuming inventory', async () => {
    await rpc(true,'freeze-parts');
    await db.exec(`reset role; update acts set data=jsonb_set(data,'{Деталі,0,Кількість}','9') where act_id=700; set role authenticated;`);
    await unchangedAfterReject(() => rpc(false,'thaw-parts'), /Деталі замороженого акта змінилися/);
  });
  await check('both ordinary payroll payment and accrual writes reject frozen acts', async () => {
    await rpc(true,'freeze-writer');
    for (const mode of ['accrual','payment']) await unchangedAfterReject(() => db.query('select write_payroll_fragments(1,$1,$2::jsonb)', [mode, JSON.stringify([{act_id:actId,expected:[],desired:[]}])]), /заморожений|Заморожений/);
  });
  await check('ordinary paid deletion remains prohibited after thaw', async () => {
    // The original ordinary writer rejects legacy entries lacking an act ID.
    // Keep this independent paid-deletion case focused on its paid guard.
    await db.query("update slyusars set data=jsonb_set(data,'{Історія,2026-06-22}',$1::jsonb) where slyusar_id=1", [JSON.stringify([entry,other])]);
    await rpc(true,'freeze-paid'); await rpc(false,'thaw-paid');
    await unchangedAfterReject(() => db.query('select write_payroll_fragments(1,\'accrual\',$1::jsonb)', [JSON.stringify([{act_id:actId,expected:[{date:'2026-06-22',value:entry}],desired:[]}])]), /Дата оплаченої зарплати|Оплачена робота/);
  });
  for (const mode of ['select','update']) await check(`restrictive ${mode} RLS prevents a partial freeze`, async () => {
    await db.exec(`reset role; create policy fixture_restrict on slyusars as restrictive for ${mode} to authenticated using(slyusar_id<>2) ${mode==='update'?'with check(slyusar_id<>2)':''}; set role authenticated;`);
    await unchangedAfterReject(() => rpc(true,`bad-rls-${mode}`), /Політики доступу/);
    await db.exec('reset role; drop policy fixture_restrict on slyusars; set role authenticated;');
  });
  await check('PUBLIC policies are accepted without evaluating role OID zero', async () => {
    await db.exec('reset role; alter policy employees_read on slyusars to public; alter policy employees_write on slyusars to public; set role authenticated;');
    assert.equal((await rpc(true,'public-policy')).employees_changed,3);
    await db.exec('reset role; alter policy employees_read on slyusars to authenticated; alter policy employees_write on slyusars to authenticated; set role authenticated;');
  });
  await check('NOINHERIT membership cannot bypass the full visibility preflight', async () => {
    await db.exec(`reset role; create role fixture_unrestricted;
      grant fixture_unrestricted to authenticated with inherit false;
      alter policy employees_read on slyusars using(slyusar_id=1);
      create policy fixture_member_read on slyusars for select to fixture_unrestricted using(true); set role authenticated;`);
    await unchangedAfterReject(() => rpc(true,'noinherit'), /Політики доступу/);
    await db.exec('reset role; drop policy fixture_member_read on slyusars; alter policy employees_read on slyusars using(true); revoke fixture_unrestricted from authenticated; drop role fixture_unrestricted; set role authenticated;');
  });
  await check('malformed history aborts the whole transaction without losing other entries', async () => {
    await db.exec(`reset role; update slyusars set data=jsonb_set(data,'{Історія}', '{"legacy":42}'::jsonb) where slyusar_id=4; set role authenticated;`);
    await unchangedAfterReject(() => rpc(true,'bad-history'), /Некоректна дата історії/);
  });
  await check('legacy frozen act without archive keeps paid live records when thawing', async () => {
    await db.exec(`reset role; update acts set data=jsonb_set(data,'{Заморожений}','true') where act_id=700;
      update sclad set kilkist_off=kilkist_off-case when sclad_id=10 then 5 else 1 end; set role authenticated;`);
    const before = await employees();
    await rpc(false,'legacy-thaw');
    assert.deepEqual(await employees(),before);
    assert.deepEqual(await stock(),[{sclad_id:10,kilkist_off:'12'},{sclad_id:20,kilkist_off:'3'}]);
  });
  await check('legacy repeat freeze archives payroll without returning parts twice', async () => {
    await db.exec(`reset role; update acts set data=jsonb_set(data,'{Заморожений}','true') where act_id=700;
      update sclad set kilkist_off=kilkist_off-case when sclad_id=10 then 5 else 1 end; set role authenticated;`);
    const beforeStock = await stock();
    const result = await rpc(true,'legacy-repair');
    assert.equal(result.employees_changed,3); assert.deepEqual(await stock(),beforeStock);
    await rpc(false,'legacy-restored');
    assert.deepEqual(await stock(),[{sclad_id:10,kilkist_off:'12'},{sclad_id:20,kilkist_off:'3'}]);
  });
  await db.exec('reset role;');
  console.log(JSON.stringify({passed:passed.length,checks:passed,engine:'PGlite isolated memory, synthetic fixtures'},null,2));
}
main().catch(error => { console.error({message:error.message,code:error.code,where:error.where,detail:error.detail,stack:error.stack}); process.exitCode=1; }).finally(() => db.close());
