const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const api={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/bukhhalteriya/shopReportRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({supabase:{}})});
test('shop report follows all pages using stable shop ID',async()=>{
 const calls=[];const rows=await api.readShopReport({rpc:async(n,args)=>{calls.push(args.p_after);return {data:args.p_after===null?{items:Array.from({length:200},(_,i)=>({shop_id:i+1})),has_more:true,next_cursor:200}:{items:[{shop_id:201}],has_more:false}}}});
 assert.equal(rows.length,201);assert.deepEqual(calls,[null,200]);
});
test('shop report rejects stalled cursor and errors after a partial page',async()=>{
 await assert.rejects(api.readShopReport({rpc:async()=>({data:{items:[],has_more:true,next_cursor:0}})}));
 await assert.rejects(api.readShopReport({rpc:async()=>({error:{code:'42501'}})}),e=>e.code==='42501');
 await assert.rejects(api.readShopReport({rpc:async(n,a)=>a.p_after===null?{data:{items:Array(200).fill({}),has_more:true,next_cursor:200}}:{error:{code:'PGRST202'}}}),e=>e.code==='PGRST202');
});
