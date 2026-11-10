const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(){
 const handlers=new Map(),subscriptions=[];
 const add=(name,fn)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn)};
 const remove=(name,fn)=>handlers.get(name)?.delete(fn);
 const document={hidden:false,addEventListener:add,removeEventListener:remove};
 const window={addEventListener:add,removeEventListener:remove};
 const registry={subscribe(resource,event,status){const entry={resource,event,status,active:true};subscriptions.push(entry);return {unsubscribe(){entry.active=false}}}};
 const api={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/ts/roboha/workshop/resourceCache.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:api,require:()=>({databaseSubscriptions:registry}),document,window,localStorage:{getItem:()=> 'owner'},structuredClone});
 return {api,subscriptions,document,fire(name,event={}){for(const fn of handlers.get(name)||[])fn(event)}};
}
test('one-act workshop watches only compact acts and invalidates only its car cache',async()=>{
 const f=fixture();const scope={kind:'act',actId:1,carId:10};let changes=0,reads=0;
 const stop=f.api.watchWorkshopResources(scope,()=>changes++);f.subscriptions[0].status('SUBSCRIBED');
 assert.equal(f.subscriptions.length,1);assert.equal(f.subscriptions[0].resource.table,'acts');assert.equal(f.subscriptions[0].resource.select.includes('data'),false);
 const cache=f.api.workshopReadCache,key=id=>JSON.stringify(['recommendations','owner','admin','me',id,1]);
 const read=id=>cache.read(key(id),async()=>++reads);await read(10);await read(20);
 f.subscriptions[0].event({eventType:'UPDATE',new:{act_id:2,cars_id:20,traffic_state:{previous:{cars_id:20}}},old:{}});
 assert.equal(changes,0);await read(10);assert.equal(reads,2);
 // Moved away from this car: previous membership must invalidate car 10 only.
 f.subscriptions[0].event({eventType:'UPDATE',new:{act_id:2,cars_id:20,traffic_state:{previous:{cars_id:10}}},old:{}});
 assert.equal(changes,1);await read(10);await read(20);assert.equal(reads,3);
 stop();assert.equal(f.subscriptions[0].active,false);
});
test('workshop ignores arbitrary browser activity, suspends when hidden and reconciles on join',()=>{
 const f=fixture();let changes=0;const stop=f.api.watchWorkshopResources({kind:'attention'},()=>changes++);
 assert.equal(f.subscriptions.length,3);for(const s of f.subscriptions)s.status('SUBSCRIBED');f.fire('focus');f.fire('storage',{key:'unrelated'});assert.equal(changes,0);
 f.document.hidden=true;f.fire('visibilitychange');assert.equal(f.subscriptions.filter(x=>x.active).length,0);
 f.document.hidden=false;f.fire('visibilitychange');assert.equal(f.subscriptions.filter(x=>x.active).length,3);assert.equal(changes,0);
 for(const s of f.subscriptions.filter(x=>x.active))s.status('SUBSCRIBED');assert.equal(changes,3);
 stop();assert.equal(f.subscriptions.filter(x=>x.active).length,0);f.fire('visibilitychange');assert.equal(f.subscriptions.filter(x=>x.active).length,0);
});
test('cards with no visible previous recommendations need no Realtime subscriptions',()=>{
 const f=fixture(),stop=f.api.watchWorkshopResources({kind:'act',actId:1,carId:null});assert.equal(f.subscriptions.length,0);stop();
});
test('targeted cache invalidation leaves unrelated in-flight reads and cached values intact',async()=>{
 const f=fixture(),cache=f.api.createWorkshopResourceCache();let finishA,finishB;
 const a=cache.read('a',()=>new Promise(r=>finishA=r)),b=cache.read('b',()=>new Promise(r=>finishB=r));
 cache.invalidate(key=>key==='a');finishA(1);finishB(2);await assert.rejects(a,/Дані змінилися/);assert.equal(await b,2);assert.equal(await cache.read('b',()=>{throw Error('not cached')}),2);
});


test('attention initial snapshot waits for all transports and covers changes during join once',async()=>{
 const f=fixture();let current=0,reads=0,refreshes=0;
 const watch=f.api.watchWorkshopResources({kind:'attention'},()=>refreshes++);
 const snapshot=(async()=>{await watch.ready;reads++;return current})();
 await Promise.resolve();assert.equal(reads,0);
 f.subscriptions[0].status('SUBSCRIBED');current=1;f.subscriptions[0].event({eventType:'UPDATE',new:{act_id:1}});
 f.subscriptions[1].status('SUBSCRIBED');await Promise.resolve();assert.equal(reads,0);assert.equal(refreshes,0);
 f.subscriptions[2].status('SUBSCRIBED');assert.equal(await snapshot,1);assert.equal(reads,1);assert.equal(refreshes,0);
 watch();
});
test('single-act recommendations start after readiness and retry one invalidated snapshot',async()=>{
 const f=fixture(),scope={kind:'act',actId:1,carId:10},watch=f.api.watchWorkshopResources(scope);
 let reads=0,finishFirst;const key=JSON.stringify(['recommendations','owner','admin','me',10,1]);
 const snapshot=(async()=>{await watch.ready;return f.api.workshopReadCache.readWithRetry(key,()=>{reads++;return reads===1?new Promise(r=>finishFirst=r):Promise.resolve('current')})})();
 await Promise.resolve();assert.equal(reads,0);f.subscriptions[0].status('SUBSCRIBED');for(let i=0;i<8;i++)await Promise.resolve();assert.equal(reads,1);
 f.subscriptions[0].event({eventType:'UPDATE',new:{act_id:1,cars_id:10}});finishFirst('stale');
 assert.equal(await snapshot,'current');assert.equal(reads,2);
 f.subscriptions[0].status('SUBSCRIBED');assert.equal(await f.api.workshopReadCache.read(key,()=>{throw Error('first ready invalidated cache twice')}),'current');watch();
});
test('failed initial join permits one snapshot then reconciles recovery; closing resolves wait',async()=>{
 const f=fixture();let refreshes=0;const watch=f.api.watchWorkshopResources({kind:'act',actId:1,carId:10},()=>refreshes++);
 f.subscriptions[0].status('CHANNEL_ERROR');await watch.ready;assert.equal(refreshes,0);
 f.subscriptions[0].status('SUBSCRIBED');assert.equal(refreshes,1);watch();
 const pending=f.api.watchWorkshopResources({kind:'attention'});pending();await pending.ready;
});
test('recommendation retry is bounded under continuously changing data',async()=>{
 const f=fixture(),cache=f.api.createWorkshopResourceCache();let reads=0;const finishes=[];
 const read=cache.readWithRetry('a',()=>{reads++;return new Promise(r=>finishes.push(r))});
 cache.invalidate();finishes[0](1);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(reads,2);
 cache.invalidate();finishes[1](2);await assert.rejects(read,/Дані змінилися/);assert.equal(reads,2);
});
