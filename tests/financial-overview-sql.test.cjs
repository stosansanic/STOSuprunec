// Real SQL against synthetic in-memory PostgreSQL; no production reads or writes.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createFixture, resetFixture, financialMigration, addAct, addEmployee, addExpense, addStock,
} = require('./financial-overview-fixture.cjs');
let db;
before(async () => { db = await createFixture(); });
after(async () => { if (db) await db.close(); });
beforeEach(async () => { await resetFixture(db); });

async function report(from = '2026-10-10', to = '2026-10-12', revision = null) {
  return (await db.query('select traffic_financial_overview($1::date,$2::date,$3::text) r',
    [from,to,revision])).rows[0].r;
}

function work(act, wage, extra = {}) {
  return { Акт: String(act), СуммаРоботи: 1000,
    Записи: [{recordId:`work-${act}`, Робота:'Fixture work', Ціна:1000, Кількість:1, Зарплата:wage, ...extra}] };
}

test('empty report is compact, has nullable true cash, and covers equal inclusive periods', async () => {
  const result = await report();
  assert.equal(result.formatVersion,1);
  assert.equal(result.complete,true);
  assert.equal(result.from,'2026-10-10'); assert.equal(result.to,'2026-10-12');
  assert.equal(result.previousFrom,'2026-10-07'); assert.equal(result.previousTo,'2026-10-09');
  for (const [name,value] of Object.entries(result.current)) assert.equal(value,0,name);
  assert.equal(result.balances.cashBalance,null);
  assert.equal(result.balances.freeCash,null);
  assert.deepEqual(result.employees,[]);
  assert.equal(result.inventory.value,0);
  assert.ok(JSON.stringify(result).length < 14000,'empty report should not carry histories or table pages');
});

test('invalid or reversed periods reject and migration reinstallation preserves business data', async () => {
  await assert.rejects(report(null,'2026-10-12'));
  await assert.rejects(report('2026-10-13','2026-10-12'));
  await addAct(db,1,{work:100});
  const before=(await db.query('select to_jsonb(a) row from acts a')).rows;
  await db.exec(financialMigration());
  assert.deepEqual((await db.query('select to_jsonb(a) row from acts a')).rows,before);
  assert.equal((await report()).current.turnover,100);
});

test('close dates, discounts, stock cost and all three payroll roles contribute exactly once', async () => {
  await addStock(db,1,{paid:'2026-10-11'});
  await addAct(db,1,{work:1000,parts:500,discount:10,paid:'2026-10-11 10:00:00',body:{
    Роботи:[{recordId:'work-1',Робота:'Fixture work',Ціна:1000,Кількість:1,Зарплата:300,Слюсар:'Mechanic'}],
    Деталі:[{Деталь:'Fixture part',Ціна:500,Кількість:1,sclad_id:1}],
  }});
  await addEmployee(db,1,'Mechanic','Слюсар',[work(1,300,{Розраховано:'11.10.2026'})]);
  await addEmployee(db,2,'Receiver','Приймальник',[{Акт:'1',СуммаРоботи:1000,ЗарплатаРоботи:100,
    ЗарплатаЗапчастин:50,__payroll_payments:[{id:'receiver-payment',amount:100,date:'11.10.2026'}]}]);
  await addEmployee(db,3,'Parts person','Запчастист',[{Акт:'1',СуммаЗапчастин:500,ЗарплатаЗапчастин:50}]);
  await addExpense(db,1,100);
  const result=await report();
  assert.equal(result.current.turnover,1350);
  assert.equal(result.current.workRevenue,900); assert.equal(result.current.partsRevenue,450);
  assert.equal(result.current.partsCost,200);
  assert.equal(result.current.payrollAccrued,500);
  assert.equal(result.current.workPayroll,400); assert.equal(result.current.partsPayroll,100);
  assert.equal(result.current.operatingExpenses,100);
  assert.equal(result.current.grossEarnings,1150); assert.equal(result.current.profit,550);
  assert.equal(result.current.settledReceipts,1350);
  assert.equal(result.current.payrollPaid,400); assert.equal(result.current.suppliersPaid,400);
  assert.equal(result.current.expensesPaid,0); assert.equal(result.current.totalPaid,800);
  assert.equal(result.current.netKnownMovement,550);
  assert.equal(result.balances.receivables,0); assert.equal(result.balances.payroll,100);
  assert.equal(result.balances.expenses,100); assert.equal(result.balances.suppliers,0);
  assert.equal(result.balances.totalLiabilities,200);
  assert.equal(result.inventory.value,200);
  assert.deepEqual(result.employees.map(e=>[e.name,e.role,e.accrued,e.paidInPeriod,e.due]).sort(),[
    ['Mechanic','Слюсар',300,300,0],['Parts person','Запчастист',50,0,50],['Receiver','Приймальник',150,100,50],
  ].sort());
  const serialized=JSON.stringify(result);
  assert.doesNotMatch(serialized,/PRIVATE-PROFILE|Fixture work|__payroll_payments|Історія|Записи/);
});

