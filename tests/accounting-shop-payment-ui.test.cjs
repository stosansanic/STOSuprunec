const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function extract(path,names,ctx){const source=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile('ui.ts',source,99,true);const code=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:99,module:ts.ModuleKind.CommonJS}}).outputText,ctx);}
function details(count=3){const rows=Array.from({length:count},(_,i)=>({rowId:`1:d:1:${i+1}`,shopId:1,dateOpen:'d',act:'2',entryOrdinal:1,detailOrdinal:i+1,paymentFingerprint:'a'.repeat(64),isPaid:false,paymentDate:'',total:25}));
 const calls=[],notes=[],filter={from:'2026-10-01',to:'2026-10-21',dateMode:'open',payment:'all'};
 const c={exports:{},structuredClone,detailsData:rows,allDetailsData:rows,shopsData:[],hiddenDetails:new Map(),appliedReportScope:'owner',reportPage:{items:rows,totalCount:count,revision:'r1',totals:{sale:count*25},shops:[]},shopPaymentBusy:false,reportLoading:false,shopPaymentNeedsRefresh:false,reportGeneration:1,appliedReportFilter:filter,detailsVisibleCount:1,
  readShopReportPage:async()=>{throw Error('Unexpected page read');},mergeHistoryRows:rows=>rows,trackReportShops:rows=>rows,
  hasFullAccess:()=>true,accountingSearchScope:()=> 'owner',currentReportFilter:()=>filter,readAccountingPeriod:()=>filter,formatNumber:String,accountingToday:()=> '2026-10-21',
  showNotification:(...a)=>notes.push(a),updateReportPagination(){},updateDetailsTable(){},updateTotalSum(){},patchShopDetailPayments(){},announceAccountingChange(){},invalidateShopReport(){},detailsScroll:{pause(){}},
  withAccountingPaymentOperation:async fn=>fn(),confirmAccountingPayment:async(...a)=>{calls.push(['confirm',...a]);return true;},
  saveDetailPayments:async(targets,date)=>{calls.push(['write',targets,date]);return targets.map(row=>({rowId:row.rowId,paidAt:date,fingerprint:row.paymentFingerprint}));},
  loadDetailsPage:async(...a)=>calls.push(['read',...a])};
 extract('src/ts/roboha/bukhhalteriya/poAktam.ts',['mergeDetailsPages','detailsPaymentSnapshotCurrent','performDetailsPayment','toggleDetailsPaymentWithConfirmation','toggleDetailsPayment','runMassPaymentCalculationForDetails'],c);return {c,rows,calls,notes,filter};}
