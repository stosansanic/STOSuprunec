const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(){const api={};let invalidations=0;vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/referenceWrite.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api,require:()=>({supabase:{},invalidateStockReads:()=>invalidations++})});return {api,count:()=>invalidations};}
test('reference writer returns IDs directly and never falls back to client inserts',async()=>{
 const {api,count}=load();const items=[{key:'a',kind:'details',name:' Part '}];let calls=0;
 const client={rpc:async(name,args)=>{calls++;assert.equal(name,'stock_resolve_references');return {data:[{key:'a',kind:'details',name:'Part',id:9,canonical:'PART',status:'ambiguous'}]};}};
 assert.equal((await api.resolveStockReferences(items,client))[0].id,9);assert.equal(calls,1);assert.equal(count(),1);
 await assert.rejects(api.resolveStockReferences(items,{rpc:async()=>({error:{code:'PGRST202'}})}));assert.equal(count(),1);
 await assert.rejects(api.resolveStockReferences(items,{rpc:async()=>({data:[]})}),/Неповний/);
});
test('reference writer rejects oversized portions before network request',async()=>{
 const {api}=load();await assert.rejects(api.resolveStockReferences(Array(101).fill({key:'a',kind:'details',name:'Part'}),{rpc:()=>{throw Error('network')}}),/100/);
});