test('unpaid closed acts add turnover and debt, open/frozen acts do not add turnover', async () => {
  await addAct(db,1,{work:300});
  await addAct(db,2,{work:400,closed:null});
  await addAct(db,3,{work:500,frozen:true});
  const result=await report();
  assert.equal(result.current.turnover,300);
  assert.equal(result.current.closedActs,1);
  assert.equal(result.current.settledReceipts,0);
  assert.equal(result.balances.receivables,300);
});

test('the complete selected period includes data older than twelve months', async () => {
  await addAct(db,1,{work:100,opened:'2024-01-01',closed:'2024-01-15'});
  await addAct(db,2,{work:200,opened:'2025-12-01',closed:'2025-12-15'});
  await addAct(db,3,{work:400,opened:'2026-10-01',closed:'2026-10-15'});
  const result=await report('2024-01-01','2026-10-31');
  assert.equal(result.current.turnover,700);
  assert.equal(result.current.closedActs,3);
});

test('legacy formatted money stays numeric and summaries round only to currency precision', async () => {
  await addAct(db,1,{work:'1 000,50',discount:'10',body:{
    Роботи:[{Ціна:'1 000,50',Кількість:'1',Зарплата:'300,25'}],
  }});
  await addEmployee(db,1,'Mechanic','Слюсар',[work(1,'300,25')]);
  const result=await report();
  assert.equal(result.current.turnover,900.45);
  assert.equal(result.current.payrollAccrued,300.25);
  assert.equal(result.current.profit,600.2);
});

test('inclusive day boundaries and preceding equal-length interval are not shifted by client timezone', async () => {
  await addAct(db,1,{work:100,opened:'2026-10-09',closed:'2026-10-09 23:59:59'});
  await addAct(db,2,{work:200,closed:'2026-10-10 00:00:00'});
  await addAct(db,3,{work:300,closed:'2026-10-12 23:59:59'});
  await addAct(db,4,{work:900,closed:'2026-10-13 00:00:00'});
  await db.exec("set timezone='America/Los_Angeles'");
  const result=await report();
  assert.equal(result.current.turnover,500);
  assert.equal(result.previous.turnover,100);
  await db.exec("set timezone='UTC'");
});

test('timestamptz events are assigned to Europe/Kyiv calendar days', async () => {
  await db.exec(`alter table acts alter column date_on type timestamptz using date_on at time zone 'Europe/Kyiv',
    alter column date_off type timestamptz using date_off at time zone 'Europe/Kyiv',
    alter column rosraxovano type timestamptz using rosraxovano at time zone 'Europe/Kyiv';`);
  try {
    await addAct(db,1,{work:100,closed:'2026-10-09T21:30:00Z',paid:'2026-10-09T21:40:00Z'});
    const result=await report('2026-10-10','2026-10-10');
    assert.equal(result.current.turnover,100);
    assert.equal(result.current.settledReceipts,100);
    assert.equal(result.previous.turnover,0);
  } finally {
    await db.exec(`alter table acts alter column date_on type timestamp using date_on at time zone 'Europe/Kyiv',
      alter column date_off type timestamp using date_off at time zone 'Europe/Kyiv',
      alter column rosraxovano type timestamp using rosraxovano at time zone 'Europe/Kyiv';`);
  }
});

