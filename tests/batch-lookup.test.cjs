const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(client,revision=()=>0){const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/batchLookup.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api,structuredClone,queueMicrotask,localStorage:{getItem:()=> 'actor'},require:path=>{
 if(path.endsWith('/supabaseClient'))return {supabase:client};
 if(path==='./stockReadRevision')return {stockSuggestionRevision:revision};
 throw new Error('Unexpected fixture import: '+path);
}});return api;}
test('batch lookup coalesces until invalidation, never caches failures or obsolete responses',async()=>{
 let calls=0,clock=0,revision=0,resolve;const api=load({});const read=api.createBatchLookup({rpc:()=>{calls++;return new Promise(r=>resolve=r)}},()=>clock,()=>revision);
 const a=read('shops','one'),b=read('shops','one');assert.equal(calls,1);resolve({data:{items:[{value:'one'}],has_more:false}});await Promise.all([a,b]);await read('shops','one');assert.equal(calls,1);
 // Lookup results live until modal close or a mutation; elapsed time alone must not refetch them.
 clock=15001;await read('shops','one');assert.equal(calls,1);
 revision++;const old=read('shops','one');assert.equal(calls,2);revision++;resolve({data:{items:[],has_more:false}});await assert.rejects(old,/змінився/);
 const bad=read('shops','one');resolve({error:{code:'42501'}});await assert.rejects(bad);const retry=read('shops','one');resolve({data:{items:[],has_more:false}});await retry;assert.equal(calls,4);
 api.invalidateBatchLookupCaches();const reopened=read('shops','one');assert.equal(calls,5);resolve({data:{items:[{value:'one updated'}],has_more:false}});assert.equal((await reopened).items[0].value,'one updated');
});
test('thirty OCR rows with ten unique catalogs use one bounded request',async()=>{
 const queries=[];const api=load({rpc:async(name,args)=>{assert.equal(name,'traffic_invoice_catalogs');queries.push(args);return {data:{items:args.p_catalogs.map((catalog,i)=>({catalog,name:'Name '+i,id:i+1})),has_more:false}};}});
 const rows=await Promise.all(Array.from({length:30},(_,i)=>api.readBatchCatalogNames('000'+i%10)));
 assert.equal(rows.length,30);assert.equal(queries.length,1);assert.equal(queries[0].p_catalogs.length,10);assert.ok(rows.every(row=>row.length===1));
});
test('initial stock form has no complete catalog/reference reads and retains targeted validation',()=>{
 const source=fs.readFileSync('src/ts/roboha/dodatu_inchi_bazu/inhi/batchImportSclad.ts','utf8');
 for(const name of ['loadShopsList','loadDetailsList','loadActsList','loadPartNumbers'])assert.ok(!source.includes(name+'('));
 assert.match(source,/refreshEnteredActValidity\(parsedDataGlobal,true\)/);assert.match(source,/hydrateEnteredReferences\(rows\)/);
});

test('entered act validation is bounded, cached and forced fresh before writes',async()=>{
 let calls=0,revision=0;const api=load({from:()=>({select:projection=>{assert.equal(projection,'act_id,date_off');return {in:async(_,ids)=>{calls++;assert.ok(ids.length<=200);return {data:ids.map(id=>({act_id:Number(id),date_off:null}))};}};}})},()=>revision);
 const ids=Array.from({length:205},(_,i)=>String(i+1));assert.equal((await api.readBatchActValidity(ids)).length,205);assert.equal(calls,2);await api.readBatchActValidity(ids);assert.equal(calls,2);await api.readBatchActValidity(ids,true);assert.equal(calls,4);
 revision++;await api.readBatchActValidity(ids);assert.equal(calls,6);api.invalidateBatchLookupCaches();await api.readBatchActValidity(ids);assert.equal(calls,8);
});
test('reference validation requests entered unique names only in batches of 100',async()=>{
 let revision=0;const batches=[];const api=load({rpc:async(name,args)=>{assert.equal(name,'traffic_reference_ids');batches.push(args.p_items);return {data:args.p_items.map((item,i)=>({...item,id:i||null}))};}},()=>revision);
 const items=Array.from({length:105},(_,i)=>({kind:'details',name:'Detail '+i}));const rows=await api.readBatchReferenceValidity([...items,...items]);assert.equal(rows.length,105);assert.deepEqual(batches.map(b=>b.length),[100,5]);await api.readBatchReferenceValidity(items);assert.equal(batches.length,2);
 revision++;await api.readBatchReferenceValidity(items);assert.deepEqual(batches.map(b=>b.length),[100,5,100,5]);api.invalidateBatchLookupCaches();await api.readBatchReferenceValidity(items);assert.deepEqual(batches.map(b=>b.length),[100,5,100,5,100,5]);
});
