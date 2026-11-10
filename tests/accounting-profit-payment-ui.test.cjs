const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(count=3){
 const source=fs.readFileSync('src/ts/roboha/bukhhalteriya/prubutok.ts','utf8'),ast=ts.createSourceFile('profit.ts',source,99,true);
 const names=['runMassPaymentCalculationForvutratu','settleProfitRows','toggleActPayment'];
 const code=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
 const rows=Array.from({length:count},(_,i)=>({id:-i-1,paymentBaseline:'a'.repeat(32),rosraxovanoDate:null,xto_rozraxuvav:null,isPaid:false,category:'💰 Прибуток',fullAmount:100,discountAmount:0,amount:10}));
 const filter={from:'2026-10-01',to:'2026-10-21'},calls=[],notes=[],confirm=[];
 const ctx={exports:{},profitReadNeedsRefresh:false,profitMutationBusy:false,profitExportPending:false,profitBusy:false,profitSnapshot:{filter,rows,revision:'revision-1',more:false,summary:{count,eligibleCount:count,eligibleAmount:count*100}},profitScope:'scope',profitLoadGeneration:1,
 filteredvutratuData:rows,profitShown:1,profitCurrentKey:()=>JSON.stringify(['scope',filter]),getCurrentUserName:()=>'Admin',formatNumber:String,
 updatevutratuTable(){},showNotification:(...args)=>notes.push(args),withAccountingPaymentOperation:async fn=>fn(),
 confirmAccountingPayment:async(...args)=>{confirm.push(args);return true;},getCurrentUkrainianTime:()=>'2026-10-21T12:00:00',
 missingAccountingRpc:(_,e)=>e,announceAccountingChange(){},profitReader:{clear(){}},reportProfitError:e=>notes.push([e.message,'error']),
 applyProfitSnapshot:next=>{ctx.profitSnapshot=next;ctx.filteredvutratuData=next.rows;},
 loadvutratuFromDatabase:async(...args)=>calls.push(['read',...args]),supabase:{rpc:async(name,args)=>{calls.push([name,args]);return {data:{updated_count:args.p_rows.length,rows:args.p_rows.map(r=>({id:r.id,paid_at:args.p_paid_at,actor:'Admin'}))}}}}};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:99,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
 return {ctx,calls,notes,confirm,rows};
}
test('mass settlement loads every filtered page and confirms the same unpaid rows it writes',async()=>{
 const f=fixture(153),all=f.rows;f.ctx.profitShown=77;all[1].isPaid=true;all[140].isPaid=true;
 f.ctx.filteredvutratuData=all.slice(0,100);f.ctx.profitSnapshot.rows=f.ctx.filteredvutratuData;f.ctx.profitSnapshot.more=true;
 const filter=f.ctx.profitSnapshot.filter,initial=f.ctx.profitSnapshot;
 f.ctx.profitReader.read=async(received,scope,more,current)=>{
  assert.equal(received,filter);assert.equal(scope,'scope');assert.equal(more,true);assert.equal(current(),true);
  f.calls.push(['page']);const count=f.calls.filter(c=>c[0]==='page').length===1?130:153;
  return {...initial,rows:all.slice(0,count),more:count<153};
 };
 await f.ctx.runMassPaymentCalculationForvutratu();
 assert.deepEqual(f.calls.map(c=>c[0]),['page','page','traffic_profit_payment_rows','read']);
 const selected=f.calls[2][1].p_rows;assert.equal(selected.length,151);assert.ok(selected.some(row=>row.id===-153));assert.ok(selected.every(row=>![-2,-141].includes(row.id)));
 assert.match(f.confirm[0][1],/151 неоплачених записів за поточним фільтром/);assert.match(f.confirm[0][1],/15100 грн/);
 assert.equal(f.ctx.profitShown,77);assert.equal(f.ctx.profitBusy,false);assert.equal(f.ctx.profitMutationBusy,false);assert.ok(all.every(row=>row.isPaid));
});
test('all cached rows are paid even if only one row is displayed',async()=>{const f=fixture(100);f.rows[1].isPaid=true;
 await f.ctx.runMassPaymentCalculationForvutratu();assert.equal(f.calls[0][1].p_rows.length,99);assert.match(f.confirm[0][1],/9900 грн/);
 const count=f.calls.length;await f.ctx.runMassPaymentCalculationForvutratu();assert.equal(f.calls.length,count);
});
test('failure while fetching remaining pages never pays a partial result',async()=>{const f=fixture();f.ctx.profitSnapshot.more=true;
 f.ctx.profitReader.read=async()=>{throw new Error('Network');};await f.ctx.runMassPaymentCalculationForvutratu();
 assert.equal(f.confirm.length,0);assert.deepEqual(f.calls,[]);assert.equal(f.ctx.profitBusy,false);assert.match(f.notes[0][0],/Network/);
});
test('filter or actor changes during full-result loading abort before confirmation',async()=>{
 for(const change of [ctx=>ctx.profitCurrentKey=()=> 'changed',ctx=>ctx.getCurrentUserName=()=> 'Other']) {
  const f=fixture();f.ctx.profitSnapshot.more=true;f.ctx.profitReader.read=async()=>{change(f.ctx);return {...f.ctx.profitSnapshot,more:false};};
  await f.ctx.runMassPaymentCalculationForvutratu();assert.equal(f.confirm.length,0);assert.deepEqual(f.calls,[]);assert.equal(f.ctx.profitBusy,false);
 }
});
test('changed report revision or incomplete result cannot be paid',async()=>{
 for(const result of [{revision:'revision-2'},{rows:[]}]) {const f=fixture();f.ctx.profitSnapshot.more=true;
  f.ctx.profitReader.read=async()=>({...f.ctx.profitSnapshot,more:false,...result});await f.ctx.runMassPaymentCalculationForvutratu();
  assert.equal(f.confirm.length,0);assert.deepEqual(f.calls,[]);assert.match(f.notes[0][0],/ACCOUNTING_REPORT_STALE/);
 }
});
test('more than 1000 unpaid filtered rows refuses the entire settlement',async()=>{const f=fixture(1001);
 await f.ctx.runMassPaymentCalculationForvutratu();assert.equal(f.confirm.length,0);assert.deepEqual(f.calls,[]);assert.match(f.notes[0][0],/до 1000 неоплачених/);assert.ok(f.rows.every(row=>!row.isPaid));
});
test('cancel performs no write and no reread',async()=>{const f=fixture();f.ctx.confirmAccountingPayment=async()=>false;await f.ctx.toggleActPayment(1);assert.deepEqual(f.calls,[]);assert.equal(f.ctx.profitMutationBusy,false);});
test('changed date/filter during confirmation is not paid',async()=>{const f=fixture();f.ctx.confirmAccountingPayment=async()=>{f.ctx.profitCurrentKey=()=> 'changed';return true;};await f.ctx.toggleActPayment(1);assert.deepEqual(f.calls,[]);assert.match(f.notes[0][0],/Звіт змінився/);});
test('single act identity is captured and sends only its compact baseline',async()=>{const f=fixture();await f.ctx.toggleActPayment(1);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1].p_rows.map(r=>r.id))),[-2]);assert.equal(f.calls[0][1].p_rows[0].fullAmount,undefined);});
test('actor changed during confirmation aborts',async()=>{const f=fixture();f.ctx.confirmAccountingPayment=async()=>{f.ctx.getCurrentUserName=()=> 'Other';return true;};await f.ctx.toggleActPayment(0);assert.deepEqual(f.calls,[]);});
test('missing SQL baseline refuses before password or writes',async()=>{const f=fixture();delete f.rows[0].paymentBaseline;await f.ctx.toggleActPayment(0);assert.equal(f.confirm.length,0);assert.deepEqual(f.calls,[]);assert.match(f.notes[0][0],/Оновіть SQL/);});
test('uncertain write refreshes once without automatic retry and clears busy',async()=>{const f=fixture();f.ctx.supabase.rpc=async()=>{f.calls.push(['write']);return {error:new Error('Network')}};await f.ctx.toggleActPayment(0);assert.deepEqual(f.calls.map(c=>c[0]),['write','read']);assert.equal(f.ctx.profitMutationBusy,false);});
test('already paid rows are excluded from mass pay and no-op has no network activity',async()=>{const f=fixture();f.rows.forEach(r=>r.isPaid=true);await f.ctx.runMassPaymentCalculationForvutratu();assert.deepEqual(f.calls,[]);assert.equal(f.confirm.length,0);});
test('duplicate/missing receipt cannot be reported as success',async()=>{const f=fixture();f.ctx.supabase.rpc=async()=>({data:{updated_count:3,rows:[{id:-1,paid_at:'now'},{id:-1,paid_at:'now'},{id:-3,paid_at:'now'}]}});await f.ctx.runMassPaymentCalculationForvutratu();assert.ok(f.notes.some(n=>n[1]==='error'));assert.equal(f.calls.length,1);});
test('failed acknowledgement refresh blocks another payment until a new search',async()=>{const f=fixture();f.ctx.profitReadNeedsRefresh=true;await f.ctx.toggleActPayment(0);assert.deepEqual(f.calls,[]);assert.equal(f.confirm.length,0);assert.match(f.notes[0][0],/Пошук/);});
test('legacy empty actor stays exact while empty unpaid timestamp normalizes to null',async()=>{const f=fixture();f.rows[0].xto_rozraxuvav='';f.rows[0].rosraxovanoDate='';await f.ctx.toggleActPayment(0);assert.equal(f.calls[0][1].p_rows[0].expected_actor,'');assert.equal(f.calls[0][1].p_rows[0].expected_paid,null);});
