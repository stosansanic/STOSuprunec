const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), ts = require('typescript'), path = require('path');
const { randomUUID } = require('crypto');
const base = {from:'2026-10-01',to:'2026-10-31',mode:'open',payment:'all',status:'all',percentage:'all',name:'',act:'',work:''};
function fixture() {
  let actor='A'; const listeners=new Map(), modules=new Map();
  const context={structuredClone,AbortController,Date,Intl,crypto:{randomUUID},localStorage:{getItem:()=>actor},
    window:{addEventListener:(name,fn)=>listeners.set(name,fn)},document:{addEventListener:(name,fn)=>listeners.set(name,fn)}};
  function load(file) {
    file=path.resolve(file); if(modules.has(file))return modules.get(file);
    const api={};modules.set(file,api);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
      {...context,exports:api,require:name=>name.endsWith('supabaseClient')?{supabase:{auth:{onAuthStateChange:fn=>listeners.set('auth',fn)}}}
        :name.endsWith('vspluvauhe_povidomlenna')?{showNotification(){}}:load(path.resolve(path.dirname(file),name+'.ts'))});
    return api;
  }
  return {api:load('src/ts/roboha/bukhhalteriya/payrollReportRead.ts'),payments:load('src/ts/utils/payrollPayments.ts'),
    filters:load('src/ts/roboha/bukhhalteriya/reportCacheFilter.ts'),period:load('src/ts/roboha/bukhhalteriya/accountingPeriod.ts'),
    setActor:v=>actor=v,emit:(name,...args)=>listeners.get(name)?.(...args)};
}
const client=fn=>({rpc:(...args)=>({abortSignal:()=>Promise.resolve(fn(...args))})});
function page(offset=0,total=101,limit=50) {
  const entries=Array.from({length:Math.min(limit,total-offset)},(_,i)=>({Акт:String(offset+i+1),Записи:[{recordId:'r',Робота:'Work',Ціна:100,Кількість:1,Зарплата:20}]}));
  return {employees:[{slyusar_id:1,data:{Name:'Worker',Історія:{'2026-10-01':entries}}}],keys:entries.map(e=>[1,'2026-10-01',e.Акт,0]),statuses:[],total,
    revenue:total*100,salary:total*20,paidAmount:0,due:total*20,overpaid:0,paidInPeriod:0,has_more:offset+limit<total,page_size:limit,acts:[],works:[]};
}
function funcs(names,ctx) {
  const file='src/ts/roboha/bukhhalteriya/zarplata.ts',ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
  const source=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
  vm.createContext(ctx);vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);return ctx;
}
test('payroll pages deduplicate/cache without mutable shared data and reject late actor responses',async()=>{
  const f=fixture();let resolve,calls=0;const db=client(()=>{calls++;return new Promise(r=>resolve=r)});
  const a=f.api.readPayrollReport(base,0,db),b=f.api.readPayrollReport(base,0,db);resolve({data:page()});const [x,y]=await Promise.all([a,b]);
  assert.equal(calls,1);x.employees.length=0;assert.equal(y.employees.length,1);assert.equal((await f.api.readPayrollReport(base,0,db)).employees.length,1);assert.equal(calls,1);
  const late=f.api.readPayrollReport(base,50,db);f.setActor('B');resolve({data:page(50)});await assert.rejects(late,/змінилися/);
});
test('explicit export collects all matched rows beyond page and deduplicates act fragments',async()=>{
  const {api}=fixture(),calls=[];const all=await api.readAllPayrollReport(base,client((_,args)=>{calls.push(args.p_offset);return {data:page(args.p_offset)}}));
  assert.deepEqual(calls,[0,50,100]);assert.equal(all.keys.length,101);assert.equal(all.employees[0].data.Історія['2026-10-01'].length,101);
});
test('complete export rejects changed accrual/payment totals, missing SQL and duplicate paging rows',async()=>{
  for(const kind of ['salary','paidAmount','due','overpaid','paidInPeriod','duplicate','missing']) {
    const {api}=fixture();await assert.rejects(api.readAllPayrollReport(base,client((_,args)=>{
      if(kind==='missing')return {error:{code:'PGRST202',message:'missing SQL'}};
      const data=page(args.p_offset);if(args.p_offset){if(kind==='duplicate')data.keys[0]=[1,'2026-10-01','1',0];else data[kind]++;}return {data};
    })));
  }
});
test('old report without ledger totals requires migration instead of displaying invented zeroes',async()=>{
  const {api}=fixture();const data=page();delete data.paidInPeriod;
  await assert.rejects(api.readPayrollReport(base,0,client(()=>({data}))),/traffic_payroll_payments/);
});
test('payroll report invalidates on mutations/auth/owner changes and payment saves',async()=>{
  const f=fixture();let calls=0;const db=client(()=>{calls++;return{data:page()}});
  await f.api.readPayrollReport(base,0,db);await f.api.readPayrollReport(base,0,db);assert.equal(calls,1);
  for(const event of ['sto:act-saved','sto:employee-saved','other-base-data-updated','auth','online']){f.emit(event);await f.api.readPayrollReport(base,0,db);}assert.equal(calls,6);
  f.api.patchPayrollReportPayments([]);await f.api.readPayrollReport(base,0,db);assert.equal(calls,7);
  f.setActor('B');await f.api.readPayrollReport(base,0,db);f.setActor('A');await f.api.readPayrollReport(base,0,db);assert.equal(calls,9);
});
test('PostgREST failure exposes its message and code without caching or retrying',async()=>{
  const {api}=fixture();let calls=0;const db=client(()=>{calls++;return{error:{code:'57014',message:'canceling statement due to statement timeout',details:'diagnostic',hint:null}}});
  await assert.rejects(api.readPayrollReport(base,0,db),e=>e.code==='57014'&&e.message.includes('statement timeout')&&e.details==='diagnostic');assert.equal(calls,1);
  await assert.rejects(api.readPayrollReport(base,0,db),/statement timeout/);assert.equal(calls,2);
});
function rendered(entries,mode='open',from=base.from,to=base.to) {
  const f=fixture();const ctx=funcs(['payrollRecordSettlement','searchDataInDatabase'],{...f.payments,
    payrollReport:null,payrollQuiet:true,payrollRowKey:row=>JSON.stringify([row.employeeId,row.dateOpen,String(row.act),row.workIndex??null]),hiddenPayrollKeys:new Set(),
    slyusarsData:[{Name:'Worker',Історія:{'2026-10-01':entries}}],podlegleData:[],allPodlegleData:[],frozenActIds:new Set(),
    podlegleDateFilterMode:mode,lastSearchDateOpen:'',lastSearchDateClose:'',hasPodlegleDataLoaded:false,assertPayrollHistory(){},payrollEmployeeId:()=>1,
    todayIso:()=>base.to,inRangeByIso:(day,a,b)=>f.period.accountingIso(day)>=a&&f.period.accountingIso(day)<=b,getActDateClose:()=>'',isActClosed:()=>false,
    toIsoDate:f.period.accountingIso,formatNumber:String,byId:()=>null,notificationHelperInSearch(){},ensureWorkSmartDropdown(){},refreshWorkDropdownOptions(){},refreshActDropdownOptions(){},updatepodlegleTable(){}});
  ctx.searchDataInDatabase(from,to,'');return ctx;
}
test('renderer retains original work index and only selected page keys',()=>{
  const works=Array.from({length:100},(_,i)=>({recordId:'r'+i,Робота:'Work',Кількість:1,Ціна:100,Зарплата:20}));const ctx=rendered([{Акт:'7',Записи:works}]);
  ctx.payrollReport={keys:[[1,'2026-10-01','7',75]],total:100};ctx.searchDataInDatabase(base.from,base.to,'');assert.equal(ctx.podlegleData.length,1);assert.equal(ctx.podlegleData[0].workIndex,75);assert.equal(ctx.podlegleData[0].recordId,'r75');
});
const paidWork=(salary=40)=>({recordId:'r1',Робота:'Work',Кількість:1,Ціна:50,Зарплата:salary,Розраховано:'17.10.2026',__payroll_payments:[{id:'legacy',amount:25,date:'17.10.2026'}]});
test('renderer shows accrued, paid, due/overpaid and retains zero earned paid work',()=>{
  for(const [salary,qty,expectedDue,overpaid] of [[40,1,15,0],[10,1,0,15],[0,0,0,25]]) {
    const row=rendered([{Акт:'1274',Записи:[{...paidWork(salary),Кількість:qty}]}]).podlegleData[0];
    assert.ok(row);assert.equal(row.salary,salary);assert.equal(row.paidAmount,25);assert.equal(row.due,expectedDue);assert.equal(row.overpaid,overpaid);
  }
});
test('renderer inherits paid header and handles receiver/parts ledger with established earned formulas',()=>{
  const entries=[{Акт:'1',Розраховано:'17.10.2026',Записи:[{recordId:'r',Робота:'Work',Кількість:1,Ціна:50,Зарплата:25}]},
    {Акт:'2',СуммаРоботи:100,СуммаЗапчастин:100,ЗарплатаРоботи:10,ЗарплатаЗапчастин:5,__payroll_payments:[{id:'legacy',amount:20,date:'17.10.2026'}]},
    {Акт:'3',СуммаЗапчастин:100,ЗарплатаЗапчастин:25,__payroll_payments:[{id:'legacy',amount:10,date:'17.10.2026'}]}];
  const rows=rendered(entries).podlegleData;const row=id=>rows.find(r=>r.act===id);
  assert.equal(row('1').isPaid,true);assert.equal(row('1').due,0);assert.equal(row('2').salary,15);assert.equal(row('2').overpaid,5);assert.equal(row('3').due,15);
});
test('paid date mode keeps one work row and separates period cash from current accrual',()=>{
  const work=paidWork();work.__payroll_payments.push({id:'topup',amount:15,date:'20.10.2026'});
  const rows=rendered([{Акт:'1274',Записи:[work]}],'paid','2026-10-19','2026-10-21').podlegleData;
  assert.equal(rows.length,1);assert.equal(rows[0].salary,40);assert.equal(rows[0].paidAmount,40);assert.equal(rows[0].paidInPeriod,15);assert.equal(rows[0].paymentDate,'20.10.2026');
});
test('complete cached paid report narrows dates locally and recomputes settlement totals',async()=>{
  const f=fixture();const work=paidWork();work.__payroll_payments.push({id:'topup',amount:15,date:'20.10.2026'});
  const data=page(0,1);data.employees[0].data.Історія['2026-10-01']=[{Акт:'1274',Записи:[work]}];data.keys=[[1,'2026-10-01','1274',0]];
  Object.assign(data,{salary:40,revenue:50,paidAmount:40,due:0,overpaid:0,paidInPeriod:40});let calls=0;const db=client(()=>{calls++;return{data}});
  await f.api.readPayrollReport({...base,mode:'paid'},0,db);
  const narrowed=await f.api.readPayrollReport({...base,mode:'paid',from:'2026-10-19',to:'2026-10-21'},0,db);
  assert.equal(calls,1);assert.equal(narrowed.salary,40);assert.equal(narrowed.paidInPeriod,15);assert.equal(narrowed.paidAmount,40);assert.equal(narrowed.total,1);
  const empty=await f.api.readPayrollReport({...base,mode:'paid',from:'2026-10-22',to:'2026-10-23'},0,db);assert.equal(empty.total,0);assert.equal(calls,1);
});
test('local unpaid filter includes partly paid wage and excludes overpayment',()=>{
  const f=fixture(),data=page(0,2);const entries=data.employees[0].data.Історія['2026-10-01'];entries[0].Записи=[paidWork(40)];entries[1].Записи=[paidWork(10)];
  const due=f.filters.filterPayrollPage(data,{...base,payment:'unpaid'},0);assert.equal(due.total,1);assert.equal(due.due,15);assert.equal(due.paidAmount,25);
  const paid=f.filters.filterPayrollPage(data,{...base,payment:'paid'},0);assert.equal(paid.total,1);assert.equal(paid.overpaid,15);
});
test('late payroll page cannot overwrite changed filters or a newer request',async()=>{
  const pending=[],applied=[];let filters={name:'A'};
  const ctx=funcs(['loadPayrollReportPage'],{localStorage:{getItem:()=>"A"},payrollPaymentInFlight:false,payrollReportGeneration:0,payrollReportLoading:false,payrollReportOffset:0,
    payrollVisibleCount:0,payrollSearchFailed:false,payrollScroll:{reset(){},pause(){}},hiddenPayrollKeys:new Set(),readAccountingPeriod:()=>base,accountingInitialRows:()=>10,
    currentPayrollFilters:()=>filters,readPayrollReport:()=>new Promise(resolve=>pending.push(resolve)),updatePayrollPager(){},applyPayrollReport:p=>applied.push(p),showNotification(){}});
  const first=ctx.loadPayrollReportPage();filters={name:'B'};const second=ctx.loadPayrollReportPage();pending[1](page());await second;pending[0](page());await first;
  assert.equal(applied.length,1);assert.equal(ctx.payrollReportLoading,false);
});
test('bulk payment rejects changed filter or actor while password confirmation is pending',async()=>{
  for(const change of ['filter','actor']) {
    let confirm,actor='A',filter={name:'One'},reads=0;const notices=[];
    const ctx=funcs(['runMassPaymentCalculationOnce','payrollPaymentScope'],{payrollReportGeneration:0,accountingSearchScope:()=>actor,currentPayrollFilters:()=>filter,hasFullAccess:()=>true,
      getFilteredpodlegleData:()=>[],capturePayrollPayments:()=>[{amount:20}],formatNumber:String,
      createPasswordConfirmationModal:()=>new Promise(resolve=>confirm=resolve),showNotification:message=>notices.push(message),executePayrollPaymentSelection:async()=>{reads++;throw Error('must not write')}});
    const pending=ctx.runMassPaymentCalculationOnce();if(change==='filter')filter={name:'Two'};else actor='B';confirm(true);await assert.rejects(pending,/змінився/);assert.equal(reads,0);
  }
});
function paymentUi(work=paidWork()) {
  const f=fixture(),entry={Акт:'1274',Записи:[work]},employee={Name:'Worker',Історія:{'2026-10-01':[entry]}};
  const record={employeeId:1,name:'Worker',act:'1274',dateOpen:'2026-10-01',recordId:work.recordId,workIndex:0,work:work.Робота,quantity:work.Кількість,price:work.Ціна,salary:work.Зарплата};
  const state={writes:0,confirmations:[],notices:[],fail:false,confirm:true};
  const ctx=funcs(['findPayrollPaymentTarget','replacePayrollPaymentTarget','payrollPaymentConfirmation','payrollRecordSettlement','findPodlegleRecordIndex',
    'togglepodleglePaymentWithConfirmation','togglepodleglePayment','withPaymentLock','runMassPaymentCalculationOnce','runMassPaymentCalculation',
    'payrollPaymentScope','capturePayrollPayments','executePayrollPaymentSelection'],{
    ...f.payments,structuredClone,crypto:{randomUUID},slyusarsData:[employee],podlegleData:[record],payrollEmployeeId:()=>1,
    lastSearchDateOpen:base.from,lastSearchDateClose:base.to,podlegleDateFilterMode:'open',toIsoDate:f.period.accountingIso,getCurrentDate:()=>'20.10.2026',formatNumber:String,
    payrollReport:null,payrollReportGeneration:0,payrollReportLoading:false,payrollPaymentInFlight:false,payrollSearchFailed:false,localStorage:{getItem:()=>"A"},currentPayrollFilters:()=>base,hasFullAccess:()=>true,
    accountingSearchScope:()=>"A",readAccountingPeriod:()=>base,withAccountingPaymentOperation:async run=>run(),updatePayrollPager(){},payrollScroll:{pause(){}},
    createPasswordConfirmationModal:async(action,details)=>{state.confirmations.push({action,details});return state.confirm},showNotification:message=>state.notices.push(message),
    fetchAllActAccountingStatuses:async()=>new Map([['1274',{actId:'1274',isFrozen:false,payrollPending:false}]]),clearPayrollReportCache(){},updatepodlegleTable(){},
    saveSlyusarsDataToDatabase:async()=>{state.writes++;if(state.fail)throw Error('save failed')},
    getFilteredpodlegleData:()=>ctx.podlegleData,byId:()=>null,restorePayrollSnapshot(){},searchDataInDatabase(){}});
  return {ctx,state,work,entry,record};
}
test('single UI payment appends only outstanding amount, retaining original payment/date and retry does not duplicate',async()=>{
  const f=paymentUi();await f.ctx.togglepodleglePayment(0,'pay');
  assert.equal(f.state.writes,1);assert.equal(f.work.Розраховано,'17.10.2026');assert.equal(f.work.__payroll_payments.length,2);
  assert.equal(f.work.__payroll_payments[1].amount,15);assert.equal(f.work.__payroll_payments[0].amount,25);assert.match(f.state.confirmations[0].details,/15/);
  await f.ctx.togglepodleglePayment(0,'pay');assert.equal(f.state.writes,1);assert.equal(f.work.__payroll_payments.length,2);
});
test('ledger cancellation is explicit, cancels only last active payment and retains original payment',async()=>{
  const f=paymentUi();await f.ctx.togglepodleglePayment(0,'pay');f.state.confirm=false;
  await f.ctx.togglepodleglePayment(0,'void');assert.equal(f.state.writes,1);assert.match(f.state.confirmations[1].details,/останню позначку виплати 15/);
  assert.equal(f.work.__payroll_payments.length,2);f.state.confirm=true;await f.ctx.togglepodleglePayment(0,'void');
  assert.equal(f.state.writes,2);assert.equal(f.work.__payroll_payments.length,3);assert.equal(f.work.__payroll_payments[2].voids,f.work.__payroll_payments[1].id);
  assert.equal(f.record.paidAmount,25);assert.equal(f.record.due,15);assert.equal(f.work.Розраховано,'17.10.2026');
});
test('single failed payment restores entire ledger and optimistic UI',async()=>{
  const f=paymentUi(),before=structuredClone(f.work);f.state.fail=true;await f.ctx.togglepodleglePayment(0,'pay');
  assert.deepEqual(f.work,before);assert.equal(f.state.writes,1);assert.equal(f.record.salary,40);assert.ok(f.state.notices.some(n=>/save failed/.test(n)));
});
test('bulk payment pays only due amounts and skips overpayment or inherited already-paid work',async()=>{
  const f=paymentUi(),over=paidWork(10),inherited={recordId:'parent',Робота:'Parent',Кількість:1,Ціна:40,Зарплата:25};over.recordId='over';
  f.entry.Записи.push(over);f.ctx.podlegleData.push({...f.record,recordId:'over',workIndex:1,salary:10});
  const second={Акт:'1275',Розраховано:'17.10.2026',Записи:[inherited]};f.ctx.slyusarsData[0].Історія['2026-10-01'].push(second);
  f.ctx.podlegleData.push({...f.record,act:'1275',recordId:'parent',work:'Parent',salary:25,price:40});
  f.ctx.fetchAllActAccountingStatuses=async()=>new Map(['1274','1275'].map(actId=>[actId,{actId,isFrozen:false,payrollPending:false}]));
  await f.ctx.runMassPaymentCalculationOnce();assert.equal(f.state.writes,1);assert.equal(f.work.__payroll_payments[1].amount,15);
  assert.equal(over.__payroll_payments.length,1);assert.equal(inherited.Розраховано,undefined);assert.equal(inherited.__payroll_payments,undefined);
});
test('Excel salary cell leads with actual period payment and labels current accrual and balances',()=>{
  const file='src/ts/roboha/bukhhalteriya/bukhhalteriya.ts',ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getPodlegleExcelCellText');const ctx={formatNumber:String};vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
  const text=ctx.getPodlegleExcelCellText({dataset:{excelSalary:'15',excelEarned:'40',excelPaid:'40',excelDue:'0',excelOverpaid:'0',excelPaidPeriod:'15',excelPaymentMode:'paid'}},'Сума');
  assert.match(text,/^Виплачено за період: 15/);assert.match(text,/Нараховано: 40/);assert.match(text,/Виплачено всього: 40/);
});

