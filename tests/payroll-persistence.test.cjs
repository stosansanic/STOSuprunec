// Local fixtures only; no production database/network calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
const copy = structuredClone;
function load(file, dependencies, extra = {}) {
  // The real payroll module listens for identity changes; these isolated
  // persistence fixtures have a stable identity and perform no auth requests.
  const client = dependencies['../vxid/supabaseClient']?.supabase;
  if (client && !client.auth) client.auth = { onAuthStateChange() {} };
  const ctx = { exports: {}, require: name => name.endsWith('/payrollPayments') ? load('src/ts/utils/payrollPayments.ts', {}) : dependencies[name], structuredClone,
    crypto: { randomUUID }, ...extra };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, ctx);
  return ctx.exports;
}
function fixture(original) {
  const db = { data: copy(original), writes: 0, race: null, fail: false };
  const supabase = { async rpc(name, params) {
    assert.equal(name,'write_payroll_fragments');db.writes++;
    if(db.fail)return {error:new Error('network')};
    if(db.race){const race=db.race;db.race=null;race(db);}
    if (params.p_mode === 'payment') {
      const fresh = copy(db.data);
      for (const change of params.p_changes) {
        const accrual = fresh.Історія[change.date]?.find(value => String(value.Акт) === String(change.act_id));
        if (!accrual) return { error: { code: '40001', message: 'Missing accrual' } };
        const position = accrual.Записи?.findIndex(value => String(value.recordId) === String(change.record_id));
        const target = change.target === 'act'
          ? Object.fromEntries(Object.entries(accrual).filter(([key]) => key !== 'Записи'))
          : accrual.Записи[position];
        if (api.payrollInputKey(target) !== api.payrollInputKey(change.expected)) {
          return { error: { code: '40001', message: 'Payment baseline changed' } };
        }
        const replacement = { ...target };
        delete replacement.Розраховано;
        delete replacement.__payroll_payments;
        Object.assign(replacement, copy(change.desired));
        if (change.target === 'act') {
          delete accrual.Розраховано;
          delete accrual.__payroll_payments;
          Object.assign(accrual, replacement);
        } else accrual.Записи[position] = replacement;
      }
      db.data = fresh;
      return { data: { slyusar_id: 1, status: 'updated', revision: randomUUID() } };
    }
    const base={Історія:{}},next={Історія:{}};
    for(const change of params.p_changes) {
      for(const item of change.expected)(base.Історія[item.date] ||= []).push(copy(item.value));
      for(const item of change.desired)(next.Історія[item.date] ||= []).push(copy(item.value));
    }
    try {db.data=api.mergePayrollHistory(base,next,db.data);return {data:{slyusar_id:1,status:'updated',revision:randomUUID()}};}
    catch(error){return {error:{code:'40001',message:error.message}};}
  }, from(){throw Error('full employee retry read is forbidden');}};
  const act = load('src/ts/utils/actSafeWrite.ts', { '../vxid/supabaseClient': { supabase } });
  const api = load('src/ts/utils/payrollSafeWrite.ts', { '../vxid/supabaseClient': { supabase }, './actSafeWrite': act });
  return { api, db };
}
const entry = (id, salary = 20) => ({ Акт: String(id), Записи: [{ recordId: 'row-'+id, Робота: 'Same name', Зарплата: salary, Кількість: 1, Ціна: 100 }] });
const history = () => ({ Name: 'Worker', ПроцентРоботи: 20, Історія: { '1926-01-01': [entry(1), entry(2)] } });

for (const target of ['header', 'work', 'new-act']) test(`accrual cannot introduce a paid marker on ${target}`, () => {
  const original = history(), next = copy(original), { api } = fixture(original);
  if (target === 'header') next.Історія['1926-01-01'][0].Розраховано = '20.10.2026';
  if (target === 'work') next.Історія['1926-01-01'][0].Записи[0].Розраховано = '20.10.2026';
  if (target === 'new-act') next.Історія['1926-01-01'].push({ ...entry(3), Розраховано: '20.10.2026' });
  assert.throws(() => api.payrollChanges(original, next, 'accrual'), /не може позначати зарплату виплаченою/);
});