test('manual salaries and parts cannot be silently deducted twice', async () => {
  await addAct(db,1,{work:1000,body:{Роботи:[{Ціна:1000,Кількість:1,Зарплата:300}]}});
  await addEmployee(db,1,'Mechanic','Слюсар',[work(1,300)]);
  await addExpense(db,1,300,'Зарплата',{paid:'2026-10-11'});
  await addExpense(db,2,200,'Деталі',{paid:'2026-10-11'});
  await addExpense(db,3,100,'Оренда',{paid:'2026-10-11'});
  const result=await report();
  assert.equal(result.current.payrollAccrued,300);
  assert.equal(result.current.operatingExpenses,100);
  assert.equal(result.current.profit,600);
  assert.equal(result.current.excludedExpenses,500);
  assert.equal(result.current.excludedExpensesPaid,500);
  assert.equal(result.current.expensesPaid,100);
  assert.ok(result.quality.warnings.some(w=>w.amount===500),'excluded manual costs must be visible');
  assert.equal(result.expenseCategories.filter(c=>!c.included).reduce((s,c)=>s+c.accrued,0),500);
});

test('an expense accrual and later payment fall into different selected periods', async () => {
  await addExpense(db,1,125,'Оренда',{date:'2026-10-08',paid:'2026-10-11'});
  const result=await report();
  assert.equal(result.current.operatingExpenses,0);
  assert.equal(result.current.expensesPaid,125);
  assert.equal(result.previous.operatingExpenses,125);
  assert.equal(result.previous.expensesPaid,0);
  assert.equal(result.balances.expenses,0);
  const prior=await report('2026-10-08','2026-10-09');
  assert.equal(prior.balances.expenses,125);
});

test('capital and credit payments reduce cash while staying outside operating profit',async()=>{
  await addAct(db,1,{work:1000});
  await addExpense(db,1,300,'Обладнання',{paid:'2026-10-11'});
  await addExpense(db,2,100,'Кредит',{paid:'2026-10-11'});
  await addExpense(db,3,40,'Інструмент',{paid:'2026-10-11'});
  await addExpense(db,4,200,'Обладнання');
  const result=await report();
  assert.equal(result.current.operatingExpenses,40);
  assert.equal(result.current.profit,960);
  assert.equal(result.current.expensesPaid,440);
  assert.equal(result.current.excludedExpensesPaid,0);
  assert.equal(result.balances.expenses,200);
  assert.ok(result.quality.warnings.some(w=>w.code==='non_operating_expenses'));
  assert.equal(result.expenseCategories.find(c=>c.category==='Кредит').cashIncluded,true);
  assert.equal(result.expenseCategories.find(c=>c.category==='Кредит').included,false);
});

test('a client advance is never counted again as a full settlement receipt', async () => {
  await addAct(db,1,{work:1000,advance:200,paid:'2026-10-11'});
  await addAct(db,2,{work:500,closed:null,advance:100});
  const result=await report();
  assert.equal(result.current.turnover,1000);
  assert.equal(result.current.settledReceipts,800);
  assert.ok(result.balances.undatedAdvances>=200);
  assert.equal(result.balances.cashBalance,null);
  assert.ok(result.quality.warnings.length>0);
});

test('frozen payroll payments remain in outflow without frozen accrual or liabilities', async () => {
  await addAct(db,1,{work:1000,frozen:true,closed:null});
  await addEmployee(db,1,'Frozen mechanic','Слюсар',[]);
  await db.query('insert into sto_payroll_private.act_freeze_state values(1,$1,$2,$3)',
    ['2026-10-12T12:00:00Z','freeze-fixture','[]']);
  await db.query('insert into sto_payroll_private.act_freeze_payroll values(1,1,$1)',[JSON.stringify([
    {date:'2026-10-10',value:work(1,600,{__payroll_payments:[{id:'frozen-pay',amount:400,date:'11.10.2026'}]})},
  ])]);
  const result=await report();
  assert.equal(result.current.payrollAccrued,0);
  assert.equal(result.current.payrollPaid,400);
  assert.equal(result.current.totalPaid,400);
  assert.equal(result.balances.payroll,0);
  assert.equal(result.employees[0].paidInPeriod,400);
});