test('salary mass payment captures all loaded rows, including prefetched rows, but never reads another page',async()=>{
  const f=paymentUi();
  const second={...paidWork(55),recordId:'prefetched'};f.entry.Записи.push(second);
  f.ctx.podlegleData.push({...f.record,recordId:'prefetched',workIndex:1,salary:55});
  f.ctx.payrollVisibleCount=1;
  f.ctx.readAllPayrollReport=()=>{throw Error('must not read whole history')};
  f.ctx.readPayrollReport=()=>{throw Error('must not re-read report')};
  f.ctx.fetchAllActAccountingStatuses=()=>{throw Error('SQL already guards act')};
  await f.ctx.runMassPaymentCalculation();
  assert.equal(f.state.writes,1);assert.match(f.state.confirmations[0].details,/45 грн за 2/);
  assert.equal(f.work.__payroll_payments.at(-1).amount,15);assert.equal(second.__payroll_payments.at(-1).amount,30);
});

test('rows loaded during password confirmation are not added to the captured batch',async()=>{
  const f=paymentUi();let confirm;
  f.ctx.createPasswordConfirmationModal=()=>new Promise(resolve=>confirm=resolve);
  const saving=f.ctx.runMassPaymentCalculation();
  const extra={...paidWork(55),recordId:'late'};f.entry.Записи.push(extra);
  f.ctx.podlegleData.unshift({...f.record,recordId:'late',workIndex:1,salary:55});
  confirm(true);await saving;
  assert.equal(f.state.writes,1);assert.equal(extra.__payroll_payments.length,1);
  assert.equal(f.work.__payroll_payments.at(-1).amount,15);
});

