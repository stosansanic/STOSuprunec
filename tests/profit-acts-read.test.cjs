const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/profitActsRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('profit reads all compact pages with unchanged date boundaries',async()=>{
 const calls=[];
 const rows=await api.readProfitActs('paid','2025-01-01','2026-10-02',{rpc:async(name,args)=>{
  calls.push(args);return {data:{items:Array.from({length:args.p_offset===0?200:5},(_,i)=>({act_id:args.p_offset+i})),has_more:args.p_offset===0}};
 }});
 assert.equal(rows.length,205);assert.equal(calls.length,2);assert.equal(calls[1].p_offset,200);
 assert.equal(calls[0].p_mode,'paid');assert.equal(calls[0].p_to,'2026-10-02');
});
test('profit failures never return partial data or fall back after first page',async()=>{
 await assert.rejects(api.readProfitActs('open','','',{rpc:async()=>({error:{code:'42501'}})}),e=>e.code==='42501');
 await assert.rejects(api.readProfitActs('open','','',{rpc:async(n,a)=>a.p_offset?{error:{code:'PGRST202'}}:{data:{items:Array(200).fill({}),has_more:true}}}),e=>e.code==='PGRST202');
 await assert.rejects(api.readProfitActs('open','','',{rpc:async()=>({data:{items:[],has_more:true}})}));
});
test('profit legacy fallback paginates rather than silently hitting API row limit',async()=>{
 const ranges=[],filters=[];const query={select(){return this},gte(k,v){filters.push([k,v]);return this},lte(){return this},order(){return this},range(a,b){ranges.push([a,b]);return Promise.resolve({data:Array(a===0?200:1).fill({})})}};
 const rows=await api.readProfitActs('close','2025-01-01','',{rpc:async()=>({error:{code:'PGRST202'}}),from:()=>query});
 assert.equal(rows.length,201);assert.deepEqual(ranges,[[0,199],[200,399]]);assert.equal(filters[0][0],'date_off');
});
