const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('src/ts/roboha/zakaz_naraudy/globalCache.ts','utf8');
function setup(read, rpc) {
  const calls=[];
  const supabase={rpc,from(table){let ids=null;const q={select(){return q;},in(_key,value){ids=value;return q;},range(){return q;},order(){return q;},then(resolve,reject){calls.push({table,ids});return Promise.resolve().then(()=>read(ids)).then(resolve,reject);}};return q;}};
  const module={exports:{}};
  const references = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/zakaz_naraudy/editorReferenceRead.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {exports:references,require:()=>({supabase}),structuredClone,console});
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {module,exports:module.exports,require:()=>({supabase,...references}),console});
  return {...module.exports,calls};
}
const row=id=>({sclad_id:id,part_number:'same',name:'Part '+id,price:10,kilkist_on:3,kilkist_off:1});
test('act opening no longer downloads all stock',()=>{
  const fn=source.slice(source.indexOf('async function loadGlobalDataOnce'),source.indexOf('async function loadStaffForAct'));
  assert.doesNotMatch(fn,/"sclad"|"works"|"details"|"shops"/);
  const modal=fs.readFileSync('src/ts/roboha/zakaz_naraudy/modalMain.ts','utf8');
  assert.ok(modal.includes('ensureSkladIdsLoaded((actDetails["Деталі"]'));
});
test('same ID set joins one read; cached and empty sets do not issue new requests',async()=>{
  let finish;const state=setup(()=>new Promise(resolve=>{finish=resolve;}));
  const first=state.ensureSkladIdsLoaded([3,1,3]),second=state.ensureSkladIdsLoaded([1,3]);
  await new Promise(setImmediate);assert.equal(state.calls.length,1);
  assert.deepEqual([...state.calls[0].ids],[1,3]);finish({data:[row(1),row(3)],error:null});
  await Promise.all([first,second]);await state.ensureSkladIdsLoaded([1,3]);await state.ensureSkladIdsLoaded([]);
  assert.equal(state.calls.length,1);assert.equal(state.globalCache.skladParts.length,2);
});

test('overlapping ID sets reuse in-flight rows instead of reading them twice',async()=>{
 const finishes=[];const state=setup(ids=>new Promise(resolve=>finishes.push(()=>resolve({data:ids.map(row)}))));
 const a=state.ensureSkladIdsLoaded([1,2]),b=state.ensureSkladIdsLoaded([2,3]);
 await new Promise(setImmediate);assert.deepEqual(state.calls.map(x=>[...x.ids]),[[1,2],[3]]);
 finishes.forEach(f=>f());await Promise.all([a,b]);assert.equal(state.globalCache.skladParts.length,3);
});
test('a partial cache does not satisfy a complete autocomplete read; identical batches retain their IDs',async()=>{
  const state=setup(ids=>({data:(ids||[1,2]).map(row),error:null}));
  await state.ensureSkladIdsLoaded([1]);await state.ensureSkladLoaded();
  assert.equal(state.calls.length,2);assert.equal(state.calls[1].ids,null);
  assert.deepEqual(Array.from(state.globalCache.skladParts,p=>p.sclad_id),[1,2]);
});
test('failed batches publish no partial cache and retry successfully',async()=>{
  let fail=true;const state=setup(ids=>fail&&ids[0]===101?{error:Error('network')}:{data:ids.map(row),error:null});
  const ids=Array.from({length:101},(_,i)=>i+1);
  await assert.rejects(state.ensureSkladIdsLoaded(ids));assert.equal(state.globalCache.skladParts.length,0);
  fail=false;await state.ensureSkladIdsLoaded(ids);assert.equal(state.globalCache.skladParts.length,101);
});
test('invalidation during a stock read discards its stale result',async()=>{
  let finish;let count=0;const state=setup(ids=>++count===1?new Promise(resolve=>{finish=resolve;}):{data:ids.map(id=>({...row(id),price:20})),error:null});
  const first=state.ensureSkladIdsLoaded([1]);await new Promise(setImmediate);state.invalidateGlobalDataCache();
  finish({data:[row(1)],error:null});await first;
  assert.equal(state.calls.length,2);assert.equal(state.globalCache.skladParts[0].price,20);
});

