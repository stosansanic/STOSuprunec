const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(){
 const source=fs.readFileSync('src/ts/roboha/tablucya/tablucya.ts','utf8');
 const code=source.slice(source.indexOf('/** Local client/car receipts'),source.indexOf('export interface ActTableStatus'));
 const events={},changes=[],reads=[];const ctx={
  window:{addEventListener:(k,fn)=>events[k]=fn},localStorage:{getItem:()=> 'actor'},isUserAuthenticated:()=>true,
  normalizeRecordId:v=>v==null?null:Number(v),safeParseJSON:v=>v||{},clientsGlobal:[{client_id:1,data:{ПІБ:'Before',Телефон:'1'}}],
  parseSmartSearch:()=>[],loadActsTable:async()=>changes.push(['bounded search refresh']),
  carsGlobal:[{cars_id:2,data:{Авто:'Before car'}}],actsGlobal:[{act_id:10,client_id:1,cars_id:2}],modifiedActIdsGlobal:[],
  rowRefreshVersions:new Map(),rowRefreshSerial:0,statusPageOwner:'actor',statusPageGeneration:1,tableLoadGeneration:1,
  userAccessLevel:'Адміністратор',statusPageShowSuma:true,activeActPage:{input:{query:'',sort:'id',mode:'open'},page:{items:[],total:1,matched:1,has_more:false,next_offset:null}},
  stopActLazyLoading:()=>{},
  findActRowsInTable:(_,id)=>[{replaceWith:row=>changes.push(['replace',id,row])}],
  createActTableRow:act=>({id:act.act_id,classList:{remove:()=>{}}}),
  loadStatusRowLabels:async()=>{reads.push('missing labels only');return{clients:[],cars:[]};},mergeCarsIntoGlobal:()=>{},
  actMatchesPageRange:()=>true,filterActs:acts=>acts,compareActsInPage:(a,b)=>b.act_id-a.act_id,
  updateActSearchSummary:()=>{},renderActPageNavigation:()=>{},refreshActCounters:()=>{},rememberStatusRecord:()=>{},showAppMessage:()=>{},
 };
 const table={querySelectorAll:()=>[],querySelector:()=>({insertBefore:row=>changes.push(['insert',row.id])})};
 const container={dataset:{},querySelector:()=>table};ctx.document={querySelector:()=>table,getElementById:()=>container};
 vm.createContext(ctx);vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None}}).outputText,ctx);
 return{ctx,events,changes,reads,container};
}
test('confirmed client labels repaint affected existing rows without reading database',()=>{const f=fixture();
 f.events['sto:client-saved']({detail:{clientId:1,patch:{ПІБ:'Updated'}}});
 assert.equal(f.ctx.clientsGlobal[0].data.ПІБ,'Updated');assert.equal(f.ctx.clientsGlobal[0].data.Телефон,'1');
 assert.equal(f.changes.length,1);assert.equal(f.reads.length,0);
});
test('car ownership change updates display without rewriting historical act client',()=>{const f=fixture();
 f.events['sto:car-saved']({detail:{carId:2,clientId:99,patch:{Авто:'Updated car'},is_deleted:false}});
 assert.equal(f.ctx.actsGlobal[0].client_id,1);assert.equal(f.ctx.carsGlobal[0].data.Авто,'Updated car');assert.equal(f.reads.length,0);
});
test('new act receipt inserts one row and increments count once across duplicate notifications',async()=>{const f=fixture();
 const receipt={created:true,record:{act_id:11,client_id:1,cars_id:2,data:{},date_off:null}};
 await f.ctx.applyCreatedActReceipt(receipt);await f.ctx.applyCreatedActReceipt(receipt);
 assert.equal(f.ctx.actsGlobal.length,2);assert.equal(f.ctx.actsGlobal[0].act_id,11);assert.equal(f.ctx.activeActPage.page.matched,2);
 assert.equal(f.changes.filter(x=>x[0]==='insert').length,1);assert.equal(f.reads.length,1);
});
test('new act outside selected period leaves visible rows and counts unchanged',async()=>{const f=fixture();f.ctx.actMatchesPageRange=()=>false;
 await f.ctx.applyCreatedActReceipt({created:true,record:{act_id:11,client_id:1,cars_id:2,data:{}}});
 assert.equal(f.ctx.actsGlobal.length,1);assert.equal(f.ctx.activeActPage.page.matched,1);assert.equal(f.ctx.activeActPage.page.total,1);
});
test('initial page and global rows may share their array without duplicating a creation',async()=>{const f=fixture();
 f.ctx.activeActPage.page.items=f.ctx.actsGlobal;
 await f.ctx.applyCreatedActReceipt({created:true,record:{act_id:11,client_id:1,cars_id:2,data:{}}});
 assert.deepEqual(Array.from(f.ctx.actsGlobal,row=>row.act_id),[11,10]);
 assert.equal(f.ctx.activeActPage.page.items.filter(row=>row.act_id===11).length,1);
});
test('pending receipt cannot apply into a newly loaded table',async()=>{const f=fixture();let finish;
 f.ctx.loadStatusRowLabels=()=>new Promise(resolve=>finish=resolve);
 const pending=f.ctx.applyCreatedActReceipt({created:true,record:{act_id:11,client_id:1,cars_id:2,data:{}}});
 f.ctx.tableLoadGeneration++;finish({clients:[],cars:[]});await pending;
 assert.equal(f.ctx.actsGlobal.length,1);assert.equal(f.ctx.activeActPage.page.total,1);
});
test('client and car receipts coalesce one bounded reread only for label-dependent active search',async()=>{const f=fixture();
 f.ctx.activeActPage.input.query='Old';
 f.events['sto:client-saved']({detail:{clientId:1,patch:{ПІБ:'New'}}});
 f.events['sto:car-saved']({detail:{carId:2,patch:{Авто:'New'}}});
 await Promise.resolve();await Promise.resolve();assert.equal(f.changes.filter(x=>x[0]==='bounded search refresh').length,1);
});
test('concurrent older row read retains new confirmed labels while accepting fresh act fields',()=>{const f=fixture();
 f.events['sto:client-saved']({detail:{clientId:1,patch:{ПІБ:'New'}}});
 assert.equal(f.ctx.preserveNewerLabelWrite('client',{client_id:1,data:{ПІБ:'Old',Телефон:'2'}},0).data.ПІБ,'New');
 assert.equal(f.ctx.rowRefreshVersions.size,0);
});
