const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const ts=require('typescript');
function load(rpc,storage,clock={now:()=>Date.now()}) {
 const exports={},events={};let auth;
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/service_book/serviceSearch.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
 exports,structuredClone,Date:clock,localStorage:storage,window:{addEventListener:(name,fn)=>events[name]=fn},
 require:()=>({supabase:{rpc,auth:{onAuthStateChange:fn=>auth=fn}}})});
 return {...exports,events,auth:()=>auth()};
}
const page=(id=1)=>({data:{items:[{car:{cars_id:id},client:{client_id:2}}],has_more:false,next_cursor:id}});
test('service search shares pending pages, clones cached data and separates cursors',async()=>{
 let calls=0,resolve;const api=load(()=>{calls++;return new Promise(r=>resolve=r)},{getItem:()=>'one'});
 const a=api.readServiceSearchPage(' VIN '),b=api.readServiceSearchPage('VIN');assert.equal(calls,1);
 resolve(page());const first=await a;await b;first.items[0].car.cars_id=9;
 assert.equal((await api.readServiceSearchPage('VIN')).items[0].car.cars_id,1);
 const c=api.readServiceSearchPage('VIN',1);assert.equal(calls,2);resolve(page(2));await c;
});
test('service search expires, bounds pages and invalidates across identity and writes',async()=>{
 let calls=0,actor='one',now=0;const api=load(async()=>{calls++;return page()},{getItem:()=>actor},{now:()=>now});
 await api.readServiceSearchPage('x');await api.readServiceSearchPage('x');assert.equal(calls,1);
 now=15001;await api.readServiceSearchPage('x');assert.equal(calls,2);
 for(const event of ['sto:car-saved','sto:client-saved','online','focus']) {
 api.events[event]();await api.readServiceSearchPage('x');}
 api.auth();await api.readServiceSearchPage('x');actor='two';await api.readServiceSearchPage('x');assert.equal(calls,8);
 for(let i=0;i<21;i++)await api.readServiceSearchPage('q'+i);
 const before=calls;await api.readServiceSearchPage('x');assert.equal(calls,before+1);
});
test('service search rejects late, invalid and failed data without broad reads',async()=>{
 let resolve;const api=load(()=>new Promise(r=>resolve=r),{getItem:()=>'one'});
 const pending=api.readServiceSearchPage('x');api.clearServiceSearchCache();resolve(page());await assert.rejects(pending,/змінилися/);
 const denied=load(async()=>({error:{code:'42501'}}));await assert.rejects(denied.readServiceSearchPage('x'),e=>e.code==='42501');
 const missing=load(async()=>({error:{code:'PGRST202'}}));await assert.rejects(missing.readServiceSearchPage('x'),/SQL/);
 const bad=load(async()=>({data:{items:[],has_more:true,next_cursor:1}}));await assert.rejects(bad.readServiceSearchPage('x'),/Некоректна/);
 const empty=await denied.readServiceSearchPage('   ');assert.equal(empty.items.length,0);
});