test('exact catalogue lookup hydrates only its ID and never falls back on access errors',async()=>{
 const state=setup(ids=>({data:ids.map(row),error:null}),async()=>({data:3}));
 assert.equal((await state.resolveScladItemByPart('same')).sclad_id,3);assert.deepEqual([...state.calls[0].ids],[3]);
 const denied=setup(()=>{throw Error('unexpected full read')},async()=>({error:{code:'42501'}}));
 await assert.rejects(denied.resolveScladItemByPart('same'),e=>e.code==='42501');
 const absent=setup(()=>{throw Error('unexpected full read')},async()=>({data:null}));assert.equal(await absent.resolveScladItemByPart('none'),null);
});

test('name suggestions fetch only returned IDs and keep server order',async()=>{
 const state=setup(ids=>({data:ids.map(row),error:null}),async()=>({data:[3,1]}));
 const rows=await state.searchSkladNames('same');assert.deepEqual(Array.from(rows,x=>x.sclad_id),[3,1]);
 assert.deepEqual([...state.calls[0].ids],[1,3]);
 const bad=setup(()=>({data:[]}),async()=>({data:['oops']}));await assert.rejects(bad.searchSkladNames('same'));
});

test('catalogue input reads one bounded page; name-prefill reads every matching page',async()=>{
 const pages=[];const state=setup(ids=>({data:ids.map(row),error:null}),async(_name,args)=>{
   pages.push(args);return {data:args.p_after?{ids:[3],has_more:false,next_cursor:3}:{ids:[1,2],has_more:true,next_cursor:2}};
 });
 assert.equal((await state.searchSkladCatalog('part')).length,2);assert.equal(pages.length,1);
 const all=await state.searchSkladCatalog('part',true);assert.deepEqual(Array.from(all,x=>x.sclad_id),[1,2,3]);
 assert.equal(pages.length,3);assert.equal(pages[2].p_after,2);
});
test('catalogue page errors never trigger broad fallback including missing initial RPC',async()=>{
 const state=setup(()=>{throw Error('unexpected broad read')},async()=>({data:{ids:[1],has_more:true,next_cursor:0}}));
 await assert.rejects(state.searchSkladCatalog('part',true));
 const denied=setup(()=>{throw Error('unexpected broad read')},async()=>({error:{code:'42501'}}));await assert.rejects(denied.searchSkladCatalog('part'));
 assert.doesNotMatch(fs.readFileSync('src/ts/roboha/zakaz_naraudy/inhi/kastomna_tabluca.ts','utf8'),/ensureSkladLoaded/);
});

test('stock subscribes only after IDs are used and releases every scoped consumer on close',async()=>{
 const resources=[],released=[],events=[];const exports={};
 const registry={subscribe(resource){resources.push(resource);return{unsubscribe(){released.push(resource.table)}}}};
 const supabase={auth:{onAuthStateChange(){}},from(){const q={select(){return q},in(){return Promise.resolve({data:[row(1)]})}};return q}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
  exports,require:()=>({supabase,databaseSubscriptions:registry,invalidateEditorReferences(){}}),
  window:{dispatchEvent:e=>events.push(e.type),addEventListener(){},removeEventListener(){}},CustomEvent:class{constructor(type){this.type=type}},
 });
 exports.initScladRealtimeSubscription();exports.initScladRealtimeSubscription();exports.initWorksRealtimeSubscription();exports.initDetailsRealtimeSubscription();
 assert.deepEqual(resources.map(r=>r.table),['works','details']);
 await exports.ensureSkladIdsLoaded([1]);await exports.ensureSkladIdsLoaded([1]);
 assert.equal(resources.length,3);assert.equal(resources[2].filter,'sclad_id=in.(1)');
 exports.releaseEditorStockSubscription();assert.deepEqual(released,['works','details','sclad']);
 exports.releaseEditorStockSubscription();assert.equal(released.length,3);assert.ok(events.includes('sto:editor-scope-reset'));
 exports.initScladRealtimeSubscription();await exports.ensureSkladIdsLoaded([1]);assert.equal(resources.filter(x=>x.table==='sclad').length,2);
});