test('changed target after confirmation is rejected before mutation; reordered indexes keep the same identity',async()=>{
  const f=paymentUi();let confirm;
  f.ctx.createPasswordConfirmationModal=()=>new Promise(resolve=>confirm=resolve);
  const saving=f.ctx.togglepodleglePayment(0,'pay');
  f.work.Зарплата=900;confirm(true);await saving;
  assert.equal(f.state.writes,0);assert.equal(f.work.__payroll_payments.length,1);
  assert.ok(f.state.notices.some(message=>/вже змінилася/.test(message)));
});

test('cancel/no-op triggers no status reads, writes, or report refreshes',async()=>{
  const f=paymentUi();f.state.confirm=false;
  f.ctx.readPayrollReport=()=>{throw Error('cancel must not fetch')};
  f.ctx.loadPayrollReportPage=()=>{throw Error('cancel must not reload')};
  f.ctx.fetchAllActAccountingStatuses=()=>{throw Error('cancel must not read status')};
  await f.ctx.runMassPaymentCalculation();await f.ctx.togglepodleglePayment(0,'pay');
  assert.equal(f.state.writes,0);assert.equal(f.ctx.payrollPaymentInFlight,false);
  f.work.Зарплата=10;await f.ctx.runMassPaymentCalculation();assert.equal(f.state.confirmations.length,2);
});

