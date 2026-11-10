const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
function load(rpc, localStorage){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/service_book/serviceHistory.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,{exports,structuredClone,localStorage,require:()=>({supabase:{rpc}})});return exports;}
test('chart history includes every page while details are fetched separately',async()=>{
  const calls=[];const api=load(async(_name,args)=>{calls.push(args);return {data:{items:[{act_id:args.p_before?1:2}],
    has_more:!args.p_before,next_cursor:{act_id:2,date_on:null}}};});
  const rows=await api.readServiceHistorySummary(7,()=>true);
  assert.equal(rows.length,2);assert.ok(calls.every(x=>x.p_summary&&x.p_car===7));
});
test('changing cars stops summary paging and prevents partial publication',async()=>{
  let current=true,count=0;const api=load(async()=>{count++;current=false;return {data:{items:[{act_id:2}],has_more:true,next_cursor:{act_id:2,date_on:null}}};});
  assert.equal((await api.readServiceHistorySummary(7,()=>current)).length,0);assert.equal(count,1);
});
test('invalid cursor and access errors do not become an empty history',async()=>{
  const cursor={act_id:2,date_on:null};const bad=load(async()=>({data:{items:[{}],has_more:true,next_cursor:cursor}}));
  await assert.rejects(bad.readServiceHistoryPage(1,cursor),/сторінка/);
  const denied=load(async()=>({error:{code:'42501'}}));await assert.rejects(denied.readServiceHistoryPage(1,null),e=>e.code==='42501');
});

test('history cache shares pages and invalidates after save or actor change',async()=>{
  let actor='one',calls=0,finish;
  const api=load(()=>{calls++;return new Promise(resolve=>finish=resolve)},{getItem:()=>actor});
  const a=api.readServiceHistoryPage(7,null),b=api.readServiceHistoryPage(7,null);
  assert.equal(calls,1);finish({data:{items:[{act_id:2}],has_more:false,next_cursor:null}});
  const row=await a;await b;row.items.length=0;
  assert.equal((await api.readServiceHistoryPage(7,null)).items.length,1);
  api.clearServiceHistoryCache();const stale=api.readServiceHistoryPage(7,null);
  api.clearServiceHistoryCache();finish({data:{items:[],has_more:false,next_cursor:null}});await assert.rejects(stale);
  const changed=api.readServiceHistoryPage(7,null);actor='two';finish({data:{items:[],has_more:false,next_cursor:null}});await assert.rejects(changed);
  const fresh=api.readServiceHistoryPage(7,null);assert.equal(calls,4);finish({data:{items:[],has_more:false,next_cursor:null}});await fresh;
});

test('targeted history invalidation preserves other cars and rejects affected in-flight pages',async()=>{
 let calls=0,finish;const api=load(async(_name,args)=>{calls++;if(args.p_car===9)return new Promise(r=>finish=r);return {data:{items:[],has_more:false,next_cursor:null}}},{getItem:()=>'one'});
 await api.readServiceHistoryPage(7,null);await api.readServiceHistoryPage(8,null);
 const pending=api.readServiceHistoryPage(9,null);api.invalidateServiceHistoryCars([7,9]);
 finish({data:{items:[],has_more:false,next_cursor:null}});await assert.rejects(pending,/змінилася/);
 await api.readServiceHistoryPage(8,null);assert.equal(calls,3);
 await api.readServiceHistoryPage(7,null);assert.equal(calls,4);
});