test('unpaid false/null legacy markers remain compatible with accrual', () => {
  const original = history(), next = copy(original), { api } = fixture(original);
  next.Історія['1926-01-01'][0].Розраховано = false;
  next.Історія['1926-01-01'][0].Записи[0].Розраховано = null;
  assert.equal(api.payrollChanges(original, next, 'accrual').length, 1);
});

test('payroll receipt acknowledges only the sent snapshot, preserving edits made during the request',async()=>{
 const pending=[],calls=[];const supabase={rpc:(_name,args)=>{calls.push(copy(args));return new Promise(resolve=>pending.push(resolve));}};
 const act=load('src/ts/utils/actSafeWrite.ts',{'../vxid/supabaseClient':{supabase}});
 const api=load('src/ts/utils/payrollSafeWrite.ts',{'../vxid/supabaseClient':{supabase},'./actSafeWrite':act});
 const data=api.trackPayrollData(1,history());data.Історія['1926-01-01'][0].Записи[0].Зарплата=21;
 const first=api.savePayrollData(data);data.Історія['1926-01-01'][1].Записи[0].Зарплата=35;
 pending.shift()({data:{slyusar_id:1,status:'updated'}});await first;
 const second=api.savePayrollData(data);assert.equal(calls.length,2);assert.equal(calls[1].p_changes[0].act_id,2);
 assert.equal(calls[1].p_changes[0].expected[0].value.Записи[0].Зарплата,20);
 pending.shift()({data:{slyusar_id:1,status:'updated'}});await second;
 data.Історія['1926-01-01'][0].Записи[0].Зарплата=999;api.restorePayrollSnapshot(data);
 assert.equal(data.Історія['1926-01-01'][0].Записи[0].Зарплата,21);assert.equal(data.Історія['1926-01-01'][1].Записи[0].Зарплата,35);
});
function functions(file, names, context) {
  Object.assign(context, load('src/ts/utils/payrollPayments.ts', {}));
  const ast=ts.createSourceFile(file, fs.readFileSync(file,'utf8'),99,true);
  const source=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))
    .map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);
  return context;
}

