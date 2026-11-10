const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const exported={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/ai/dashboardRead.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,{exports:exported,require:()=>({supabase:{}})});
test('dashboard shares concurrent day/scope and never reuses another role',async()=>{
 const resolvers=[],calls=[];const read=exported.createDashboardReader({rpc:(_name,args)=>{calls.push(args);return new Promise(resolve=>resolvers.push(resolve))}});
 const a=read('a','b','one'),b=read('a','b','one'),c=read('a','b','two');assert.equal(calls.length,2);
 resolvers[0]({data:{items:[{act_id:1}],has_more:false}});resolvers[1]({data:{items:[],has_more:false}});
 assert.equal(await a,await b);assert.equal((await c).length,0);
 const fresh=read('a','b','one');assert.equal(calls.length,3);resolvers[2]({data:{items:[],has_more:false}});await fresh;
});
test('dashboard reads every page and only absent initial RPC may use compatibility path',async()=>{
 const calls=[];const read=exported.createDashboardReader({rpc:async(_name,p)=>{calls.push(p.p_before);return {data:{items:[{act_id:p.p_before?1:101}],has_more:!p.p_before,next_cursor:101}}}});
 assert.equal((await read('a','b','s')).length,2);assert.deepEqual(calls,[null,101]);
 const missing=exported.createDashboardReader({rpc:async()=>({error:{code:'PGRST202'}})});assert.equal(await missing('a','b','s'),undefined);
 const denied=exported.createDashboardReader({rpc:async()=>({error:{code:'42501'}})});await assert.rejects(denied('a','b','s'),e=>e.code==='42501');
});
test('compact dashboard keeps existing zero-quantity, profit and day rules without extra client reads',async()=>{
 const source=fs.readFileSync('src/ts/roboha/ai/aiChat.ts','utf8');const start=source.indexOf('async function loadDailyStats('),end=source.indexOf('// ПАРСИНГ ДАНИХ КЛІЄНТА',start);
 const row={act_id:1,date_on:'2026-10-01T01:00:00Z',date_off:'2026-10-02T12:00:00Z',client_id:1,cars_id:1,
   __client_data:{ПІБ:'Тест'},__car_data:{Авто:'Авто'},data:{Роботи:[{Ціна:'10.5',Кількість:0}],Деталі:[{Ціна:2,Кількість:3}], 'Прибуток за роботу':-2,'Прибуток за деталі':1}};
 const state={exports:{},Date,localStorage:{getItem:()=>null},toLocalISODate:d=>d.toISOString().slice(0,10),fmtDate:x=>x,
   readDashboardRows:async()=>[row,{...row,act_id:2,date_on:'2026-10-02T10:00:00Z',date_off:null}],
   supabase:{from:()=>{throw Error('unexpected broad client read')}}};
 vm.runInNewContext(ts.transpileModule('export '+source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,state);
 const stats=await state.exports.loadDailyStats(new Date('2026-10-02T12:00:00Z'));
 assert.equal(stats.closedCount,1);assert.equal(stats.openCount,1);assert.equal(stats.totalSum,16.5);assert.equal(stats.profitTotal,-1);
 assert.equal(stats.closedActs[0].client,'Тест');assert.equal(stats.closedActs[0].car,'Авто');assert.equal(stats.openedTodayOpen,1);
 row.data={__dashboard_totals:{works:10.5,details:6,worksCount:1},'Прибуток за роботу':-2,'Прибуток за деталі':1};
 const compactStats=await state.exports.loadDailyStats(new Date('2026-10-02T12:00:00Z'));
 assert.equal(JSON.stringify(compactStats),JSON.stringify(stats));

});

test('dashboard invalidation starts a fresh request while old request is pending',async()=>{
 const resolvers=[];const read=exported.createDashboardReader({rpc:()=>new Promise(resolve=>resolvers.push(resolve))});
 const old=read('a','b','s');read.invalidate();const fresh=read('a','b','s');assert.equal(resolvers.length,2);
 resolvers[0]({data:{items:[],has_more:false}});resolvers[1]({data:{items:[{act_id:1}],has_more:false}});
 assert.equal((await old).length,0);assert.equal((await fresh).length,1);
});

test('empty dashboard stays empty and same-day opened/closed act contributes once',async()=>{
 const source=fs.readFileSync('src/ts/roboha/ai/aiChat.ts','utf8');
 const start=source.indexOf('async function loadDailyStats('),end=source.indexOf('// ПАРСИНГ ДАНИХ КЛІЄНТА',start);
 let rows=[]; let calls=0;
 const state={exports:{},Date,localStorage:{getItem:()=>null},toLocalISODate:d=>d.toISOString().slice(0,10),fmtDate:x=>x,
  readDashboardRows:async()=>{calls++;return rows},supabase:{from:()=>{throw Error('unexpected fallback')}}};
 vm.runInNewContext(ts.transpileModule('export '+source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,state);
 const date=new Date('2026-10-02T12:00:00Z');
 const empty=await state.exports.loadDailyStats(date);
 assert.equal(calls,1);assert.equal(empty.closedCount,0);assert.equal(empty.totalSum,0);
 rows=[{act_id:1,date_on:'2026-10-02T08:00:00Z',date_off:'2026-10-02T11:00:00Z',__client_data:{},__car_data:{},data:{__dashboard_totals:{works:10,details:5,worksCount:1}}}];
 const stats=await state.exports.loadDailyStats(date);
 assert.equal(stats.closedCount,1);assert.equal(stats.openedTodayClosed,1);assert.equal(stats.totalSum,15);
 assert.equal(stats.closedActs.length,1);assert.equal(calls,2);
});
