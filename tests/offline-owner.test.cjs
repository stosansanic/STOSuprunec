const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{webcrypto}=require('node:crypto');
const {IDBFactory}=require(process.env.STO_IDB_MODULE||'fake-indexeddb');
function setup() {
 let actor;const indexedDB=new IDBFactory();
 const context={navigator:{onLine:true},window:{addEventListener(){},removeEventListener(){}},setInterval,clearInterval,indexedDB,crypto:webcrypto,TextEncoder,localStorage:{getItem:()=>actor},console,Date,setTimeout,clearTimeout};
 const load=(file,imports={})=>{const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{...context,exports,require:name=>{if(!(name in imports))throw Error(name);return imports[name];}});return exports;};
 const owner=load('src/ts/roboha/offline/offlineOwner.ts',{'../../../config/project.config':{SUPABASE_CONFIG:{url:'https://example.test'}}});
 const db=load('src/ts/roboha/offline/offlineDB.ts',{'./offlineOwner':owner,'./offlineSnapshot':{readOfflineSnapshot:async()=>{},OFFLINE_RESOURCES:[]},'../../utils/actFrozenState':{isActFrozen:()=>false}});
 return {db,owner,indexedDB,load,setActor:(id,role='Слюсар',extra={})=>{actor=id?JSON.stringify({slyusar_id:id,Name:'Person',Доступ:role,version:'2.0',timestamp:Date.now(),...extra}):null;}};
}
const item={timestamp:1,operation:'update_act',table:'acts',recordId:7,payload:{data:{draft:true}},retries:0};
test('owner cache and queue isolation survives login timestamp changes; foreign queue cannot be removed',async()=>{
 const h=setup();h.setActor(1);const first=h.owner.offlineScope();
 await h.db.cacheActs([{act_id:7,data:{draft:true}}]);await h.db.addToSyncQueue(item);
 const queue=await h.db.getSyncQueue();assert.equal(queue.length,1);assert.ok(queue[0].owner);
 h.setActor(1,'Слюсар',{timestamp:123,Name:'Renamed'});assert.equal(h.owner.offlineScope(),first);assert.equal((await h.db.getSyncQueue()).length,1);
 h.setActor(2);assert.equal((await h.db.getCachedActs()).length,0);assert.equal((await h.db.getSyncQueue()).length,0);
 await h.db.addToSyncQueue(item);await assert.rejects(h.db.removeSyncQueueItem(queue[0].id,queue[0].owner));await assert.rejects(h.db.addToSyncQueue(queue[0]));
 assert.equal((await h.db.getSyncQueue()).length,1);
 h.setActor(1);assert.equal((await h.db.getCachedActs()).length,1);assert.equal((await h.db.getSyncQueue()).length,1);
 h.setActor(null);await assert.rejects(h.db.getCachedActs());await assert.rejects(h.db.addToSyncQueue(item));
});
test('legacy queue remains quarantined; admin recovery exports only drafts, no unrelated caches',async()=>{
 const h=setup();await new Promise((resolve,reject)=>{
  const r=h.indexedDB.open('sto-offline',1);r.onupgradeneeded=()=>{for(const name of ['acts','syncQueue','clients'])r.result.createObjectStore(name,{keyPath:name==='acts'?'act_id':'id'});};
  r.onsuccess=()=>{const d=r.result,t=d.transaction(['acts','syncQueue','clients'],'readwrite');t.objectStore('acts').put({act_id:7,data:'draft'});t.objectStore('acts').put({act_id:8,data:'private cached act'});t.objectStore('syncQueue').put({...item,id:1});t.objectStore('clients').put({id:1,password:'not exported'});t.oncomplete=()=>{d.close();resolve();};};r.onerror=()=>reject(r.error);
 });
 h.setActor(1);assert.equal((await h.db.getSyncQueue()).length,0);await assert.rejects(h.db.exportOfflineRecoveryStore('sto-offline'));
 h.setActor(3,'Адміністратор');assert.ok((await h.db.listOfflineRecoveryStores()).includes('sto-offline'));
 const exported=await h.db.exportOfflineRecoveryStore('sto-offline');assert.equal(exported.stores.syncQueue.length,1);assert.equal(exported.stores.acts.length,1);assert.equal(exported.stores.clients,undefined);
 assert.equal((await h.db.getSyncQueue()).length,0);
});
test('late database open for previous actor fails closed',async()=>{
 const h=setup();h.setActor(1);const pending=h.db.cacheActs([{act_id:99,data:{}}]);h.setActor(2);await assert.rejects(pending);
 assert.equal((await h.db.getCachedActs()).length,0);
});
test('auth switch during queue snapshot read prevents mutation and preserves the queued draft',async()=>{
 const h=setup();h.setActor(1);let release,reads=0,writes=0;
 class Conflict extends Error{}
 const sync=h.load('src/ts/roboha/offline/offlineSync.ts',{
  './offlineOwner':h.owner,'./offlineDB':h.db,'../../vxid/supabaseClient':{supabase:{}},'../zakaz_naraudy/inhi/vspluvauhe_povidomlenna':{showNotification(){}},
  '../../utils/actSafeWrite':{ACT_REVISION_KEY:'revision',ActWriteConflict:Conflict,readActJson:x=>x,stableActJson:JSON.stringify,readActSnapshot:async()=>{reads++;return new Promise(r=>{release=r;});},writeActSnapshotWithStock:async()=>{writes++;}},
 });
 await h.db.addToSyncQueue({...item,payload:{data:{next:1},expectedData:{old:1}}});
 const run=sync.forceSyncNow();while(!release)await new Promise(r=>setTimeout(r,1));h.setActor(2);release({data:{old:1}});await run;
 assert.equal(reads,1);assert.equal(writes,0);h.setActor(1);assert.equal((await h.db.getSyncQueue()).length,1);
});