test('payment UI serializes single and mass operations and releases the guard on failure',async()=>{
 let finish,single=0,mass=0;const notices=[];
 const ctx=functions('src/ts/roboha/bukhhalteriya/zarplata.ts',['withPaymentLock','runMassPaymentCalculation'],{
  payrollReport:null,payrollReportLoading:false,payrollPaymentInFlight:false,payrollSearchFailed:false,showNotification:message=>notices.push(message),
  hasFullAccess:()=>true,readAccountingPeriod:()=>({}),updatePayrollPager(){},withAccountingPaymentOperation:async run=>run(),
  runMassPaymentCalculationOnce:async()=>{mass++;throw Error('failed')},
 });
 const first=ctx.withPaymentLock(()=>{single++;return new Promise(resolve=>finish=resolve)});await ctx.withPaymentLock(async()=>single++);await ctx.runMassPaymentCalculation();
 assert.equal(single,1);assert.equal(mass,0);assert.equal(notices.length,2);finish();await first;
 await ctx.runMassPaymentCalculation();assert.match(notices[2],/failed/);assert.equal(ctx.payrollPaymentInFlight,false);
});
function batchPaymentFixture(count, response) {
 const calls=[];const supabase={rpc:async(name,args)=>{calls.push({name,args:copy(args)});return response?response(args):
  {data:args.p_employees.map(item=>({slyusar_id:item.id,status:'updated'}))};},from(){throw Error('whole table read forbidden')}};
 const act=load('src/ts/utils/actSafeWrite.ts',{'../vxid/supabaseClient':{supabase}});
 const api=load('src/ts/utils/payrollSafeWrite.ts',{'../vxid/supabaseClient':{supabase},'./actSafeWrite':act});
 const employees=Array.from({length:count},(_,index)=>{const data=api.trackPayrollData(index+1,history());
  data.Історія['1926-01-01'][0].Записи[0].Розраховано='21.10.2026';return data;});
 return {api,calls,employees};
}
test('salary batch uses one atomic request with only changed targets and skips acknowledged repeats',async()=>{
 const f=batchPaymentFixture(50);await f.api.savePayrollPayments(f.employees);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'write_payroll_payment_batch');
 assert.equal(f.calls[0].args.p_employees.length,50);
 for(const employee of f.calls[0].args.p_employees){assert.equal(employee.changes.length,1);assert.equal(employee.changes[0].act_id,1);}
 await f.api.savePayrollPayments(f.employees);assert.equal(f.calls.length,1);
});
test('oversized salary batch rejects before the first write rather than partially committing fifty employees',async()=>{
 const f=batchPaymentFixture(51);await assert.rejects(f.api.savePayrollPayments(f.employees),/50 працівників/);
 assert.equal(f.calls.length,0);
});
test('failed atomic salary batch acknowledges none of the employee snapshots',async()=>{
 const f=batchPaymentFixture(2,()=>({error:{message:'concurrent baseline changed'}}));
 await assert.rejects(f.api.savePayrollPayments(f.employees),/concurrent/);
 f.employees.forEach(employee=>f.api.restorePayrollSnapshot(employee));
 assert.equal(f.calls.length,1);
 for(const employee of f.employees)assert.equal(employee.Історія['1926-01-01'][0].Записи[0].Розраховано,undefined);
});
function calculationFixture() {
  const employees=[
    {slyusar_id:1,data:{Name:'Receiver',Доступ:'Приймальник',Склад:1,ПроцентРоботи:20,ПроцентЗапчастин:10}},
    {slyusar_id:2,data:{Name:'Parts',Доступ:'Запчастист',Склад:2,ПроцентЗапчастин:50}},
  ];
  const state={ employees, stock:[{sclad_id:10,price:50,scladNomer:3,xto_zamovuv:2}], stockError:null, writes:0,
    act:{Роботи:[{recordId:'w1',Робота:'Work',Слюсар:'Mechanic',Кількість:1,Ціна:100,Сума:100,Зарплата:40}],
      Деталі:[{recordId:'p1',Деталь:'Part',sclad_id:10,Кількість:1,Ціна:100,Сума:100}],Знижка:0} };
  const api=fixture(history()).api;
  const ids=new WeakMap();
  const ctx=functions('src/ts/roboha/zakaz_naraudy/inhi/zberechennya_zmin_y_danux_aktu.ts',
    ['syncPruimalnikHistory','syncAllZapchastystyHistoryForAct','fetchPayrollEmployeesForAct','persistPayrollData'], {
    payrollPercent:api.payrollPercent, payrollNumber:api.payrollNumber, payrollInputKey:api.payrollInputKey, stableActJson:api.payrollInputKey,
    safeParseJSON:copy,isActFrozen:()=>false,
    trackPayrollData(id,data){const clone=copy(data);ids.set(clone,id);return clone;},
    async savePayrollData(data){state.employees.find(e=>e.slyusar_id===ids.get(data)).data=copy(data);state.writes++;},
    fetchPayrollEmployees:async(_actIds,selector)=>copy(state.employees.filter(e=>!selector?.name||e.data.Name===selector.name)),
    fetchActClientAndCarDataFromDB:async()=>({pib:'Client',auto:'Car'}),
    localStorage:{getItem:()=>null,setItem(){}},
    supabase:{from(table){let name;
      const q={select(){return q;},eq(key,value){name=value;return q;},
        single:async()=>({data:{pruimalnyk:'Receiver',data:copy(state.act)},error:null}),
        in:async()=>({data:copy(state.stock),error:state.stockError}),
        then(resolve,reject){return Promise.resolve({data:copy(state.employees.filter(e=>e.data.Name===name)),error:null}).then(resolve,reject);}};
      assert.ok(['acts','sclad','slyusars'].includes(table));return q;
    }},
  });
  return {state, async save(previous=null){await ctx.syncPruimalnikHistory(7,0,0,'1926-01-01T10:00:00',state.act.Знижка,copy(state.act),previous);},
    record(id){return state.employees.find(e=>e.slyusar_id===id).data.Історія?.['1926-01-01']?.[0];}};
}
test('all salaries truncate down, decimal percent never rounds upwards', () => {
  const { api } = fixture(history());
  for (const [amount, expected] of [[0,0],[.9,0],[1.2,1],[1.9,1],[2.4,2],[2.9,2],[1.9999999999,1]]) {
    assert.equal(api.floorPayrollSalary(amount), expected);
    assert.equal(api.payrollPercent(amount, 100), expected);
  }
  assert.equal(api.payrollPercent(100,29),29);
  assert.equal(api.payrollPercent(123.45,12.5),15);
  assert.equal(api.payrollPercent(-20,20),0);
  assert.equal(api.payrollPercent(100,0),0);
  assert.throws(() => api.payrollPercent(NaN,20));
});
test('payment from stale tab preserves new payroll on another act and current settings', async () => {
  const { api, db } = fixture(history());
  const stale = api.trackPayrollData(1,db.data);
  stale.Історія['1926-01-01'][0].Записи[0].Розраховано = '26.09.2026';
  db.data.Історія['1926-01-01'][1].Записи.push({ recordId:'extra', Зарплата:99 });
  db.data.ПроцентРоботи = 30;
  await api.savePayrollData(stale, 'payment');
  assert.equal(db.data.Історія['1926-01-01'][1].Записи.length,2);
  assert.equal(db.data.ПроцентРоботи,30);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Розраховано,'26.09.2026');
});

