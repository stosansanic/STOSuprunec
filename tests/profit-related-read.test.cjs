const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/profitRelatedRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('profit related rows are unique and batched, preserving string JSON',async()=>{
 const calls=[];const client={from(table){assert.equal(table,'clients');return {select(fields){assert.equal(fields,'client_id,data');return {in:async(key,ids)=>{calls.push(ids);return {data:ids.map(id=>({client_id:id,data:'{"ПІБ":"Клієнт"}'}))}}}}}}};
 const result=await api.readProfitRelated('clients',[...Array.from({length:205},(_,i)=>i+1),1,1,null,0,-1],client);
 assert.equal(calls.length,2);assert.equal(calls[0].length,200);assert.equal(result.size,205);
 assert.equal(result.get(1),'{"ПІБ":"Клієнт"}');
});
test('profit related empty IDs do not query and failed later batch does not return partial result',async()=>{
 assert.equal((await api.readProfitRelated('cars',[],{from(){throw Error('unexpected')}})).size,0);
 let calls=0;
 await assert.rejects(api.readProfitRelated('cars',Array.from({length:201},(_,i)=>i+1),{from(){return {select(){return {in:async()=>++calls===1?{data:[{cars_id:1,data:{}}]}:{error:{code:'42501'}}}}}}}),e=>e.code==='42501');
});
test('profit related rows are fresh on each report load',async()=>{
 let calls=0;const client={from(){return {select(){return {in:async()=>({data:[{cars_id:1,data:{Авто:String(++calls)}}]})}}}}};
 assert.equal((await api.readProfitRelated('cars',[1],client)).get(1).Авто,'1');
 assert.equal((await api.readProfitRelated('cars',[1],client)).get(1).Авто,'2');
});