test('double click while password dialog is open starts only one salary confirmation',async()=>{
  const f=paymentUi();let confirm,count=0;
  f.ctx.createPasswordConfirmationModal=()=>{count++;return new Promise(resolve=>confirm=resolve)};
  const first=f.ctx.togglepodleglePayment(0,'pay');await f.ctx.togglepodleglePayment(0,'pay');await f.ctx.runMassPaymentCalculation();
  assert.equal(count,1);confirm(true);await first;assert.equal(f.state.writes,1);
});

test('failed payment does not retry automatically and blocks another payment until a new search',async()=>{
  const f=paymentUi();f.state.fail=true;
  await f.ctx.togglepodleglePayment(0,'pay');await f.ctx.togglepodleglePayment(0,'pay');
  assert.equal(f.state.writes,1);assert.equal(f.ctx.payrollSearchFailed,true);
});

test('payment receipt after actor change is not applied to the new actor view',async()=>{
  const f=paymentUi();let ack,actor='A',renders=0;
  f.ctx.accountingSearchScope=()=>actor;f.ctx.updatepodlegleTable=()=>renders++;
  f.ctx.saveSlyusarsDataToDatabase=()=>new Promise(resolve=>ack=resolve);
  const saving=f.ctx.togglepodleglePayment(0,'pay');await new Promise(resolve=>setImmediate(resolve));
  actor='B';ack();await saving;
  assert.equal(renders,0);assert.equal(f.work.__payroll_payments.length,2);
  assert.ok(f.state.notices.some(message=>/Виплату збережено/.test(message)));
});