test('payment payload contains only its target record and cannot edit salary or move dates',()=>{
  const {api}=fixture(history());const base=history(),next=copy(base);
  next.Історія['1926-01-01'][0].Записи[0].Розраховано='11.10.2026';
  const changes=api.payrollChanges(base,next,'payment');
  assert.equal(changes.length,1);assert.equal(changes[0].target,'record');assert.equal(changes[0].record_id,'row-1');
  assert.equal(changes[0].expected.Історія,undefined);assert.equal(changes[0].expected.Записи,undefined);
  assert.equal(changes[0].desired.Розраховано,'11.10.2026');
  next.Історія['1926-01-01'][0].Записи[0].Зарплата=200;
  assert.throws(()=>api.payrollChanges(base,next,'payment'),/роботу або суму/);
});
test('concurrent different acts merge atomically without a whole-employee retry', async () => {
  const { api, db } = fixture(history());
  const local = api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'][0].Записи[0].Зарплата = 31;
  db.race = db => { db.data.__payroll_revision = randomUUID(); db.data.Історія['1926-01-01'][1].Записи[0].Зарплата=47; };
  await api.savePayrollData(local);
  assert.equal(db.writes,1);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Зарплата,31);
  assert.equal(db.data.Історія['1926-01-01'][1].Записи[0].Зарплата,47);
});
test('same-act concurrent payment blocks stale salary replacement', async () => {
  const { api, db } = fixture(history());
  const local = api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'][0].Записи[0].Зарплата=31;
  db.race = db => { db.data.__payroll_revision = randomUUID(); db.data.Історія['1926-01-01'][0].Записи[0].Розраховано='today'; };
  await assert.rejects(api.savePayrollData(local), /Зарплату змінено/);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Зарплата,20);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Розраховано,'today');
});
test('unchanged employees and repeated successful saves do not write', async () => {
  const { api, db } = fixture(history());
  const local = api.trackPayrollData(1,db.data);
  await api.savePayrollData(local); assert.equal(db.writes,0);
  local.Історія['1926-01-01'][0].Записи[0].Зарплата=0;
  await api.savePayrollData(local); await api.savePayrollData(local);
  assert.equal(db.writes,1);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Зарплата,0);
});
test('failed write is visible and safely retryable', async () => {
  const { api, db } = fixture(history());
  const local = api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'][0].Записи[0].Зарплата=31;
  db.fail=true;
  await assert.rejects(api.savePayrollData(local), /network/);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Зарплата,20);
  db.fail=false; await api.savePayrollData(local);
  assert.equal(db.data.Історія['1926-01-01'][0].Записи[0].Зарплата,31);
});
for (const size of [40,100,500]) test(`old act with ${size} distinct repeated-name works retains rows and payments`, async () => {
  const initial=history();
  initial.Історія['1926-01-01'][0].Записи=Array.from({length:size},(_,i)=>({recordId:'r'+i,Робота:'Same',Зарплата:i,Розраховано:'paid'}));
  const { api, db }=fixture(initial);
  const local=api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'][0].ДатаЗакриття='2026-09-26';
  await api.savePayrollData(local);
  assert.deepEqual(db.data.Історія['1926-01-01'][0].Записи, initial.Історія['1926-01-01'][0].Записи);
  assert.deepEqual(db.data.Історія['1926-01-01'][1],initial.Історія['1926-01-01'][1]);
});
test('duplicate act or work identifiers reject ambiguous changes', async () => {
  const { api, db }=fixture(history());
  const local=api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'].push(entry(1));
  await assert.rejects(api.savePayrollData(local), /Дублікати/);
  local.Історія['1926-01-01'].pop();
  local.Історія['1926-01-01'][0].Записи.push(copy(local.Історія['1926-01-01'][0].Записи[0]));
  await assert.rejects(api.savePayrollData(local), /ідентифікатори/);
  assert.equal(db.writes,0);
});
test('removing one act preserves all other acts even in the same date bucket', async () => {
  const { api, db }=fixture(history());
  const local=api.trackPayrollData(1,db.data);
  local.Історія['1926-01-01'].shift();
  await api.savePayrollData(local);
  assert.deepEqual(db.data.Історія['1926-01-01'],[entry(2)]);
});
test('receiver and parts employee use configured percentages from the saved act without DOM',async()=>{
  const f=calculationFixture();await f.save();
  assert.equal(f.record(1).ЗарплатаРоботи,12);
  assert.equal(f.record(1).ЗарплатаЗапчастин,5);
  assert.equal(f.record(2).ЗарплатаЗапчастин,25);
  assert.equal(f.record(1).ЗарплатаЗапчастистів,25);
});
test('unchanged act retains accrued salaries after stock prices and employee rates change',async()=>{
  const f=calculationFixture();await f.save();
  f.state.employees[0].data.ПроцентРоботи=99;
  f.state.employees[1].data.ПроцентЗапчастин=99;
  f.state.stock[0].price=95;
  await f.save(copy(f.state.act));
  assert.equal(f.record(1).ЗарплатаРоботи,12);
  assert.equal(f.record(1).ЗарплатаЗапчастин,5);
  assert.equal(f.record(2).ЗарплатаЗапчастин,25);
});
test('stock ownership change on an unchanged act cannot add a second parts salary',async()=>{
  const f=calculationFixture();await f.save();
  f.state.employees.push({slyusar_id:3,data:{Name:'New parts employee',Доступ:'Запчастист',ПроцентЗапчастин:50,Склад:2}});
  f.state.stock[0].xto_zamovuv=3;
  await f.save(copy(f.state.act));
  assert.equal(f.record(2).ЗарплатаЗапчастин,25);
  assert.equal(f.record(3),undefined);
});
test('missing or failed stock lookup does not silently replace payroll with zero or inflated margin',async()=>{
  const f=calculationFixture();await f.save();const old=copy(f.state.employees);
  f.state.stockError={message:'offline'};
  await assert.rejects(f.save(), /закупівельні ціни/);
  assert.deepEqual(f.state.employees,old);
  f.state.stockError=null;f.state.stock=[];
  await assert.rejects(f.save(), /Не знайдено закупівельну|відсутня закупівельна ціна/);
  assert.deepEqual(f.state.employees,old);
});
test('deleting a single saved part recalculates payroll and removes only its parts-employee accrual',async()=>{
  const f=calculationFixture();await f.save();const previous=copy(f.state.act);
  f.state.act.Деталі=[];await f.save(previous);
  assert.equal(f.record(1).ЗарплатаРоботи,12);
  assert.equal(f.record(1).ЗарплатаЗапчастин,0);
  assert.equal(f.record(2),undefined);
});
test('report shows stored parts payroll even when total margin is negative and excludes frozen status',()=>{
  const ctx=functions('src/ts/roboha/bukhhalteriya/zarplata.ts',['searchDataInDatabase','payrollRecordSettlement','toIsoDate'],{
    slyusarsData:[{Name:'Receiver',Історія:{'1926-01-01':[{Акт:'7',СуммаРоботи:0,СуммаЗапчастин:-100,МаржаДляЗарплати:50,ЗарплатаРоботи:0,ЗарплатаЗапчастин:5,Розраховано:'26.09.2026'}]}}],
    payrollReport:null,payrollQuiet:false,podlegleData:[],allPodlegleData:[],frozenActIds:new Set(),podlegleDateFilterMode:'open',
    lastSearchDateOpen:'',lastSearchDateClose:'',hasPodlegleDataLoaded:false,
    assertPayrollHistory:fixture(history()).api.assertPayrollHistory,
    payrollEmployeeId:()=>1,todayIso:()=>'',inRangeByIso:()=>true,getActDateClose:()=>'',isActClosed:()=>false,
    formatNumber:String,byId:()=>null,notificationHelperInSearch(){},ensureWorkSmartDropdown(){},refreshWorkDropdownOptions(){},refreshActDropdownOptions(){},updatepodlegleTable(){},
  });
  ctx.searchDataInDatabase('1926-01-01','','');
  assert.equal(ctx.podlegleData[0].salary,5);assert.equal(ctx.podlegleData[0].isPaid,true);
  ctx.frozenActIds.add('7');ctx.searchDataInDatabase('1926-01-01','','');assert.equal(ctx.podlegleData.length,0);
  ctx.frozenActIds.clear();ctx.searchDataInDatabase('1926-01-01','','');
  assert.equal(ctx.podlegleData[0].salary,5);assert.equal(ctx.podlegleData[0].isPaid,true);
});
test('mechanic sync: repeated save, same-name works, deletion and transfer affect only the selected act',async()=>{
  const api=fixture(history()).api;
  const employees=new Map([
    [1,{Name:'A',Історія:{'1926-01-02':[{Акт:'7',Записи:[{recordId:'w1',Робота:'Same',Кількість:1,Ціна:100,Зарплата:20,Розраховано:'paid'},{recordId:'w2',Робота:'Same',Кількість:1,Ціна:100,Зарплата:30}]}],'1926-01-01':[entry(99)]}}],
    [2,{Name:'B',Історія:{'1926-01-01':[entry(100)]}}],
  ]);
  const ctx=functions('src/ts/roboha/zakaz_naraudy/inhi/save_work.ts',['employeeKey','syncSlyusarsHistoryForAct'],{
    structuredClone,
    payrollActBucket:api.payrollActBucket,
    fetchSlyusarByName:async key=>{
      const id=key.startsWith('#employee:')?Number(key.slice(10)):[...employees].find(([,d])=>d.Name===key)?.[0];
      return id?{slyusar_id:id,data:copy(employees.get(id))}:null;
    },
    updateSlyusarJson:async row=>employees.set(row.slyusar_id,copy(row.data)),
    ensureSlyusarHistoryRoot:row=>row.data.Історія ||= {},
    globalCache:{worksWithId:[]},showNotification(){},
  });
  const row=(id,name,pay)=>({recordId:id,slyusarName:name,Найменування:'Same',Кількість:1,Ціна:100,Зарплата:pay});
  const params={actId:7,dateKey:'1926-01-01',dateClose:null,clientInfo:'Client',carInfo:'Car',
    currentRows:[row('w1','A',20),row('w2','A',30)],
    prevRows:[{recordId:'w1',slyusarName:'A',slyusar_id:1},{recordId:'w2',slyusarName:'A',slyusar_id:1}]};
  await ctx.syncSlyusarsHistoryForAct(params);
  await ctx.syncSlyusarsHistoryForAct(params);
  assert.equal(employees.get(1).Історія['1926-01-02'][0].Записи.length,2);
  assert.equal(employees.get(1).Історія['1926-01-02'][0].Записи[0].Розраховано,'paid');
  params.currentRows=[row('w1','A',20),row('w2','B',30)];
  await ctx.syncSlyusarsHistoryForAct(params);
  assert.equal(employees.get(1).Історія['1926-01-02'][0].Записи.length,1);
  assert.equal(employees.get(2).Історія['1926-01-01'].find(e=>e.Акт==='7').Записи[0].Зарплата,30);
  assert.deepEqual(employees.get(1).Історія['1926-01-01'],[entry(99)]);
  assert.deepEqual(employees.get(2).Історія['1926-01-01'].find(e=>e.Акт==='100'),entry(100));
});
test('payment record lookup cannot borrow a matching recordId from another act',()=>{
  const ctx=functions('src/ts/roboha/bukhhalteriya/zarplata.ts',['findPodlegleRecordIndex'],{
    podlegleData:[{employeeId:1,name:'A',act:'1',dateOpen:'date',recordId:'same'},
      {employeeId:1,name:'A',act:'2',dateOpen:'date',recordId:'same'}],
  });
  assert.equal(ctx.findPodlegleRecordIndex({employeeId:1,name:'A',act:'2',dateOpen:'date',recordId:'same'}),1);
});