test('void after the report end does not rewrite earlier paid balance', async () => {
  await addAct(db,1,{work:200});
  await addEmployee(db,1,'Mechanic','Слюсар',[work(1,100,{__payroll_payments:[
    {id:'payment',amount:100,date:'10.10.2026'},
    {id:'void',voids:'payment',date:'12.10.2026'},
  ]})]);
  const earlier=await report('2026-10-10','2026-10-11');
  assert.equal(earlier.current.payrollPaid,100);
  assert.equal(earlier.balances.payroll,0);
  const cancellation=await report('2026-10-12','2026-10-12');
  assert.equal(cancellation.current.payrollPaid,-100);
  assert.equal(cancellation.balances.payroll,100);
  assert.equal(cancellation.current.payrollAccrued,0);
});

test('paid supplier returns do not imply that the supplier has refunded the cash', async () => {
  await addStock(db,1,{price:100,quantity:2,used:0,paid:'2026-10-10',returned:'2026-10-11'});
  const result=await report();
  assert.equal(result.current.suppliersPaid,200);
  assert.equal(result.inventory.value,0);
  assert.equal(result.balances.suppliers,0);
  assert.ok(result.quality.warnings.length>0);
});

test('missing purchase cost is reported as incomplete rather than silently verified profit', async () => {
  await addAct(db,1,{parts:300,body:{Деталі:[{Деталь:'Unknown part',Ціна:300,Кількість:1,sclad_id:999}]}});
  const result=await report();
  assert.equal(result.current.turnover,300);
  assert.equal(result.quality.estimates,true);
  assert.ok(result.quality.warnings.some(w=>w.count>0));
  assert.equal(result.balances.cashBalance,null);
});

test('legacy JSON stock fields fill missing flat columns without losing inventory cost', async () => {
  await addStock(db,1,{price:null,quantity:null,used:null,data:{price:50,kilkist_on:10,kilkist_off:4,time_on:'2026-10-10'}});
  await addAct(db,1,{parts:300,body:{Деталі:[{Деталь:'Part',Ціна:300,Кількість:1,sclad_id:1}]}});
  const result=await report();
  assert.equal(result.current.partsCost,50);
  assert.equal(result.inventory.value,300);
  assert.equal(result.balances.suppliers,500);
});

test('invalid negative stock prices cannot increase margin or create a negative stock balance', async () => {
  await addStock(db,1,{price:-100});
  await addAct(db,1,{parts:300,body:{Деталі:[{Деталь:'Part',Ціна:300,Кількість:1,sclad_id:1}]}});
  const result=await report();
  assert.equal(result.current.partsCost,0);
  assert.equal(result.inventory.value,0);
  assert.equal(result.balances.suppliers,0);
  assert.ok(result.quality.warnings.some(w=>w.code==='missing_stock_price'));
});

test('an invalid negative saved cost falls back to valid stock cost',async()=>{
  await addStock(db,1,{price:100});
  await addAct(db,1,{parts:300,body:{Деталі:[{Деталь:'Part',Ціна:300,Кількість:1,sclad_id:1,purchasePrice:-50}]}});
  const result=await report();
  assert.equal(result.current.partsCost,100);
  assert.equal(result.current.profit,200);
});

test('corrupt payroll history is disclosed instead of disappearing into apparently complete profit',async()=>{
  await addAct(db,1,{work:1000});
  await db.query('insert into slyusars values(1,$1)',[JSON.stringify({Name:'Mechanic',Доступ:'Слюсар',Історія:{'2026-10-10':'corrupt'}})]);
  const result=await report();
  assert.ok(result.quality.warnings.some(w=>w.severity==='warning'&&/зарплат|нарахуван|виплат/i.test(w.message)));
});