test('local payment reconciliation keeps unfetched totals, hidden child works and continuation offsets',()=>{
  const f=fixture(),before=page(0,101,2),after=structuredClone(before.employees);
  const entry=after[0].data.Історія['2026-10-01'][0];
  entry.Записи.push({recordId:'hidden',Робота:'Different work',Ціна:500,Кількість:1,Зарплата:250});
  before.employees[0].data.Історія['2026-10-01'][0].Записи.push(structuredClone(entry.Записи[1]));
  entry.Записи[0].Розраховано='20.10.2026';
  const updated=f.api.reconcilePayrollReportPayments(before,after,base);
  assert.equal(updated.total,101);assert.equal(updated.keys.length,2);assert.equal(updated.has_more,true);
  assert.equal(updated.salary,2020);assert.equal(updated.paidAmount,20);assert.equal(updated.due,2000);
  assert.equal(updated.employees[0].data.Історія['2026-10-01'][0].Записи[1].Розраховано,undefined);
  assert.equal(before.paidAmount,0);assert.equal(before.employees[0].data.Історія['2026-10-01'][0].Записи[0].Розраховано,undefined);
  const unpaid=f.api.reconcilePayrollReportPayments(before,after,{...base,payment:'unpaid'});
  assert.equal(unpaid.total,100);assert.equal(unpaid.keys.length,1);assert.equal(unpaid.salary,2000);
  assert.equal(unpaid.paidAmount,0);assert.equal(unpaid.due,2000);assert.equal(unpaid.has_more,true);
});