function freezeFixture() {
  const state = {
    act: {date_off:null,data:{Роботи:[{Робота:'Work',Зарплата:150,Кількість:1,Ціна:500}],
      Деталі:[{Деталь:'Part',sclad_id:10,Кількість:2,Ціна:40},{Деталь:'Part',sclad_id:10,Кількість:2,Ціна:40}]}},
    used:4,stockCalls:[],committedStatuses:[],failEmployee:null,failActWrite:false,
    employees:['Приймальник','Слюсар','Запчастист','Складовщик','Адміністратор'].map((role,i)=>({
      slyusar_id:i+1,data:{Name:role,Доступ:role,Історія:{'2026-01-01':[entry(7,150),entry(99,321)],'2025-01-01':[entry(100,88)]}},
    })),
  };
  const api=fixture(history()).api;
  const snapshots=new WeakMap();
  const ctx=functions('src/ts/roboha/zakaz_naraudy/inhi/knopka_zamok.ts',
    ['freezeAct','unfreezeAct','removeSalaryFromSlyusars','getInventoryAllocations','applyAllocations'], {
    fetchPayrollEmployees:async()=>copy(state.employees),
    trackPayrollData(id,data){const value=copy(data);snapshots.set(value,{id,base:copy(data)});return value;},
    async savePayrollData(data){
      const snap=snapshots.get(data);
      if(snap.id===state.failEmployee)throw new Error('network');
      const employee=state.employees.find(e=>e.slyusar_id===snap.id);
      employee.data=api.mergePayrollHistory(snap.base,data,employee.data);
    },
    parseActData:copy,isActFrozen:act=>act.data.Заморожений===true,
    dataWithFrozenState:(data,frozen)=>({...copy(data),Заморожений:frozen}),
    async writeActSnapshot(id,expected,next){
      assert.equal(id,7);assert.deepEqual(state.act.data,expected);
      if(state.failActWrite)throw new Error('write failed');
      state.act.data=copy(next);return {data:copy(next)};
    },logAction:async()=>{},
    supabase:{
      from(table){assert.equal(table,'acts');const q={select:()=>q,eq:()=>q,single:async()=>({data:copy(state.act),error:null})};return q;},
      async rpc(name,args){assert.equal(name,'apply_sclad_delta');state.stockCalls.push(copy(args));state.used+=args.delta_val;return {error:null};},
    },
  });
  const onCommitted=status=>state.committedStatuses.push(copy(status));
  return {state,ctx:{...ctx,
    freezeAct:id=>ctx.freezeAct(id,onCommitted),
    unfreezeAct:id=>ctx.unfreezeAct(id,onCommitted),
  }};
}
test('freeze returns 4 parts once, deletes this act payroll for every role, preserves act content and other acts',async()=>{
  const {state,ctx}=freezeFixture();const before=copy(state.act.data);
  await ctx.freezeAct(7);
  assert.equal(100-state.used,100);
  assert.equal(state.stockCalls.length,1);
  assert.equal(state.act.data.Заморожений,true);
  assert.deepEqual(state.act.data.Роботи,before.Роботи);
  assert.deepEqual(state.act.data.Деталі,before.Деталі);
  for(const employee of state.employees){
    assert.deepEqual(employee.data.Історія['2026-01-01'],[entry(99,321)]);
    assert.deepEqual(employee.data.Історія['2025-01-01'],[entry(100,88)]);
  }
  await ctx.freezeAct(7);
  assert.equal(state.stockCalls.length,1);
});
test('partial payroll deletion remains frozen and retries without a second stock return',async()=>{
  const {state,ctx}=freezeFixture();state.failEmployee=2;
  await assert.rejects(ctx.freezeAct(7),/видалення зарплат не завершено/);
  assert.equal(state.act.data.Заморожений,true);
  assert.equal(state.used,0);
  state.failEmployee=null;await ctx.freezeAct(7);
  assert.equal(state.stockCalls.length,1);
  assert.ok(state.employees.every(e=>Object.values(e.data.Історія).flat().every(row=>row.Акт!=='7')));
});
test('freeze returns only this act quantity, retaining stock consumption from other acts',async()=>{
  const {state,ctx}=freezeFixture();
  state.act.data.Деталі[0].Кількість=3; // this act = 5 parts
  state.used=30; // 25 in other acts + 5 in this one
  await ctx.freezeAct(7);
  assert.equal(state.used,25);
  assert.equal(50-state.used,25);
});
test('failed frozen-state write compensates inventory and never deletes payroll',async()=>{
  const {state,ctx}=freezeFixture();const before=copy(state.employees);state.failActWrite=true;
  await assert.rejects(ctx.freezeAct(7),/write failed/);
  assert.equal(state.used,4);
  assert.deepEqual(state.employees,before);
});
test('unfreeze consumes parts once, preserves act rows, marks payroll for recalculation on save',async()=>{
  const {state,ctx}=freezeFixture();const before=copy(state.act.data);
  await ctx.freezeAct(7);await ctx.unfreezeAct(7);await ctx.unfreezeAct(7);
  assert.equal(state.used,4);
  assert.equal(state.stockCalls.length,2);
  assert.equal(state.act.data.Заморожений,false);
  assert.equal(state.act.data.__payroll_pending,true);
  assert.deepEqual(state.act.data.Роботи,before.Роботи);
  assert.deepEqual(state.act.data.Деталі,before.Деталі);
});