test('a wage on a closed act without corresponding payroll history makes profit provisional',async()=>{
  await addAct(db,1,{work:1000,body:{Роботи:[{recordId:'missing-wage',Робота:'Work',Ціна:1000,Кількість:1,Зарплата:300,Слюсар:'Mechanic'}]}});
  const result=await report();
  assert.ok(result.quality.warnings.some(w=>w.severity==='warning'&&/зарплат|нарахуван/i.test(w.message)));
});

test('optional archive absence is reported without breaking fresh installations',async()=>{
  await addAct(db,1,{work:100,frozen:true});
  await db.exec('alter table sto_payroll_private.act_freeze_payroll rename to fixture_archive_unavailable');
  try {
    const result=await report();
    assert.equal(result.current.turnover,0);
    assert.ok(result.quality.warnings.some(w=>w.code==='archive_unavailable'));
  } finally { await db.exec('alter table sto_payroll_private.fixture_archive_unavailable rename to act_freeze_payroll'); }
});

test('unchanged revisions return a small response, and differing periods cannot reuse it',async()=>{
  const first=await report();
  const unchanged=await report('2026-10-10','2026-10-12',first.revision);
  assert.equal(unchanged.not_modified,true);
  assert.equal(unchanged.revision,first.revision);
  assert.ok(JSON.stringify(unchanged).length<200);
  const different=await report('2026-10-11','2026-10-12',first.revision);
  assert.equal(different.complete,true); assert.notEqual(different.revision,first.revision);
});

test('summary respects caller RLS and does not expose unauthorized employee profiles', async () => {
  await addAct(db,1,{work:100}); await addAct(db,2,{work:900});
  await addEmployee(db,1,'Visible','Слюсар',[work(1,10)]);
  await addEmployee(db,2,'Hidden','Слюсар',[work(2,90)]);
  await db.exec(`alter table acts enable row level security;
    alter table slyusars enable row level security;
    create policy fixture_acts on acts for select to authenticated using(act_id=1);
    create policy fixture_employees on slyusars for select to authenticated using(slyusar_id=1);
    set role authenticated;`);
  try {
    const result=await report();
    assert.equal(result.current.turnover,100);
    assert.equal(result.current.payrollAccrued,10);
    assert.deepEqual(result.employees.map(e=>e.name),['Visible']);
    assert.doesNotMatch(JSON.stringify(result),/Hidden|PRIVATE-PROFILE/);
  } finally {
    await db.exec(`reset role;drop policy fixture_acts on acts;drop policy fixture_employees on slyusars;
      alter table acts disable row level security;alter table slyusars disable row level security;`);
  }
});

test('anonymous callers cannot execute the financial overview',async()=>{
  await db.exec('set role anon');
  try { await assert.rejects(report(),error=>error.code==='42501'); }
  finally { await db.exec('reset role'); }
});

test('archived wage totals cannot bypass employee visibility through the private archive',async()=>{
  await addAct(db,1,{work:100,frozen:true,closed:null});
  await addEmployee(db,1,'Visible','Слюсар',[]);
  await addEmployee(db,2,'Hidden','Слюсар',[]);
  await db.query('insert into sto_payroll_private.act_freeze_payroll values(1,2,$1)',[JSON.stringify([
    {date:'2026-10-10',value:work(1,600,{__payroll_payments:[{id:'hidden-pay',amount:400,date:'11.10.2026'}]})},
  ])]);
  await db.exec(`alter table slyusars enable row level security;
    create policy fixture_archive_employee on slyusars for select to authenticated using(slyusar_id=1);
    set role authenticated;`);
  try {
    const result=await report();
    assert.equal(result.current.payrollPaid,0);
    assert.deepEqual(result.employees,[]);
  } finally {
    await db.exec(`reset role;drop policy fixture_archive_employee on slyusars;
      alter table slyusars disable row level security;`);
  }
});