test('details mass settles a complete cached report including rows beyond viewport, no additional read',async()=>{const f=details(30);await f.c.runMassPaymentCalculationForDetails();const write=f.calls.find(c=>c[0]==='write');assert.equal(write[1].length,30);assert.equal(f.calls.filter(c=>c[0]==='read').length,0);assert.ok(f.rows.every(row=>row.isPaid));assert.equal(f.c.shopPaymentBusy,false);});
test('one detail payment never marks its sibling',async()=>{const f=details();await f.c.toggleDetailsPaymentWithConfirmation(1);assert.equal(f.rows[0].isPaid,false);assert.equal(f.rows[1].isPaid,true);assert.equal(f.rows[2].isPaid,false);assert.equal(f.calls.find(c=>c[0]==='write')[1].length,1);});
test('details cancel and already-paid mass have no write/read',async()=>{const f=details();f.c.confirmAccountingPayment=async()=>false;await f.c.toggleDetailsPaymentWithConfirmation(0);assert.deepEqual(f.calls,[]);f.rows.forEach(r=>r.isPaid=true);await f.c.runMassPaymentCalculationForDetails();assert.deepEqual(f.calls,[]);assert.equal(f.c.shopPaymentBusy,false);});
test('details changing row amount, filter, or actor during password aborts',async()=>{for(const change of [f=>f.rows[0].total=99,f=>f.c.currentReportFilter=()=>({...f.filter,from:'2026-10-20'}),f=>f.c.accountingSearchScope=()=> 'other']){const f=details();f.c.confirmAccountingPayment=async()=>{change(f);return true;};await f.c.toggleDetailsPaymentWithConfirmation(0);assert.equal(f.calls.length,0);assert.ok(f.notes.some(n=>n[1]==='error'));}});
test('membership-sensitive detail filter refreshes once after write only',async()=>{const f=details();f.filter.payment='unpaid';await f.c.toggleDetailsPaymentWithConfirmation(0);assert.deepEqual(f.calls.map(c=>c[0]),['confirm','write','read']);assert.equal(f.calls[2][5],true);});
test('unknown detail write acknowledgement blocks subsequent payment without auto-retry',async()=>{const f=details();f.c.saveDetailPayments=async()=>{throw Error('offline');};await f.c.toggleDetailsPaymentWithConfirmation(0);assert.equal(f.rows[0].isPaid,false);assert.equal(f.c.shopPaymentNeedsRefresh,true);assert.equal(f.c.shopPaymentBusy,false);const n=f.calls.length;await f.c.toggleDetailsPaymentWithConfirmation(0);assert.equal(f.calls.length,n);});
test('missing detail migration token refuses before password',async()=>{const f=details();delete f.rows[0].paymentFingerprint;await f.c.toggleDetailsPaymentWithConfirmation(0);assert.deepEqual(f.calls,[]);assert.match(f.notes[0][0],/SQL/);});
test('confirmed detail write under changed context is reported saved without patching the new view',async()=>{const f=details();const save=f.c.saveDetailPayments;f.c.saveDetailPayments=async(...args)=>{const receipts=await save(...args);f.c.accountingSearchScope=()=> 'other';return receipts;};await f.c.toggleDetailsPaymentWithConfirmation(0);assert.equal(f.rows[0].isPaid,false);assert.equal(f.c.shopPaymentNeedsRefresh,true);assert.ok(f.notes.some(n=>/Розрахунок збережено/.test(n[0])&&n[1]==='warning'));assert.ok(!f.notes.some(n=>n[1]==='error'));});
test('failed refresh after confirmed detail payment preserves rows and requires search before another payment',async()=>{const f=details();f.c.detailsScroll={pause(){},reset(){}};f.c.readShopReportPage=async()=>{throw Error('offline');};
 extract('src/ts/roboha/bukhhalteriya/poAktam.ts',['loadDetailsPage'],f.c);
 await f.c.loadDetailsPage(0,false,false,true,true);assert.equal(f.c.shopPaymentNeedsRefresh,true);assert.equal(f.c.reportSearchFailed,true);assert.equal(f.c.detailsData,f.rows);
 assert.ok(f.notes.some(n=>/Розрахунок збережено.*повторіть пошук/.test(n[0])&&n[1]==='warning'));
 await f.c.toggleDetailsPaymentWithConfirmation(0);assert.deepEqual(f.calls,[]);
});
function stock(count=3){const raw=Array.from({length:count},(_,i)=>({sclad_id:i+1,rosraxovano:null,povernennya:null,kilkist_on:1,price:25,paymentFingerprint:'b'.repeat(64)})),rows=raw.map(r=>({...r,isPaid:false,isReturned:false})),calls=[],notes=[],filter={from:'2026-10-01',to:'2026-10-21'};
 const c={exports:{},structuredClone,magazineData:rows,allMagazineData:rows,magazinePage:{items:raw,revision:'r1',summary:{payableCount:count,totalCount:count},has_more:false,next_cursor:null},magazineBusy:false,magazineLoading:false,magazineAppliedFilter:filter,magazineAppliedScope:'scope',magazineLoadGeneration:1,
  mapRowToMagazineRecord:r=>({...r,isPaid:!!r.rosraxovano,isReturned:!!r.povernennya}),readStockAccountingPage:async()=>{throw Error('Unexpected page read');},
  magazineFilterCurrent:()=>true,readAccountingPeriod:()=>filter,hasFullAccess:()=>true,updateMagazineScroll(){},canUserPayMagazine:async()=>{calls.push(['permission','pay']);return true;},canUserUnpayMagazine:async()=>{calls.push(['permission','unpay']);return true;},formatNumber:String,accountingToday:()=> '2026-10-21',
  confirmAccountingPayment:async(...a)=>{calls.push(['confirm',...a]);return true;},saveStockPayments:async(targets,date)=>{calls.push(['write',targets,date]);return targets.map(r=>({id:r.sclad_id,paidAt:date,fingerprint:r.paymentFingerprint}));},invalidateStockAccounting(){},announceAccountingChange(){},updateMagazineTable(){},showNotification:(...a)=>notes.push(a),magazineScroll:{pause(){}},refreshMagazinePaymentPage:async()=>calls.push(['read']),withAccountingPaymentOperation:async fn=>fn()};
 extract('src/ts/roboha/bukhhalteriya/shopsBuxha.ts',['magazinePaymentSnapshotCurrent','performMagazinePayment','toggleMagazinePayment','runMassPaymentCalculationForMagazine'],c);return {c,rows,raw,calls,notes};}
