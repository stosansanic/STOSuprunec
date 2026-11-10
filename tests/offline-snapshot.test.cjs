const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/offline/offlineSnapshot.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
}).outputText,{exports:exportsObject});
const {readOfflineSnapshot,OFFLINE_RESOURCES}=exportsObject;
test('unchanged offline pages transfer only hashes and reuse complete local pages',async()=>{
  let payloads=0;
  const client={rpc:async(_name,p)=>{const hash=p.p_resource+'-hash';const items=p.p_hash===hash?null:[{id:1}];if(items)payloads++;
    return {data:{hash,items,count:1,has_more:false,next_cursor:1}};}};
  const first=await readOfflineSnapshot(client);assert.equal(payloads,6);
  const second=await readOfflineSnapshot(client,first);assert.equal(payloads,6);
  for(const resource of OFFLINE_RESOURCES)assert.equal(second.pages[resource][0].items,first.pages[resource][0].items);
});
test('changed page downloads its content, other resources keep their full local copy',async()=>{
  const old={version:1,pages:Object.fromEntries(OFFLINE_RESOURCES.map(r=>[r,[{hash:r,items:[{id:1}],next:1}]]))};
  const next=await readOfflineSnapshot({rpc:async(_name,p)=>({data:{hash:p.p_resource==='acts'?'changed':p.p_resource,
    items:p.p_resource==='acts'?[{id:2}]:null,count:1,has_more:false,next_cursor:2}})},old);
  assert.equal(next.pages.acts[0].items[0].id,2);assert.equal(next.pages.works[0].items[0].id,1);
});
test('empty server page reconciles deleted records instead of retaining old data',async()=>{
  const result=await readOfflineSnapshot({rpc:async()=>({data:{hash:'empty',items:[],count:0,has_more:false,next_cursor:null}})});
  assert.equal(result.pages.acts[0].items.length,0);
});
test('only absent optional RPC falls back; access errors and incomplete hash responses fail',async()=>{
  let calls=0;assert.equal(await readOfflineSnapshot({rpc:async()=>{calls++;return {error:{code:'PGRST202'}}}}),undefined);
  assert.equal(calls,1);
  await assert.rejects(readOfflineSnapshot({rpc:async()=>({error:{code:'42501'}})}),e=>e.code==='42501');
  await assert.rejects(readOfflineSnapshot({rpc:async()=>({data:{hash:'x',items:null,count:2,has_more:false}})}),/Incomplete/);
});