test('local reconciliation voids paid rows and handles paid-date membership without fetching',()=>{
  const f=fixture(),before=page(0,2,2);
  for(const entry of before.employees[0].data.Історія['2026-10-01'])entry.Записи[0].Розраховано='20.10.2026';
  before.paidAmount=40;before.paidInPeriod=40;before.due=0;
  const employees=structuredClone(before.employees);delete employees[0].data.Історія['2026-10-01'][0].Записи[0].Розраховано;
  for(const filters of [{...base,payment:'paid'},{...base,mode:'paid',from:'2026-10-19'}]) {
    const updated=f.api.reconcilePayrollReportPayments(before,employees,filters);
    assert.equal(updated.total,1);assert.equal(updated.keys.length,1);assert.equal(updated.paidAmount,20);assert.equal(updated.salary,20);
    assert.equal(updated.has_more,false);assert.equal(updated.due,0);
  }
});

test('receiver and parts payments reconcile only their own header',()=>{
  const f=fixture(),source=page(0,3,3);
  const entries=[{Акт:'1',СуммаРоботи:200,СуммаЗапчастин:0,ЗарплатаРоботи:20},
    {Акт:'2',СуммаЗапчастин:100,ЗарплатаЗапчастин:30},
    {Акт:'3',Записи:[{recordId:'mechanic',Робота:'Work',Ціна:200,Кількість:1,Зарплата:100}]}];
  source.employees[0].data.Історія['2026-10-01']=entries;source.keys=[[1,'2026-10-01','1',null],[1,'2026-10-01','2',null],[1,'2026-10-01','3',0]];
  source.salary=150;source.revenue=500;source.due=150;
  const employees=structuredClone(source.employees);employees[0].data.Історія['2026-10-01'][0].Розраховано='20.10.2026';
  const updated=f.api.reconcilePayrollReportPayments(source,employees,base);
  assert.equal(updated.paidAmount,20);assert.equal(updated.due,130);assert.equal(updated.salary,150);
  assert.equal(updated.employees[0].data.Історія['2026-10-01'][1].Розраховано,undefined);
  assert.equal(updated.employees[0].data.Історія['2026-10-01'][2].Записи[0].Розраховано,undefined);
});