test('stock mass settles a complete cached report excluding paid and returned IDs',async()=>{const f=stock(30);f.raw[3].rosraxovano='2026-10-01';f.raw[4].povernennya='2026-10-01';await f.c.runMassPaymentCalculationForMagazine();const write=f.calls.find(c=>c[0]==='write');assert.equal(write[1].length,28);assert.ok(write[1].every(r=>![4,5].includes(r.sclad_id)));assert.equal(f.calls.filter(c=>c[0]==='read').length,1);});
test('stock single reads only the needed permission and changes one row',async()=>{const f=stock();await f.c.toggleMagazinePayment(1);assert.deepEqual(f.calls.filter(c=>c[0]==='permission'),[['permission','pay']]);assert.equal(f.calls.find(c=>c[0]==='write')[1][0].sclad_id,2);assert.equal(f.rows[0].isPaid,false);assert.equal(f.rows[1].isPaid,true);});
test('stock cancel/stale row/missing token never writes or reloads',async()=>{for(const mode of ['cancel','stale','missing']){const f=stock();if(mode==='missing')delete f.raw[0].paymentFingerprint;else f.c.confirmAccountingPayment=async()=>{if(mode==='stale')f.raw[0].price=99;return mode!=='cancel';};await f.c.toggleMagazinePayment(0);assert.equal(f.calls.filter(c=>['write','read'].includes(c[0])).length,0);assert.equal(f.c.magazineBusy,false);}});
test('confirmed stock write under changed context stays saved and does not refresh the new view',async()=>{const f=stock();const save=f.c.saveStockPayments;f.c.saveStockPayments=async(...args)=>{const receipts=await save(...args);f.c.magazineFilterCurrent=()=>false;return receipts;};await f.c.toggleMagazinePayment(0);assert.equal(f.rows[0].isPaid,false);assert.ok(f.notes.some(n=>/Розрахунок збережено/.test(n[0])&&n[1]==='warning'));assert.equal(f.calls.filter(c=>c[0]==='read').length,0);});

