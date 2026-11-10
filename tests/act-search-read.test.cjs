const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function load(rpc,parse=()=>[],storage={getItem:()=>'one'}){
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/tablucya/actSearchRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
 {exports,Intl,structuredClone,localStorage:storage,require:name=>name.includes('smartSearch')?{parseSmartSearch:parse}:{supabase:{rpc}}});return exports;
}
const input={from:null,to:null,mode:'open',query:'x',offset:0,sort:'id'};
const page={items:Array.from({length:50},(_,i)=>({act_id:1005-i})),clients:[],cars:[],total:1005,matched:1005,has_more:true,next_offset:50};
test('act search serializes parser filters and exact legacy tokens',()=>{
 const smart=load(null,()=>[{type:'date',dateFrom:new Date('2026-01-01Z')}]);
 assert.equal(smart.serializeActSearch('today')[0].dateFrom,'2026-01-01T00:00:00.000Z');
 const fallback=load(null);assert.equal(fallback.serializeActSearch('акт:12 rest:a:b')[1].value,'a');assert.equal(fallback.serializeActSearch('').length,0);
});
test('act search reads a single page, coalesces requests and keeps cursor/scope/cache separate',async()=>{
 let calls=0,done,actor='one';const api=load(()=>{calls++;return new Promise(r=>done=r)},()=>[],{getItem:()=>actor});
 const a=api.readActSearchPage(input),b=api.readActSearchPage(input);assert.equal(calls,1);
 done({data:page});const first=await a;await b;first.items.length=0;assert.equal((await api.readActSearchPage(input)).items.length,50);
 const c=api.readActSearchPage({...input,offset:50});assert.equal(calls,2);done({data:{...page,next_offset:100}});await c;
 const stale=api.readActSearchPage({...input,query:'changed'});actor='two';done({data:page});await assert.rejects(stale,/змінився/);
});
test('missing search RPC and access errors never trigger broad table fallback',async()=>{
 await assert.rejects(load(async()=>({error:{code:'PGRST202'}})).readActSearchPage(input),/SQL/);
 await assert.rejects(load(async()=>({error:{code:'42501'}})).readActSearchPage(input),e=>e.code==='42501');
 await assert.rejects(load(async()=>({data:{...page,next_offset:0}})).readActSearchPage(input),/Некоректна/);
});

test('lazy requests send a five-row limit and validate their next offset',async()=>{
 let request;
 const five={...page,items:page.items.slice(0,5),next_offset:55};
 const api=load(async(name,args)=>{request={name,args};return {data:five}});
 assert.equal((await api.readActSearchPage({...input,offset:50,limit:5})).items.length,5);
 assert.equal(request.name,'traffic_act_search_page_v2');assert.equal(request.args.p_limit,5);
 await assert.rejects(load(async()=>({data:page})).readActSearchPage({...input,offset:50,limit:5}),/Некоректна/);
});