test('paid-date void near an unfetched boundary preserves acknowledged row and pauses unsafe offset continuation',async()=>{
  const f=paymentUi(),helpers=fixture(),filters={...base,mode:'paid'};
  f.work.__payroll_payments.push({id:'latest',amount:15,date:'20.10.2026'});
  const source={employees:[{slyusar_id:1,data:structuredClone(f.ctx.slyusarsData[0])}],
    keys:[[1,'2026-10-01','1274',0]],statuses:[],total:2,revenue:100,salary:80,paidAmount:80,due:0,overpaid:0,paidInPeriod:80,has_more:true,acts:[],works:[]};
  Object.assign(f.ctx,{payrollReport:source,payrollReportFilterKey:JSON.stringify(filters),payrollReportOwner:'A',payrollReportScope:'A',
    payrollVisibleCount:1,allPodlegleData:[f.record],podlegleDateFilterMode:'paid',currentPayrollFilters:()=>filters,
    reconcilePayrollReportPayments:helpers.api.reconcilePayrollReportPayments,payrollRowKey:r=>JSON.stringify([r.employeeId,r.dateOpen,String(r.act),r.workIndex??null])});
  await f.ctx.togglepodleglePayment(0,'void');
  assert.equal(f.state.writes,1);assert.equal(f.ctx.podlegleData.length,1);assert.equal(f.ctx.payrollReport.total,2);
  assert.equal(f.ctx.payrollReport.paidAmount,65);assert.equal(f.ctx.payrollReport.due,15);
  assert.equal(f.ctx.payrollSearchFailed,true);assert.equal(f.ctx.payrollReport.has_more,true);
  assert.ok(f.state.notices.some(message=>/правильному порядку/.test(message)));
});

test('same filter with a new search generation invalidates an outstanding confirmation',async()=>{
  const f=paymentUi();let confirm;
  f.ctx.createPasswordConfirmationModal=()=>new Promise(resolve=>confirm=resolve);
  const saving=f.ctx.runMassPaymentCalculation();f.ctx.payrollReportGeneration++;confirm(true);await saving;
  assert.equal(f.state.writes,0);
});