function pagedDetails(total=333) {
 const f=details(total),initial={...f.c.reportPage,items:f.rows.slice(0,100)};
 f.c.reportPage=initial;f.c.detailsData=initial.items;f.c.allDetailsData=initial.items;f.c.detailsVisibleCount=77;
 f.c.readShopReportPage=async(filter,offset,force,client,limit)=>{
  f.calls.push(['page',filter,offset,limit]);
  return {...initial,items:f.rows.slice(offset,offset+limit)};
 };
 return f;
}
function pagedStock(total=333) {
 const f=stock(total),initial={...f.c.magazinePage,items:f.raw.slice(0,100),has_more:true,next_cursor:{offset:100}};
 f.c.magazinePage=initial;f.c.magazineData=f.rows.slice(0,100);f.c.allMagazineData=f.c.magazineData;f.c.magazineVisibleCount=77;
 f.c.readStockAccountingPage=async(filter,cursor,revision,limit)=>{
  f.calls.push(['page',filter,cursor,revision,limit]);
  const end=Math.min(cursor.offset+limit,total);
  return {...initial,items:f.raw.slice(cursor.offset,end),has_more:end<total,next_cursor:end<total?{offset:end}:null};
 };
 return f;
}
test('details: 77 displayed, 100 cached, 333 filtered confirms and pays every unpaid row across pages',async()=>{
 const f=pagedDetails();f.rows[4].isPaid=true;f.rows[302].isPaid=true;
 await f.c.runMassPaymentCalculationForDetails();
 assert.deepEqual(f.calls.filter(c=>c[0]==='page').map(c=>[c[2],c[3]]),[[100,200],[300,200]]);
 const write=f.calls.find(c=>c[0]==='write')[1];assert.equal(write.length,331);
 assert.equal(write.at(-1).rowId,f.rows.at(-1).rowId);assert.equal(new Set(write.map(r=>r.rowId)).size,331);
 assert.match(f.calls.find(c=>c[0]==='confirm')[2],/331; сума: 8275/);
 assert.equal(f.c.detailsVisibleCount,77);assert.equal(f.c.shopPaymentBusy,false);
});
test('stock: 77 displayed, 100 cached, 333 filtered confirms and pays all eligible rows across pages',async()=>{
 const f=pagedStock();f.raw[4].rosraxovano='2026-10-01';f.raw[302].povernennya='2026-10-01';
 await f.c.runMassPaymentCalculationForMagazine();
 assert.deepEqual(f.calls.filter(c=>c[0]==='page').map(c=>[c[2].offset,c[3],c[4]]),[[100,'r1',200],[300,'r1',200]]);
 const write=f.calls.find(c=>c[0]==='write')[1];assert.equal(write.length,331);
 assert.equal(write.at(-1).sclad_id,333);assert.ok(write.every(r=>![5,303].includes(r.sclad_id)));
 assert.match(f.calls.find(c=>c[0]==='confirm')[2],/331; сума: 8275/);
 assert.equal(f.c.magazineVisibleCount,77);assert.equal(f.c.magazineBusy,false);
});
test('details: locally hidden rows still belong to all-filtered payment',async()=>{
 const f=details();f.c.hiddenDetails.set(f.rows[0].rowId,f.rows[0]);f.c.detailsData=f.rows.slice(1);
 await f.c.runMassPaymentCalculationForDetails();assert.equal(f.calls.find(c=>c[0]==='write')[1].length,3);
});
test('details: failed, incomplete, duplicate, changed revision/filter/actor pages never pay a partial result',async()=>{
 for(const mode of ['offline','empty','duplicate','revision','filter','actor']){
  const f=pagedDetails(),initial=f.c.reportPage,read=f.c.readShopReportPage;
  f.c.readShopReportPage=async(...args)=>{
   if(mode==='offline')throw Error('offline');const page=await read(...args);
   if(mode==='empty')page.items=[];
   if(mode==='duplicate')page.items[0]=f.rows[0];
   if(mode==='revision')page.revision='r2';
   if(mode==='filter')f.c.currentReportFilter=()=>({...f.filter,item:'other'});
   if(mode==='actor')f.c.accountingSearchScope=()=> 'other';
   return page;
  };
  await f.c.runMassPaymentCalculationForDetails();
  assert.ok(!f.calls.some(c=>['confirm','write'].includes(c[0])),mode);
  assert.equal(f.c.reportPage,initial,mode);assert.equal(f.c.shopPaymentBusy,false,mode);
  assert.ok(f.notes.some(n=>n[1]==='error'),mode);
 }
});
test('stock: failed, incomplete, duplicate, changed revision/scope pages never pay a partial result',async()=>{
 for(const mode of ['offline','empty','incomplete','duplicate','revision','scope']){
  const f=pagedStock(),initial=f.c.magazinePage,read=f.c.readStockAccountingPage;
  f.c.readStockAccountingPage=async(...args)=>{
   if(mode==='offline')throw Error('offline');const page=await read(...args);
   if(mode==='empty')page.items=[];
   if(mode==='incomplete')page.has_more=false;
   if(mode==='duplicate')page.items[0]=f.raw[0];
   if(mode==='revision')page.revision='r2';
   if(mode==='scope')f.c.magazineFilterCurrent=()=>false;
   return page;
  };
  await f.c.runMassPaymentCalculationForMagazine();
  assert.ok(!f.calls.some(c=>['confirm','write'].includes(c[0])),mode);
  assert.equal(f.c.magazinePage,initial,mode);assert.equal(f.c.magazineBusy,false,mode);
  assert.ok(f.notes.some(n=>n[1]==='error'),mode);
 }
});
test('all-filtered cancel and transaction limits never silently pay a subset',async()=>{
 for(const kind of ['details','stock'])for(const mode of ['cancel','limit']){
  const f=kind==='details'?pagedDetails(mode==='limit'?2001:333):pagedStock(mode==='limit'?2001:333);
  if(mode==='cancel')f.c.confirmAccountingPayment=async()=>false;
  await (kind==='details'?f.c.runMassPaymentCalculationForDetails():f.c.runMassPaymentCalculationForMagazine());
  assert.ok(!f.calls.some(c=>c[0]==='write'),`${kind}: ${mode}`);
  if(mode==='limit')assert.ok(f.notes.some(n=>/2000/.test(n[0])),kind);
 }
});
